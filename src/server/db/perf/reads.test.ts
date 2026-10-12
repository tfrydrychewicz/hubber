// The plan of a query depends on the schema and on the text of the query and, while the database
// has no statistics, on nothing else: what is asserted here on thirty days of history holds on
// three years of it, and needs no clock.
import { afterAll, describe, expect, it } from "vitest";
import type { ItemId } from "../../../shared/ids.ts";
import { generateSynthetic } from "../synthetic/index.ts";
import { createSyntheticTestDatabase } from "../synthetic/testing.ts";
import { createTestDatabase } from "../testing.ts";
import { compiled, explain } from "./plans.ts";
import {
  ABOVE_WITH_A_CONDITION_ON_THE_PARENT,
  CARDS_WITH_A_PLAIN_JOIN,
  CHART_WITH_A_PLAIN_JOIN,
  INDEXES_OF_WHAT_IS_OPEN,
  planProblems,
  READS,
  readContext,
} from "./reads.ts";

const world = createSyntheticTestDatabase();
const { connection, db, manifest } = world;
const context = readContext(db, manifest);

afterAll(() => {
  world.close();
});

const read = (name: string) => {
  const found = READS.find((candidate) => candidate.name.startsWith(name));
  if (found === undefined) throw new Error(`No read is called "${name}".`);
  return found;
};
const rowsOf = <Row>(name: string): Row[] => db.all<Row>(read(name).query(context));

interface Item {
  id: string;
  kind: string;
  parent_id: string | null;
  status: string;
  importance: string;
  health: string | null;
  start_on: string | null;
  due_on: string | null;
  is_milestone: number;
  closed_at: string | null;
  merged_into_id: string | null;
  last_activity_at: string;
}
const ITEMS =
  "SELECT id, kind, parent_id, status, importance, health, start_on, due_on, is_milestone, closed_at, merged_into_id, last_activity_at FROM items";
const items = connection.prepare(ITEMS).all() as Item[];
const byId = new Map(items.map((item) => [item.id, item]));
/** The item and everything under it, found the plain way: by asking every item for its parent. */
const under = (root: string): string[] => {
  const found = [root];
  for (const id of found) {
    found.push(...items.filter((item) => item.parent_id === id && item.merged_into_id === null).map((item) => item.id));
  }
  return found;
};
/** The items above the given one, from the nearest to the top. */
const above = (id: string): string[] => {
  const found: string[] = [];
  for (let parent = byId.get(id)?.parent_id ?? null; parent !== null; parent = byId.get(parent)?.parent_id ?? null) {
    found.push(parent);
  }
  return found;
};

describe("the representative reads", () => {
  it("are told apart by their names, and each says whose view asks it", () => {
    const names = READS.map(({ name }) => name);

    expect(new Set(names).size).toBe(names.length);
    for (const { name, owner } of READS) expect(owner, name).toMatch(/^M\d[a-c]?-\d+(, M\d[a-c]?-\d+)*$/);
  });

  it.each(READS.map((one) => [one.name, one] as const))(
    "%s: goes through its indexes and reads no table from end to end",
    (_name, one) => {
      expect(planProblems(explain(connection, one.query(context)), one)).toEqual([]);
    },
  );

  it("walk a whole table in three reads only, each of them on purpose", () => {
    expect(READS.filter(({ walks }) => walks !== undefined).map(({ name, walks }) => [name, walks])).toEqual([
      ["items: closed in the last thirty days, for the check of duplicates", "i"],
      ["persons: everyone with their aliases, for the agent's index", "p"],
      ["costs: the tokens of the last thirty days, by day and role", "m"],
    ]);
  });

  it("hold two reads to no budget, the two that return the whole history of the busiest item", () => {
    const unbounded = READS.filter((one) => one.unbounded === true);

    expect(unbounded.map(({ name }) => name)).toEqual([
      "item: all its facts, with their source",
      "item: the whole history of the changes of its fields",
    ]);
    // Whole: the item is all that is bound in either, nothing of "now", and neither stops at a number of rows.
    for (const one of unbounded) {
      const { sql, params } = compiled(one.query(context));
      expect(params, one.name).toEqual([context.tree]);
      expect(sql, one.name).not.toMatch(/\blimit\b/i);
    }
    // The control: a read of the last thirty days binds the instant they begin at, and has a budget.
    const lastThirtyDays = read("item: the changes of its fields in the last thirty days");
    expect(compiled(lastThirtyDays.query(context)).params).toEqual([context.tree, context.since]);
    expect(lastThirtyDays.unbounded).toBeUndefined();
  });

  it("mark the one read whose time grows with the history: it reads the whole log of calls, and has a budget", () => {
    const growing = READS.filter((one) => one.wholeHistory === true);

    expect(growing.map(({ name, walks, unbounded }) => [name, walks, unbounded])).toEqual([
      ["costs: the tokens of the last thirty days, by day and role", "m", undefined],
    ]);
  });

  // A read that finds nothing is fast for the wrong reason, and its measurement says nothing.
  it("each find rows in the world they are measured on, but for two that a month of history is too short for", () => {
    const empty = READS.filter((one) => db.all(one.query(context)).length === 0).map(({ name }) => name);

    expect(manifest.days).toBe(30);
    expect(empty).toEqual(["item: the applied changes of its due day in the last two weeks", "person: what I owe her"]);
  });
});

