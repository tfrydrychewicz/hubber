// The world alone, without a database: what it hands over is counted here. What the database
// makes of it is the matter of index.test.ts.
import { beforeAll, describe, expect, it } from "vitest";
import { isId } from "../../../shared/ids.ts";
import { addDays, type Day } from "../../../shared/time.ts";
import type { ItemHealth, OperationState } from "../../../shared/vocabulary.ts";
import { SCALES, type Scale } from "./scale.ts";
import {
  type Change,
  createWorld,
  type ItemFields,
  type PersonFields,
  type Sink,
  type SourceLinkFields,
  type WorldOperation,
} from "./world.ts";

const NOW = Date.parse("2026-10-14T17:30:00.000Z");
/** Five months of the small hub: enough items for a share to mean something, and no database to wait for. */
const MONTHS: Scale = { ...SCALES.small, name: "five months", days: 150 };

interface Lived {
  /** The items as they are at the end, by their ids; what was undone is not among them. */
  items: Map<string, ItemFields>;
  everCreated: number;
  /** Every operation that was handed over, in that order, and what each of them changed. */
  operations: WorldOperation[];
  changes: { operation: WorldOperation; changes: readonly Change[] }[];
  /** The changes of the due day of an item that had a period, in their order: whether its start moved with it. */
  periodMoves: boolean[];
  /** The health that each item was created with, by the id of the item. */
  healthGiven: Map<string, ItemHealth | null>;
  /** The changes of the health of an item, in their order: the health before and after, and whether the item was open. */
  healthChanges: {
    operation: WorldOperation;
    id: string;
    from: ItemHealth | null;
    to: ItemHealth | null;
    open: boolean;
  }[];
  instants: number[];
  ids: Record<string, string[]>;
}

function live(scale: Scale, seed = 1): Lived {
  const lived: Lived = {
    items: new Map(),
    everCreated: 0,
    operations: [],
    changes: [],
    periodMoves: [],
    healthGiven: new Map(),
    healthChanges: [],
    instants: [],
    ids: {},
  };
  const id = (kind: string, value: string) => {
    lived.ids[kind] = [...(lived.ids[kind] ?? []), value];
  };
  const sink: Sink = {
    file: () => {},
    capture: (capture) => {
      id("capture", capture.id);
      for (const part of capture.parts) id("capturePart", part.id);
      lived.instants.push(capture.createdAt);
    },
    partText: (text) => id("capturePartText", text.id),
    job: (job) => id("job", job.id),
    jobChanged: () => {},
    run: (run) => {
      id("run", run.id);
      lived.instants.push(run.startedAt);
    },
    runEnded: () => {},
    modelCall: () => {},
    operation: (operation) => {
      id("operation", operation.id);
      lived.operations.push(operation);
    },
    operationMoved: () => {},
    changes: (operation, changes) => {
      lived.changes.push({ operation, changes });
      lived.instants.push(operation.appliedAt ?? 0);
      for (const change of changes) {
        if (change.kind !== "item") continue;
        if (change.change === "create") {
          lived.items.set(change.row.id, change.row);
          lived.everCreated++;
          id("item", change.row.id);
        }
        if (change.change === "delete") lived.items.delete(change.row.id);
        // Looked at here, while the row is what the change made of it: the world goes on changing it.
        const { was, row } = change;
        if (change.change === "create") lived.healthGiven.set(row.id, row.health);
        if (change.change === "update" && was !== undefined && "dueOn" in was && row.startOn !== null) {
          lived.periodMoves.push("startOn" in was);
        }
        if (change.change === "update" && was !== undefined && "health" in was) {
          lived.healthChanges.push({
            operation,
            id: row.id,
            from: was.health ?? null,
            to: row.health,
            open: row.closedAt === null && row.mergedIntoId === null,
          });
        }
      }
    },
  };
  const world = createWorld({ scale, seed, now: NOW }, sink);
  for (let day = 0; day < scale.days; day++) world.day(day);
  world.finish();
  return lived;
}

