// What the application does to its database, as functions that a measurement and a test share:
// saving a capture, staging and committing the operations of a run, the reads of the views, a
// copy of the database, a start that migrates. "npm run perf" times them on three years of
// synthetic history; the tests run the same functions on a small world and count what does not
// depend on the machine, so that none of them can rot unseen.
import { createHash, randomBytes } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { newId } from "../../../shared/ids.ts";
import type { Day } from "../../../shared/time.ts";
import { EXIT_FAILURE, EXIT_INCONCLUSIVE } from "../../exit-codes.ts";
import { snapshotWorkspaceDatabase, type WorkspaceDatabase } from "../../workspace/database.ts";
import type { Db } from "../handle.ts";
import { type Migration, migrateDatabase, readMigrations, schemaFingerprint } from "../migrate.ts";
import type { SyntheticManifest } from "../synthetic/index.ts";
import type {
  Change,
  FactFields,
  MentionFields,
  Sink,
  SourceLinkFields,
  WorldCapture,
  WorldJob,
  WorldOperation,
  WorldRun,
} from "../synthetic/world.ts";
import { createWriter } from "../synthetic/writer.ts";
import { compiled } from "./plans.ts";
import { READS, readContext } from "./reads.ts";

/** A database that holds a synthetic world, with what the scenarios need to know about it. */
export interface Target {
  db: Db;
  connection: WorkspaceDatabase;
  /** The file of the database. */
  file: string;
  /** Where a start that migrates puts its copy of the database. */
  backups: string;
  world: Pick<SyntheticManifest, "now" | "me" | "busiestItem" | "openCardSource">;
}

/**
 * What a scenario may take, in milliseconds. Each is above what was measured on three years of
 * history, most of them several times: a budget that is exceeded means that something changed,
 * not that the machine was busy. The two that come closest to theirs are the generation and the
 * one read that walks a table which grows with the history.
 */
export const BUDGETS = {
  /** Saving a capture: the 95th percentile. A tenth of what the owner may wait for it. */
  saveCapture: 30,
  /** Staging one operation, and committing a run of seven: the 95th percentile. */
  stageOperation: 30,
  commitRun: 60,
  /** Any single read: the median. A view asks a handful of them and has 300 ms. */
  read: 20,
  snapshot: 30_000,
  /** A start that migrates, with the copy it makes first. */
  migration: 60_000,
  generation: 180_000,
  /** A commit that only waits for the drive takes about 3 ms. Three times slower, and the machine is too busy to measure on. */
  referenceCommit: 9,
} as const;

export interface Timing {
  /** In milliseconds. Never a maximum: one slow sample is the machine, not the code. */
  median: number;
  p95: number;
  samples: number;
}

/** Runs the function and says how long it took, in milliseconds. */
export function timed<Result>(fn: () => Result): [result: Result, milliseconds: number] {
  const from = process.hrtime.bigint();
  const result = fn();
  return [result, Number(process.hrtime.bigint() - from) / 1e6];
}

export function timingOf(samples: readonly number[]): Timing {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (share: number): number => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0;
  return { median: at(0.5), p95: at(0.95), samples: sorted.length };
}

/** What a measurement comes to. */
export type Verdict = "within" | "exceeded" | "busy";

/**
 * The verdict on a measurement, from the reference commits taken before and after it and from the
 * scenarios that took longer than they may. The machine is looked at first: a measurement on one
 * that was too busy says nothing about the code, whatever it measured.
 */
export function verdictOf(referenceCommits: readonly Timing[], exceeded: readonly string[]): Verdict {
  if (referenceCommits.some(({ median }) => median > BUDGETS.referenceCommit)) return "busy";
  return exceeded.length > 0 ? "exceeded" : "within";
}

// ---------------------------------------------------------------------------------------------------
// Writes.
// ---------------------------------------------------------------------------------------------------

export interface SavedCapture {
  capture: WorldCapture;
  job: WorldJob;
}

