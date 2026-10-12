// How SQLite means to run a query. A plan depends on the schema and on the text of the query, and,
// while the database has no statistics, on nothing else: the plan on a small database is the plan
// on three years of history. So a test can hold a query to its index without a clock, where a
// measurement of time would fail on a busy machine and pass on a fast one.
import type { SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import type { WorkspaceDatabase } from "../../workspace/database.ts";

const dialect = new SQLiteSyncDialect();

/** The text of a query and the values bound to it, as the driver gets them. */
export function compiled(query: SQL): { sql: string; params: unknown[] } {
  const { sql, params } = dialect.sqlToQuery(query);
  return { sql, params };
}

/**
 * The plan of a query, line by line, in the order SQLite gives it: "SEARCH i USING INDEX
 * items_by_parent (parent_id=?)" for a look-up through an index, "SCAN operations" for a table
 * that is read from end to end.
 */
export function explain(connection: WorkspaceDatabase, query: SQL): string[] {
  const { sql, params } = compiled(query);
  const lines = connection.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
  return lines.map(({ detail }) => detail);
}
