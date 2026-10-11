// The SQLite file of a workspace: how it is created, how it is opened, and the endpoint pin it
// carries. No ORM here: Drizzle goes on top of the connection that openWorkspaceDatabase()
// returns, and never declares workspace_pin in its schema.
//
// The only module that imports better-sqlite3 (lint): nobody gets a connection to a workspace
// database without the checks below.
import { closeSync, openSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { PRIVATE_FILE_MODE } from "./layout.ts";

export type WorkspaceDatabase = Database.Database;

/** "HUBR" in ASCII, written once into the file header (PRAGMA application_id). */
export const APPLICATION_ID = 0x48554252;

/**
 * Version of what this module itself keeps in the file (PRAGMA user_version).
 * 1: the workspace_pin table. The migrations of the application schema are counted elsewhere,
 * so this number changes only when the pin itself changes shape.
 */
export const WORKSPACE_FORMAT = 1;

/** How long a statement waits for a lock held by another process, e.g. a backup command. */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * One row, written when the workspace is created and never changed afterwards. The CHECK leaves
 * room for one row only, and the triggers reject every later write. The INSERT trigger is the one
 * that stops INSERT OR REPLACE: REPLACE removes the old row without firing a DELETE trigger.
 * This guards against a mistake in later code, not against someone who edits the file on purpose.
 */
const PIN_SCHEMA = `
  CREATE TABLE workspace_pin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    endpoint TEXT NOT NULL CHECK (endpoint <> ''),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER workspace_pin_insert_once BEFORE INSERT ON workspace_pin
  WHEN EXISTS (SELECT 1 FROM workspace_pin)
  BEGIN SELECT RAISE(ABORT, 'workspace_pin is immutable'); END;
  CREATE TRIGGER workspace_pin_no_update BEFORE UPDATE ON workspace_pin
  BEGIN SELECT RAISE(ABORT, 'workspace_pin is immutable'); END;
  CREATE TRIGGER workspace_pin_no_delete BEFORE DELETE ON workspace_pin
  BEGIN SELECT RAISE(ABORT, 'workspace_pin is immutable'); END;
`;

export type WorkspaceDatabaseProblem =
  /** create: something is already at the path. */
  | "exists"
  /** create: the file system refused WAL mode (a network share, for example). */
  | "wal-unavailable"
  /** open: there is no file at the path. */
  | "missing"
  /** open: the file is not an SQLite database, or not one that Hubber created. */
  | "foreign"
  /** open: the file was written by a newer Hubber than this one. `format` is the file's. */
  | "newer"
  /** open: the file is Hubber's, but the pin is not in it. */
  | "no-pin"
  /** open: the pin names another endpoint than the expected one. `storedEndpoint` is the file's. */
  | "pinned-elsewhere"
  /** Anything else SQLite reports. `sqliteCode` says what. */
  | "sqlite";

/**
 * Says what is wrong and carries the facts. The message is for a log line of last resort: the
 * callers (create.ts, open.ts) put every problem into the user's words, because those words
 * need what only the callers know (the workspace's name, its configuration file).
 */
export class WorkspaceDatabaseError extends Error {
  override name = "WorkspaceDatabaseError";
  readonly problem: WorkspaceDatabaseProblem;
  readonly path: string;
  readonly storedEndpoint?: string;
  readonly format?: number;
  readonly sqliteCode?: string;

  constructor(
    problem: WorkspaceDatabaseProblem,
    path: string,
    facts: { storedEndpoint?: string; format?: number; sqliteCode?: string } = {},
  ) {
    super(`Workspace database ${path}: ${problem}${facts.sqliteCode === undefined ? "" : ` (${facts.sqliteCode})`}`);
    this.problem = problem;
    this.path = path;
    if (facts.storedEndpoint !== undefined) this.storedEndpoint = facts.storedEndpoint;
    if (facts.format !== undefined) this.format = facts.format;
    if (facts.sqliteCode !== undefined) this.sqliteCode = facts.sqliteCode;
  }
}

export interface WorkspacePin {
  /** The endpoint address in its canonical form, exactly as the configuration file holds it. */
  endpoint: string;
  /** ISO 8601, UTC: the same instant as "createdAt" of the configuration file. */
  createdAt: string;
}

/**
 * Makes a commit wait until the drive has written it. FULL has SQLite sync after every
 * transaction; better-sqlite3 opens a WAL database with NORMAL, which syncs at checkpoints only.
 * On macOS the sync that SQLite asks for by default hands the data to the drive and returns while
 * the drive may still hold it in its cache, so a power cut can lose commits that had returned.
 * The two flags make it the sync that waits for the drive itself (F_FULLFSYNC), at a few
 * milliseconds a commit. All three are settings of a connection, not of the file.
 */
function waitForTheDrive(db: WorkspaceDatabase): void {
  db.pragma("synchronous = FULL");
  db.pragma("fullfsync = ON");
  db.pragma("checkpoint_fullfsync = ON");
}

function isSqliteError(error: unknown, ...codes: string[]): error is InstanceType<typeof Database.SqliteError> {
  return (
    error instanceof Database.SqliteError && (codes.length === 0 || codes.some((code) => error.code.startsWith(code)))
  );
}

/**
 * Creates the database of a new workspace and writes the pin into it. The file is created by
 * this call and by nothing else: a path that already exists is an error, never a database to
 * reuse. On any failure the files this call created are removed again. Leaves exactly one file.
 */
export function createWorkspaceDatabase(path: string, pin: WorkspacePin): void {
  try {
    // Created here, and not by SQLite, for two reasons: "wx" fails when anything is already
    // there, and the mode keeps the file private. SQLite gives the -wal and -shm files the mode
    // of the database file, and treats an empty file as a new database.
    closeSync(openSync(path, "wx", PRIVATE_FILE_MODE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WorkspaceDatabaseError("exists", path);
    throw error;
  }

  try {
    const db = new Database(path, { fileMustExist: true, timeout: BUSY_TIMEOUT_MS });
    try {
      // Stored in the file, so set once. It cannot change inside a transaction.
      if (db.pragma("journal_mode = WAL", { simple: true }) !== "wal") {
        throw new WorkspaceDatabaseError("wal-unavailable", path);
      }
      waitForTheDrive(db);
      // The header fields and the pin land together or not at all.
      db.transaction(() => {
        db.pragma(`application_id = ${APPLICATION_ID}`);
        db.pragma(`user_version = ${WORKSPACE_FORMAT}`);
        db.exec(PIN_SCHEMA);
        db.prepare("INSERT INTO workspace_pin (id, endpoint, created_at) VALUES (1, ?, ?)").run(
          pin.endpoint,
          pin.createdAt,
        );
      })();
    } finally {
      // The last connection to close folds the WAL into the main file and removes -wal and -shm.
      db.close();
    }
  } catch (error) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    if (isSqliteError(error)) throw new WorkspaceDatabaseError("sqlite", path, { sqliteCode: error.code });
    throw error;
  }
}

/**
 * Opens the database of an existing workspace. The connection is handed out only when the file
 * is Hubber's, no newer than this code, and pinned to `expectedEndpoint`; otherwise the file is
 * closed again and the error says which of these failed.
 *
 * The checks themselves write nothing, and nothing is set in the file before they pass. Opening
 * and closing is another matter: when a process that was killed has left a write-ahead log beside
 * the file, SQLite folds that log into the file as soon as anyone opens and closes it. So a
 * refused open, too, can leave the file with other bytes and one file where there were three; what
 * the database holds is the same before and after.
 */
export function openWorkspaceDatabase(path: string, expectedEndpoint: string): WorkspaceDatabase {
  let db: WorkspaceDatabase;
  try {
    db = new Database(path, { fileMustExist: true, timeout: BUSY_TIMEOUT_MS });
  } catch (error) {
    if (isSqliteError(error, "SQLITE_CANTOPEN")) throw new WorkspaceDatabaseError("missing", path);
    if (isSqliteError(error)) throw new WorkspaceDatabaseError("sqlite", path, { sqliteCode: error.code });
    throw error;
  }

  try {
    let applicationId: unknown;
    try {
      applicationId = db.pragma("application_id", { simple: true });
    } catch (error) {
      // Not a database at all. A file that SQLite cannot read is no more Hubber's than one it can.
      if (!isSqliteError(error, "SQLITE_NOTADB", "SQLITE_CORRUPT")) throw error;
    }
    if (applicationId !== APPLICATION_ID) throw new WorkspaceDatabaseError("foreign", path);

    const format = db.pragma("user_version", { simple: true }) as number;
    if (format > WORKSPACE_FORMAT) throw new WorkspaceDatabaseError("newer", path, { format });

    const hasPinTable = db
      .prepare("SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'workspace_pin'")
      .pluck()
      .get();
    const row = hasPinTable
      ? (db.prepare("SELECT endpoint, created_at AS createdAt FROM workspace_pin WHERE id = 1").get() as
          | WorkspacePin
          | undefined)
      : undefined;
    if (format < 1 || row === undefined) throw new WorkspaceDatabaseError("no-pin", path);

    // Letter by letter: both strings were written by the same canonical spelling at creation.
    if (row.endpoint !== expectedEndpoint) {
      throw new WorkspaceDatabaseError("pinned-elsewhere", path, { storedEndpoint: row.endpoint });
    }

    // Per connection, so set at every open.
    db.pragma("foreign_keys = ON");
    waitForTheDrive(db);
    // A file restored from a VACUUM INTO snapshot is not in WAL mode.
    if (db.pragma("journal_mode", { simple: true }) !== "wal") db.pragma("journal_mode = WAL");
    return db;
  } catch (error) {
    db.close();
    if (isSqliteError(error)) throw new WorkspaceDatabaseError("sqlite", path, { sqliteCode: error.code });
    throw error;
  }
}

/** The pin as stored. */
export function readWorkspacePin(db: WorkspaceDatabase): WorkspacePin {
  return db.prepare("SELECT endpoint, created_at AS createdAt FROM workspace_pin WHERE id = 1").get() as WorkspacePin;
}
