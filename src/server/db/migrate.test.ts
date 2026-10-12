import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type SpawnedNode, spawnNode } from "../testing.ts";
import {
  APPLICATION_ID,
  createWorkspaceDatabase,
  openWorkspaceDatabase,
  readWorkspacePin,
  snapshotWorkspaceDatabase,
  WORKSPACE_FORMAT,
  type WorkspaceDatabase,
} from "../workspace/database.ts";
import {
  MIGRATIONS_DIR,
  MIGRATIONS_TABLE,
  type Migration,
  MigrationError,
  MigrationFilesError,
  migrateDatabase,
  pendingMigrations,
  readMigrations,
  schemaFingerprint,
} from "./migrate.ts";
import { syntheticWorkspaceDatabase } from "./synthetic/testing.ts";

// A full disk is not at hand, so the system is made to answer like one: for the directory named
// here it reports the room set here, and nothing else. Asked about any other place it gives the real
// answer, so a runner that asked about the wrong disk would find room. Every question is kept.
// Nor is a directory at hand that the user may write to and does not own: for the one named here
// the system refuses a change of its mode, as it does for a directory of somebody else.
const disk = vi.hoisted(() => ({
  full: undefined as { dir: string; freeBytes: number } | undefined,
  asked: [] as string[],
  notTheUsersOwn: undefined as string | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    statfsSync: (path: string) => {
      disk.asked.push(path);
      const found = real.statfsSync(path);
      return path === disk.full?.dir ? { ...found, bavail: disk.full.freeBytes, bsize: 1 } : found;
    },
    chmodSync: (path: string, mode: number) => {
      if (path === disk.notTheUsersOwn) {
        throw Object.assign(new Error(`EPERM: operation not permitted, chmod '${path}'`), { code: "EPERM" });
      }
      real.chmodSync(path, mode);
    },
  };
});

const ENDPOINT = "https://router.corp.example/llm";
const PIN = { endpoint: ENDPOINT, createdAt: "2026-10-10T20:00:00.000Z" };
const BREAKPOINT_LINE = "\n--> statement-breakpoint\n";
/** What createWorkspaceDatabase() puts into a file: all that the database of a workspace held before the application had a schema. */
const PIN_OBJECTS = [
  { type: "table", name: "workspace_pin" },
  { type: "trigger", name: "workspace_pin_insert_once" },
  { type: "trigger", name: "workspace_pin_no_delete" },
  { type: "trigger", name: "workspace_pin_no_update" },
];

/** The migrations of this code. No test below holds how many there are or what they contain. */
const REAL = readMigrations();
const HEAD = REAL.at(-1) as Migration;
const REAL_TAGS = REAL.map(({ tag }) => tag);

const tempDirs: string[] = [];
const connections: Database.Database[] = [];
const children: SpawnedNode[] = [];
const startUmask = process.umask();

afterEach(async () => {
  disk.full = undefined;
  disk.asked.length = 0;
  disk.notTheUsersOwn = undefined;
  process.umask(startUmask);
  for (const { child } of children.splice(0)) child.kill("SIGKILL");
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hubber-migrate-"));
  tempDirs.push(dir);
  return dir;
}

interface Place {
  /** Stands for the directory of a workspace. */
  dir: string;
  file: string;
  backups: string;
}

/** A database file as it was created before the application had a schema, in a directory of its own: the pin and nothing else. */
function pinOnly(): Place {
  const dir = tempDir();
  const file = join(dir, "hubber.sqlite");
  createWorkspaceDatabase(file, PIN);
  return { dir, file, backups: join(dir, "backups") };
}

/** The connection the runner is given in the application: every check of the pin has passed. */
function open(file: string): WorkspaceDatabase {
  const db = openWorkspaceDatabase(file, ENDPOINT);
  connections.push(db);
  return db;
}

/** A database at the schema of this code, the way a new workspace gets it: migrated without a copy. */
function current(migrations: Migration[] = REAL): Place & { db: WorkspaceDatabase } {
  const place = pinOnly();
  const db = open(place.file);
  migrateDatabase(db, { migrations, snapshotDir: null });
  return { ...place, db };
}

/**
 * A database at the schema of this code that has been in use: the small synthetic world, with rows in
 * every table and state, written through the guards of the schema.
 */
function used(): Place & { db: WorkspaceDatabase } {
  const dir = tempDir();
  const file = join(dir, "hubber.sqlite");
  writeFileSync(file, syntheticWorkspaceDatabase(PIN), { mode: 0o600 });
  return { dir, file, backups: join(dir, "backups"), db: open(file) };
}

/** A connection that goes around the checks, for looking at a file from outside and for damaging one. */
function raw(path: string, options: Database.Options = {}): Database.Database {
  const db = new Database(path, options);
  connections.push(db);
  return db;
}

function failure(run: () => unknown): MigrationError {
  try {
    run();
  } catch (error) {
    if (error instanceof MigrationError) return error;
    throw error;
  }
  throw new Error("No MigrationError was thrown.");
}

const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);
const textOf = (statements: string[]) => `${statements.join(BREAKPOINT_LINE)}\n`;
const tagAt = (index: number, words: string) => `${String(index).padStart(4, "0")}_${words}`;

const objectsOf = (db: Database.Database) =>
  db.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
const hasTable = (db: Database.Database, name: string) =>
  db.prepare("SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = ?").pluck().get(name) === 1;
/** What the database recorded, or nothing for a database that was never migrated. */
const recorded = (db: Database.Database) =>
  hasTable(db, MIGRATIONS_TABLE)
    ? (db
        .prepare(`SELECT idx, tag, sha256, applied_at AS appliedAt, snapshot FROM ${MIGRATIONS_TABLE} ORDER BY idx`)
        .all() as {
        idx: number;
        tag: string;
        sha256: string;
        appliedAt: string;
        snapshot: string | null;
      }[])
    : [];
const recordedTags = (db: Database.Database) => recorded(db).map(({ tag }) => tag);
/** The number of rows of every table but the runner's own, by name. */
function rowCounts(db: Database.Database): Record<string, number> {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> ? ORDER BY name",
    )
    .pluck()
    .all(MIGRATIONS_TABLE) as string[];
  return Object.fromEntries(
    tables.map((table) => [table, db.prepare(`SELECT count(*) FROM "${table}"`).pluck().get() as number]),
  );
}
/** The columns of every table but the runner's own, by table, in the order of the table. */
function columnsOf(db: Database.Database): Record<string, string[]> {
  return Object.fromEntries(
    Object.keys(rowCounts(db)).map((table) => [
      table,
      db.prepare("SELECT name FROM pragma_table_xinfo(?) ORDER BY cid").pluck().all(table) as string[],
    ]),
  );
}
/**
 * What every table holds in the given columns, as a digest of its rows by table: equal numbers of
 * rows say nothing about what is in them. The order in which a table stores its rows does not count.
 */
function contentOf(db: Database.Database, columns: Record<string, string[]> = columnsOf(db)): Record<string, string> {
  return Object.fromEntries(
    Object.entries(columns).map(([table, names]) => {
      const rows = db
        .prepare(`SELECT ${names.map((name) => `"${name}"`).join(", ")} FROM "${table}"`)
        .raw()
        .all()
        .map((row) => JSON.stringify(row))
        .sort();
      return [table, `${rows.length} rows, ${sha256(rows.join("\n"))}`];
    }),
  );
}
const snapshotsIn = (backups: string) => (existsSync(backups) ? readdirSync(backups).sort() : []);

interface Step {
  /** The words of the tag; the number is the step's place after the migrations before it. */
  words: string;
  /** The statements, or how to write them once the database is at the schema before this step. */
  statements: string[] | ((db: Database.Database) => string[]);
}

/**
 * The migrations of a test: the real ones and, numbered after them, the steps it names. What the
 * manifest would say of each step is found the way it is found for a real migration: on a database
 * that is migrated from empty.
 */
function withSteps(...steps: Step[]): Migration[] {
  const db = new Database(":memory:");
  try {
    migrateDatabase(db, { migrations: REAL, snapshotDir: null });
    db.pragma("foreign_keys = OFF");
    const all = [...REAL];
    for (const { words, statements: given } of steps) {
      const statements = typeof given === "function" ? given(db) : given;
      db.transaction(() => {
        for (const statement of statements) db.prepare(statement).run();
      })();
      const index = all.length + 1;
      all.push({
        index,
        tag: tagAt(index, words),
        sha256: sha256(textOf(statements)),
        schema: schemaFingerprint(db),
        statements,
      });
    }
    return all;
  } finally {
    db.close();
  }
}

/** One more migration after the given ones that is not meant to get through: nothing in the manifest fits it. */
function followedBy(migrations: Migration[], words: string, statements: string[]): Migration[] {
  const index = migrations.length + 1;
  return [
    ...migrations,
    { index, tag: tagAt(index, words), sha256: sha256(textOf(statements)), schema: "never reached", statements },
  ];
}

/** Each of them adds a table of its own, so a database shows which of them it has had. */
const tableStep = (name: string): Step => ({ words: name, statements: [`CREATE TABLE ${name} (x INTEGER) STRICT`] });

/**
 * Writes migrations into a folder of their own, each a file, with their manifest: the way
 * ./migrations holds the real ones, whose files are taken as they are.
 */
