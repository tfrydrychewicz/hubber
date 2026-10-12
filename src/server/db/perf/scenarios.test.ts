// The scenarios of the measurement, on a workspace that holds a few days of history. Nothing here
// looks at a clock: what is counted is commits and rows, which are the same on every machine.
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT_FAILURE, EXIT_INCONCLUSIVE } from "../../exit-codes.ts";
import { type OpenWorkspace, openWorkspace } from "../../workspace/open.ts";
import { createTestWorkspace, type TestWorkspace } from "../../workspace/testing.ts";
import { DIRECT_TRANSPORT } from "../../workspace/transport.ts";
import { createDb, type Db } from "../handle.ts";
import { readMigrations } from "../migrate.ts";
import { checkInvariants, DATA_TABLES, generateSynthetic } from "../synthetic/index.ts";
import { createWriter } from "../synthetic/writer.ts";
import { commitsDuring } from "./commits.ts";
import { READS } from "./reads.ts";
import {
  BUDGETS,
  commitRun,
  judge,
  type Measured,
  measureMigrations,
  measureReads,
  measureReferenceCommits,
  measureSnapshot,
  measureWrites,
  outcomeOf,
  type ReadTiming,
  rebuildStatements,
  saveCapture,
  stageOperation,
  startRun,
  type Target,
  type Timing,
  timed,
  timingOf,
  verdictOf,
} from "./scenarios.ts";

const workspaces: TestWorkspace[] = [];
const open: OpenWorkspace[] = [];

afterEach(() => {
  for (const workspace of open.splice(0)) workspace.close();
  for (const workspace of workspaces.splice(0)) workspace.remove();
});

/** A workspace as the application opens it, filled with the smallest world. */
function target(): Target & { wal: string; rows: (table: string) => number; later: (seconds: number) => Date } {
  const created = createTestWorkspace();
  workspaces.push(created);
  const opened = openWorkspace({ dir: created.dir, source: "variable" }, {}, DIRECT_TRANSPORT);
  open.push(opened);
  const connection = opened.database;
  const db = createDb(connection);
  const world = generateSynthetic(db, { scale: "tiny" });
  return {
    db,
    connection,
    file: opened.paths.database,
    backups: opened.paths.backups,
    world,
    wal: `${opened.paths.database}-wal`,
    rows: (table) => connection.prepare(`SELECT count(*) FROM "${table}"`).pluck().get() as number,
    // After the newest row of the history: the journal stays in the order of its instants.
    later: (seconds) => new Date(Date.parse(world.now) + seconds * 1_000),
  };
}

describe("saving a capture", () => {
  it("is one commit: its registry row, the capture, its parts and its job go in together", () => {
    const { db, wal, rows, later } = target();
    const sink = createWriter(db);
    const counts = () => ({
      sources: rows("sources"),
      captures: rows("captures"),
      parts: rows("capture_parts"),
      jobs: rows("queue_jobs"),
    });
    const before = counts();

    const commits = commitsDuring(wal, () => saveCapture(db, sink, later(60)));

    expect(commits).toBe(1);
    expect(counts()).toEqual({
      sources: before.sources + 1,
      captures: before.captures + 1,
      parts: before.parts + 2,
      jobs: before.jobs + 1,
    });
  });

  it("would be a commit a statement without its transaction: five waits for the drive instead of one", () => {
    const { db, wal, later } = target();
    const sink = createWriter(db);
    const withoutTransaction = { transaction: (fn: () => void) => fn() } as unknown as Db;

    expect(commitsDuring(wal, () => saveCapture(withoutTransaction, sink, later(60)))).toBe(5);
  });

  it("leaves a job that waits for the worker, for the capture it saved", () => {
    const { db, connection, later } = target();

    const { capture, job } = saveCapture(db, createWriter(db), later(60));

    expect(
      connection.prepare("SELECT kind, state, source_id, attempts FROM queue_jobs WHERE id = ?").get(job.id),
    ).toEqual({
      kind: "process_capture",
      state: "queued",
      source_id: capture.id,
      attempts: 0,
    });
    expect(
      connection
        .prepare("SELECT kind FROM capture_parts WHERE capture_id = ? ORDER BY position")
        .pluck()
        .all(capture.id),
    ).toEqual(["typed", "pasted"]);
  });
});

