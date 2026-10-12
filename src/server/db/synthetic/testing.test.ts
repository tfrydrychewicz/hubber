import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_WORKSPACE } from "../../testing.ts";
import { openWorkspaceDatabase, readWorkspacePin, type WorkspaceDatabase } from "../../workspace/database.ts";
import { createDb } from "../handle.ts";
import { migrateDatabase, pendingMigrations } from "../migrate.ts";
import { createTestDatabase } from "../testing.ts";
import { checkInvariants, contentHash, SCALES } from "./index.ts";
import { createSyntheticTestDatabase, syntheticWorkspaceDatabase } from "./testing.ts";

const PIN = { endpoint: TEST_WORKSPACE.endpoint, createdAt: "2026-10-10T20:00:00.000Z" };

const dirs: string[] = [];
const connections: WorkspaceDatabase[] = [];
const closing: { close: () => void }[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  for (const database of closing.splice(0)) database.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function inMemory(scale?: "tiny" | "small") {
  const database = createSyntheticTestDatabase(scale);
  closing.push(database);
  return database;
}

/** The bytes as a database file in a directory of its own, opened the way a workspace opens its database. */
function opened(bytes: Buffer, endpoint = PIN.endpoint): { connection: WorkspaceDatabase; dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "hubber-synthetic-test-"));
  dirs.push(dir);
  const file = join(dir, "hubber.sqlite");
  writeFileSync(file, bytes);
  const connection = openWorkspaceDatabase(file, endpoint);
  connections.push(connection);
  return { connection, dir, file };
}

describe("createSyntheticTestDatabase", () => {
  it("holds the world of the scale asked for, and says which rows a test finds by their role", () => {
    const { connection, manifest } = inMemory("tiny");
    const rows = (table: string) => connection.prepare(`SELECT count(*) FROM "${table}"`).pluck().get();

    expect(manifest.days).toBe(SCALES.tiny.days);
    for (const [table, count] of Object.entries(manifest.rows)) expect(rows(table), table).toBe(count);
    expect(manifest.rows.items).toBeGreaterThan(40);
    expect(connection.prepare("SELECT kind FROM items WHERE id = ?").pluck().get(manifest.busiestItem)).toBe("project");
    expect(connection.prepare("SELECT is_me FROM persons WHERE id = ?").pluck().get(manifest.me)).toBe(1);
  });

  it("gives every caller a world of its own: what one writes, no other sees", () => {
    const first = inMemory("tiny");
    const second = inMemory("tiny");

    expect(contentHash(second.db)).toBe(contentHash(first.db));
    first.connection.prepare("UPDATE persons SET job_title = 'ktoś inny' WHERE id = ?").run(first.manifest.me);

    expect(contentHash(second.db)).not.toBe(contentHash(first.db));
    expect(contentHash(inMemory("tiny").db)).toBe(contentHash(second.db));
  });

  it("has the settings of the test database, with which the guards of the schema are in force", () => {
    const plain = createTestDatabase();
    closing.push(plain);
    const { connection } = inMemory("tiny");

    for (const setting of ["foreign_keys", "secure_delete", "recursive_triggers", "defer_foreign_keys"]) {
      expect(connection.pragma(setting, { simple: true }), setting).toBe(
        plain.connection.pragma(setting, { simple: true }),
      );
    }
    expect(connection.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() => connection.prepare("DELETE FROM persons").run()).toThrow(/FOREIGN KEY constraint failed|^persons: /);
  });
});

describe("syntheticWorkspaceDatabase", () => {
  it("is the database of a workspace that was used for a month: it opens at its pin and has nothing to migrate", () => {
    const { connection, dir } = opened(syntheticWorkspaceDatabase(PIN));

    expect(readWorkspacePin(connection)).toEqual(PIN);
    expect(pendingMigrations(connection)).toEqual([]);
    expect(migrateDatabase(connection, { snapshotDir: join(dir, "backups") })).toEqual({ applied: [], snapshot: null });
    expect(connection.prepare("SELECT count(DISTINCT occurred_on) FROM captures").pluck().get()).toBe(
      SCALES.small.days,
    );
    expect(connection.pragma("foreign_key_check")).toEqual([]);
    expect(checkInvariants(createDb(connection))).toEqual([]);
  });

  it("is one file that needs no log beside it, and the same bytes every time it is asked for", () => {
    const bytes = syntheticWorkspaceDatabase(PIN, "tiny");

    expect(syntheticWorkspaceDatabase(PIN, "tiny")).toBe(bytes);
    const { connection, dir } = opened(bytes);
    // Opened from the one file, the world is whole: the same rows as the world in memory.
    expect(contentHash(createDb(connection))).toBe(contentHash(inMemory("tiny").db));
    connection.close();
    expect(readdirSync(dir)).toEqual(["hubber.sqlite"]);
    // What a test did to its copy is in its file, not in the bytes that the next test gets.
    expect(syntheticWorkspaceDatabase(PIN, "tiny").equals(bytes)).toBe(true);
  });

  it("is pinned as asked: a workspace with another address or another instant gets a database of its own", () => {
    const other = { endpoint: "https://router.corp.example/llm", createdAt: "2026-10-11T08:00:00.000Z" };

    const { connection } = opened(syntheticWorkspaceDatabase(other, "tiny"), other.endpoint);

    expect(readWorkspacePin(connection)).toEqual(other);
    expect(contentHash(createDb(connection))).toBe(contentHash(inMemory("tiny").db));
  });
});
