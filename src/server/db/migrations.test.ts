// What holds for the migrations of this code as files of the repository: the manifest says what
// they are and what they leave, they build the schema from nothing, the frozen databases of
// earlier versions reach the newest one, and nothing in the code replaces rows.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  MIGRATIONS_DIR,
  MIGRATIONS_TABLE,
  type Migration,
  MigrationError,
  migrateDatabase,
  pendingMigrations,
  readMigrations,
  schemaFingerprint,
  withoutComments,
} from "./migrate.ts";

const REPO_ROOT = join(import.meta.dirname, "../../..");
/** Small filled databases, one per version of the schema, each written while that version was the newest. */
const FIXTURES_DIR = join(import.meta.dirname, "fixtures");
const FIXTURE_NAME = /^after-(\d{4}_[a-z0-9_]+)\.sqlite\.gz$/;

interface ManifestEntry {
  tag: string;
  sha256: string;
  schema: string;
}

const connections: Database.Database[] = [];

afterEach(() => {
  for (const db of connections.splice(0)) if (db.open) db.close();
});

function memory(bytes?: Buffer): Database.Database {
  const db = bytes === undefined ? new Database(":memory:") : new Database(bytes);
  connections.push(db);
  db.pragma("foreign_keys = ON");
  return db;
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const readManifest = () => JSON.parse(readFileSync(join(MIGRATIONS_DIR, "manifest.json"), "utf8")) as ManifestEntry[];
const recordedTags = (db: Database.Database) =>
  db.prepare(`SELECT tag FROM ${MIGRATIONS_TABLE} ORDER BY idx`).pluck().all() as string[];
/** The number of rows of every table of the application, by name. */
function rowCounts(db: Database.Database): Record<string, number> {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('workspace_pin', ?) ORDER BY name",
    )
    .pluck()
    .all(MIGRATIONS_TABLE) as string[];
  return Object.fromEntries(
    tables.map((table) => [table, db.prepare(`SELECT count(*) FROM "${table}"`).pluck().get() as number]),
  );
}

