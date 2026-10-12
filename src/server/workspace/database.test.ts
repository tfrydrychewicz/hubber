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
  snapshotWorkspaceDatabase,
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
// And it keeps what the module asked the system to write to the drive, to name and to remove, in
// order: whether a file reached the drive before it got its name cannot be read from the directory.
// With a path to watch, each step is kept with the size that file had just before it, "absent"
// for a file that was not there: what stood under a name at a moment that is over cannot be read
// afterwards either. And a file system without hard links is not at hand: with a code set here, the
// system refuses every link with it, the way exFAT does with ENOTSUP. Nor is a drive that fails at
// one moment: with a path set here, the system refuses to write that file or directory to the drive.
const disk = vi.hoisted(() => ({
  refusesWal: false,
  linkFailsWith: undefined as string | undefined,
  syncFailsFor: undefined as string | undefined,
  pragmas: [] as string[],
  steps: [] as string[],
  watched: undefined as string | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const opened = new Map<number, string>();
  const note = (step: string) => {
    const size =
      disk.watched === undefined
        ? undefined
        : (real.statSync(disk.watched, { throwIfNoEntry: false })?.size ?? "absent");
    disk.steps.push(size === undefined ? step : `${step} [${size}]`);
  };
  return {
    ...real,
    openSync: (...args: Parameters<typeof real.openSync>) => {
      const descriptor = real.openSync(...args);
      opened.set(descriptor, String(args[0]));
      return descriptor;
    },
    fsyncSync: (descriptor: number) => {
      note(`sync ${opened.get(descriptor)}`);
      if (opened.get(descriptor) === disk.syncFailsFor) {
        throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
      }
      real.fsyncSync(descriptor);
    },
    renameSync: (from: string, to: string) => {
      note(`rename ${from} to ${to}`);
      real.renameSync(from, to);
    },
    linkSync: (from: string, to: string) => {
      note(`link ${from} to ${to}`);
      if (disk.linkFailsWith !== undefined) {
        throw Object.assign(new Error(`${disk.linkFailsWith}: link '${from}' -> '${to}'`), {
          code: disk.linkFailsWith,
        });
      }
      real.linkSync(from, to);
    },
    rmSync: (...args: Parameters<typeof real.rmSync>) => {
      note(`remove ${args[0]}`);
      real.rmSync(...args);
    },
  };
});
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
  disk.linkFailsWith = undefined;
  disk.syncFailsFor = undefined;
  disk.watched = undefined;
  disk.pragmas.length = 0;
  process.umask(startUmask);
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  // Last: the tidying above is kept as steps too.
  disk.steps.length = 0;
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
      // Also before the first write: what the creating connection deletes must not stay readable either.
      "secure_delete = ON",
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

  it("writes zeros over what is deleted, so that a deleted text is not left in the file", () => {
    // A text long enough to be found, short enough to stay inside one page of the table.
    const text = "usunięta-wrzutka-".repeat(20);
    const write = (db: Database.Database) => {
      db.exec("CREATE TABLE drops (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT");
      db.prepare("INSERT INTO drops (body) VALUES (?)").run(text);
      // Folded into the file first: the row is then deleted from the file itself, not from the log.
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.exec("DELETE FROM drops");
      db.close();
    };
    // The control: a connection left to itself only marks the space of the row as free.
    const plainPath = created();
    const plain = raw(plainPath);
    expect(plain.pragma("secure_delete", { simple: true })).toBe(0);
    write(plain);
    expect(readFileSync(plainPath).includes(text)).toBe(true);

    const path = created();
    const db = opened(path);
    expect(db.pragma("secure_delete", { simple: true })).toBe(1);
    write(db);

    expect(readFileSync(path).includes(text)).toBe(false);
    expect(entries(path)).toEqual([DATABASE_FILE]);
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

describe("snapshotWorkspaceDatabase", () => {
  /** A database with a row that only its write-ahead log holds, and the place for a copy beside it. */
  function withUnfoldedRow(): { db: WorkspaceDatabase; path: string; target: string } {
    const path = created();
    const db = opened(path);
    db.exec("CREATE TABLE drops (body TEXT NOT NULL) STRICT; INSERT INTO drops VALUES ('tylko-w-dzienniku')");
    return { db, path, target: join(dirname(path), "kopia.sqlite") };
  }

  it("writes the whole database into one new file, what only the log holds included", () => {
    const { db, path, target } = withUnfoldedRow();
    expect(readFileSync(path).includes("tylko-w-dzienniku")).toBe(false);

    snapshotWorkspaceDatabase(db, target);

    // Nothing of the making is left: no partial file and no journal of the copy.
    expect(entries(path)).toEqual([DATABASE_FILE, ...SIDE_FILES, "kopia.sqlite"].sort());
    const copy = raw(target, { readonly: true });
    expect(copy.prepare("SELECT body FROM drops").pluck().all()).toEqual(["tylko-w-dzienniku"]);
    expect(copy.prepare("SELECT endpoint, created_at AS createdAt FROM workspace_pin").get()).toEqual({
      endpoint: ROUTER,
      createdAt: CREATED_AT,
    });
    expect(copy.pragma("application_id", { simple: true })).toBe(APPLICATION_ID);
    expect(copy.pragma("user_version", { simple: true })).toBe(WORKSPACE_FORMAT);
    expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("makes the copy private whatever the shell would let others read", () => {
    process.umask(0o022);
    const { db, target } = withUnfoldedRow();

    snapshotWorkspaceDatabase(db, target);

    expect(mode(target)).toBe("600");
  });

  it("gives the copy its name only once the drive has it, and then has the drive keep the name", () => {
    const { db, path, target } = withUnfoldedRow();
    disk.steps.length = 0;

    snapshotWorkspaceDatabase(db, target);

    // A power cut leaves either no copy of that name or a whole one. The name is a second name
    // for the finished file, and the first one is taken away afterwards.
    expect(disk.steps).toEqual([
      `sync ${target}.partial`,
      `link ${target}.partial to ${target}`,
      `remove ${target}.partial`,
      `sync ${dirname(path)}`,
    ]);
  });

  it("never lets the name of the copy stand for less than the whole copy, not even for a moment", () => {
    const { db, target } = withUnfoldedRow();
    disk.steps.length = 0;
    disk.watched = target;

    snapshotWorkspaceDatabase(db, target);

    // What was under the name just before each step: nothing until the copy was whole and on the
    // drive, and all of it from then on. A process killed at any point leaves no empty file there.
    const whole = statSync(target).size;
    expect(whole).toBeGreaterThan(0);
    expect(disk.steps.map((step) => step.replace(/^(\w+) .* \[(.+)\]$/, "$1: $2"))).toEqual([
      "sync: absent",
      "link: absent",
      `remove: ${whole}`,
      `sync: ${whole}`,
    ]);
  });

  describe("where the system refuses the link", () => {
    // What macOS and Linux answer for a link on exFAT or FAT, which have no hard links, and what
    // another file system may answer, a network share or a folder that a program keeps in step
    // with a server: the copy is made wherever a file can be created and renamed.
    it.each(["ENOTSUP", "EPERM", "ENOSYS", "EOPNOTSUPP", "EACCES", "EMLINK", "EIO"])(
      "takes the name first and moves the copy over it, whole and private (%s)",
      (code) => {
        process.umask(0o022);
        const { db, path, target } = withUnfoldedRow();
        disk.linkFailsWith = code;
        disk.steps.length = 0;

        snapshotWorkspaceDatabase(db, target);

        expect(disk.steps).toEqual([
          `sync ${target}.partial`,
          `link ${target}.partial to ${target}`,
          `rename ${target}.partial to ${target}`,
          `sync ${dirname(path)}`,
        ]);
        expect(entries(path)).toEqual([DATABASE_FILE, ...SIDE_FILES, "kopia.sqlite"].sort());
        expect(mode(target)).toBe("600");
        const copy = raw(target, { readonly: true });
        expect(copy.prepare("SELECT body FROM drops").pluck().all()).toEqual(["tylko-w-dzienniku"]);
        expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
      },
    );

    it("never writes over a copy that is already there either", () => {
      const { db, path, target } = withUnfoldedRow();
      disk.linkFailsWith = "ENOTSUP";
      writeFileSync(target, "an earlier copy");
      const before = entries(path);

      expect(() => snapshotWorkspaceDatabase(db, target)).toThrow(/EEXIST/);

      expect(readFileSync(target, "utf8")).toBe("an earlier copy");
      expect(entries(path)).toEqual(before);
    });
  });

  it("does not try the other way for a name that the link found taken: that is passed on, and nothing is left behind", () => {
    const { db, path, target } = withUnfoldedRow();
    // As the link saw it. Whatever had the name is somebody else's, also when it is gone a moment later.
    disk.linkFailsWith = "EEXIST";
    const before = entries(path);

    expect(() => snapshotWorkspaceDatabase(db, target)).toThrow(/EEXIST/);

    expect(entries(path)).toEqual(before);
  });

  // The last step, after the copy has its name: the directory that holds the name goes to the drive.
  it.each([
    ["by a link", undefined],
    ["by a move over an empty file", "ENOTSUP"],
  ])("removes the copy again when a later step fails, also once it has got its name %s", (_how, linkFailsWith) => {
    const { db, path, target } = withUnfoldedRow();
    disk.linkFailsWith = linkFailsWith;
    disk.syncFailsFor = dirname(target);
    disk.steps.length = 0;
    const before = entries(path);

    expect(() => snapshotWorkspaceDatabase(db, target)).toThrow(/EIO/);

    // The control: the copy had its name when the step failed.
    expect(disk.steps.slice(0, 3)).toEqual([
      `sync ${target}.partial`,
      `link ${target}.partial to ${target}`,
      linkFailsWith === undefined ? `remove ${target}.partial` : `rename ${target}.partial to ${target}`,
    ]);
    expect(entries(path)).toEqual(before);
  });

  it("makes a copy that is one file without a log, so it opens from its bytes alone", () => {
    const { db, target } = withUnfoldedRow();

    snapshotWorkspaceDatabase(db, target);

    const onDisk = raw(target, { readonly: true });
    expect(onDisk.pragma("journal_mode", { simple: true })).toBe("delete");
    const fromBytes = new Database(readFileSync(target));
    connections.push(fromBytes);
    expect(fromBytes.prepare("SELECT body FROM drops").pluck().all()).toEqual(["tylko-w-dzienniku"]);
  });

  it("leaves the database it copies as it was", () => {
    const { db, path, target } = withUnfoldedRow();
    const watching = raw(path);
    const version = watching.pragma("data_version", { simple: true });
    const before = [digest(path), digest(`${path}-wal`)];

    snapshotWorkspaceDatabase(db, target);

    expect([digest(path), digest(`${path}-wal`)]).toEqual(before);
    expect(watching.pragma("data_version", { simple: true })).toBe(version);
  });

  it("can be opened as the database of the workspace once it is put in its place", () => {
    const { db, target } = withUnfoldedRow();
    snapshotWorkspaceDatabase(db, target);

    const restored = opened(target);

    expect(restored.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(restored.prepare("SELECT body FROM drops").pluck().all()).toEqual(["tylko-w-dzienniku"]);
  });

  it("never writes over a copy that is already there, and leaves nothing of its own beside it", () => {
    const { db, path, target } = withUnfoldedRow();
    writeFileSync(target, "an earlier copy");
    const before = entries(path);

    expect(() => snapshotWorkspaceDatabase(db, target)).toThrow(/EEXIST/);

    expect(readFileSync(target, "utf8")).toBe("an earlier copy");
    expect(entries(path)).toEqual(before);
  });

  it("leaves alone a partial file of that name, which is somebody else's copy in the making", () => {
    const { db, path, target } = withUnfoldedRow();
    writeFileSync(`${target}.partial`, "half a copy");
    const before = entries(path);

    expect(() => snapshotWorkspaceDatabase(db, target)).toThrow(/EEXIST/);

    expect(readFileSync(`${target}.partial`, "utf8")).toBe("half a copy");
    expect(entries(path)).toEqual(before);
  });

  it("removes what it began when SQLite refuses to write the copy", () => {
    const { db, path, target } = withUnfoldedRow();
    const before = entries(path);
    db.exec("BEGIN");

    // Passed on as SQLite said it: the caller knows what the copy was for.
    expect(() => snapshotWorkspaceDatabase(db, target)).toThrow("cannot VACUUM from within a transaction");

    db.exec("ROLLBACK");
    expect(entries(path)).toEqual(before);
  });

  it("passes on what the system says when there is no directory for the copy", () => {
    const { db, path } = withUnfoldedRow();
    const before = entries(path);

    expect(() => snapshotWorkspaceDatabase(db, join(dirname(path), "no-such-directory", "kopia.sqlite"))).toThrow(
      /ENOENT/,
    );

    expect(entries(path)).toEqual(before);
  });
});