describe("readContext", () => {
  it("has an operation to ask about also where nothing has changed the busiest item yet", () => {
    // Five days of this seed: no field of the largest project was changed in them.
    const short = createTestDatabase();
    const world = generateSynthetic(short.db, { scale: "tiny", seed: 7 });
    const changes = short.connection
      .prepare(
        "SELECT count(*) FROM operation_effects WHERE item_id = ? AND entity_kind = 'item' AND change = 'update'",
      )
      .pluck();

    const asked = readContext(short.db, world);

    expect(changes.get(world.busiestItem)).toBe(0);
    for (const [name, value] of Object.entries(asked)) expect(value, name).toBeDefined();
    // Every read can be asked, and the two that ask about the operation find what it did.
    for (const one of READS) expect(() => short.db.all(one.query(asked)), one.name).not.toThrow();
    expect(short.db.all(read("journal: what one entry did").query(asked)).length).toBeGreaterThan(0);
    expect(short.db.all(read("undo: the later changes").query(asked))).toBeDefined();
    short.close();
  });
});

describe("the indexes of what is open", () => {
  it("are partial: each holds the rows of one state and no others", () => {
    const partial = connection
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND sql LIKE '% WHERE %'")
      .pluck()
      .all() as string[];

    expect(partial).toEqual(expect.arrayContaining([...INDEXES_OF_WHAT_IS_OPEN]));
  });
});

