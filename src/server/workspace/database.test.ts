import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPLICATION_ID,
  createWorkspaceDatabase,
  openWorkspaceDatabase,
  readWorkspacePin,
  WORKSPACE_FORMAT,
  type WorkspaceDatabase,
  WorkspaceDatabaseError,
} from "./database.ts";
import { DATABASE_FILE } from "./layout.ts";

// A disk that cannot do WAL is not at hand, so the library is made to answer like one: with
// the switch on, the question for WAL mode is not passed on, and SQLite reports the mode it
// stays in. Everything else goes to the real library.
// It also keeps what every connection was asked to set: a setting of the connection that
// creates the database is gone with that connection, and cannot be read from the file afterwards.
const disk = vi.hoisted(() => ({ refusesWal: false, pragmas: [] as string[] }));
vi.mock("better-sqlite3", async (importOriginal) => {
  const { default: Real } = await importOriginal<{ default: typeof Database }>();
  return {
    default: class extends Real {
      override pragma(source: string, options?: Database.PragmaOptions): unknown {
        disk.pragmas.push(source);
        const asked = disk.refusesWal && /^journal_mode\s*=/i.test(source) ? "journal_mode" : source;
        return super.pragma(asked, options);
      }
    },
  };
});

const ROUTER = "https://router.corp.example/llm";
const ANTHROPIC = "https://api.anthropic.com";
const CREATED_AT = "2026-10-10T20:00:00.000Z";
const SIDE_FILES = [`${DATABASE_FILE}-shm`, `${DATABASE_FILE}-wal`];

const tempDirs: string[] = [];
const connections: Database.Database[] = [];
const startUmask = process.umask();

afterEach(() => {
  disk.refusesWal = false;
  disk.pragmas.length = 0;
  process.umask(startUmask);
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The path of a database file in a directory of its own, where nothing exists yet. */
function freshPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hubber-database-"));
  tempDirs.push(dir);
  return join(dir, DATABASE_FILE);
}

function created(endpoint = ROUTER): string {
  const path = freshPath();
  createWorkspaceDatabase(path, { endpoint, createdAt: CREATED_AT });
  return path;
}

function opened(path: string, endpoint = ROUTER): WorkspaceDatabase {
  const db = openWorkspaceDatabase(path, endpoint);
  connections.push(db);
  return db;
}

/** A connection that goes around the module, for building files that the module has to refuse. */
function raw(path: string, options: Database.Options = {}): Database.Database {
  const db = new Database(path, options);
  connections.push(db);
  return db;
}

function failure(run: () => unknown): WorkspaceDatabaseError {
  try {
    run();
  } catch (error) {
    if (error instanceof WorkspaceDatabaseError) return error;
    throw error;
  }
  throw new Error("No WorkspaceDatabaseError was thrown.");
}

const entries = (path: string) => readdirSync(dirname(path)).sort();
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("createWorkspaceDatabase", () => {
  it("leaves exactly one file behind, for the owner alone", () => {
    const path = created();

    expect(entries(path)).toEqual([DATABASE_FILE]);
    expect(mode(path)).toBe("600");
  });

  it("keeps the file private even when the shell would let others read new files", () => {
    process.umask(0);

    const path = created();

    expect(mode(path)).toBe("600");
  });

  it("marks the file as Hubber's and writes the pin into it", () => {
    const db = opened(created());

    expect(db.pragma("application_id", { simple: true })).toBe(0x48554252);
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    expect(readWorkspacePin(db)).toEqual({ endpoint: ROUTER, createdAt: CREATED_AT });
    expect(APPLICATION_ID).toBe(0x48554252);
    expect(WORKSPACE_FORMAT).toBe(1);
  });

  it("puts the file into WAL mode, with nothing else in it than the pin", () => {
    const db = raw(created(), { readonly: true });

    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.prepare("SELECT type, name FROM sqlite_schema ORDER BY name").all()).toEqual([
      { type: "table", name: "workspace_pin" },
      { type: "trigger", name: "workspace_pin_insert_once" },
      { type: "trigger", name: "workspace_pin_no_delete" },
      { type: "trigger", name: "workspace_pin_no_update" },
    ]);
    expect(db.prepare("SELECT * FROM workspace_pin").all()).toEqual([
      { id: 1, endpoint: ROUTER, created_at: CREATED_AT },
    ]);
  });

  it("writes the pin with every commit waiting for the drive itself", () => {
    created();

    // Before the first thing it writes into the file after the journal mode.
    const firstWrite = disk.pragmas.findIndex((source) => source.startsWith("application_id ="));
    expect(firstWrite).toBeGreaterThan(0);
    expect(disk.pragmas.slice(0, firstWrite)).toEqual([
      "journal_mode = WAL",
      "synchronous = FULL",
      "fullfsync = ON",
      "checkpoint_fullfsync = ON",
    ]);
  });

  it("refuses a path where something already is, and leaves that alone", () => {
    const path = freshPath();
    writeFileSync(path, "something else");

    const error = failure(() => createWorkspaceDatabase(path, { endpoint: ROUTER, createdAt: CREATED_AT }));

    expect(error).toMatchObject({ problem: "exists", path });
    expect(readFileSync(path, "utf8")).toBe("something else");
    expect(entries(path)).toEqual([DATABASE_FILE]);
  });

  it("refuses to reuse a database that it created before", () => {
    const path = created();

    expect(failure(() => createWorkspaceDatabase(path, { endpoint: ANTHROPIC, createdAt: CREATED_AT })).problem).toBe(
      "exists",
    );
    expect(readWorkspacePin(opened(path)).endpoint).toBe(ROUTER);
  });

  it("removes what it created when the pin cannot be written, and says what SQLite objected to", () => {
    const path = freshPath();

    // The CHECK on the column rejects an empty address inside the creating transaction.
    const error = failure(() => createWorkspaceDatabase(path, { endpoint: "", createdAt: CREATED_AT }));

    expect(error).toMatchObject({ problem: "sqlite", path, sqliteCode: "SQLITE_CONSTRAINT_CHECK" });
    expect(error.message).toBe(`Workspace database ${path}: sqlite (SQLITE_CONSTRAINT_CHECK)`);
    expect(entries(path)).toEqual([]);
  });

  it("gives up, and removes the file, on a disk that cannot do WAL", () => {
    const path = freshPath();
    disk.refusesWal = true;

    const error = failure(() => createWorkspaceDatabase(path, { endpoint: ROUTER, createdAt: CREATED_AT }));

    expect(error).toMatchObject({ problem: "wal-unavailable", path });
    expect(error.sqliteCode).toBeUndefined();
    expect(entries(path)).toEqual([]);
  });

  it("passes on what the system says when the file cannot be created at all", () => {
    const path = join(freshPath(), "no-such-directory", DATABASE_FILE);

    expect(() => createWorkspaceDatabase(path, { endpoint: ROUTER, createdAt: CREATED_AT })).toThrow(/ENOENT/);
  });
});