/**
 * Saves a capture the way the server will: its registry row, the capture, a typed remark and
 * pasted material, and the job that will process it, in one transaction. One commit, so one wait
 * for the drive, whatever the capture holds.
 */
export function saveCapture(db: Db, sink: Sink, at: Date): SavedCapture {
  const savedAt = at.getTime();
  const id = newId("capture");
  const capture: WorldCapture = {
    id,
    createdAt: savedAt,
    occurredOn: at.toISOString().slice(0, 10) as Day,
    occurredOnApproximate: true,
    parts: [
      {
        id: newId("capturePart"),
        position: 0,
        kind: "typed",
        text: "zobacz, co z tym zrobić",
        file: null,
        fileName: null,
      },
      {
        id: newId("capturePart"),
        position: 1,
        kind: "pasted",
        text: "[10:42] Piotr Nowak: czy mamy już termin dla migracji płatności? Klient pyta o okno serwisowe.\n".repeat(
          20,
        ),
        file: null,
        fileName: null,
      },
    ],
  };
  const job: WorldJob = {
    id: newId("job"),
    kind: "process_capture",
    state: "queued",
    sourceId: id,
    dedupeKey: `process_capture:${id}`,
    attempts: 0,
    maxAttempts: 5,
    runAfter: savedAt,
    leasedUntil: null,
    createdAt: savedAt,
    startedAt: null,
    finishedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    payload: { capture_id: id },
  };
  db.transaction(
    () => {
      sink.capture(capture);
      sink.job(job);
    },
    { behavior: "immediate" },
  );
  return { capture, job };
}

/** The worker takes the job of a saved capture and starts a run for it. */
export function startRun(db: Db, sink: Sink, { capture, job }: SavedCapture, at: Date): WorldRun {
  const startedAt = at.getTime();
  const run: WorldRun = {
    id: newId("run"),
    kind: "process_capture",
    state: "running",
    sourceId: capture.id,
    jobId: job.id,
    model: "model-large",
    promptVersion: "process-capture@4",
    startedAt,
    endedAt: null,
    errorCode: null,
    errorMessage: null,
    summary: null,
  };
  job.state = "running";
  job.attempts += 1;
  job.startedAt = startedAt;
  job.leasedUntil = startedAt + 600_000;
  db.transaction(
    () => {
      sink.jobChanged(job);
      sink.run(run);
    },
    { behavior: "immediate" },
  );
  return run;
}

/** The kinds of the seven operations that the run of a typical capture stages, in their order. */
const STAGED = [
  "link_source",
  "add_fact",
  "add_fact",
  "add_fact",
  "resolve_mention",
  "resolve_mention",
  "resolve_mention",
] as const;

/** The agent stages one operation while its run is running: one row, one commit. */
export function stageOperation(sink: Sink, run: WorldRun, seq: number, at: Date): WorldOperation {
  const operation: WorldOperation = {
    id: newId("operation"),
    runId: run.id,
    seq,
    kind: STAGED[seq % STAGED.length] ?? "link_source",
    origin: "inference",
    state: "staged",
    confidence: "high",
    approval: null,
    sourceId: run.sourceId,
    undoneById: null,
    createdAt: at.getTime(),
    decidedAt: null,
    appliedAt: null,
    quote: "czy mamy już termin dla migracji płatności?",
    commandQuote: null,
    rationale: "Wątek wymienia projekt z nazwy, a zdanie opisuje konkretne ustalenie.",
    answer: null,
    annotations: null,
    problems: null,
    proposedPayload: null,
    payload: { seq },
  };
  sink.operation(operation, []);
  return operation;
}

/**
 * "finish": the run is committed and every operation it staged is applied, each with its row and
 * its effect, and the job is done. One transaction: either the whole card is in the data, or none of it.
 */