interface HandedOver {
  /** The method of the sink that was called, and the operation that the call was about, where it was about one. */
  method: string;
  operation: string | undefined;
  /** For the changes of an operation: each row that changed, with the fields that did. */
  changed: string[];
  /** What was handed over, without the health of an item and without what only the world keeps of an operation. */
  text: string;
}

/** Everything that a world hands over, call by call, as it was at that moment: the world goes on changing its rows. */
function handedOver(scale: Scale): HandedOver[] {
  const calls: HandedOver[] = [];
  const left = new Set(["health", "intent", "needs", "dependants"]);
  const sink = new Proxy({} as Sink, {
    get:
      (_sink, method: string) =>
      (...given: unknown[]) => {
        const about = method === "operation" || method === "operationMoved" || method === "changes";
        calls.push({
          method,
          operation: about ? (given[0] as WorldOperation).id : undefined,
          changed:
            method === "changes"
              ? (given[1] as Change[]).map(
                  ({ kind, change, was }) => `${kind} ${change} ${Object.keys(was ?? {}).join(" ")}`,
                )
              : [],
          text: JSON.stringify(given, (key, value) => (left.has(key) ? undefined : value)),
        });
      },
  });
  const world = createWorld({ scale, seed: 1, now: NOW }, sink);
  for (let day = 0; day < scale.days; day++) world.day(day);
  world.finish();
  return calls;
}

const lived = live(MONTHS);
const items = [...lived.items.values()];
const tasks = items.filter((item) => item.kind === "task");
const share = (part: number, whole: number): number => part / Math.max(1, whole);
/** The updates of items, each with the names of the fields it changed. */
const itemUpdates = lived.changes.flatMap(({ operation, changes }) =>
  changes.flatMap((change) =>
    change.kind === "item" && change.change === "update"
      ? [{ operation, id: change.row.id, fields: Object.keys(change.was ?? {}) }]
      : [],
  ),
);
const depthOf = (item: ItemFields): number => {
  let depth = 0;
  for (let above = item.parentId; above !== null; above = lived.items.get(above)?.parentId ?? null) depth++;
  return depth;
};

