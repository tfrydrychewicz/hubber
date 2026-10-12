// The reads that the views will ask, written before the views exist: each with the index its
// plan has to use, so that a query which loses its index is noticed here and not after three years
// of use. The packages that build the views take their queries from this list or hold their own
// to the same test.
//
// Three rules keep these reads on their indexes, and the plan tests hold each of them:
//   - a state that a partial index names is written into the text of the query, never bound as a
//     value: the fragments of ../schema/predicates.ts are that text for a table without an alias;
//   - a read over an item with everything under it is recursive, starts from the one item, and
//     outside the recursion has the tree first in a CROSS JOIN: joined plainly, the planner walks
//     the table and looks every row up in the tree;
//   - the walk above the rows of a list starts from the conditions of the list alone: with a
//     condition on parent_id in its start, the planner reads every item that has a parent.
import { type SQL, sql } from "drizzle-orm";
import type { CaptureId, ItemId, OperationId, PersonId } from "../../../shared/ids.ts";
import { addDays, type Day, type Instant, instantOf, periodEnd, periodStart } from "../../../shared/time.ts";
import type { Db } from "../handle.ts";
import { itemIsActive, jobIsQueued, jobIsRunning, operationIsJournalEntry, runIsRunning } from "../schema/index.ts";

/** What the reads are asked about: "now" in its several forms, and rows that stand for the busiest of their kind. */
export interface ReadContext {
  now: Instant;
  today: Day;
  /** Fourteen days before now: an item without activity since then is stale. */
  staleBefore: Instant;
  /** Thirty and seven days before now. */
  since: Instant;
  sinceDay: Day;
  weekAgo: Instant;
  /** The month of today, and the two weeks from today. */
  monthFirst: Day;
  monthLast: Day;
  rangeLast: Day;
  /** The top of the largest tree, which is also the item with the longest history. */
  tree: ItemId;
  /** A task in that tree with tasks under it, and the item that sits deepest in it. */
  branch: ItemId;
  deepest: ItemId;
  /** The owner, and the person that material names most. */
  me: PersonId;
  person: PersonId;
  /** A capture whose card has something to decide. */
  card: CaptureId;
  /** An operation that changed the busiest item, or another item where no operation has changed that one. */
  operation: OperationId;
  /** Folded spellings to look up: a name of a person, a base form of a mention, a title of an item. */
  alias: string;
  baseNorm: string;
  titleNorm: string;
}

/**
 * The partial indexes that a read may walk from end to end: each holds only what is open now
 * (the active items, the operations that wait for a decision, the jobs and runs that are under
 * way), a few hundred rows however long the history grows. The index of unresolved mentions is
 * not among them: names that nobody ever resolves add up over the years.
 */
export const INDEXES_OF_WHAT_IS_OPEN: readonly string[] = [
  "items_active",
  "operations_pending",
  "queue_jobs_due",
  "queue_jobs_running",
  "runs_running",
];

export interface Read {
  name: string;
  /** The package whose view or tool asks it. */
  owner: string;
  query: (context: ReadContext) => SQL;
  /** The indexes that its plan names. */
  uses: readonly string[];
  /** The one table, by its name in the query, that it reads from end to end, on purpose. */
  walks?: string;
  /**
   * Returns the whole of the longest history there is, as many rows as that history has: read in
   * pages by the view, and held to no budget here.
   */
  unbounded?: true;
  /**
   * The table that it walks grows with the history, and so does the time that it takes. Held to
   * the budget like every read.
   */
  wholeHistory?: true;
}

/**
 * What the plan of a read does that a read may not do: an index that it should go through and
 * does not name, an index that SQLite builds for the one query, and a table that it reads from
 * end to end. Empty for a plan that keeps the rules.
 *
 * Read from end to end may be what stays small however long the history grows: what the query
 * computes itself (the queue of a recursion, the rows of a subquery), an index of what is open,
 * and the one table that the read says it walks.
 */
export function planProblems(plan: readonly string[], read: Pick<Read, "uses" | "walks">): string[] {
  const indexOf = (line: string): string | undefined => /\bUSING (?:COVERING )?INDEX (\S+)/.exec(line)?.[1];
  const scannedBy = (line: string): string | undefined => /^SCAN (\S+)/.exec(line)?.[1];
  const named = new Set(plan.map(indexOf));
  const computed = new Set(plan.map((line) => /^(?:CO-ROUTINE|MATERIALIZE) (\S+)/.exec(line)?.[1]));
  const problems = read.uses.filter((index) => !named.has(index)).map((index) => `does not go through ${index}`);
  if (read.walks !== undefined && !plan.some((line) => scannedBy(line) === read.walks)) {
    problems.push(`says that it walks ${read.walks}, and does not`);
  }
  for (const line of plan) {
    // An index for the one query is made by reading its table from end to end, every time the query runs.
    if (line.includes("AUTOMATIC")) problems.push(`builds an index of its own: ${line}`);
    const scanned = scannedBy(line);
    if (scanned === undefined || scanned === "CONSTANT" || computed.has(scanned) || scanned === read.walks) continue;
    const through = indexOf(line);
    if (through !== undefined && INDEXES_OF_WHAT_IS_OPEN.includes(through)) continue;
    problems.push(`reads from end to end: ${line}`);
  }
  return problems;
}