export function commitRun(
  db: Db,
  sink: Sink,
  { capture, job }: SavedCapture,
  run: WorldRun,
  operations: readonly WorldOperation[],
  world: Target["world"],
  at: Date,
): void {
  const appliedAt = at.getTime();
  db.transaction(
    () => {
      run.state = "committed";
      run.endedAt = appliedAt;
      run.summary = "Powiązano z jednym itemem.";
      sink.runEnded(run);
      for (const operation of operations) {
        operation.state = "applied";
        operation.approval = "auto";
        operation.appliedAt = appliedAt;
        sink.operationMoved(operation);
        sink.changes(operation, [whatItDoes(operation, capture, world, appliedAt)]);
      }
      job.state = "done";
      job.leasedUntil = null;
      job.finishedAt = appliedAt;
      sink.jobChanged(job);
    },
    { behavior: "immediate" },
  );
}

function whatItDoes(operation: WorldOperation, capture: WorldCapture, world: Target["world"], at: number): Change {
  const item = world.busiestItem;
  if (operation.kind === "link_source") {
    const row: SourceLinkFields = { id: newId("sourceLink"), sourceId: capture.id, itemId: item, createdAt: at };
    return { kind: "source_link", change: "create", row, item, person: null };
  }
  if (operation.kind === "add_fact") {
    const row: FactFields = {
      id: newId("fact"),
      itemId: item,
      type: "info",
      occurredOn: capture.occurredOn,
      occurredOnApproximate: true,
      sourceId: capture.id,
      outdatedAt: null,
      supersededByFactId: null,
      createdAt: at,
      quote: "czy mamy już termin dla migracji płatności?",
      text: "Klient pyta o termin migracji płatności.",
    };
    return { kind: "fact", change: "create", row, item, person: null };
  }
  const row: MentionFields = {
    id: newId("mention"),
    sourceId: capture.id,
    personId: world.me,
    skippedAt: null,
    createdAt: at,
    surface: "Piotr Nowak",
    baseForm: "Piotr Nowak",
  };
  return { kind: "mention", change: "create", row, item: null, person: world.me };
}

export interface WriteTimings {
  saveCapture: Timing;
  stageOperation: Timing;
  commitRun: Timing;
}

/**
 * Saves captures and processes each of them: seven operations staged one by one, then the run
 * committed. The first rounds warm the connection up and are left out of the timings.
 */
export function measureWrites(target: Target, rounds: number, warmUp = 5): WriteTimings {
  const { db, world } = target;
  const sink = createWriter(db);
  // After the newest row of the history, so that the journal stays in the order of its instants.
  let clock = Date.parse(world.now) + 60_000;
  const tick = (): Date => {
    clock += 1_000;
    return new Date(clock);
  };
  const save: number[] = [];
  const stage: number[] = [];
  const commit: number[] = [];
  for (let round = 0; round < rounds + warmUp; round++) {
    const [saved, saveMs] = timed(() => saveCapture(db, sink, tick()));
    const run = startRun(db, sink, saved, tick());
    const operations = STAGED.map((_kind, seq) => {
      const [operation, stageMs] = timed(() => stageOperation(sink, run, seq, tick()));
      if (round >= warmUp) stage.push(stageMs);
      return operation;
    });
    const [, commitMs] = timed(() => commitRun(db, sink, saved, run, operations, world, tick()));
    if (round >= warmUp) {
      save.push(saveMs);
      commit.push(commitMs);
    }
  }
  return { saveCapture: timingOf(save), stageOperation: timingOf(stage), commitRun: timingOf(commit) };
}

/** A commit that writes one small row and waits for the drive: what the machine can do at best right now. */
export function measureReferenceCommits(target: Target, count = 50): Timing {
  const sink = createWriter(target.db);
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    // The row of a file that no part uses: it changes nothing that a scenario reads.
    const file = {
      sha256: createHash("sha256").update(randomBytes(16)).digest("hex"),
      byteSize: 0,
      mediaType: "application/octet-stream",
      createdAt: Date.parse(target.world.now),
    };
    samples.push(timed(() => sink.file(file))[1]);
  }
  return timingOf(samples);
}

// ---------------------------------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------------------------------

export interface ReadTiming {
  name: string;
  rows: number;
  timing: Timing;
  /** Held to no budget: it returns the whole of the longest history. */
  unbounded: boolean;
  /** Its time grows with the history: it reads all of a table that does. */
  wholeHistory: boolean;
}