describe("a read over a tree", () => {
  it("returns the item and everything under it, each with its depth", () => {
    const rows = rowsOf<{ id: string; depth: number; health: string | null }>("tree: the rows of the chart");

    expect(rows.map(({ id }) => id).sort()).toEqual(under(context.tree).sort());
    expect(rows.length).toBeGreaterThan(20);
    for (const { id, depth } of rows) expect(depth, id).toBe(above(id).length);
    // A row says how its item is doing, a task as well as the project: the chart marks it.
    for (const { id, health } of rows) expect([id, health]).toEqual([id, byId.get(id)?.health]);
    expect(rows.filter(({ id, health }) => health !== null && byId.get(id)?.kind === "task").length).toBeGreaterThan(0);
    // The largest tree of the world reaches the deepest level there is.
    expect(Math.max(...rows.map(({ depth }) => depth))).toBeGreaterThanOrEqual(4);
  });

  it("leaves out an item that was merged into another: it is a signpost, not a row of the plan", () => {
    const merged = items.find((item) => item.merged_into_id !== null && item.parent_id !== null) as Item;
    const top = above(merged.id).at(-1) as ItemId;

    const rows = db.all<{ id: string }>(read("tree: the rows of the chart").query({ ...context, tree: top }));

    expect(rows.map(({ id }) => id).sort()).toEqual(under(top).sort());
    expect(rows.map(({ id }) => id)).not.toContain(merged.id);
    expect(rows.map(({ id }) => id)).toContain(merged.parent_id);
  });

  it("finds the top of the tree from any item in it, and then the open milestones of all of it", () => {
    const rows = rowsOf<{ id: string }>("tree: the open milestones of the whole tree");
    const whole = under(context.tree).map((id) => byId.get(id) as Item);

    expect(above(context.deepest).at(-1)).toBe(context.tree);
    expect(rows.map(({ id }) => id).sort()).toEqual(
      whole
        .filter((item) => item.is_milestone === 1 && item.closed_at === null)
        .map(({ id }) => id)
        .sort(),
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("returns the path of an item from the top down", () => {
    const rows = rowsOf<{ id: string }>("item: the item with every item above it");

    expect(rows.map(({ id }) => id)).toEqual([...above(context.deepest).reverse(), context.deepest]);
    expect(rows.length).toBeGreaterThan(2);
  });

  it("returns every item that stands above an active one once, closed ones among them", () => {
    const rows = rowsOf<{ id: string; closed_at: string | null }>("items: every item that stands above an active one");
    const active = items.filter((item) => item.closed_at === null && item.merged_into_id === null);

    expect(rows.map(({ id }) => id).sort()).toEqual([...new Set(active.flatMap(({ id }) => above(id)))].sort());
    // The list shows them greyed out: an active item keeps its place under what was closed above it.
    expect(rows.filter(({ closed_at }) => closed_at !== null).length).toBeGreaterThan(0);
  });
});

// The plan of a read says how it finds its rows and nothing of which rows they are. Where a
// condition of a read can go without its plan changing, the rows are held here: each read against
// the same question asked of all items, one by one.
describe("the rows of a read", () => {
  const active = (item: Item) => item.closed_at === null && item.merged_into_id === null;
  /** SQLite puts the rows without a day before the others. */
  const inOrderOfTheDay = (rows: { due_on: string | null }[]): boolean =>
    rows.every((row, at) => at === 0 || (rows[at - 1]?.due_on ?? "") <= (row.due_on ?? ""));

  it("are, for the items directly under an item, those that were not merged, each with whether such an item sits under it", () => {
    const directlyUnder = read("item: the items directly under it");
    // A world of this test's own, in which one more item is merged: the only one under its parent,
    // so that the parent has something under it and nothing that counts.
    const own = createSyntheticTestDatabase();
    const lone = own.connection
      .prepare(
        `SELECT c.id, c.parent_id AS parent FROM items c JOIN items p ON p.id = c.parent_id
          WHERE p.parent_id IS NOT NULL AND c.merged_into_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM items s WHERE s.parent_id = c.parent_id AND s.id <> c.id)
            AND NOT EXISTS (SELECT 1 FROM items g WHERE g.parent_id = c.id)
          ORDER BY c.id LIMIT 1`,
      )
      .get() as { id: string; parent: string };
    own.connection
      .prepare("UPDATE items SET merged_into_id = (SELECT min(id) FROM items WHERE kind = 'project') WHERE id = ?")
      .run(lone.id);
    const all = own.connection.prepare("SELECT id, parent_id, merged_into_id FROM items").all() as Item[];
    const standing = (parent: string) =>
      all.filter((item) => item.parent_id === parent && item.merged_into_id === null);
    const parents = [...new Set(all.flatMap((item) => item.parent_id ?? []))];

    for (const parent of parents) {
      const rows = own.db.all<{ id: string; has_children: number }>(
        directlyUnder.query({ ...context, tree: parent as ItemId }),
      );
      expect(rows.map(({ id, has_children }) => `${id} ${has_children}`).sort(), parent).toEqual(
        standing(parent)
          .map(({ id }) => `${id} ${standing(id).length > 0 ? 1 : 0}`)
          .sort(),
      );
    }
    // The control: merged items still name their parents, so each of the two conditions leaves something out.
    expect(parents.filter((parent) => standing(parent).length === 0)).toContain(lone.parent);
    expect(
      parents.some(
        (parent) =>
          standing(parent).length > 0 &&
          standing(parent).length < all.filter((item) => item.parent_id === parent).length,
      ),
    ).toBe(true);
    own.close();
  });

  it("are, for the active items of a tree, the open ones under its top, in order of the due day", () => {
    const rows = rowsOf<{ id: string; due_on: string | null }>("tree: the active items of a tree");
    const open = under(context.tree)
      .map((id) => byId.get(id) as Item)
      .filter((item) => item.closed_at === null && item.id !== context.tree);

    expect(rows.map(({ id }) => id).sort()).toEqual(open.map(({ id }) => id).sort());
    expect(inOrderOfTheDay(rows)).toBe(true);
    // The control: the tree holds closed items too, which the read leaves out.
    expect(under(context.tree).length - 1).toBeGreaterThan(open.length);
    expect(open.length).toBeGreaterThan(5);
  });

  it("are, for the stale items of today, the active ones without activity, but for work that has not begun and milestones that are not due", () => {
    const stale = read("today: active items without activity for two weeks");
    // Asked as of a day in the middle of the history, with nothing counting as recent: every
    // active item is then without activity, and a good part of them lie ahead of that day.
    const asked = { ...context, today: context.sinceDay, staleBefore: context.now };
    const quiet = items.filter((item) => active(item) && item.last_activity_at < asked.staleBefore);
    const notBegun = (item: Item) => item.start_on !== null && item.start_on > asked.today;
    const notDue = (item: Item) => item.is_milestone === 1 && item.due_on !== null && item.due_on > asked.today;

    const rows = db.all<{ id: string; last_activity_at: string }>(stale.query(asked));

    expect(rows.map(({ id }) => id).sort()).toEqual(
      quiet
        .filter((item) => !notBegun(item) && !notDue(item))
        .map(({ id }) => id)
        .sort(),
    );
    expect(rows.every((row, at) => at === 0 || (rows[at - 1]?.last_activity_at ?? "") <= row.last_activity_at)).toBe(
      true,
    );
    // The control: each of the two exceptions takes items out, and items are left.
    expect(quiet.filter(notBegun).length).toBeGreaterThan(0);
    expect(quiet.filter((item) => notDue(item) && !notBegun(item)).length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("are, for what is at risk today, the active projects that are blocked and the active projects and tasks in a health of concern, the worst first", () => {
    const rows = rowsOf<{ id: string; kind: string; parent_id: string | null; health: string | null }>(
      "today: blocked projects, and projects and tasks whose health is yellow or red",
    );
    const severities = new Map(
      (connection.prepare("SELECT code, severity FROM item_healths").all() as { code: string; severity: number }[]).map(
        ({ code, severity }) => [code, severity],
      ),
    );
    const severityOf = (item: { health: string | null }) => severities.get(item.health ?? "") ?? 0;
    const blockedProject = (item: Item) => item.kind === "project" && item.status === "blocked";
    const listed = items.filter((item) => active(item) && (blockedProject(item) || severityOf(item) > 0));

    expect(rows.map(({ id }) => id).sort()).toEqual(listed.map(({ id }) => id).sort());
    // The worst first: by the severity of the health, which the vocabulary gives and the order of its codes does not.
    expect(rows.map(severityOf)).toEqual(rows.map(severityOf).sort((a, b) => b - a));
    expect([...severities].sort(([, a], [, b]) => b - a).map(([code]) => code)).toEqual(["red", "yellow", "green"]);
    // A row says what it is and what it sits under: the list holds projects and tasks.
    for (const { id, kind, parent_id } of rows) {
      expect([kind, parent_id], id).toEqual([byId.get(id)?.kind, byId.get(id)?.parent_id]);
    }
    // The control: projects and tasks in either health of concern are on the list, a milestone and a
    // task under a task among them, and a project that is blocked and of no concern otherwise.
    expect([...new Set(listed.map(({ kind, health }) => `${kind} ${health}`))]).toEqual(
      expect.arrayContaining(["project green", "project yellow", "task red", "task yellow"]),
    );
    expect(listed.some((item) => item.is_milestone === 1)).toBe(true);
    expect(listed.some((item) => byId.get(item.parent_id ?? "")?.kind === "task")).toBe(true);
    // And each condition leaves something out: a task that is blocked, an item that is green, an
    // item of concern that was closed.
    const others = items.filter((item) => !listed.includes(item));
    expect(others.some((item) => active(item) && item.kind === "task" && item.status === "blocked")).toBe(true);
    expect(others.some((item) => active(item) && item.health === "green")).toBe(true);
    expect(others.some((item) => !active(item) && severityOf(item) > 0)).toBe(true);
  });

  it("are, for what is at risk today, also a blocked project that was never assessed, a red project that is not blocked, a task that stands alone and no merged item", () => {
    // A world of this test's own with the four rows that a month of this seed does not hold.
    const own = createSyntheticTestDatabase();
    const pick = (condition: string) =>
      own.connection
        .prepare(
          `SELECT id FROM items WHERE closed_at IS NULL AND merged_into_id IS NULL AND ${condition} ORDER BY id LIMIT 1`,
        )
        .pluck()
        .get() as string;
    const neverAssessed = pick("kind = 'project' AND status = 'blocked'");
    const redProject = pick(`kind = 'project' AND status <> 'blocked' AND id <> '${neverAssessed}'`);
    const alone = pick("kind = 'task' AND parent_id IS NULL AND health IS NULL AND status <> 'blocked'");
    const merged = pick(
      `kind = 'task' AND health IS NULL AND id <> '${alone}' AND NOT EXISTS (SELECT 1 FROM items c WHERE c.parent_id = items.id)`,
    );
    own.connection.prepare("UPDATE items SET health = NULL WHERE id = ?").run(neverAssessed);
    own.connection.prepare("UPDATE items SET health = 'red' WHERE id IN (?, ?, ?)").run(redProject, alone, merged);
    own.connection.prepare("UPDATE items SET merged_into_id = ? WHERE id = ?").run(alone, merged);

    const rows = own.db.all<{ id: string }>(
      read("today: blocked projects, and projects and tasks whose health is yellow or red").query(context),
    );
    const all = own.connection.prepare(ITEMS).all() as Item[];
    const listed = all.filter(
      (item) =>
        active(item) &&
        ((item.kind === "project" && item.status === "blocked") || item.health === "yellow" || item.health === "red"),
    );

    expect(rows.map(({ id }) => id).sort()).toEqual(listed.map(({ id }) => id).sort());
    expect(rows.map(({ id }) => id)).toEqual(expect.arrayContaining([neverAssessed, redProject, alone]));
    expect(rows.map(({ id }) => id)).not.toContain(merged);
    // A project that is only blocked comes after everything that has a health of concern.
    expect(rows.at(-1)?.id).toBe(neverAssessed);
    own.close();
  });

  it("are, for the list in order of importance, the active items by the weight of their importance, then by the due day", () => {
    const rows = rowsOf<{ id: string; importance: string; due_on: string | null }>(
      "items: the active ones in order of importance",
    );
    const weights = new Map(
      (connection.prepare("SELECT code, weight FROM item_importances").all() as { code: string; weight: number }[]).map(
        ({ code, weight }) => [code, weight],
      ),
    );
    const weightOf = (row: { importance: string }) => weights.get(row.importance) as number;

    expect(rows.map(({ id }) => id).sort()).toEqual(
      items
        .filter(active)
        .map(({ id }) => id)
        .sort(),
    );
    // The most important first: by the weight, which is not the order of the codes.
    expect(rows.every((row, at) => at === 0 || weightOf(rows[at - 1] as (typeof rows)[number]) >= weightOf(row))).toBe(
      true,
    );
    for (const importance of weights.keys()) {
      expect(inOrderOfTheDay(rows.filter((row) => row.importance === importance)), importance).toBe(true);
    }
    expect([...new Set(rows.map(({ importance }) => importance))]).toEqual(["high", "normal", "low"]);
  });
});

describe("planProblems", () => {
  const none = { uses: [] };

  it("passes a plan that looks every row up", () => {
    expect(
      planProblems(["SEARCH l USING INDEX source_links_by_item (item_id=?)", "SEARCH s USING PRIMARY KEY (id=?)"], {
        uses: ["source_links_by_item"],
      }),
    ).toEqual([]);
  });

  it("names an index that the plan should go through and does not", () => {
    expect(planProblems(["SEARCH f USING INDEX facts_by_item (item_id=?)"], { uses: ["facts_by_source"] })).toEqual([
      "does not go through facts_by_source",
    ]);
    // An index is its whole name: another one that begins the same way does not stand for it.
    expect(
      planProblems(["SEARCH f USING INDEX facts_by_item_and_day (item_id=?)"], { uses: ["facts_by_item"] }),
    ).toEqual(["does not go through facts_by_item"]);
    expect(
      planProblems(["SEARCH s USING COVERING INDEX sources_by_kind (kind=?)"], { uses: ["sources_by_kind"] }),
    ).toEqual([]);
  });

  it("names a table that is read from end to end, with or without an index to read it in order", () => {
    expect(planProblems(["SCAN operations"], none)).toEqual(["reads from end to end: SCAN operations"]);
    expect(planProblems(["SCAN r USING INDEX runs_by_source"], none)).toEqual([
      "reads from end to end: SCAN r USING INDEX runs_by_source",
    ]);
    expect(planProblems(["SCAN o USING COVERING INDEX operations_journal"], none)).toEqual([
      "reads from end to end: SCAN o USING COVERING INDEX operations_journal",
    ]);
  });

  it("lets a read walk what stays small: what the query computes, and an index of what is open", () => {
    expect(
      planProblems(
        [
          "CO-ROUTINE tree",
          "SETUP",
          "SCAN CONSTANT ROW",
          "RECURSIVE STEP",
          "SCAN tree",
          "SEARCH c USING INDEX items_by_parent (parent_id=?)",
          "CO-ROUTINE (subquery-1)",
          "SCAN (subquery-1)",
          "MATERIALIZE newest",
          "SCAN newest",
          "SCAN i USING INDEX items_active",
          "SCAN o USING COVERING INDEX operations_pending",
        ],
        none,
      ),
    ).toEqual([]);
    // A name alone does not make a table something that the query computed.
    expect(planProblems(["SCAN tree"], none)).toEqual(["reads from end to end: SCAN tree"]);
  });

  it("lets a read walk the one table it names, and holds it to walking that table", () => {
    expect(planProblems(["SCAN m", "USE TEMP B-TREE FOR GROUP BY"], { uses: [], walks: "m" })).toEqual([]);
    expect(planProblems(["SCAN m", "SCAN o"], { uses: [], walks: "m" })).toEqual(["reads from end to end: SCAN o"]);
    expect(
      planProblems(["SEARCH m USING INDEX model_calls_by_start (started_at>?)"], { uses: [], walks: "m" }),
    ).toEqual(["says that it walks m, and does not"]);
  });

  it("names an index that is built for the one query", () => {
    expect(planProblems(["SEARCH tree USING AUTOMATIC COVERING INDEX (id=?)"], none)).toEqual([
      "builds an index of its own: SEARCH tree USING AUTOMATIC COVERING INDEX (id=?)",
    ]);
  });
});

// What the three rules at the top of reads.ts are for: each of these queries returns the same rows
// as the read beside it, and its plan reads a table that grows with the history.
describe("a query that leaves its index", () => {
  const sorted = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).sort();

  it("is caught when the cards of the Inbox are joined plainly: every run there ever was is walked", () => {
    const cards = read("inbox: the newest fifty cards");
    const plan = explain(connection, CARDS_WITH_A_PLAIN_JOIN());

    expect(sorted(db.all(CARDS_WITH_A_PLAIN_JOIN()))).toEqual(sorted(db.all(cards.query(context))));
    expect(planProblems(plan, cards)).toEqual([
      "does not go through sqlite_autoindex_runs_1",
      "reads from end to end: SCAN r USING INDEX runs_by_source",
    ]);
  });

  it("is caught when a tree is joined plainly: every item is walked and looked up in the tree", () => {
    const chart = read("tree: the rows of the chart");
    const plan = explain(connection, CHART_WITH_A_PLAIN_JOIN(context));

    expect(db.all(CHART_WITH_A_PLAIN_JOIN(context)).length).toBe(db.all(chart.query(context)).length);
    expect(planProblems(plan, { uses: ["items_by_parent", "sqlite_autoindex_items_1"] })).toEqual([
      "does not go through sqlite_autoindex_items_1",
      "reads from end to end: SCAN i",
      "builds an index of its own: SEARCH tree USING AUTOMATIC COVERING INDEX (id=?)",
    ]);
  });

  it("is caught when the walk above a list starts with a condition on the parent: every item with a parent is read", () => {
    const parents = read("items: every item that stands above an active one");
    const plan = explain(connection, ABOVE_WITH_A_CONDITION_ON_THE_PARENT());

    expect(sorted(db.all(ABOVE_WITH_A_CONDITION_ON_THE_PARENT()))).toEqual(sorted(db.all(parents.query(context))));
    expect(plan).toContain("SEARCH i USING INDEX items_by_parent (parent_id>?)");
    expect(planProblems(plan, parents)).toEqual(["does not go through items_active"]);
  });
});

describe("explain", () => {
  it("gives the plan of a query line by line, with the values of the query bound", () => {
    const query = read("item: its newest fact").query(context);

    expect(compiled(query).params).toEqual([context.branch]);
    expect(explain(connection, query)).toEqual(["SEARCH facts USING INDEX facts_by_item (item_id=?)"]);
  });
});