function folderOf(migrations: Migration[]): string {
  const folder = tempDir();
  for (const migration of migrations) {
    const file = join(folder, `${migration.tag}.sql`);
    if (REAL.includes(migration)) copyFileSync(join(MIGRATIONS_DIR, `${migration.tag}.sql`), file);
    else writeFileSync(file, textOf(migration.statements));
  }
  const manifest = migrations.map(({ tag, sha256: hash, schema }) => ({ tag, sha256: hash, schema }));
  writeFileSync(join(folder, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return folder;
}

/** A folder with one migration whose file holds the given text. */
function folderWithText(text: string, tag = "0001_only"): string {
  const folder = tempDir();
  writeFileSync(join(folder, `${tag}.sql`), text);
  writeFileSync(join(folder, "manifest.json"), JSON.stringify([{ tag, sha256: sha256(text), schema: "any" }]));
  return folder;
}

describe("readMigrations", () => {
  it("reads the migrations of this code in the order of the manifest, numbered from one", () => {
    const manifest = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "manifest.json"), "utf8")) as {
      tag: string;
      sha256: string;
      schema: string;
    }[];

    expect(REAL.length).toBeGreaterThan(0);
    expect(REAL.map(({ index, tag, sha256: hash, schema }) => ({ index, tag, sha256: hash, schema }))).toEqual(
      manifest.map((entry, position) => ({ index: position + 1, ...entry })),
    );
    for (const { tag, sha256: hash, statements } of REAL) {
      const bytes = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`));
      // Of the file as it lies on the disk: what "shasum -a 256" says of it.
      expect(hash).toBe(sha256(bytes));
      const text = bytes.toString("utf8");
      // Nothing of the file is lost between its breakpoints: the statements are the file without them.
      const letters = (sql: string) => sql.replace(/\s+/g, "");
      expect(letters(statements.join(""))).toBe(letters(text.split("--> statement-breakpoint").join("")));
    }
  });

  it("cuts a file into its statements at the breakpoints, each with the comment above it", () => {
    const folder = folderWithText(
      `-- The first table.\nCREATE TABLE a (x INTEGER) STRICT;\n--> statement-breakpoint\n\n/* The second,\n   with a trigger. */\nCREATE TABLE b (x INTEGER) STRICT;\n--> statement-breakpoint\nCREATE TRIGGER b_fixed BEFORE UPDATE ON b\nBEGIN SELECT RAISE(ABORT, 'b: fixed'); END;\n`,
    );

    expect(readMigrations(folder)).toEqual([
      {
        index: 1,
        tag: "0001_only",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        schema: "any",
        statements: [
          "-- The first table.\nCREATE TABLE a (x INTEGER) STRICT;",
          "/* The second,\n   with a trigger. */\nCREATE TABLE b (x INTEGER) STRICT;",
          "CREATE TRIGGER b_fixed BEFORE UPDATE ON b\nBEGIN SELECT RAISE(ABORT, 'b: fixed'); END;",
        ],
      },
    ]);
  });

  it("reads a folder of several migrations that a test wrote, the real ones first", () => {
    const migrations = withSteps(tableStep("one"), tableStep("two"));

    expect(readMigrations(folderOf(migrations))).toEqual(migrations);
    expect(migrations.map(({ tag }) => tag)).toEqual([
      ...REAL_TAGS,
      tagAt(REAL.length + 1, "one"),
      tagAt(REAL.length + 2, "two"),
    ]);
  });

  it("refuses a file that is not what the manifest says, and names the hash it has", () => {
    const folder = folderOf(withSteps(tableStep("one")));
    const file = join(folder, `${tagAt(REAL.length + 1, "one")}.sql`);
    // The smallest edit of a migration that was applied somewhere: one more space.
    writeFileSync(file, `${readFileSync(file, "utf8")} `);

    expect(() => readMigrations(folder)).toThrow(
      `Migration ${tagAt(REAL.length + 1, "one")} differs from its entry in manifest.json (the sha256 of the file is ${sha256(readFileSync(file, "utf8"))}).`,
    );
  });

  it("takes the sha256 of the bytes of a file and not of the text they are read as", () => {
    // A byte that is no UTF-8 is read as the same character whatever byte it is: two files, and one text.
    const fileWith = (byte: number) =>
      Buffer.concat([
        Buffer.from("-- caf"),
        Buffer.from([byte]),
        Buffer.from("\nCREATE TABLE notes (body TEXT) STRICT;\n"),
      ]);
    const [written, other] = [fileWith(0xe9), fileWith(0xf8)];
    expect(written.equals(other)).toBe(false);
    expect(written.toString("utf8")).toBe(other.toString("utf8"));
    const folder = tempDir();
    writeFileSync(join(folder, "0001_only.sql"), written);
    writeFileSync(
      join(folder, "manifest.json"),
      JSON.stringify([{ tag: "0001_only", sha256: sha256(written), schema: "any" }]),
    );

    // The entry holds what any tool says of the file.
    expect(readMigrations(folder).map(({ sha256: hash }) => hash)).toEqual([sha256(written)]);

    writeFileSync(join(folder, "0001_only.sql"), other);
    expect(() => readMigrations(folder)).toThrow(
      `Migration 0001_only differs from its entry in manifest.json (the sha256 of the file is ${sha256(other)}).`,
    );
  });

  it("refuses a migration file that the manifest does not list", () => {
    const folder = folderOf(withSteps(tableStep("one")));
    writeFileSync(join(folder, "0009_forgotten.sql"), "CREATE TABLE forgotten (x INTEGER) STRICT;\n");

    expect(() => readMigrations(folder)).toThrow(
      "The migration file 0009_forgotten.sql is not listed in manifest.json.",
    );
  });

  it("does not mind other files in the folder", () => {
    const folder = folderOf(withSteps(tableStep("one")));
    writeFileSync(join(folder, "notes.txt"), "not a migration");

    expect(readMigrations(folder)).toHaveLength(REAL.length + 1);
  });

  it("says what is missing when a listed file is not there", () => {
    const folder = folderOf(withSteps(tableStep("one")));
    rmSync(join(folder, `${tagAt(REAL.length + 1, "one")}.sql`));

    expect(() => readMigrations(folder)).toThrow(/ENOENT/);
  });

  it.each([
    ["a number that leaves a gap", "0003_later"],
    ["the number of the migration before it", "0001_again"],
    ["no number", "second"],
    ["three digits", "002_second"],
    ["capitals", "0002_Second"],
    ["a hyphen", "0002_second-try"],
    ["no words", "0002_"],
  ])("refuses a second migration that is called by %s", (_what, tag) => {
    const folder = tempDir();
    const first = "CREATE TABLE a (x INTEGER) STRICT;\n";
    const second = "CREATE TABLE b (x INTEGER) STRICT;\n";
    writeFileSync(join(folder, "0001_first.sql"), first);
    writeFileSync(join(folder, `${tag}.sql`), second);
    writeFileSync(
      join(folder, "manifest.json"),
      JSON.stringify([
        { tag: "0001_first", sha256: sha256(first), schema: "any" },
        { tag, sha256: sha256(second), schema: "any" },
      ]),
    );

    expect(() => readMigrations(folder)).toThrow(`Migration 2 of manifest.json is called "${tag}"`);
  });

  it.each([
    ["is no list", { tag: "0001_only" }, "manifest.json has to hold a list of migrations"],
    // A code without a migration would take every database for a newer one, and create one without a schema.
    ["lists nothing", [], "manifest.json lists no migration."],
    [
      "has an entry without its hashes",
      [{ tag: "0001_only" }],
      'Entry 1 of manifest.json needs the texts "tag", "sha256" and "schema".',
    ],
    [
      "has an entry that is no object",
      [null],
      'Entry 1 of manifest.json needs the texts "tag", "sha256" and "schema".',
    ],
  ])("refuses a manifest that %s", (_what, manifest, message) => {
    const folder = tempDir();
    writeFileSync(join(folder, "manifest.json"), JSON.stringify(manifest));

    expect(() => readMigrations(folder)).toThrow(message);
  });

  // The runner owns the one transaction, the connection and the header of the file.
  it.each([
    "BEGIN",
    "BEGIN IMMEDIATE",
    "COMMIT",
    "END",
    "END TRANSACTION",
    "ROLLBACK",
    "SAVEPOINT half",
    "RELEASE half",
    "VACUUM",
    "ATTACH DATABASE 'other.sqlite' AS other",
    "DETACH DATABASE other",
    "REINDEX",
    "ANALYZE",
    "PRAGMA foreign_keys = ON",
    "pragma user_version = 2",
    "-- A comment does not hide it.\n  PRAGMA journal_mode = DELETE",
  ])("refuses a migration with the statement %j, which belongs to the runner", (statement) => {
    const folder = folderWithText(textOf(["CREATE TABLE a (x INTEGER) STRICT;", `${statement};`]));

    expect(() => readMigrations(folder)).toThrow(
      "Migration 0001_only, statement 2: a statement that belongs to the runner (transactions, PRAGMA, VACUUM, ATTACH and their kin) is not allowed.",
    );
  });

  it.each([
    "DROP TABLE workspace_pin",
    "DROP TRIGGER workspace_pin_no_update",
    "UPDATE Workspace_Pin SET endpoint = 'https://other.corp.example'",
    "DELETE FROM schema_migrations",
    "CREATE TABLE note (id INTEGER PRIMARY KEY, migration INTEGER REFERENCES schema_migrations (idx)) STRICT",
  ])("refuses a migration that touches a table of another layer: %j", (statement) => {
    const folder = folderWithText(textOf([`${statement};`]));

    expect(() => readMigrations(folder)).toThrow(
      "Migration 0001_only, statement 1: a table of another layer (workspace_pin, schema_migrations) is not allowed.",
    );
  });

  // REPLACE removes the row that is in the way without firing its UPDATE and DELETE triggers.
  it.each([
    "INSERT OR REPLACE INTO a (x) VALUES (1)",
    "insert or  replace into a (x) values (1)",
    "UPDATE OR REPLACE a SET x = 2",
    "REPLACE INTO a (x) VALUES (1)",
    "CREATE TABLE b (x INTEGER PRIMARY KEY ON CONFLICT REPLACE) STRICT",
    "CREATE TRIGGER a_copy AFTER INSERT ON a BEGIN INSERT OR REPLACE INTO a (x) VALUES (NEW.x + 1); END",
  ])("refuses a migration that replaces rows: %j", (statement) => {
    const folder = folderWithText(textOf(["CREATE TABLE a (x INTEGER UNIQUE) STRICT;", `${statement};`]));

    expect(() => readMigrations(folder)).toThrow(
      "Migration 0001_only, statement 2: a statement that replaces rows (REPLACE) is not allowed.",
    );
  });

  // With an action, a table rebuilt with foreign keys left on would empty the tables that point at it.
  it.each([
    "ON DELETE CASCADE",
    "ON DELETE SET NULL",
    "ON DELETE SET DEFAULT",
    "ON DELETE RESTRICT",
    "ON UPDATE CASCADE",
    "on update  set\n null",
  ])("refuses a migration with a foreign key that says %j", (action) => {
    const folder = folderWithText(
      textOf([
        "CREATE TABLE a (x INTEGER PRIMARY KEY) STRICT;",
        `CREATE TABLE b (a INTEGER REFERENCES a (x) ${action}) STRICT;`,
      ]),
    );

    expect(() => readMigrations(folder)).toThrow(
      "Migration 0001_only, statement 2: a foreign key with an action is not allowed.",
    );
  });

  it("refuses a statement that is nothing but a comment, and a file without a statement", () => {
    expect(() =>
      readMigrations(folderWithText(textOf(["CREATE TABLE a (x INTEGER) STRICT;", "-- Left over."]))),
    ).toThrow("Migration 0001_only, statement 2: nothing but a comment.");
    expect(() =>
      readMigrations(folderWithText(textOf(["CREATE TABLE a (x INTEGER) STRICT;", "/* Never closed."]))),
    ).toThrow("Migration 0001_only, statement 2: nothing but a comment.");
    expect(() => readMigrations(folderWithText("\n\n"))).toThrow("Migration 0001_only holds no statement.");
  });

  /** A database on which the statements of the tests below are SQL that runs: what they name is there. */
  function withTableA(): Database.Database {
    const db = new Database(":memory:");
    connections.push(db);
    db.exec(
      "CREATE TABLE a (x INTEGER UNIQUE, note TEXT) STRICT; CREATE TABLE workspace_pin (id INTEGER PRIMARY KEY) STRICT",
    );
    return db;
  }

  // SQLite skips a statement that is empty and runs the one behind it, which then does not begin
  // the text: every rule that goes by how a statement begins would be passed.
  it.each([
    ";PRAGMA user_version = 9",
    " ;\tCOMMIT",
    ";;VACUUM",
    "/* A comment does not hide it. */ ;ANALYZE",
    "-- Nor does this one.\n;PRAGMA ignore_check_constraints = ON",
    ";CREATE TABLE b (x INTEGER) STRICT",
  ])("refuses a migration whose statement %j begins with an empty one", (statement) => {
    const folder = folderWithText(textOf(["CREATE TABLE a (x INTEGER) STRICT;", `${statement};`]));

    expect(() => readMigrations(folder)).toThrow(
      'Migration 0001_only, statement 2: begins with ";", an empty statement in front of the one that would run.',
    );
    // The control: handed to the database as it is, the statement behind the semicolon is the one
    // that runs. Inside a transaction, as in a migration; VACUUM is the one that SQLite itself refuses there.
    const db = withTableA();
    if (!statement.includes("VACUUM")) db.exec("BEGIN");
    db.prepare(statement).run();
  });

  // SQLite reads a statement as far as a NUL character and no further, and there the database
  // library stops looking for a second statement: what stands behind one would be in the file, and
  // in its sha256, and would never run.
  it.each([
    ["with a second statement behind it", "INSERT INTO a (x) VALUES (1);\0\nINSERT INTO a (x) VALUES (2);", [1, 7, 8]],
    ["with the rest of its statement behind it", "DELETE FROM a\0 WHERE x = 7;", []],
  ])("refuses a migration that holds a NUL character %s", (_what, statement, left) => {
    const folder = folderWithText(textOf(["CREATE TABLE a (x INTEGER UNIQUE, note TEXT) STRICT;", statement]));

    expect(() => readMigrations(folder)).toThrow(
      "Migration 0001_only holds a NUL character: SQLite reads a statement only as far as that.",
    );
    // The control: handed to the database as it is, the text is taken for one statement, and what
    // runs is the part in front of the NUL.
    const db = withTableA();
    db.exec("INSERT INTO a (x) VALUES (7), (8)");
    db.prepare(statement).run();
    expect(db.prepare("SELECT x FROM a ORDER BY x").pluck().all()).toEqual(left);
  });

  // To SQLite two hyphens or a slash and an asterisk inside a string or a quoted name begin no
  // comment. A reader that cut the text off there would not see what follows.
  it.each([
    [
      "a statement that replaces rows (REPLACE)",
      "CREATE TRIGGER a_copy AFTER INSERT ON a WHEN NEW.x > 100 BEGIN SELECT '--'; INSERT OR REPLACE INTO a (x, note) VALUES (1, 'replaced'); END",
    ],
    [
      "a foreign key with an action",
      "CREATE TABLE b (mark TEXT DEFAULT '--', a INTEGER REFERENCES a (x) ON DELETE CASCADE) STRICT",
    ],
    [
      "a foreign key with an action",
      "CREATE TABLE b (mark TEXT DEFAULT '/*', a INTEGER REFERENCES a (x) ON DELETE SET NULL, note TEXT DEFAULT '*/') STRICT",
    ],
    [
      "a foreign key with an action",
      'CREATE TABLE b ("--" TEXT, `/*` TEXT, [-- x] TEXT, a INTEGER REFERENCES a (x) ON UPDATE CASCADE) STRICT',
    ],
    [
      "a table of another layer (workspace_pin, schema_migrations)",
      "CREATE TABLE b (mark TEXT DEFAULT 'it''s -- no comment', pin INTEGER REFERENCES workspace_pin (id)) STRICT",
    ],
    // And a quote inside a comment begins no string that would hide the statement under it.
    [
      "a statement that replaces rows (REPLACE)",
      "-- It's the comment that holds the quote.\nINSERT OR REPLACE INTO a (x, note) VALUES (1, 'x')",
    ],
    [
      "a statement that replaces rows (REPLACE)",
      "/* A \" in a comment begins no name. */ UPDATE OR REPLACE a SET x = 2 WHERE note = '\"'",
    ],
  ])(
    "refuses %s behind a string, a name or a comment that only looks like the end of the text: %j",
    (what, statement) => {
      const folder = folderWithText(textOf(["CREATE TABLE a (x INTEGER UNIQUE, note TEXT) STRICT;", `${statement};`]));

      expect(() => readMigrations(folder)).toThrow(`Migration 0001_only, statement 2: ${what} is not allowed.`);
      // The control: it is SQL that the database takes, with the part that the rule is about.
      withTableA().prepare(statement).run();
    },
  );

  it.each(["SELECT * FROM pragma_optimize", "INSERT INTO a (x) SELECT count(*) FROM Pragma_Optimize(0xfffe)"])(
    "refuses a migration that gathers statistics through a query: %j",
    (statement) => {
      const folder = folderWithText(textOf(["CREATE TABLE a (x INTEGER UNIQUE, note TEXT) STRICT;", `${statement};`]));

      expect(() => readMigrations(folder)).toThrow(
        "Migration 0001_only, statement 2: a query of pragma_optimize, which gathers statistics as ANALYZE does, is not allowed.",
      );
    },
  );

  it("would otherwise leave the tables of statistics behind, which change how queries are planned", () => {
    // The control for the rule above: the one PRAGMA that changes something when it is asked as a table.
    const db = withTableA();
    db.exec("CREATE INDEX a_by_note ON a (note); INSERT INTO a (x, note) VALUES (1, 'a'), (2, 'b')");

    db.prepare("SELECT * FROM pragma_optimize").all();

    expect(hasTable(db, "sqlite_stat1")).toBe(true);
  });

  describe("the breakpoint", () => {
    const WANTED = 'Migration 0001_only: "--> statement-breakpoint" is a line of its own.';

    it.each([
      // To SQLite, and to an editor, the whole line is a comment: nothing behind the words may run.
      ["text behind it", "CREATE TABLE a (x INTEGER) STRICT;\n--> statement-breakpoint DROP TABLE a;\n"],
      [
        "a statement in front of it",
        "CREATE TABLE a (x INTEGER) STRICT; --> statement-breakpoint\nCREATE TABLE b (x INTEGER) STRICT;\n",
      ],
      [
        "a string around it",
        "CREATE TABLE a (note TEXT) STRICT;\n--> statement-breakpoint\nINSERT INTO a VALUES ('--> statement-breakpoint');\n",
      ],
      ["a comment around it", "/* --> statement-breakpoint */\nCREATE TABLE a (x INTEGER) STRICT;\n"],
      // Not white space to SQLite: a no-break space is a letter of a name there.
      ["a no-break space in front of it", "CREATE TABLE a (x INTEGER) STRICT;\n\u00a0--> statement-breakpoint\n"],
    ])("is refused with %s", (_what, text) => {
      expect(() => readMigrations(folderWithText(text))).toThrow(WANTED);
    });

    // To SQLite, and to an editor, a comment between two marks runs on over every line in it, a
    // breakpoint line among them. A reader that cut the file there would run what the file comments out.
    describe("on a line inside a comment between two marks", () => {
      const COMMENTED_OUT = "UPDATE a SET x = 0;";
      const fileWith = (lastLineOfTheComment: string) =>
        [
          "INSERT INTO a (x) VALUES (7);",
          "/* Not yet, see the review:",
          "--> statement-breakpoint",
          COMMENTED_OUT,
          "--> statement-breakpoint",
          lastLineOfTheComment,
          "INSERT INTO a (x) VALUES (8);",
          "",
        ].join("\n");

      // In both, what follows the last breakpoint is SQL by itself as well: a comment and a statement.
      it.each([
        ["behind a first mark, which means nothing inside it", fileWith("/* until here */")],
        ["behind two hyphens, which mean nothing inside it", fileWith("-- */")],
      ])("is refused: the statement before it ends inside a comment that goes on to a mark %s", (_what, text) => {
        expect(() => readMigrations(folderWithText(text))).toThrow(
          "Migration 0001_only, statement 1: ends inside a comment that is never closed.",
        );
        // The control. As one script the file leaves the rows as its statements wrote them: the
        // UPDATE is a part of the comment. Cut at the breakpoint lines, it is a statement that runs.
        const values = (run: (db: Database.Database) => void) => {
          const db = withTableA();
          run(db);
          return db.prepare("SELECT x FROM a ORDER BY x").pluck().all();
        };
        expect(values((db) => db.exec(text))).toEqual([7, 8]);
        const cut = text.split("--> statement-breakpoint\n");
        expect(cut).toContain(`${COMMENTED_OUT}\n`);
        expect(
          values((db) => {
            for (const statement of cut) db.exec(statement);
          }),
        ).toEqual([0, 8]);
      });

      it.each([
        ["a comment that is opened and never closed", "CREATE TABLE a (x INTEGER) STRICT;\n/* Left open."],
        // The two marks share their asterisk: to SQLite the comment has begun and has not ended.
        ["a slash, an asterisk and a slash", "CREATE TABLE a (x INTEGER) STRICT; /*/"],
      ])("is not needed for the refusal: a statement that ends with %s", (_what, statement) => {
        const folder = folderWithText(textOf(["CREATE TABLE first (x INTEGER) STRICT;", statement]));

        expect(() => readMigrations(folder)).toThrow(
          "Migration 0001_only, statement 2: ends inside a comment that is never closed.",
        );
      });
    });

    it("may have blanks around it, and a line end of either kind", () => {
      const folder = folderWithText(
        "CREATE TABLE a (x INTEGER) STRICT;\r\n  --> statement-breakpoint\t \r\nCREATE TABLE b (x INTEGER) STRICT;\n\t--> statement-breakpoint\n\n-- The last one.\nCREATE TABLE c (x INTEGER) STRICT;",
      );

      expect(readMigrations(folder)[0]?.statements).toEqual([
        "CREATE TABLE a (x INTEGER) STRICT;",
        "CREATE TABLE b (x INTEGER) STRICT;",
        "-- The last one.\nCREATE TABLE c (x INTEGER) STRICT;",
      ]);
    });
  });

  it("goes by the statements and not by words that only look like them", () => {
    // The control: what the refusals above go by is the SQL, so none of these is one.
    const statements = [
      "-- Not in this file: workspace_pin, schema_migrations, PRAGMA user_version, INSERT OR REPLACE, ON DELETE CASCADE.\nCREATE TABLE a (x INTEGER PRIMARY KEY, note TEXT) STRICT;",
      "/* COMMIT; VACUUM; REPLACE INTO a */ CREATE TABLE b (a INTEGER REFERENCES a (x) ON DELETE NO ACTION ON UPDATE NO ACTION) STRICT;",
      "CREATE TABLE begin_log (analyze_at TEXT, pragma TEXT) STRICT;",
      "CREATE TRIGGER a_no_replace BEFORE INSERT ON a WHEN EXISTS (SELECT 1 FROM a WHERE x = NEW.x)\nBEGIN SELECT RAISE(ABORT, 'a: a row is never replaced'); END;",
      "CREATE TRIGGER a_on_update AFTER UPDATE OF note ON a BEGIN DELETE FROM b WHERE a = OLD.x; END;",
      "UPDATE a SET note = 'x' WHERE note IS NULL OR replace(note, ' ', '') = '';",
      "INSERT INTO a (x, note) VALUES (1, 'a') ON CONFLICT (x) DO UPDATE SET note = excluded.note;",
      // Strings and names that hold what begins a comment, and comments that hold what begins a string.
      "CREATE TABLE c (mark TEXT DEFAULT '--', other TEXT DEFAULT '/*', \"a--b\" INTEGER, `c/*d` INTEGER, [e--f] INTEGER) STRICT;",
      "-- It's a comment with one quote in it; the next has two kinds, in pairs.\n-- A \"name\" and a 'string'.\nINSERT INTO c (mark, other) VALUES ('it''s; -- not a comment', ';PRAGMA is a word here');",
      "/* Don't: ON DELETE CASCADE. */ CREATE TABLE d (c INTEGER REFERENCES c (rowid)) STRICT /* \"never closed */;",
      "SELECT name FROM pragma_table_info('a') WHERE name <> 'pragma_optimized';",
      // Comments that are closed, however short, and a first mark that begins none: in a string, behind two hyphens.
      "CREATE TABLE e (mark TEXT DEFAULT '/* no comment') STRICT /**/;",
      "-- A line may hold /* and nothing after it.\nCREATE TABLE f (x INTEGER) STRICT /***/ /* a * b / c **/;",
    ];
    const folder = folderWithText(textOf(statements));

    expect(readMigrations(folder)[0]?.statements).toEqual(statements);
    // And they are SQL that runs.
    const db = new Database(":memory:");
    connections.push(db);
    for (const statement of statements) {
      const prepared = db.prepare(statement);
      if (prepared.reader) prepared.all();
      else prepared.run();
    }
  });

  describe("an error of its own kind for everything that is wrong with a folder", () => {
    function filesFailure(run: () => unknown): MigrationFilesError {
      try {
        run();
      } catch (error) {
        if (error instanceof MigrationFilesError) return error;
        throw error;
      }
      throw new Error("No MigrationFilesError was thrown.");
    }

    it("names the file whose bytes are not the ones of its manifest entry, as a checkout that rewrites line ends leaves it", () => {
      const folder = folderOf(withSteps(tableStep("one")));
      const file = join(folder, `${REAL_TAGS[0]}.sql`);
      // What git does to a text file where it is told to convert line ends.
      writeFileSync(file, readFileSync(file, "utf8").replaceAll("\n", "\r\n"));

      const error = filesFailure(() => readMigrations(folder));

      expect(error.name).toBe("MigrationFilesError");
      expect(error.message).toContain(`Migration ${REAL_TAGS[0]} differs from its entry in manifest.json`);
      expect(factsOf(error)).toEqual({ folder, changedFile: file });
    });

    /** What an error says beside its message: the folder, and the one fault that it names by a path. */
    function factsOf(error: MigrationFilesError): Record<string, string> {
      const { folder, changedFile, missingFile, unreadablePath, code, unlistedFile, damagedManifest } = error;
      return Object.fromEntries(
        Object.entries({
          folder,
          changedFile,
          missingFile,
          unreadablePath,
          code,
          unlistedFile,
          damagedManifest,
        }).filter((fact): fact is [string, string] => fact[1] !== undefined),
      );
    }
    const added = (folder: string) => join(folder, `${tagAt(REAL.length + 1, "one")}.sql`);
    const manifestOf = (folder: string) => join(folder, "manifest.json");

    // The faults that need no mistake in a migration: half of an update of the code, a file that
    // lost its permissions, a copy that an editor or a file manager left beside the original.
    it.each<[string, (folder: string) => void, RegExp, (folder: string) => Record<string, string>]>([
      [
        "a manifest that is missing",
        (folder) => rmSync(join(folder, "manifest.json")),
        /ENOENT/,
        (folder) => ({ missingFile: join(folder, "manifest.json") }),
      ],
      [
        "a manifest that is empty, as half of a write leaves it",
        (folder) => writeFileSync(manifestOf(folder), ""),
        /manifest\.json cannot be read as JSON/,
        (folder) => ({ damagedManifest: manifestOf(folder) }),
      ],
      [
        "a manifest that is cut short",
        (folder) => writeFileSync(manifestOf(folder), readFileSync(manifestOf(folder)).subarray(0, 70)),
        /manifest\.json cannot be read as JSON/,
        (folder) => ({ damagedManifest: manifestOf(folder) }),
      ],
      [
        "a manifest with the marks of a merge that was not finished",
        (folder) =>
          writeFileSync(
            manifestOf(folder),
            `<<<<<<< HEAD\n${readFileSync(manifestOf(folder), "utf8")}=======\n[]\n>>>>>>> other\n`,
          ),
        /manifest\.json cannot be read as JSON/,
        (folder) => ({ damagedManifest: manifestOf(folder) }),
      ],
      [
        "a manifest that was saved with a byte order mark",
        (folder) => writeFileSync(manifestOf(folder), `\ufeff${readFileSync(manifestOf(folder), "utf8")}`),
        /manifest\.json cannot be read as JSON/,
        (folder) => ({ damagedManifest: manifestOf(folder) }),
      ],
      [
        "a manifest that is JSON and no list",
        (folder) => writeFileSync(manifestOf(folder), "{}"),
        /manifest\.json has to hold a list of migrations/,
        (folder) => ({ damagedManifest: manifestOf(folder) }),
      ],
      [
        "a listed file that is missing",
        (folder) => rmSync(added(folder)),
        /ENOENT/,
        (folder) => ({ missingFile: added(folder) }),
      ],
      [
        "a listed file that may not be read",
        (folder) => chmodSync(added(folder), 0o000),
        /EACCES/,
        (folder) => ({ unreadablePath: added(folder), code: "EACCES" }),
      ],
      [
        "a directory under the name of a listed file",
        (folder) => {
          rmSync(added(folder));
          mkdirSync(added(folder));
        },
        /EISDIR/,
        (folder) => ({ unreadablePath: added(folder), code: "EISDIR" }),
      ],
      [
        "a migration file that is not listed",
        (folder) => writeFileSync(join(folder, "0009_forgotten.sql"), "CREATE TABLE forgotten (x INTEGER) STRICT;\n"),
        /0009_forgotten\.sql is not listed/,
        (folder) => ({ unlistedFile: join(folder, "0009_forgotten.sql") }),
      ],
      [
        "a copy of a migration file under a name with a blank",
        (folder) => copyFileSync(added(folder), join(folder, "0001_init copy.sql")),
        /0001_init copy\.sql is not listed/,
        (folder) => ({ unlistedFile: join(folder, "0001_init copy.sql") }),
      ],
    ])("names by its path what is wrong, for %s", (_what, damage, message, facts) => {
      const folder = folderOf(withSteps(tableStep("one")));
      damage(folder);

      const error = filesFailure(() => readMigrations(folder));

      expect(error.message).toMatch(message);
      expect(factsOf(error)).toEqual({ folder, ...facts(folder) });
    });

    it("names the folder as what could not be read when its files open and it cannot be listed", () => {
      const folder = folderOf(withSteps(tableStep("one")));
      // May be entered and may not be listed: every file opens by its name, and a file that no entry names stays unseen.
      chmodSync(folder, 0o300);

      try {
        const error = filesFailure(() => readMigrations(folder));

        expect(error.message).toMatch(/EACCES/);
        expect(factsOf(error)).toEqual({ folder, unreadablePath: folder, code: "EACCES" });
      } finally {
        chmodSync(folder, 0o700);
      }
    });

    // What only a mistake in the folder brings about: the message states the rule, and that is all.
    // A manifest that is a list is whole, whatever it lists.
    it.each<[string, (folder: string) => void, RegExp]>([
      [
        "a manifest that lists nothing",
        (folder) => writeFileSync(join(folder, "manifest.json"), "[]"),
        /manifest\.json lists no migration/,
      ],
    ])("names the folder alone for %s", (_what, damage, message) => {
      const folder = folderOf(withSteps(tableStep("one")));
      damage(folder);

      const error = filesFailure(() => readMigrations(folder));

      expect(error.message).toMatch(message);
      expect(factsOf(error)).toEqual({ folder });
    });

    it("is what a statement that is not allowed is refused with, too", () => {
      const folder = folderWithText("PRAGMA user_version = 2;\n");

      expect(filesFailure(() => readMigrations(folder)).folder).toBe(folder);
    });
  });
});

