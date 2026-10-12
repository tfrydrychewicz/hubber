// Brings the database of a workspace to the schema that this code knows. The schema is the SQL
// files of ./migrations, in the order of ./migrations/manifest.json; a database records the ones
// it has had in its table schema_migrations.
//
// The runner works on the connection that openWorkspaceDatabase() returned, so every check of the
// pin has passed before its first statement, and it loads no ORM: whatever creates or opens a
// workspace loads this file.
//
// What it holds to:
//   - nothing to apply: reads only, compares the schema with the one the migrations leave, and
//     writes nothing;
//   - something to apply: a whole copy of the database is in <workspace>/backups before the first
//     statement of a migration runs, and all that is pending lands in one transaction or not at all.
//     The database is then either exactly what the copy holds or at the newest schema;
//   - while it applies, the database is this process's alone: a start is refused while any other
//     process has the workspace open, so no older server keeps running on a schema that changed
//     under it, and two starts cannot both migrate;
//   - a database that this code does not know, a newer one or one with another history, or one
//     whose schema is not what its migrations left, is refused before anything is written;
//   - a copy that is already there is removed only when it is no longer needed: the one of a start
//     that never committed, when this start has just copied the very same bytes again, and the
//     oldest ones beyond the number that is kept.
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { snapshotWorkspaceDatabase, type WorkspaceDatabase } from "../workspace/database.ts";
import { PRIVATE_DIR_MODE } from "../workspace/layout.ts";

export const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");
/** Kept by this module alone: like workspace_pin, it is in no migration and not in the Drizzle schema. */
export const MIGRATIONS_TABLE = "schema_migrations";

const MANIFEST_FILE = "manifest.json";
const BREAKPOINT = "--> statement-breakpoint";
// The breakpoint with nothing but blanks around it. To SQLite a line that begins this way is a
// comment to its end, so text behind the words would be a comment in the file and a statement here.
// Inside a comment between two marks such a line is a part of that comment: readMigrations() refuses
// the statement that such a comment is left open in, so no file is cut there.
const BREAKPOINT_LINE = /^[ \t]*--> statement-breakpoint[ \t]*\r?$/;
const TAG = /^\d{4}_[a-z0-9_]+$/;

/** How many copies from before a migration stay in the workspace. Each is a whole database. */
const KEPT_SNAPSHOTS = 5;
// The time carries milliseconds: a start that follows a restore within the same second must not meet its own name.
const SNAPSHOT_NAME = /^before-(\d{4}_[a-z0-9_]+)-\d{8}T\d{9}Z\.sqlite$/;
// A copy in the making, and the journal that VACUUM INTO keeps beside the file it writes.
const PARTIAL_NAME = /^before-\d{4}_[a-z0-9_]+-\d{8}T\d{9}Z\.sqlite\.partial(-journal)?$/;

/** One step of the schema: a file of ./migrations and its entry in the manifest. */
export interface Migration {
  /** Position in the manifest, from 1: the order of application. */
  index: number;
  /** The name of the file without ".sql", e.g. "0001_init". */
  tag: string;
  /** Of the file. A database records it, so a file that was edited after it was applied is noticed. */
  sha256: string;
  /** The fingerprint of the schema once this migration has run. */
  schema: string;
  /** One SQL statement each, with the comments that precede it. */
  statements: string[];
}

/** A fault of a folder of migrations that needs no mistake in a migration; at most one of them is named. */
export interface MigrationFilesFault {
  /**
   * The path of a migration file that holds other bytes than its manifest entry says. A checkout
   * that rewrites line ends brings that about, and so does a migration that is being written.
   */
  changedFile?: string;
  /**
   * The path of a file that the folder has to hold and does not: the manifest, or a file that the
   * manifest lists. Half of an update of the code leaves that.
   */
  missingFile?: string;
  /** The path of such a file, or of the folder, that is there and could not be read; `code` is what the system said. */
  unreadablePath?: string;
  code?: string;
  /**
   * The path of a .sql file in the folder that the manifest does not list: a copy that an editor
   * or a file manager left beside the original, for one, or a file that half of an update of the
   * code brought without its entry.
   */
  unlistedFile?: string;
  /**
   * The path of the manifest when what it holds is no list: an empty file or one that was cut
   * short, as half of a write or of an update of the code leaves it, the marks of a merge that was
   * not finished, a byte order mark.
   */
  damagedManifest?: string;
}

/**
 * Something is wrong with a folder of migrations: with its manifest, with the bytes of a file,
 * with what a file holds. The folder is part of the code, so this is a mistake in the checkout
 * and none in a workspace, and no database was touched when it is thrown.
 *
 * The messages are English, and they are meant to be: each states a rule of the folder for
 * whoever is writing a migration, and open.ts and create.ts quote it as it is, behind a Polish
 * sentence that says that the code is at fault. The faults that anybody can meet without writing
 * a migration carry a field of their own, and get Polish sentences to their end.
 */