describe("the synthetic world", () => {
  it("is large enough for its shares to mean something", () => {
    expect(items.length).toBeGreaterThan(600);
    expect(lived.operations.length).toBeGreaterThan(10_000);
  });

  it("gives every item an importance: most are ordinary, and a few are changed later", () => {
    const of = (importance: string) =>
      share(items.filter((item) => item.importance === importance).length, items.length);

    expect(of("normal")).toBeGreaterThan(0.62);
    expect(of("normal")).toBeLessThan(0.78);
    expect(of("high")).toBeGreaterThan(0.09);
    expect(of("high")).toBeLessThan(0.21);
    expect(of("low")).toBeGreaterThan(0.09);
    expect(of("low")).toBeLessThan(0.21);
    const changed = new Set(itemUpdates.filter(({ fields }) => fields.includes("importance")).map(({ id }) => id));
    expect(share(changed.size, lived.everCreated)).toBeGreaterThan(0.01);
    expect(share(changed.size, lived.everCreated)).toBeLessThan(0.08);
  });

  it("assesses about one task in ten: its health comes with the task or by a change of its own, and is changed later for some", () => {
    const assessed = tasks.filter((task) => task.health !== null);
    const of = (health: ItemHealth) => share(assessed.filter((task) => task.health === health).length, assessed.length);
    const ofTasks = lived.healthChanges.filter(({ id }) => lived.items.get(id)?.kind === "task");
    const withTheTask = assessed.filter((task) => lived.healthGiven.get(task.id) !== null);
    const givenLater = new Set(ofTasks.filter(({ from }) => from === null).map(({ id }) => id));
    const changed = new Set(ofTasks.filter(({ from }) => from !== null).map(({ id }) => id));

    expect(share(assessed.length, tasks.length)).toBeGreaterThan(0.06);
    expect(share(assessed.length, tasks.length)).toBeLessThan(0.14);
    // Most tasks that are assessed are fine, and the fewest are in trouble.
    expect(of("green")).toBeGreaterThan(of("yellow"));
    expect(of("yellow")).toBeGreaterThan(of("red"));
    expect(of("red")).toBeGreaterThan(0);
    // About half of them were created with their health; the others got it by a change of their own.
    expect(share(withTheTask.length, assessed.length)).toBeGreaterThan(0.3);
    expect(share(withTheTask.length, assessed.length)).toBeLessThan(0.7);
    expect(withTheTask.length + givenLater.size).toBe(assessed.length);
    // And the health of some was changed after that.
    expect(share(changed.size, assessed.length)).toBeGreaterThan(0.1);
    expect(share(changed.size, assessed.length)).toBeLessThan(0.4);
    // Each of these changes is an operation by hand that changes the health of an open task, and nothing else.
    for (const { operation, from, to, open } of ofTasks) {
      expect([operation.kind, operation.origin, operation.approval, to === from, open], operation.id).toEqual([
        "update_item",
        "user",
        "manual",
        false,
        true,
      ]);
    }
    const assessments = new Set(ofTasks.map(({ operation }) => operation.id));
    expect(itemUpdates.filter(({ operation }) => assessments.has(operation.id)).map(({ fields }) => fields)).toEqual(
      ofTasks.map(() => ["health"]),
    );
  });

  it("assesses its tasks beside everything else: with every task assessed or none, it hands over the same, but for the health and its changes", () => {
    const every = handedOver({ ...SCALES.small, name: "every task is assessed", assessedTaskShare: 1 });
    const none = handedOver({ ...SCALES.small, name: "no task is assessed", assessedTaskShare: 0 });
    const known = new Set(none.map(({ operation }) => operation));
    const more = every.filter(({ operation }) => !known.has(operation));

    // Every row, every instant and every identifier of the one world is in the other, in the same order.
    expect(every.filter(({ operation }) => known.has(operation)).map(({ text }) => text)).toEqual(
      none.map(({ text }) => text),
    );
    // What the one world hands over besides: operations of their own, each the change of the health of one item.
    const assessments = more.filter(({ method }) => method === "changes");
    expect(assessments.length).toBeGreaterThan(100);
    expect(more.filter(({ method }) => method !== "changes").map(({ method }) => method)).toEqual(
      assessments.map(() => "operation"),
    );
    for (const { changed } of assessments) expect(changed).toEqual(["item update health"]);
    // The control: the changes of a health that both worlds hold are compared like every other call.
    expect(none.filter(({ changed }) => changed.includes("item update health")).length).toBeGreaterThan(0);
  });

  it("assesses later only what has a later: a task that was entered twice keeps the health it was entered with", () => {
    // Five months in which every task is assessed. A duplicate waits for its merge and nothing
    // else happens to it, as nothing does to the items that are there to show a shape.
    const every = live({ ...MONTHS, name: "every task is assessed", assessedTaskShare: 1 });
    const merged = [...every.items.values()].filter((item) => item.mergedIntoId !== null);
    const assessedLater = new Set(every.healthChanges.map(({ id }) => id));

    expect(merged.filter((item) => assessedLater.has(item.id))).toEqual([]);
    // The control: duplicates were merged, some of them entered with a health, and other tasks were assessed later.
    expect(merged.length).toBeGreaterThan(5);
    expect(merged.filter((item) => every.healthGiven.get(item.id) !== null).length).toBeGreaterThan(0);
    expect(assessedLater.size).toBeGreaterThan(300);
  });

  it("makes an assessment also where the clock is ahead of it: it waits, and is applied in a millisecond of its own", () => {
    // One day on which a capture arrives every other second and every first attempt at one is
    // interrupted. What the second attempt brings is applied half a minute after the event that
    // carries it, so from the morning to the evening the clock of the world is ahead of its events.
    const scale: Scale = {
      ...SCALES.tiny,
      name: "the clock is ahead all day",
      days: 1,
      capturesPerDay: 20_000,
      notesPerDay: 0,
      interruptedShare: 1,
      failedShare: 0,
    };
    const assessed: { from: ItemHealth | null; to: ItemHealth | null; appliedAt: number }[] = [];
    let appliedOutOfOrder = 0;
    let lastApplied = 0;
    const nothing = () => {};
    const world = createWorld(
      { scale, seed: 1, now: NOW },
      {
        file: nothing,
        capture: nothing,
        partText: nothing,
        job: nothing,
        jobChanged: nothing,
        run: nothing,
        runEnded: nothing,
        modelCall: nothing,
        operation: nothing,
        operationMoved: nothing,
        changes: (operation, changes) => {
          const appliedAt = operation.appliedAt ?? 0;
          if (appliedAt <= lastApplied) appliedOutOfOrder++;
          lastApplied = appliedAt;
          for (const { kind, change, row, was } of changes) {
            if (kind === "item" && change === "update" && was !== undefined && "health" in was && row.kind === "task") {
              assessed.push({ from: was.health ?? null, to: row.health, appliedAt });
            }
          }
        },
      },
    );
    world.day(0);
    world.finish();

    // The two assessments that every world holds, meant for ten to one and five to one: both wait
    // until the last capture of the day is through, and then each takes its turn.
    const fiveInTheAfternoon = Date.parse("2026-10-14T17:00:00.000Z");
    expect(assessed.map(({ from, to }) => `${from} to ${to}`).sort()).toEqual(["null to yellow", "yellow to red"]);
    for (const { appliedAt } of assessed) expect(appliedAt).toBeGreaterThan(fiveInTheAfternoon);
    expect(appliedOutOfOrder).toBe(0);
    expect(lastApplied).toBeLessThanOrEqual(NOW);
  });

  it("marks about one task in ten as a milestone, never a project, and never one with a start", () => {
    const milestones = items.filter((item) => item.isMilestone);

    expect(share(milestones.length, tasks.length)).toBeGreaterThan(0.06);
    expect(share(milestones.length, tasks.length)).toBeLessThan(0.14);
    expect(milestones.filter((item) => item.kind === "project" || item.startOn !== null)).toEqual([]);
    // Most milestones have their day; a few do not have one yet.
    const undated = share(milestones.filter((item) => item.dueOn === null).length, milestones.length);
    expect(undated).toBeGreaterThan(0.02);
    expect(undated).toBeLessThan(0.25);
    // And a few were tasks with a period first: the mark and the removed start in one change.
    expect(
      itemUpdates.filter(({ fields }) => fields.includes("isMilestone") && fields.includes("startOn")).length,
    ).toBeGreaterThan(0);
  });

  it("dates its items as a plan is dated: most have a due day, many a start, a few only a start", () => {
    const plain = tasks.filter((item) => !item.isMilestone);
    const both = items.filter((item) => item.startOn !== null && item.dueOn !== null);

    expect(share(tasks.filter((item) => item.dueOn !== null).length, tasks.length)).toBeGreaterThan(0.78);
    expect(share(tasks.filter((item) => item.dueOn !== null).length, tasks.length)).toBeLessThan(0.92);
    expect(share(plain.filter((item) => item.startOn !== null).length, plain.length)).toBeGreaterThan(0.36);
    expect(share(plain.filter((item) => item.startOn !== null).length, plain.length)).toBeLessThan(0.54);
    const startAlone = share(items.filter((item) => item.startOn !== null && item.dueOn === null).length, items.length);
    expect(startAlone).toBeGreaterThan(0.02);
    expect(startAlone).toBeLessThan(0.12);
    // No rule orders the two days: now and then the work begins after its due day.
    const late = share(both.filter((item) => (item.startOn as string) > (item.dueOn as string)).length, both.length);
    expect(late).toBeGreaterThan(0);
    expect(late).toBeLessThan(0.06);
  });

  it("knows about one day in eight roughly: about that day, or to a named period", () => {
    const precisions = items.flatMap((item) => [
      ...(item.startOn === null ? [] : [item.startOnPrecision]),
      ...(item.dueOn === null ? [] : [item.dueOnPrecision]),
    ]);
    const rough = precisions.filter((precision) => precision !== null);

    expect(share(rough.length, precisions.length)).toBeGreaterThan(0.08);
    expect(share(rough.length, precisions.length)).toBeLessThan(0.18);
    expect(share(rough.filter((precision) => precision === "approximate").length, rough.length)).toBeGreaterThan(0.3);
    expect(new Set(rough)).toEqual(new Set(["approximate", "week", "month", "quarter", "half", "year"]));
    // A precision is never there without its day.
    expect(
      items.filter(
        (item) =>
          (item.startOn === null && item.startOnPrecision !== null) ||
          (item.dueOn === null && item.dueOnPrecision !== null),
      ),
    ).toEqual([]);
  });

  it("moves the days of some dated items later, each change one update of the item", () => {
    const moves = itemUpdates.filter(({ fields }) => fields.includes("dueOn") || fields.includes("startOn"));
    const moved = new Set(moves.map(({ id }) => id));

    expect(share(moved.size, lived.everCreated)).toBeGreaterThan(0.05);
    expect(share(moved.size, lived.everCreated)).toBeLessThan(0.35);
    // Both days of a period move together in a good part of the changes, and not in all of them.
    const together = moves.filter(({ fields }) => fields.includes("dueOn") && fields.includes("startOn")).length;
    expect(together).toBeGreaterThan(0);
    expect(together).toBeLessThan(moves.length);
    // In about three of five, counted over the items that have a period when their due day moves.
    const withTheStart = share(lived.periodMoves.filter((both) => both).length, lived.periodMoves.length);
    expect(lived.periodMoves.length).toBeGreaterThan(40);
    expect(withTheStart).toBeGreaterThan(0.45);
    expect(withTheStart).toBeLessThan(0.75);
    // A day that moves loses the precision it had: an effect of its own.
    expect(moves.filter(({ fields }) => fields.includes("dueOnPrecision")).length).toBeGreaterThan(0);
  });

  it("builds trees: most tasks sit under another task, none deeper than eight levels", () => {
    const depths = tasks.map(depthOf);
    const underTask = tasks.filter((task) => task.parentId !== null && lived.items.get(task.parentId)?.kind === "task");

    expect(Math.max(...depths)).toBe(MONTHS.maxDepth);
    expect(share(underTask.length, tasks.length)).toBeGreaterThan(0.5);
    expect(items.filter((item) => item.kind === "project" && item.parentId !== null)).toEqual([]);
    // Tasks that stand alone, some with a tree of their own.
    const alone = tasks.filter((task) => task.parentId === null);
    expect(alone.length).toBeGreaterThan(50);
    expect(alone.filter((task) => tasks.some((other) => other.parentId === task.id)).length).toBeGreaterThan(5);
  });

  it("moves a few tasks to another parent, with everything under them, by one change of one row", () => {
    const moves = itemUpdates.filter(
      ({ operation, fields }) => operation.kind === "update_item" && fields.includes("parentId"),
    );

    expect(share(moves.length, tasks.length)).toBeGreaterThan(0.01);
    expect(share(moves.length, tasks.length)).toBeLessThan(0.06);
    for (const { fields } of moves) expect(fields).toEqual(["parentId"]);
    // No operation changes the kind of an item.
    expect(itemUpdates.filter(({ fields }) => fields.includes("kind"))).toEqual([]);
  });

  it("changes a row at most once in an operation: one statement a row, whatever it changes", () => {
    for (const { operation, changes } of lived.changes) {
      const updated = changes.filter((change) => change.change === "update").map((change) => change.row.id);
      expect(new Set(updated).size, operation.id).toBe(updated.length);
    }
  });

  it("applies its operations in the order of the clock, and never after now", () => {
    const applied = lived.changes.map(({ operation }) => operation.appliedAt ?? 0);

    expect(applied.every((instant, at) => at === 0 || instant > (applied[at - 1] ?? 0))).toBe(true);
    expect(Math.max(...lived.instants)).toBeLessThanOrEqual(NOW);
    expect(Math.min(...lived.instants)).toBeGreaterThan(NOW - 150 * 86_400_000);
  });

  it("gives every row an id that the application could have given it", () => {
    for (const kind of ["capture", "capturePart", "capturePartText", "job", "run", "operation", "item"] as const) {
      const ids = lived.ids[kind] ?? [];
      expect(ids.length, kind).toBeGreaterThan(0);
      expect(
        ids.filter((id) => !isId(kind, id)),
        kind,
      ).toEqual([]);
      expect(new Set(ids).size, kind).toBe(ids.length);
    }
  });

  it("changes a title by changing its mark: no title collects one mark after another", () => {
    const retitled = itemUpdates.filter(({ fields }) => fields.includes("title"));
    const marks = (title: string) => title.match(/ \((?:pilne|wersja 2|po zmianach|nowy zakres)\)/g)?.length ?? 0;

    // Some items are renamed more than once: that is where marks would pile up.
    expect(retitled.length).toBeGreaterThan(new Set(retitled.map(({ id }) => id)).size);
    expect(items.filter((item) => marks(item.title) > 1).map((item) => item.title)).toEqual([]);
    expect(items.filter((item) => marks(item.title) === 1).length).toBeGreaterThan(0);
  });

  it("has the owner do by hand, the day after, what a capture whose processing failed was to bring", () => {
    // A hub in which every run fails, and in which nothing that is planned is entered by hand at first.
    const failing = live({
      ...SCALES.small,
      name: "every run fails",
      failedShare: 1,
      creationChannels: { hand: 0, command: 0.5, agent: 0.5 },
    });
    const usual = live(SCALES.small);
    const created = (world: Lived) => world.changes.filter(({ operation }) => operation.kind === "create_item");
    const notByHand = (world: Lived) => created(world).filter(({ operation }) => operation.origin !== "user");

    // The tasks of the plans are there all the same, and the owner entered each of them.
    expect(created(failing).length).toBeGreaterThan(created(usual).length * 0.7);
    expect(notByHand(failing).length).toBeLessThan(5);
    expect(notByHand(usual).length).toBeGreaterThan(50);
  });

  it("is the same world again for the same seed, and another one for another", () => {
    const again = live(SCALES.tiny);
    const titles = (world: Lived) => [...world.items.values()].map((item) => `${item.id} ${item.title}`);

    expect(titles(live(SCALES.tiny))).toEqual(titles(again));
    expect(titles(live(SCALES.tiny, 7))).not.toEqual(titles(again));
  });
});

