// The tables of words: seven vocabularies that the owner may still adjust, and the three lists
// of life-cycle states. Their rows come from migrations, never from the application, and the
// codes are the lists of src/shared/vocabulary.ts.
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type {
  FactType,
  ItemHealth,
  ItemImportance,
  ItemPersonRole,
  ItemStatus,
  JobState,
  MyRole,
  OperationState,
  PersonRelation,
  RunState,
} from "../../../shared/vocabulary.ts";
import { flag } from "./columns.ts";

export const itemStatuses = sqliteTable("item_statuses", {
  code: text("code").$type<ItemStatus>().primaryKey(),
  position: integer("position").notNull(),
  /** What "active item" is computed from. */
  isClosed: flag("is_closed").notNull(),
});

export const itemHealths = sqliteTable("item_healths", {
  code: text("code").$type<ItemHealth>().primaryKey(),
  position: integer("position").notNull(),
  /** 0 is "no concern"; the items at risk are the ones above it. */
  severity: integer("severity").notNull(),
});

export const itemImportances = sqliteTable("item_importances", {
  code: text("code").$type<ItemImportance>().primaryKey(),
  position: integer("position").notNull(),
  /** What "more important" is computed from, largest first; 0 is the ordinary importance. */
  weight: integer("weight").notNull(),
});

export const myRoles = sqliteTable("my_roles", {
  code: text("code").$type<MyRole>().primaryKey(),
  position: integer("position").notNull(),
});

export const itemPersonRoles = sqliteTable("item_person_roles", {
  code: text("code").$type<ItemPersonRole>().primaryKey(),
  position: integer("position").notNull(),
});

export const factTypes = sqliteTable("fact_types", {
  code: text("code").$type<FactType>().primaryKey(),
  position: integer("position").notNull(),
});

export const personRelations = sqliteTable("person_relations", {
  code: text("code").$type<PersonRelation>().primaryKey(),
  position: integer("position").notNull(),
});

export const operationStates = sqliteTable("operation_states", {
  code: text("code").$type<OperationState>().primaryKey(),
});

export const runStates = sqliteTable("run_states", {
  code: text("code").$type<RunState>().primaryKey(),
});

export const jobStates = sqliteTable("job_states", {
  code: text("code").$type<JobState>().primaryKey(),
});

export type ItemStatusRow = typeof itemStatuses.$inferSelect;
export type ItemHealthRow = typeof itemHealths.$inferSelect;
export type ItemImportanceRow = typeof itemImportances.$inferSelect;
export type MyRoleRow = typeof myRoles.$inferSelect;
export type ItemPersonRoleRow = typeof itemPersonRoles.$inferSelect;
export type FactTypeRow = typeof factTypes.$inferSelect;
export type PersonRelationRow = typeof personRelations.$inferSelect;
export type OperationStateRow = typeof operationStates.$inferSelect;
export type RunStateRow = typeof runStates.$inferSelect;
export type JobStateRow = typeof jobStates.$inferSelect;
