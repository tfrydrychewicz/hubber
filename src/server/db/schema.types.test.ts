// The TypeScript side of the declaration: the types that a query and a row get from it. Nothing
// at run time can see them, so src/server/db/schema.test.ts cannot hold them to the database.
// They are held here, by the type-check: a line below that is no longer true does not compile,
// and "npm run typecheck" names it.
//
// For every table, the columns whose type says more than "text" or "a number": an id of a kind,
// an instant, a day, a flag, a word of a list. A column that is widened to plain text drops out
// of its table's list and one that is narrowed joins it, so either changes the type that the
// line compares.
//
// Those lists say nothing of a column that is typed as plain text or as a plain number, and
// nothing of one that is typed as any or as unknown, which drops out of them like a widened one.
// One more line holds every column of every table to the kind of value that it stores: text is
// typed as text and an integer as a number.
//
// The lists are written table by table, and a table without one would be held by none of them.
// So one line names the tables of the declaration: a table that is added fails the type-check
// there until it is named, and the comment of that line asks for its list.
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { expect, it } from "vitest";
import type {
  CaptureId,
  CapturePartId,
  CapturePartTextId,
  FactId,
  FactPersonId,
  ItemAliasId,
  ItemDescriptionId,
  ItemId,
  ItemPersonId,
  JobId,
  MentionId,
  OperationId,
  PersonAliasId,
  PersonId,
  RunId,
  SourceId,
  SourceLinkId,
} from "../../shared/ids.ts";
import type { Day, Instant } from "../../shared/time.ts";
import type {
  Approval,
  Confidence,
  DatePrecision,
  EffectChange,
  EntityKind,
  FactType,
  ItemHealth,
  ItemImportance,
  ItemKind,
  ItemPersonRole,
  ItemStatus,
  JobKind,
  JobState,
  ModelPurpose,
  ModelRole,
  MyRole,
  OperationKind,
  OperationOrigin,
  OperationState,
  PartKind,
  PartTextOrigin,
  PersonRelation,
  RunKind,
  RunState,
  SourceKind,
} from "../../shared/vocabulary.ts";
import type * as declaration from "./schema/index.ts";
import type {
  Capture,
  CapturePart,
  CapturePartText,
  Fact,
  FactPerson,
  FactTypeRow,
  Item,
  ItemAlias,
  ItemDescription,
  ItemHealthRow,
  ItemImportanceRow,
  ItemPerson,
  ItemPersonRoleRow,
  ItemStatusRow,
  JobStateRow,
  Mention,
  ModelCall,
  MyRoleRow,
  NewItem,
  Operation,
  OperationDependency,
  OperationEffect,
  OperationStateRow,
  Person,
  PersonAlias,
  PersonRelationRow,
  QueueJob,
  Run,
  RunStateRow,
  Source,
  SourceLink,
  StoredFile,
} from "./schema/index.ts";

/** Whether two types are one type, and not only assignable to each other. */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** The columns of a row whose type is narrower than text or a number. */
type Narrow<Row> = { [K in keyof Row as string extends Row[K] ? never : number extends Row[K] ? never : K]: Row[K] };
/** The properties that a value of the type has to have. */
type RequiredKeys<Row> = { [K in keyof Row]-?: Record<never, never> extends Pick<Row, K> ? never : K }[keyof Row];
/** Whether a type is any, which every other comparison takes for a match. */
type IsAny<T> = 0 extends 1 & T ? true : false;
/**
 * The columns of a table whose type is not of the kind that the column stores: text that is typed
 * as a number, an integer that is typed as text, a type that is both, any or unknown.
 */