/** The item and everything under it: the tree is walked first, level by level, through the index of parents. */
const tree = (root: ItemId): SQL => sql`WITH RECURSIVE tree (id, depth) AS (
    SELECT ${root}, 0
    UNION ALL
    SELECT c.id, tree.depth + 1
      FROM tree JOIN items c ON c.parent_id = tree.id
     WHERE c.merged_into_id IS NULL)`;
/** Every item that stands above the rows of a list, each once. `start` is the list: its conditions and nothing else. */
const above = (start: SQL): SQL => sql`WITH RECURSIVE above (id) AS (
    SELECT i.parent_id FROM items i WHERE ${start}
    UNION
    SELECT p.parent_id FROM above JOIN items p ON p.id = above.id WHERE p.parent_id IS NOT NULL)
SELECT a.id, a.kind, a.parent_id, a.title, a.status, a.closed_at
  FROM above CROSS JOIN items a ON a.id = above.id`;
const ROW = sql.raw(
  "i.id, i.kind, i.parent_id, i.title, i.status, i.importance, i.health, i.is_milestone, i.start_on, i.start_on_precision, i.due_on, i.due_on_precision, i.closed_at",
);
const ACTIVE = sql.raw("i.closed_at IS NULL AND i.merged_into_id IS NULL");
const JOURNAL_ENTRY = sql.raw("id, kind, state, origin, approval, applied_at, source_id, payload");

