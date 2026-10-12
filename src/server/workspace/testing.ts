// Throwaway workspaces and the search for a planted secret. For tests and for the end-to-end
// run only: the application never imports this file.
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { TEST_WORKSPACE } from "../testing.ts";
import type { LlmProfile } from "./config.ts";
import { createWorkspace } from "./create.ts";
import { createWorkspaceDatabase } from "./database.ts";
import { BACKUPS_DIR, DATABASE_FILE } from "./layout.ts";
import { WORKSPACE_VARIABLE } from "./location.ts";

export const TEST_PROFILE: LlmProfile = {
  kind: "router",
  endpoint: TEST_WORKSPACE.endpoint,
  auth: "bearer",
  models: { default: "test-model" },
  diagnostics: null,
};

/** A throwaway workspace at the given place, which must not exist yet. */
export function createTestWorkspaceAt(dir: string, profile: Partial<LlmProfile> = {}): void {
  createWorkspace({ dir, name: TEST_WORKSPACE.name, profile: { ...TEST_PROFILE, ...profile } });
}

export interface TestWorkspace {
  dir: string;
  /**
   * What a process needs in its environment to open this workspace. spawnNode() starts from
   * an empty environment, so without this variable a server has no workspace at all: it can
   * never fall back to the developer's own.
   */
  env: Record<string, string>;
  /** Deletes the workspace. Safe to call more than once. */
  remove: () => void;
}

/** A throwaway workspace in a temporary directory of its own, at the schema of this code. The caller removes it. */
export function createTestWorkspace(profile: Partial<LlmProfile> = {}): TestWorkspace {
  const base = mkdtempSync(join(tmpdir(), "hubber-workspace-"));
  const dir = join(base, "workspace");
  createTestWorkspaceAt(dir, profile);
  return { dir, env: { [WORKSPACE_VARIABLE]: dir }, remove: () => rmSync(base, { recursive: true, force: true }) };
}

/**
 * A throwaway workspace as it was created before the application had a schema: its database
 * holds the pin and nothing else, so the first open of it migrates. For the tests of that start.
 */
export function createUnmigratedTestWorkspace(profile: Partial<LlmProfile> = {}): TestWorkspace {
  const base = mkdtempSync(join(tmpdir(), "hubber-workspace-"));
  const dir = join(base, "workspace");
  createWorkspace(
    { dir, name: TEST_WORKSPACE.name, profile: { ...TEST_PROFILE, ...profile } },
    { createDatabase: createWorkspaceDatabase },
  );
  return { dir, env: { [WORKSPACE_VARIABLE]: dir }, remove: () => rmSync(base, { recursive: true, force: true }) };
}

export interface SecretFinding {
  /**
   * A file path for what the file holds, "path: name" for what an entry is called, "path: link
   * target" for where a link leads, or "path: table.column" for a value read through SQL.
   */
  where: string;
  /** How the secret was spelled there. */
  spelling: string;
}

/** The forms a secret could take in a file without anyone meaning to hide it. */
export function spellingsOf(secret: string): Array<{ name: string; bytes: Buffer }> {
  const utf8 = Buffer.from(secret, "utf8");
  const spellings = [
    { name: "utf-8", bytes: utf8 },
    { name: "utf-16le", bytes: Buffer.from(secret, "utf16le") },
    { name: "base64", bytes: Buffer.from(utf8.toString("base64").replace(/=+$/, "")) },
    { name: "base64url", bytes: Buffer.from(utf8.toString("base64url")) },
    { name: "hex", bytes: Buffer.from(utf8.toString("hex")) },
    { name: "percent-encoded", bytes: Buffer.from(encodeURIComponent(secret)) },
    { name: "JSON-escaped", bytes: Buffer.from(JSON.stringify(secret).slice(1, -1)) },
  ];
  // Spellings that come out the same as plain UTF-8 would only repeat its findings.
  return spellings.filter((spelling, index) => index === 0 || !spelling.bytes.equals(utf8));
}

interface Entry {
  path: string;
  /** What the entry is called in its directory. */
  name: string;
  kind: "file" | "directory" | "link" | "other";
}

/** Everything below a directory, whatever it is. Links are listed and not followed. */
function entriesUnder(root: string): Entry[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry): Entry[] => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return [{ path, name: entry.name, kind: "directory" }, ...entriesUnder(path)];
    const kind = entry.isFile() ? "file" : entry.isSymbolicLink() ? "link" : "other";
    return [{ path, name: entry.name, kind }];
  });
}

/**
 * Looks for a secret in everything a workspace keeps on disk. Three scans, because none is
 * enough alone: the bytes of every file (configuration, write-ahead log, dropped files); what
 * every file, directory and link is called and where a link leads, since a name is kept by the
 * directory and is in no file; and every value of every table read through SQL, the schema
 * included, which sees a value that SQLite split across pages. The copies of the database from
 * before a migration are whole databases, and are read through SQL like the database itself.
 * Not looked at: extended attributes.
 */
export function scanWorkspaceForSecret(dir: string, secret: string): SecretFinding[] {
  const backups = join(dir, BACKUPS_DIR);
  const databases = [
    join(dir, DATABASE_FILE),
    ...(existsSync(backups) ? readdirSync(backups).sort() : [])
      .filter((name) => name.endsWith(".sqlite"))
      .map((name) => join(backups, name)),
  ];
  const spellings = spellingsOf(secret);
  const findings: SecretFinding[] = [];
  for (const { path, name, kind } of entriesUnder(dir)) {
    const places: [where: string, bytes: Buffer][] = [[`${path}: name`, Buffer.from(name)]];
    if (kind === "file") places.unshift([path, readFileSync(path)]);
    if (kind === "link") places.push([`${path}: link target`, Buffer.from(readlinkSync(path))]);
    for (const [where, bytes] of places) {
      for (const { name: spelling, bytes: needle } of spellings) {
        if (bytes.includes(needle)) findings.push({ where, spelling });
      }
    }
  }
  for (const database of databases) {
    // Not through openWorkspaceDatabase(): a scan must work on a database that fails its checks too.
    // Not with the "readonly" option either: such a connection leaves -shm and -wal files beside a
    // database that was closed, and a scan must leave the directory as it found it. An ordinary
    // connection removes them when it closes, and query_only keeps it from writing.
    const db = new Database(database, { fileMustExist: true });
    try {
      db.pragma("query_only = ON");
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").pluck().all() as string[];
      // The schema is a table too: the names of tables and columns and the defaults are its values.
      for (const table of ["sqlite_schema", ...tables]) {
        for (const row of db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).iterate() as Iterable<
          Record<string, unknown>
        >) {
          for (const [column, value] of Object.entries(row)) {
            const bytes =
              typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.isBuffer(value) ? value : undefined;
            if (bytes === undefined) continue;
            for (const { name, bytes: needle } of spellings) {
              if (bytes.includes(needle)) findings.push({ where: `${database}: ${table}.${column}`, spelling: name });
            }
          }
        }
      }
    } finally {
      db.close();
    }
  }
  return findings;
}
