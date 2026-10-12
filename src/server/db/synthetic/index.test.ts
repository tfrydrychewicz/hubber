import { afterEach, describe, expect, it } from "vitest";
import {
  DATE_PRECISIONS,
  EFFECT_CHANGES,
  type EffectChange,
  ENTITY_KINDS,
  OPERATION_STATES,
  type OperationKind,
  PART_KINDS,
  PART_TEXT_ORIGINS,
} from "../../../shared/vocabulary.ts";
import { MIGRATIONS_TABLE } from "../migrate.ts";
import { createTestDatabase, type TestDatabase } from "../testing.ts";
import {
  checkInvariants,
  contentHash,
  DATA_TABLES,
  DatabaseInUseError,
  EARLIEST_NOW,
  generateSynthetic,
  LATEST_NOW,
  SCALES,
  type ScaleName,
  usedTable,
} from "./index.ts";
import { createSyntheticTestDatabase, type SyntheticTestDatabase } from "./testing.ts";

const databases: TestDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function empty(): TestDatabase {
  const database = createTestDatabase();
  databases.push(database);
  return database;
}
/** A copy of the world of a scale: generated once in this process, however many tests ask for it. */
function world(scale: ScaleName): SyntheticTestDatabase {
  const database = createSyntheticTestDatabase(scale);
  databases.push(database);
  return database;
}
/** The content hash of a world that is generated for this one question. */
function hashOf(options: Parameters<typeof generateSynthetic>[1]): string {
  const { db } = empty();
  generateSynthetic(db, options);
  return contentHash(db);
}

const one = <T>({ connection }: TestDatabase, sql: string, ...values: unknown[]): T =>
  connection
    .prepare(sql)
    .pluck()
    .get(...values) as T;
const all = <T>({ connection }: TestDatabase, sql: string, ...values: unknown[]): T[] =>
  connection
    .prepare(sql)
    .pluck()
    .all(...values) as T[];
const count = (database: TestDatabase, sql: string, ...values: unknown[]): number =>
  one<number>(database, `SELECT count(*) FROM ${sql}`, ...values);
/** The tables of the application as the database lists them, without those of other layers. */
const tablesOf = (database: TestDatabase): string[] =>
  all<string>(
    database,
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> ? ORDER BY name",
    MIGRATIONS_TABLE,
  );

const SCALE_NAMES: ScaleName[] = ["tiny", "small"];

describe("generateSynthetic", () => {
  // No table of the schema may be forgotten by the generator: a migration that changes a table
  // without rows would be tested on nothing. Every table gets rows, and none is left empty on
  // purpose: the tests of the runner of the migrations ask the same of the world they migrate.
  it.each(SCALE_NAMES)("gives every table of the schema rows at scale %s", (scale) => {
    const database = world(scale);

    const withoutRows = tablesOf(database).filter((table) => count(database, `"${table}"`) === 0);

    expect(withoutRows).toEqual([]);
    // The control: the tables were looked at, the largest ones of the journal among them.
    expect(tablesOf(database)).toEqual(expect.arrayContaining(["operations", "operation_effects", ...DATA_TABLES]));
    expect(DATA_TABLES.length).toBeGreaterThan(15);
  });

  it.each(SCALE_NAMES)(
    "writes rows that point at rows which exist, into a file that is whole, at scale %s",
    (scale) => {
      const { connection } = world(scale);

      expect(connection.pragma("foreign_key_check")).toEqual([]);
      expect(connection.pragma("integrity_check", { simple: true })).toBe("ok");
    },
  );

  it.each(SCALE_NAMES)("breaks none of the rules that no constraint holds at scale %s", (scale) => {
    expect(checkInvariants(world(scale).db)).toEqual([]);
  });

  it("gives the same content for the same scale, seed and now", () => {
    const first = hashOf({ scale: "tiny" });

    expect(hashOf({ scale: "tiny" })).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same content whatever the number of days in a transaction", () => {
    const { db, manifest } = world("small");

    expect(hashOf({ scale: "small", batchDays: 7 })).toBe(contentHash(db));
    expect(hashOf({ scale: "tiny", batchDays: 1 })).toBe(hashOf({ scale: "tiny", batchDays: 365 }));
    // The control: the small world is more than one transaction of a week.
    expect(manifest.days).toBeGreaterThan(7);
  });

  it("gives another world for another seed and for another now", () => {
    const first = hashOf({ scale: "tiny" });

    expect(hashOf({ scale: "tiny", seed: 2 })).not.toBe(first);
    expect(hashOf({ scale: "tiny", now: new Date("2027-03-01T12:00:00.000Z") })).not.toBe(first);
  });

  it("holds through the guards for another seed and for a now in the middle of a day", () => {
    // The default world passing says little about the next one: every seed draws other moves,
    // merges and undos, and each of them is judged by the database.
    for (const seed of [2, 3]) {
      const database = empty();

      generateSynthetic(database.db, { scale: "small", seed, now: new Date("2026-06-30T11:07:13.250Z") });

      expect(checkInvariants(database.db), `seed ${seed}`).toEqual([]);
      expect(database.connection.pragma("foreign_key_check"), `seed ${seed}`).toEqual([]);
    }
  });

  it("says what it generated", () => {
    const database = world("small");
    const { manifest } = database;

    expect(manifest.seed).toBe(1);
    expect(manifest.now).toBe("2026-10-14T17:30:00.000Z");
    expect(manifest.days).toBe(SCALES.small.days);
    for (const table of tablesOf(database)) expect(manifest.rows[table], table).toBe(count(database, `"${table}"`));
    // The rows that a test addresses by their role.
    expect(one(database, "SELECT id FROM persons WHERE is_me = 1")).toBe(manifest.me);
    // The busiest item is the top of the largest tree.
    expect(
      one(
        database,
        `WITH RECURSIVE tree (top, id) AS (
           SELECT id, id FROM items WHERE parent_id IS NULL
           UNION ALL
           SELECT tree.top, c.id FROM tree JOIN items c ON c.parent_id = tree.id)
         SELECT top FROM tree GROUP BY top ORDER BY count(*) DESC LIMIT 1`,
      ),
    ).toBe(manifest.busiestItem);
    expect(manifest.openCardSource).toBeDefined();
    expect(
      count(
        database,
        "operations o JOIN runs r ON r.id = o.run_id WHERE r.source_id = ? AND o.state = 'proposed'",
        manifest.openCardSource,
      ),
    ).toBeGreaterThan(0);
  });

  it("ends its history at now: nothing is dated after it, and the newest capture is minutes old", () => {
    const database = world("small");
    const { now } = database.manifest;

    expect(one<string>(database, "SELECT max(created_at) FROM sources") <= now).toBe(true);
    expect(one<string>(database, "SELECT max(created_at) FROM sources") > "2026-10-14T17:20").toBe(true);
    expect(one<string>(database, "SELECT max(applied_at) FROM operations") <= now).toBe(true);
    expect(one(database, "SELECT min(created_at) FROM sources")).toMatch(/^2026-09-15T/);
  });

  it("ends its history at the first and at the last instant that a command takes for now", () => {
    for (const now of [EARLIEST_NOW, LATEST_NOW]) {
      const database = empty();

      const manifest = generateSynthetic(database.db, { scale: "small", now: new Date(now) });

      expect(manifest.now).toBe(now);
      expect(checkInvariants(database.db), now).toEqual([]);
      expect(database.connection.pragma("foreign_key_check"), now).toEqual([]);
      // The history lies before that instant, as it does in every world: nothing is applied after it.
      expect(one<string>(database, "SELECT max(applied_at) FROM operations") <= now, now).toBe(true);
      expect(
        one<string>(database, "SELECT min(applied_at) FROM operations") > `${Number(now.slice(0, 4)) - 1}`,
        now,
      ).toBe(true);
      expect(one<string>(database, "SELECT max(my_role_set_on) FROM items") <= now.slice(0, 10), now).toBe(true);
    }
  });

  it("takes a scale of the caller's own", () => {
    const database = empty();

    const manifest = generateSynthetic(database.db, { scale: { ...SCALES.tiny, name: "two days", days: 2 } });

    expect(manifest.days).toBe(2);
    expect(one(database, "SELECT min(created_at) FROM sources")).toMatch(/^2026-10-13T/);
    expect(checkInvariants(database.db)).toEqual([]);
  });

  it("refuses a database that holds data, and leaves it as it was", () => {
    const database = world("tiny");
    const before = contentHash(database.db);

    const attempt = () => generateSynthetic(database.db, { scale: "tiny" });

    expect(attempt).toThrow(DatabaseInUseError);
    expect(attempt).toThrow(/synthetic data goes into an empty database only/);
    expect(contentHash(database.db)).toBe(before);
  });

  it("names a table that has rows, and none for a database with the rows of the migrations alone", () => {
    const database = empty();
    expect(usedTable(database.db)).toBeUndefined();

    database.connection.exec(
      "INSERT INTO files (sha256, byte_size, media_type, created_at) VALUES ('" +
        "ab".repeat(32) +
        "', 1, 'image/png', '2026-10-12T09:00:00.000Z')",
    );

    expect(usedTable(database.db)).toBe("files");
    expect(() => generateSynthetic(database.db, { scale: "tiny" })).toThrow(DatabaseInUseError);
  });
});