export const READS: readonly Read[] = [
  // ---- "Dziś" and the list of items: they start from the active items, about three hundred rows ----
  {
    name: "today: my tasks that are due or overdue",
    owner: "M1c-4",
    query: (c) =>
      sql`SELECT id, title, due_on, status FROM items WHERE ${itemIsActive} AND my_role = 'doing' AND due_on <= ${c.today} ORDER BY due_on`,
    uses: ["items_active"],
  },
  {
    name: "today: what I wait for, the longest first, with who owes it",
    owner: "M1c-4",
    query: () =>
      sql`SELECT i.id, i.title, i.my_role_set_on, i.due_on, p.id AS owner_id, p.name AS owner
            FROM items i LEFT JOIN item_persons ip ON ip.item_id = i.id AND ip.role = 'owner' LEFT JOIN persons p ON p.id = ip.person_id
           WHERE ${ACTIVE} AND i.my_role = 'waiting' ORDER BY i.my_role_set_on`,
    uses: ["items_active", "item_persons_one_owner"],
  },
  {
    name: "today: blocked projects, and projects and tasks whose health is yellow or red",
    owner: "M1c-4",
    query: () =>
      // A project is on the list for being blocked or for its health, a task for its health alone.
      sql`SELECT i.id, i.kind, i.parent_id, i.title, i.status, i.health FROM items i LEFT JOIN item_healths h ON h.code = i.health
           WHERE ${ACTIVE} AND ((i.kind = 'project' AND i.status = 'blocked') OR h.severity > 0) ORDER BY h.severity DESC`,
    uses: ["items_active"],
  },
  {
    name: "today: active items without activity for two weeks, but for work that has not begun and milestones that are not due",
    owner: "M1c-4",
    query: (c) =>
      sql`SELECT i.id, i.kind, i.parent_id, i.title, i.last_activity_at FROM items i
           WHERE ${ACTIVE} AND i.last_activity_at < ${c.staleBefore}
             AND NOT coalesce(i.start_on > ${c.today}, 0) AND NOT (i.is_milestone = 1 AND coalesce(i.due_on > ${c.today}, 0))
           ORDER BY i.last_activity_at`,
    uses: ["items_active"],
  },
  {
    name: "today: open milestones that are due or missed, each with its parent",
    owner: "M1c-4",
    query: (c) =>
      sql`SELECT i.id, i.parent_id, i.title, i.due_on, i.due_on_precision FROM items i
           WHERE ${ACTIVE} AND i.is_milestone = 1 AND i.due_on <= ${c.today}`,
    uses: ["items_active"],
  },
  {
    name: "today: every item that stands above such a milestone, once",
    owner: "M1c-4",
    query: (c) => above(sql`${ACTIVE} AND i.is_milestone = 1 AND i.due_on <= ${c.today}`),
    uses: ["items_active", "sqlite_autoindex_items_1"],
  },
  {
    name: "items: the active ones in order of importance, then of the due day",
    owner: "M1a-11",
    query: () =>
      sql`SELECT i.id, i.kind, i.parent_id, i.title, i.status, i.importance, i.due_on
            FROM items i JOIN item_importances w ON w.code = i.importance
           WHERE ${ACTIVE} ORDER BY w.weight DESC, i.due_on`,
    uses: ["items_active"],
  },
  {
    name: "items: the active ones, each with its parent",
    owner: "M1a-11, M1a-6",
    query: () =>
      sql`SELECT i.id, i.kind, i.parent_id, i.title, i.status, i.importance, i.my_role, i.start_on, i.due_on, i.due_on_precision, i.is_milestone
            FROM items i WHERE ${ACTIVE}`,
    uses: ["items_active"],
  },
  {
    name: "items: every item that stands above an active one, once, closed ones among them",
    owner: "M1a-11, M1a-6",
    query: () => above(sql`${ACTIVE}`),
    uses: ["items_active", "sqlite_autoindex_items_1"],
  },
  {
    name: "items: the active ones with a due day in a range, in order of the day",
    owner: "M1a-16",
    query: (c) =>
      sql`SELECT i.id, i.parent_id, i.title, i.due_on, i.due_on_precision, i.is_milestone FROM items i
           WHERE ${ACTIVE} AND i.due_on BETWEEN ${c.today} AND ${c.rangeLast} ORDER BY i.due_on`,
    uses: ["items_active"],
  },
  {
    name: "items: the active ones with their aliases and owner, for the agent's index",
    owner: "M1a-6",
    query: () =>
      sql`SELECT i.id, i.kind, i.parent_id, i.title, i.status, i.my_role, i.due_on, i.is_milestone,
                 (SELECT group_concat(a.alias, '|') FROM item_aliases a WHERE a.item_id = i.id) AS aliases,
                 (SELECT ip.person_id FROM item_persons ip WHERE ip.item_id = i.id AND ip.role = 'owner') AS owner_id
            FROM items i WHERE ${ACTIVE}`,
    uses: ["items_active", "item_aliases_one_per_item", "item_persons_one_owner"],
  },
  {
    name: "items: closed in the last thirty days, for the check of duplicates",
    owner: "M1a-7",
    query: (c) => sql`SELECT i.id, i.title, i.status, i.closed_at FROM items i WHERE i.closed_at >= ${c.since}`,
    uses: [],
    // No index on purpose: the table of items is a few megabytes after three years.
    walks: "i",
  },

  // ---- one item with everything under it ----
  {
    name: "tree: the rows of the chart of an item, with the depth and the owner of each",
    owner: "M1a-18",
    query: (c) =>
      sql`${tree(c.tree)}
          SELECT ${ROW}, tree.depth,
                 (SELECT p.person_id FROM item_persons p WHERE p.item_id = i.id AND p.role = 'owner') AS owner_id
            FROM tree CROSS JOIN items i ON i.id = tree.id`,
    uses: ["items_by_parent", "sqlite_autoindex_items_1", "item_persons_one_owner"],
  },
  {
    name: "tree: the items of a tree with a start or a due day in a month",
    owner: "M1a-20",
    query: (c) =>
      sql`${tree(c.tree)}
          SELECT ${ROW} FROM tree CROSS JOIN items i ON i.id = tree.id
           WHERE i.start_on BETWEEN ${c.monthFirst} AND ${c.monthLast} OR i.due_on BETWEEN ${c.monthFirst} AND ${c.monthLast}`,
    uses: ["items_by_parent", "sqlite_autoindex_items_1"],
  },
  {
    name: "tree: the active items of a tree in order of the due day",
    owner: "M1a-11",
    query: (c) =>
      sql`${tree(c.tree)}
          SELECT ${ROW}, tree.depth FROM tree CROSS JOIN items i ON i.id = tree.id
           WHERE i.closed_at IS NULL AND i.id <> ${c.tree} ORDER BY i.due_on`,
    uses: ["items_by_parent", "sqlite_autoindex_items_1"],
  },
  {
    name: "tree: the facts of an item and of everything under it in a month",
    owner: "M1a-11",
    query: (c) =>
      sql`${tree(c.tree)}
          SELECT f.id, f.item_id, f.type, f.occurred_on FROM tree CROSS JOIN facts f ON f.item_id = tree.id
           WHERE f.occurred_on BETWEEN ${c.monthFirst} AND ${c.monthLast}`,
    uses: ["items_by_parent", "facts_by_item"],
  },
  {
    name: "tree: the open milestones of the whole tree that an item sits in",
    owner: "M1a-17",
    query: (c) =>
      sql`WITH RECURSIVE up (id, parent_id) AS (
              SELECT id, parent_id FROM items WHERE id = ${c.deepest}
              UNION ALL
              SELECT p.id, p.parent_id FROM up JOIN items p ON p.id = up.parent_id),
            tree (id) AS (
              SELECT id FROM up WHERE parent_id IS NULL
              UNION ALL
              SELECT c.id FROM tree JOIN items c ON c.parent_id = tree.id WHERE c.merged_into_id IS NULL)
          SELECT i.id, i.title, i.due_on, i.due_on_precision FROM tree CROSS JOIN items i ON i.id = tree.id
           WHERE i.is_milestone = 1 AND i.closed_at IS NULL`,
    uses: ["items_by_parent", "sqlite_autoindex_items_1"],
  },
  {
    name: "item: the item with every item above it, from the top down",
    owner: "M1a-11",
    query: (c) =>
      sql`WITH RECURSIVE up (id, parent_id, kind, title, steps) AS (
              SELECT id, parent_id, kind, title, 0 FROM items WHERE id = ${c.deepest}
              UNION ALL
              SELECT p.id, p.parent_id, p.kind, p.title, up.steps + 1 FROM up JOIN items p ON p.id = up.parent_id)
          SELECT id, kind, title FROM up ORDER BY steps DESC`,
    uses: ["sqlite_autoindex_items_1"],
  },
  {
    name: "item: the items directly under it, each with the answer whether anything sits under it",
    owner: "M1a-11",
    query: (c) =>
      sql`SELECT ${ROW}, EXISTS (SELECT 1 FROM items g WHERE g.parent_id = i.id AND g.merged_into_id IS NULL) AS has_children
            FROM items i WHERE i.parent_id = ${c.tree} AND i.merged_into_id IS NULL`,
    uses: ["items_by_parent"],
  },

  // ---- the page of an item ----
  {
    name: "item: all its facts, with their source",
    owner: "M1a-11",
    query: (c) =>
      sql`SELECT f.id, f.type, f.text, f.quote, f.occurred_on, f.outdated_at, f.superseded_by_fact_id, f.source_id, s.kind AS source_kind, s.deleted_at
            FROM facts f LEFT JOIN sources s ON s.id = f.source_id WHERE f.item_id = ${c.tree} ORDER BY f.occurred_on DESC`,
    uses: ["facts_by_item"],
    unbounded: true,
  },
  {
    name: "item: the facts of its timeline since a day",
    owner: "M1a-11",
    query: (c) =>
      sql`SELECT id, type, text, occurred_on FROM facts WHERE item_id = ${c.tree} AND occurred_on >= ${c.sinceDay} ORDER BY occurred_on`,
    uses: ["facts_by_item"],
  },
  {
    name: "item: its newest fact",
    owner: "M1a-18",
    query: (c) =>
      sql`SELECT id, type, quote, occurred_on FROM facts WHERE item_id = ${c.branch} ORDER BY occurred_on DESC LIMIT 1`,
    uses: ["facts_by_item"],
  },
  {
    name: "item: the changes of its fields in the last thirty days",
    owner: "M1a-11",
    query: (c) =>
      sql`SELECT o.id, o.kind, o.state, o.applied_at, o.approval, o.source_id, e.field, e.before_value, e.after_value
            FROM operation_effects e JOIN operations o ON o.id = e.operation_id
           WHERE e.item_id = ${c.tree} AND e.entity_kind = 'item' AND e.change = 'update' AND o.applied_at >= ${c.since} ORDER BY e.id`,
    uses: ["operation_effects_by_item", "sqlite_autoindex_operations_1"],
  },
  {
    name: "item: the whole history of the changes of its fields",
    owner: "M1a-11",
    query: (c) =>
      sql`SELECT o.id, o.kind, o.state, o.applied_at, o.approval, o.source_id, e.field, e.before_value, e.after_value
            FROM operation_effects e JOIN operations o ON o.id = e.operation_id
           WHERE e.item_id = ${c.tree} AND e.entity_kind = 'item' AND e.change = 'update' ORDER BY e.id`,
    uses: ["operation_effects_by_item", "sqlite_autoindex_operations_1"],
    unbounded: true,
  },
  {
    name: "item: its newest fifty sources, with the beginning of each",
    owner: "M1a-11",
    query: (c) =>
      sql`SELECT l.source_id, s.kind, s.created_at,
                 (SELECT substr(p.text, 1, 200) FROM capture_parts p WHERE p.capture_id = l.source_id ORDER BY p.position LIMIT 1) AS snippet
            FROM source_links l JOIN sources s ON s.id = l.source_id WHERE l.item_id = ${c.tree} ORDER BY l.created_at DESC LIMIT 50`,
    uses: ["source_links_by_item", "capture_parts_one_per_position"],
  },
  {
    name: "item: its persons, with their roles and expectations",
    owner: "M1a-11",
    query: (c) =>
      sql`SELECT p.id, p.name, ip.role, ip.expectations FROM item_persons ip JOIN persons p ON p.id = ip.person_id WHERE ip.item_id = ${c.tree}`,
    uses: ["item_persons_one_role"],
  },
  {
    name: "item: where the present value of its due day comes from",
    owner: "M1a-17",
    query: (c) =>
      sql`SELECT e.change, e.field, e.before_value, e.after_value, o.origin, o.approval, o.applied_at, o.source_id, o.quote,
                 (SELECT c.occurred_on FROM captures c WHERE c.id = o.source_id) AS source_day
            FROM operation_effects e JOIN operations o ON o.id = e.operation_id
           WHERE e.entity_id = ${c.branch} AND e.entity_kind = 'item' AND (e.field = 'due_on' OR e.change = 'create')
             AND o.state = 'applied' AND o.kind <> 'undo'
           ORDER BY e.id DESC LIMIT 1`,
    uses: ["operation_effects_by_entity", "sqlite_autoindex_operations_1"],
  },
  {
    name: "item: the applied changes of its due day in the last two weeks",
    owner: "M1a-17",
    query: (c) =>
      sql`SELECT e.before_value, e.after_value, o.applied_at, o.source_id
            FROM operation_effects e JOIN operations o ON o.id = e.operation_id
           WHERE e.entity_id = ${c.branch} AND e.entity_kind = 'item' AND e.change = 'update' AND e.field = 'due_on'
             AND o.state = 'applied' AND o.kind <> 'undo' AND o.applied_at >= ${c.staleBefore}`,
    uses: ["operation_effects_by_entity", "sqlite_autoindex_operations_1"],
  },

  // ---- the Inbox and the captures ----
  {
    name: "inbox: the number of cards with something to decide",
    owner: "M1a-8, M1a-10",
    query: () =>
      sql`SELECT count(DISTINCT r.source_id) AS cards FROM operations o JOIN runs r ON r.id = o.run_id WHERE o.state IN ('proposed', 'invalid')`,
    uses: ["operations_pending"],
  },
  {
    name: "inbox: the newest fifty cards",
    owner: "M1a-10",
    query: () =>
      // The operations first, in a CROSS JOIN: joined plainly, the planner goes by the GROUP BY,
      // walks every run there ever was in the order of its source and looks its operations up.
      sql`SELECT r.source_id, s.kind, count(*) AS pending, max(o.created_at) AS latest
            FROM operations o CROSS JOIN runs r ON r.id = o.run_id CROSS JOIN sources s ON s.id = r.source_id
           WHERE o.state IN ('proposed', 'invalid') GROUP BY r.source_id ORDER BY latest DESC LIMIT 50`,
    uses: ["operations_pending", "sqlite_autoindex_runs_1"],
  },
  {
    name: "inbox: every operation of the runs of one capture",
    owner: "M1a-10",
    query: (c) =>
      sql`SELECT o.id, o.kind, o.state, o.confidence, o.approval, o.payload, o.quote, o.rationale
            FROM runs r JOIN operations o ON o.run_id = r.id WHERE r.source_id = ${c.card} ORDER BY r.started_at, o.seq`,
    uses: ["runs_by_source", "operations_by_run"],
  },
  {
    name: "capture: its parts, each with its newest derived text",
    owner: "M1a-9",
    query: (c) =>
      sql`SELECT p.id, p.position, p.kind, p.file_sha256, p.file_name, p.text,
                 (SELECT t.text FROM capture_part_texts t WHERE t.part_id = p.id ORDER BY t.revision DESC LIMIT 1) AS derived
            FROM capture_parts p WHERE p.capture_id = ${c.card} ORDER BY p.position`,
    uses: ["capture_parts_one_per_position", "capture_part_texts_one_per_revision"],
  },
  {
    name: "captures: the last fifty, each with its state and its beginning",
    owner: "M1a-9",
    query: () =>
      sql`SELECT c.id, s.created_at, c.occurred_on,
                 (SELECT j.state FROM queue_jobs j WHERE j.source_id = c.id ORDER BY j.created_at DESC LIMIT 1) AS state,
                 (SELECT substr(p.text, 1, 200) FROM capture_parts p WHERE p.capture_id = c.id ORDER BY p.position LIMIT 1) AS snippet
            FROM sources s JOIN captures c ON c.id = s.id WHERE s.kind = 'capture' ORDER BY s.created_at DESC LIMIT 50`,
    uses: ["sources_by_kind", "queue_jobs_by_source", "capture_parts_one_per_position"],
  },
  {
    name: "source: the facts it gave",
    owner: "M1a-14",
    query: (c) => sql`SELECT id, item_id, type FROM facts WHERE source_id = ${c.card}`,
    uses: ["facts_by_source"],
  },
  {
    name: "source: its decided operations, for the difference at reprocessing",
    owner: "M1a-7",
    query: (c) =>
      sql`SELECT id, kind, state, payload, quote FROM operations WHERE source_id = ${c.card} AND state IN ('applied', 'rejected')`,
    uses: ["operations_by_source"],
  },

  // ---- persons ----
  {
    name: "person: what she owes me",
    owner: "M1b-3",
    query: (c) =>
      sql`SELECT i.id, i.title, i.my_role, i.due_on, i.my_role_set_on FROM item_persons ip JOIN items i ON i.id = ip.item_id
           WHERE ip.person_id = ${c.person} AND ip.role = 'owner' AND ${ACTIVE} AND i.my_role IN ('waiting', 'delegating')`,
    uses: ["item_persons_by_person"],
  },
  {
    name: "person: what I owe her",
    owner: "M1b-3",
    query: (c) =>
      sql`SELECT i.id, i.title, i.due_on FROM item_persons ip JOIN items i ON i.id = ip.item_id
           WHERE ip.person_id = ${c.person} AND ip.role = 'requester' AND ${ACTIVE} AND i.my_role = 'doing'`,
    uses: ["item_persons_by_person"],
  },
  {
    name: "person: a hundred of her items, the open ones first, then by their last activity",
    owner: "M1b-3",
    query: (c) =>
      sql`SELECT i.id, i.title, i.kind, i.status, ip.role FROM item_persons ip JOIN items i ON i.id = ip.item_id
           WHERE ip.person_id = ${c.person} ORDER BY i.closed_at IS NOT NULL, i.last_activity_at DESC LIMIT 100`,
    uses: ["item_persons_by_person"],
  },
  {
    name: "person: her newest fifty mentions, with the kind and the day of each source",
    owner: "M1b-3",
    query: (c) =>
      sql`SELECT m.id, m.source_id, m.surface, s.kind, s.created_at FROM mentions m JOIN sources s ON s.id = m.source_id
           WHERE m.person_id = ${c.person} ORDER BY m.created_at DESC LIMIT 50`,
    uses: ["mentions_by_person"],
  },
  {
    name: "persons: everyone with their aliases, for the agent's index",
    owner: "M1a-6",
    query: () =>
      sql`SELECT p.id, p.name, p.team, p.relation, (SELECT group_concat(a.alias, '|') FROM person_aliases a WHERE a.person_id = p.id) AS aliases
            FROM persons p WHERE p.merged_into_id IS NULL`,
    uses: ["person_aliases_one_per_context"],
    // Five hundred rows, all of which the index of the agent holds.
    walks: "p",
  },
  {
    name: "match: who answers to this name",
    owner: "M1a-5, M1b-2",
    query: (c) =>
      sql`SELECT person_id AS id FROM person_aliases WHERE alias_norm = ${c.alias} UNION SELECT id FROM persons WHERE name_norm = ${c.alias}`,
    uses: ["person_aliases_by_norm", "persons_by_name"],
  },
  {
    name: "match: the items with exactly this title or alias",
    owner: "M1a-5, M1a-7",
    query: (c) =>
      sql`SELECT id FROM items WHERE title_norm = ${c.titleNorm} UNION SELECT item_id FROM item_aliases WHERE alias_norm = ${c.titleNorm}`,
    uses: ["items_by_title", "item_aliases_by_norm"],
  },
  {
    name: "match: the unresolved mentions of a name, to complete after an answer",
    owner: "M1b-2",
    query: (c) =>
      sql`SELECT id, source_id FROM mentions WHERE person_id IS NULL AND skipped_at IS NULL AND base_norm = ${c.baseNorm}`,
    uses: ["mentions_unresolved"],
  },

  // ---- the journal ----
  {
    name: "journal: the newest fifty entries",
    owner: "M1a-14",
    query: () =>
      sql`SELECT ${JOURNAL_ENTRY} FROM operations WHERE ${operationIsJournalEntry} ORDER BY applied_at DESC LIMIT 50`,
    uses: ["operations_journal"],
  },
  {
    name: "journal: what one entry did, before and after",
    owner: "M1a-14",
    query: (c) =>
      sql`SELECT entity_kind, entity_id, change, field, before_value, after_value FROM operation_effects WHERE operation_id = ${c.operation} ORDER BY id`,
    uses: ["operation_effects_by_operation"],
  },
  {
    name: "journal: the newest fifty entries of a rare kind",
    owner: "M1a-14",
    query: () =>
      sql`SELECT ${JOURNAL_ENTRY} FROM operations WHERE ${operationIsJournalEntry} AND kind = 'supersede_fact' ORDER BY applied_at DESC LIMIT 50`,
    uses: ["operations_journal"],
  },
  {
    name: "journal: the newest fifty entries applied by command",
    owner: "M1a-14",
    query: () =>
      sql`SELECT ${JOURNAL_ENTRY} FROM operations WHERE ${operationIsJournalEntry} AND approval = 'command' ORDER BY applied_at DESC LIMIT 50`,
    uses: ["operations_journal"],
  },
  {
    name: "journal: the changes of items in the last thirty days",
    owner: "M1a-14",
    query: (c) =>
      sql`SELECT id, kind, state, approval, applied_at, payload FROM operations WHERE applied_at >= ${c.since} AND kind = 'update_item' ORDER BY applied_at DESC`,
    uses: ["operations_journal"],
  },
  {
    name: "journal: the newest fifty entries about an item",
    owner: "M1a-14",
    query: (c) =>
      sql`SELECT o.id, o.kind, o.state, o.approval, o.applied_at, o.payload FROM operations o
           WHERE o.id IN (SELECT DISTINCT operation_id FROM (SELECT operation_id FROM operation_effects WHERE item_id = ${c.tree} ORDER BY id DESC LIMIT 200) LIMIT 50)
           ORDER BY o.applied_at DESC`,
    uses: ["operation_effects_by_item", "sqlite_autoindex_operations_1"],
  },
  {
    name: "journal: the newest fifty entries about a person",
    owner: "M1a-14",
    query: (c) =>
      sql`SELECT o.id, o.kind, o.state, o.approval, o.applied_at, o.payload FROM operations o
           WHERE o.id IN (SELECT DISTINCT operation_id FROM (SELECT operation_id FROM operation_effects WHERE person_id = ${c.person} ORDER BY id DESC LIMIT 200) LIMIT 50)
           ORDER BY o.applied_at DESC`,
    uses: ["operation_effects_by_person", "sqlite_autoindex_operations_1"],
  },
  {
    name: "undo: the later changes of the rows that one operation changed",
    owner: "M1a-5",
    query: (c) =>
      sql`SELECT DISTINCT l.operation_id FROM operation_effects mine
            JOIN operation_effects l ON l.entity_id = mine.entity_id AND l.id > mine.id AND l.change <> 'touch'
             AND (mine.change <> 'update' OR l.change <> 'update' OR l.field = mine.field)
            JOIN operations o ON o.id = l.operation_id
           WHERE mine.operation_id = ${c.operation} AND mine.change <> 'touch' AND o.state = 'applied' AND o.kind <> 'undo'`,
    uses: ["operation_effects_by_operation", "operation_effects_by_entity", "sqlite_autoindex_operations_1"],
  },
  {
    name: "metrics: proposals accepted unchanged and automatic operations undone, in a week",
    owner: "M1c-7",
    query: (c) =>
      sql`SELECT sum(approval = 'accepted') AS accepted, sum(approval = 'accepted' AND proposed_payload IS NULL) AS unchanged,
                 sum(approval = 'auto') AS automatic, sum(approval = 'auto' AND state = 'undone') AS automatic_undone
            FROM operations WHERE applied_at >= ${c.weekAgo} AND applied_at < ${c.now}`,
    uses: ["operations_journal"],
  },

  // ---- work in progress ----
  {
    name: "queue: the job that the worker takes next",
    owner: "M1a-7",
    query: (c) =>
      sql`SELECT id, kind, attempts FROM queue_jobs WHERE ${jobIsQueued} AND run_after <= ${c.now} ORDER BY run_after LIMIT 1`,
    uses: ["queue_jobs_due"],
  },
  {
    name: "queue: the jobs and the runs that a killed process left behind",
    owner: "M1a-7",
    query: () =>
      sql`SELECT id FROM queue_jobs WHERE ${jobIsRunning} UNION ALL SELECT id FROM runs WHERE ${runIsRunning}`,
    uses: ["queue_jobs_running", "runs_running"],
  },
  {
    name: "costs: the tokens of the last thirty days, by day and role",
    owner: "M2-10",
    query: (c) =>
      sql`SELECT substr(m.started_at, 1, 10) AS day, m.role, count(*) AS calls, sum(m.input_tokens) AS input, sum(m.output_tokens) AS output, sum(m.cache_read_input_tokens) AS cache_read
            FROM model_calls m WHERE m.started_at >= ${c.since} GROUP BY day, m.role`,
    uses: [],
    // No index on purpose: the log of calls is read whole, once, when the view of costs is opened.
    walks: "m",
    wholeHistory: true,
  },
];

