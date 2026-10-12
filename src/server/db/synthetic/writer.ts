// Writes what the world hands over into the tables: the one file of the generator that knows a
// column. Every statement is prepared once from the Drizzle tables, so a column that is renamed
// fails the type check here and nowhere else in the generator.
//
// Every row goes through the guards of the schema, in the order the application will write it: a
// run is running while it stages, operations move on after the commit, and each change of a
// ledgered row is followed by the effect that records it. Nothing is switched off to get data in.
import { eq, getTableColumns, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { foldName } from "../../../shared/fold.ts";
import { type Instant, instantOf } from "../../../shared/time.ts";
import type { Db } from "../handle.ts";
import {
  captureParts,
  capturePartTexts,
  captures,
  factPersons,
  facts,
  files,
  itemAliases,
  itemDescriptions,
  itemPersons,
  items,
  mentions,
  modelCalls,
  type NewCapture,
  type NewCapturePart,
  type NewCapturePartText,
  type NewFact,
  type NewFactPerson,
  type NewItem,
  type NewItemAlias,
  type NewItemDescription,
  type NewItemPerson,
  type NewMention,
  type NewModelCall,
  type NewOperation,
  type NewOperationDependency,
  type NewOperationEffect,
  type NewPerson,
  type NewPersonAlias,
  type NewQueueJob,
  type NewRun,
  type NewSource,
  type NewSourceLink,
  type NewStoredFile,
  operationDependencies,
  operationEffects,
  operations,
  personAliases,
  persons,
  queueJobs,
  runs,
  sourceLinks,
  sources,
} from "../schema/index.ts";
import type { Change, Ledgered, LedgeredKind, Sink, WorldOperation } from "./world.ts";

/** Every column of a row with its value: the schema has no defaults, so a statement names them all. */
type Whole<Row> = { [Column in keyof Row]-?: Exclude<Row[Column], undefined> };
type Values = Record<string, unknown>;

const instant = (milliseconds: number): Instant => instantOf(new Date(milliseconds));
const instantOrNull = (milliseconds: number | null): Instant | null =>
  milliseconds === null ? null : instant(milliseconds);
const flag = (value: boolean): 0 | 1 => (value ? 1 : 0);
const json = (value: object | null): string | null => (value === null ? null : JSON.stringify(value));
/** A value that a prepared UPDATE is given when it runs. */
const bound = (name: string) => sql`${sql.placeholder(name)}`;

/** The rows that operations change, as the tables store them. What is derived from other columns is derived here. */
const ROWS: { [Kind in LedgeredKind]: { table: SQLiteTable; row: (fields: Ledgered[Kind]) => Values } } = {
  item: {
    table: items,
    row: (fields): Whole<NewItem> => ({
      id: fields.id,
      kind: fields.kind,
      parentId: fields.parentId,
      title: fields.title,
      titleNorm: foldName(fields.title),
      status: fields.status,
      importance: fields.importance,
      health: fields.health,
      myRole: fields.myRole,
      myRoleSetOn: fields.myRoleSetOn,
      startOn: fields.startOn,
      startOnPrecision: fields.startOnPrecision,
      dueOn: fields.dueOn,
      dueOnPrecision: fields.dueOnPrecision,
      isMilestone: flag(fields.isMilestone),
      externalSystem: fields.externalSystem,
      externalKey: fields.externalKey,
      externalUrl: fields.externalUrl,
      mergedIntoId: fields.mergedIntoId,
      createdAt: instant(fields.createdAt),
      closedAt: instantOrNull(fields.closedAt),
      // Written once, equal to the date of creation: from then on the triggers of the journal keep it.
      lastActivityAt: instant(fields.createdAt),
    }),
  },
  item_description: {
    table: itemDescriptions,
    row: (fields): Whole<NewItemDescription> => ({
      id: fields.id,
      itemId: fields.itemId,
      updatedAt: instant(fields.updatedAt),
      body: JSON.stringify(fields.body),
    }),
  },
  item_alias: {
    table: itemAliases,
    row: (fields): Whole<NewItemAlias> => ({
      id: fields.id,
      itemId: fields.itemId,
      alias: fields.alias,
      aliasNorm: foldName(fields.alias),
      createdAt: instant(fields.createdAt),
    }),
  },
  item_person: {
    table: itemPersons,
    row: (fields): Whole<NewItemPerson> => ({
      id: fields.id,
      itemId: fields.itemId,
      personId: fields.personId,
      role: fields.role,
      createdAt: instant(fields.createdAt),
      expectations: fields.expectations,
    }),
  },
  person: {
    table: persons,
    row: (fields): Whole<NewPerson> => ({
      id: fields.id,
      name: fields.name,
      nameNorm: foldName(fields.name),
      jobTitle: fields.jobTitle,
      team: fields.team,
      relation: fields.relation,
      isMe: flag(fields.isMe),
      mergedIntoId: fields.mergedIntoId,
      createdAt: instant(fields.createdAt),
      note: fields.note,
    }),
  },
  person_alias: {
    table: personAliases,
    row: (fields): Whole<NewPersonAlias> => ({
      id: fields.id,
      personId: fields.personId,
      alias: fields.alias,
      aliasNorm: foldName(fields.alias),
      context: fields.context,
      createdAt: instant(fields.createdAt),
    }),
  },
  mention: {
    table: mentions,
    row: (fields): Whole<NewMention> => ({
      id: fields.id,
      sourceId: fields.sourceId,
      personId: fields.personId,
      skippedAt: instantOrNull(fields.skippedAt),
      createdAt: instant(fields.createdAt),
      surface: fields.surface,
      baseForm: fields.baseForm,
      baseNorm: fields.baseForm === null ? null : foldName(fields.baseForm),
    }),
  },
  fact: {
    table: facts,
    row: (fields): Whole<NewFact> => ({
      id: fields.id,
      itemId: fields.itemId,
      type: fields.type,
      occurredOn: fields.occurredOn,
      occurredOnApproximate: flag(fields.occurredOnApproximate),
      sourceId: fields.sourceId,
      outdatedAt: instantOrNull(fields.outdatedAt),
      supersededByFactId: fields.supersededByFactId,
      createdAt: instant(fields.createdAt),
      quote: fields.quote,
      text: fields.text,
    }),
  },
  fact_person: {
    table: factPersons,
    row: (fields): Whole<NewFactPerson> => ({ id: fields.id, factId: fields.factId, personId: fields.personId }),
  },
  source_link: {
    table: sourceLinks,
    row: (fields): Whole<NewSourceLink> => ({
      id: fields.id,
      sourceId: fields.sourceId,
      itemId: fields.itemId,
      createdAt: instant(fields.createdAt),
    }),
  },
};

// What an effect leaves out of a row, because it follows from the rest of it: the folded
// spellings, which a later version of the folding may spell otherwise, and the date of the last
// activity, which the journal itself keeps.
export const isDerived = (column: string): boolean => column.endsWith("_norm") || column === "last_activity_at";
/** The columns that are written with another one: the folded spelling of a name goes where the name goes. */
const WRITTEN_WITH: Record<string, string> = {
  title: "titleNorm",
  name: "nameNorm",
  alias: "aliasNorm",
  baseForm: "baseNorm",
};

/** The tables of the rows that only operations change, by the kind of entity that an effect names. */
export const LEDGERED_TABLES = Object.fromEntries(
  (Object.keys(ROWS) as LedgeredKind[]).map((kind) => [kind, ROWS[kind].table]),
) as Record<LedgeredKind, SQLiteTable>;

export function createWriter(db: Db): Sink {
  /** An INSERT that names every column the table stores, prepared once. */
  function inserting<Row extends Values>(table: SQLiteTable, more?: "keep the row that is there"): (row: Row) => void {
    const names = Object.entries(getTableColumns(table) as Record<string, SQLiteColumn>)
      // What the database computes takes no value.
      .filter(([, column]) => column.generated === undefined)
      .map(([name]) => name);
    const values = Object.fromEntries(names.map((name) => [name, sql.placeholder(name)]));
    const insert = db.insert(table).values(values);
    const statement = (more === undefined ? insert : insert.onConflictDoNothing()).prepare();
    return (row) => {
      statement.run(row);
    };
  }

  const insertFile = inserting<Whole<NewStoredFile>>(files, "keep the row that is there");
  const insertSource = inserting<Whole<NewSource>>(sources);
  const insertCapture = inserting<Whole<NewCapture>>(captures);
  const insertPart = inserting<Whole<NewCapturePart>>(captureParts);
  const insertPartText = inserting<Whole<NewCapturePartText>>(capturePartTexts);
  const insertJob = inserting<Whole<NewQueueJob>>(queueJobs);
  const insertRun = inserting<Whole<NewRun>>(runs);
  const insertCall = inserting<Whole<NewModelCall>>(modelCalls);
  const insertOperation = inserting<Whole<NewOperation>>(operations);
  const insertDependency = inserting<Whole<NewOperationDependency>>(operationDependencies);
  // The database numbers the effects: the id is the order of all changes, and runs without a gap.
  const insertEffect = inserting<Whole<NewOperationEffect>>(operationEffects);

  const updateJob = db
    .update(queueJobs)
    .set({
      state: bound("state"),
      attempts: bound("attempts"),
      runAfter: bound("runAfter"),
      leasedUntil: bound("leasedUntil"),
      startedAt: bound("startedAt"),
      finishedAt: bound("finishedAt"),
      lastErrorCode: bound("lastErrorCode"),
      lastErrorMessage: bound("lastErrorMessage"),
    })
    .where(eq(queueJobs.id, sql.placeholder("id")))
    .prepare();
  const endRun = db
    .update(runs)
    .set({
      state: bound("state"),
      endedAt: bound("endedAt"),
      errorCode: bound("errorCode"),
      errorMessage: bound("errorMessage"),
      summary: bound("summary"),
    })
    .where(eq(runs.id, sql.placeholder("id")))
    .prepare();
  // One statement for each way an operation moves on: a decided operation is history, and the
  // database refuses a statement that names a column it may no longer change.
  const byId = eq(operations.id, sql.placeholder("id"));
  const moved = {
    proposed: db.update(operations).set({ state: "proposed" }).where(byId).prepare(),
    invalid: db
      .update(operations)
      .set({ state: "invalid", problems: bound("problems") })
      .where(byId)
      .prepare(),
    rejected: db
      .update(operations)
      .set({ state: "rejected", decidedAt: bound("decidedAt") })
      .where(byId)
      .prepare(),
    applied: db
      .update(operations)
      .set({
        state: "applied",
        approval: bound("approval"),
        decidedAt: bound("decidedAt"),
        appliedAt: bound("appliedAt"),
        answer: bound("answer"),
        proposedPayload: bound("proposedPayload"),
        payload: bound("payload"),
      })
      .where(byId)
      .prepare(),
    undone: db
      .update(operations)
      .set({ state: "undone", undoneById: bound("undoneById") })
      .where(byId)
      .prepare(),
  };

  // The ledgered tables: an INSERT and a DELETE each, and an UPDATE for every set of columns that
  // an operation changes together, prepared when it is first met.
  const ledger = Object.fromEntries(
    (Object.keys(ROWS) as LedgeredKind[]).map((kind) => {
      const { table } = ROWS[kind];
      const columns = getTableColumns(table) as Record<string, SQLiteColumn>;
      const key = columns.id as SQLiteColumn;
      return [
        kind,
        {
          columns,
          /** The columns an effect records, by the name they have in a row here. */
          recorded: Object.entries(columns).filter(([, column]) => !isDerived(column.name)),
          insert: inserting<Values>(table),
          remove: db
            .delete(table)
            .where(eq(key, sql.placeholder("rowId")))
            .prepare(),
          key,
          updates: new Map<string, { run: (values: Values) => unknown }>(),
        },
      ];
    }),
  ) as unknown as Record<
    LedgeredKind,
    {
      columns: Record<string, SQLiteColumn>;
      recorded: [string, SQLiteColumn][];
      insert: (row: Values) => void;
      remove: { run: (values: Values) => unknown };
      key: SQLiteColumn;
      updates: Map<string, { run: (values: Values) => unknown }>;
    }
  >;
  /** A row as an effect records it: every stored column that is not derived, under its name in the database. */
  const image = (kind: LedgeredKind, row: Values): string =>
    JSON.stringify(Object.fromEntries(ledger[kind].recorded.map(([name, column]) => [column.name, row[name] ?? null])));

  function effect(operation: WorldOperation, change: Change, more: Partial<Whole<NewOperationEffect>>): void {
    insertEffect({
      id: null as never,
      operationId: operation.id,
      entityKind: change.kind,
      entityId: change.row.id,
      change: change.change,
      field: null,
      itemId: change.item,
      personId: change.person,
      scrubbed: 0,
      beforeValue: null,
      afterValue: null,
      ...more,
    });
  }

  function write(operation: WorldOperation, change: Change): void {
    const { kind } = change;
    const { table, row } = ROWS[kind] as { table: SQLiteTable; row: (fields: Change["row"]) => Values };
    const tools = ledger[kind];
    const now = row(change.row);
    switch (change.change) {
      case "create":
        tools.insert(now);
        effect(operation, change, { afterValue: image(kind, now) });
        return;
      case "delete":
        tools.remove.run({ rowId: change.row.id });
        effect(operation, change, { beforeValue: image(kind, now) });
        return;
      case "touch":
        effect(operation, change, {});
        return;
      case "update": {
        const changed = Object.keys(change.was ?? {});
        const before = row({ ...change.row, ...change.was } as Change["row"]);
        // One UPDATE for everything the operation changes on the row: the rules of a row are asked
        // of every statement, so a state in between could be refused.
        const written = changed.flatMap((name) =>
          name in WRITTEN_WITH ? [name, WRITTEN_WITH[name] as string] : [name],
        );
        const shape = written.join(",");
        let update = tools.updates.get(shape);
        if (update === undefined) {
          update = db
            .update(table)
            .set(Object.fromEntries(written.map((name) => [name, bound(name)])))
            .where(eq(tools.key, sql.placeholder("rowId")))
            .prepare();
          tools.updates.set(shape, update);
        }
        update.run({ ...Object.fromEntries(written.map((name) => [name, now[name]])), rowId: change.row.id });
        // And an effect for every column that changed.
        for (const name of changed) {
          effect(operation, change, {
            field: (tools.columns[name] as SQLiteColumn).name,
            beforeValue: JSON.stringify(before[name] ?? null),
            afterValue: JSON.stringify(now[name] ?? null),
          });
        }
        return;
      }
    }
  }

  return {
    file(file) {
      insertFile({
        sha256: file.sha256,
        byteSize: file.byteSize,
        mediaType: file.mediaType,
        createdAt: instant(file.createdAt),
      });
    },
    capture(capture) {
      insertSource({ id: capture.id, kind: "capture", createdAt: instant(capture.createdAt), deletedAt: null });
      insertCapture({
        id: capture.id,
        occurredOn: capture.occurredOn,
        occurredOnApproximate: flag(capture.occurredOnApproximate),
      });
      for (const part of capture.parts) {
        insertPart({
          id: part.id,
          captureId: capture.id,
          position: part.position,
          kind: part.kind,
          fileSha256: part.file?.sha256 ?? null,
          fileName: part.fileName,
          text: part.text,
        });
      }
    },
    partText(text) {
      insertPartText({
        id: text.id,
        partId: text.partId,
        revision: text.revision,
        origin: text.origin,
        modelCallId: text.modelCallId,
        createdAt: instant(text.createdAt),
        structure: json(text.structure),
        text: text.text,
      });
    },
    job(job) {
      insertJob({
        id: job.id,
        kind: job.kind,
        state: job.state,
        sourceId: job.sourceId,
        dedupeKey: job.dedupeKey,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        runAfter: instant(job.runAfter),
        leasedUntil: instantOrNull(job.leasedUntil),
        createdAt: instant(job.createdAt),
        startedAt: instantOrNull(job.startedAt),
        finishedAt: instantOrNull(job.finishedAt),
        lastErrorCode: job.lastErrorCode,
        lastErrorMessage: job.lastErrorMessage,
        payload: JSON.stringify(job.payload),
      });
    },
    jobChanged(job) {
      updateJob.run({
        id: job.id,
        state: job.state,
        attempts: job.attempts,
        runAfter: instant(job.runAfter),
        leasedUntil: instantOrNull(job.leasedUntil),
        startedAt: instantOrNull(job.startedAt),
        finishedAt: instantOrNull(job.finishedAt),
        lastErrorCode: job.lastErrorCode,
        lastErrorMessage: job.lastErrorMessage,
      });
    },
    run(run) {
      insertRun({
        id: run.id,
        kind: run.kind,
        state: run.state,
        sourceId: run.sourceId,
        jobId: run.jobId,
        model: run.model,
        promptVersion: run.promptVersion,
        startedAt: instant(run.startedAt),
        endedAt: instantOrNull(run.endedAt),
        errorCode: run.errorCode,
        errorMessage: run.errorMessage,
        summary: run.summary,
      });
    },
    runEnded(run) {
      endRun.run({
        id: run.id,
        state: run.state,
        endedAt: instantOrNull(run.endedAt),
        errorCode: run.errorCode,
        errorMessage: run.errorMessage,
        summary: run.summary,
      });
    },
    modelCall(call) {
      insertCall({
        id: call.id,
        runId: call.runId,
        jobId: call.jobId,
        role: call.role,
        purpose: call.purpose,
        model: call.model,
        promptVersion: call.promptVersion,
        startedAt: instant(call.startedAt),
        durationMs: call.durationMs,
        firstTokenMs: call.firstTokenMs,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        cacheReadInputTokens: call.cacheReadInputTokens,
        cacheCreationInputTokens: call.cacheCreationInputTokens,
        httpStatus: call.httpStatus,
        stopReason: call.stopReason,
        requestId: call.requestId,
        errorType: call.errorType,
        errorMessage: call.errorMessage,
        detail: json(call.detail),
      });
    },
    operation(operation, needs) {
      insertOperation({
        id: operation.id,
        runId: operation.runId,
        seq: operation.seq,
        kind: operation.kind,
        origin: operation.origin,
        state: operation.state,
        confidence: operation.confidence,
        approval: operation.approval,
        sourceId: operation.sourceId,
        undoneById: operation.undoneById,
        createdAt: instant(operation.createdAt),
        decidedAt: instantOrNull(operation.decidedAt),
        appliedAt: instantOrNull(operation.appliedAt),
        scrubbedAt: null,
        quote: operation.quote,
        commandQuote: operation.commandQuote,
        rationale: operation.rationale,
        answer: json(operation.answer),
        annotations: json(operation.annotations),
        problems: json(operation.problems),
        proposedPayload: json(operation.proposedPayload),
        payload: JSON.stringify(operation.payload),
      });
      for (const need of needs) insertDependency({ operationId: operation.id, dependsOnId: need.id });
    },
    operationMoved(operation) {
      const { id, state } = operation;
      if (state === "staged") throw new Error(`Operation ${id} has not moved on: it is staged.`);
      moved[state].run({
        id,
        problems: json(operation.problems),
        decidedAt: instantOrNull(operation.decidedAt),
        approval: operation.approval,
        appliedAt: instantOrNull(operation.appliedAt),
        answer: json(operation.answer),
        proposedPayload: json(operation.proposedPayload),
        payload: JSON.stringify(operation.payload),
        undoneById: operation.undoneById,
      });
    },
    changes(operation, changes) {
      for (const change of changes) write(operation, change);
    },
  };
}