// The smallest world is the one that is kept as a file for the tests of later migrations, so it
// has to hold every shape that a migration could treat differently. The shapes are asked for by
// what they are, not by an identifier.
describe.each(SCALE_NAMES)("the shapes that the %s world holds", (scale) => {
  const UNDER = `WITH RECURSIVE tree (id, depth) AS (
      SELECT id, 0 FROM items WHERE parent_id IS NULL
      UNION ALL
      SELECT c.id, tree.depth + 1 FROM tree JOIN items c ON c.parent_id = tree.id)`;

  it("has trees: a chain of eight levels, and none deeper", () => {
    const database = world(scale);

    expect(one(database, `${UNDER} SELECT max(depth) FROM tree`)).toBe(8);
    // Every item is reached from a top, so the items are a forest.
    expect(one(database, `${UNDER} SELECT count(*) FROM tree`)).toBe(count(database, "items"));
  });

  it("has two kinds of item: projects at the top, tasks alone, in projects and under tasks", () => {
    const database = world(scale);

    expect(all(database, "SELECT DISTINCT kind FROM items ORDER BY kind")).toEqual(["project", "task"]);
    expect(count(database, "items WHERE kind = 'project' AND parent_id IS NOT NULL")).toBe(0);
    expect(count(database, "items WHERE kind = 'task' AND parent_id IS NULL")).toBeGreaterThan(0);
    expect(
      count(database, "items i JOIN items p ON p.id = i.parent_id WHERE i.kind = 'task' AND p.kind = 'project'"),
    ).toBeGreaterThan(0);
    expect(
      count(database, "items i JOIN items p ON p.id = i.parent_id WHERE i.kind = 'task' AND p.kind = 'task'"),
    ).toBeGreaterThan(0);
  });

  it("has a task that stands alone with a tree of its own", () => {
    const database = world(scale);

    expect(
      count(
        database,
        `items t WHERE t.kind = 'task' AND t.parent_id IS NULL
           AND EXISTS (SELECT 1 FROM items c JOIN items g ON g.parent_id = c.id WHERE c.parent_id = t.id)`,
      ),
    ).toBeGreaterThan(0);
  });

  it("has a subtree that was moved: one effect on the parent of the item that moved, and none on what is under it", () => {
    const database = world(scale);
    const moved = all<string>(
      database,
      `SELECT e.entity_id FROM operation_effects e JOIN operations o ON o.id = e.operation_id
        WHERE e.entity_kind = 'item' AND e.change = 'update' AND e.field = 'parent_id' AND o.kind = 'update_item'
          AND EXISTS (SELECT 1 FROM items c WHERE c.parent_id = e.entity_id)`,
    );

    expect(moved.length).toBeGreaterThan(0);
    // The effect is anchored at the item that moved, and its operation changed nothing else.
    expect(
      count(
        database,
        `operation_effects e WHERE e.field = 'parent_id' AND e.entity_id = ?
           AND (e.item_id IS NOT e.entity_id OR (SELECT count(*) FROM operation_effects o WHERE o.operation_id = e.operation_id) <> 1)
           AND (SELECT kind FROM operations WHERE id = e.operation_id) = 'update_item'`,
        moved[0],
      ),
    ).toBe(0);
  });

  it("has an open task directly under a closed one", () => {
    const database = world(scale);

    expect(
      count(
        database,
        "items i JOIN items p ON p.id = i.parent_id WHERE i.closed_at IS NULL AND i.merged_into_id IS NULL AND p.closed_at IS NOT NULL",
      ),
    ).toBeGreaterThan(0);
  });

  it("has no item that changed its kind", () => {
    expect(count(world(scale), "operation_effects WHERE entity_kind = 'item' AND field = 'kind'")).toBe(0);
  });

  it.each([
    ["a period: a start and a due day in order", "start_on <= due_on AND is_milestone = 0"],
    ["a due day alone", "start_on IS NULL AND due_on IS NOT NULL AND is_milestone = 0"],
    ["a start alone", "start_on IS NOT NULL AND due_on IS NULL"],
    ["a start after the due day", "start_on > due_on"],
    ["a milestone with its day", "is_milestone = 1 AND due_on IS NOT NULL"],
    ["a milestone without a day", "is_milestone = 1 AND due_on IS NULL"],
    [
      "a milestone below the first level",
      "is_milestone = 1 AND parent_id IN (SELECT id FROM items WHERE kind = 'task')",
    ],
    [
      "both days from one named period",
      "start_on_precision = due_on_precision AND start_on_precision <> 'approximate'",
    ],
    ["no day at all", "start_on IS NULL AND due_on IS NULL AND is_milestone = 0"],
  ])("has an item with %s", (_shape, condition) => {
    expect(count(world(scale), `items WHERE ${condition}`)).toBeGreaterThan(0);
  });

  it("has every precision of a day, and a milestone is never a project and never has a start", () => {
    const database = world(scale);

    expect(
      all(
        database,
        "SELECT start_on_precision FROM items WHERE start_on_precision IS NOT NULL UNION SELECT due_on_precision FROM items WHERE due_on_precision IS NOT NULL",
      ).sort(),
    ).toEqual([...DATE_PRECISIONS].sort());
    expect(count(database, "items WHERE is_milestone = 1 AND (kind = 'project' OR start_on IS NOT NULL)")).toBe(0);
    expect(count(database, "items WHERE is_milestone NOT IN (0, 1)")).toBe(0);
  });

  it("has every importance, and an importance that was changed later", () => {
    const database = world(scale);

    expect(all(database, "SELECT DISTINCT importance FROM items ORDER BY importance")).toEqual([
      "high",
      "low",
      "normal",
    ]);
    expect(count(database, "operation_effects WHERE entity_kind = 'item' AND field = 'importance'")).toBeGreaterThan(0);
  });

  it.each([
    ["a project", "kind = 'project'"],
    ["a task", "kind = 'task'"],
    ["a task under a task", "parent_id IN (SELECT id FROM items WHERE kind = 'task')"],
    ["a milestone", "is_milestone = 1"],
  ])("has %s with a health", (_which, condition) => {
    expect(count(world(scale), `items WHERE health IS NOT NULL AND ${condition}`)).toBeGreaterThan(0);
  });

  it("has tasks in every health: one that was created with it, one that got it later, and one whose health was changed", () => {
    const database = world(scale);
    const OF_A_TASK = "e.entity_kind = 'item' AND (SELECT kind FROM items WHERE id = e.entity_id) = 'task'";

    expect(
      all(database, "SELECT DISTINCT health FROM items WHERE kind = 'task' AND health IS NOT NULL ORDER BY health"),
    ).toEqual(["green", "red", "yellow"]);
    // Most tasks are not assessed at all.
    expect(count(database, "items WHERE kind = 'task' AND health IS NULL")).toBeGreaterThan(
      count(database, "items WHERE kind = 'task' AND health IS NOT NULL"),
    );
    // Created with it: the health stands in the image of the row that the creation recorded.
    expect(
      count(
        database,
        `operation_effects e WHERE ${OF_A_TASK} AND e.change = 'create' AND json_extract(e.after_value, '$.health') IS NOT NULL`,
      ),
    ).toBeGreaterThan(0);
    expect(
      count(database, `operation_effects e WHERE ${OF_A_TASK} AND e.field = 'health' AND e.before_value = 'null'`),
    ).toBeGreaterThan(0);
    expect(
      count(
        database,
        `operation_effects e WHERE ${OF_A_TASK} AND e.field = 'health' AND e.before_value <> 'null' AND e.after_value <> 'null'`,
      ),
    ).toBeGreaterThan(0);
    // A change of the health is a change like that of any other field: one operation in force,
    // its one effect, anchored at the task.
    expect(
      count(
        database,
        `operation_effects e JOIN operations o ON o.id = e.operation_id
          WHERE ${OF_A_TASK} AND e.field = 'health'
            AND (o.kind <> 'update_item' OR o.state <> 'applied' OR e.change <> 'update' OR e.item_id IS NOT e.entity_id
                 OR json_extract(o.payload, '$.item_id') IS NOT e.entity_id
                 OR json_extract(o.payload, '$.set.health') IS NOT json_extract(e.after_value, '$')
                 OR o.created_at > o.applied_at
                 OR (SELECT count(*) FROM operation_effects s WHERE s.operation_id = e.operation_id) <> 1)`,
      ),
    ).toBe(0);
  });

  it("has days that were changed later, each change one operation with an effect for every column", () => {
    const database = world(scale);
    const fieldsOf = (condition: string) =>
      all<string>(
        database,
        `SELECT group_concat(field, ' ') FROM (SELECT operation_id, field FROM operation_effects
            WHERE entity_kind = 'item' AND change = 'update' ORDER BY id) GROUP BY operation_id HAVING ${condition}`,
      );

    // A day that moved, with the precision that the change took away.
    expect(fieldsOf("group_concat(field, ' ') LIKE '%due_on due_on_precision%'").length).toBeGreaterThan(0);
    // Both days of a period moved by one change.
    expect(fieldsOf("group_concat(field, ' ') LIKE '%due_on%start_on%'").length).toBeGreaterThan(0);
    // A task with a period that was marked as a milestone: the mark, and the start that went with it.
    expect(fieldsOf("group_concat(field, ' ') LIKE 'is_milestone start_on%'").length).toBeGreaterThan(0);
    expect(
      count(database, "operation_effects WHERE field = 'is_milestone' AND before_value = '0' AND after_value = '1'"),
    ).toBeGreaterThan(0);
  });

  it("has a merged item and a merged person, and nothing that still points at either", () => {
    const database = world(scale);

    expect(count(database, "items WHERE merged_into_id IS NOT NULL")).toBeGreaterThan(0);
    expect(count(database, "persons WHERE merged_into_id IS NOT NULL")).toBeGreaterThan(0);
    for (const [table, column, merged] of [
      ["items", "parent_id", "items"],
      ["facts", "item_id", "items"],
      ["source_links", "item_id", "items"],
      ["item_persons", "item_id", "items"],
      ["item_aliases", "item_id", "items"],
      ["item_descriptions", "item_id", "items"],
      ["item_persons", "person_id", "persons"],
      ["mentions", "person_id", "persons"],
      ["fact_persons", "person_id", "persons"],
      ["person_aliases", "person_id", "persons"],
    ] as const) {
      expect(
        count(database, `${table} t JOIN ${merged} m ON m.id = t.${column} WHERE m.merged_into_id IS NOT NULL`),
        `${table}.${column}`,
      ).toBe(0);
    }
    // What the merge moved is in the journal: rows that changed the item or the person they belong to.
    expect(
      count(
        database,
        "operation_effects e JOIN operations o ON o.id = e.operation_id WHERE o.kind = 'merge_items' AND e.field IN ('item_id', 'parent_id')",
      ),
    ).toBeGreaterThan(0);
    expect(
      count(
        database,
        "operation_effects e JOIN operations o ON o.id = e.operation_id WHERE o.kind = 'merge_people' AND e.field = 'person_id'",
      ),
    ).toBeGreaterThan(0);
  });

  it("has operations in every state, each as the journal means it", () => {
    const database = world(scale);

    expect(all(database, "SELECT DISTINCT state FROM operations").sort()).toEqual([...OPERATION_STATES].sort());
    // Staged: only what the run that is still running has staged.
    expect(
      count(
        database,
        "operations o WHERE o.state = 'staged' AND (SELECT state FROM runs WHERE id = o.run_id) IS NOT 'running'",
      ),
    ).toBe(0);
    // Proposed, with nothing that depends on it and depending on nothing itself.
    expect(
      count(
        database,
        "operations WHERE state = 'proposed' AND id NOT IN (SELECT depends_on_id FROM operation_dependencies UNION SELECT operation_id FROM operation_dependencies)",
      ),
    ).toBeGreaterThan(0);
    expect(count(database, "operations WHERE state = 'invalid' AND problems IS NOT NULL")).toBeGreaterThan(0);
    expect(count(database, "operations WHERE state = 'rejected' AND decided_at IS NOT NULL")).toBeGreaterThan(0);
    expect(count(database, "operations WHERE state = 'applied' AND run_id IS NOT NULL")).toBeGreaterThan(0);
    // Undone: taken back by an undo that is itself an entry of the journal.
    expect(
      count(
        database,
        "operations o JOIN operations u ON u.id = o.undone_by_id WHERE o.state = 'undone' AND u.kind = 'undo' AND u.state = 'applied'",
      ),
    ).toBe(count(database, "operations WHERE state = 'undone'"));
  });

  it("has operations of every origin and every way of approval, with their quotes", () => {
    const database = world(scale);

    expect(all(database, "SELECT DISTINCT origin FROM operations ORDER BY origin")).toEqual([
      "command",
      "inference",
      "user",
    ]);
    expect(
      all(database, "SELECT DISTINCT approval FROM operations WHERE approval IS NOT NULL ORDER BY approval"),
    ).toEqual(["accepted", "auto", "command", "manual"]);
    expect(all(database, "SELECT DISTINCT confidence FROM operations WHERE confidence IS NOT NULL ORDER BY 1")).toEqual(
      ["high", "low"],
    );
    expect(count(database, "operations WHERE origin = 'command' AND command_quote IS NULL")).toBe(0);
    expect(count(database, "operations WHERE quote IS NOT NULL")).toBeGreaterThan(0);
    expect(count(database, "operations WHERE rationale IS NOT NULL")).toBeGreaterThan(0);
    expect(count(database, "operation_dependencies")).toBeGreaterThan(0);
  });

  // The kinds of entity that the journal of the world has no effect on, each with the reason.
  // "capture": the day that a capture is about is changed by an operation, and the vocabulary has
  // no kind of operation for that change yet.
  const WITHOUT_EFFECTS: string[] = ["capture"];

  it("has effects on every kind of entity that operations change, but for the kinds on a list", () => {
    const database = world(scale);

    expect(all(database, "SELECT DISTINCT entity_kind FROM operation_effects").sort()).toEqual(
      ENTITY_KINDS.filter((kind) => !WITHOUT_EFFECTS.includes(kind)).sort(),
    );
  });

  it("has effects of every kind of change", () => {
    const database = world(scale);

    expect(all(database, "SELECT DISTINCT change FROM operation_effects").sort()).toEqual([...EFFECT_CHANGES].sort());
    // An effect records the stored columns of a row, and none that follows from the others.
    const created = JSON.parse(
      one<string>(
        database,
        "SELECT after_value FROM operation_effects WHERE entity_kind = 'item' AND change = 'create'",
      ),
    ) as Record<string, unknown>;
    expect(Object.keys(created)).toEqual(
      all<string>(database, "SELECT name FROM pragma_table_info('items')").filter(
        (column) => column !== "title_norm" && column !== "last_activity_at",
      ),
    );
  });

  it("has work that is under way at now: a job that waits, one that is being processed, one that failed", () => {
    const database = world(scale);

    expect(count(database, "queue_jobs WHERE state = 'queued' AND attempts = 0")).toBeGreaterThan(0);
    expect(count(database, "queue_jobs WHERE state = 'queued' AND attempts > 0")).toBeGreaterThan(0);
    expect(count(database, "queue_jobs WHERE state = 'failed'")).toBeGreaterThan(0);
    expect(count(database, "queue_jobs WHERE kind = 'summarize_item'")).toBeGreaterThan(0);
    // The run of the job that is being processed has staged operations, and what one of them waits for.
    expect(
      count(
        database,
        "queue_jobs j JOIN runs r ON r.job_id = j.id AND r.state = 'running' JOIN operations o ON o.run_id = r.id AND o.state = 'staged' WHERE j.state = 'running'",
      ),
    ).toBeGreaterThan(0);
    expect(count(database, "runs WHERE state = 'failed' AND error_code = 'interrupted'")).toBeGreaterThan(0);
    expect(count(database, "model_calls WHERE job_id IS NOT NULL")).toBeGreaterThan(0);
    expect(count(database, "model_calls WHERE error_type IS NOT NULL")).toBeGreaterThanOrEqual(0);
  });

  it("has raw material of every kind, and text derived from what is no text", () => {
    const database = world(scale);

    expect(all(database, "SELECT DISTINCT kind FROM capture_parts").sort()).toEqual([...PART_KINDS].sort());
    expect(all(database, "SELECT DISTINCT origin FROM capture_part_texts").sort()).toEqual(
      [...PART_TEXT_ORIGINS].sort(),
    );
    // A correction is a new revision of the text beside the one it corrects.
    expect(count(database, "capture_part_texts WHERE revision > 1 AND origin = 'correction'")).toBeGreaterThan(0);
    expect(
      count(database, "capture_part_texts WHERE origin = 'transcription' AND model_call_id IS NOT NULL"),
    ).toBeGreaterThan(0);
    expect(
      count(
        database,
        "capture_parts p WHERE p.file_sha256 IS NOT NULL AND NOT EXISTS (SELECT 1 FROM files f WHERE f.sha256 = p.file_sha256)",
      ),
    ).toBe(0);
  });
});

