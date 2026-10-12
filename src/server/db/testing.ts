// A database for the tests of queries and operations. For tests only: the application never
// imports this file.
import Database from "better-sqlite3";
import type { WorkspaceDatabase } from "../workspace/database.ts";
import { createDb, type Db } from "./handle.ts";
import { migrateDatabase } from "./migrate.ts";

export interface TestDatabase {
  db: Db;
  /** The connection under the handle, for what a test does around it: raw SQL, PRAGMA, EXPLAIN. */
  connection: WorkspaceDatabase;
  /** Closes the connection, and the database is gone. Safe to call more than once. */
  close(): void;
}

// The schema as the real runner builds it from the real migrations, as the bytes of a database
// file. Migrating takes a hundred times longer than copying these bytes, so it is done once in
// a process, when the first test asks.
let template: Buffer | undefined;

/**
 * What openWorkspaceDatabase() sets on a connection, as far as it changes what a statement does
 * or leaves behind. testing.test.ts compares the two connections: every setting that a pragma
 * tells, and what none tells (an attached database, a temporary table or trigger, the unsafe
 * mode of the driver). What the real connection gains and this one lacks turns that test red.
 */
function configure(connection: WorkspaceDatabase): void {
  connection.pragma("foreign_keys = ON");
  // A deleted row is written over with zeros. A test of permanent deletion looks for exactly that.
  connection.pragma("secure_delete = ON");
}

function migratedTemplate(): Buffer {
  const connection = new Database(":memory:");
  try {
    configure(connection);
    migrateDatabase(connection, { snapshotDir: null });
    return connection.serialize();
  } finally {
    connection.close();
  }
}

/**
 * A database in memory at the current schema, empty but for the rows that the migrations
 * insert, and private to the caller: a new one for every test.
 *
 * It is the schema of a workspace on a connection that is not the real one: no file, so no
 * write-ahead log, no waiting for the drive and no locks, and no workspace_pin table. A test
 * about any of those takes a workspace from createTestWorkspace().
 */
export function createTestDatabase(): TestDatabase {
  template ??= migratedTemplate();
  const connection = new Database(template);
  configure(connection);
  return {
    db: createDb(connection),
    connection,
    close: () => {
      connection.close();
    },
  };
}
