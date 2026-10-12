// How the data became what it is: operations, what they depend on, and what each one did.
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { ItemId, PersonId, SourceId } from "../../../shared/ids.ts";
import type {
  Approval,
  Confidence,
  EffectChange,
  EntityKind,
  OperationKind,
  OperationOrigin,
  OperationState,
} from "../../../shared/vocabulary.ts";
import { flag, id, instant, json } from "./columns.ts";
import { sources } from "./sources.ts";
import { operationStates } from "./vocabularies.ts";
import { runs } from "./work.ts";

/**
 * The proposal and the journal entry are one row at two moments of its life. Every change of
 * the hub is one, also a manual edit and an undo. What an applied operation did is in
 * operationEffects.
 */
export const operations = sqliteTable(
  "operations",
  {
    id: id("operation").primaryKey(),
    /** The run that staged it. NULL for what the owner did by hand, and for an undo. */
    runId: id("run", "run_id").references(() => runs.id),
    /** Position among the operations of the run, in the order the agent issued them. */
    seq: integer("seq"),
    kind: text("kind").$type<OperationKind>().notNull(),
    origin: text("origin").$type<OperationOrigin>().notNull(),
    state: text("state")
      .$type<OperationState>()
      .notNull()
      .references(() => operationStates.code),
    /** NULL where it has no meaning. */
    confidence: text("confidence").$type<Confidence>(),
    /** The way of approval. Set when applied. */
    approval: text("approval").$type<Approval>(),
    /** The material the operation follows from. NULL for a manual edit. */
    sourceId: text("source_id")
      .$type<SourceId>()
      .references(() => sources.id),
    /** The undo operation that took this one back. One undo can take back a chain of operations. */
    undoneById: id("operation", "undone_by_id").references((): AnySQLiteColumn => operations.id),
    /** When it was staged, or made by hand. */
    createdAt: instant("created_at").notNull(),
    /** When the owner accepted or rejected it in the Inbox. */
    decidedAt: instant("decided_at"),
    /** When it changed the data. A row with appliedAt is an entry of the journal. */
    appliedAt: instant("applied_at"),
    /** Set when permanent deletion removed the material this operation came from. */
    scrubbedAt: instant("scrubbed_at"),
    /** The piece of the material it follows from, word for word. */
    quote: text("quote"),
    /** The owner's typed words that make it a command. */
    commandQuote: text("command_quote"),
    rationale: text("rationale"),
    /** The owner's answer to a question, as JSON. */
    answer: json("answer"),
    /** What the framework attached, as JSON: duplicate candidates, what the guards lowered and why. */
    annotations: json("annotations"),
    /** Why the checks refused it, as JSON. */
    problems: json("problems"),
    /** What the agent proposed, kept when the owner changed it before accepting; NULL means accepted as proposed. */
    proposedPayload: json("proposed_payload"),
    /** The input of the operation as validated, a JSON object. Never a quote. */
    payload: json("payload").notNull(),
  },
  (t) => [
    uniqueIndex("operations_by_run").on(t.runId, t.seq).where(sql`run_id IS NOT NULL`),
    index("operations_pending").on(t.runId).where(sql`state IN ('proposed', 'invalid')`),
    index("operations_journal").on(t.appliedAt, t.kind, t.approval).where(sql`applied_at IS NOT NULL`),
    index("operations_by_source").on(t.sourceId).where(sql`source_id IS NOT NULL`),
    index("operations_undone_by").on(t.undoneById).where(sql`undone_by_id IS NOT NULL`),
  ],
);

/** "operationId needs dependsOnId": accepting the first accepts the second, rejecting the second rejects the first. */
export const operationDependencies = sqliteTable(
  "operation_dependencies",
  {
    operationId: id("operation", "operation_id")
      .notNull()
      .references(() => operations.id),
    dependsOnId: id("operation", "depends_on_id")
      .notNull()
      .references(() => operations.id),
  },
  (t) => [
    primaryKey({ columns: [t.operationId, t.dependsOnId] }),
    index("operation_dependencies_reverse").on(t.dependsOnId, t.operationId),
  ],
);

/**
 * What an applied operation did, row by row and field by field. Append-only. Undo is the
 * inverse of these rows; replayed in the order of id they give the state again.
 */
export const operationEffects = sqliteTable(
  "operation_effects",
  {
    /** The order of all changes: a logical clock that does not depend on the wall clock. */
    id: integer("id").primaryKey(),
    operationId: id("operation", "operation_id")
      .notNull()
      .references(() => operations.id),
    entityKind: text("entity_kind").$type<EntityKind>().notNull(),
    /** The key of the row. No foreign key: the row may be gone, the effect stays. */
    entityId: text("entity_id").notNull(),
    change: text("change").$type<EffectChange>().notNull(),
    /** The column, for an update. */
    field: text("field"),
    /**
     * The item and the person the change is about. No foreign keys, for the same reason as
     * entityId; the database holds each to the shape of an id of its kind.
     */
    itemId: text("item_id").$type<ItemId>(),
    personId: text("person_id").$type<PersonId>(),
    /** 1 when permanent deletion of a source removed the values. */
    scrubbed: flag("scrubbed").notNull(),
    /**
     * JSON: the whole row for create and delete, one value for an update. JSON null means the
     * column was NULL; SQL NULL means there is no value.
     */
    beforeValue: json("before_value"),
    afterValue: json("after_value"),
  },
  (t) => [
    index("operation_effects_by_operation").on(t.operationId, t.id),
    index("operation_effects_by_entity").on(t.entityId, t.id),
    index("operation_effects_by_item").on(t.itemId, t.id, t.entityKind, t.change).where(sql`item_id IS NOT NULL`),
    index("operation_effects_by_person").on(t.personId, t.id).where(sql`person_id IS NOT NULL`),
  ],
);

export type Operation = typeof operations.$inferSelect;
export type NewOperation = typeof operations.$inferInsert;
export type OperationDependency = typeof operationDependencies.$inferSelect;
export type NewOperationDependency = typeof operationDependencies.$inferInsert;
export type OperationEffect = typeof operationEffects.$inferSelect;
export type NewOperationEffect = typeof operationEffects.$inferInsert;
