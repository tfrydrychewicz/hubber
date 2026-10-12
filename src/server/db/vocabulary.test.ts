// The words of src/shared/vocabulary.ts against the database: a list in code and the table, the
// CHECK or the index that holds the same words must not drift apart.
import { afterAll, describe, expect, it } from "vitest";
import * as vocabulary from "../../shared/vocabulary.ts";
import {
  CLOSED_ITEM_STATUSES,
  DATE_PRECISIONS,
  DEFAULT_ITEM_IMPORTANCE,
  EFFECT_CHANGES,
  ENTITY_KINDS,
  FACT_TYPES,
  ITEM_HEALTHS,
  ITEM_IMPORTANCES,
  ITEM_KINDS,
  ITEM_PERSON_ROLES,
  ITEM_STATUSES,
  JOB_STATES,
  MODEL_ROLES,
  MY_ROLES,
  NAMED_PERIODS,
  OPERATION_KINDS,
  OPERATION_ORIGINS,
  OPERATION_STATES,
  PART_KINDS,
  PERSON_RELATIONS,
  RUN_STATES,
  SOURCE_KINDS,
} from "../../shared/vocabulary.ts";
import { MODEL_ROLES as CONFIGURED_MODEL_ROLES } from "../workspace/config.ts";
import { createTestDatabase } from "./testing.ts";

const database = createTestDatabase();
const { connection } = database;

afterAll(() => {
  database.close();
});

