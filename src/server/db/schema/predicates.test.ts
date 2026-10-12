import { and, asc, count, desc, eq, inArray, lt, lte, not, or, type SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { afterAll, describe, expect, it } from "vitest";
import { instantOf } from "../../../shared/time.ts";
import { DEFAULT_ITEM_IMPORTANCE } from "../../../shared/vocabulary.ts";
import type { Db } from "../handle.ts";
import { createTestDatabase } from "../testing.ts";
import {
  captureParts,
  itemIsActive,
  itemPersonIsOwner,
  itemPersons,
  items,
  jobIsQueued,
  jobIsRunning,
  mentionIsUnresolved,
  mentions,
  operationIsJournalEntry,
  operationIsPending,
  operations,
  partIsTyped,
  queueJobs,
  runIsCommitted,
  runIsRunning,
  runs,
} from "./index.ts";

const database = createTestDatabase();
const { db, connection } = database;

afterAll(() => {
  database.close();
});

const NOW = instantOf(new Date("2026-10-11T08:00:00.000Z"));

interface Query {
  toSQL(): { sql: string; params: unknown[] };
}

interface Case {
  fragment: SQL;
  /** The partial indexes whose condition holds the fragment's. */
  indexes: string[];
  /** A read that the application makes with the fragment, and the index it has to use. */
  query: (db: Db) => Query;
  uses: string;
}

const CASES: Record<string, Case> = {
  // The counter of the Inbox.
  operationIsPending: {
    fragment: operationIsPending,
    indexes: ["operations_pending"],
    query: (db) => db.select({ n: count() }).from(operations).where(operationIsPending),
    uses: "operations_pending",
  },
  // The journal, newest first.
  operationIsJournalEntry: {
    fragment: operationIsJournalEntry,
    indexes: ["operations_journal"],
    query: (db) =>
      db
        .select({ id: operations.id })
        .from(operations)
        .where(operationIsJournalEntry)
        .orderBy(desc(operations.appliedAt))
        .limit(50),
    uses: "operations_journal",
  },
  // The worker's claim: the oldest job that is due.
  jobIsQueued: {
    fragment: jobIsQueued,
    indexes: ["queue_jobs_due", "queue_jobs_one_queued_per_key"],
    query: (db) =>
      db
        .select({ id: queueJobs.id })
        .from(queueJobs)
        .where(and(jobIsQueued, lte(queueJobs.runAfter, NOW)))
        .orderBy(asc(queueJobs.runAfter))
        .limit(1),
    uses: "queue_jobs_due",
  },
  // The lease check: jobs whose worker is gone.
  jobIsRunning: {
    fragment: jobIsRunning,
    indexes: ["queue_jobs_running"],
    query: (db) =>
      db
        .select({ id: queueJobs.id })
        .from(queueJobs)
        .where(and(jobIsRunning, lt(queueJobs.leasedUntil, NOW))),
    uses: "queue_jobs_running",
  },
  // Start-up: runs that a killed process left behind.
  runIsRunning: {
    fragment: runIsRunning,
    indexes: ["runs_running", "runs_one_running_per_job"],
    query: (db) => db.select({ id: runs.id }).from(runs).where(runIsRunning),
    uses: "runs_running",
  },
  // Was this job committed already?
  runIsCommitted: {
    fragment: runIsCommitted,
    indexes: ["runs_one_commit_per_job"],
    query: (db) =>
      db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.jobId, "job_a"), runIsCommitted)),
    uses: "runs_one_commit_per_job",
  },
  // What I am waiting for.
  itemIsActive: {
    fragment: itemIsActive,
    indexes: ["items_active"],
    query: (db) =>
      db
        .select({ id: items.id })
        .from(items)
        .where(and(itemIsActive, eq(items.myRole, "waiting"))),
    uses: "items_active",
  },
  // The owner of an item.
  itemPersonIsOwner: {
    fragment: itemPersonIsOwner,
    indexes: ["item_persons_one_owner"],
    query: (db) =>
      db
        .select({ personId: itemPersons.personId })
        .from(itemPersons)
        .where(and(eq(itemPersons.itemId, "itm_a"), itemPersonIsOwner)),
    uses: "item_persons_one_owner",
  },
  // Which other mentions were waiting for the same name?
  mentionIsUnresolved: {
    fragment: mentionIsUnresolved,
    indexes: ["mentions_unresolved"],
    query: (db) =>
      db
        .select({ id: mentions.id })
        .from(mentions)
        .where(and(mentionIsUnresolved, eq(mentions.baseNorm, "kasia"))),
    uses: "mentions_unresolved",
  },
  // The owner's own words in an input.
  partIsTyped: {
    fragment: partIsTyped,
    indexes: ["capture_parts_one_typed"],
    query: (db) =>
      db
        .select({ text: captureParts.text })
        .from(captureParts)
        .where(and(eq(captureParts.captureId, "cap_a"), partIsTyped)),
    uses: "capture_parts_one_typed",
  },
};
const NAMES = Object.keys(CASES);
const caseOf = (name: string) => CASES[name] as Case;