describe("the manifest", () => {
  it("says of every migration what its file is and what schema it leaves", () => {
    const manifest = readManifest();
    // Found again from the files alone, on a database that starts empty. Foreign keys are off,
    // as they are while the runner applies a migration.
    const db = memory();
    db.pragma("foreign_keys = OFF");
    const found = manifest.map(({ tag }): ManifestEntry => {
      const bytes = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`));
      const statements = bytes
        .toString("utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => statement.trim() !== "");
      // One statement between two breakpoints: the database library refuses a text that holds two.
      db.transaction(() => {
        for (const statement of statements) db.prepare(statement).run();
      })();
      // The sha256 is of the file as it lies on the disk, which is what the runner compares.
      return { tag, sha256: sha256(bytes), schema: schemaFingerprint(db) };
    });

    // For a new migration, this is the entry to paste. For one that is on main, a difference means
    // that its file was changed, and the file is what has to go back.
    expect(manifest, `manifest.json has to hold:\n${JSON.stringify(found, null, 2)}\n`).toEqual(found);
  });

  it("is what the runner reads: every file is listed, numbered in order, and holds nothing a migration may not", () => {
    const manifest = readManifest();

    const migrations = readMigrations();

    expect(migrations.map(({ tag, sha256: hash, schema }) => ({ tag, sha256: hash, schema }))).toEqual(manifest);
    expect(migrations.length).toBeGreaterThan(0);
    expect(readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"))).toHaveLength(manifest.length);
  });
});

describe("the files of the migrations in the repository", () => {
  it("are kept byte for byte by git: a checkout that rewrote their line ends would fail every start", () => {
    // What a checkout does to a text file where it is told to convert line ends: other bytes,
    // and so another sha256 than the manifest holds.
    const attributes = readFileSync(join(REPO_ROOT, ".gitattributes"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

    expect(attributes).toContain(`${relative(REPO_ROOT, MIGRATIONS_DIR)}/*.sql -text`);
    // The control: the pattern is the folder the runner reads, and the files in it are what it names.
    expect(relative(REPO_ROOT, MIGRATIONS_DIR)).toBe("src/server/db/migrations");
    expect(readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).length).toBeGreaterThan(0);
  });
});

describe("the migrations, from nothing", () => {
  it("build the schema of this code on an empty database, through the runner", () => {
    const migrations = readMigrations();
    const db = memory();

    const { applied, snapshot } = migrateDatabase(db, { snapshotDir: null });

    expect(applied).toEqual(migrations.map(({ tag }) => tag));
    expect(snapshot).toBeNull();
    expect(schemaFingerprint(db)).toBe(migrations.at(-1)?.schema);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.prepare(`SELECT idx, tag, sha256, snapshot FROM ${MIGRATIONS_TABLE} ORDER BY idx`).all()).toEqual(
      migrations.map(({ index, tag, sha256: hash }) => ({ idx: index, tag, sha256: hash, snapshot: null })),
    );
  });

  // The fingerprint drops the double quotes around a name, so a name that needs them, for a blank
  // in it, would count like the words it is made of.
  it("give every table, column, index and trigger a name that is one word without quotes", () => {
    const db = memory();
    migrateDatabase(db, { snapshotDir: null });

    const objects = db
      .prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
      .pluck()
      .all() as string[];
    const columns = db
      .prepare("SELECT c.name FROM sqlite_schema t JOIN pragma_table_xinfo(t.name) c WHERE t.type = 'table'")
      .pluck()
      .all() as string[];

    expect(objects.length).toBeGreaterThan(0);
    expect(columns.length).toBeGreaterThan(0);
    expect([...objects, ...columns].filter((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))).toEqual([]);
  });

  it("leave a database that the next start finds current", () => {
    const db = memory();
    migrateDatabase(db, { snapshotDir: null });

    expect(migrateDatabase(db, { snapshotDir: null })).toEqual({ applied: [], snapshot: null });
  });

  it("reach the same schema one start at a time as all at once", () => {
    const migrations = readMigrations();
    const db = memory();

    // A workspace that was opened by every version on the way.
    for (let known = 1; known <= migrations.length; known++) {
      migrateDatabase(db, { migrations: migrations.slice(0, known), snapshotDir: null });
      expect(schemaFingerprint(db)).toBe(migrations[known - 1]?.schema);
    }

    expect(recordedTags(db)).toEqual(migrations.map(({ tag }) => tag));
  });
});

/**
 * For a migration that changes the number of rows of a table on purpose: the tables it does that
 * to. A migration that is not named here has to leave every table with the rows it had.
 */
const CHANGES_ROW_COUNTS: Record<string, string[]> = {};

/**
 * The items that break a rule of the schedule: a precision without its day, a milestone with a
 * start, a project that is a milestone. The triggers that hold these rules look at the row a
 * statement writes and never at the rows that are there, and integrity_check does not know the
 * rules at all: a migration that makes a rule stricter, or moves the columns, can leave such a
 * row behind without a sound, and the row then refuses every later change of its schedule.
 */
const scheduleBreakers = (db: Database.Database) =>
  db
    .prepare(
      `SELECT id FROM items
        WHERE (start_on_precision IS NOT NULL AND start_on IS NULL)
           OR (due_on_precision IS NOT NULL AND due_on IS NULL)
           OR (is_milestone = 1 AND (start_on IS NOT NULL OR kind = 'project'))
        ORDER BY id`,
    )
    .pluck()
    .all() as string[];

describe("the rules of the schedule, as a question to the rows that are there", () => {
  it("finds every item that breaks one of them, and no other", () => {
    const db = memory();
    migrateDatabase(db, { snapshotDir: null });
    // The rules are held by triggers on items. Without them the rows below can be written: what a
    // migration leaves that replaced the triggers and did not repair the rows.
    const rules = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'items' AND name LIKE '%schedule%'",
      )
      .pluck()
      .all() as string[];
    expect(rules.length).toBeGreaterThan(0);
    const item = db.prepare(
      `INSERT INTO items (id, kind, title, title_norm, status, importance, start_on, start_on_precision, due_on,
                          due_on_precision, is_milestone, created_at, last_activity_at)
       VALUES (@id, @kind, 'Atlas', 'atlas', 'todo', 'normal', @startOn, @startOnPrecision, @dueOn,
               @dueOnPrecision, @isMilestone, '2026-10-12T09:00:00.000Z', '2026-10-12T09:00:00.000Z')`,
    );
    const within = { kind: "task", startOn: null, startOnPrecision: null, dueOn: null, dueOnPrecision: null };
    const rows = [
      { ...within, id: "itm_undated", isMilestone: 0 },
      {
        ...within,
        id: "itm_period",
        startOn: "2026-10-01",
        startOnPrecision: "month",
        dueOn: "2026-12-31",
        dueOnPrecision: "quarter",
        isMilestone: 0,
      },
      { ...within, id: "itm_milestone", dueOn: "2026-11-02", isMilestone: 1 },
      { ...within, id: "itm_milestone_undated", isMilestone: 1 },
      { ...within, id: "itm_project", kind: "project", startOn: "2026-10-01", isMilestone: 0 },
      { ...within, id: "itm_x_start_precision_alone", startOnPrecision: "week", isMilestone: 0 },
      { ...within, id: "itm_x_due_precision_alone", dueOnPrecision: "approximate", isMilestone: 0 },
      { ...within, id: "itm_x_milestone_with_start", startOn: "2026-10-01", dueOn: "2026-11-02", isMilestone: 1 },
      { ...within, id: "itm_x_milestone_project", kind: "project", isMilestone: 1 },
    ];
    // The control: with the triggers in place the database refuses each of the four, and only those.
    const refused = rows.filter((row) => {
      try {
        db.transaction(() => {
          item.run(row);
          throw new Error("taken back");
        })();
      } catch (error) {
        return (error as Error).message !== "taken back";
      }
      return false;
    });
    expect(refused.map(({ id }) => id)).toEqual(rows.map(({ id }) => id).filter((id) => id.startsWith("itm_x_")));

    for (const name of rules) db.exec(`DROP TRIGGER ${name}`);
    for (const row of rows) item.run(row);

    expect(scheduleBreakers(db)).toEqual(refused.map(({ id }) => id).sort());
  });
});

/**
 * The items that break a rule of the tree, as three counts: projects that have a parent; items from
 * which no way leads up to an item without a parent, which is a cycle and whatever sits under one;
 * items that sit directly under a merged item. The first two are rules that two triggers hold and
 * nothing else: integrity_check does not know them, and to foreign_key_check every parent on a cycle
 * exists. The third is a state that the triggers accept, a merge that marked an item before it moved
 * what was under it, and that no operation leaves. The walk goes down from the tops, so it ends on
 * any rows: an item on a cycle is never reached.
 */
const treeBreakers = (db: Database.Database) =>
  db
    .prepare(
      `WITH RECURSIVE reached (id) AS (
         SELECT id FROM items WHERE parent_id IS NULL
         UNION ALL
         SELECT c.id FROM reached JOIN items c ON c.parent_id = reached.id)
       SELECT (SELECT count(*) FROM items WHERE kind = 'project' AND parent_id IS NOT NULL) AS projects_with_a_parent,
              (SELECT count(*) FROM items WHERE id NOT IN (SELECT id FROM reached)) AS items_that_reach_no_top,
              (SELECT count(*) FROM items c JOIN items p ON p.id = c.parent_id
                WHERE p.merged_into_id IS NOT NULL) AS items_under_a_merged_item`,
    )
    .get() as { projects_with_a_parent: number; items_that_reach_no_top: number; items_under_a_merged_item: number };
const A_TREE = { projects_with_a_parent: 0, items_that_reach_no_top: 0, items_under_a_merged_item: 0 };

describe("the rules of the tree of items, as a question to the rows that are there", () => {
  const AT = "2026-10-12T09:00:00.000Z";

  /** A database with two projects, the first of them five levels deep, and a task that stands alone with a task under it. */
  function withTrees(): Database.Database {
    const db = memory();
    migrateDatabase(db, { snapshotDir: null });
    const item = db.prepare(
      `INSERT INTO items (id, kind, parent_id, title, title_norm, status, importance, is_milestone, created_at, last_activity_at)
       VALUES (?, ?, ?, 'Atlas', 'atlas', 'todo', 'normal', 0, '${AT}', '${AT}')`,
    );
    const rows: [id: string, kind: string, parent: string | null][] = [
      ["itm_p1", "project", null],
      ["itm_p2", "project", null],
      ["itm_t10", "task", "itm_p1"],
      ["itm_t11", "task", null],
      ["itm_s20", "task", "itm_t10"],
      ["itm_s21", "task", "itm_t11"],
      ["itm_d30", "task", "itm_s20"],
      ["itm_d40", "task", "itm_d30"],
    ];
    for (const row of rows) item.run(...row);
    return db;
  }
  const move = (db: Database.Database, id: string, parent: string) =>
    db.prepare("UPDATE items SET parent_id = ? WHERE id = ?").run(parent, id);

  it("counts nothing in trees of any depth", () => {
    expect(treeBreakers(withTrees())).toEqual(A_TREE);
  });

  it("counts what is left under an item that was marked as merged before its rows were moved", () => {
    const db = withTrees();

    // Accepted by every guard: they judge the moment a row is put under an item, not the mark.
    db.exec("UPDATE items SET merged_into_id = 'itm_s21' WHERE id = 'itm_s20'");

    expect(treeBreakers(db)).toEqual({ ...A_TREE, items_under_a_merged_item: 1 });
  });

  it("counts a cycle with what sits under it, and a project in a project, which neither check of SQLite sees", () => {
    const db = withTrees();
    db.prepare(
      `INSERT INTO items (id, kind, parent_id, title, title_norm, status, importance, is_milestone, created_at, last_activity_at)
       VALUES ('itm_e50', 'task', 'itm_d40', 'Atlas', 'atlas', 'todo', 'normal', 0, '${AT}', '${AT}')`,
    ).run();
    const rules = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'items' AND name LIKE '%hierarchy%'",
      )
      .pluck()
      .all() as string[];
    expect(rules.length).toBeGreaterThan(0);
    // The control: with the triggers in place the database refuses both moves.
    expect(() => move(db, "itm_s20", "itm_d40")).toThrow("items: an item is not its own ancestor");
    expect(() => move(db, "itm_p2", "itm_p1")).toThrow("items: a project has no parent");
    expect(treeBreakers(db)).toEqual(A_TREE);

    // What a database can hold that lost them: a migration that rebuilt items and forgot the pair.
    for (const name of rules) db.exec(`DROP TRIGGER ${name}`);
    move(db, "itm_s20", "itm_d40");
    move(db, "itm_p2", "itm_p1");

    // itm_s20 > itm_d30 > itm_d40 > itm_s20, and itm_e50 under itm_d40: four items reach no top.
    expect(treeBreakers(db)).toEqual({
      projects_with_a_parent: 1,
      items_that_reach_no_top: 4,
      items_under_a_merged_item: 0,
    });
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});

/**
 * What to do about the fixture of the newest migration when the runner refuses it as a database
 * with another history: the fixture recorded other bytes of a migration than its file holds now,
 * which is what any edit of a migration in the making leaves, a word of a comment included. The
 * runner says only that the history differs. Nothing for a fixture that the runner takes, and
 * nothing for the fixture of an earlier version: "npm run db:fixture" writes the one of the newest
 * migration and no other.
 */
function staleFixture(db: Database.Database, name: string, migrations: Migration[]): string | undefined {
  if (FIXTURE_NAME.exec(name)?.[1] !== migrations.at(-1)?.tag) return undefined;
  try {
    pendingMigrations(db, migrations);
  } catch (error) {
    if (error instanceof MigrationError && error.problem === "diverged") {
      return `The file of migration ${error.facts.tag} was changed after the fixture ${name} was written: the fixture recorded other bytes of it, and the runner refuses such a database. If that migration is not on main yet, remove ${relative(REPO_ROOT, join(FIXTURES_DIR, name))} and run "npm run db:fixture", which writes the fixture again. A migration that is on main is never edited: there its file is what has to go back.`;
    }
  }
  // Whatever else is wrong with it shows in the test that migrates it.
  return undefined;
}

describe("the databases kept from earlier versions", () => {
  const fixtures = existsSync(FIXTURES_DIR)
    ? readdirSync(FIXTURES_DIR)
        .filter((name) => name.endsWith(".gz"))
        .sort()
    : [];

  it("are each named after the migration that was the newest when they were written", () => {
    const tags = readMigrations().map(({ tag }) => tag);

    for (const name of fixtures) expect(tags, name).toContain(FIXTURE_NAME.exec(name)?.[1]);
  });

  it("come with the way out when the newest migration was edited after its fixture was written", () => {
    const migrations = readMigrations();
    const head = migrations.at(-1) as Migration;
    const name = `after-${head.tag}.sqlite.gz`;
    // What the fixture of the newest migration is: a database that has had every migration.
    const db = memory();
    migrateDatabase(db, { snapshotDir: null });
    // The smallest edit, one more word in a comment: other bytes, and the same schema.
    const edited = [...migrations.slice(0, -1), { ...head, sha256: "0".repeat(64) }];

    expect(staleFixture(db, name, migrations)).toBeUndefined();
    expect(staleFixture(db, name, edited)).toBe(
      `The file of migration ${head.tag} was changed after the fixture ${name} was written: the fixture recorded other bytes of it, and the runner refuses such a database. If that migration is not on main yet, remove src/server/db/fixtures/${name} and run "npm run db:fixture", which writes the fixture again. A migration that is on main is never edited: there its file is what has to go back.`,
    );
    // The control: without those words, the test below fails with the runner's, which name no way out.
    expect(() => migrateDatabase(db, { migrations: edited, snapshotDir: null })).toThrow(
      `Migration: diverged {"tag":"${head.tag}"}`,
    );
    // The fixture of an earlier version is not what the command writes again.
    expect(staleFixture(db, "after-0000_earlier.sqlite.gz", edited)).toBeUndefined();
  });

  it("reach the schema of this code through the runner, with every row they had", () => {
    const migrations = readMigrations();
    const tags = migrations.map(({ tag }) => tag);

    for (const name of fixtures) {
      const at = tags.indexOf(FIXTURE_NAME.exec(name)?.[1] ?? "");
      // Opened from its bytes: a fixture is one file without a log.
      const db = memory(gunzipSync(readFileSync(join(FIXTURES_DIR, name))));
      // Before anything else: after an edit of the newest migration the lines below fail with a
      // fingerprint that differs or with the runner's refusal, and neither says what to do.
      const stale = staleFixture(db, name, migrations);
      if (stale !== undefined) throw new Error(stale);
      // It is at the version its name says.
      expect(recordedTags(db), name).toEqual(tags.slice(0, at + 1));
      expect(schemaFingerprint(db), name).toBe(migrations[at]?.schema);
      const before = rowCounts(db);

      const { applied } = migrateDatabase(db, { snapshotDir: null });

      expect(applied, name).toEqual(tags.slice(at + 1));
      expect(schemaFingerprint(db), name).toBe(migrations.at(-1)?.schema);
      expect(db.pragma("foreign_key_check"), name).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true }), name).toBe("ok");
      // Neither check knows the rules that only triggers hold: asked of the rows themselves.
      expect(scheduleBreakers(db), `${name}: items that break a rule of the schedule`).toEqual([]);
      expect(treeBreakers(db), `${name}: items that break a rule of the tree`).toEqual(A_TREE);
      const after = rowCounts(db);
      const changedOnPurpose = new Set(applied.flatMap((tag) => CHANGES_ROW_COUNTS[tag] ?? []));
      for (const [table, rows] of Object.entries(before)) {
        if (!changedOnPurpose.has(table)) expect(after[table], `${name}: rows of ${table}`).toBe(rows);
      }
    }
  });

  it("are excused a changed number of rows only for migrations that exist", () => {
    const tags = readMigrations().map(({ tag }) => tag);

    expect(tags).toEqual(expect.arrayContaining(Object.keys(CHANGES_ROW_COUNTS)));
  });
});

// REPLACE removes the row that is in the way without firing its UPDATE and DELETE triggers, so the
// guards of the schema would not see the change; a foreign key with an action deletes or changes
// rows that no statement names. Neither is used anywhere. The tests are left out: they try both, to
// show that the database and the runner refuse them.
describe("statements that go past the guards of the schema", () => {
  const REPLACES_ROWS = /\b(?:OR\s+REPLACE\b(?!\s*\()|REPLACE\s+INTO\b|ON\s+CONFLICT\s+REPLACE\b)/i;
  const FOREIGN_KEY_ACTION = /\bON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT)\b/i;

  /** Every file below a directory of the repository, by its path from the root. */
  function filesUnder(dir: string): string[] {
    return readdirSync(join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    });
  }
  /**
   * Comments say in words what the code must not do; they are no code. Those of a migration are
   * cut the way the runner cuts them, where SQLite sees a comment: two hyphens inside a string
   * begin none, and what follows them on the line is still a statement.
   */
  const code = (path: string, text: string) =>
    path.endsWith(".sql")
      ? withoutComments(text)
      : text.replace(/(^|\s)\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1 ");
  /**
   * A file that can hold a statement: a script in any of the spellings Node and the build take, or
   * a migration; no test. A test is a file named *.test.ts, which is what Vitest runs here and what
   * lint keeps out of application code: under any other extension a file is code, whatever it is called.
   */
  const isSource = (path: string) => /\.(?:[cm]?[jt]s|[jt]sx|sql)$/.test(path) && !path.endsWith(".test.ts");
  const sources = ["src/server", "scripts"].flatMap(filesUnder).filter(isSource);
  const found = (pattern: RegExp) =>
    sources.filter((path) => pattern.test(code(path, readFileSync(join(REPO_ROOT, path), "utf8"))));

  it("are in no source of the server and of the scripts, and in no migration: REPLACE in any spelling", () => {
    expect(found(REPLACES_ROWS)).toEqual([]);
    // The control: the files were looked at, the migrations among them.
    expect(sources.length).toBeGreaterThan(40);
    expect(sources).toEqual(
      expect.arrayContaining([
        relative(REPO_ROOT, join(MIGRATIONS_DIR, `${readManifest()[0]?.tag}.sql`)),
        "src/server/db/migrate.ts",
        "src/server/workspace/database.ts",
      ]),
    );
  });

  it.each([
    ["src/server/db/handle.ts", true],
    ["src/server/db/later.mts", true],
    ["src/server/db/later.cts", true],
    ["src/server/panel.tsx", true],
    ["scripts/tool.js", true],
    ["scripts/preflight.cjs", true],
    ["scripts/tool.mjs", true],
    ["scripts/tool.jsx", true],
    ["src/server/db/migrations/0002_next.sql", true],
    // Tests by their names only: Vitest runs neither, and application code may import both.
    ["src/server/db/later.test.mts", true],
    ["src/server/panel.test.tsx", true],
    ["src/server/db/migrate.test.ts", false],
    ["src/server/db/migrations/manifest.json", false],
    ["src/server/db/fixtures/after-0001_init.sqlite.gz", false],
    ["src/server/db/notes.ts.txt", false],
  ])("are looked for in every file that can hold one: %s is read, %s", (path, read) => {
    expect(isSource(path)).toBe(read);
  });

  it("are in no migration: a foreign key with an action", () => {
    expect(found(FOREIGN_KEY_ACTION).filter((path) => path.endsWith(".sql"))).toEqual([]);
  });

  it.each([
    ["INSERT OR REPLACE INTO items (id) VALUES (?)", true],
    ["insert or\n  replace into items (id) values (?)", true],
    ["UPDATE OR REPLACE items SET title = ?", true],
    ["REPLACE INTO items (id) VALUES (?)", true],
    ["CREATE TABLE t (x INTEGER UNIQUE ON CONFLICT REPLACE)", true],
    ["SELECT replace(title, 'a', 'b') FROM items WHERE kind = 'task' OR replace(title, ' ', '') = ''", false],
    ["INSERT INTO items (id) VALUES (?) ON CONFLICT (id) DO UPDATE SET title = excluded.title", false],
    ["// INSERT OR REPLACE removes the old row without firing a DELETE trigger.", false],
    ["/** REPLACE INTO is never used. */", false],
    ['const endpoint = "https://router.corp.example/"; db.exec("REPLACE INTO items (id) VALUES (1)");', true],
    ['const pattern = "src/**/*.ts"; db.exec(`INSERT OR REPLACE INTO items (id) VALUES (1)`);', true],
  ])("finds REPLACE in the code %j: %s", (text, expected) => {
    expect(REPLACES_ROWS.test(code("module.ts", text))).toBe(expected);
  });

  it.each([
    ["CREATE TABLE b (a INTEGER REFERENCES a (x) ON DELETE CASCADE)", true],
    ["CREATE TABLE b (a INTEGER REFERENCES a (x) on update set null)", true],
    ["CREATE TABLE b (a INTEGER REFERENCES a (x) ON DELETE RESTRICT)", true],
    ["-- No foreign key says ON DELETE CASCADE.\nCREATE TABLE b (a INTEGER REFERENCES a (x))", false],
    ["CREATE TRIGGER a_fixed BEFORE UPDATE ON a BEGIN DELETE FROM b; END", false],
    ["CREATE TABLE b (a INTEGER REFERENCES a (x) ON DELETE NO ACTION)", false],
    // Behind a string that holds what begins a comment, the text is a statement all the same.
    ["CREATE TABLE b (mark TEXT DEFAULT '--', a INTEGER REFERENCES a (x) ON DELETE CASCADE)", true],
    [
      "CREATE TABLE b (mark TEXT DEFAULT '/*', a INTEGER REFERENCES a (x) ON DELETE SET NULL, note TEXT DEFAULT '*/')",
      true,
    ],
    ["-- It's a comment with one quote.\nCREATE TABLE b (a INTEGER REFERENCES a (x) ON UPDATE CASCADE)", true],
  ])("finds a foreign key action in the SQL %j: %s", (text, expected) => {
    expect(FOREIGN_KEY_ACTION.test(code("0002_next.sql", text))).toBe(expected);
  });

  it.each([
    ["CREATE TRIGGER a_copy AFTER INSERT ON a BEGIN SELECT '--'; INSERT OR REPLACE INTO a (x) VALUES (1); END", true],
    ["/* REPLACE INTO a is what this file must not hold. */ INSERT INTO a (x) VALUES (1)", false],
    ["INSERT INTO a (x) VALUES (1) -- not OR REPLACE", false],
  ])("finds REPLACE in the SQL %j: %s", (text, expected) => {
    expect(REPLACES_ROWS.test(code("0002_next.sql", text))).toBe(expected);
  });
});