describe("schemaFingerprint", () => {
  function memory(...statements: string[]): Database.Database {
    const db = new Database(":memory:");
    connections.push(db);
    for (const statement of statements) db.exec(statement);
    return db;
  }
  const TABLE = "CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT NOT NULL CHECK (body <> '')) STRICT";
  const INDEX = "CREATE INDEX note_by_body ON note (body)";
  const TRIGGER = "CREATE TRIGGER note_fixed BEFORE UPDATE ON note BEGIN SELECT RAISE(ABORT, 'note: fixed'); END";

  it("is the same for the same schema, in whatever order it was made", () => {
    const fingerprint = schemaFingerprint(memory(TABLE, INDEX, TRIGGER));

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(schemaFingerprint(memory(TABLE, TRIGGER, INDEX))).toBe(fingerprint);
  });

  it.each([
    ["a trigger is missing", [TABLE, INDEX]],
    ["an index is missing", [TABLE, TRIGGER]],
    ["a CHECK is missing", [TABLE.replace(" CHECK (body <> '')", ""), INDEX, TRIGGER]],
    ["a column allows NULL", [TABLE.replace(" NOT NULL", ""), INDEX, TRIGGER]],
    ["a table is not STRICT", [TABLE.replace(" STRICT", ""), INDEX, TRIGGER]],
    ["an index covers another column", [TABLE, INDEX.replace("(body)", "(id)"), TRIGGER]],
    ["a trigger says something else", [TABLE, INDEX, TRIGGER.replace("note: fixed", "note: never")]],
    ["a trigger is on another event", [TABLE, INDEX, TRIGGER.replace("BEFORE UPDATE", "BEFORE DELETE")]],
    ["there is one more table", [TABLE, INDEX, TRIGGER, "CREATE TABLE extra (x INTEGER) STRICT"]],
    ["a name differs", [TABLE, INDEX.replace("note_by_body", "note_body"), TRIGGER]],
  ])("is another one when %s", (_what, statements) => {
    expect(schemaFingerprint(memory(...statements))).not.toBe(schemaFingerprint(memory(TABLE, INDEX, TRIGGER)));
  });

  it("does not count quotes, nor how the white space between two words is made up", () => {
    const written = memory(TABLE, INDEX, TRIGGER);
    const rewritten = memory(
      'CREATE TABLE  "note"\n  ("id" INTEGER\tPRIMARY KEY,\n   "body" TEXT NOT NULL CHECK (body <> \'\'))   STRICT',
      INDEX,
      TRIGGER,
    );

    expect(schemaFingerprint(rewritten)).toBe(schemaFingerprint(written));
    // What ALTER TABLE ... RENAME leaves behind: the name of the table in quotes.
    const renamed = memory(
      TABLE.replace("TABLE note", "TABLE new_note"),
      "ALTER TABLE new_note RENAME TO note",
      INDEX,
      TRIGGER,
    );
    expect(renamed.prepare("SELECT sql FROM sqlite_schema WHERE name = 'note'").pluck().get()).toContain('"note"');
    expect(schemaFingerprint(renamed)).toBe(schemaFingerprint(written));
  });

  it("keeps the end of a comment line: a column that a comment has swallowed is another schema", () => {
    const columnsOfT = (db: Database.Database) => db.prepare("SELECT name FROM pragma_table_info('t')").pluck().all();
    const written = memory(
      "CREATE TABLE t (\n  a INTEGER NOT NULL,\n  -- b is positive\n  b INTEGER CHECK (b > 0),\n  c INTEGER\n) STRICT",
    );
    // The comment joined to the line under it, as a table restated by hand can end up: to SQLite
    // the rest of that line is the comment.
    const swallowed = memory(
      "CREATE TABLE t (\n  a INTEGER NOT NULL,\n  -- b is positive b INTEGER CHECK (b > 0),\n  c INTEGER\n) STRICT",
    );
    expect(columnsOfT(written)).toEqual(["a", "b", "c"]);
    expect(columnsOfT(swallowed)).toEqual(["a", "c"]);

    expect(schemaFingerprint(swallowed)).not.toBe(schemaFingerprint(written));
    // How the lines around the comment are laid out still does not count, nor blanks at its end.
    const laidOutAnew = memory(
      "CREATE TABLE t (\n\ta INTEGER NOT NULL,     --   b is positive   \n\n\t\tb INTEGER CHECK (b > 0),\n c INTEGER\n) STRICT",
    );
    expect(schemaFingerprint(laidOutAnew)).toBe(schemaFingerprint(written));
  });

  it("takes for white space only what is white space to SQLite: any other blank is a letter of a name", () => {
    const columnsOfT = (db: Database.Database) => db.prepare("SELECT name FROM pragma_table_info('t')").pluck().all();
    // A no-break space between two words makes them one name; a space makes them a name and its type.
    const oneName = memory("CREATE TABLE t (a\u00a0b INTEGER)");
    const nameAndType = memory("CREATE TABLE t (a b INTEGER)");
    expect(columnsOfT(oneName)).toEqual(["a\u00a0b"]);
    expect(columnsOfT(nameAndType)).toEqual(["a"]);

    expect(schemaFingerprint(oneName)).not.toBe(schemaFingerprint(nameAndType));
  });

  // Two limits of the fingerprint, held here as what they are.
  it("takes a byte order mark for a letter where SQLite reads a blank: one schema, and two fingerprints", () => {
    const typeOfA = (db: Database.Database) =>
      db.prepare("SELECT type FROM pragma_table_info('t') WHERE name = 'a'").pluck().get();
    const withMark = memory("CREATE TABLE t (a \ufeffb INTEGER)");
    const withBlank = memory("CREATE TABLE t (a  b INTEGER)");
    // To SQLite both are a column a of the type "b INTEGER".
    expect(typeOfA(withMark)).toBe("b INTEGER");
    expect(typeOfA(withBlank)).toBe("b INTEGER");

    // The direction that refuses a database and lets none through.
    expect(schemaFingerprint(withMark)).not.toBe(schemaFingerprint(withBlank));
  });

  it("does not see the quotes around a name where they are what makes it one name: two schemas, and one fingerprint", () => {
    const columnsOfT = (db: Database.Database) => db.prepare("SELECT name, type FROM pragma_table_info('t')").all();
    const oneName = memory('CREATE TABLE t ("a b" INTEGER)');
    const nameAndType = memory("CREATE TABLE t (a b INTEGER)");
    expect(columnsOfT(oneName)).toEqual([{ name: "a b", type: "INTEGER" }]);
    expect(columnsOfT(nameAndType)).toEqual([{ name: "a", type: "b INTEGER" }]);

    expect(schemaFingerprint(oneName)).toBe(schemaFingerprint(nameAndType));
  });

  it("does not count how the white space inside a comment between two marks is made up", () => {
    const table = (comment: string) =>
      memory(`CREATE TABLE note (id INTEGER PRIMARY KEY ${comment}, body TEXT) STRICT`);

    expect(schemaFingerprint(table("/*\ta b\n*/"))).toBe(schemaFingerprint(table("/* a   b */")));
    // The control: the words of a comment do count.
    expect(schemaFingerprint(table("/* a c */"))).not.toBe(schemaFingerprint(table("/* a b */")));
  });

  it.each([
    ["a blank in a string", "CHECK (body <> ' ')", "CHECK (body <> '\t\t')"],
    ["a quote in a string", "CHECK (body <> 'a \"b\" c')", "CHECK (body <> 'a b c')"],
    ["two hyphens in a string", "CHECK (body <> '--\n')", "CHECK (body <> '-- ')"],
    ["blanks in a quoted name", 'CHECK ("a  b" <> body)', 'CHECK ("a b" <> body)'],
  ])("counts what stands inside a string or a quoted name as it is written: %s", (_what, one, other) => {
    const table = (check: string) =>
      memory(`CREATE TABLE note (body TEXT NOT NULL ${check}, "a  b" TEXT, "a b" TEXT) STRICT`);

    expect(schemaFingerprint(table(one))).not.toBe(schemaFingerprint(table(other)));
  });

  it("leaves out the tables of the other layers and the tables SQLite keeps for itself", () => {
    const { db, file } = current();
    const fingerprint = schemaFingerprint(db);
    expect(fingerprint).toBe(HEAD.schema);

    // A file without the pin and without the record of migrations: only what the migrations made.
    const bare = memory();
    bare.pragma("foreign_keys = OFF");
    for (const { statements } of REAL) for (const statement of statements) bare.prepare(statement).run();
    expect(schemaFingerprint(bare)).toBe(fingerprint);

    // ANALYZE creates sqlite_stat1; the application never runs it, somebody with the sqlite3 shell might.
    const visitor = raw(file);
    visitor.exec("ANALYZE");
    expect(hasTable(visitor, "sqlite_stat1")).toBe(true);
    visitor.exec("DROP TRIGGER workspace_pin_no_delete");
    expect(schemaFingerprint(db)).toBe(fingerprint);
  });
});

