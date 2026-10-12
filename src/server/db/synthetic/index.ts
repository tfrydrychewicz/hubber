// Synthetic data: a hub that was used for a while, generated from a scale, a seed and "now".
// For tests, for the measurement of performance and for looking at the views with years of
// history behind them. The data is invented. A given name and a surname that chance paired can
// be the name of a person who exists; nothing else of a real person or project is in the data.
import { createHash } from "node:crypto";
import { getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { foldName } from "../../../shared/fold.ts";
import type { CaptureId, ItemId, PersonId } from "../../../shared/ids.ts";
import { type Day, type Instant, instantOf, periodEnd, periodStart } from "../../../shared/time.ts";
import { DATE_PRECISIONS, NAMED_PERIODS, type NamedPeriod } from "../../../shared/vocabulary.ts";
import type { Db } from "../handle.ts";
import { MIGRATIONS_TABLE } from "../migrate.ts";
import * as schema from "../schema/index.ts";
import { SCALES, type Scale, type ScaleName } from "./scale.ts";
import { createWorld, type LedgeredKind, type WorldSummary } from "./world.ts";
import { createWriter, isDerived, LEDGERED_TABLES } from "./writer.ts";

export { SCALES, type Scale, type ScaleName } from "./scale.ts";

/** The seed and the "now" of a world that names neither: fixed, so that "due today" never goes stale. */
export const DEFAULT_SEED = 1;
export const DEFAULT_NOW = "2026-10-14T17:30:00.000Z";
/**
 * The first and the last instant that a command takes for "now". The clock of the world counts
 * from 1970, and a history reaches three years back from its end: a history that ended earlier
 * would have its operations applied after its own "now". The database takes days up to the year
 * 9999, and the plans of a world reach less than two years past its end: ten years are left free.
 */
export const EARLIEST_NOW = "1980-01-01T00:00:00.000Z" as Instant;
export const LATEST_NOW = "9989-12-31T23:59:59.999Z" as Instant;
/** How many days of history go into one transaction. */
const BATCH_DAYS = 30;

export interface GenerateOptions {
  /** One of the three scales by its name, or a scale of the caller's own. */
  scale: ScaleName | Scale;
  seed?: number;
  /** The instant the history ends at. */
  now?: Date;
  /** Days of history in a transaction. The content of the database does not depend on it. */
  batchDays?: number;
}

/** What was generated, and the rows that a test addresses by their role. */
export interface SyntheticManifest {
  seed: number;
  now: Instant;
  days: number;
  /** The number of rows of every table of the application, by its name. */
  rows: Record<string, number>;
  /** The owner. */
  me: PersonId;
  /** The project with the longest history: thousands of rows in its tree, and every eighth link. */
  busiestItem: ItemId;
  /** The newest capture whose card still has something to decide. */
  openCardSource: CaptureId | undefined;
}

/** The tables that Drizzle declares, by their names in the database. */
const TABLES = new Map(
  (Object.values(schema).filter((value) => is(value, SQLiteTable)) as SQLiteTable[]).map((table) => [
    getTableName(table),
    table,
  ]),
);
// The tables of words are filled by the migrations: a vocabulary and a list of states have a
// column "code" for their key, and no other table has one.
const isVocabulary = (table: SQLiteTable): boolean => "code" in getTableColumns(table);
/** The tables that hold what a hub was used for, in the order of their names. */
export const DATA_TABLES: readonly string[] = [...TABLES]
  .filter(([, table]) => !isVocabulary(table))
  .map(([name]) => name)
  .sort();

const count = (db: Db, table: string): number =>
  (db.get<{ rows: number }>(sql.raw(`SELECT count(*) AS rows FROM "${table}"`)) as { rows: number }).rows;

/** The first table that holds what a hub was used for and has a row, or undefined for a database that was never used. */
export function usedTable(db: Db): string | undefined {
  return DATA_TABLES.find((table) => db.get(sql.raw(`SELECT 1 FROM "${table}" LIMIT 1`)) !== undefined);
}

/** The database was used already: synthetic data goes into an empty one only. */
export class DatabaseInUseError extends Error {
  override name = "DatabaseInUseError";
  /** A table that has rows. */
  readonly table: string;

  constructor(table: string) {
    super(`The database holds data already (table ${table}); synthetic data goes into an empty database only.`);
    this.table = table;
  }
}

/**
 * Fills a database that was never used with the history of a hub: persons, projects and tasks in
 * trees, captures with their processing, and the journal of every change. Every row goes through
 * the guards of the schema, as the application writes it. The same scale, seed and "now" give the
 * same content, whatever the size of the transactions.
 *
 * Throws DatabaseInUseError, before it writes anything, for a database that holds data.
 */
export function generateSynthetic(db: Db, options: GenerateOptions): SyntheticManifest {
  const scale: Scale = typeof options.scale === "string" ? SCALES[options.scale] : options.scale;
  const seed = options.seed ?? DEFAULT_SEED;
  const now = options.now ?? new Date(DEFAULT_NOW);
  const batchDays = Math.max(1, Math.floor(options.batchDays ?? BATCH_DAYS));
  const used = usedTable(db);
  if (used !== undefined) throw new DatabaseInUseError(used);

  const world = createWorld({ scale, seed, now: now.getTime() }, createWriter(db));
  let summary: WorldSummary | undefined;
  for (let from = 0; from < scale.days; from += batchDays) {
    const to = Math.min(scale.days, from + batchDays);
    // A commit waits for the drive whatever its size, so a month of history shares one.
    db.transaction(
      () => {
        for (let day = from; day < to; day++) world.day(day);
        if (to === scale.days) summary = world.finish();
      },
      { behavior: "immediate" },
    );
  }
  if (summary === undefined) throw new Error("A scale needs at least one day of history.");
  return {
    seed,
    now: instantOf(now),
    days: scale.days,
    rows: Object.fromEntries([...TABLES.keys()].sort().map((table) => [table, count(db, table)])),
    ...summary,
  };
}

/** The tables of the application as the database lists them: also one that a later migration added. */
function applicationTables(db: Db): string[] {
  return db
    .all<{ name: string }>(
      // Left out, as in the fingerprint of the schema: the tables of other layers, whose rows say
      // when a workspace was made and migrated, and SQLite's own.
      sql`SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
             AND name NOT IN ('workspace_pin', ${MIGRATIONS_TABLE})
           ORDER BY name`,
    )
    .map(({ name }) => name);
}

/**
 * The content of a database as one hash: every table of the application in the order of its name,
 * every row in the order of its key, every column. Two databases with the same rows give the same
 * hash, however and in whatever order they were written.
 */
export function contentHash(db: Db): string {
  const hash = createHash("sha256");
  for (const table of applicationTables(db)) {
    const key = db
      .all<{ name: string }>(sql`SELECT name FROM pragma_table_info(${table}) WHERE pk > 0 ORDER BY pk`)
      .map(({ name }) => `"${name}"`);
    hash.update(`\u0000${table}\u0000`);
    const rows = db.values(sql.raw(`SELECT * FROM "${table}" ORDER BY ${key.length === 0 ? "rowid" : key.join(", ")}`));
    for (const row of rows) hash.update(`${JSON.stringify(row)}\n`);
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------------------------------
// What must hold of generated data, and of any database the application has written. Each of these
// is a rule that no CHECK and no foreign key holds: integrity_check and foreign_key_check pass on
// a database that breaks every one of them.
// ---------------------------------------------------------------------------------------------------

/**
 * The rules of the hierarchy as a question to the rows that are there: projects with a parent,
 * items that reach no top (they sit on a circle, or under one), and items directly under a merged
 * item. The walk goes down from the tops, so it ends on any data.
 */
export const TREE_INVARIANT = `WITH RECURSIVE reached (id) AS (
    SELECT id FROM items WHERE parent_id IS NULL
    UNION ALL
    SELECT c.id FROM reached JOIN items c ON c.parent_id = reached.id)
SELECT (SELECT count(*) FROM items WHERE kind = 'project' AND parent_id IS NOT NULL) AS projects_with_a_parent,
       (SELECT count(*) FROM items WHERE id NOT IN (SELECT id FROM reached)) AS items_that_reach_no_top,
       (SELECT count(*) FROM items c JOIN items p ON p.id = c.parent_id WHERE p.merged_into_id IS NOT NULL) AS items_under_a_merged_item`;

/** The three rules of the schedule that the triggers hold for a row that is written. */
export const SCHEDULE_INVARIANT = `SELECT count(*) AS broken FROM items
 WHERE (start_on_precision IS NOT NULL AND start_on IS NULL)
    OR (due_on_precision IS NOT NULL AND due_on IS NULL)
    OR (is_milestone = 1 AND (start_on IS NOT NULL OR kind = 'project'))`;

const none = (db: Db, query: string): boolean => {
  const counts = db.get<Record<string, number>>(sql.raw(query)) ?? {};
  return Object.values(counts).every((found) => found === 0);
};

/** A day with a named period is a boundary of that period, and every precision is one the code knows. */
function scheduleHolds(db: Db): boolean {
  if (!none(db, SCHEDULE_INVARIANT)) return false;
  const precise = db.all<{ startOn: Day | null; start: string | null; dueOn: Day | null; due: string | null }>(
    sql`SELECT start_on AS startOn, start_on_precision AS start, due_on AS dueOn, due_on_precision AS due
          FROM items WHERE start_on_precision IS NOT NULL OR due_on_precision IS NOT NULL`,
  );
  const known = (precision: string | null) =>
    precision === null || (DATE_PRECISIONS as readonly string[]).includes(precision);
  const named = (precision: string | null): precision is NamedPeriod =>
    (NAMED_PERIODS as readonly (string | null)[]).includes(precision);
  return precise.every(
    ({ startOn, start, dueOn, due }) =>
      known(start) &&
      known(due) &&
      (!named(start) || (startOn !== null && periodStart(startOn, start) === startOn)) &&
      (!named(due) || (dueOn !== null && periodEnd(dueOn, due) === dueOn)),
  );
}

/**
 * The effects are true: replayed in the order of their ids, on nothing, they give the ledgered
 * tables as they stand, and each one finds the row as its own "before" says.
 *
 * A row is compared column by column. The order in which an image lists its columns says nothing,
 * and a column that an image lacks was NULL when the image was written: a later migration added
 * it. A column that the table does not store, or that follows from the others, is in no image.
 * An effect on a row of a table that is not replayed here, the day that a capture is about for
 * one, is passed over.
 */
function effectsHold(db: Db): boolean {
  const replayed = new Map<string, Map<string, Record<string, unknown>>>(
    Object.keys(LEDGERED_TABLES).map((kind) => [kind, new Map()]),
  );
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const sameRow = (a: Record<string, unknown>, b: Record<string, unknown>): boolean =>
    [...new Set([...Object.keys(a), ...Object.keys(b)])].every((column) => same(a[column], b[column]));
  interface Effect {
    id: number;
    kind: string;
    entity: string;
    change: string;
    field: string | null;
    before: string | null;
    after: string | null;
  }
  // Read in pieces, in the order of the key: the journal of three years is half a million effects.
  for (let last = 0; ; ) {
    const effects = db.all<Effect>(
      sql`SELECT id, entity_kind AS kind, entity_id AS entity, change, field, before_value AS before, after_value AS after
            FROM operation_effects WHERE id > ${last} ORDER BY id LIMIT 20000`,
    );
    if (effects.length === 0) break;
    for (const effect of effects) {
      last = effect.id;
      const rows = replayed.get(effect.kind);
      if (rows === undefined) continue;
      const row = rows.get(effect.entity);
      if (effect.change === "create") {
        if (row !== undefined || effect.after === null) return false;
        rows.set(effect.entity, JSON.parse(effect.after) as Record<string, unknown>);
      } else if (row === undefined) return false;
      else if (effect.change === "delete") {
        if (effect.before === null || !sameRow(JSON.parse(effect.before) as Record<string, unknown>, row)) return false;
        rows.delete(effect.entity);
      } else if (effect.change === "update") {
        if (effect.field === null || effect.before === null || effect.after === null) return false;
        if (!same(JSON.parse(effect.before), row[effect.field])) return false;
        row[effect.field] = JSON.parse(effect.after);
      }
    }
  }
  for (const kind of Object.keys(LEDGERED_TABLES) as LedgeredKind[]) {
    const rows = replayed.get(kind) as Map<string, Record<string, unknown>>;
    const stored = db.all<Record<string, unknown>>(sql.raw(`SELECT * FROM "${getTableName(LEDGERED_TABLES[kind])}"`));
    if (stored.length !== rows.size) return false;
    for (const row of stored) {
      const recorded = Object.fromEntries(Object.entries(row).filter(([column]) => !isDerived(column)));
      const image = rows.get(row.id as string);
      if (image === undefined || !sameRow(image, recorded)) return false;
    }
  }
  return true;
}

/** The columns that hold a folded spelling, each with the column whose text it is the folding of. */
const FOLDED_COLUMNS = [
  ["items", "title", "title_norm"],
  ["persons", "name", "name_norm"],
  ["item_aliases", "alias", "alias_norm"],
  ["person_aliases", "alias", "alias_norm"],
  ["mentions", "base_form", "base_norm"],
] as const;

/** Every folded spelling is what foldName() makes of the text beside it; where there is no text, there is none. */
function foldedNamesHold(db: Db): boolean {
  return FOLDED_COLUMNS.every(([table, text, folded]) =>
    db
      .all<{ text: string | null; folded: string | null }>(
        sql.raw(`SELECT "${text}" AS text, "${folded}" AS folded FROM "${table}"`),
      )
      .every((row) => row.folded === (row.text === null ? null : foldName(row.text))),
  );
}

const INVARIANTS: readonly { name: string; holds: (db: Db) => boolean }[] = [
  // The schedule of an item: a precision is about a day that is set, a milestone has no start and
  // is no project, and a day with a named period is on the boundary of that period.
  { name: "schedule", holds: scheduleHolds },
  // The items are a forest, projects are its tops, and nothing sits directly under a merged item.
  { name: "tree", holds: (db) => none(db, TREE_INVARIANT) },
  // The date of last activity of an item is the instant of the newest operation in force that concerned it.
  {
    name: "last activity",
    holds: (db) =>
      none(
        db,
        `SELECT count(*) AS broken FROM items i
          WHERE i.last_activity_at IS NOT max(i.created_at, coalesce(
                  (SELECT max(o.applied_at) FROM operation_effects e JOIN operations o ON o.id = e.operation_id
                    WHERE e.item_id = i.id AND o.state = 'applied' AND o.kind <> 'undo'), i.created_at))`,
      ),
  },
  { name: "effects", holds: effectsHold },
  // An effect on an item or on a person is anchored at that row: the timeline, the filters of the
  // journal and the date of last activity go by the anchor, and the database takes any.
  {
    name: "anchors",
    holds: (db) =>
      none(
        db,
        `SELECT count(*) AS broken FROM operation_effects
          WHERE (entity_kind = 'item' AND item_id IS NOT entity_id)
             OR (entity_kind = 'person' AND person_id IS NOT entity_id)`,
      ),
  },
  // A name is looked up by its folded spelling, which no rule of the database compares with the name.
  { name: "folded names", holds: foldedNamesHold },
  // An operation that is marked undone was taken back by the undo it points at. The database asks
  // only that the undo is there and applied; which operations an undo takes back is said by its
  // payload, in the list "operations".
  {
    name: "undone operations",
    holds: (db) =>
      none(
        db,
        `SELECT count(*) AS broken FROM operations o
          WHERE o.state = 'undone' AND NOT EXISTS (
                  SELECT 1 FROM operations u, json_each(u.payload, '$.operations') taken
                   WHERE u.id = o.undone_by_id AND u.kind = 'undo' AND u.state = 'applied' AND taken.value = o.id)`,
      ),
  },
  // Nothing is left staged once its run has ended: a view would never show it, and nothing could move it on.
  {
    name: "staged operations",
    holds: (db) =>
      none(
        db,
        `SELECT count(*) AS broken FROM operations o
          WHERE o.state = 'staged' AND (SELECT r.state FROM runs r WHERE r.id = o.run_id) IS NOT 'running'`,
      ),
  },
  // Every quote of a fact and every name of a mention stands, word for word, in the text of its source.
  {
    name: "quotes",
    holds: (db) =>
      none(
        db,
        `SELECT (SELECT count(*) FROM facts f WHERE f.quote IS NOT NULL AND NOT EXISTS (
                   SELECT 1 FROM capture_parts p WHERE p.capture_id = f.source_id AND (instr(p.text, f.quote) > 0
                      OR EXISTS (SELECT 1 FROM capture_part_texts t WHERE t.part_id = p.id AND instr(t.text, f.quote) > 0)))) AS facts,
                (SELECT count(*) FROM mentions m WHERE NOT EXISTS (
                   SELECT 1 FROM capture_parts p WHERE p.capture_id = m.source_id AND (instr(p.text, m.surface) > 0
                      OR EXISTS (SELECT 1 FROM capture_part_texts t WHERE t.part_id = p.id AND instr(t.text, m.surface) > 0)))) AS mentions`,
      ),
  },
];

/** The names of the invariants that the database breaks; none for a database that is sound. */
export function checkInvariants(db: Db): string[] {
  return INVARIANTS.filter(({ holds }) => !holds(db)).map(({ name }) => name);
}
