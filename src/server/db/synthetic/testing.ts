// Databases that hold a synthetic world, for the tests that need rows in every table and in
// every state. For tests only: the application never imports this file.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  createWorkspaceDatabase,
  openWorkspaceDatabase,
  type WorkspaceDatabase,
  type WorkspacePin,
} from "../../workspace/database.ts";
import { createDb } from "../handle.ts";
import { migrateDatabase } from "../migrate.ts";
import { createTestDatabase, type TestDatabase } from "../testing.ts";
import { generateSynthetic, type ScaleName, type SyntheticManifest } from "./index.ts";

export interface SyntheticTestDatabase extends TestDatabase {
  /** What was generated, and the rows a test addresses by their role. */
  manifest: SyntheticManifest;
}

// A world is generated once in a process for each scale, and every caller gets a copy of its
// bytes: generating takes a hundred times longer than copying.
const inMemory = new Map<ScaleName, { bytes: Buffer; manifest: SyntheticManifest }>();
const asFiles = new Map<string, Buffer>();

/**
 * A database in memory at the current schema that holds the synthetic world of the given scale,
 * private to the caller: what a test writes into it, no other test sees.
 */
export function createSyntheticTestDatabase(scale: ScaleName = "small"): SyntheticTestDatabase {
  let world = inMemory.get(scale);
  if (world === undefined) {
    const first = createTestDatabase();
    try {
      const manifest = generateSynthetic(first.db, { scale });
      world = { bytes: first.connection.serialize(), manifest };
    } finally {
      first.close();
    }
    inMemory.set(scale, world);
  }
  const connection: WorkspaceDatabase = new Database(world.bytes);
  // As createTestDatabase() sets them: what a workspace's connection has, as far as it changes
  // what a statement does or leaves behind.
  connection.pragma("foreign_keys = ON");
  connection.pragma("secure_delete = ON");
  return {
    db: createDb(connection),
    connection,
    manifest: world.manifest,
    close: () => {
      connection.close();
    },
  };
}

/**
 * The bytes of the database file of a workspace that was used: pinned as given, at the schema of
 * this code, and filled with the synthetic world of the given scale. One file without a log
 * beside it, as a workspace that was closed leaves it: written to a path, it opens with
 * openWorkspaceDatabase(). For the tests of what happens to a database that has rows.
 */
export function syntheticWorkspaceDatabase(pin: WorkspacePin, scale: ScaleName = "small"): Buffer {
  const key = JSON.stringify([pin.endpoint, pin.createdAt, scale]);
  let bytes = asFiles.get(key);
  if (bytes === undefined) {
    const dir = mkdtempSync(join(tmpdir(), "hubber-synthetic-"));
    try {
      const file = join(dir, "hubber.sqlite");
      createWorkspaceDatabase(file, pin);
      const connection = openWorkspaceDatabase(file, pin.endpoint);
      try {
        migrateDatabase(connection, { snapshotDir: null });
        generateSynthetic(createDb(connection), { scale });
      } finally {
        // The last connection to close folds the log into the file.
        connection.close();
      }
      bytes = readFileSync(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    asFiles.set(key, bytes);
  }
  return bytes;
}
