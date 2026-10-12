import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { pendingMigrations, readMigrations } from "../db/migrate.ts";
import { TEST_WORKSPACE } from "../testing.ts";
import { snapshotWorkspaceDatabase } from "./database.ts";
import { WorkspaceError } from "./errors.ts";
import { locateWorkspace } from "./location.ts";
import { type OpenWorkspace, openWorkspace } from "./open.ts";
import {
  createTestWorkspace,
  createTestWorkspaceAt,
  createUnmigratedTestWorkspace,
  scanWorkspaceForSecret,
  spellingsOf,
  TEST_PROFILE,
  type TestWorkspace,
} from "./testing.ts";
import { DIRECT_TRANSPORT } from "./transport.ts";

// Unique per run, so that a finding can only come from this run.
const SECRET = `hubber-planted-${randomUUID()}`;
// Every spelling of this one differs from the plain text: it has what base64, percent-encoding
// and JSON each write in a way of their own.
const AWKWARD_SECRET = `hubber-planted-"key"/a+b>>>???-${randomUUID()}`;
const LAYOUT = ["files", "hubber.sqlite", "workspace.json"];

const workspaces: TestWorkspace[] = [];
const opened: OpenWorkspace[] = [];
const connections: Database.Database[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const workspace of opened.splice(0)) workspace.close();
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const workspace of workspaces.splice(0)) workspace.remove();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): TestWorkspace {
  const created = createTestWorkspace();
  workspaces.push(created);
  return created;
}

function open(dir: string): OpenWorkspace {
  const found = openWorkspace({ dir, source: "variable" }, {}, DIRECT_TRANSPORT);
  opened.push(found);
  return found;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hubber-scan-"));
  tempDirs.push(dir);
  return dir;
}

/** Every file below a directory with a digest of its bytes: what a scan must leave as it was. */
function fingerprint(root: string): Record<string, string> {
  return Object.fromEntries(
    (readdirSync(root, { recursive: true }) as string[])
      .sort()
      .filter((name) => statSync(join(root, name)).isFile())
      .map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(join(root, name)))
          .digest("hex"),
      ]),
  );
}

/** How many whole copies of the text the bytes of a file contain. */
function copiesIn(path: string, text: string): number {
  const bytes = readFileSync(path);
  let count = 0;
  for (let at = bytes.indexOf(text); at !== -1; at = bytes.indexOf(text, at + 1)) count++;
  return count;
}

describe("createTestWorkspace", () => {
  it("creates a throwaway workspace in a temporary directory of its own", () => {
    const { dir } = workspace();

    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(LAYOUT);
    expect(readdirSync(dirname(dir))).toEqual(["workspace"]);
  });

  it("pins it to an address where nothing listens, under the name the tests expect", () => {
    const found = open(workspace().dir);

    expect(found.config.name).toBe("Testowy");
    expect(found.config.profile).toEqual({
      kind: "router",
      endpoint: "http://127.0.0.1:9/llm",
      auth: "bearer",
      models: { default: "test-model" },
      diagnostics: null,
    });
    expect(found.config.profile).toEqual(TEST_PROFILE);
    expect(TEST_PROFILE.endpoint).toBe(TEST_WORKSPACE.endpoint);
  });

  it("gives the one variable a process needs to find it, and nothing that could lead elsewhere", () => {
    const { dir, env } = workspace();

    expect(env).toEqual({ HUBBER_WORKSPACE: dir });
    expect(locateWorkspace(env)).toEqual({ dir, source: "variable" });
  });

  it("takes another profile where a test needs one", () => {
    const created = createTestWorkspace({
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      auth: "x-api-key",
    });
    workspaces.push(created);

    expect(open(created.dir).config.profile).toEqual({
      ...TEST_PROFILE,
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      auth: "x-api-key",
    });
  });

  it("removes the workspace with the directory it was made in, as often as it is asked", () => {
    const created = createTestWorkspace();

    created.remove();
    created.remove();

    expect(existsSync(dirname(created.dir))).toBe(false);
  });

  it("gives its database the schema of this code: a server that opens it has nothing to migrate", () => {
    const { dir } = workspace();

    const found = open(dir);

    expect(found.migration).toEqual({ applied: [], snapshot: null });
    expect(pendingMigrations(found.database)).toEqual([]);
  });
});