export class MigrationFilesError extends Error implements MigrationFilesFault {
  override name = "MigrationFilesError";
  readonly folder: string;
  readonly changedFile?: string;
  readonly missingFile?: string;
  readonly unreadablePath?: string;
  readonly code?: string;
  readonly unlistedFile?: string;
  readonly damagedManifest?: string;

  constructor(folder: string, message: string, { cause, ...fault }: MigrationFilesFault & { cause?: unknown } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.folder = folder;
    Object.assign(this, fault);
  }
}

// What a migration must not contain. The runner owns the one transaction, the connection and the
// header of the file: a COMMIT in a migration would end the transaction with half of the pending
// work applied and none of it recorded.
const NOT_A_MIGRATION_STATEMENT =
  /^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|ATTACH|DETACH|REINDEX|ANALYZE|PRAGMA)\b/i;
// PRAGMA optimize asked as a table in a query: the one PRAGMA that changes something when it is
// asked this way. It runs ANALYZE, which leaves tables of statistics that change query plans.
const GATHERS_STATISTICS = /\bpragma_optimize\b/i;
// Without a boundary at the end: the triggers of the pin are called workspace_pin_<something>.
const TABLE_OF_ANOTHER_LAYER = /\b(workspace_pin|schema_migrations)/i;
// REPLACE removes the row that is in the way without firing its UPDATE and DELETE triggers, so the
// guards of the schema would not see it. "OR replace(" is the text function after an OR.
const REPLACES_ROWS = /\b(OR\s+REPLACE\b(?!\s*\()|REPLACE\s+INTO\b|ON\s+CONFLICT\s+REPLACE\b)/i;
// No foreign key deletes or changes a row on its own: a table rebuilt with foreign keys left on
// would otherwise empty the tables that point at it.
const FOREIGN_KEY_ACTION = /\bON\s+(DELETE|UPDATE)\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT)\b/i;
const REFUSED_IN_A_MIGRATION: ReadonlyArray<readonly [pattern: RegExp, what: string]> = [
  [
    NOT_A_MIGRATION_STATEMENT,
    "a statement that belongs to the runner (transactions, PRAGMA, VACUUM, ATTACH and their kin)",
  ],
  [GATHERS_STATISTICS, "a query of pragma_optimize, which gathers statistics as ANALYZE does,"],
  [TABLE_OF_ANOTHER_LAYER, "a table of another layer (workspace_pin, schema_migrations)"],
  [REPLACES_ROWS, "a statement that replaces rows (REPLACE)"],
  [FOREIGN_KEY_ACTION, "a foreign key with an action"],
];

// SQL text cut into the pieces that SQLite reads as one whatever stands inside them, with the
// white space between them: a string, a name in quotes of any of the four kinds, a comment to the
// end of its line with the white space after it, a comment between its two marks (one that is never
// closed runs to the end of the text). Found in one pass from the left, the way SQLite reads: two
// hyphens inside a string begin no comment, and a quote inside a comment begins no string. White
// space is the five characters that are always white space to SQLite. SQLite takes one more for a
// blank, a byte order mark where a word would begin: here that is a letter like any other character.
const SQL_PIECE =
  /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*[ \t\n\f\r]*|\/\*[\s\S]*?(?:\*\/|$)|[ \t\n\f\r]+/g;
const SQL_SPACE = /[ \t\n\f\r]+/g;

const isComment = (piece: string) => piece.startsWith("--") || piece.startsWith("/*");
// A comment between two marks whose second mark never comes. "/*/" is one: the marks share no asterisk.
const isLeftOpen = (piece: string) => piece.startsWith("/*") && !(piece.length >= 4 && piece.endsWith("*/"));

/**
 * SQL text without its comments, each cut where SQLite sees one and nowhere else. What the rules
 * of readMigrations() are asked of; a search of the migration files for what they must not hold
 * cuts them the same way.
 */
export function withoutComments(sql: string): string {
  return sql.replace(SQL_PIECE, (piece) => (isComment(piece) ? " " : piece)).trim();
}

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The sha256 of a file, read piece by piece: a copy is as large as the database. */
function sha256OfFile(path: string): string {
  const hash = createHash("sha256");
  const piece = Buffer.allocUnsafe(1 << 20);
  const file = openSync(path, "r");
  try {
    for (let read = readSync(file, piece); read > 0; read = readSync(file, piece)) hash.update(piece.subarray(0, read));
  } finally {
    closeSync(file);
  }
  return hash.digest("hex");
}