/** Runs every representative read: once to warm it up, then as often as asked. */
export function measureReads(target: Target, runs: number): ReadTiming[] {
  const context = readContext(target.db, target.world);
  return READS.map((read) => {
    const { sql, params } = compiled(read.query(context));
    const statement = target.connection.prepare(sql);
    const rows = statement.all(...params).length;
    const samples = Array.from({ length: runs }, () => timed(() => statement.all(...params))[1]);
    return {
      name: read.name,
      rows,
      timing: timingOf(samples),
      unbounded: read.unbounded === true,
      wholeHistory: read.wholeHistory === true,
    };
  });
}

// ---------------------------------------------------------------------------------------------------
// The copy of the database, and a start that migrates.
// ---------------------------------------------------------------------------------------------------

/** Makes a whole copy of the database beside it, as a start that migrates does, and removes it again. */
export function measureSnapshot(target: Target): { milliseconds: number; bytes: number } {
  const copy = join(dirname(target.file), "pomiar-kopia.sqlite");
  try {
    const [, milliseconds] = timed(() => snapshotWorkspaceDatabase(target.connection, copy));
    return { milliseconds, bytes: statSync(copy).size };
  } finally {
    rmSync(copy, { force: true });
  }
}

/**
 * The statements that rebuild a table without changing it, by the one procedure that a migration
 * follows when it changes a CHECK, a key or NOT NULL: every trigger whose text names the table
 * goes first, also those on other tables; the rows move into a new table that takes the old
 * name; the indexes and the triggers come back as they were.
 */
export function rebuildStatements(connection: WorkspaceDatabase, table: string): string[] {
  const objects = connection
    .prepare("SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid")
    .all() as { type: string; name: string; tableName: string; sql: string }[];
  const triggers = objects.filter(({ type, sql }) => type === "trigger" && new RegExp(`\\b${table}\\b`).test(sql));
  const indexes = objects.filter(({ type, tableName }) => type === "index" && tableName === table);
  const create = objects.find(({ type, name }) => type === "table" && name === table)?.sql ?? "";
  // Without the generated columns: those are computed, not stored.
  const columns = (
    connection.prepare("SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0").pluck().all(table) as string[]
  ).join(", ");
  return [
    ...triggers.map(({ name }) => `DROP TRIGGER ${name}`),
    create.replace(new RegExp(`^CREATE TABLE "?${table}"?`), `CREATE TABLE new_${table}`),
    `INSERT INTO new_${table} (${columns}) SELECT ${columns} FROM ${table}`,
    `DROP TABLE ${table}`,
    `ALTER TABLE new_${table} RENAME TO ${table}`,
    ...indexes.map(({ sql }) => sql),
    ...triggers.map(({ sql }) => sql),
  ];
}

/** One more migration after the given ones, as its manifest entry would describe it. */
function followedBy(
  migrations: readonly Migration[],
  words: string,
  statements: string[],
  schema: string,
): Migration[] {
  const index = migrations.length + 1;
  const tag = `${String(index).padStart(4, "0")}_${words}`;
  const sha256 = createHash("sha256").update(statements.join("\n")).digest("hex");
  return [...migrations, { index, tag, sha256, schema, statements }];
}

export interface MigrationTimings {
  /** A start whose migration adds a column to the largest table. */
  addColumn: number;
  /** A start whose migration rebuilds the largest table. */
  rebuild: number;
}

/**
 * Two starts of a later version of the application, each with one migration of the kind that a
 * later package will bring, on the database as it stands: a new column on operations, and a
 * rebuild of operations. Each start makes its copy of the database first, which is most of what
 * it costs. The copies are removed again.
 *
 * Changes the schema of the database: of what a measurement does, only the reference commits can
 * follow it, which write the row of a table that it leaves alone.
 */