// Three years at the upper bound of what the hub is built for: what the measurement of
// performance runs on. Without a database the world of that scale takes about two seconds, so its
// shape is held here, where "npm run check" sees it, and not only where a measurement is read.
describe("the world at the full scale", () => {
  const scale = SCALES.full;
  const all = new Map<string, ItemFields>();
  const persons = new Map<string, PersonFields>();
  const links = new Map<string, SourceLinkFields>();
  const states = new Map<string, OperationState>();
  let captures = 0;
  let createdWithBothDays = 0;
  let createdStartingLate = 0;
  let markedLater = 0;
  /** The health that each task was first found in, the tasks that were created with it, and those whose health changed after that. */
  const firstHealth = new Map<string, ItemHealth>();
  const createdWithHealth = new Set<string>();
  const healthChanged = new Set<string>();
  /** The operations that were applied no later than the one that was applied before them. */
  let appliedOutOfOrder = 0;
  let lastApplied = 0;
  /** The latest day that any item ever had for its start or its due day. */
  let latestDay = "";
  const sink: Sink = {
    file: () => {},
    capture: () => {
      captures++;
    },
    partText: () => {},
    job: () => {},
    jobChanged: () => {},
    run: () => {},
    runEnded: () => {},
    modelCall: () => {},
    operation: (operation) => states.set(operation.id, operation.state),
    operationMoved: (operation) => states.set(operation.id, operation.state),
    changes: (operation, changes) => {
      if ((operation.appliedAt ?? 0) <= lastApplied) appliedOutOfOrder++;
      lastApplied = operation.appliedAt ?? 0;
      for (const one of changes) {
        const { kind, change, row } = one;
        const rows = kind === "item" ? all : kind === "person" ? persons : kind === "source_link" ? links : undefined;
        if (change === "delete") rows?.delete(row.id);
        else rows?.set(row.id, row as never);
        if (one.kind !== "item") continue;
        const { startOn, dueOn } = one.row;
        for (const day of [startOn, dueOn]) if (day !== null && day > latestDay) latestDay = day;
        if (change === "create" && startOn !== null && dueOn !== null) {
          createdWithBothDays++;
          if (startOn > dueOn) createdStartingLate++;
        }
        if (change === "update" && one.was !== undefined && "isMilestone" in one.was && "startOn" in one.was)
          markedLater++;
        // Looked at here, while the row is what the change made of it.
        const { kind: itemKind, health } = one.row;
        if (itemKind !== "task" || health === null) continue;
        if (change === "create") {
          firstHealth.set(row.id, health);
          createdWithHealth.add(row.id);
        }
        if (change === "update" && one.was !== undefined && "health" in one.was) {
          if (one.was.health === null) firstHealth.set(row.id, health);
          else healthChanged.add(row.id);
        }
      }
    },
  };
  let busiestItem: string;

  beforeAll(() => {
    const world = createWorld({ scale, seed: 1, now: NOW }, sink);
    for (let day = 0; day < scale.days; day++) world.day(day);
    busiestItem = world.finish().busiestItem;
  });

  const top = (item: ItemFields): string => {
    let above = item;
    while (above.parentId !== null) above = all.get(above.parentId) as ItemFields;
    return above.id;
  };
  const levelOf = (item: ItemFields): number => {
    let level = 0;
    for (let above = item.parentId; above !== null; above = all.get(above)?.parentId ?? null) level++;
    return level;
  };

  it("holds some ten thousand items, of which about three hundred are active", () => {
    const active = [...all.values()].filter((item) => item.closedAt === null && item.mergedIntoId === null);

    expect(all.size).toBeGreaterThan(10_000);
    expect(all.size).toBeLessThan(16_000);
    expect(active.length).toBeGreaterThan(220);
    expect(active.length).toBeLessThan(380);
  });

  it("has one project with more than two thousand rows in its tree, down to the eighth level", () => {
    const tree = [...all.values()].filter((item) => top(item) === busiestItem);

    expect(all.get(busiestItem)).toMatchObject({ kind: "project", parentId: null, closedAt: null });
    expect(tree.length).toBeGreaterThan(2_000);
    expect(Math.max(...tree.map(levelOf))).toBe(scale.maxDepth);
    // The next largest tree is a tenth of it: the project is an outlier, as one project of a hub is.
    const sizes = new Map<string, number>();
    for (const item of all.values()) sizes.set(top(item), (sizes.get(top(item)) ?? 0) + 1);
    const [largest, next] = [...sizes.values()].sort((a, b) => b - a);
    expect(largest).toBe(tree.length);
    expect(next).toBeLessThan(tree.length / 5);
  });

  it("links about every eighth piece of material to that one project", () => {
    const toIt = [...links.values()].filter((link) => link.itemId === busiestItem).length;

    expect(toIt / links.size).toBeGreaterThan(0.09);
    expect(toIt / links.size).toBeLessThan(0.16);
  });

  it("holds sixty captures for every day, five hundred persons, and a few hundred operations that wait", () => {
    const standing = [...persons.values()].filter((person) => person.mergedIntoId === null);
    const waiting = [...states.values()].filter((state) => state === "proposed" || state === "invalid");

    // One more than the days make: the capture that shows every state of an operation.
    expect(captures).toBe(scale.days * (scale.capturesPerDay + scale.notesPerDay) + 1);
    expect(standing.length).toBeGreaterThan(450);
    expect(standing.length).toBeLessThan(550);
    expect(waiting.length).toBeGreaterThan(100);
    expect(waiting.length).toBeLessThan(600);
    expect(states.size).toBeGreaterThan(350_000);
  });

  it("holds the rare shapes of a schedule often enough to be met: a start after the due day, a period that became a milestone", () => {
    // About one period in a hundred is entered with its start after its due day: nothing orders the two.
    expect(createdStartingLate / createdWithBothDays).toBeGreaterThan(0.004);
    expect(createdStartingLate / createdWithBothDays).toBeLessThan(0.03);
    // And a task with a period is marked as a milestone later, which takes its start away in the same change.
    expect(markedLater).toBeGreaterThan(8);
  });

  it("assesses one task in ten: six in ten of those are first found green, three yellow and one red, and a quarter change later", () => {
    const tasks = [...all.values()].filter((item) => item.kind === "task");
    const assessed = tasks.filter((task) => task.health !== null);
    const part = (of: (task: ItemFields) => boolean): number => assessed.filter(of).length / assessed.length;
    const firstFound = (health: ItemHealth) => part((task) => firstHealth.get(task.id) === health);

    expect(assessed.length / tasks.length).toBeGreaterThan(0.08);
    expect(assessed.length / tasks.length).toBeLessThan(0.12);
    expect(firstFound("green")).toBeGreaterThan(0.55);
    expect(firstFound("green")).toBeLessThan(0.65);
    expect(firstFound("yellow")).toBeGreaterThan(0.25);
    expect(firstFound("yellow")).toBeLessThan(0.35);
    expect(firstFound("red")).toBeGreaterThan(0.07);
    expect(firstFound("red")).toBeLessThan(0.13);
    // Half of them were created with their health, and the others got it by a change of their own.
    expect(part((task) => createdWithHealth.has(task.id))).toBeGreaterThan(0.44);
    expect(part((task) => createdWithHealth.has(task.id))).toBeLessThan(0.56);
    // About a quarter of them were assessed again after that, and found in another health.
    expect(part((task) => healthChanged.has(task.id))).toBeGreaterThan(0.2);
    expect(part((task) => healthChanged.has(task.id))).toBeLessThan(0.3);
    // Most of those were green before, so after the changes a little over half of the assessed
    // tasks are green, and the fewest are still red.
    expect(part((task) => task.health === "green")).toBeGreaterThan(0.45);
    expect(part((task) => task.health === "green")).toBeLessThan(0.6);
    expect(part((task) => task.health === "red")).toBeLessThan(part((task) => task.health === "yellow"));
    // A project keeps its health as it had it: most projects have one.
    const projects = [...all.values()].filter((item) => item.kind === "project");
    expect(projects.filter((project) => project.health !== null).length / projects.length).toBeGreaterThan(0.7);
  });

  // After a capture whose first attempt was interrupted, the operations of the second attempt are
  // applied half a minute ahead of the events of the world. In three years some assessments of a
  // task fall into such a stretch, and wait until the clock has passed.
  it("applies every operation after the one before it, also an assessment that finds the clock ahead of it", () => {
    expect(appliedOutOfOrder).toBe(0);
    expect(lastApplied).toBeLessThanOrEqual(NOW);
  });

  it("reaches three years back with its history and less than ten years ahead with its plans", () => {
    const today = new Date(NOW).toISOString().slice(0, 10) as Day;

    // What the bounds of the "now" that a command takes leave free at either end of the years of the database.
    expect(scale.days).toBeLessThan(3_650);
    expect(latestDay > today).toBe(true);
    expect(latestDay < addDays(today, 3_650)).toBe(true);
  });

  it("keeps its titles short however long an item lives", () => {
    expect(Math.max(...[...all.values()].map((item) => item.title.length))).toBeLessThan(100);
  });
});