// What a writer of the application has to get right and no rule of the database asks for. The
// generator is such a writer: these hold of every row it makes.
describe("the small world, row by row", () => {
  it("anchors every effect at the item and the person of its row, as the row stands after the change", () => {
    const database = world("small");
    interface Effect {
      id: number;
      operation: string;
      kind: string;
      entity: string;
      change: string;
      field: string | null;
      after: string | null;
      item: string | null;
      person: string | null;
    }
    const effects = database.connection
      .prepare(
        `SELECT e.id, o.kind AS operation, e.entity_kind AS kind, e.entity_id AS entity, e.change, e.field,
                e.after_value AS after, e.item_id AS item, e.person_id AS person
           FROM operation_effects e JOIN operations o ON o.id = e.operation_id ORDER BY e.id`,
      )
      .all() as Effect[];
    // The rows as the effects leave them, one after the other: the ids of all kinds are told apart by their beginnings.
    const rows = new Map<string, Record<string, string | null>>();
    const wrong: string[] = [];
    const kinds = new Set<string>();

    for (const effect of effects) {
      if (effect.change === "create") rows.set(effect.entity, JSON.parse(effect.after ?? "{}"));
      const row = rows.get(effect.entity) ?? {};
      if (effect.change === "update" && effect.field !== null) row[effect.field] = JSON.parse(effect.after ?? "null");
      if (effect.change === "delete") {
        rows.delete(effect.entity);
        // What a merge removes is anchored at what the row was merged into, which the row never named.
        if (effect.operation === "merge_items" || effect.operation === "merge_people") continue;
      }
      const item =
        effect.kind === "item"
          ? effect.entity
          : effect.kind === "fact_person"
            ? (rows.get(row.fact_id ?? "")?.item_id ?? null)
            : (row.item_id ?? null);
      const person = effect.kind === "person" ? effect.entity : (row.person_id ?? null);
      if (effect.item !== item || effect.person !== person) wrong.push(`effect ${effect.id} on ${effect.entity}`);
      kinds.add(`${effect.kind} ${effect.change}`);
    }

    expect(wrong).toEqual([]);
    // The control: the effects of aliases, roles, facts and mentions were among those looked at.
    expect([...kinds]).toEqual(
      expect.arrayContaining([
        "item_alias create",
        "person_alias create",
        "item_person create",
        "item_person update",
        "fact create",
        "fact_person create",
        "mention create",
        "mention update",
        "source_link create",
        "item_description create",
      ]),
    );
  });

  it("holds no address outside the names that are reserved for examples", () => {
    const database = world("small");
    const hosts = new Set<string>();
    for (const table of tablesOf(database)) {
      for (const column of all<string>(database, "SELECT name FROM pragma_table_info(?) WHERE type = 'TEXT'", table)) {
        const values = all<string>(
          database,
          `SELECT DISTINCT "${column}" FROM "${table}" WHERE "${column}" LIKE '%@%' OR "${column}" LIKE '%://%'`,
        );
        // The host of an address of a page, and of an address for letters: a name with a dot behind an "@".
        for (const value of values) {
          for (const [, page, letters] of value.matchAll(
            /:\/\/([^\s/"'<>)]+)|[^\s@]@([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)/gu,
          )) {
            hosts.add((page ?? letters) as string);
          }
        }
      }
    }

    expect([...hosts].filter((host) => !host.endsWith(".example"))).toEqual([]);
    // The control: both kinds of address were found, in the aliases of persons and in the links of items.
    expect([...hosts].sort()).toEqual(["firma.example", "tracker.example"]);
  });
});

describe("contentHash", () => {
  it("changes with one value of one row, in any table", () => {
    const database = world("tiny");
    const before = contentHash(database.db);

    database.connection.exec(
      "UPDATE operations SET rationale = 'another' WHERE id = (SELECT min(id) FROM operations WHERE state = 'proposed')",
    );
    const changed = contentHash(database.db);
    database.connection.exec("UPDATE item_statuses SET position = position + 10");

    expect(changed).not.toBe(before);
    expect(contentHash(database.db)).not.toBe(changed);
  });

  it("covers every column: a value that differs in one of them shows", () => {
    const database = world("tiny");
    // The columns that a statement may still write on a row of a ledgered table, one of each kind.
    const changes = [
      "UPDATE items SET last_activity_at = '2030-01-01T00:00:00.000Z' WHERE id = (SELECT min(id) FROM items)",
      "UPDATE items SET external_url = 'https://tracker.example/x' WHERE id = (SELECT min(id) FROM items)",
      "UPDATE persons SET note = 'x' WHERE id = (SELECT min(id) FROM persons)",
      "UPDATE queue_jobs SET last_error_message = 'x' WHERE id = (SELECT min(id) FROM queue_jobs)",
      "UPDATE model_calls SET first_token_ms = 1 WHERE id = 1",
    ];
    let last = contentHash(database.db);

    for (const statement of changes) {
      database.connection.exec(statement);
      const now = contentHash(database.db);
      expect(now, statement).not.toBe(last);
      last = now;
    }
  });

  it("does not depend on the order in which the rows were written", () => {
    const [first, second] = [empty(), empty()];
    const file = (hash: string) =>
      `INSERT INTO files (sha256, byte_size, media_type, created_at) VALUES ('${hash.repeat(32)}', 1, 'image/png', '2026-10-12T09:00:00.000Z')`;

    first.connection.exec(file("ab"));
    first.connection.exec(file("cd"));
    second.connection.exec(file("cd"));
    second.connection.exec(file("ab"));

    expect(contentHash(first.db)).toBe(contentHash(second.db));
    expect(contentHash(first.db)).not.toBe(contentHash(empty().db));
  });

  it("does not depend on that order in a table that keeps its rows as they came", () => {
    const [first, second] = [empty(), empty()];
    // Left to itself, a table with a row number returns its rows in the order they were written.
    const person = (name: string) =>
      `INSERT INTO persons (id, name, name_norm, job_title, team, relation, is_me, merged_into_id, created_at, note)
       VALUES ('per_${name}', '${name}', '${name}', NULL, NULL, NULL, 0, NULL, '2026-10-12T09:00:00.000Z', NULL)`;

    first.connection.exec(person("anna"));
    first.connection.exec(person("zofia"));
    second.connection.exec(person("zofia"));
    second.connection.exec(person("anna"));

    expect(all(first, "SELECT rowid FROM persons ORDER BY id")).toEqual([1, 2]);
    expect(all(second, "SELECT rowid FROM persons ORDER BY id")).toEqual([2, 1]);
    expect(contentHash(first.db)).toBe(contentHash(second.db));
  });

  it("tells the same row in two tables apart, also in tables that a later migration adds", () => {
    const [first, second] = [empty(), empty()];
    for (const { connection } of [first, second]) {
      connection.exec(
        "CREATE TABLE later_a (id TEXT PRIMARY KEY) STRICT; CREATE TABLE later_b (id TEXT PRIMARY KEY) STRICT",
      );
    }

    first.connection.exec("INSERT INTO later_a (id) VALUES ('x')");
    second.connection.exec("INSERT INTO later_b (id) VALUES ('x')");

    expect(contentHash(first.db)).not.toBe(contentHash(second.db));
  });

  it("leaves out what another layer records about the file itself", () => {
    const database = world("tiny");
    const before = contentHash(database.db);

    // When the migrations were applied says nothing about what the database holds.
    database.connection.exec(`UPDATE ${MIGRATIONS_TABLE} SET applied_at = '2031-01-01T00:00:00.000Z'`);

    expect(contentHash(database.db)).toBe(before);
  });
});

describe("checkInvariants", () => {
  /** An instant after the newest row of a world that ends at the default "now". */
  const LATER = "2026-10-14T18:00:00.000Z";
  type Plant = (database: SyntheticTestDatabase) => void;

  /** Drops the triggers whose names hold the word: a rule that only triggers hold can then be broken. */
  function withoutTriggers(database: TestDatabase, word: string): void {
    const names = all<string>(
      database,
      "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE ?",
      `%${word}%`,
    );
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) database.connection.exec(`DROP TRIGGER ${name}`);
  }

  /** An operation as the owner makes one by hand: applied by the statement that inserts it, so that it can have effects. */
  function byHand({ connection }: TestDatabase, kind: OperationKind, id = "opr_plant"): string {
    connection
      .prepare(
        `INSERT INTO operations (id, run_id, seq, kind, origin, state, confidence, approval, source_id, undone_by_id,
                                 created_at, decided_at, applied_at, scrubbed_at, quote, command_quote, rationale,
                                 answer, annotations, problems, proposed_payload, payload)
         VALUES (?, NULL, NULL, ?, 'user', 'applied', NULL, 'manual', NULL, NULL,
                 ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}')`,
      )
      .run(id, kind, LATER, LATER);
    return id;
  }

  interface Planted {
    kind: string;
    entity: string;
    change: EffectChange;
    field?: string;
    item?: string | null;
    person?: string | null;
    /** The values themselves; left out where the effect has none. */
    before?: unknown;
    after?: unknown;
  }
  /** An effect of an operation, written through every guard of the schema. */
  function effect({ connection }: TestDatabase, operation: string, planted: Planted): void {
    const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value));
    connection
      .prepare(
        `INSERT INTO operation_effects (id, operation_id, entity_kind, entity_id, change, field, item_id, person_id,
                                        scrubbed, before_value, after_value)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        operation,
        planted.kind,
        planted.entity,
        planted.change,
        planted.field ?? null,
        planted.item ?? null,
        planted.person ?? null,
        json(planted.before),
        json(planted.after),
      );
  }

  /**
   * Changes columns of a row the way the application does: an operation by hand, one statement, and
   * an effect for every column, anchored where the caller says.
   */
  function change(
    database: TestDatabase,
    table: "items" | "persons",
    id: string,
    values: Record<string, string | number | null>,
    anchors: Pick<Planted, "item" | "person">,
  ): void {
    const columns = Object.keys(values);
    const before = database.connection
      .prepare(`SELECT ${columns.join(", ")} FROM ${table} WHERE id = ?`)
      .get(id) as Record<string, unknown>;
    const operation = byHand(database, table === "items" ? "update_item" : "update_person");
    database.connection
      .prepare(`UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`)
      .run(...Object.values(values), id);
    for (const field of columns) {
      effect(database, operation, {
        kind: table === "items" ? "item" : "person",
        entity: id,
        change: "update",
        field,
        ...anchors,
        before: before[field],
        after: values[field],
      });
    }
  }

  /** A task that is open and no milestone: any of its fields may change. */
  const openTask = (database: TestDatabase): string =>
    one<string>(
      database,
      "SELECT min(id) FROM items WHERE kind = 'task' AND closed_at IS NULL AND merged_into_id IS NULL AND is_milestone = 0",
    );
  const anotherImportance = (database: TestDatabase, item: string): string =>
    one<string>(database, "SELECT importance FROM items WHERE id = ?", item) === "high" ? "low" : "high";

  /** Forty characters that stand in the text of another source and nowhere in the texts of this one. */
  function wordsOfAnotherSource(database: TestDatabase, source: string): string {
    const texts = (which: "=" | "<>") =>
      all<string>(
        database,
        `SELECT p.text FROM capture_parts p WHERE p.text IS NOT NULL AND p.capture_id ${which} ?
         UNION ALL
         SELECT t.text FROM capture_part_texts t JOIN capture_parts p ON p.id = t.part_id WHERE p.capture_id ${which} ?`,
        source,
        source,
      );
    const own = texts("=");
    const words = texts("<>")
      .map((text) => text.slice(0, 40))
      .find((start) => start.length === 40 && own.every((text) => !text.includes(start)));
    if (words === undefined) throw new Error(`Every other source begins with words of ${source}.`);
    return words;
  }

  /** A statement as a plant, run once the triggers whose names hold the given words are gone. */
  const sql =
    (statement: string, ...withoutTriggersNamed: string[]): Plant =>
    (database) => {
      for (const word of withoutTriggersNamed) withoutTriggers(database, word);
      database.connection.exec(statement);
    };
  /** The top of a chain is put under its own grandchild. */
  const circle = sql(
    `UPDATE items SET parent_id = (SELECT g.id FROM items c JOIN items g ON g.parent_id = c.id WHERE c.parent_id = items.id LIMIT 1)
      WHERE id = (SELECT t.id FROM items t WHERE t.kind = 'task' AND EXISTS (SELECT 1 FROM items c JOIN items g ON g.parent_id = c.id WHERE c.parent_id = t.id) ORDER BY t.id LIMIT 1)`,
    "hierarchy",
  );

  // One broken rule each, and one for every clause of every invariant: what the clause is there to
  // find, and nothing that another clause of the same invariant finds as well. A plant that writes
  // a ledgered row past the journal breaks "effects" too, and says so.
  const PLANTS: Record<string, [what: string, plant: Plant, also?: string[]][]> = {
    schedule: [
      [
        "a precision of a start that is not set",
        sql(
          "UPDATE items SET start_on_precision = 'approximate' WHERE id = (SELECT min(id) FROM items WHERE start_on IS NULL AND is_milestone = 0)",
          "schedule",
        ),
        ["effects"],
      ],
      [
        "a precision of a due day that is not set",
        sql(
          "UPDATE items SET due_on_precision = 'approximate' WHERE id = (SELECT min(id) FROM items WHERE due_on IS NULL)",
          "schedule",
        ),
        ["effects"],
      ],
      [
        "a milestone with a start",
        sql(
          "UPDATE items SET start_on = '2026-10-01' WHERE id = (SELECT min(id) FROM items WHERE is_milestone = 1)",
          "schedule",
        ),
        ["effects"],
      ],
      [
        "a project that is a milestone",
        sql(
          "UPDATE items SET is_milestone = 1, start_on = NULL, start_on_precision = NULL WHERE id = (SELECT min(id) FROM items WHERE kind = 'project')",
          "schedule",
        ),
        ["effects"],
      ],
      // The database takes a precision for its shape: only the code knows the words.
      [
        "a precision of a start that the code does not know",
        sql(
          "UPDATE items SET start_on = '2026-04-01', start_on_precision = 'decade' WHERE id = (SELECT min(id) FROM items WHERE is_milestone = 0)",
        ),
        ["effects"],
      ],
      [
        "a precision of a due day that the code does not know",
        sql(
          "UPDATE items SET due_on = '2026-12-31', due_on_precision = 'fortnight' WHERE id = (SELECT min(id) FROM items)",
        ),
        ["effects"],
      ],
      // A start stands for its period by the first day of it, a due day by the last: no trigger asks.
      [
        "a start in a named period that is not the first day of it",
        sql(
          "UPDATE items SET start_on = '2026-04-01', start_on_precision = 'half' WHERE id = (SELECT min(id) FROM items WHERE is_milestone = 0)",
        ),
        ["effects"],
      ],
      [
        "a due day in a named period that is not the last day of it",
        sql("UPDATE items SET due_on = '2026-12-30', due_on_precision = 'year' WHERE id = (SELECT min(id) FROM items)"),
        ["effects"],
      ],
    ],
    tree: [
      [
        "a project with a parent",
        sql(
          `UPDATE items SET parent_id = (SELECT min(id) FROM items WHERE kind = 'task' AND parent_id IS NULL AND merged_into_id IS NULL)
            WHERE id = (SELECT max(id) FROM items WHERE kind = 'project')`,
          "hierarchy",
        ),
        ["effects"],
      ],
      ["a circle among the items", circle, ["effects"]],
      // A merge that marks before it has moved what sits under the item: the database accepts it.
      [
        "an item directly under a merged one",
        sql(
          `UPDATE items SET merged_into_id = (SELECT max(id) FROM items WHERE kind = 'project')
            WHERE id = (SELECT p.id FROM items p WHERE p.kind = 'task' AND p.merged_into_id IS NULL AND EXISTS (SELECT 1 FROM items c WHERE c.parent_id = p.id) ORDER BY p.id LIMIT 1)`,
        ),
        ["effects"],
      ],
    ],
    "last activity": [
      [
        "a date that is later than every operation about the item",
        sql("UPDATE items SET last_activity_at = '2031-01-01T00:00:00.000Z' WHERE id = (SELECT min(id) FROM items)"),
      ],
      [
        "a date that an operation in force about the item is later than",
        sql(
          "UPDATE items SET last_activity_at = created_at WHERE id = (SELECT min(id) FROM items WHERE last_activity_at > created_at)",
        ),
      ],
    ],
    effects: [
      [
        "a row that was changed past the journal",
        sql("UPDATE persons SET team = 'Inny zespół' WHERE id = (SELECT min(id) FROM persons)"),
      ],
      ["a row that is missing", sql("DELETE FROM person_aliases WHERE id = (SELECT min(id) FROM person_aliases)")],
      [
        "a row that no effect made",
        sql(
          "INSERT INTO item_aliases (id, item_id, alias, alias_norm, created_at) SELECT 'ial_extra', id, 'Zbędny', 'zbedny', created_at FROM items LIMIT 1",
        ),
      ],
      // What is recorded is never changed: only without that guard can a record be made to lie.
      [
        "an effect of a change that does not say what was there before",
        sql(
          `UPDATE operation_effects SET before_value = '"coś innego"'
            WHERE id = (SELECT min(id) FROM operation_effects WHERE change = 'update' AND entity_kind = 'item' AND field = 'title')`,
          "operation_effects_update_guard",
        ),
      ],
      [
        "an effect of a removal that does not say what was there before",
        sql(
          `UPDATE operation_effects SET before_value = json_set(before_value, '$.created_at', '2020-01-01T00:00:00.000Z')
            WHERE id = (SELECT min(id) FROM operation_effects WHERE change = 'delete')`,
          "operation_effects_update_guard",
        ),
      ],
      [
        "an image that holds a column which follows from the others",
        sql(
          `UPDATE operation_effects SET after_value = json_set(after_value, '$.title_norm', 'x')
            WHERE id = (SELECT min(id) FROM operation_effects WHERE entity_kind = 'item' AND change = 'create')`,
          "operation_effects_update_guard",
        ),
      ],
      [
        "an effect that makes a row which is there already",
        (database) => {
          // The newest row that nothing has changed since it was made: made twice, it comes out the same.
          const made = database.connection
            .prepare(
              `SELECT e.entity_kind AS kind, e.entity_id AS entity, e.item_id AS item, e.person_id AS person, e.after_value AS image
                 FROM operation_effects e
                WHERE e.change = 'create'
                  AND NOT EXISTS (SELECT 1 FROM operation_effects l WHERE l.entity_id = e.entity_id AND l.id <> e.id)
                ORDER BY e.id DESC LIMIT 1`,
            )
            .get() as { kind: string; entity: string; item: string | null; person: string | null; image: string };
          const { image, ...row } = made;
          effect(database, byHand(database, "update_item"), { ...row, change: "create", after: JSON.parse(image) });
        },
      ],
      [
        "an effect on a row that is not there",
        (database) =>
          effect(database, byHand(database, "resolve_mention"), {
            kind: "mention",
            entity: "mnt_nowhere",
            change: "touch",
          }),
      ],
    ],
    "staged operations": [
      // A commit that forgets to move on what was staged: the database lets the run end.
      [
        "an operation that is left staged by a run that has ended",
        sql("UPDATE runs SET state = 'committed', ended_at = started_at WHERE state = 'running'"),
      ],
    ],
    quotes: [
      [
        "a quote of a fact that is in no source",
        sql(
          "UPDATE facts SET quote = 'Tego nie ma w żadnym źródle.' WHERE id = (SELECT min(id) FROM facts)",
          "facts_never_edited",
        ),
        ["effects"],
      ],
      [
        "a quote of a fact that stands in another source only",
        (database) => {
          withoutTriggers(database, "facts_never_edited");
          const fact = database.connection
            .prepare("SELECT id, source_id AS source FROM facts ORDER BY id LIMIT 1")
            .get();
          const { id, source } = fact as { id: string; source: string };
          database.connection
            .prepare("UPDATE facts SET quote = ? WHERE id = ?")
            .run(wordsOfAnotherSource(database, source), id);
        },
        ["effects"],
      ],
      [
        "a name of a mention that is in no source",
        sql("UPDATE mentions SET surface = 'Nikt Taki' WHERE id = (SELECT min(id) FROM mentions)"),
        ["effects"],
      ],
      [
        "a name of a mention that stands in another source only",
        (database) => {
          const mention = database.connection
            .prepare("SELECT id, source_id AS source FROM mentions ORDER BY id LIMIT 1")
            .get() as { id: string; source: string };
          database.connection
            .prepare("UPDATE mentions SET surface = ? WHERE id = ?")
            .run(wordsOfAnotherSource(database, mention.source), mention.id);
        },
        ["effects"],
      ],
    ],
    // Written through every guard of the schema, as a writer of the application with a mistake would.
    anchors: [
      [
        "a change of an item whose effect is anchored at no item",
        (database) => {
          const item = openTask(database);
          change(database, "items", item, { importance: anotherImportance(database, item) }, { item: null });
        },
      ],
      [
        "a change of an item whose effect is anchored at another item",
        (database) => {
          const item = openTask(database);
          const other = one<string>(database, "SELECT max(id) FROM items WHERE id <> ?", item);
          change(database, "items", item, { importance: anotherImportance(database, item) }, { item: other });
        },
      ],
      [
        "a change of a person whose effect is anchored at no person",
        (database) => {
          const person = one<string>(database, "SELECT min(id) FROM persons WHERE merged_into_id IS NULL");
          change(database, "persons", person, { job_title: "Ktoś inny" }, { person: null });
        },
      ],
    ],
    "folded names": [
      [
        "a folded title that is not the folding of the title",
        sql("UPDATE items SET title_norm = 'zupelnie inny tytul' WHERE id = (SELECT min(id) FROM items)"),
      ],
      [
        "a folded name of a person that is not the folding of the name",
        sql("UPDATE persons SET name_norm = 'ktos inny' WHERE id = (SELECT min(id) FROM persons)"),
      ],
      [
        "a folded alias of an item that is not the folding of the alias",
        sql("UPDATE item_aliases SET alias_norm = 'inny alias' WHERE id = (SELECT min(id) FROM item_aliases)"),
      ],
      [
        "a folded alias of a person that is not the folding of the alias",
        sql("UPDATE person_aliases SET alias_norm = 'inny alias' WHERE id = (SELECT min(id) FROM person_aliases)"),
      ],
      [
        "a folded base form of a mention that is not the folding of the base form",
        sql(
          "UPDATE mentions SET base_norm = 'ktos inny' WHERE id = (SELECT min(id) FROM mentions WHERE base_form IS NOT NULL)",
        ),
      ],
    ],
    "undone operations": [
      // The database asks that the undo exists and is applied, not that it names the operation.
      [
        "an operation that is marked undone by an undo which did not take it back",
        (database) => {
          const undo = one<string>(
            database,
            "SELECT min(id) FROM operations WHERE kind = 'undo' AND state = 'applied'",
          );
          const untouched = one<string>(
            database,
            `SELECT min(o.id) FROM operations o
              WHERE o.state = 'applied' AND o.kind = 'add_fact'
                AND NOT EXISTS (SELECT 1 FROM operation_dependencies d WHERE d.depends_on_id = o.id)`,
          );
          database.connection
            .prepare("UPDATE operations SET state = 'undone', undone_by_id = ? WHERE id = ?")
            .run(undo, untouched);
        },
      ],
    ],
  };

  describe.each(Object.entries(PLANTS))("%s", (invariant, plants) => {
    it.each(plants)("finds %s", (_what, plant, also = []) => {
      const database = world("tiny");

      plant(database);

      expect(checkInvariants(database.db).sort()).toEqual([invariant, ...also].sort());
    });
  });

  // Sound data that a rule read too narrowly would report: each is written through every guard.
  const SOUND: [what: string, plant: Plant][] = [
    [
      "a day that is marked approximate, and a start after the due day",
      (database) => {
        const item = openTask(database);
        change(
          database,
          "items",
          item,
          { due_on: "2026-12-30", due_on_precision: "approximate", start_on: "2027-01-05" },
          { item },
        );
      },
    ],
    [
      "an image that lists the columns of its row in another order",
      (database) => {
        const operation = byHand(database, "create_item");
        database.connection.exec(
          `INSERT INTO items (id, kind, parent_id, title, title_norm, status, importance, health, my_role, my_role_set_on,
                              start_on, start_on_precision, due_on, due_on_precision, is_milestone, external_system,
                              external_key, external_url, merged_into_id, created_at, closed_at, last_activity_at)
           VALUES ('itm_plant', 'task', NULL, 'Nowe zadanie', 'nowe zadanie', 'todo', 'normal', NULL, NULL, NULL,
                   NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, '${LATER}', NULL, '${LATER}')`,
        );
        const row = database.connection.prepare("SELECT * FROM items WHERE id = 'itm_plant'").get() as object;
        const recorded = Object.entries(row).filter(
          ([column]) => column !== "title_norm" && column !== "last_activity_at",
        );
        effect(database, operation, {
          kind: "item",
          entity: "itm_plant",
          change: "create",
          item: "itm_plant",
          after: Object.fromEntries(recorded.reverse()),
        });
      },
    ],
    [
      "a column that a later migration added to a ledgered table, and a change of it",
      (database) => {
        // Older images know nothing of the column: in them it was NULL.
        database.connection.exec("ALTER TABLE items ADD COLUMN sort_key TEXT");
        const item = openTask(database);
        change(database, "items", item, { sort_key: "a" }, { item });
      },
    ],
    [
      "a change of the day that a capture is about, with its effect of the kind of a table that is not replayed",
      (database) => {
        const capture = database.connection
          .prepare("SELECT id, occurred_on AS day FROM captures ORDER BY id LIMIT 1")
          .get();
        const { id, day } = capture as { id: string; day: string };
        const operation = byHand(database, "update_item");
        database.connection
          .prepare("UPDATE captures SET occurred_on = '2026-10-01', occurred_on_approximate = 0 WHERE id = ?")
          .run(id);
        effect(database, operation, {
          kind: "capture",
          entity: id,
          change: "update",
          field: "occurred_on",
          before: day,
          after: "2026-10-01",
        });
      },
    ],
  ];

  it.each(SOUND)("passes %s", (_what, plant) => {
    const database = world("tiny");

    plant(database);

    expect(checkInvariants(database.db)).toEqual([]);
  });

  it("finds what neither check of SQLite sees: a circle among the items passes both", () => {
    const database = world("tiny");

    circle(database);

    expect(checkInvariants(database.db)).toContain("tree");
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    expect(database.connection.pragma("integrity_check", { simple: true })).toBe("ok");
  });
});