describe("createUnmigratedTestWorkspace", () => {
  function unmigrated(...profile: Parameters<typeof createUnmigratedTestWorkspace>): TestWorkspace {
    const created = createUnmigratedTestWorkspace(...profile);
    workspaces.push(created);
    return created;
  }

  it("creates a throwaway workspace whose database holds the pin and nothing else", () => {
    const { dir, env } = unmigrated();

    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(LAYOUT);
    expect(env).toEqual({ HUBBER_WORKSPACE: dir });
    const db = new Database(join(dir, "hubber.sqlite"));
    connections.push(db);
    expect(db.prepare("SELECT type, name FROM sqlite_schema ORDER BY name").all()).toEqual([
      { type: "table", name: "workspace_pin" },
      { type: "trigger", name: "workspace_pin_insert_once" },
      { type: "trigger", name: "workspace_pin_no_delete" },
      { type: "trigger", name: "workspace_pin_no_update" },
    ]);
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    expect(db.prepare("SELECT endpoint FROM workspace_pin").pluck().get()).toBe(TEST_WORKSPACE.endpoint);
  });

  it("is the same workspace otherwise: its name, its profile, and another profile where a test needs one", () => {
    const usual = open(unmigrated().dir);
    const other = open(unmigrated({ endpoint: "https://router.corp.example/llm" }).dir);

    expect(usual.config).toMatchObject({ name: TEST_WORKSPACE.name, profile: TEST_PROFILE });
    expect(other.config.profile).toEqual({ ...TEST_PROFILE, endpoint: "https://router.corp.example/llm" });
  });

  it("is migrated by the first open, which leaves a copy of what it was", () => {
    const { dir } = unmigrated();

    const found = open(dir);

    expect(found.migration.applied).toEqual(readMigrations().map(({ tag }) => tag));
    expect(readdirSync(join(dir, "backups"))).toHaveLength(1);
  });

  it("removes the workspace with the directory it was made in", () => {
    const created = createUnmigratedTestWorkspace();

    created.remove();
    created.remove();

    expect(existsSync(dirname(created.dir))).toBe(false);
  });
});

describe("createTestWorkspaceAt", () => {
  it("creates the throwaway workspace at the place it is given", () => {
    const dir = join(tempDir(), "e2e");

    createTestWorkspaceAt(dir);

    expect(open(dir).config.profile).toEqual(TEST_PROFILE);
  });

  it("never writes over what is at that place", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "precious.txt"), "data");

    expect(() => createTestWorkspaceAt(dir)).toThrow(WorkspaceError);
    expect(readdirSync(dir)).toEqual(["precious.txt"]);
  });
});

describe("spellingsOf", () => {
  it("knows seven ways in which a secret could end up in a file", () => {
    const spellings = Object.fromEntries(
      spellingsOf('a"b/c d').map(({ name, bytes }) => [name, bytes.toString("latin1")]),
    );

    expect(spellings).toEqual({
      "utf-8": 'a"b/c d',
      "utf-16le": 'a\0"\0b\0/\0c\0 \0d\0',
      base64: "YSJiL2MgZA",
      base64url: "YSJiL2MgZA",
      hex: "6122622f632064",
      "percent-encoded": "a%22b%2Fc%20d",
      "JSON-escaped": 'a\\"b/c d',
    });
  });

  it("leaves out a spelling that is the plain text again", () => {
    expect(spellingsOf(SECRET).map(({ name }) => name)).toEqual(["utf-8", "utf-16le", "base64", "base64url", "hex"]);
    expect(spellingsOf(AWKWARD_SECRET)).toHaveLength(7);
  });
});