const codes = (sql: string) => connection.prepare(sql).pluck().all() as string[];
const sqlOf = (name: string) =>
  (connection.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").pluck().get(name) as string | undefined) ?? "";

// The vocabularies that the owner may adjust have an order: the one in which the interface
// offers the words.
const ORDERED: [table: string, list: readonly string[]][] = [
  ["item_statuses", ITEM_STATUSES],
  ["item_healths", ITEM_HEALTHS],
  ["item_importances", ITEM_IMPORTANCES],
  ["my_roles", MY_ROLES],
  ["item_person_roles", ITEM_PERSON_ROLES],
  ["fact_types", FACT_TYPES],
  ["person_relations", PERSON_RELATIONS],
];
const STATES: [table: string, list: readonly string[]][] = [
  ["operation_states", OPERATION_STATES],
  ["run_states", RUN_STATES],
  ["job_states", JOB_STATES],
];
/** Every list of the module, by the name it is exported under. */
const LISTS = Object.entries(vocabulary).flatMap(([name, value]): [string, readonly string[]][] =>
  Array.isArray(value) ? [[name, value]] : [],
);

describe("the lists of words", () => {
  it.each(ORDERED)("%s holds the words of its list, in the order of the list", (table, list) => {
    expect(codes(`SELECT code FROM ${table} ORDER BY position`)).toEqual([...list]);
    // The order is a real one: no two words share a position.
    expect(codes(`SELECT position FROM ${table} GROUP BY position HAVING count(*) > 1`)).toEqual([]);
  });

  it.each(STATES)("%s holds the states of its list", (table, list) => {
    expect(codes(`SELECT code FROM ${table} ORDER BY code`)).toEqual([...list].sort());
  });

  it("leave no table of words without a list", () => {
    // A table of words is one whose key is a column named "code".
    const tables = codes(
      "SELECT m.name FROM sqlite_schema m JOIN pragma_table_info(m.name) c ON c.name = 'code' AND c.pk = 1 WHERE m.type = 'table' ORDER BY m.name",
    );

    expect(tables).toEqual([...ORDERED, ...STATES].map(([table]) => table).sort());
  });

  it("name as closed the statuses that the database marks closed", () => {
    expect(codes("SELECT code FROM item_statuses WHERE is_closed = 1 ORDER BY position")).toEqual([
      ...CLOSED_ITEM_STATUSES,
    ]);
  });

  // No column has a default, so the code that inserts an item writes this word. It has to be the
  // ordinary importance, which is the row that sorts neither above nor below the others.
  it("give a new item the importance whose weight is 0, and there is one such word", () => {
    expect(codes("SELECT code FROM item_importances WHERE weight = 0")).toEqual([DEFAULT_ITEM_IMPORTANCE]);
    expect(ITEM_IMPORTANCES).toContain(DEFAULT_ITEM_IMPORTANCE);
  });

  // Code that sorts by importance reads the weight and names no word. What the weights say must
  // then be what the words say.
  it("weigh the importances as their names say: high above the ordinary one, low below it", () => {
    const weight = (code: string) =>
      connection.prepare("SELECT weight FROM item_importances WHERE code = ?").pluck().get(code) as number;

    expect(weight("high")).toBeGreaterThan(weight(DEFAULT_ITEM_IMPORTANCE));
    expect(weight("low")).toBeLessThan(weight(DEFAULT_ITEM_IMPORTANCE));
  });

  // The list of items at risk reads the severity and names no word: an item, a project or a task,
  // is at risk when the severity of its health is above 0. What the severities say must be what
  // the words say.
  it("give the healths a severity that rises with their order, and only green has none", () => {
    expect(codes("SELECT code FROM item_healths WHERE severity = 0")).toEqual(["green"]);
    expect(codes("SELECT code FROM item_healths ORDER BY severity")).toEqual([...ITEM_HEALTHS]);
    expect(codes("SELECT severity FROM item_healths GROUP BY severity HAVING count(*) > 1")).toEqual([]);
  });

  it.each([
    ["the kinds of item", "items", "kind", ITEM_KINDS],
    ["the changes of an effect", "operation_effects", "change", EFFECT_CHANGES],
  ] as const)("spell %s as the CHECK of the table does", (_what, table, column, list) => {
    const check = new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(sqlOf(table))?.[1];

    expect(check?.split(",").map((word) => word.trim())).toEqual(list.map((word) => `'${word}'`));
  });

  it("spell the roles of a model as the configuration of a workspace does", () => {
    expect([...MODEL_ROLES]).toEqual([...CONFIGURED_MODEL_ROLES]);
  });

  // The shape that the database checks wherever it stores one of these words.
  it.each(LISTS)("%s: every word is a lower-case identifier, and none is there twice", (_name, list) => {
    for (const word of list) expect(word).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(new Set(list).size).toBe(list.length);
    expect(list.length).toBeGreaterThan(0);
  });

  it("are found by the test that reads them all", () => {
    expect(LISTS.map(([name]) => name)).toEqual(
      expect.arrayContaining(["ITEM_STATUSES", "OPERATION_KINDS", "MODEL_ROLES", "DATE_PRECISIONS", "NAMED_PERIODS"]),
    );
  });

  // How exactly a day of the schedule is known is a label: the database has no table and no list
  // of the words, it checks their shape. So the list is held to what the database stores, in both
  // of the columns that take such a word.
  it.each(["start_on_precision", "due_on_precision"])("every precision of a day is a word that %s stores", (column) => {
    const day = column.replace("_precision", "");
    const put = connection.prepare(
      `INSERT INTO items (id, kind, title, title_norm, status, importance, is_milestone, created_at, last_activity_at, ${day}, ${column}) VALUES (?, 'task', 't', 't', 'todo', ?, 0, ?, ?, '2026-11-30', ?)`,
    );
    const at = "2026-10-12T08:00:00.000Z";

    for (const precision of DATE_PRECISIONS) {
      expect(put.run(`itm_${column}_${precision}`, DEFAULT_ITEM_IMPORTANCE, at, at, precision).changes, precision).toBe(
        1,
      );
    }
    expect(codes(`SELECT ${column} FROM items WHERE ${column} IS NOT NULL ORDER BY rowid`)).toEqual([
      ...DATE_PRECISIONS,
    ]);
  });

  it("name as periods the precisions that say more than that a day is about right", () => {
    expect([...NAMED_PERIODS]).toEqual(DATE_PRECISIONS.filter((precision) => precision !== "approximate"));
    expect(DATE_PRECISIONS).toContain("approximate");
  });
});

// An index, a trigger or a CHECK that spells a word out stops working, without a sound, when the
// word is renamed in one place only. Each row is such a word, the list it must stay in, and one
// of the schema objects that spell it.
describe("the words that the schema itself names", () => {
  it.each([
    ["project", "items_hierarchy_insert", ITEM_KINDS],
    ["project", "items_hierarchy_update", ITEM_KINDS],
    ["project", "items_schedule_insert", ITEM_KINDS],
    ["project", "items_schedule_update", ITEM_KINDS],
    ["owner", "item_persons_one_owner", ITEM_PERSON_ROLES],
    ["typed", "capture_parts_one_typed", PART_KINDS],
    ["capture", "captures", SOURCE_KINDS],
    ["undo", "operations_state_guard", OPERATION_KINDS],
    ["command", "operations_insert_guard", OPERATION_ORIGINS],
    ["staged", "operations_insert_guard", OPERATION_STATES],
    ["proposed", "operations_pending", OPERATION_STATES],
    ["invalid", "operations_pending", OPERATION_STATES],
    ["applied", "operations_state_guard", OPERATION_STATES],
    ["rejected", "operations_state_guard", OPERATION_STATES],
    ["undone", "operations_state_guard", OPERATION_STATES],
    ["running", "runs_running", RUN_STATES],
    ["committed", "runs_one_commit_per_job", RUN_STATES],
    ["failed", "runs", RUN_STATES],
    ["queued", "queue_jobs_due", JOB_STATES],
    ["running", "queue_jobs_running", JOB_STATES],
  ] as [string, string, readonly string[]][])("%s, which %s spells out, is in its list", (word, object, list) => {
    expect(list).toContain(word);
    expect(sqlOf(object)).toContain(`'${word}'`);
  });
});

describe("the kinds of entity", () => {
  it("name every table that operations change, in the singular, and the capture for its event date", () => {
    // A table that operations change is one whose rows an effect can name: it has a text id of
    // its own and is neither raw material nor work in progress nor the journal itself.
    const ledgered = [
      "items",
      "item_descriptions",
      "item_aliases",
      "item_persons",
      "persons",
      "person_aliases",
      "mentions",
      "facts",
      "fact_persons",
      "source_links",
    ];
    const singular = (table: string) => table.slice(0, table.endsWith("ses") ? -2 : -1);

    expect([...ENTITY_KINDS]).toEqual([...ledgered.map(singular), "capture"]);
    for (const table of ledgered) expect(sqlOf(table), table).toContain("CREATE TABLE");
  });
});
