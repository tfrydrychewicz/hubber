// Creates a workspace as one step: either the whole directory appears under its final name, or
// nothing does. Everything is built in a staging directory beside the target and moved into
// place with one rename().
//
// The function is synchronous from the first file to the rename on purpose. A caller that has
// registered handlers for SIGINT and SIGTERM cannot be interrupted half-way: Node delivers a
// signal to a handler only between turns of the event loop, so the creation finishes first.
// What still can cut it short (SIGKILL, power loss) leaves a staging directory, never a
// half-made workspace under the real name; a later creation of the same target removes it, once
// it has lain untouched long enough to be nobody's work in progress.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { MigrationError, MigrationFilesError, migrateDatabase } from "../db/migrate.ts";
import { EXIT_FAILURE } from "../exit-codes.ts";
import {
  CONFIG_SCHEMA_VERSION,
  cleanName,
  type LlmProfile,
  parseWorkspaceConfig,
  serializeWorkspaceConfig,
  type WorkspaceConfig,
  WorkspaceConfigError,
} from "./config.ts";
import {
  createWorkspaceDatabase,
  openWorkspaceDatabase,
  WorkspaceDatabaseError,
  type WorkspacePin,
} from "./database.ts";
import { unusableMigrations, WorkspaceError } from "./errors.ts";
import { CONFIG_FILE, DATABASE_FILE, FILES_DIR, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./layout.ts";

export interface CreateWorkspaceOptions {
  /** Where the workspace goes: an absolute path that does not exist yet. */
  dir: string;
  name: string;
  /** Kind, canonical address, way of authenticating, models and diagnostics, as they will be written. */
  profile: LlmProfile;
}

/** What a test replaces. The command passes none of them. */
export interface CreateWorkspaceDeps {
  now: () => Date;
  /**
   * Creates the database with the pin in it, at the schema of this code, and closes it, leaving
   * exactly one file. Synchronous, like the rest of the creation.
   */
  createDatabase: (file: string, pin: WorkspacePin) => void;
  /** The random part of the staging directory's name. */
  token: () => string;
}

/**
 * How long a staging directory has to lie untouched before it counts as left by a creation that
 * was killed. A creation takes a fraction of a second; one that is under way must never lose its
 * staging directory to another creation of the same target that happens to run beside it.
 */
const STAGING_GRACE_MS = 60_000;

function stagingPrefix(dir: string): string {
  return `.${basename(dir)}.creating-`;
}

/**
 * The database of a new workspace: the pin, and on it the schema of this code, so that only a
 * workspace of an earlier version is migrated when the server opens it. Without a copy first:
 * there is nothing in the file to protect yet.
 */
function createCurrentDatabase(file: string, pin: WorkspacePin): void {
  createWorkspaceDatabase(file, pin);
  const db = openWorkspaceDatabase(file, pin.endpoint);
  try {
    migrateDatabase(db, { snapshotDir: null });
  } finally {
    // Closed whatever became of the migration: an open database has files beside it.
    db.close();
  }
}

function exists(path: string): boolean {
  try {
    // lstat: a link that leads nowhere is still something in the way.
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function writePrivateFile(path: string, text: string): void {
  // "wx": never writes over a file that is already there.
  const file = openSync(path, "wx", PRIVATE_FILE_MODE);
  try {
    writeSync(file, text);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}

function syncDirectory(path: string): void {
  const directory = openSync(path, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** The directories on the way to a path that are not there yet, the deepest first. */
function missingAncestors(path: string): string[] {
  const missing: string[] = [];
  for (let current = path; dirname(current) !== current && !exists(current); current = dirname(current)) {
    missing.push(current);
  }
  return missing;
}

/** Removes what a killed creation of this target left beside it. Never fails: it is tidying, not the creation. */
function removeAbandonedStaging(parent: string, dir: string): void {
  for (const entry of readdirSync(parent)) {
    if (!entry.startsWith(stagingPrefix(dir))) continue;
    const path = join(parent, entry);
    try {
      // The time of the last change inside it. A clock that was set back makes it look young, which is the safe side.
      if (Date.now() - lstatSync(path).mtimeMs < STAGING_GRACE_MS) continue;
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Gone already, or not to be removed: neither is in the way of a staging directory of another name.
    }
  }
}

/** Which directory this is, whatever it is called at the moment. */
function identityOf(path: string): string {
  const { dev, ino } = lstatSync(path, { bigint: true });
  return `${dev}:${ino}`;
}

/**
 * The code with which SQLite refused, whichever error carries it: the one of the database file,
 * or SQLite's own, which the runner passes on for what is no statement of a migration, the commit
 * for one. undefined for any other error.
 */
function sqliteCodeOf(error: unknown): string | undefined {
  if (error instanceof WorkspaceDatabaseError) return error.sqliteCode;
  const { code } = (error ?? {}) as { code?: unknown };
  return typeof code === "string" && code.startsWith("SQLITE_") ? code : undefined;
}

/**
 * What follows a code of SQLite in the reason of a failed creation: for a disk without room, what
 * the code means and what to do.
 */
function afterSqliteCode(code: string | undefined): string {
  return code?.startsWith("SQLITE_FULL")
    ? ", bo na dysku zabrakło miejsca. Zwolnij miejsce albo wskaż inny katalog opcją --dir"
    : "";
}

function alreadyExists(dir: string): WorkspaceError {
  return new WorkspaceError(
    `Katalog "${dir}" już istnieje. Polecenie tworzy wyłącznie nowy katalog i niczego nie nadpisuje; wskaż inny opcją --dir.`,
    EXIT_FAILURE,
  );
}

/**
 * Checks what a caller could get wrong, without ever touching the disk. The configuration goes
 * through its own reader: a workspace that is created must be one that opens at the next start.
 */
function check(dir: string, config: WorkspaceConfig): void {
  if (!isAbsolute(dir)) throw new TypeError(`The workspace directory has to be an absolute path: ${dir}`);
  try {
    parseWorkspaceConfig(serializeWorkspaceConfig(config));
  } catch (error) {
    if (!(error instanceof WorkspaceConfigError)) throw error;
    throw new TypeError(`Not a workspace that can be created: ${error.problems.join("; ")}`);
  }
}

/**
 * Creates the directory, the configuration file, the database without rows at the schema of this
 * code, and the directory for files. Returns the configuration it wrote. Throws WorkspaceError,
 * with nothing left behind, when the target exists or the creation fails on the way.
 */
export function createWorkspace(
  options: CreateWorkspaceOptions,
  {
    now = () => new Date(),
    createDatabase = createCurrentDatabase,
    token = () => randomBytes(4).toString("hex"),
  }: Partial<CreateWorkspaceDeps> = {},
): WorkspaceConfig {
  const { dir, profile } = options;
  const config: WorkspaceConfig = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    name: cleanName(options.name),
    // The same instant goes into the database's pin row: the pair identifies this workspace.
    createdAt: now().toISOString(),
    profile,
  };
  check(dir, config);

  const parent = dirname(dir);
  const expected = [CONFIG_FILE, DATABASE_FILE, FILES_DIR].sort();
  // What this call has put on the disk so far, and so what a failure has to take away again.
  let madeParents: string[] = [];
  let staging: string | undefined;
  let moved: string | undefined;
  try {
    if (exists(dir)) throw alreadyExists(dir);

    madeParents = missingAncestors(parent);
    mkdirSync(parent, { recursive: true, mode: PRIVATE_DIR_MODE });
    removeAbandonedStaging(parent, dir);

    const stagingPath = join(parent, `${stagingPrefix(dir)}${token()}`);
    mkdirSync(stagingPath, { mode: PRIVATE_DIR_MODE });
    // Only now: a directory that could not be made is not there to be removed.
    staging = stagingPath;
    mkdirSync(join(staging, FILES_DIR), { mode: PRIVATE_DIR_MODE });

    const database = join(staging, DATABASE_FILE);
    createDatabase(database, { endpoint: profile.endpoint, createdAt: config.createdAt });
    // Whatever the database library made of the process umask.
    chmodSync(database, PRIVATE_FILE_MODE);
    writePrivateFile(join(staging, CONFIG_FILE), serializeWorkspaceConfig(config));

    // A database that was not closed leaves files beside it that a rename would carry along.
    const made = readdirSync(staging).sort();
    if (made.join("\n") !== expected.join("\n")) {
      throw new Error(`Unexpected content of the staging directory: ${made.join(", ")}`);
    }

    const identity = identityOf(staging);
    syncDirectory(staging);
    // The one step that makes the workspace exist. It cannot write over anything: rename()
    // replaces at most an empty directory and fails on a file, a link or a directory with content.
    try {
      renameSync(staging, dir);
    } catch (error) {
      // Someone put something there between the check above and the rename.
      if (exists(dir)) throw alreadyExists(dir);
      throw error;
    }
    staging = undefined;
    // What is at the target now has to be the very directory that was staged, and whole. Anything
    // else means that someone else was at work on the same place at the same moment, and then
    // this call must not report a workspace of its own making.
    if (identityOf(dir) !== identity) throw alreadyExists(dir);
    moved = dir;
    if (readdirSync(dir).sort().join("\n") !== expected.join("\n")) {
      throw new Error("inna operacja usunęła pliki tworzonego workspace'u. Spróbuj ponownie");
    }
    syncDirectory(parent);
    return config;
  } catch (error) {
    // Each step on its own and none of them allowed to fail: the error to report is the one
    // that ended the creation, not one from tidying up after it.
    for (const path of [staging, moved]) {
      try {
        if (path !== undefined) rmSync(path, { recursive: true, force: true });
      } catch {
        // Whatever could not be removed stays; there is nothing more to do about it here.
      }
    }
    for (const path of madeParents) {
      try {
        // Only a directory that is empty goes, so nothing that someone else has put there meanwhile.
        rmdirSync(path);
      } catch (failure) {
        // Not made at all, when the creation ended before it got that far: the ones above may have been.
        if ((failure as NodeJS.ErrnoException).code !== "ENOENT") break;
      }
    }
    if (error instanceof WorkspaceError) throw error;
    // What SQLite says is given by its code: its own sentence is English, and the error of the
    // database file names the staging directory, which is gone by now.
    const sqliteCode = sqliteCodeOf(error);
    const reason =
      error instanceof WorkspaceDatabaseError && error.problem === "wal-unavailable"
        ? "dysk nie obsługuje trybu WAL bazy SQLite. Utwórz workspace na dysku lokalnym"
        : error instanceof MigrationError
          ? `nie udało się założyć schematu bazy (migracja ${error.facts.tag}: ${error.facts.code ?? error.problem})${afterSqliteCode(error.facts.code)}`
          : error instanceof MigrationFilesError
            ? unusableMigrations(error)
            : sqliteCode !== undefined
              ? `nie udało się założyć bazy (${sqliteCode})${afterSqliteCode(sqliteCode)}`
              : error instanceof Error
                ? error.message
                : String(error);
    throw new WorkspaceError(`Nie udało się utworzyć workspace'u w katalogu "${dir}": ${reason}`, EXIT_FAILURE);
  }
}
