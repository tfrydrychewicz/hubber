// The tables of the application as Drizzle declares them, for queries and for types. The
// database is the truth: the migrations create it, and src/server/db/schema.test.ts holds this
// declaration to what they create. What the database enforces by CHECK and by trigger is in
// the migrations only. Two tables are not declared at all: workspace_pin belongs to the
// workspace layer and schema_migrations to the migration runner.
export * from "./columns.ts";
export * from "./items.ts";
export * from "./knowledge.ts";
export * from "./operations.ts";
export * from "./persons.ts";
export * from "./predicates.ts";
export * from "./sources.ts";
export * from "./vocabularies.ts";
export * from "./work.ts";