/** The newest cards of the Inbox with a plain join: the planner then starts from the runs, all of them. */
export const CARDS_WITH_A_PLAIN_JOIN = (): SQL =>
  sql`SELECT r.source_id, s.kind, count(*) AS pending, max(o.created_at) AS latest
        FROM operations o JOIN runs r ON r.id = o.run_id JOIN sources s ON s.id = r.source_id
       WHERE o.state IN ('proposed', 'invalid') GROUP BY r.source_id ORDER BY latest DESC LIMIT 50`;
/** The same read as the chart, with the tree joined plainly: what the second rule at the top is for. */
export const CHART_WITH_A_PLAIN_JOIN = (c: ReadContext): SQL =>
  sql`${tree(c.tree)}
      SELECT ${ROW}, tree.depth FROM tree JOIN items i ON i.id = tree.id`;
/** The walk above the active items with a condition on the parent in its start: what the third rule is for. */
export const ABOVE_WITH_A_CONDITION_ON_THE_PARENT = (): SQL => above(sql`${ACTIVE} AND i.parent_id IS NOT NULL`);

/** The rows that the reads are asked about, found in a database that holds a synthetic world. */
export function readContext(
  db: Db,
  world: { now: Instant; me: PersonId; busiestItem: ItemId; openCardSource: CaptureId | undefined },
): ReadContext {
  const one = <T>(query: SQL): T | undefined => (db.get<{ value: T }>(query) as { value: T } | undefined)?.value;
  const nowMs = Date.parse(world.now);
  const today = world.now.slice(0, 10) as Day;
  const before = (days: number): Instant => instantOf(new Date(nowMs - days * 86_400_000));
  const root = world.busiestItem;
  return {
    now: world.now,
    today,
    staleBefore: before(14),
    since: before(30),
    sinceDay: addDays(today, -30),
    weekAgo: before(7),
    monthFirst: periodStart(today, "month"),
    monthLast: periodEnd(today, "month"),
    rangeLast: addDays(today, 14),
    tree: root,
    branch:
      one<ItemId>(
        sql`SELECT i.id AS value FROM items i WHERE i.parent_id = ${root} AND EXISTS (SELECT 1 FROM items c WHERE c.parent_id = i.id) ORDER BY i.id LIMIT 1`,
      ) ?? root,
    deepest: one<ItemId>(sql`${tree(root)} SELECT id AS value FROM tree ORDER BY depth DESC, id LIMIT 1`) ?? root,
    me: world.me,
    person:
      one<PersonId>(
        sql`SELECT person_id AS value FROM item_persons WHERE person_id <> ${world.me} GROUP BY person_id ORDER BY count(*) DESC, person_id LIMIT 1`,
      ) ?? world.me,
    card:
      world.openCardSource ??
      (one<CaptureId>(sql`SELECT id AS value FROM sources ORDER BY created_at DESC LIMIT 1`) as CaptureId),
    operation:
      one<OperationId>(
        sql`SELECT operation_id AS value FROM operation_effects WHERE item_id = ${root} AND entity_kind = 'item' AND change = 'update' ORDER BY id LIMIT 1`,
      ) ??
      // A history of a few days may not have changed the busiest item yet: then a change of any item.
      one<OperationId>(
        sql`SELECT operation_id AS value FROM operation_effects WHERE entity_kind = 'item' AND change = 'update' ORDER BY id LIMIT 1`,
      ) ??
      ("" as OperationId),
    alias: one<string>(sql`SELECT alias_norm AS value FROM person_aliases ORDER BY id LIMIT 1`) ?? "",
    baseNorm:
      one<string>(
        sql`SELECT base_norm AS value FROM mentions WHERE person_id IS NULL AND skipped_at IS NULL LIMIT 1`,
      ) ?? "",
    titleNorm: one<string>(sql`SELECT title_norm AS value FROM items WHERE id = ${root}`) ?? "",
  };
}