/**
 * The statements of a migration file: what stands between two lines that hold the breakpoint and
 * nothing else. Each is handed to SQLite by itself, so SQLite and the rules of readMigrations()
 * read the same text from the same beginning.
 */
function statementsOf(text: string): string[] {
  const statements: string[] = [];
  let lines: string[] = [];
  for (const line of text.split("\n")) {
    if (BREAKPOINT_LINE.test(line)) {
      statements.push(lines.join("\n"));
      lines = [];
    } else lines.push(line);
  }
  statements.push(lines.join("\n"));
  return statements.map((statement) => statement.trim()).filter((statement) => statement !== "");
}

/**
 * Reads a folder of migrations: manifest.json, which lists them in the order of application, and
 * one <tag>.sql per entry, its statements separated by a line "--> statement-breakpoint".
 *
 * Whatever is wrong with the folder is a MigrationFilesError.
 */
export function readMigrations(folder: string = MIGRATIONS_DIR): Migration[] {
  const wrong = (message: string, facts?: MigrationFilesFault & { cause?: unknown }) =>
    new MigrationFilesError(folder, message, facts);
  /** What the system refused to read: a file that is not there, or one that is there and was not given out. */
  const notRead = (path: string, error: unknown) =>
    // With what the system said, which names the path.
    wrong((error as Error).message, {
      ...(codeOf(error) === "ENOENT" ? { missingFile: path } : { unreadablePath: path, code: codeOf(error) }),
      cause: error,
    });
  const read = (name: string): Buffer => {
    try {
      return readFileSync(join(folder, name));
    } catch (error) {
      throw notRead(join(folder, name), error);
    }
  };

  let manifest: unknown;
  const listed = read(MANIFEST_FILE);
  // Named by its path: a manifest that holds no list is most often one that was cut short, by a
  // write or by an update of the code, and nobody has to be writing a migration to meet that.
  const damagedManifest = join(folder, MANIFEST_FILE);
  try {
    manifest = JSON.parse(listed.toString("utf8"));
  } catch (error) {
    throw wrong(`${MANIFEST_FILE} cannot be read as JSON: ${(error as Error).message}`, {
      damagedManifest,
      cause: error,
    });
  }
  if (!Array.isArray(manifest)) {
    throw wrong(`${MANIFEST_FILE} has to hold a list of migrations: ${folder}`, { damagedManifest });
  }
  // A code without a migration would take every database that has had one for a newer one, start
  // on a database that has none without giving it a schema, and create workspaces that hold the pin alone.
  if (manifest.length === 0) throw wrong(`${MANIFEST_FILE} lists no migration.`);

  const migrations = manifest.map((entry: unknown, position): Migration => {
    const { tag, sha256, schema } = (entry ?? {}) as Record<string, unknown>;
    if (typeof tag !== "string" || typeof sha256 !== "string" || typeof schema !== "string") {
      throw wrong(`Entry ${position + 1} of ${MANIFEST_FILE} needs the texts "tag", "sha256" and "schema".`);
    }
    // Numbered without gaps: a number that is missing or used twice is two branches that each added a migration.
    if (!TAG.test(tag) || Number(tag.slice(0, 4)) !== position + 1) {
      throw wrong(
        `Migration ${position + 1} of ${MANIFEST_FILE} is called "${tag}": a tag is its position in four digits, an underscore and lower-case words, like ${String(position + 1).padStart(4, "0")}_words.`,
      );
    }
    // Of the bytes, and not of the text they are read as: two files that differ in a byte that is
    // no UTF-8 are one text.
    const bytes = read(`${tag}.sql`);
    const found = sha256Of(bytes);
    if (found !== sha256) {
      throw wrong(
        `Migration ${tag} differs from its entry in ${MANIFEST_FILE} (the sha256 of the file is ${found}). A migration that is on main is never edited; for a new one, paste the entry that the migrations test prints.`,
        { changedFile: join(folder, `${tag}.sql`) },
      );
    }
    const text = bytes.toString("utf8");
    // SQLite reads a statement as far as a NUL character and no further, and there the database
    // library stops looking for a second statement: what stands behind one would be in the file,
    // and in its sha256, and would never run.
    if (text.includes("\0")) {
      throw wrong(`Migration ${tag} holds a NUL character: SQLite reads a statement only as far as that.`);
    }
    const statements = statementsOf(text);
    if (statements.some((statement) => statement.includes(BREAKPOINT))) {
      throw wrong(
        `Migration ${tag}: "${BREAKPOINT}" is a line of its own. Where it stands among other text it would cut a statement in two, or run what a comment holds.`,
      );
    }
    if (statements.length === 0) throw wrong(`Migration ${tag} holds no statement.`);
    statements.forEach((statement, at) => {
      const sql = withoutComments(statement);
      if (sql === "") throw wrong(`Migration ${tag}, statement ${at + 1}: nothing but a comment.`);
      // In the file such a comment goes on over the breakpoint line to its second mark, wherever
      // that stands: all of it is commented out there, and the statements in it would run here.
      if ((statement.match(SQL_PIECE) ?? []).some(isLeftOpen)) {
        throw wrong(
          `Migration ${tag}, statement ${at + 1}: ends inside a comment that is never closed. A comment between two marks does not go on over a breakpoint: what the file comments out there would run.`,
        );
      }
      // SQLite skips a statement that is empty and runs the one behind it, which the rules below,
      // going by how a statement begins, would not see.
      if (sql.startsWith(";")) {
        throw wrong(
          `Migration ${tag}, statement ${at + 1}: begins with ";", an empty statement in front of the one that would run.`,
        );
      }
      for (const [pattern, what] of REFUSED_IN_A_MIGRATION) {
        if (pattern.test(sql)) throw wrong(`Migration ${tag}, statement ${at + 1}: ${what} is not allowed.`);
      }
    });
    return { index: position + 1, tag, sha256, schema, statements };
  });

  const files = new Set(migrations.map(({ tag }) => `${tag}.sql`));
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch (error) {
    throw notRead(folder, error);
  }
  for (const name of names) {
    // A file that no entry names would never run, on any database.
    if (name.endsWith(".sql") && !files.has(name)) {
      throw wrong(`The migration file ${name} is not listed in ${MANIFEST_FILE}.`, {
        unlistedFile: join(folder, name),
      });
    }
  }
  return migrations;
}