const dialect = new SQLiteSyncDialect();
const plain = (sql: string) => sql.replace(/"/g, "").replace(/\s+/g, " ").trim();
/** The condition of a partial index, as the database holds it. */
const conditionOf = (index: string) =>
  / WHERE (.*)$/.exec(
    plain(
      (connection.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?").pluck().get(index) as
        | string
        | undefined) ?? "",
    ),
  )?.[1];
interface Plan {
  detail: string;
}
/** How SQLite means to run a query: one line for every table it reads. */
const planOf = (query: Query) => {
  const { sql, params } = query.toSQL();
  return (connection.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Plan[]).map((row) => row.detail);
};

describe("the conditions of the partial indexes", () => {
  it("are all tried here", async () => {
    const exported = Object.entries(await import("./predicates.ts")).map(([name]) => name);

    expect(NAMES.sort()).toEqual(exported.sort());
  });

  it.each(NAMES)("%s spells its words into the SQL text and binds no value", (name) => {
    const { sql, params } = dialect.sqlToQuery(caseOf(name).fragment);

    expect(params).toEqual([]);
    expect(sql).not.toContain("?");
    // In parentheses, so that not() and or() apply to the whole of it.
    expect(sql).toMatch(/^\(.*\)$/);
  });

  it.each(NAMES)("%s is the condition, or a part of the condition, of its indexes", (name) => {
    const { fragment, indexes } = caseOf(name);
    const table = /^\("?(\w+)"?\./.exec(dialect.sqlToQuery(fragment).sql)?.[1] ?? "";
    // The fragment names its columns with their table, the index does not.
    const condition = plain(dialect.sqlToQuery(fragment).sql).slice(1, -1).replaceAll(`${table}.`, "");

    expect(table).not.toBe("");
    expect(indexes.length).toBeGreaterThan(0);
    for (const index of indexes) expect(conditionOf(index), index).toContain(condition);
  });

  it.each(NAMES)("%s lets a query use its index", (name) => {
    const { query, uses } = caseOf(name);
    const plan = planOf(query(db));

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatch(new RegExp(`USING (COVERING )?INDEX ${uses}\\b`));
  });

  // A fragment that is the whole condition of an index is enough for a query to use it. One is
  // only a part of the condition of its index, and a query that has nothing else reads the table.
  it.each(NAMES)("%s, with nothing beside it, uses an index exactly when it is the whole condition of one", (name) => {
    const { fragment, indexes } = caseOf(name);
    const { sql } = dialect.sqlToQuery(fragment);
    const table = /^\("?(\w+)"?\./.exec(sql)?.[1] ?? "";
    const whole = indexes.some((index) => conditionOf(index) === plain(sql).slice(1, -1).replaceAll(`${table}.`, ""));

    const plan = (connection.prepare(`EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE ${sql}`).all() as Plan[]).map(
      (row) => row.detail,
    );

    expect(plan).toHaveLength(1);
    expect(/USING (COVERING )?INDEX /.test(plan[0] ?? ""), plan[0]).toBe(whole);
    expect(whole).toBe(name !== "runIsCommitted");
  });

  // What the fragments are for. Asked with the states as values, the same question cannot use
  // the index: when the query is planned nobody knows which states the values will be.
  it("are needed: the counter of the Inbox reads every operation when its states are bound values", () => {
    const bound = db
      .select({ n: count() })
      .from(operations)
      .where(inArray(operations.state, ["proposed", "invalid"]));

    expect(bound.toSQL().params).toEqual(["proposed", "invalid"]);
    expect(planOf(bound)).toEqual(["SCAN operations"]);
  });
});

describe("a condition of two parts", () => {
  const at = instantOf(new Date("2026-10-11T08:00:00.000Z"));
  const closedAt = instantOf(new Date("2026-10-12T08:00:00.000Z"));
  const item = (id: `itm_${string}`, title: string) => ({
    id,
    kind: "task" as const,
    title,
    titleNorm: title,
    status: "todo" as const,
    importance: DEFAULT_ITEM_IMPORTANCE,
    isMilestone: 0 as const,
    createdAt: at,
    lastActivityAt: at,
  });
  const ids = (condition: SQL | undefined) =>
    db
      .select({ id: items.id })
      .from(items)
      .where(condition)
      .orderBy(items.id)
      .all()
      .map((row) => row.id);

  it("keeps its meaning under not() and beside or()", () => {
    db.insert(items)
      .values([
        item("itm_active", "active"),
        { ...item("itm_closed", "closed"), status: "done", closedAt },
        item("itm_merged", "merged"),
      ])
      .run();
    db.update(items).set({ mergedIntoId: "itm_active" }).where(eq(items.id, "itm_merged")).run();

    expect(ids(itemIsActive)).toEqual(["itm_active"]);
    expect(ids(not(itemIsActive))).toEqual(["itm_closed", "itm_merged"]);
    expect(ids(or(eq(items.id, "itm_closed"), itemIsActive))).toEqual(["itm_active", "itm_closed"]);
    expect(ids(and(not(itemIsActive), eq(items.status, "todo")))).toEqual(["itm_merged"]);
  });
});