describe("scanWorkspaceForSecret", () => {
  it("finds nothing in a workspace that holds no secret, and leaves the directory as it found it", () => {
    const { dir } = workspace();
    const before = fingerprint(dir);

    expect(scanWorkspaceForSecret(dir, SECRET)).toEqual([]);

    // A database that is closed stays one file: the scan must not leave its own traces beside it.
    expect(readdirSync(dir).sort()).toEqual(LAYOUT);
    expect(fingerprint(dir)).toEqual(before);
  });

  // The controls: a scan that finds nothing proves something only if it can find what it looks for.
  it("finds a secret in a file in every spelling", () => {
    const { dir } = workspace();
    const spellings = spellingsOf(AWKWARD_SECRET);
    mkdirSync(join(dir, "files", "2026", "10"), { recursive: true });
    for (const { name, bytes } of spellings) {
      writeFileSync(
        join(dir, "files", "2026", "10", `${name}.bin`),
        Buffer.concat([Buffer.from("xx"), bytes, Buffer.from("yy")]),
      );
    }

    const findings = scanWorkspaceForSecret(dir, AWKWARD_SECRET);

    expect(findings).toEqual(
      expect.arrayContaining(
        spellings.map(({ name }) => ({ where: join(dir, "files", "2026", "10", `${name}.bin`), spelling: name })),
      ),
    );
    expect(findings.every((finding) => finding.where.includes("/files/2026/10/"))).toBe(true);
  });

  it("finds a secret that is what a file, a directory or a link is called, in every spelling a name can have", () => {
    // A name is kept by the directory that holds the entry: it is in the bytes of no file.
    const { dir } = workspace();
    const files = join(dir, "files");
    const spelled = Object.fromEntries(spellingsOf(SECRET).map(({ name, bytes }) => [name, bytes.toString("latin1")]));
    writeFileSync(join(files, `${SECRET}`), "");
    writeFileSync(join(files, `cache-${spelled.hex}.bin`), "");
    mkdirSync(join(files, `${spelled.base64url}.d`));
    writeFileSync(join(files, `${spelled.base64url}.d`, "inside.txt"), "nothing here");
    symlinkSync("inside.txt", join(files, `link-${SECRET}`));

    expect(scanWorkspaceForSecret(dir, SECRET)).toEqual(
      expect.arrayContaining([
        { where: `${join(files, SECRET)}: name`, spelling: "utf-8" },
        { where: `${join(files, `cache-${spelled.hex}.bin`)}: name`, spelling: "hex" },
        { where: `${join(files, `${spelled.base64url}.d`)}: name`, spelling: "base64url" },
        { where: `${join(files, `link-${SECRET}`)}: name`, spelling: "utf-8" },
      ]),
    );
  });

  it("finds a secret in where a link leads, and does not follow the link", () => {
    const { dir } = workspace();
    const outside = tempDir();
    writeFileSync(join(outside, "elsewhere.txt"), `the file outside holds ${SECRET} too`);
    const link = join(dir, "files", "shortcut");
    symlinkSync(join(outside, SECRET), link);
    // A link to a directory outside is not walked into: what lies there is not in the workspace.
    symlinkSync(outside, join(dir, "files", "outside"));

    expect(scanWorkspaceForSecret(dir, SECRET)).toEqual([{ where: `${link}: link target`, spelling: "utf-8" }]);
  });

  it("finds a secret that only the schema of the database holds", () => {
    const { dir } = workspace();
    const { database } = open(dir);
    database.exec(`CREATE TABLE settings (id INTEGER PRIMARY KEY, token TEXT DEFAULT '${SECRET}') STRICT`);
    const file = join(dir, "hubber.sqlite");

    expect(scanWorkspaceForSecret(dir, SECRET)).toEqual(
      expect.arrayContaining([{ where: `${file}: sqlite_schema.sql`, spelling: "utf-8" }]),
    );
  });

  it("finds a secret in the configuration file", () => {
    const { dir } = workspace();
    const config = join(dir, "workspace.json");
    writeFileSync(config, readFileSync(config, "utf8").replace('"bearer"', JSON.stringify(AWKWARD_SECRET)));

    expect(scanWorkspaceForSecret(dir, AWKWARD_SECRET)).toEqual([{ where: config, spelling: "JSON-escaped" }]);
  });

  it("finds a row that is only in the write-ahead log, by its bytes and through SQL", () => {
    const { dir } = workspace();
    const { database } = open(dir);
    database.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT");
    database.prepare("INSERT INTO notes (body) VALUES (?)").run(`before ${SECRET} after`);
    const file = join(dir, "hubber.sqlite");

    // The connection is still open: the row has not reached the database file yet.
    const findings = scanWorkspaceForSecret(dir, SECRET);

    expect(findings).toEqual([
      { where: `${file}-wal`, spelling: "utf-8" },
      { where: `${file}: notes.body`, spelling: "utf-8" },
    ]);
    expect(copiesIn(file, SECRET)).toBe(0);
    // The connection of the application is none the worse for the scan.
    expect(database.prepare("SELECT count(*) FROM notes").pluck().get()).toBe(1);
    expect(readdirSync(dir)).toContain("hubber.sqlite-wal");
  });

  it("finds through SQL every one of 600 values, of which the bytes of the file show only some whole", () => {
    // A database built by hand, with small pages: a value longer than a page is cut into
    // pieces, and a secret that lies across a cut is in no run of bytes of the file.
    const dir = tempDir();
    const file = join(dir, "hubber.sqlite");
    const db = new Database(file);
    connections.push(db);
    db.pragma("page_size = 512");
    db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT");
    const insert = db.prepare("INSERT INTO notes (body) VALUES (?)");
    const rows = 600;
    // The secret at every offset from 0 to 599 inside a value of the same length.
    for (let offset = 0; offset < rows; offset++)
      insert.run(`${"a".repeat(offset)}${SECRET}${"b".repeat(1500 - offset)}`);
    db.close();

    const findings = scanWorkspaceForSecret(dir, SECRET);

    const whole = copiesIn(file, SECRET);
    expect(whole).toBeGreaterThan(0);
    expect(whole).toBeLessThan(rows);
    expect(findings.filter((finding) => finding.where === `${file}: notes.body`)).toHaveLength(rows);
    // The file is not a workspace database at all: the scan does not depend on the pin.
    expect(findings.filter((finding) => finding.where === file)).toEqual([{ where: file, spelling: "utf-8" }]);
  });

  it("finds through SQL a secret that only a copy from before a migration still holds", () => {
    const { dir } = workspace();
    const found = open(dir);
    const file = join(dir, "hubber.sqlite");
    const copy = join(dir, "backups", "before-0002_next-20261011T120000000Z.sqlite");
    // A note that the owner removes later; the copy was made while it was there.
    found.database
      .prepare("INSERT INTO persons (id, name, name_norm, is_me, created_at, note) VALUES (?, ?, ?, 0, ?, ?)")
      .run("per_anna", "Anna", "anna", "2026-10-12T09:00:00.000Z", `before ${SECRET} after`);
    mkdirSync(join(dir, "backups"));
    snapshotWorkspaceDatabase(found.database, copy);
    found.database.exec("DELETE FROM persons");
    found.close();
    const before = fingerprint(dir);

    const findings = scanWorkspaceForSecret(dir, SECRET);

    // Gone from the database, by its bytes and through SQL; the copy has it, and is read both ways too.
    expect(findings).toEqual([
      { where: copy, spelling: "utf-8" },
      { where: `${copy}: persons.note`, spelling: "utf-8" },
    ]);
    expect(copiesIn(file, SECRET)).toBe(0);
    expect(fingerprint(dir)).toEqual(before);
    expect(readdirSync(join(dir, "backups"))).toEqual(["before-0002_next-20261011T120000000Z.sqlite"]);
  });

  it("reads every copy through SQL, and does not take other files there for databases", () => {
    const { dir } = workspace();
    const found = open(dir);
    const backups = join(dir, "backups");
    mkdirSync(backups);
    // Values that the bytes of a file do not all show whole: longer than a page, each is cut into
    // pieces, and the secret is moved through them in steps shorter than itself, across a whole page.
    found.database.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT");
    const insert = found.database.prepare("INSERT INTO notes (body) VALUES (?)");
    const rows = 105;
    // In one transaction: every commit of this connection waits for the drive.
    found.database.transaction(() => {
      for (let step = 0; step < rows; step++) {
        insert.run(`${"a".repeat(4500 + 40 * step)}${SECRET}${"b".repeat(4200 - 40 * step)}`);
      }
    })();
    snapshotWorkspaceDatabase(found.database, join(backups, "first.sqlite"));
    snapshotWorkspaceDatabase(found.database, join(backups, "second.sqlite"));
    writeFileSync(join(backups, "notes.txt"), "not a database");
    writeFileSync(join(backups, "third.sqlite.partial"), "a copy that was cut short");

    const findings = scanWorkspaceForSecret(dir, SECRET);

    for (const name of ["first.sqlite", "second.sqlite"]) {
      const path = join(backups, name);
      expect(findings.filter((finding) => finding.where === `${path}: notes.body`)).toHaveLength(rows);
      expect(copiesIn(path, SECRET)).toBeLessThan(rows);
    }
    expect(findings.some((finding) => finding.where.includes("notes.txt"))).toBe(false);
    expect(findings.some((finding) => finding.where.includes("third.sqlite.partial"))).toBe(false);
  });

  it("finds a secret in a value of any spelling and of any type that can hold one", () => {
    const { dir } = workspace();
    const { database } = open(dir);
    database.exec("CREATE TABLE leak (id INTEGER PRIMARY KEY, header TEXT, raw BLOB, size INTEGER) STRICT");
    database
      .prepare("INSERT INTO leak (header, raw, size) VALUES (?, ?, ?)")
      .run(`Bearer ${Buffer.from(SECRET).toString("base64")}`, Buffer.from(SECRET, "utf16le"), SECRET.length);
    const file = join(dir, "hubber.sqlite");

    const throughSql = scanWorkspaceForSecret(dir, SECRET).filter((finding) => finding.where.startsWith(`${file}: `));

    expect(throughSql).toEqual(
      expect.arrayContaining([
        { where: `${file}: leak.header`, spelling: "base64" },
        { where: `${file}: leak.raw`, spelling: "utf-16le" },
      ]),
    );
  });
});