describe("openWorkspaceDatabase", () => {
  it("opens with the endpoint the workspace was created for", () => {
    const db = opened(created());

    expect(db.open).toBe(true);
    expect(readWorkspacePin(db)).toEqual({ endpoint: ROUTER, createdAt: CREATED_AT });
  });

  it("sets up the connection for data that must not be lost", () => {
    const path = created();
    // The control: left to itself, the library reopens a WAL database with NORMAL (1), which
    // can lose the last commits in a power cut, and with a sync that does not wait for the drive.
    const plain = raw(path);
    expect(plain.pragma("synchronous", { simple: true })).toBe(1);
    expect(plain.pragma("fullfsync", { simple: true })).toBe(0);
    expect(plain.pragma("checkpoint_fullfsync", { simple: true })).toBe(0);
    plain.close();

    const db = opened(path);

    expect(db.pragma("synchronous", { simple: true })).toBe(2);
    // On macOS the sync that waits until the drive has written; elsewhere the flags change nothing.
    expect(db.pragma("fullfsync", { simple: true })).toBe(1);
    expect(db.pragma("checkpoint_fullfsync", { simple: true })).toBe(1);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(db.readonly).toBe(false);
  });

  it("enforces foreign keys on the connection it hands out", () => {
    const db = opened(created());
    db.exec(`
      CREATE TABLE person (id INTEGER PRIMARY KEY) STRICT;
      CREATE TABLE note (person_id INTEGER NOT NULL REFERENCES person (id)) STRICT;
    `);

    expect(() => db.exec("INSERT INTO note VALUES (7)")).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("refuses another endpoint, says which one the file is pinned to, and leaves the directory as it was", () => {
    const path = created(ROUTER);
    const before = digest(path);

    const error = failure(() => openWorkspaceDatabase(path, ANTHROPIC));

    expect(error).toMatchObject({ problem: "pinned-elsewhere", path, storedEndpoint: ROUTER });
    // No side file: the connection was closed before the error was thrown.
    expect(entries(path)).toEqual([DATABASE_FILE]);
    expect(digest(path)).toBe(before);
  });

  it.each([
    ["a slash at the end", `${ROUTER}/`],
    ["capitals", ROUTER.toUpperCase()],
    ["http for https", ROUTER.replace("https:", "http:")],
    ["a longer path", `${ROUTER}/v1`],
    ["a shorter path", "https://router.corp.example"],
    ["a space at the end", `${ROUTER} `],
  ])("compares the address letter by letter, so %s is another endpoint too", (_what, other) => {
    const path = created(ROUTER);

    expect(failure(() => openWorkspaceDatabase(path, other))).toMatchObject({
      problem: "pinned-elsewhere",
      storedEndpoint: ROUTER,
    });
  });

  it("reports a missing file without creating one", () => {
    const path = freshPath();

    expect(failure(() => openWorkspaceDatabase(path, ROUTER))).toMatchObject({ problem: "missing", path });
    expect(entries(path)).toEqual([]);
  });

  it.each([
    ["an empty file", ""],
    ["a few bytes of text", "abc"],
    ["a longer text file", "not a database, only text ".repeat(100)],
  ])("refuses %s as a file that is not Hubber's, and leaves it alone", (_what, content) => {
    const path = freshPath();
    writeFileSync(path, content);

    expect(failure(() => openWorkspaceDatabase(path, ROUTER))).toMatchObject({ problem: "foreign", path });
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(entries(path)).toEqual([DATABASE_FILE]);
  });

  it("refuses an SQLite database that Hubber did not create, and writes nothing into it", () => {
    const path = freshPath();
    const other = raw(path);
    other.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('cudze dane')");
    other.close();
    const before = digest(path);

    expect(failure(() => openWorkspaceDatabase(path, ROUTER)).problem).toBe("foreign");

    expect(digest(path)).toBe(before);
    expect(entries(path)).toEqual([DATABASE_FILE]);
  });

  it("refuses a file written by a newer Hubber, and says which format it has", () => {
    const path = created();
    const newer = raw(path);
    newer.pragma(`user_version = ${WORKSPACE_FORMAT + 6}`);
    newer.close();

    expect(failure(() => openWorkspaceDatabase(path, ROUTER))).toMatchObject({ problem: "newer", path, format: 7 });
    expect(entries(path)).toEqual([DATABASE_FILE]);
  });

  it.each<[string, (db: Database.Database) => void]>([
    ["has no pin table", () => {}],
    [
      "has an empty pin table",
      (db) => db.exec("CREATE TABLE workspace_pin (id INTEGER PRIMARY KEY, endpoint TEXT, created_at TEXT)"),
    ],
    [
      "has a pin, but the format number of a file without one",
      (db) => {
        db.exec("CREATE TABLE workspace_pin (id INTEGER PRIMARY KEY, endpoint TEXT, created_at TEXT)");
        db.prepare("INSERT INTO workspace_pin VALUES (1, ?, ?)").run(ROUTER, CREATED_AT);
        db.pragma("user_version = 0");
      },
    ],
  ])("refuses a file of Hubber's that %s", (_what, build) => {
    const path = freshPath();
    const db = raw(path);
    db.pragma(`application_id = ${APPLICATION_ID}`);
    db.pragma(`user_version = ${WORKSPACE_FORMAT}`);
    build(db);
    db.close();

    expect(failure(() => openWorkspaceDatabase(path, ROUTER))).toMatchObject({ problem: "no-pin", path });
  });

  it("reports what SQLite says about a file that it cannot read the pin from", () => {
    const path = freshPath();
    const db = raw(path);
    db.pragma(`application_id = ${APPLICATION_ID}`);
    db.pragma(`user_version = ${WORKSPACE_FORMAT}`);
    // A pin table of another shape: the question for the address fails.
    db.exec("CREATE TABLE workspace_pin (id INTEGER PRIMARY KEY)");
    db.close();

    const error = failure(() => openWorkspaceDatabase(path, ROUTER));

    expect(error).toMatchObject({ problem: "sqlite", path, sqliteCode: "SQLITE_ERROR" });
    expect(error.name).toBe("WorkspaceDatabaseError");
  });

  it("turns WAL back on for a file restored from a VACUUM INTO snapshot", () => {
    const snapshot = freshPath();
    opened(created()).prepare("VACUUM INTO ?").run(snapshot);
    const restored = raw(snapshot, { readonly: true });
    expect(restored.pragma("journal_mode", { simple: true })).toBe("delete");
    restored.close();

    const db = opened(snapshot);

    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(readWorkspacePin(db)).toEqual({ endpoint: ROUTER, createdAt: CREATED_AT });
  });

  it("folds in what a killed process left in the write-ahead log, also when it refuses the file", () => {
    // Opening and closing does that, not the checks. The bytes of the file change; what the
    // database holds does not, and that includes what only the log held.
    const path = created(ROUTER);
    const writer = raw(path);
    writer.exec("CREATE TABLE notes (body TEXT NOT NULL) STRICT; INSERT INTO notes VALUES ('tylko-w-dzienniku')");
    // What a killed writer leaves behind: its files as they are while its connection is open.
    const left = freshPath();
    copyFileSync(path, left);
    copyFileSync(`${path}-wal`, `${left}-wal`);
    const before = digest(left);
    expect(readFileSync(left).includes("tylko-w-dzienniku")).toBe(false);

    expect(failure(() => openWorkspaceDatabase(left, ANTHROPIC)).problem).toBe("pinned-elsewhere");

    expect(entries(left)).toEqual([DATABASE_FILE]);
    expect(digest(left)).not.toBe(before);
    expect(opened(left).prepare("SELECT body FROM notes").pluck().all()).toEqual(["tylko-w-dzienniku"]);
  });

  it("changes nothing in a file before its checks have passed", () => {
    const snapshot = freshPath();
    opened(created()).prepare("VACUUM INTO ?").run(snapshot);
    const before = digest(snapshot);

    expect(failure(() => openWorkspaceDatabase(snapshot, ANTHROPIC)).problem).toBe("pinned-elsewhere");

    // Still in the journal mode it came with: WAL is switched on only for a file that is opened.
    expect(digest(snapshot)).toBe(before);
    const untouched = raw(snapshot, { readonly: true });
    expect(untouched.pragma("journal_mode", { simple: true })).toBe("delete");
  });
});

describe("the pin", () => {
  it.each([
    ["UPDATE", "UPDATE workspace_pin SET endpoint = 'https://other.example'"],
    ["DELETE", "DELETE FROM workspace_pin"],
    ["a second row", "INSERT INTO workspace_pin (id, endpoint, created_at) VALUES (2, 'https://other.example', 'x')"],
    [
      "INSERT OR REPLACE",
      "INSERT OR REPLACE INTO workspace_pin (id, endpoint, created_at) VALUES (1, 'https://other.example', 'x')",
    ],
    ["an UPDATE that changes nothing", `UPDATE workspace_pin SET endpoint = '${ROUTER}'`],
  ])("cannot be changed by %s", (_what, sql) => {
    const db = opened(created());

    expect(() => db.exec(sql)).toThrow("workspace_pin is immutable");
    expect(readWorkspacePin(db)).toEqual({ endpoint: ROUTER, createdAt: CREATED_AT });
  });

  it("holds one row only, also for whoever drops the trigger that says so", () => {
    const db = opened(created());
    db.exec("DROP TRIGGER workspace_pin_insert_once");

    expect(() => db.exec("INSERT INTO workspace_pin VALUES (2, 'https://other.example', 'x')")).toThrow(
      /CHECK constraint failed/,
    );
  });

  it("survives a clean close and a reopen", () => {
    const path = created();
    opened(path).close();

    expect(readWorkspacePin(opened(path))).toEqual({ endpoint: ROUTER, createdAt: CREATED_AT });
  });
});

describe("what lies beside the database file", () => {
  it("is private while the database is open, and gone after a clean close", () => {
    // Whatever the shell allows: SQLite gives the side files the mode of the database file.
    process.umask(0);
    const path = created();
    const db = opened(path);
    db.exec("CREATE TABLE drops (body TEXT NOT NULL) STRICT; INSERT INTO drops VALUES ('wrzutka')");

    expect(entries(path)).toEqual([DATABASE_FILE, ...SIDE_FILES]);
    for (const name of entries(path)) expect(mode(join(dirname(path), name))).toBe("600");

    db.close();

    expect(entries(path)).toEqual([DATABASE_FILE]);
    expect(readFileSync(path).includes("wrzutka")).toBe(true);
  });

  it("holds what was written until the close folds it into the database file", () => {
    const path = created();
    const db = opened(path);
    db.exec("CREATE TABLE drops (body TEXT NOT NULL) STRICT; INSERT INTO drops VALUES ('tylko-w-dzienniku')");

    // Why a copy of the database file alone, taken while the app runs, is no backup.
    expect(readFileSync(path).includes("tylko-w-dzienniku")).toBe(false);
    expect(readFileSync(`${path}-wal`).includes("tylko-w-dzienniku")).toBe(true);
  });
});