describe("processing a capture", () => {
  it("is one commit for the start of the run, one for every staged operation, and one for the whole card", () => {
    const { db, connection, wal, world, later } = target();
    const sink = createWriter(db);
    const saved = saveCapture(db, sink, later(60));
    const commits: number[] = [];
    const counted = <Result>(fn: () => Result): Result => {
      let result: Result | undefined;
      commits.push(
        commitsDuring(wal, () => {
          result = fn();
        }),
      );
      return result as Result;
    };

    const run = counted(() => startRun(db, sink, saved, later(61)));
    const operations = Array.from({ length: 7 }, (_, seq) =>
      counted(() => stageOperation(sink, run, seq, later(62 + seq))),
    );
    counted(() => commitRun(db, sink, saved, run, operations, world, later(70)));

    expect(commits).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const source = saved.capture.id;
    expect(connection.prepare("SELECT state, ended_at FROM runs WHERE id = ?").get(run.id)).toEqual({
      state: "committed",
      ended_at: later(70).toISOString(),
    });
    expect(
      connection
        .prepare("SELECT kind, state, approval, applied_at FROM operations WHERE run_id = ? ORDER BY seq")
        .all(run.id),
    ).toEqual(
      ["link_source", "add_fact", "add_fact", "add_fact", "resolve_mention", "resolve_mention", "resolve_mention"].map(
        (kind) => ({ kind, state: "applied", approval: "auto", applied_at: later(70).toISOString() }),
      ),
    );
    // Every operation with its row and with the effect that records it.
    expect(
      connection
        .prepare(
          `SELECT e.entity_kind AS kind, count(*) AS effects FROM operation_effects e JOIN operations o ON o.id = e.operation_id
            WHERE o.run_id = ? GROUP BY e.entity_kind ORDER BY e.entity_kind`,
        )
        .all(run.id),
    ).toEqual([
      { kind: "fact", effects: 3 },
      { kind: "mention", effects: 3 },
      { kind: "source_link", effects: 1 },
    ]);
    expect(connection.prepare("SELECT count(*) FROM facts WHERE source_id = ?").pluck().get(source)).toBe(3);
    expect(connection.prepare("SELECT count(*) FROM mentions WHERE source_id = ?").pluck().get(source)).toBe(3);
    expect(connection.prepare("SELECT item_id FROM source_links WHERE source_id = ?").pluck().all(source)).toEqual([
      world.busiestItem,
    ]);
    expect(connection.prepare("SELECT state, finished_at FROM queue_jobs WHERE id = ?").get(saved.job.id)).toEqual({
      state: "done",
      finished_at: later(70).toISOString(),
    });
  });
});