/**
 * The text of one object of the schema as the fingerprint counts it. What does not count is how
 * the white space between two pieces is made up, also inside a comment, and the double quotes
 * around a name: ALTER TABLE ... RENAME puts them around the names it rewrites. What does count
 * is everything inside a string or a quoted name, as it is written, and where a comment line ends:
 * the line under it is a column or a rule, and joined to the comment it would be neither.
 */
function countedText(sql: string): string {
  return sql
    .replace(SQL_PIECE, (piece) => {
      if (piece.startsWith("--")) return `${piece.replace(SQL_SPACE, " ").trimEnd()}\n`;
      if (piece.startsWith("/*")) return piece.replace(SQL_SPACE, " ");
      if (piece.startsWith('"')) return piece.slice(1, -1);
      // What is left is a string or a name in other quotes, kept as it is, or a run of white space.
      return /^['`[]/.test(piece) ? piece : " ";
    })
    .trim();
}

/**
 * What the application's schema looks like, as one hash over sqlite_schema: every table, index
 * and trigger with its text. Compared with the manifest after each migration and at every start,
 * because a table that is rebuilt loses its triggers and indexes without a sound, and neither
 * integrity_check nor foreign_key_check sees that.
 *
 * Left out: the tables of other layers (the pin with its triggers, the record of migrations) and
 * SQLite's own tables, which ANALYZE creates. See countedText() for what counts of a text.
 *
 * What it does not see, so a start accepts a database in which one of these was changed past the
 * application:
 *   - the rows of any table, those of the vocabularies and of the lists of states included: a code
 *     that was deleted, or one whose is_closed, severity or weight was changed;
 *   - what was put on the two tables of other layers, a trigger or an index on workspace_pin or on
 *     the record of migrations, because everything that belongs to them is left out with them;
 *   - the tables of statistics that ANALYZE leaves, which change how queries are planned;
 *   - the order in which the objects were made. A table that was rebuilt gets its triggers back in
 *     the order of the rebuild, and where two triggers refuse the same statement, which of them
 *     answers can differ from a database that was migrated in one go;
 *   - the double quotes around a name, also where they are what makes it one name: a name that
 *     holds a blank or the mark of a comment counts like the words it is made of. A column "a b"
 *     of type INTEGER and a column a of type b INTEGER have one fingerprint.
 *
 * And one text that it tells apart although SQLite reads it like another: a byte order mark where
 * a word would begin is a blank to SQLite and a letter here. One schema then has two fingerprints,
 * which refuses a database and lets none through.
 */
export function schemaFingerprint(db: WorkspaceDatabase): string {
  const objects = db
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
          AND tbl_name NOT IN ('workspace_pin', '${MIGRATIONS_TABLE}')
        ORDER BY type, name`,
    )
    .all() as { type: string; name: string; tableName: string; sql: string }[];
  const hash = createHash("sha256");
  for (const { type, name, tableName, sql } of objects) {
    hash.update(`${type}\n${name}\n${tableName}\n${countedText(sql)}\n\0`);
  }
  return hash.digest("hex");
}

/** The fingerprint of a database that holds nothing of the application yet: one that has had no migration. */
const NO_SCHEMA = createHash("sha256").digest("hex");

export type MigrationProblem =
  /** The database has had migrations that this code lacks. Nothing was changed by this start. */
  | "newer"
  /** A migration that the database recorded is not the one this code has at that position. Nothing was changed. */
  | "diverged"
  /**
   * The schema is not the one the migrations leave: found before anything was begun (nothing was
   * changed), or after a migration of this start (rolled back).
   */
  | "schema-drift"
  /** Another process has the workspace open, or wrote to it while this start was getting ready. Nothing was changed. */
  | "in-use"
  /** The disk has no room for the copy. Nothing was changed. */
  | "no-space"
  /** The copy could not be made, so no migration was begun. Nothing was changed. */
  | "snapshot-failed"
  /**
   * A statement of a migration failed. Rolled back, with one exception: a statement that ended
   * the transaction itself (code TRANSACTION_ENDED) leaves what ran before it in the database.
   */
  | "statement-failed"
  /** The migrations would leave rows that point at rows which do not exist. Rolled back. */
  | "foreign-keys";

/** What the caller needs for the owner's words; which of them are there depends on the problem. */
export interface MigrationFacts {
  /**
   * The migration the problem is about: the one whose statement failed, the recorded one that
   * differs (diverged). For schema-drift the one after which the schema differs: the migration of
   * this start that left it so, or the last one the database had had when the start found it so
   * (none for a database that has had no migration). For foreign-keys the last one applied: the
   * check runs once, after all of them.
   */
  tag?: string;
  /** statement-failed: which statement of the file, counted from 1. */
  statement?: number;
  /** statement-failed, snapshot-failed, in-use: what SQLite or the system said, e.g. SQLITE_ERROR or EACCES. */
  code?: string;
  /** schema-drift: whether it was found after a migration of this start, and so rolled back, or before anything was begun. */
  whileMigrating?: boolean;
  /** schema-drift before anything was begun: the first migration that was waiting, when one was. */
  pendingTag?: string;
  /** foreign-keys: a table with a row that points nowhere, and the table it points at. */
  table?: string;
  parent?: string;
  /** newer: the last migration the database recorded. */
  databaseTag?: string;
  /** newer: the last migration of this code. */
  codeTag?: string;
  /**
   * The file name of a copy among the copies. newer: the one made before the first migration this
   * code lacks, if the record names one. statement-failed with the code TRANSACTION_ENDED: the one
   * this start made, which was kept because it is the only way back.
   */
  snapshot?: string;
  /** no-space: what the copy needs and what the disk has, in bytes. */
  neededBytes?: number;
  freeBytes?: number;
}

/**
 * Says what kept a database from being migrated, and carries the facts. The message is for a log
 * line of last resort: open.ts and create.ts put every problem into the owner's words, because
 * those words need what only they know (the name of the workspace, the path of the file).
 */
export class MigrationError extends Error {
  override name = "MigrationError";
  readonly problem: MigrationProblem;
  readonly facts: MigrationFacts;

  constructor(problem: MigrationProblem, facts: MigrationFacts = {}, options?: ErrorOptions) {
    super(`Migration: ${problem} ${JSON.stringify(facts)}`, options);
    this.problem = problem;
    this.facts = facts;
  }
}

/** The code of an error of SQLite or of the system; for anything else the kind of error it is. */
function codeOf(error: unknown): string {
  const { code, name } = error as { code?: unknown; name?: unknown };
  return typeof code === "string" ? code : typeof name === "string" ? name : "Error";
}

/** Compares what the database recorded with what the code has, and returns what is still to apply. Reads only. */
function plan(db: WorkspaceDatabase, migrations: Migration[]): Migration[] {
  const hasRecord =
    db.prepare("SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = ?").pluck().get(MIGRATIONS_TABLE) ===
    1;
  const applied = hasRecord
    ? (db.prepare(`SELECT idx, tag, sha256, snapshot FROM ${MIGRATIONS_TABLE} ORDER BY idx`).all() as {
        idx: number;
        tag: string;
        sha256: string;
        snapshot: string | null;
      }[])
    : [];
  applied.forEach((row, position) => {
    const known = migrations[position];
    if (known === undefined) {
      const codeTag = migrations.at(-1)?.tag;
      throw new MigrationError("newer", {
        databaseTag: applied.at(-1)?.tag ?? row.tag,
        ...(codeTag !== undefined && { codeTag }),
        // The first migration that this code lacks: the copy made before it is the last state this code can open.
        ...(row.snapshot !== null && { snapshot: row.snapshot }),
      });
    }
    if (row.idx !== known.index || row.tag !== known.tag || row.sha256 !== known.sha256) {
      throw new MigrationError("diverged", { tag: row.tag });
    }
  });
  return migrations.slice(applied.length);
}

/** The tags of the migrations that the database has not had yet, in order. Reads only; refuses what plan() refuses. */
export function pendingMigrations(db: WorkspaceDatabase, migrations: Migration[] = readMigrations()): string[] {
  return plan(db, migrations).map(({ tag }) => tag);
}

/**
 * Takes the database for this process alone, or says that somebody else has it. In WAL mode every
 * connection keeps a shared lock on the file for as long as it is open, also while it is idle, so
 * the exclusive lock is refused while any other process has the workspace open. SQLite waits for
 * the lock as long as the connection's busy timeout says before it gives up.
 *
 * Two starts at the same moment can each hold the shared lock that the other one waits for. Both
 * then give up after the same wait and neither migrates: nothing is lost, and the start is repeated.
 */
function takeExclusive(db: WorkspaceDatabase): void {
  db.pragma("locking_mode = EXCLUSIVE");
  try {
    // The mode alone takes nothing: the lock comes with the first write transaction.
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    releaseExclusive(db);
    if (codeOf(error).startsWith("SQLITE_BUSY")) {
      throw new MigrationError("in-use", { code: codeOf(error) }, { cause: error });
    }
    throw error;
  }
  db.exec("COMMIT");
}

function releaseExclusive(db: WorkspaceDatabase): void {
  db.pragma("locking_mode = NORMAL");
  try {
    // The lock goes with the next access to the file, not with the pragma.
    db.prepare("SELECT count(*) FROM sqlite_schema").get();
  } catch {
    // Refused by whoever holds the file: then there was no lock of ours to give back.
  }
}

/** Switches the enforcement of foreign keys, and makes sure that it took: inside a transaction SQLite ignores the pragma. */
function enforceForeignKeys(db: WorkspaceDatabase, on: boolean): void {
  db.pragma(`foreign_keys = ${on ? "ON" : "OFF"}`);
  if (db.pragma("foreign_keys", { simple: true }) !== (on ? 1 : 0)) {
    throw new Error(`Foreign keys could not be switched ${on ? "back on" : "off"} on the connection.`);
  }
}

/** A whole copy of the database as it is now, under a name that says which migration it is the state before. */
function takeSnapshot(db: WorkspaceDatabase, dir: string, firstPendingTag: string, at: Date): string {
  let neededBytes: number;
  let freeBytes: number;
  try {
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    // Also for a directory that was there already, whoever made it: the copies hold all that the
    // database holds. A link in its place is followed, like one in the place of the workspace itself.
    // Tried and no more: where such a link leads, the directory may be one that the user writes to
    // and does not own, and the system lets nobody but the owner change a mode. The copy is made
    // there all the same, and is itself created for the owner alone whatever the directory allows.
    try {
      chmodSync(dir, PRIVATE_DIR_MODE);
    } catch {
      // The directory stays as it is.
    }
    neededBytes =
      (db.pragma("page_size", { simple: true }) as number) * (db.pragma("page_count", { simple: true }) as number);
    const { bavail, bsize } = statfsSync(dir);
    freeBytes = bavail * bsize;
  } catch (error) {
    throw new MigrationError("snapshot-failed", { code: codeOf(error) }, { cause: error });
  }
  // Before a byte is written: a disk that fills up half-way would cost the time of the copy first.
  // The copy alone is counted. What the migrations themselves write comes on top of it, and is
  // not known beforehand: a table that is rebuilt is written a second time, into the log.
  if (freeBytes < neededBytes) throw new MigrationError("no-space", { neededBytes, freeBytes });

  const target = join(dir, `before-${firstPendingTag}-${at.toISOString().replace(/[-:.]/g, "")}.sqlite`);
  try {
    snapshotWorkspaceDatabase(db, target);
  } catch (error) {
    throw new MigrationError("snapshot-failed", { code: codeOf(error) }, { cause: error });
  }
  return target;
}

/**
 * Removes what starts that never committed left among the copies: every copy that was cut short,
 * every empty file under the name of a copy, and whole copies "before" the migration that is still
 * the first one pending which hold, byte for byte, what this start has just copied again. Without
 * this a start that keeps being killed would fill the disk, and push the useful copies out of the
 * ones kept.
 *
 * An empty file under the name of a copy is a name that was taken for a copy which never got there:
 * what a start leaves that is killed at that moment on a file system without hard links. It holds
 * no state, whatever migration it names, and left alone it would be kept in the place of a copy.
 *
 * A copy under such a name that holds anything else stays, whatever its age. It is a state that
 * exists nowhere else: the database before a migration that ended its own transaction, or the
 * newer rows of a database whose file was since put back from an older backup.
 *
 * Only under the write lock of the database: then no other start is between its copy and its
 * commit, and what is still in the making under these names is nobody's. Tidying, so it never ends
 * a migration.
 */
function removeLeftovers(dir: string, firstPendingTag: string, own: string): void {
  try {
    const ownPath = join(dir, own);
    let ownHash: string | undefined;
    const holdsWhatThisStartCopied = (path: string): boolean => {
      // The size first: it tells most copies of another state apart without reading either file.
      if (statSync(path).size !== statSync(ownPath).size) return false;
      ownHash ??= sha256OfFile(ownPath);
      return sha256OfFile(path) === ownHash;
    };
    // The file itself: a link under such a name is somebody's own doing, wherever it leads.
    const isEmptyFile = (path: string): boolean => {
      const found = lstatSync(path);
      return found.isFile() && found.size === 0;
    };
    for (const name of readdirSync(dir)) {
      if (name === own) continue;
      const path = join(dir, name);
      try {
        const copyBefore = SNAPSHOT_NAME.exec(name)?.[1];
        const leftover =
          PARTIAL_NAME.test(name) ||
          (copyBefore !== undefined && isEmptyFile(path)) ||
          (copyBefore === firstPendingTag && holdsWhatThisStartCopied(path));
        if (leftover) rmSync(path, { force: true });
      } catch {
        // Gone already, not to be read or not to be removed: it stays, and none of that stands in
        // the way of the migration.
      }
    }
  } catch {
    // The same for a directory that cannot be listed.
  }
}

/**
 * Keeps the copy of this start and the newest of the other whole copies, `keep` in all and never
 * fewer than that one. A name sorts by its migration first and by its time second; the copy of
 * this start stays whatever its name sorts like, because the start is about to tell the owner
 * where it is, and the record of the database names it. After an older file of the database was
 * put back, copies of later migrations are newer by name.
 */
function pruneSnapshots(dir: string, keep: number, own: string): void {
  let others: string[];
  try {
    others = readdirSync(dir)
      .filter((name) => SNAPSHOT_NAME.test(name) && name !== own)
      .sort();
  } catch {
    // The migration has committed: copies that cannot be listed are no reason to fail the start.
    return;
  }
  for (const name of others.slice(0, Math.max(0, others.length - Math.max(0, keep - 1)))) {
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      // Nor is one that cannot be removed, a directory under such a name for one: the rest still go.
    }
  }
}

export interface MigrateOptions {
  /** The migrations of this code. By default the ones of MIGRATIONS_DIR; a test hands in its own. */
  migrations?: Migration[];
  /**
   * Where the copy from before the migration goes: <workspace>/backups. null only for a database
   * that is being created, where there is nothing to protect yet.
   */
  snapshotDir: string | null;
  keepSnapshots?: number;
  now?: () => Date;
  /** Called when there is something to apply, before the database is taken and copied: the moment to tell the owner. */
  onPending?: (info: { pending: string[] }) => void;
}

export interface MigrateResult {
  /** The tags of the migrations this call applied, in order. */
  applied: string[];
  /** The path of the copy made before them; null when nothing was applied or no copy was asked for. */
  snapshot: string | null;
  /**
   * There only when the log could not be folded back into the file after the commit: what SQLite
   * said, e.g. SQLITE_FULL. The migrations are in the database all the same. Their pages are in the
   * log beside the file until a checkpoint gets through, so the file alone is not the database.
   */
  checkpointFailed?: string;
}

/**
 * Applies the migrations that the database has not had. Throws a MigrationError for everything
 * that the owner has to hear about, with the database as it was (for "newer": as the newer version
 * left it; for a migration that ended its own transaction: see "statement-failed"), a
 * MigrationFilesError for a folder of migrations that cannot be used, before anything is touched,
 * and an ordinary Error for a mistake in the caller.
 */
export function migrateDatabase(db: WorkspaceDatabase, options: MigrateOptions): MigrateResult {
  const { snapshotDir, keepSnapshots = KEPT_SNAPSHOTS, now = () => new Date(), onPending } = options;
  // The one transaction is the runner's own, and so is the setting of foreign keys around it.
  if (db.inTransaction) throw new Error("migrateDatabase() needs a connection that is not inside a transaction.");
  const migrations = options.migrations ?? readMigrations();

  // Without a lock. The version first: whatever another connection commits from here on is noticed below.
  const dataVersion = db.pragma("data_version", { simple: true });
  const pending = plan(db, migrations);

  // The schema has to be the one that the migrations it has had leave, whether or not more are to
  // come. Looked at before anything is begun: a schema that was changed past the application is
  // then named as that, and is not taken for the doing of the migration that would run on it.
  //
  // It follows that no migration mends a schema that differs: one written to repair it is refused
  // here, before its first statement, on every database that would need it. That is right for
  // damage, where the way back is a backup. Should the stored text of an object ever differ on
  // databases that are sound, because a later SQLite rewrites it another way or a migration that
  // has shipped was wrong, a backup holds the same text. The way out is then a change of what
  // countedText() counts, or a repair of the file by hand, and never a migration.
  const reached = migrations[migrations.length - pending.length - 1];
  const [first] = pending;
  if (schemaFingerprint(db) !== (reached?.schema ?? NO_SCHEMA)) {
    throw new MigrationError("schema-drift", {
      ...(reached !== undefined && { tag: reached.tag }),
      whileMigrating: false,
      ...(first !== undefined && { pendingTag: first.tag }),
    });
  }
  // The usual start: nothing to apply, and nothing is written.
  if (first === undefined) return { applied: [], snapshot: null };

  const tags = pending.map(({ tag }) => tag);
  onPending?.({ pending: tags });
  takeExclusive(db);
  try {
    const startedAt = now();
    const snapshot = snapshotDir === null ? null : takeSnapshot(db, snapshotDir, first.tag, startedAt);
    // Set when a statement of a migration ended the transaction: what ran before it may then be in the database.
    let cutShort = false;
    try {
      // Off for the whole transaction: with foreign keys on, DROP TABLE deletes the rows of the
      // table one by one, and a table that is rebuilt would take the rows that point at it along.
      enforceForeignKeys(db, false);
      db.exec("BEGIN IMMEDIATE");
      // Read again, now that nobody else can write: between the first look and the lock another
      // process may have migrated the database or written to it.
      const stillPending = plan(db, migrations).map(({ tag }) => tag);
      if (stillPending.join() !== tags.join() || db.pragma("data_version", { simple: true }) !== dataVersion) {
        throw new MigrationError("in-use");
      }
      if (snapshotDir !== null && snapshot !== null) removeLeftovers(snapshotDir, first.tag, basename(snapshot));
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (idx INTEGER PRIMARY KEY CHECK (idx >= 1), tag TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL, snapshot TEXT) STRICT`,
      );
      const record = db.prepare(
        `INSERT INTO ${MIGRATIONS_TABLE} (idx, tag, sha256, applied_at, snapshot) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const migration of pending) {
        migration.statements.forEach((statement, at) => {
          try {
            // Prepared one by one: the database library refuses a text that holds two statements.
            db.prepare(statement).run();
          } catch (error) {
            throw new MigrationError(
              "statement-failed",
              { tag: migration.tag, statement: at + 1, code: codeOf(error) },
              { cause: error },
            );
          }
          // The files are kept from it by readMigrations(); a list that was handed in is not.
          if (!db.inTransaction) {
            cutShort = true;
            throw new MigrationError("statement-failed", {
              tag: migration.tag,
              statement: at + 1,
              code: "TRANSACTION_ENDED",
              ...(snapshot !== null && { snapshot: basename(snapshot) }),
            });
          }
        });
        if (schemaFingerprint(db) !== migration.schema) {
          throw new MigrationError("schema-drift", { tag: migration.tag, whileMigrating: true });
        }
        record.run(
          migration.index,
          migration.tag,
          migration.sha256,
          startedAt.toISOString(),
          snapshot === null ? null : basename(snapshot),
        );
      }
      // Before the commit: after it the rows that point nowhere would be in the database for good.
      const [violation] = db.pragma("foreign_key_check") as { table: string; parent: string }[];
      if (violation !== undefined) {
        throw new MigrationError("foreign-keys", {
          tag: tags.at(-1) ?? first.tag,
          table: violation.table,
          parent: violation.parent,
        });
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      // Nothing was committed, so the database is what it was and the copy of it is not needed.
      if (snapshot !== null && !cutShort) rmSync(snapshot, { force: true });
      throw error;
    } finally {
      // After the rollback: the pragma does nothing inside a transaction.
      enforceForeignKeys(db, true);
    }
    // The log beside the file holds every page the migrations touched; folded back now, the file
    // is whole again whatever becomes of the process next. Tried and no more: the migrations are
    // committed, and a checkpoint that fails, on a disk that has no room left for it, is made up
    // for by the next one. The start goes on and says where its copy is, and the caller is told
    // of the checkpoint, because the owner has to hear that the log now holds the update.
    let checkpointFailed: string | undefined;
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (error) {
      // The pages stay in the log, where every connection reads them.
      checkpointFailed = codeOf(error);
    }
    if (snapshotDir !== null && snapshot !== null) pruneSnapshots(snapshotDir, keepSnapshots, basename(snapshot));
    return { applied: tags, snapshot, ...(checkpointFailed !== undefined && { checkpointFailed }) };
  } finally {
    releaseExclusive(db);
  }
}