describe("migrateDatabase on a database without rows", () => {
  it("gives a database that holds the pin alone all migrations, with a copy of what it was", () => {
    const { dir, file, backups } = pinOnly();
    // What such a workspace has: one table with its triggers, format 1, one file.
    const before = raw(file);
    expect(objectsOf(before)).toEqual(PIN_OBJECTS);
    expect(before.pragma("user_version", { simple: true })).toBe(1);
    before.close();
    expect(readdirSync(dir)).toEqual(["hubber.sqlite"]);
    const db = open(file);
    const announced: string[][] = [];

    const result = migrateDatabase(db, {
      snapshotDir: backups,
      now: () => new Date("2026-10-11T12:00:00.123Z"),
      onPending: ({ pending }) => announced.push(pending),
    });

    const snapshot = join(backups, `before-${REAL_TAGS[0]}-20261011T120000123Z.sqlite`);
    expect(result).toEqual({ applied: REAL_TAGS, snapshot });
    expect(announced).toEqual([REAL_TAGS]);
    expect(snapshotsIn(backups)).toEqual([basename(snapshot)]);
    expect(schemaFingerprint(db)).toBe(HEAD.schema);
    expect(recorded(db)).toEqual(
      REAL.map(({ index, tag, sha256: hash }) => ({
        idx: index,
        tag,
        sha256: hash,
        appliedAt: "2026-10-11T12:00:00.123Z",
        snapshot: basename(snapshot),
      })),
    );
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);

    // The copy is the file as it was, with nothing of the schema in it.
    const copy = raw(snapshot, { readonly: true });
    expect(objectsOf(copy)).toEqual(PIN_OBJECTS);
    expect(copy.prepare("SELECT endpoint, created_at AS createdAt FROM workspace_pin").all()).toEqual([PIN]);
    expect(copy.pragma("user_version", { simple: true })).toBe(WORKSPACE_FORMAT);
    expect(copy.pragma("application_id", { simple: true })).toBe(APPLICATION_ID);
    expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("leaves the pin, the format number and the mark of the file as they were", () => {
    const { file, backups } = pinOnly();
    const db = open(file);

    migrateDatabase(db, { snapshotDir: backups });

    expect(readWorkspacePin(db)).toEqual(PIN);
    expect(db.pragma("user_version", { simple: true })).toBe(WORKSPACE_FORMAT);
    expect(db.pragma("application_id", { simple: true })).toBe(APPLICATION_ID);
    expect(objectsOf(db)).toEqual(expect.arrayContaining(PIN_OBJECTS));
    expect(() => db.exec("DELETE FROM workspace_pin")).toThrow("workspace_pin is immutable");
  });

  it("hands the connection back as it got it: foreign keys on, WAL, and the file free for others", () => {
    const { dir, file, backups } = pinOnly();
    const db = open(file);

    const result = migrateDatabase(db, { snapshotDir: backups });

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("locking_mode", { simple: true })).toBe("normal");
    expect(db.inTransaction).toBe(false);
    // Everything is in the file: the log beside it is empty, and the start has nothing to say of it.
    expect(statSync(`${file}-wal`).size).toBe(0);
    expect(result).not.toHaveProperty("checkpointFailed");
    // Another connection reads and writes while this one stays open.
    const other = raw(file, { timeout: 100 });
    other.exec("CREATE TABLE visitor (x INTEGER) STRICT; DROP TABLE visitor");
    expect(recordedTags(other)).toEqual(REAL_TAGS);
    other.close();
    db.close();
    expect(readdirSync(dir).sort()).toEqual(["backups", "hubber.sqlite"]);
  });

  it("stays migrated when the log cannot be folded back after the commit, and says so: that waits for the next checkpoint", () => {
    const { file, backups } = pinOnly();
    const db = open(file);
    const pragma = db.pragma.bind(db);
    // What a disk gives that has room for the commit and none for the checkpoint after it.
    db.pragma = (source: string, options?: Database.PragmaOptions) => {
      if (source.startsWith("wal_checkpoint")) {
        throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
      }
      return pragma(source, options);
    };

    const { applied, snapshot, checkpointFailed } = migrateDatabase(db, { snapshotDir: backups });

    // The start goes on, and says where its copy is: the migrations are in the database for good.
    // With what SQLite said of the checkpoint: the caller tells the owner where the update is for now.
    expect(checkpointFailed).toBe("SQLITE_FULL");
    expect(applied).toEqual(REAL_TAGS);
    expect(snapshotsIn(backups)).toEqual([basename(snapshot ?? "")]);
    expect(schemaFingerprint(db)).toBe(HEAD.schema);
    expect(statSync(`${file}-wal`).size).toBeGreaterThan(0);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("locking_mode", { simple: true })).toBe("normal");
    // Another connection finds them there, and the close folds the log back after all.
    const other = raw(file, { timeout: 100 });
    expect(recordedTags(other)).toEqual(REAL_TAGS);
    other.close();
    db.close();
    expect(existsSync(`${file}-wal`)).toBe(false);
  });

  it("enforces foreign keys again on the tables it made, although it made them with foreign keys off", () => {
    const { file, backups } = pinOnly();
    const db = open(file);
    const family: Step = {
      words: "family",
      statements: [
        "CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT",
        "CREATE TABLE child (parent_id INTEGER NOT NULL REFERENCES parent (id)) STRICT",
      ],
    };

    migrateDatabase(db, { migrations: withSteps(family), snapshotDir: backups });

    expect(() => db.exec("INSERT INTO child VALUES (7)")).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("does nothing at the second start, and says so", () => {
    const { file, backups } = pinOnly();
    const db = open(file);
    migrateDatabase(db, { snapshotDir: backups });
    const announced: string[][] = [];

    expect(migrateDatabase(db, { snapshotDir: backups, onPending: ({ pending }) => announced.push(pending) })).toEqual({
      applied: [],
      snapshot: null,
    });

    expect(announced).toEqual([]);
    expect(snapshotsIn(backups)).toHaveLength(1);
    expect(recordedTags(db)).toEqual(REAL_TAGS);
  });

  it("makes no copy and no directory for one when it is told that there is nothing to protect yet", () => {
    const { dir, file } = pinOnly();
    const db = open(file);

    expect(migrateDatabase(db, { snapshotDir: null })).toEqual({ applied: REAL_TAGS, snapshot: null });

    expect(recorded(db).map(({ snapshot }) => snapshot)).toEqual(REAL.map(() => null));
    db.close();
    // One file, as a new workspace has to be: nothing beside the database.
    expect(readdirSync(dir)).toEqual(["hubber.sqlite"]);
  });

  it("takes the migrations of this code when it is given none, and the clock when it is given no time", () => {
    const { file, backups } = pinOnly();
    const db = open(file);
    const before = Date.now();

    const { applied, snapshot } = migrateDatabase(db, { snapshotDir: backups });

    expect(applied).toEqual(REAL_TAGS);
    const [row] = recorded(db);
    expect(Date.parse(row?.appliedAt ?? "")).toBeGreaterThanOrEqual(before);
    expect(Date.parse(row?.appliedAt ?? "")).toBeLessThanOrEqual(Date.now());
    // The same instant, as the name of the copy spells it.
    expect(basename(snapshot ?? "")).toBe(`before-${REAL_TAGS[0]}-${row?.appliedAt.replace(/[-:.]/g, "")}.sqlite`);
  });

  it("works on a database in memory, which is what the tests of queries are given", () => {
    const db = new Database(":memory:");
    connections.push(db);
    db.pragma("foreign_keys = ON");

    expect(migrateDatabase(db, { snapshotDir: null })).toEqual({ applied: REAL_TAGS, snapshot: null });

    expect(schemaFingerprint(db)).toBe(HEAD.schema);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(migrateDatabase(db, { snapshotDir: null })).toEqual({ applied: [], snapshot: null });
    // Such a database is copied from its bytes for every test: the copy is as current as the original.
    const copy = new Database(db.serialize());
    connections.push(copy);
    expect(pendingMigrations(copy)).toEqual([]);
  });

  it("refuses a connection that is inside a transaction: the one transaction is its own", () => {
    const { file, backups } = pinOnly();
    const db = open(file);
    db.exec("BEGIN");

    expect(() => migrateDatabase(db, { snapshotDir: backups })).toThrow(
      "migrateDatabase() needs a connection that is not inside a transaction.",
    );

    // Whoever began the transaction still has it.
    expect(db.inTransaction).toBe(true);
    db.exec("ROLLBACK");
    expect(existsSync(backups)).toBe(false);
  });
});

describe("pendingMigrations", () => {
  it("lists what a database has not had yet, and writes nothing", () => {
    const { file } = pinOnly();
    const db = open(file);
    const all = withSteps(tableStep("one"), tableStep("two"));

    expect(pendingMigrations(db)).toEqual(REAL_TAGS);
    expect(objectsOf(db)).toEqual(PIN_OBJECTS);

    migrateDatabase(db, { snapshotDir: null });
    expect(pendingMigrations(db)).toEqual([]);
    expect(pendingMigrations(db, all)).toEqual(all.slice(REAL.length).map(({ tag }) => tag));
  });

  it("refuses a database that this code does not know, as the runner does", () => {
    const { db } = current(withSteps(tableStep("one")));

    expect(failure(() => pendingMigrations(db)).problem).toBe("newer");
  });
});

/**
 * The statements that rebuild a table without changing it, by the one procedure a migration that
 * changes a CHECK, a key or NOT NULL follows: every trigger whose text names the table goes first,
 * also those on other tables; the rows move into a new table that takes the old name; the indexes
 * and the triggers come back as they were. Read off a database that is at the schema before it.
 */
function rebuildOf(db: Database.Database, table: string): string[] {
  const objects = db
    .prepare("SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid")
    .all() as { type: string; name: string; tableName: string; sql: string }[];
  const triggers = objects.filter(({ type, sql }) => type === "trigger" && new RegExp(`\\b${table}\\b`).test(sql));
  const indexes = objects.filter(({ type, tableName }) => type === "index" && tableName === table);
  const create = objects.find(({ type, name }) => type === "table" && name === table)?.sql ?? "";
  // Without the generated columns: those are computed, not stored.
  const columns = (
    db.prepare("SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0").pluck().all(table) as string[]
  ).join(", ");
  return [
    ...triggers.map(({ name }) => `DROP TRIGGER ${name}`),
    create.replace(`CREATE TABLE ${table} (`, `CREATE TABLE new_${table} (`),
    `INSERT INTO new_${table} (${columns}) SELECT ${columns} FROM ${table}`,
    `DROP TABLE ${table}`,
    `ALTER TABLE new_${table} RENAME TO ${table}`,
    ...indexes.map(({ sql }) => sql),
    ...triggers.map(({ sql }) => sql),
  ];
}

describe("migrateDatabase on a database with rows", () => {
  // The two kinds of change a later package will bring: a new column, and a table rebuilt in place.
  const ADD_COLUMN: Step = { words: "operation_note", statements: ["ALTER TABLE operations ADD COLUMN note TEXT"] };
  const REBUILD: Step = { words: "rebuild_operations", statements: (db) => rebuildOf(db, "operations") };

  function filled(): Place & {
    db: WorkspaceDatabase;
    counts: Record<string, number>;
    /** The columns the tables had, and a digest of what their rows held in them. */
    columns: Record<string, string[]>;
    content: Record<string, string>;
  } {
    const place = used();
    const counts = rowCounts(place.db);
    // The tables this is about hold rows: the one that is changed, and the ones that point at it.
    for (const table of ["operations", "operation_effects", "operation_dependencies", "items", "runs"]) {
      expect(counts[table], table).toBeGreaterThan(0);
    }
    expect(place.db.pragma("foreign_key_check")).toEqual([]);
    const columns = columnsOf(place.db);
    return { ...place, counts, columns, content: contentOf(place.db, columns) };
  }

  /**
   * Rows to ask the two rules of the tree of items with, found by what they are: a task with a task
   * directly under it, and a task that sits under something and is no milestone. To put the first
   * under the second, or to make the third a project, breaks one rule of the tree and no other rule.
   */
  function treeRowsOf(db: Database.Database): { above: string; below: string; inAProject: string } {
    const pair = db
      .prepare(
        "SELECT p.id AS above, c.id AS below FROM items c JOIN items p ON p.id = c.parent_id WHERE p.kind = 'task' AND p.merged_into_id IS NULL AND c.merged_into_id IS NULL LIMIT 1",
      )
      .get() as { above: string; below: string } | undefined;
    const inAProject = db
      .prepare("SELECT id FROM items WHERE kind = 'task' AND parent_id IS NOT NULL AND is_milestone = 0 LIMIT 1")
      .pluck()
      .get() as string | undefined;
    if (pair === undefined || inAProject === undefined) throw new Error("The rows hold no task under a task.");
    return { ...pair, inAProject };
  }

  it("writes the rows of every table through the guards of the schema", () => {
    const { db, counts } = filled();

    // The control for the tests below: equal numbers of rows say something only where there are rows.
    expect(Object.entries(counts).filter(([, rows]) => rows === 0)).toEqual([]);
    // And equal rows say something about a column only where a row has a value in it: here the text
    // columns of an operation and the schedule of an item, on tables that the tests below rebuild.
    const withValue = (table: string, column: string) =>
      db.prepare(`SELECT count(*) FROM ${table} WHERE ${column} IS NOT NULL`).pluck().get();
    for (const column of ["quote", "command_quote", "problems", "decided_at", "undone_by_id"]) {
      expect(withValue("operations", column), column).toBeGreaterThan(0);
    }
    for (const column of ["start_on", "start_on_precision", "due_on", "due_on_precision", "health", "closed_at"]) {
      expect(withValue("items", column), column).toBeGreaterThan(0);
    }
    expect(db.prepare("SELECT count(*) FROM items WHERE is_milestone = 1").pluck().get()).toBeGreaterThan(0);
    // A task has a health as well as a project: the rebuilds carry both.
    expect(
      db.prepare("SELECT count(*) FROM items WHERE kind = 'task' AND health IS NOT NULL").pluck().get(),
    ).toBeGreaterThan(0);
    // And the items are a tree with more than one level under its top: a task in a project, and a task under it.
    expect(
      db
        .prepare(
          "SELECT count(*) FROM items c JOIN items p ON p.id = c.parent_id JOIN items top ON top.id = p.parent_id WHERE top.kind = 'project' AND p.kind = 'task' AND c.kind = 'task'",
        )
        .pluck()
        .get(),
    ).toBeGreaterThan(0);
  });

  it("has rows whose content is compared and not only counted: one changed value of one row shows", () => {
    // The control for the comparison itself.
    const { db, counts, columns, content } = filled();

    db.exec(
      "UPDATE operations SET rationale = 'lost' WHERE rowid = (SELECT min(rowid) FROM operations WHERE state = 'proposed')",
    );

    expect(rowCounts(db)).toEqual(counts);
    const now = contentOf(db, columns);
    expect(Object.keys(content).filter((table) => now[table] !== content[table])).toEqual(["operations"]);
  });

  it("adds a column and rebuilds the largest table, read from files, and loses no row", () => {
    const { db, backups, counts, columns, content } = filled();
    const migrations = readMigrations(folderOf(withSteps(ADD_COLUMN, REBUILD)));
    const [added, rebuilt] = migrations.slice(REAL.length) as [Migration, Migration];
    // The rebuild drops and brings back the triggers of the table, those of other tables that name
    // it, and the table's own indexes.
    const dropped = rebuilt.statements.filter((statement) => statement.startsWith("DROP TRIGGER"));
    expect(dropped.some((statement) => statement.startsWith("DROP TRIGGER operations_"))).toBe(true);
    expect(dropped.some((statement) => !statement.startsWith("DROP TRIGGER operations_"))).toBe(true);
    expect(rebuilt.statements.filter((statement) => statement.startsWith("CREATE TRIGGER"))).toHaveLength(
      dropped.length,
    );
    expect(rebuilt.statements.some((statement) => /^CREATE (UNIQUE )?INDEX /.test(statement))).toBe(true);
    // A rebuild that changes nothing leaves the fingerprint as it was; the new column had changed it.
    expect(rebuilt.schema).toBe(added.schema);
    expect(added.schema).not.toBe(HEAD.schema);
    const operations = db.prepare("SELECT id, state, kind, applied_at FROM operations ORDER BY id").all();

    const result = migrateDatabase(db, { migrations, snapshotDir: backups });

    expect(result.applied).toEqual([added.tag, rebuilt.tag]);
    expect(rowCounts(db)).toEqual(counts);
    // Every row of every table holds what it held, in the columns that were there before.
    expect(contentOf(db, columns)).toEqual(content);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(schemaFingerprint(db)).toBe(rebuilt.schema);
    expect(db.prepare("SELECT id, state, kind, applied_at FROM operations ORDER BY id").all()).toEqual(operations);
    expect(db.prepare("SELECT count(*) FROM operations WHERE note IS NOT NULL").pluck().get()).toBe(0);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);

    // One copy for the start, from before the first of the two: the old schema with every row.
    expect(snapshotsIn(backups)).toEqual([basename(result.snapshot ?? "")]);
    expect(basename(result.snapshot ?? "")).toMatch(new RegExp(`^before-${added.tag}-`));
    const copy = raw(result.snapshot ?? "", { readonly: true });
    expect(schemaFingerprint(copy)).toBe(HEAD.schema);
    expect(contentOf(copy)).toEqual(content);
    expect(recordedTags(copy)).toEqual(REAL_TAGS);
  });

  // The tables that most others point at, each rebuilt as a migration that changes a CHECK, a key
  // or NOT NULL would rebuild it. A rebuild that changes nothing is the control for one that does.
  it.each(["operations", "items", "persons"])(
    "rebuilds %s by the one procedure and leaves every row of every table, and the schema, as they were",
    (table) => {
      const { db, content } = filled();
      const migrations = withSteps({ words: `rebuild_${table}`, statements: (memory) => rebuildOf(memory, table) });

      migrateDatabase(db, { migrations, snapshotDir: null });

      expect(contentOf(db)).toEqual(content);
      expect(schemaFingerprint(db)).toBe(HEAD.schema);
      expect(migrations.at(-1)?.schema).toBe(HEAD.schema);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      // The table took its rows along, and the guards of the schema are on the new one.
      expect(() => db.exec("DELETE FROM operation_effects")).toThrow("operation_effects: effects are append-only");
      expect(() => db.exec("UPDATE items SET start_on_precision = 'week' WHERE start_on IS NULL")).toThrow(
        "items: a precision is about a day that is set",
      );
      // So are the two rules of the tree, each asked of a row that breaks no other rule.
      const { above, below, inAProject } = treeRowsOf(db);
      expect(() => db.prepare("UPDATE items SET parent_id = ? WHERE id = ?").run(below, above)).toThrow(
        "items: an item is not its own ancestor",
      );
      expect(() => db.prepare("UPDATE items SET kind = 'project' WHERE id = ?").run(inAProject)).toThrow(
        "items: a project has no parent",
      );
    },
  );

  it("restates the two triggers that hold the tree of items when it rebuilds items: the table itself holds neither rule", () => {
    const { db, backups, content } = filled();
    const [rebuild] = withSteps({
      words: "rebuild_items",
      statements: (memory) => rebuildOf(memory, "items"),
    }).slice(-1) as [Migration];
    const PAIR = ["items_hierarchy_insert", "items_hierarchy_update"];
    const bringsBack = (name: string) => (statement: string) => statement.startsWith(`CREATE TRIGGER ${name} `);
    // What the table has now: the pair is dropped with the other triggers that name items, and comes back.
    for (const name of PAIR) {
      expect(rebuild.statements).toContain(`DROP TRIGGER ${name}`);
      expect(rebuild.statements.filter(bringsBack(name))).toHaveLength(1);
    }
    // A rebuild written from memory that brings back everything but the pair. The table it leaves has
    // every column, key and CHECK of items, and no rule of the tree.
    const forgetful = {
      ...rebuild,
      statements: rebuild.statements.filter((statement) => !PAIR.some((name) => bringsBack(name)(statement))),
    };
    const { above, below } = treeRowsOf(db);

    const error = failure(() => migrateDatabase(db, { migrations: [...REAL, forgetful], snapshotDir: backups }));

    // The fingerprint is what notices: the manifest says what a rebuild of items has to leave.
    expect(error.problem).toBe("schema-drift");
    expect(error.facts).toEqual({ tag: rebuild.tag, whileMigrating: true });
    expect(schemaFingerprint(db)).toBe(HEAD.schema);
    expect(contentOf(db)).toEqual(content);
    // The control: let through past the runner, such a rebuild leaves a database in which an item
    // goes under the item below it, and neither check of SQLite has anything to say.
    db.pragma("foreign_keys = OFF");
    db.transaction(() => {
      for (const statement of forgetful.statements) db.prepare(statement).run();
    })();
    db.pragma("foreign_keys = ON");
    expect(db.prepare("UPDATE items SET parent_id = ? WHERE id = ?").run(below, above).changes).toBe(1);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("leaves the guards of the rebuilt table and of the tables around it in force", () => {
    const { db } = filled();
    // The rows the statements below are about, found by what they are: whatever wrote the rows, by
    // hand or by a generator, the test holds none of their identifiers.
    const one = (sql: string) => {
      const found = db.prepare(sql).pluck().get();
      expect(found, sql).toBeTypeOf("string");
      return found as string;
    };
    const applied = one("SELECT id FROM operations WHERE state = 'applied' AND run_id IS NOT NULL LIMIT 1");
    // Waiting for a decision, with nothing that depends on it and depending on nothing itself.
    const proposed = one(
      "SELECT id FROM operations WHERE state = 'proposed' AND id NOT IN (SELECT depends_on_id FROM operation_dependencies UNION SELECT operation_id FROM operation_dependencies) LIMIT 1",
    );
    const source = one("SELECT id FROM sources LIMIT 1");
    const item = one("SELECT id FROM items WHERE merged_into_id IS NULL LIMIT 1");
    // Each statement breaks one rule only, so that the rule that answers is the one that is named.
    const refusals: [statement: string, answer: string][] = [
      // On the rebuilt table itself.
      [
        `UPDATE operations SET rationale = 'rewritten' WHERE id = '${applied}'`,
        "operations: a decided operation is history",
      ],
      [`DELETE FROM operations WHERE id = '${applied}'`, "operations: only staged operations are deleted"],
      [`UPDATE operations SET state = 'undone' WHERE id = '${proposed}'`, "operations: illegal state transition"],
      [
        `UPDATE operations SET kind = 'other_kind' WHERE id = '${proposed}'`,
        "operations: what an operation is never changes",
      ],
      [
        "INSERT INTO operations (id, kind, origin, state, created_at, payload) VALUES ('opr_x', 'update_item', 'user', 'proposed', '2026-10-13T08:00:00.000Z', '{}')",
        "operations: an operation without a run is inserted as applied",
      ],
      // On other tables, by triggers whose text names the rebuilt one.
      [
        `INSERT INTO operation_effects (operation_id, entity_kind, entity_id, change, scrubbed) VALUES ('${proposed}', 'item', '${item}', 'touch', 0)`,
        "operation_effects: only an applied operation has effects",
      ],
      [
        `INSERT INTO operation_dependencies (operation_id, depends_on_id) VALUES ('${applied}', '${proposed}')`,
        "operation_dependencies: the edges of a decided operation are history",
      ],
      // The foreign keys that point at it, and the ones it has itself.
      [
        `INSERT INTO operation_dependencies (operation_id, depends_on_id) VALUES ('opr_nowhere', '${proposed}')`,
        "FOREIGN KEY constraint failed",
      ],
      [
        "INSERT INTO operations (id, kind, origin, state, approval, source_id, created_at, applied_at, payload) VALUES ('opr_y', 'update_item', 'user', 'applied', 'manual', 'cap_nowhere', '2026-10-13T08:00:00.000Z', '2026-10-13T08:00:00.000Z', '{}')",
        "FOREIGN KEY constraint failed",
      ],
    ];
    const answers = () =>
      refusals.map(([statement]) => {
        try {
          db.exec(statement);
        } catch (error) {
          return (error as Error).message;
        }
        return "accepted";
      });
    // The control: on the schema as the real migrations leave it, every one of them is refused with these words.
    const before = answers();
    for (const [at, [statement, answer]] of refusals.entries()) expect(before[at], statement).toContain(answer);
    const named = (type: string) =>
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = ? AND sql LIKE '%operations%' ORDER BY name")
        .pluck()
        .all(type);
    const [triggers, indexes] = [named("trigger"), named("index")];

    migrateDatabase(db, { migrations: withSteps(ADD_COLUMN, REBUILD), snapshotDir: null });

    expect(answers()).toEqual(before);
    expect(named("trigger")).toEqual(triggers);
    expect(named("index")).toEqual(indexes);
    // The date of last activity is still kept by the trigger on the effects: an operation later than all others.
    db.exec(
      "INSERT INTO operations (id, kind, origin, state, approval, created_at, applied_at, payload) VALUES ('opr_late', 'update_item', 'user', 'applied', 'manual', '2099-01-01T08:00:00.000Z', '2099-01-01T08:00:00.000Z', '{}')",
    );
    db.exec(
      `INSERT INTO operation_effects (operation_id, entity_kind, entity_id, change, item_id, scrubbed) VALUES ('opr_late', 'item', '${item}', 'touch', '${item}', 0)`,
    );
    expect(db.prepare("SELECT last_activity_at FROM items WHERE id = ?").pluck().get(item)).toBe(
      "2099-01-01T08:00:00.000Z",
    );
    // A run that ends without being committed still takes along what it staged: a trigger on runs.
    db.exec(
      `INSERT INTO runs (id, kind, state, source_id, started_at) VALUES ('run_late', 'process_capture', 'running', '${source}', '2099-01-01T09:00:00.000Z')`,
    );
    db.exec(
      `INSERT INTO operations (id, run_id, seq, kind, origin, state, source_id, created_at, payload) VALUES ('opr_staged', 'run_late', 1, 'link_source', 'inference', 'staged', '${source}', '2099-01-01T09:00:01.000Z', '{}')`,
    );
    db.exec(
      "UPDATE runs SET state = 'failed', ended_at = '2099-01-01T09:00:02.000Z', error_code = 'interrupted' WHERE id = 'run_late'",
    );
    expect(db.prepare("SELECT count(*) FROM operations WHERE id = 'opr_staged'").pluck().get()).toBe(0);
    // And the new column takes a value on a row that is history: it is no part of what the guard protects.
    expect(() => db.prepare("UPDATE operations SET note = 'x' WHERE id = ?").run(applied)).not.toThrow();
  });

  it("would have lost the guards without the fingerprint: a rebuild that forgets a trigger is refused and undone", () => {
    const { db, backups, counts } = filled();
    const forgetful: Step = {
      words: "rebuild_operations",
      // The last statement brings a trigger back; a migration written from memory leaves one out.
      statements: (memory) => rebuildOf(memory, "operations").slice(0, -1),
    };
    const careless = withSteps(forgetful);
    const complete = withSteps({
      words: "rebuild_operations",
      statements: (memory) => rebuildOf(memory, "operations"),
    });
    // The manifest says what a rebuild has to leave; the careless one leaves something else.
    const migrations = [...REAL, { ...(careless.at(-1) as Migration), schema: (complete.at(-1) as Migration).schema }];

    const error = failure(() => migrateDatabase(db, { migrations, snapshotDir: backups }));

    expect(error.problem).toBe("schema-drift");
    expect(error.facts).toEqual({ tag: tagAt(REAL.length + 1, "rebuild_operations"), whileMigrating: true });
    // Neither check that SQLite offers would have seen it.
    expect(schemaFingerprint(db)).toBe(HEAD.schema);
    expect(rowCounts(db)).toEqual(counts);
    expect(recordedTags(db)).toEqual(REAL_TAGS);
    expect(snapshotsIn(backups)).toEqual([]);
  });

  it("keeps the rows that point at a rebuilt table, which a rebuild with foreign keys on would delete or refuse", () => {
    const { db, counts } = filled();
    const before = db.prepare("SELECT operation_id, depends_on_id FROM operation_dependencies").all();

    migrateDatabase(db, { migrations: withSteps(REBUILD), snapshotDir: null });

    expect(db.prepare("SELECT operation_id, depends_on_id FROM operation_dependencies").all()).toEqual(before);
    expect(rowCounts(db).operation_effects).toBe(counts.operation_effects);
  });
});

describe("the copy made before a migration", () => {
  const STEPS = ["one", "two", "three", "four", "five", "six"] as const;
  /** A clock that is a second later at every look. */
  function ticking(): () => Date {
    let time = Date.parse("2026-10-11T12:00:00.000Z");
    return () => {
      time += 1_000;
      return new Date(time);
    };
  }

  it("is made once for every start that migrates, and each holds the database without that start's own step", () => {
    const { db, backups } = current();
    const steps = STEPS.slice(0, 3);
    const all = withSteps(...steps.map(tableStep));
    const now = ticking();

    // Three starts, each of a version with one migration more.
    for (let known = REAL.length + 1; known <= all.length; known++) {
      migrateDatabase(db, { migrations: all.slice(0, known), snapshotDir: backups, now });
    }

    const names = snapshotsIn(backups);
    expect(names).toEqual([
      `before-${tagAt(REAL.length + 1, "one")}-20261011T120001000Z.sqlite`,
      `before-${tagAt(REAL.length + 2, "two")}-20261011T120002000Z.sqlite`,
      `before-${tagAt(REAL.length + 3, "three")}-20261011T120003000Z.sqlite`,
    ]);
    names.forEach((name, position) => {
      const copy = raw(join(backups, name), { readonly: true });
      // The steps before it are in it; its own and the later ones are not.
      expect(steps.map((step) => hasTable(copy, step))).toEqual(steps.map((_step, at) => at < position));
      expect(recordedTags(copy)).toEqual(all.slice(0, REAL.length + position).map(({ tag }) => tag));
      expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
    });
    // The record names, for every migration, the copy made before the start that applied it.
    expect(
      recorded(db)
        .slice(REAL.length)
        .map(({ snapshot }) => snapshot),
    ).toEqual(names);
  });

  it("is one for a start that applies several migrations, named for the first of them", () => {
    const { db, backups } = current();
    const all = withSteps(tableStep("one"), tableStep("two"));

    const { applied, snapshot } = migrateDatabase(db, { migrations: all, snapshotDir: backups, now: ticking() });

    expect(applied).toEqual([tagAt(REAL.length + 1, "one"), tagAt(REAL.length + 2, "two")]);
    expect(snapshotsIn(backups)).toEqual([`before-${tagAt(REAL.length + 1, "one")}-20261011T120001000Z.sqlite`]);
    expect(
      recorded(db)
        .slice(REAL.length)
        .map((row) => row.snapshot),
    ).toEqual([basename(snapshot ?? ""), basename(snapshot ?? "")]);
  });

  it("is not made, and nothing is written at all, at a start with nothing to apply", () => {
    const { dir, file, backups, db } = current();
    // Something in the log beside the file: a start that folded it in, or wrote, would show.
    db.exec(
      "INSERT INTO persons (id, name, name_norm, is_me, created_at) VALUES ('per_me', 'Ja', 'ja', 1, '2026-10-12T09:00:00.000Z')",
    );
    const watching = raw(file);
    const state = () => ({
      entries: readdirSync(dir).sort(),
      changed: statSync(file).mtimeMs,
      log: statSync(`${file}-wal`).size,
      version: watching.pragma("data_version", { simple: true }),
    });
    const before = state();
    expect(before.log).toBeGreaterThan(0);

    expect(migrateDatabase(db, { snapshotDir: backups })).toEqual({ applied: [], snapshot: null });

    expect(state()).toEqual(before);
    expect(existsSync(backups)).toBe(false);
  });

  it("is for the owner alone, in a directory for the owner alone, whatever the shell allows", () => {
    process.umask(0o022);
    const { backups, db } = current();

    const { snapshot } = migrateDatabase(db, { migrations: withSteps(tableStep("one")), snapshotDir: backups });

    expect(mode(backups)).toBe("700");
    expect(mode(snapshot ?? "")).toBe("600");
    expect(snapshotsIn(backups)).toHaveLength(1);
  });

  it("is removed again when the start fails: the database is what it was", () => {
    const { backups, db } = current();
    const failing = followedBy(REAL, "broken", [
      "CREATE TABLE half (x INTEGER) STRICT",
      "INSERT INTO nowhere VALUES (1)",
    ]);

    expect(failure(() => migrateDatabase(db, { migrations: failing, snapshotDir: backups })).problem).toBe(
      "statement-failed",
    );

    expect(snapshotsIn(backups)).toEqual([]);
  });

  it("never takes the place of a copy that is already there", () => {
    const { backups, db } = current();
    const all = withSteps(tableStep("one"));
    const name = `before-${tagAt(REAL.length + 1, "one")}-20261011T120000000Z.sqlite`;
    mkdirSync(backups);
    writeFileSync(join(backups, name), "an earlier copy");

    const error = failure(() =>
      migrateDatabase(db, { migrations: all, snapshotDir: backups, now: () => new Date("2026-10-11T12:00:00.000Z") }),
    );

    expect(error.problem).toBe("snapshot-failed");
    expect(error.facts).toEqual({ code: "EEXIST" });
    expect(readFileSync(join(backups, name), "utf8")).toBe("an earlier copy");
    expect(snapshotsIn(backups)).toEqual([name]);
    // Without a copy no migration begins.
    expect(recordedTags(db)).toEqual(REAL_TAGS);
    expect(hasTable(db, "one")).toBe(false);
  });

  it("stays as the five newest: the older ones go once a migration has succeeded", () => {
    const { backups, db } = current();
    const all = withSteps(...STEPS.map(tableStep));
    const now = ticking();

    for (let known = REAL.length + 1; known <= all.length; known++) {
      migrateDatabase(db, { migrations: all.slice(0, known), snapshotDir: backups, now });
    }

    // Six starts migrated; the copy from before the first of them is gone.
    expect(snapshotsIn(backups)).toEqual(
      STEPS.slice(1).map(
        (step, at) => `before-${tagAt(REAL.length + 2 + at, step)}-20261011T12000${2 + at}000Z.sqlite`,
      ),
    );
  });

  it("goes by the migration first and by the time second when it picks the newest", () => {
    const { backups, db } = current();
    const all = withSteps(tableStep("one"), tableStep("two"));
    // The clock was set back between the two starts: the later migration has the earlier time.
    migrateDatabase(db, {
      migrations: all.slice(0, -1),
      snapshotDir: backups,
      now: () => new Date("2026-10-11T12:00:00.000Z"),
    });
    migrateDatabase(db, {
      migrations: all,
      snapshotDir: backups,
      now: () => new Date("2026-10-01T12:00:00.000Z"),
      keepSnapshots: 1,
    });

    expect(snapshotsIn(backups)).toEqual([`before-${tagAt(REAL.length + 2, "two")}-20261001T120000000Z.sqlite`]);
  });

  it("keeps as many as it is told, and leaves alone what is no copy of its own making", () => {
    const { backups, db } = current();
    const all = withSteps(...STEPS.slice(0, 3).map(tableStep));
    mkdirSync(backups);
    for (const name of ["notes.txt", "before-my-own-experiment.sqlite", "hubber-2026-10-01.sqlite"]) {
      writeFileSync(join(backups, name), "kept by the owner");
    }
    const now = ticking();

    for (let known = REAL.length + 1; known <= all.length; known++) {
      migrateDatabase(db, { migrations: all.slice(0, known), snapshotDir: backups, now, keepSnapshots: 2 });
    }

    expect(snapshotsIn(backups)).toEqual([
      `before-${tagAt(REAL.length + 2, "two")}-20261011T120002000Z.sqlite`,
      `before-${tagAt(REAL.length + 3, "three")}-20261011T120003000Z.sqlite`,
      "before-my-own-experiment.sqlite",
      "hubber-2026-10-01.sqlite",
      "notes.txt",
    ]);
  });

  it("keeps the copy of this start whatever its name sorts like, and beside it the newest of the others", () => {
    const { file, backups } = pinOnly();
    const db = open(file);
    mkdirSync(backups);
    // Copies from before five later migrations: the database was at a later version once, and an
    // older file of it was put back since. By name each of them is newer than the copy of this start.
    const later = [1, 2, 3, 4, 5].map(
      (step) => `before-${tagAt(REAL.length + step, "later")}-20260101T000000000Z.sqlite`,
    );
    for (const name of later) snapshotWorkspaceDatabase(db, join(backups, name));

    const { snapshot } = migrateDatabase(db, { snapshotDir: backups });

    // Five in all, as told: the one that goes is the oldest of the others.
    expect(snapshotsIn(backups)).toEqual([basename(snapshot ?? ""), ...later.slice(1)]);
    // What the start says of its copy is true: the file is there, and the record names it.
    expect(existsSync(snapshot ?? "")).toBe(true);
    expect(new Set(recorded(db).map((row) => row.snapshot))).toEqual(new Set([basename(snapshot ?? "")]));
  });

  it("keeps its own copy also when it is told to keep none", () => {
    const { backups, db } = current();
    const all = withSteps(tableStep("one"), tableStep("two"));
    const now = ticking();
    migrateDatabase(db, { migrations: all.slice(0, -1), snapshotDir: backups, now });

    const { snapshot } = migrateDatabase(db, { migrations: all, snapshotDir: backups, now, keepSnapshots: 0 });

    expect(snapshotsIn(backups)).toEqual([basename(snapshot ?? "")]);
  });

  it("goes on past an entry that it cannot remove", () => {
    const { backups, db } = current();
    const all = withSteps(tableStep("one"));
    mkdirSync(backups);
    // A directory under the name of a copy, which sorts first: removing it fails.
    const inTheWay = "before-0000_a-20200101T000000000Z.sqlite";
    mkdirSync(join(backups, inTheWay));
    const older = [1, 2, 3].map((day) => `before-${REAL_TAGS[0]}-2026010${day}T000000000Z.sqlite`);
    for (const name of older) snapshotWorkspaceDatabase(db, join(backups, name));

    const { snapshot } = migrateDatabase(db, { migrations: all, snapshotDir: backups, keepSnapshots: 2 });

    // Two copies as told, this start's and the newest other one; the entry that could not go is still there.
    expect(snapshotsIn(backups)).toEqual([inTheWay, older[2], basename(snapshot ?? "")]);
  });

  it("makes a directory for the copies that was there already the owner's alone", () => {
    process.umask(0o022);
    const { backups, db } = current();
    mkdirSync(backups);
    expect(mode(backups)).toBe("755");

    migrateDatabase(db, { migrations: withSteps(tableStep("one")), snapshotDir: backups });

    expect(mode(backups)).toBe("700");
  });

  it("is made also in a directory whose mode the system does not let it change, and is the owner's alone there too", () => {
    process.umask(0o022);
    const { backups, db } = current();
    mkdirSync(backups);
    // What a link in the place of the directory can lead to: a directory that the user may write
    // to and that belongs to somebody else.
    disk.notTheUsersOwn = backups;

    const { applied, snapshot } = migrateDatabase(db, {
      migrations: withSteps(tableStep("one")),
      snapshotDir: backups,
    });

    expect(applied).toEqual([tagAt(REAL.length + 1, "one")]);
    expect(snapshotsIn(backups)).toEqual([basename(snapshot ?? "")]);
    // The directory is as it was. The copy is created private, whatever the directory allows.
    expect(mode(backups)).toBe("755");
    expect(mode(snapshot ?? "")).toBe("600");
  });

  // Accepted as it is: the directory of the workspace may itself be reached through a link, to
  // another volume for one, and the place of the copies is treated no differently.
  it("follows a link in the place of the directory for the copies: they go where it leads", () => {
    const { dir, backups, db } = current();
    const elsewhere = join(dir, "copies-elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, backups);

    const { snapshot } = migrateDatabase(db, { migrations: withSteps(tableStep("one")), snapshotDir: backups });

    expect(readdirSync(elsewhere)).toEqual([basename(snapshot ?? "")]);
    expect(mode(elsewhere)).toBe("700");
  });

  describe("after starts that never committed", () => {
    /** Makes a file look as if nothing had written to it for that long. */
    function age(path: string, seconds: number): void {
      const then = new Date(Date.now() - seconds * 1_000);
      utimesSync(path, then, then);
    }
    /** A whole copy of the database as it is now, under the name a start would give it. */
    function copyAsAStartMakesIt(db: WorkspaceDatabase, backups: string, name: string): void {
      snapshotWorkspaceDatabase(db, join(backups, name));
    }
    const addPerson = (db: WorkspaceDatabase, id: string, name: string) =>
      db
        .prepare(
          "INSERT INTO persons (id, name, name_norm, is_me, created_at) VALUES (?, ?, ?, 0, '2026-10-12T09:00:00.000Z')",
        )
        .run(id, name, name.toLowerCase());
    /** The names of the persons in a copy. */
    function personsIn(copy: string): unknown[] {
      return raw(copy, { readonly: true }).prepare("SELECT name FROM persons ORDER BY name").pluck().all();
    }

    it("clears their copies of the very state that this start copies again, and every copy that was cut short", () => {
      const { backups, db } = current();
      const all = withSteps(tableStep("one"), tableStep("two"));
      const pendingTag = tagAt(REAL.length + 1, "one");
      mkdirSync(backups);
      const left = {
        // A copy under the same name that holds another state: the database has changed since.
        ofAnotherState: `before-${pendingTag}-20261011T100000000Z.sqlite`,
        // A start that was killed after its copy: whole, and of the state the database is still in.
        whole: `before-${pendingTag}-20261011T110000000Z.sqlite`,
        // Starts that were killed during the copy: long ago, and a moment ago.
        cutShort: `before-${pendingTag}-20261011T110100000Z.sqlite.partial`,
        itsJournal: `before-${pendingTag}-20261011T110100000Z.sqlite.partial-journal`,
        cutShortJustNow: `before-${pendingTag}-20261011T115959000Z.sqlite.partial`,
        // The copy from before a migration that has long been applied: the way back to that state.
        earlier: `before-${REAL_TAGS[0]}-20261001T080000000Z.sqlite`,
        ownersFile: "notes.partial",
      };
      copyAsAStartMakesIt(open(pinOnly().file), backups, left.earlier);
      copyAsAStartMakesIt(db, backups, left.ofAnotherState);
      addPerson(db, "per_anna", "Anna");
      copyAsAStartMakesIt(db, backups, left.whole);
      for (const name of [left.cutShort, left.itsJournal, left.cutShortJustNow, left.ownersFile]) {
        writeFileSync(join(backups, name), "left behind");
      }
      age(join(backups, left.cutShort), 90);
      age(join(backups, left.itsJournal), 90);
      age(join(backups, left.ownersFile), 3_600);

      const { snapshot } = migrateDatabase(db, { migrations: all, snapshotDir: backups });

      expect(snapshotsIn(backups)).toEqual(
        [left.earlier, left.ofAnotherState, basename(snapshot ?? ""), left.ownersFile].sort(),
      );
      // Nothing of the owner's is gone: the state that was copied twice is still there once.
      expect(personsIn(join(backups, left.ofAnotherState))).toEqual([]);
      expect(personsIn(snapshot ?? "")).toEqual(["Anna"]);
    });

    it("compares a copy with its own to the last byte: one that differs only far behind its beginning stays", () => {
      const { backups, db } = current();
      const all = withSteps(tableStep("one"));
      // Rows for copies of several megabytes: a copy is read piece by piece, and a piece is a megabyte.
      const person = db.prepare(
        "INSERT INTO persons (id, name, name_norm, is_me, created_at, note) VALUES (?, ?, ?, 0, '2026-10-12T09:00:00.000Z', ?)",
      );
      db.transaction(() => {
        for (let number = 1; number <= 3_000; number++) {
          person.run(`per_n${String(number).padStart(4, "0")}`, `Osoba ${number}`, `osoba ${number}`, "x".repeat(900));
        }
      })();
      mkdirSync(backups);
      const earlier = `before-${tagAt(REAL.length + 1, "one")}-20261011T100000000Z.sqlite`;
      copyAsAStartMakesIt(db, backups, earlier);
      // One letter of the row that was written last: as many pages as before, and another state.
      db.exec("UPDATE persons SET note = 'y' || substr(note, 2) WHERE id = (SELECT max(id) FROM persons)");

      const { snapshot } = migrateDatabase(db, { migrations: all, snapshotDir: backups });

      expect(snapshotsIn(backups)).toEqual([earlier, basename(snapshot ?? "")]);
      // The control: the two copies are of one size and differ, and not within their first two megabytes.
      const [one, other] = [readFileSync(join(backups, earlier)), readFileSync(snapshot ?? "")];
      expect(one.length).toBe(other.length);
      expect(one.equals(other)).toBe(false);
      expect(one.subarray(0, 2 << 20).equals(other.subarray(0, 2 << 20))).toBe(true);
    });

    it("clears both names of a copy whose start was killed between giving it its name and taking the first one away", () => {
      const { backups, db } = current();
      const all = withSteps(tableStep("one"));
      mkdirSync(backups);
      // One file under two names: the name of the copy in the making, and the name of the whole copy.
      const whole = `before-${tagAt(REAL.length + 1, "one")}-20261011T110000000Z.sqlite`;
      copyAsAStartMakesIt(db, backups, whole);
      linkSync(join(backups, whole), join(backups, `${whole}.partial`));

      const { snapshot } = migrateDatabase(db, { migrations: all, snapshotDir: backups });

      expect(snapshotsIn(backups)).toEqual([basename(snapshot ?? "")]);
    });

    it("clears an empty file under the name of a copy, whatever migration it names: it holds no state, and would be kept in the place of a copy", () => {
      const { backups, db } = current();
      const all = withSteps(tableStep("one"));
      mkdirSync(backups);
      const real = [1, 2, 3, 4].map((day) => `before-${REAL_TAGS[0]}-2026090${day}T100000000Z.sqlite`);
      for (const name of real) copyAsAStartMakesIt(db, backups, name);
      // What a start leaves that is killed where the file system has no hard links, between taking
      // the name of its copy and moving the copy there. By name each is newer than every real copy.
      const empty = [3, 4, 5, 6, 7].map(
        (step) => `before-${tagAt(REAL.length + step, "later")}-20260101T000000000Z.sqlite`,
      );
      for (const name of empty) writeFileSync(join(backups, name), "");
      // An empty file of the owner's own naming is not the runner's to judge.
      const ownersFile = "before-my-own-experiment.sqlite";
      writeFileSync(join(backups, ownersFile), "");

      const { snapshot } = migrateDatabase(db, { migrations: all, snapshotDir: backups });

      // Five are kept, and all five are copies: the start's own and the four from before.
      expect(snapshotsIn(backups)).toEqual([...real, basename(snapshot ?? ""), ownersFile].sort());
      for (const name of real) expect(statSync(join(backups, name)).size, name).toBeGreaterThan(0);
    });

    it("leaves a file under the name of a copy that holds anything at all, and a link under such a name, wherever it leads", () => {
      const { dir, backups, db } = current();
      const all = withSteps(tableStep("one"));
      mkdirSync(backups);
      // One byte is a state that exists nowhere else, as far as the runner can tell.
      const oneByte = `before-${tagAt(REAL.length + 3, "later")}-20260101T000000000Z.sqlite`;
      writeFileSync(join(backups, oneByte), "x");
      // A link is the doing of its owner, also when the file it leads to is empty.
      const emptyElsewhere = join(dir, "empty-elsewhere");
      writeFileSync(emptyElsewhere, "");
      const link = `before-${tagAt(REAL.length + 4, "later")}-20260101T000000000Z.sqlite`;
      symlinkSync(emptyElsewhere, join(backups, link));

      // Room for all three: what is gone afterwards was cleared, and not pushed out by newer copies.
      const { snapshot } = migrateDatabase(db, { migrations: all, snapshotDir: backups, keepSnapshots: 10 });

      expect(snapshotsIn(backups)).toEqual([basename(snapshot ?? ""), oneByte, link].sort());
      expect(readFileSync(join(backups, oneByte), "utf8")).toBe("x");
      expect(existsSync(emptyElsewhere)).toBe(true);
    });

    it("clears such an empty file also at a start that then fails, and leaves the copies as they were", () => {
      const { backups, db } = current();
      const failing = followedBy(REAL, "broken", ["INSERT INTO nowhere VALUES (1)"]);
      mkdirSync(backups);
      const earlier = `before-${REAL_TAGS[0]}-20261001T080000000Z.sqlite`;
      copyAsAStartMakesIt(open(pinOnly().file), backups, earlier);
      // The name of the copy of a start that was killed before its copy got there.
      writeFileSync(join(backups, `before-${tagAt(REAL.length + 1, "broken")}-20261011T110000000Z.sqlite`), "");

      failure(() => migrateDatabase(db, { migrations: failing, snapshotDir: backups }));

      expect(snapshotsIn(backups)).toEqual([earlier]);
    });

    it("leaves no copy of that state at all when it then fails itself: the database still is that state", () => {
      const { backups, db } = current();
      const failing = followedBy(REAL, "broken", ["INSERT INTO nowhere VALUES (1)"]);
      mkdirSync(backups);
      const earlier = `before-${REAL_TAGS[0]}-20261001T080000000Z.sqlite`;
      copyAsAStartMakesIt(open(pinOnly().file), backups, earlier);
      copyAsAStartMakesIt(db, backups, `before-${tagAt(REAL.length + 1, "broken")}-20261011T110000000Z.sqlite`);

      failure(() => migrateDatabase(db, { migrations: failing, snapshotDir: backups }));

      // The leftover went while the start had the database; the start's own copy went when it failed.
      expect(snapshotsIn(backups)).toEqual([earlier]);
    });

    it("keeps a copy that holds more than the database: an older file of the database was put back", () => {
      const { dir, file, backups, db } = current();
      const all = withSteps(tableStep("one"));
      addPerson(db, "per_anna", "Anna");
      db.close();
      // The owner's own backup of last week: the one file of a database that was closed.
      const lastWeek = join(dir, "last-week.sqlite");
      copyFileSync(file, lastWeek);
      const later = open(file);
      addPerson(later, "per_bartek", "Bartek");
      const now = ticking();
      // The next version migrates: its copy holds both persons.
      const first = migrateDatabase(later, { migrations: all, snapshotDir: backups, now });
      later.close();
      expect(personsIn(first.snapshot ?? "")).toEqual(["Anna", "Bartek"]);

      // Last week's file goes back in the place of the database, and the same version starts again.
      copyFileSync(lastWeek, file);
      const second = migrateDatabase(open(file), { migrations: all, snapshotDir: backups, now });

      // Both copies are named for the same migration. The first is the only place that still has Bartek.
      expect(snapshotsIn(backups)).toEqual([basename(first.snapshot ?? ""), basename(second.snapshot ?? "")]);
      expect(personsIn(first.snapshot ?? "")).toEqual(["Anna", "Bartek"]);
      expect(personsIn(second.snapshot ?? "")).toEqual(["Anna"]);
    });

    it("keeps the copy of a start whose migration ended the transaction, when the next start copies what that left", () => {
      const { backups, db } = current();
      addPerson(db, "per_anna", "Anna");
      // Not from a file: readMigrations() refuses such a statement. A list that is handed in can hold it.
      const migrations = followedBy(REAL, "cut_short", [
        "UPDATE persons SET name = 'Zmieniona'",
        "COMMIT",
        "CREATE TABLE rest (x INTEGER) STRICT",
      ]);
      const now = ticking();
      failure(() => migrateDatabase(db, { migrations, snapshotDir: backups, now }));
      const [kept] = snapshotsIn(backups);
      expect(personsIn(join(backups, kept ?? ""))).toEqual(["Anna"]);

      failure(() => migrateDatabase(db, { migrations, snapshotDir: backups, now }));

      // The only place that still has the name as it was.
      const copies = snapshotsIn(backups);
      expect(copies).toHaveLength(2);
      expect(copies[0]).toBe(kept);
      expect(copies.map((name) => personsIn(join(backups, name)))).toEqual([["Anna"], ["Zmieniona"]]);
    });

    it("does not count them among the copies it keeps: a start that fails takes none of the older ones away", () => {
      const { backups, db } = current();
      const all = withSteps(tableStep("one"), tableStep("two"));
      migrateDatabase(db, {
        migrations: all.slice(0, -1),
        snapshotDir: backups,
        now: () => new Date("2026-10-11T12:00:00.000Z"),
      });
      const kept = snapshotsIn(backups);
      const failing = followedBy(all.slice(0, -1), "broken", ["INSERT INTO nowhere VALUES (1)"]);

      failure(() => migrateDatabase(db, { migrations: failing, snapshotDir: backups, keepSnapshots: 0 }));

      expect(snapshotsIn(backups)).toEqual(kept);
    });
  });
});

describe("migrateDatabase refuses", () => {
  /**
   * What a refused start must leave as it was: what the database holds, what lies beside it, and
   * the connection. "fromOutside" adds a second connection that sees every commit of the first.
   * Only for a start that is refused before it takes the database for itself: a second connection
   * is exactly what keeps a start from taking it.
   */
  function watch({ dir, file, backups }: Place, db: WorkspaceDatabase, { fromOutside = false } = {}) {
    const outside = fromOutside ? raw(file) : undefined;
    const state = () => ({
      schema: schemaFingerprint(db),
      recorded: recorded(db),
      rows: rowCounts(db),
      version: outside?.pragma("data_version", { simple: true }),
      entries: readdirSync(dir).sort(),
      copies: snapshotsIn(backups),
      foreignKeys: db.pragma("foreign_keys", { simple: true }),
      locking: db.pragma("locking_mode", { simple: true }),
      inTransaction: db.inTransaction,
    });
    return { before: state(), state };
  }

  describe("a database from a newer version", () => {
    it("with the last migration of both, and with the copy from before the first one this code lacks", () => {
      const place = current();
      const all = withSteps(tableStep("one"), tableStep("two"));
      migrateDatabase(place.db, {
        migrations: all.slice(0, -1),
        snapshotDir: place.backups,
        now: () => new Date("2026-10-11T12:00:00.000Z"),
      });
      migrateDatabase(place.db, {
        migrations: all,
        snapshotDir: place.backups,
        now: () => new Date("2026-10-11T13:00:00.000Z"),
      });
      const { before, state } = watch(place, place.db, { fromOutside: true });
      const announced: string[][] = [];

      const error = failure(() =>
        migrateDatabase(place.db, { snapshotDir: place.backups, onPending: ({ pending }) => announced.push(pending) }),
      );

      expect(error.problem).toBe("newer");
      expect(error.facts).toEqual({
        databaseTag: tagAt(REAL.length + 2, "two"),
        codeTag: HEAD.tag,
        snapshot: `before-${tagAt(REAL.length + 1, "one")}-20261011T120000000Z.sqlite`,
      });
      expect(state()).toEqual(before);
      expect(announced).toEqual([]);
    });

    it("without a copy to name when the newer version created the database", () => {
      const { db } = current(withSteps(tableStep("one")));

      const error = failure(() => migrateDatabase(db, { snapshotDir: null }));

      expect(error.facts).toEqual({ databaseTag: tagAt(REAL.length + 1, "one"), codeTag: HEAD.tag });
    });

    it("also for a code that has no migration at all", () => {
      const { db } = current();

      expect(failure(() => migrateDatabase(db, { migrations: [], snapshotDir: null })).facts).toEqual({
        databaseTag: HEAD.tag,
      });
    });
  });

  describe("a database with another history", () => {
    it.each<[string, (migration: Migration) => Migration]>([
      ["a migration that was edited after it was applied", (migration) => ({ ...migration, sha256: "0".repeat(64) })],
      [
        "another migration in the place of one it has had",
        (migration) => ({ ...migration, tag: tagAt(migration.index, "other") }),
      ],
    ])("where the code has %s", (_what, change) => {
      const place = current();
      const { before, state } = watch(place, place.db, { fromOutside: true });
      const migrations = [...REAL.slice(0, -1), change(HEAD)];

      const error = failure(() => migrateDatabase(place.db, { migrations, snapshotDir: place.backups }));

      expect(error.problem).toBe("diverged");
      // The one the database recorded.
      expect(error.facts).toEqual({ tag: HEAD.tag });
      expect(state()).toEqual(before);
    });

    it("before it looks at what would be pending, and before it says that the database is newer", () => {
      const { db, backups } = current(withSteps(tableStep("one")));
      const edited = [...REAL.slice(0, -1), { ...HEAD, sha256: "0".repeat(64) }];

      expect(failure(() => migrateDatabase(db, { migrations: edited, snapshotDir: backups })).problem).toBe("diverged");
    });

    it("whose record counts differently", () => {
      const place = current();
      const outside = raw(place.file);
      outside.prepare(`UPDATE ${MIGRATIONS_TABLE} SET idx = idx + 10`).run();
      outside.close();

      expect(failure(() => migrateDatabase(place.db, { snapshotDir: place.backups })).problem).toBe("diverged");
    });
  });

  describe("a schema that is not the one the migrations leave", () => {
    it.each([
      ["a trigger was dropped", (name: string) => `DROP TRIGGER ${name}`, "trigger"],
      ["an index was dropped", (name: string) => `DROP INDEX ${name}`, "index"],
    ])("at a start with nothing to apply, when %s", (_what, damage, type) => {
      const place = current();
      const name = place.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = ? AND sql IS NOT NULL AND tbl_name NOT IN ('workspace_pin') LIMIT 1",
        )
        .pluck()
        .get(type) as string;
      const outside = raw(place.file);
      outside.exec(damage(name));
      // What the two checks of SQLite make of it: nothing.
      expect(outside.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(outside.pragma("foreign_key_check")).toEqual([]);
      outside.close();
      const { before, state } = watch(place, place.db, { fromOutside: true });

      const error = failure(() => migrateDatabase(place.db, { snapshotDir: place.backups }));

      expect(error.problem).toBe("schema-drift");
      expect(error.facts).toEqual({ tag: HEAD.tag, whileMigrating: false });
      expect(state()).toEqual(before);
    });

    it("at a start with nothing to apply, when a table was added past the migrations", () => {
      const { db, backups } = current();
      db.exec("CREATE TABLE scratch (x INTEGER) STRICT");

      expect(failure(() => migrateDatabase(db, { snapshotDir: backups })).problem).toBe("schema-drift");
    });

    it("after a migration that leaves another schema than its manifest entry says, and takes the migration back", () => {
      const place = current();
      const { before, state } = watch(place, place.db);
      const [step] = withSteps(tableStep("one")).slice(-1) as [Migration];
      const migrations = [
        ...REAL,
        { ...step, schema: HEAD.schema },
        ...followedBy([...REAL, step], "two", ["CREATE TABLE two (x INTEGER) STRICT"]).slice(-1),
      ];

      const error = failure(() => migrateDatabase(place.db, { migrations, snapshotDir: place.backups }));

      expect(error.problem).toBe("schema-drift");
      expect(error.facts).toEqual({ tag: step.tag, whileMigrating: true });
      // The directory for the copies stays; the copy does not.
      expect(state()).toEqual({ ...before, entries: [...before.entries, "backups"].sort() });
      expect(hasTable(place.db, "one")).toBe(false);
    });

    it("before a migration that is pending, when the damage was there before the start: nothing is begun", () => {
      const place = current();
      const name = place.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name <> 'workspace_pin' LIMIT 1")
        .pluck()
        .get() as string;
      place.db.exec(`DROP TRIGGER ${name}`);
      const { before, state } = watch(place, place.db, { fromOutside: true });
      const announced: string[][] = [];

      const error = failure(() =>
        migrateDatabase(place.db, {
          migrations: withSteps(tableStep("one")),
          snapshotDir: place.backups,
          onPending: ({ pending }) => announced.push(pending),
        }),
      );

      // The schema is not the one that the last migration it has had leaves: no fault of the one that waits.
      expect(error.problem).toBe("schema-drift");
      expect(error.facts).toEqual({
        tag: HEAD.tag,
        whileMigrating: false,
        pendingTag: tagAt(REAL.length + 1, "one"),
      });
      // Found before the owner was told of an update, before the database was taken, and before any copy.
      expect(announced).toEqual([]);
      expect(state()).toEqual(before);
    });

    it("before the first migration, when the database holds what the application did not make", () => {
      const place = pinOnly();
      const outside = raw(place.file);
      outside.exec("CREATE TABLE notatki_wlasne (x TEXT)");
      outside.close();
      const db = open(place.file);
      const { before, state } = watch(place, db, { fromOutside: true });
      const announced: string[][] = [];

      const error = failure(() =>
        migrateDatabase(db, { snapshotDir: place.backups, onPending: ({ pending }) => announced.push(pending) }),
      );

      expect(error.problem).toBe("schema-drift");
      // No migration to name: the database has had none.
      expect(error.facts).toEqual({ whileMigrating: false, pendingTag: REAL_TAGS[0] });
      expect(announced).toEqual([]);
      expect(state()).toEqual(before);
    });

    it("not for what the other layers keep in the file, and not for a database that holds nothing yet", () => {
      // The control for the two tests above: the pin alone is no difference, and neither is the record of migrations.
      const { file, backups } = pinOnly();
      const db = open(file);

      expect(migrateDatabase(db, { snapshotDir: backups }).applied).toEqual(REAL_TAGS);
      expect(
        migrateDatabase(db, { migrations: withSteps(tableStep("one")), snapshotDir: backups }).applied,
      ).toHaveLength(1);
    });
  });

  describe("a migration with a statement that fails", () => {
    it("and takes back everything that was pending, also the migrations before it", () => {
      const place = current();
      place.db.exec(
        "INSERT INTO persons (id, name, name_norm, is_me, created_at) VALUES ('per_me', 'Ja', 'ja', 1, '2026-10-12T09:00:00.000Z')",
      );
      const { before, state } = watch(place, place.db);
      const migrations = followedBy(withSteps(tableStep("one")), "broken", [
        "CREATE TABLE two (x INTEGER) STRICT",
        "UPDATE persons SET name = 'changed'",
        "INSERT INTO nowhere VALUES (1)",
        "CREATE TABLE three (x INTEGER) STRICT",
      ]);
      const announced: string[][] = [];

      const error = failure(() =>
        migrateDatabase(place.db, {
          migrations,
          snapshotDir: place.backups,
          onPending: ({ pending }) => announced.push(pending),
        }),
      );

      expect(error.problem).toBe("statement-failed");
      expect(error.facts).toEqual({ tag: tagAt(REAL.length + 2, "broken"), statement: 3, code: "SQLITE_ERROR" });
      expect(error.cause).toMatchObject({ message: "no such table: nowhere" });
      expect(announced).toEqual([[tagAt(REAL.length + 1, "one"), tagAt(REAL.length + 2, "broken")]]);
      expect(state()).toEqual({ ...before, entries: [...before.entries, "backups"].sort() });
      for (const table of ["one", "two", "three"]) expect(hasTable(place.db, table), table).toBe(false);
      expect(place.db.prepare("SELECT name FROM persons").pluck().all()).toEqual(["Ja"]);
      // The connection is as usable as before: the next version of the migration goes through.
      expect(
        migrateDatabase(place.db, { migrations: withSteps(tableStep("one")), snapshotDir: place.backups }).applied,
      ).toEqual([tagAt(REAL.length + 1, "one")]);
    });

    it.each([
      ["breaks a CHECK", "INSERT INTO positive VALUES (0)", "SQLITE_CONSTRAINT_CHECK"],
      [
        "is refused by a trigger",
        "UPDATE workspace_pin SET endpoint = 'https://other.corp.example'",
        "SQLITE_CONSTRAINT_TRIGGER",
      ],
      ["is no SQL", "CREATE TABEL typo (x INTEGER)", "SQLITE_ERROR"],
      // The database library prepares one statement at a time, and says so in a way of its own.
      ["is two statements", "CREATE TABLE a (x INTEGER) STRICT; CREATE TABLE b (x INTEGER) STRICT", "RangeError"],
    ])("with the code of what went wrong when the statement %s", (_what, statement, code) => {
      const { db, backups } = current();
      const migrations = followedBy(REAL, "broken", [
        "CREATE TABLE positive (x INTEGER NOT NULL CHECK (x > 0)) STRICT",
        statement,
      ]);

      const error = failure(() => migrateDatabase(db, { migrations, snapshotDir: backups }));

      expect(error.facts).toEqual({ tag: tagAt(REAL.length + 1, "broken"), statement: 2, code });
      expect(schemaFingerprint(db)).toBe(HEAD.schema);
      expect(snapshotsIn(backups)).toEqual([]);
    });

    it("that ends the transaction, and keeps the copy then: what ran before it may be in the database", () => {
      const { db, backups } = current();
      // Not from a file: readMigrations() refuses such a statement. A list that is handed in can hold it.
      const migrations = followedBy(REAL, "cut_short", [
        "CREATE TABLE half (x INTEGER) STRICT",
        "COMMIT",
        "CREATE TABLE rest (x INTEGER) STRICT",
      ]);

      const error = failure(() => migrateDatabase(db, { migrations, snapshotDir: backups }));

      const [name] = snapshotsIn(backups);
      expect(snapshotsIn(backups)).toHaveLength(1);
      expect(error.problem).toBe("statement-failed");
      // With the name of the copy: it is the one way back, and the owner has to be told where it is.
      expect(error.facts).toEqual({
        tag: tagAt(REAL.length + 1, "cut_short"),
        statement: 2,
        code: "TRANSACTION_ENDED",
        snapshot: name,
      });
      expect(hasTable(db, "half")).toBe(true);
      expect(hasTable(db, "rest")).toBe(false);
      expect(hasTable(raw(join(backups, name ?? ""), { readonly: true }), "half")).toBe(false);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("locking_mode", { simple: true })).toBe("normal");
    });

    it("that ends the transaction of a database that is being created, where there is no copy to name", () => {
      const { file } = pinOnly();
      const db = open(file);
      const migrations = followedBy(REAL, "cut_short", ["CREATE TABLE half (x INTEGER) STRICT", "ROLLBACK"]);

      const error = failure(() => migrateDatabase(db, { migrations, snapshotDir: null }));

      expect(error.facts).toEqual({
        tag: tagAt(REAL.length + 1, "cut_short"),
        statement: 2,
        code: "TRANSACTION_ENDED",
      });
    });
  });

  it("migrations that would leave rows pointing at rows that do not exist, and says where", () => {
    const place = used();
    const { before, state } = watch(place, place.db);
    // With foreign keys off, as they are inside a migration, SQLite takes both statements.
    const migrations = withSteps(tableStep("one"), {
      words: "orphans",
      statements: [
        "INSERT INTO sources (id, kind, created_at) VALUES ('cap_new', 'capture', '2026-10-13T08:00:00.000Z')",
        "INSERT INTO mentions (id, source_id, created_at, surface) VALUES ('mnt_new', 'cap_nowhere', '2026-10-13T08:00:00.000Z', 'x')",
      ],
    });

    const error = failure(() => migrateDatabase(place.db, { migrations, snapshotDir: place.backups }));

    expect(error.problem).toBe("foreign-keys");
    // The check runs once, after all of them: the tag is the last one applied.
    expect(error.facts).toEqual({ tag: tagAt(REAL.length + 2, "orphans"), table: "mentions", parent: "sources" });
    expect(state()).toEqual({ ...before, entries: [...before.entries, "backups"].sort() });
    expect(hasTable(place.db, "one")).toBe(false);
    expect(place.db.prepare("SELECT count(*) FROM sources WHERE id = 'cap_new'").pluck().get()).toBe(0);
  });

  it("a start for which the disk has no room for the copy, before it writes a byte", () => {
    const place = used();
    const { before, state } = watch(place, place.db);
    const needed =
      (place.db.pragma("page_size", { simple: true }) as number) *
      (place.db.pragma("page_count", { simple: true }) as number);
    // The disk of the directory for the copies, which need not be the one of anything else.
    disk.full = { dir: place.backups, freeBytes: needed - 1 };

    const error = failure(() =>
      migrateDatabase(place.db, { migrations: withSteps(tableStep("one")), snapshotDir: place.backups }),
    );

    expect(error.problem).toBe("no-space");
    expect(error.facts).toEqual({ neededBytes: needed, freeBytes: needed - 1 });
    expect(needed).toBeGreaterThan(100_000);
    expect(disk.asked).toEqual([place.backups]);
    expect(state()).toEqual({ ...before, entries: [...before.entries, "backups"].sort() });
    expect(hasTable(place.db, "one")).toBe(false);

    // With exactly as much room as the database takes, the copy is tried.
    disk.full = { dir: place.backups, freeBytes: needed };
    expect(
      migrateDatabase(place.db, { migrations: withSteps(tableStep("one")), snapshotDir: place.backups }).applied,
    ).toHaveLength(1);
  });

  it("a start that cannot make its copy, with what the system said, and begins no migration", () => {
    const { dir, backups, db } = current();
    // Something else is where the directory for the copies belongs.
    writeFileSync(backups, "not a directory");
    const entries = readdirSync(dir).sort();

    const error = failure(() => migrateDatabase(db, { migrations: withSteps(tableStep("one")), snapshotDir: backups }));

    expect(error.problem).toBe("snapshot-failed");
    expect(error.facts).toEqual({ code: "EEXIST" });
    expect(readFileSync(backups, "utf8")).toBe("not a directory");
    expect(readdirSync(dir).sort()).toEqual(entries);
    expect(recordedTags(db)).toEqual(REAL_TAGS);
    expect(hasTable(db, "one")).toBe(false);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("locking_mode", { simple: true })).toBe("normal");
  });

  describe("a start while somebody else is at the database", () => {
    it("when another connection wrote to it between the first look and the lock", () => {
      const place = current();
      const { before, state } = watch(place, place.db);
      const intruding = () => {
        const other = new Database(place.file);
        other.exec(
          "INSERT INTO persons (id, name, name_norm, is_me, created_at) VALUES ('per_me', 'Ja', 'ja', 1, '2026-10-12T09:00:00.000Z')",
        );
        other.close();
      };

      const error = failure(() =>
        migrateDatabase(place.db, {
          migrations: withSteps(tableStep("one")),
          snapshotDir: place.backups,
          onPending: intruding,
        }),
      );

      expect(error.problem).toBe("in-use");
      expect(error.facts).toEqual({});
      // The other one's row is there; nothing of the migration is, and no copy.
      expect(state()).toEqual({
        ...before,
        rows: { ...before.rows, persons: 1 },
        entries: [...before.entries, "backups"].sort(),
      });
      expect(hasTable(place.db, "one")).toBe(false);
    });

    it("when the migrations were applied between the first look and the lock, and keeps the copy made for them", () => {
      const place = current();
      const all = withSteps(tableStep("one"));
      let theirs: string | null = null;
      // Through the same connection: another one could not migrate while this one has the file
      // open. Its own commits are no change of the database to a connection, so what is noticed
      // here is that there is nothing left to apply.
      const overtaking = () => {
        theirs = migrateDatabase(place.db, {
          migrations: all,
          snapshotDir: place.backups,
          now: () => new Date("2026-10-11T12:00:00.000Z"),
        }).snapshot;
      };

      const error = failure(() =>
        migrateDatabase(place.db, {
          migrations: all,
          snapshotDir: place.backups,
          now: () => new Date("2026-10-11T12:00:01.000Z"),
          onPending: overtaking,
        }),
      );

      expect(error.problem).toBe("in-use");
      expect(error.facts).toEqual({});
      // Migrated once; the copy that stays is the one from before the migration.
      expect(recordedTags(place.db)).toEqual(all.map(({ tag }) => tag));
      expect(snapshotsIn(place.backups)).toEqual([basename(theirs ?? "")]);
      expect(place.db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(migrateDatabase(place.db, { migrations: all, snapshotDir: place.backups })).toEqual({
        applied: [],
        snapshot: null,
      });
    });
  });
});

describe("migrateDatabase beside another process", () => {
  let scripts: string;
  let holder: string;
  let killedHalfWay: string;

  const DATABASE = pathToFileURL(join(import.meta.dirname, "../workspace/database.ts")).href;
  const MIGRATE = pathToFileURL(join(import.meta.dirname, "migrate.ts")).href;

  // Has the workspace open and does nothing with it, as a server between two requests does.
  const HOLDER = `import { openWorkspaceDatabase } from ${JSON.stringify(DATABASE)};
const [file, endpoint] = process.argv.slice(2);
const db = openWorkspaceDatabase(file, endpoint);
console.log("holding");
// Referred to from the callback for as long as the process lives: a connection that nothing refers
// to any more is closed by the garbage collector, and its lock goes with it.
setInterval(() => db.open, 1_000);
`;

  // Starts the real migrations and stops in the middle of them, inside the transaction, until it is
  // killed: a statement in the middle of the first one calls back into the process.
  const KILLED_HALF_WAY = `import { writeSync } from "node:fs";
import { migrateDatabase, readMigrations } from ${JSON.stringify(MIGRATE)};
import { openWorkspaceDatabase } from ${JSON.stringify(DATABASE)};
const [file, endpoint, backups] = process.argv.slice(2);
const db = openWorkspaceDatabase(file, endpoint);
db.function("stall", () => {
  writeSync(1, "inside the transaction\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  return 0;
});
const [first, ...rest] = readMigrations();
const half = Math.ceil(first.statements.length / 2);
const stalling = { ...first, statements: [...first.statements.slice(0, half), "SELECT stall()", ...first.statements.slice(half)] };
migrateDatabase(db, { migrations: [stalling, ...rest], snapshotDir: backups });
console.log("migrated");
`;

  beforeAll(() => {
    scripts = mkdtempSync(join(tmpdir(), "hubber-migrate-scripts-"));
    holder = join(scripts, "holder.mjs");
    killedHalfWay = join(scripts, "killed-half-way.mjs");
    writeFileSync(holder, HOLDER);
    writeFileSync(killedHalfWay, KILLED_HALF_WAY);
  });

  afterAll(() => rmSync(scripts, { recursive: true, force: true }));

  /** Starts a script and resolves once it has printed the line; rejects with its output if it ends first. */
  async function started(script: string, args: string[], line: string): Promise<SpawnedNode> {
    const spawned = spawnNode(script, { args });
    children.push(spawned);
    await new Promise<void>((resolve, reject) => {
      spawned.child.stdout.on("data", () => {
        if (spawned.stdout().includes(line)) resolve();
      });
      void spawned.exited.then(({ code }) =>
        reject(
          new Error(
            `The process ended with code ${code} before it printed "${line}".\n${spawned.stdout()}${spawned.stderr()}`,
          ),
        ),
      );
    });
    return spawned;
  }

  it("refuses to migrate while another process has the workspace open, and writes nothing", async () => {
    const place = pinOnly();
    const other = await started(holder, [place.file, ENDPOINT], "holding");
    const db = open(place.file);
    // The connection of the application waits five seconds for a lock; the test does not.
    db.pragma("busy_timeout = 150");
    const announced: string[][] = [];

    const error = failure(() =>
      migrateDatabase(db, { snapshotDir: place.backups, onPending: ({ pending }) => announced.push(pending) }),
    );

    expect(error.problem).toBe("in-use");
    expect(error.facts).toEqual({ code: "SQLITE_BUSY" });
    // The owner was told what the start was about to do before it found the database taken.
    expect(announced).toEqual([REAL_TAGS]);
    expect(objectsOf(db)).toEqual(PIN_OBJECTS);
    expect(existsSync(place.backups)).toBe(false);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("locking_mode", { simple: true })).toBe("normal");
    // The other process was not disturbed: it still runs, and the file is as it left it.
    expect(other.child.exitCode).toBeNull();

    // Once it is gone, the same start goes through.
    other.child.kill("SIGKILL");
    await other.exited;
    expect(migrateDatabase(db, { snapshotDir: place.backups }).applied).toEqual(REAL_TAGS);
  });

  it("leaves the database as it was when it is killed in the middle of a migration, and migrates at the next start", async () => {
    const place = pinOnly();
    const killed = await started(killedHalfWay, [place.file, ENDPOINT, place.backups], "inside the transaction");

    killed.child.kill("SIGKILL");
    expect(await killed.exited).toEqual({ code: null, signal: "SIGKILL" });

    expect(killed.stdout()).toBe("inside the transaction\n");
    // What it left: its copy, and the files of a database that was not closed.
    const [left] = snapshotsIn(place.backups);
    expect(snapshotsIn(place.backups)).toEqual([
      expect.stringMatching(new RegExp(`^before-${REAL_TAGS[0]}-\\d{8}T\\d{9}Z\\.sqlite$`)),
    ]);
    expect(readdirSync(place.dir)).toContain("hubber.sqlite-wal");

    const db = open(place.file);
    // The schema of before: none of the statements that ran is there.
    expect(objectsOf(db)).toEqual(PIN_OBJECTS);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");

    const { applied, snapshot } = migrateDatabase(db, { snapshotDir: place.backups });

    expect(applied).toEqual(REAL_TAGS);
    expect(schemaFingerprint(db)).toBe(HEAD.schema);
    // One copy, this start's: the one of the killed start held the same state.
    expect(snapshotsIn(place.backups)).toEqual([basename(snapshot ?? "")]);
    expect(basename(snapshot ?? "")).not.toBe(left);
    db.close();
    expect(readdirSync(place.dir).sort()).toEqual(["backups", "hubber.sqlite"]);
  });
});