describe("measureWrites", () => {
  it("times every round after the warm-up, and leaves the data within its rules", () => {
    const measured = target();
    const captures = measured.rows("captures");

    const timings = measureWrites(measured, 2, 1);

    // Three rounds, of which the first only warms the connection up: seven operations a round.
    expect([timings.saveCapture.samples, timings.stageOperation.samples, timings.commitRun.samples]).toEqual([
      2, 14, 2,
    ]);
    expect(measured.rows("captures")).toBe(captures + 3);
    for (const timing of Object.values(timings) as Timing[]) {
      expect(timing.median).toBeGreaterThan(0);
      expect(timing.p95).toBeGreaterThanOrEqual(timing.median);
    }
    expect(checkInvariants(measured.db)).toEqual([]);
    expect(measured.connection.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("measureReferenceCommits", () => {
  it("commits one small row a sample, which nothing else reads", () => {
    const measured = target();
    const before = Object.fromEntries(DATA_TABLES.map((table) => [table, measured.rows(table)]));
    let timing: Timing | undefined;

    const commits = commitsDuring(measured.wal, () => {
      timing = measureReferenceCommits(measured, 4);
    });

    expect(commits).toBe(4);
    expect(timing?.samples).toBe(4);
    expect(Object.fromEntries(DATA_TABLES.map((table) => [table, measured.rows(table)]))).toEqual({
      ...before,
      files: (before.files ?? 0) + 4,
    });
    // No part points at them: the reads of a capture and the check of the files never meet them.
    expect(checkInvariants(measured.db)).toEqual([]);
  });
});

describe("measureReads", () => {
  it("runs every representative read as often as asked, and writes nothing", () => {
    const measured = target();
    let reads: ReturnType<typeof measureReads> = [];

    const commits = commitsDuring(measured.wal, () => {
      reads = measureReads(measured, 3);
    });

    expect(commits).toBe(0);
    expect(reads.map(({ name }) => name)).toEqual(READS.map(({ name }) => name));
    for (const read of reads) expect(read.timing.samples, read.name).toBe(3);
    expect(reads.filter(({ unbounded }) => unbounded).map(({ name }) => name)).toEqual(
      READS.filter(({ unbounded }) => unbounded === true).map(({ name }) => name),
    );
    expect(reads.filter(({ wholeHistory }) => wholeHistory).map(({ name }) => name)).toEqual(
      READS.filter(({ wholeHistory }) => wholeHistory === true).map(({ name }) => name),
    );
    // The number of rows is what the read returns: the tree of the busiest item, for one.
    const tree = measured.connection
      .prepare(
        `WITH RECURSIVE tree (id) AS (SELECT ? UNION ALL SELECT c.id FROM tree JOIN items c ON c.parent_id = tree.id WHERE c.merged_into_id IS NULL)
         SELECT count(*) FROM tree`,
      )
      .pluck()
      .get(measured.world.busiestItem);
    expect(reads.find(({ name }) => name.startsWith("tree: the rows of the chart"))?.rows).toBe(tree);
  });
});

describe("measureSnapshot", () => {
  it("copies the whole database and leaves no copy behind", () => {
    const measured = target();
    const beside = readdirSync(dirname(measured.file)).sort();
    const pages = measured.connection.pragma("page_count", { simple: true }) as number;
    const pageSize = measured.connection.pragma("page_size", { simple: true }) as number;

    const snapshot = measureSnapshot(measured);

    expect(snapshot.milliseconds).toBeGreaterThan(0);
    // A copy without free pages is never larger than its original, and holds every row of it.
    expect(snapshot.bytes).toBeGreaterThan(100_000);
    expect(snapshot.bytes).toBeLessThanOrEqual(pages * pageSize);
    expect(readdirSync(dirname(measured.file)).sort()).toEqual(beside);
  });
});

describe("measureMigrations", () => {
  const objects = (measured: Target, type: string): string[] =>
    measured.connection
      .prepare("SELECT name FROM sqlite_schema WHERE type = ? ORDER BY name")
      .pluck()
      .all(type) as string[];
  const columns = (measured: Target): string[] =>
    measured.connection.prepare("SELECT name FROM pragma_table_xinfo('operations')").pluck().all() as string[];

  it("starts twice with a migration of its own: a new column on operations, then a rebuild of the table", () => {
    const measured = target();
    const before = {
      rows: Object.fromEntries(DATA_TABLES.map((table) => [table, measured.rows(table)])),
      triggers: objects(measured, "trigger"),
      indexes: objects(measured, "index"),
      columns: columns(measured),
    };
    const real = readMigrations().map(({ tag }) => tag);

    const timings = measureMigrations(measured);

    expect(timings.addColumn).toBeGreaterThan(0);
    expect(timings.rebuild).toBeGreaterThan(0);
    expect(measured.connection.prepare("SELECT tag FROM schema_migrations ORDER BY idx").pluck().all()).toEqual([
      ...real,
      `${String(real.length + 1).padStart(4, "0")}_operation_note`,
      `${String(real.length + 2).padStart(4, "0")}_rebuild_operations`,
    ]);
    expect(columns(measured)).toEqual([...before.columns, "note"]);
    // The rebuild put back every index and every trigger, also those of other tables that name operations.
    expect(objects(measured, "trigger")).toEqual(before.triggers);
    expect(objects(measured, "index")).toEqual(before.indexes);
    expect(Object.fromEntries(DATA_TABLES.map((table) => [table, measured.rows(table)]))).toEqual(before.rows);
    expect(measured.connection.pragma("foreign_key_check")).toEqual([]);
    expect(measured.connection.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(checkInvariants(measured.db)).toEqual([]);
    // The guards are in force on the table that was built anew.
    expect(() =>
      measured.connection.prepare("UPDATE operations SET kind = 'add_fact' WHERE state = 'applied'").run(),
    ).toThrow(/^operations: /);
    // Each start made its copy first, and the measurement removed both again.
    expect(readdirSync(measured.backups)).toEqual([]);
  });

  it("leaves a database on which the reference commits can still be taken: they are what a measurement ends with", () => {
    const measured = target();
    measureMigrations(measured);
    // A start that migrates leaves the log empty: one commit, and commits can be counted again.
    measureReferenceCommits(measured, 1);
    const files = measured.rows("files");

    const commits = commitsDuring(measured.wal, () => void measureReferenceCommits(measured, 3));

    expect(commits).toBe(3);
    expect(measured.rows("files")).toBe(files + 3);
  });
});

describe("rebuildStatements", () => {
  it("takes every trigger that names the table away first, and puts each back at the end", () => {
    const { connection } = target();

    const statements = rebuildStatements(connection, "operations");

    const dropped = statements.flatMap((statement) => /^DROP TRIGGER (\S+)$/.exec(statement)?.[1] ?? []);
    const created = statements.flatMap((statement) => /^CREATE TRIGGER (\S+)/.exec(statement)?.[1] ?? []);
    expect(dropped.length).toBeGreaterThan(5);
    expect(created).toEqual(dropped);
    // Triggers of other tables read operations too: left in place, they would point at a table that is gone.
    const elsewhere = connection
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name <> 'operations' AND sql LIKE '%operations%'",
      )
      .pluck()
      .all() as string[];
    expect(elsewhere.length).toBeGreaterThan(0);
    expect(dropped).toEqual(expect.arrayContaining(elsewhere));
    const body = statements.slice(dropped.length, statements.length - created.length);
    expect(body.map((statement) => statement.slice(0, 28))).toEqual([
      "CREATE TABLE new_operations ",
      "INSERT INTO new_operations (",
      "DROP TABLE operations",
      "ALTER TABLE new_operations R",
      ...connection
        .prepare(
          "SELECT substr(sql, 1, 28) FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'operations' AND sql IS NOT NULL ORDER BY rowid",
        )
        .pluck()
        .all(),
    ]);
  });
});

describe("timingOf", () => {
  it("gives the median and the 95th percentile of its samples, never the slowest of many", () => {
    expect(timingOf([5, 1, 3, 2, 4])).toEqual({ median: 3, p95: 5, samples: 5 });
    const hundred = Array.from({ length: 100 }, (_, at) => 100 - at);
    expect(timingOf(hundred)).toEqual({ median: 51, p95: 96, samples: 100 });
    expect(timingOf([])).toEqual({ median: 0, p95: 0, samples: 0 });
  });
});

describe("timed", () => {
  it("returns what the function returned, and how long it took", () => {
    const [result, milliseconds] = timed(() => "done");

    expect(result).toBe("done");
    expect(milliseconds).toBeGreaterThanOrEqual(0);
    expect(milliseconds).toBeLessThan(1_000);
  });
});

describe("verdictOf", () => {
  const commit = (median: number): Timing => ({ median, p95: median * 2, samples: 50 });
  const calm = [commit(3), commit(3.4)];

  it("says that the budgets were kept, or that some were not", () => {
    expect(verdictOf(calm, [])).toBe("within");
    expect(verdictOf(calm, ["Zapis wrzutki (jedna transakcja)"])).toBe("exceeded");
  });

  it("says first that the machine was too busy, before or after the measurement, whatever was measured", () => {
    expect(verdictOf([commit(3), commit(BUDGETS.referenceCommit + 0.1)], [])).toBe("busy");
    expect(verdictOf([commit(40), commit(3)], ["Kopia bazy (VACUUM INTO)"])).toBe("busy");
    // Up to three times the usual commit, the machine is calm enough.
    expect(verdictOf([commit(BUDGETS.referenceCommit), commit(3)], [])).toBe("within");
  });
});

describe("judge", () => {
  const timing = (median: number, p95: number): Timing => ({ median, p95, samples: 200 });
  const read = (name: string, median: number, p95: number, more: Partial<ReadTiming> = {}): ReadTiming => ({
    name,
    rows: 1,
    timing: timing(median, p95),
    unbounded: false,
    wholeHistory: false,
    ...more,
  });
  // Made up, and all of it well inside the budgets.
  const calm: Measured = {
    generation: 120_000,
    writes: { saveCapture: timing(3, 6), stageOperation: timing(3, 4), commitRun: timing(6, 9) },
    reads: [read("a", 0.5, 0.6), read("b", 5, 5.5), read("c", 1, 1.2)],
    snapshot: 3_400,
    migrations: { addColumn: 4_800, rebuild: 9_500 },
  };
  const exceededIn = (measured: Partial<Measured>): string[] =>
    judge(measured)
      .filter(({ within }) => !within)
      .map(({ scenario }) => scenario);

  it("holds every scenario to its own budget, in the order of the measurement", () => {
    expect(judge(calm)).toEqual([
      { scenario: "generation", took: 120_000, limit: BUDGETS.generation, within: true },
      { scenario: "saveCapture", took: 6, limit: BUDGETS.saveCapture, within: true },
      { scenario: "stageOperation", took: 4, limit: BUDGETS.stageOperation, within: true },
      { scenario: "commitRun", took: 9, limit: BUDGETS.commitRun, within: true },
      { scenario: "read", took: 5, limit: BUDGETS.read, within: true },
      { scenario: "snapshot", took: 3_400, limit: BUDGETS.snapshot, within: true },
      { scenario: "addColumn", took: 4_800, limit: BUDGETS.migration, within: true },
      { scenario: "rebuild", took: 9_500, limit: BUDGETS.migration, within: true },
    ]);
  });

  it("judges a write by its 95th percentile: a median inside the budget does not save it, one outside does not condemn it", () => {
    const slowTail = { ...calm.writes, saveCapture: timing(3, BUDGETS.saveCapture + 1) };
    const slowMiddle = { ...calm.writes, commitRun: timing(BUDGETS.commitRun + 1, BUDGETS.commitRun) };

    expect(exceededIn({ ...calm, writes: slowTail })).toEqual(["saveCapture"]);
    // Made up to tell the two numbers apart: a real median is never above its 95th percentile.
    expect(exceededIn({ ...calm, writes: slowMiddle })).toEqual([]);
    expect(exceededIn({ ...calm, writes: { ...calm.writes, stageOperation: timing(1, 31) } })).toEqual([
      "stageOperation",
    ]);
  });

  it("judges the reads by the slowest median among them, whatever its 95th percentile", () => {
    const oneSlowSample = [...calm.reads, read("d", 2, 400)];
    const slowRead = [...calm.reads, read("d", BUDGETS.read + 0.1, 21)];

    expect(judge({ reads: oneSlowSample })).toEqual([{ scenario: "read", took: 5, limit: BUDGETS.read, within: true }]);
    expect(judge({ reads: slowRead })).toEqual([
      { scenario: "read", took: BUDGETS.read + 0.1, limit: BUDGETS.read, within: false },
    ]);
  });

  it("holds a read that returns the whole of the longest history to no budget, and every other read to it", () => {
    const wholeHistory = read("the whole history of an item", 22, 25, { unbounded: true });
    const wholeTable = read("the whole log of calls", 22, 25, { wholeHistory: true });

    expect(judge({ reads: [...calm.reads, wholeHistory] })).toEqual([
      { scenario: "read", took: 5, limit: BUDGETS.read, within: true },
    ]);
    expect(exceededIn({ reads: [...calm.reads, wholeTable] })).toEqual(["read"]);
    // Nothing is left to judge when no read has a budget.
    expect(judge({ reads: [wholeHistory] })).toEqual([]);
  });

  it("takes a number that equals its budget for one that keeps to it", () => {
    const atTheLimit: Measured = {
      generation: BUDGETS.generation,
      writes: {
        saveCapture: timing(1, BUDGETS.saveCapture),
        stageOperation: timing(1, BUDGETS.stageOperation),
        commitRun: timing(1, BUDGETS.commitRun),
      },
      reads: [read("a", BUDGETS.read, 99)],
      snapshot: BUDGETS.snapshot,
      migrations: { addColumn: BUDGETS.migration, rebuild: BUDGETS.migration },
    };

    expect(exceededIn(atTheLimit)).toEqual([]);
    expect(
      exceededIn({
        ...atTheLimit,
        generation: BUDGETS.generation + 1,
        snapshot: BUDGETS.snapshot + 1,
        migrations: { addColumn: BUDGETS.migration + 1, rebuild: BUDGETS.migration + 1 },
      }),
    ).toEqual(["generation", "snapshot", "addColumn", "rebuild"]);
  });

  it("judges what was measured so far, while a measurement is under way", () => {
    expect(judge({})).toEqual([]);
    expect(judge({ generation: 1 }).map(({ scenario }) => scenario)).toEqual(["generation"]);
    expect(judge({ generation: 1, writes: calm.writes }).map(({ scenario }) => scenario)).toEqual([
      "generation",
      "saveCapture",
      "stageOperation",
      "commitRun",
    ]);
  });
});

describe("outcomeOf", () => {
  const commit = (median: number): Timing => ({ median, p95: median * 2, samples: 50 });
  const calmMachine = [commit(3), commit(3.4)];
  const kept = { scenario: "snapshot", took: 1, limit: 2, within: true } as const;
  const missed = { scenario: "saveCapture", took: 31, limit: 30, within: false } as const;
  const alsoMissed = { scenario: "rebuild", took: 61_000, limit: 60_000, within: false } as const;

  it("ends with 0 when every budget was kept", () => {
    expect(outcomeOf(calmMachine, [kept])).toEqual({ verdict: "within", exceeded: [], exitCode: 0 });
  });

  it("names what took longer than it may, in the order of the measurement, and ends with the code of a failed run", () => {
    expect(outcomeOf(calmMachine, [missed, kept, alsoMissed])).toEqual({
      verdict: "exceeded",
      exceeded: ["saveCapture", "rebuild"],
      exitCode: EXIT_FAILURE,
    });
  });

  it("ends with a code of its own when the machine was too busy, whatever was exceeded", () => {
    const busyMachine = [commit(3), commit(BUDGETS.referenceCommit + 1)];

    expect(outcomeOf(busyMachine, [kept])).toEqual({ verdict: "busy", exceeded: [], exitCode: EXIT_INCONCLUSIVE });
    expect(outcomeOf(busyMachine, [missed]).exitCode).toBe(EXIT_INCONCLUSIVE);
    expect(EXIT_INCONCLUSIVE).not.toBe(EXIT_FAILURE);
  });
});