export function measureMigrations(target: Target): MigrationTimings {
  const { connection, backups } = target;
  const real = readMigrations();
  const start = (migrations: Migration[]): number => {
    const [{ snapshot }, milliseconds] = timed(() => migrateDatabase(connection, { migrations, snapshotDir: backups }));
    if (snapshot !== null) rmSync(snapshot, { force: true });
    return milliseconds;
  };

  const addColumn = ["ALTER TABLE operations ADD COLUMN note TEXT"];
  // What the manifest would say of the migration: the schema it leaves, found by running it and taking it back.
  connection.exec("BEGIN");
  let withColumn: string;
  try {
    for (const statement of addColumn) connection.prepare(statement).run();
    withColumn = schemaFingerprint(connection);
  } finally {
    connection.exec("ROLLBACK");
  }
  const first = followedBy(real, "operation_note", addColumn, withColumn);
  const addColumnMs = start(first);

  // A rebuild that changes nothing leaves the schema as it was.
  const second = followedBy(first, "rebuild_operations", rebuildStatements(connection, "operations"), withColumn);
  return { addColumn: addColumnMs, rebuild: start(second) };
}

// ---------------------------------------------------------------------------------------------------
// What was measured against what it may be.
// ---------------------------------------------------------------------------------------------------

/** What a measurement took. While it is under way, the part of it that is done. */
export interface Measured {
  /** In milliseconds. */
  generation: number;
  writes: WriteTimings;
  reads: readonly ReadTiming[];
  /** In milliseconds. */
  snapshot: number;
  migrations: MigrationTimings;
}

/** The scenarios that are held to a budget, in the order in which they are measured. */
export type Budgeted =
  | "generation"
  | "saveCapture"
  | "stageOperation"
  | "commitRun"
  | "read"
  | "snapshot"
  | "addColumn"
  | "rebuild";

/** One scenario against its budget. */
export interface Judgement {
  scenario: Budgeted;
  /** The number that the budget is of, in milliseconds. */
  took: number;
  limit: number;
  within: boolean;
}

/**
 * Holds what was measured to the budgets, in the order of the measurement; what was not measured
 * yet is not judged. Each budget is of one number: of a write its 95th percentile, of the reads
 * the median of the slowest among those that have a budget, of everything else the time it took.
 * A number that equals its budget keeps to it.
 */
export function judge(measured: Partial<Measured>): Judgement[] {
  const { generation, writes, reads, snapshot, migrations } = measured;
  const bounded = (reads ?? []).filter((read) => !read.unbounded).map((read) => read.timing.median);
  const held: [scenario: Budgeted, took: number | undefined, limit: number][] = [
    ["generation", generation, BUDGETS.generation],
    ["saveCapture", writes?.saveCapture.p95, BUDGETS.saveCapture],
    ["stageOperation", writes?.stageOperation.p95, BUDGETS.stageOperation],
    ["commitRun", writes?.commitRun.p95, BUDGETS.commitRun],
    ["read", bounded.length === 0 ? undefined : Math.max(...bounded), BUDGETS.read],
    ["snapshot", snapshot, BUDGETS.snapshot],
    ["addColumn", migrations?.addColumn, BUDGETS.migration],
    ["rebuild", migrations?.rebuild, BUDGETS.migration],
  ];
  return held.flatMap(([scenario, took, limit]) =>
    took === undefined ? [] : [{ scenario, took, limit, within: took <= limit }],
  );
}

/**
 * What a measurement comes to: the verdict, the scenarios that took longer than they may, and the
 * exit code that tells whatever started the command which of the three it was.
 */
export function outcomeOf(
  referenceCommits: readonly Timing[],
  judged: readonly Judgement[],
): { verdict: Verdict; exceeded: Budgeted[]; exitCode: number } {
  const exceeded = judged.filter(({ within }) => !within).map(({ scenario }) => scenario);
  const verdict = verdictOf(referenceCommits, exceeded);
  const exitCode = verdict === "within" ? 0 : verdict === "exceeded" ? EXIT_FAILURE : EXIT_INCONCLUSIVE;
  return { verdict, exceeded, exitCode };
}