type Mistyped<T extends SQLiteTable> = {
  [K in keyof T["_"]["columns"]]: IsAny<T["_"]["columns"][K]["_"]["data"]> extends true
    ? K
    : [T["_"]["columns"][K]["_"]["data"]] extends [
          T["_"]["columns"][K]["_"]["dataType"] extends "number" ? number : string,
        ]
      ? never
      : K;
}[keyof T["_"]["columns"]];
type Declared = typeof declaration;
/** Every mistyped column of every declared table, as "table.column" by the names of the declaration. */
type MistypedColumns = {
  [K in keyof Declared]: Declared[K] extends SQLiteTable ? `${K & string}.${Mistyped<Declared[K]> & string}` : never;
}[keyof Declared];
/** The tables of the declaration, by the names under which it exports them. */
type DeclaredTables = { [K in keyof Declared]: Declared[K] extends SQLiteTable ? K : never }[keyof Declared];

const held: true[] = [
  // No column of any table is typed as another kind of value than the one it stores.
  true satisfies Same<MistypedColumns, never>,

  // Every table of the declaration has its line below, in this order: a new table joins this list
  // with its line.
  true satisfies Same<
    DeclaredTables,
    | "itemStatuses"
    | "itemHealths"
    | "itemImportances"
    | "myRoles"
    | "itemPersonRoles"
    | "factTypes"
    | "personRelations"
    | "operationStates"
    | "runStates"
    | "jobStates"
    | "sources"
    | "files"
    | "captures"
    | "captureParts"
    | "capturePartTexts"
    | "persons"
    | "personAliases"
    | "items"
    | "itemDescriptions"
    | "itemAliases"
    | "itemPersons"
    | "mentions"
    | "facts"
    | "factPersons"
    | "sourceLinks"
    | "queueJobs"
    | "runs"
    | "modelCalls"
    | "operations"
    | "operationDependencies"
    | "operationEffects"
  >,

  // The tables of words.
  true satisfies Same<Narrow<ItemStatusRow>, { code: ItemStatus; isClosed: 0 | 1 }>,
  true satisfies Same<Narrow<ItemHealthRow>, { code: ItemHealth }>,
  true satisfies Same<Narrow<ItemImportanceRow>, { code: ItemImportance }>,
  true satisfies Same<Narrow<MyRoleRow>, { code: MyRole }>,
  true satisfies Same<Narrow<ItemPersonRoleRow>, { code: ItemPersonRole }>,
  true satisfies Same<Narrow<FactTypeRow>, { code: FactType }>,
  true satisfies Same<Narrow<PersonRelationRow>, { code: PersonRelation }>,
  true satisfies Same<Narrow<OperationStateRow>, { code: OperationState }>,
  true satisfies Same<Narrow<RunStateRow>, { code: RunState }>,
  true satisfies Same<Narrow<JobStateRow>, { code: JobState }>,

  // Raw material.
  true satisfies Same<
    Narrow<Source>,
    { id: SourceId; kind: SourceKind; createdAt: Instant; deletedAt: Instant | null }
  >,
  true satisfies Same<Narrow<StoredFile>, { createdAt: Instant }>,
  true satisfies Same<
    Narrow<Capture>,
    { id: CaptureId; sourceKind: "capture" | null; occurredOn: Day; occurredOnApproximate: 0 | 1 }
  >,
  true satisfies Same<Narrow<CapturePart>, { id: CapturePartId; captureId: CaptureId; kind: PartKind }>,
  true satisfies Same<
    Narrow<CapturePartText>,
    { id: CapturePartTextId; partId: CapturePartId; origin: PartTextOrigin; createdAt: Instant }
  >,

  // Persons and items.
  true satisfies Same<
    Narrow<Person>,
    { id: PersonId; relation: PersonRelation | null; isMe: 0 | 1; mergedIntoId: PersonId | null; createdAt: Instant }
  >,
  true satisfies Same<Narrow<PersonAlias>, { id: PersonAliasId; personId: PersonId; createdAt: Instant }>,
  true satisfies Same<
    Narrow<Item>,
    {
      id: ItemId;
      kind: ItemKind;
      parentId: ItemId | null;
      status: ItemStatus;
      importance: ItemImportance;
      health: ItemHealth | null;
      myRole: MyRole | null;
      myRoleSetOn: Day | null;
      startOn: Day | null;
      startOnPrecision: DatePrecision | null;
      dueOn: Day | null;
      dueOnPrecision: DatePrecision | null;
      isMilestone: 0 | 1;
      mergedIntoId: ItemId | null;
      createdAt: Instant;
      closedAt: Instant | null;
      lastActivityAt: Instant;
    }
  >,
  true satisfies Same<Narrow<ItemDescription>, { id: ItemDescriptionId; itemId: ItemId; updatedAt: Instant }>,
  true satisfies Same<Narrow<ItemAlias>, { id: ItemAliasId; itemId: ItemId; createdAt: Instant }>,
  true satisfies Same<
    Narrow<ItemPerson>,
    { id: ItemPersonId; itemId: ItemId; personId: PersonId; role: ItemPersonRole; createdAt: Instant }
  >,

  // What was extracted from sources.
  true satisfies Same<
    Narrow<Mention>,
    { id: MentionId; sourceId: SourceId; personId: PersonId | null; skippedAt: Instant | null; createdAt: Instant }
  >,
  true satisfies Same<
    Narrow<Fact>,
    {
      id: FactId;
      itemId: ItemId;
      type: FactType;
      occurredOn: Day;
      occurredOnApproximate: 0 | 1;
      sourceId: SourceId | null;
      outdatedAt: Instant | null;
      supersededByFactId: FactId | null;
      createdAt: Instant;
    }
  >,
  true satisfies Same<Narrow<FactPerson>, { id: FactPersonId; factId: FactId; personId: PersonId }>,
  true satisfies Same<Narrow<SourceLink>, { id: SourceLinkId; sourceId: SourceId; itemId: ItemId; createdAt: Instant }>,

  // Work in progress.
  true satisfies Same<
    Narrow<QueueJob>,
    {
      id: JobId;
      kind: JobKind;
      state: JobState;
      sourceId: SourceId | null;
      runAfter: Instant;
      leasedUntil: Instant | null;
      createdAt: Instant;
      startedAt: Instant | null;
      finishedAt: Instant | null;
    }
  >,
  true satisfies Same<
    Narrow<Run>,
    {
      id: RunId;
      kind: RunKind;
      state: RunState;
      sourceId: SourceId | null;
      jobId: JobId | null;
      startedAt: Instant;
      endedAt: Instant | null;
    }
  >,
  true satisfies Same<
    Narrow<ModelCall>,
    { runId: RunId | null; jobId: JobId | null; role: ModelRole; purpose: ModelPurpose; startedAt: Instant }
  >,

  // The journal.
  true satisfies Same<
    Narrow<Operation>,
    {
      id: OperationId;
      runId: RunId | null;
      kind: OperationKind;
      origin: OperationOrigin;
      state: OperationState;
      confidence: Confidence | null;
      approval: Approval | null;
      sourceId: SourceId | null;
      undoneById: OperationId | null;
      createdAt: Instant;
      decidedAt: Instant | null;
      appliedAt: Instant | null;
      scrubbedAt: Instant | null;
    }
  >,
  true satisfies Same<Narrow<OperationDependency>, { operationId: OperationId; dependsOnId: OperationId }>,
  true satisfies Same<
    Narrow<OperationEffect>,
    {
      operationId: OperationId;
      entityKind: EntityKind;
      change: EffectChange;
      itemId: ItemId | null;
      personId: PersonId | null;
      scrubbed: 0 | 1;
    }
  >,

  // No column has a default, so the statement that inserts an item writes every one of these.
  true satisfies Same<
    RequiredKeys<NewItem>,
    "id" | "kind" | "title" | "titleNorm" | "status" | "importance" | "isMilestone" | "createdAt" | "lastActivityAt"
  >,
];

// The lines above are judged when this file is compiled. This is the test that the runner finds in it.
it("holds the types of the declaration, at the type-check", () => {
  expect(held.every(Boolean)).toBe(true);
});
