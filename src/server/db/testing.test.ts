import { afterEach, describe, expect, it } from "vitest";
import { instantOf } from "../../shared/time.ts";
import { type OpenWorkspace, openWorkspace } from "../workspace/open.ts";
import { createTestWorkspace, type TestWorkspace } from "../workspace/testing.ts";
import { DIRECT_TRANSPORT } from "../workspace/transport.ts";
import { MIGRATIONS_TABLE, pendingMigrations, readMigrations, schemaFingerprint } from "./migrate.ts";
import { sources } from "./schema/index.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";

const T = instantOf(new Date("2026-10-11T08:00:00.000Z"));

const databases: TestDatabase[] = [];
const workspaces: TestWorkspace[] = [];
const openedWorkspaces: OpenWorkspace[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const workspace of openedWorkspaces.splice(0)) workspace.close();
  for (const workspace of workspaces.splice(0)) workspace.remove();
});

function testDatabase(): TestDatabase {
  const database = createTestDatabase();
  databases.push(database);
  return database;
}

const count = ({ connection }: TestDatabase, table: string) =>
  connection.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;

describe("createTestDatabase", () => {
  it("gives a database at the schema that the migrations leave", () => {
    const { connection } = testDatabase();
    const head = readMigrations().at(-1);

    expect(head).toBeDefined();
    expect(schemaFingerprint(connection)).toBe(head?.schema);
    expect(pendingMigrations(connection)).toEqual([]);
    expect(connection.pragma("foreign_key_check")).toEqual([]);
    expect(connection.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("gives a database in memory", () => {
    const { connection } = testDatabase();

    expect(connection.memory).toBe(true);
    expect(connection.name).toBe(":memory:");
  });

  it("holds the rows of the migrations and no others", () => {
    const database = testDatabase();
    const names = (sql: string) => database.connection.prepare(sql).pluck().all() as string[];
    const tables = names(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
    );
    // The migrations fill the tables of words, whose key is a column named "code", and the
    // runner keeps its journal of what it applied.
    const words = names(
      "SELECT m.name FROM sqlite_schema m JOIN pragma_table_info(m.name) c ON c.name = 'code' AND c.pk = 1 WHERE m.type = 'table'",
    );

    expect(tables.filter((table) => count(database, table) > 0).sort()).toEqual([...words, MIGRATIONS_TABLE].sort());
    expect(words.length).toBeGreaterThan(0);
  });

  it("gives every caller a database of its own", () => {
    const first = testDatabase();
    const second = testDatabase();

    first.connection.prepare("INSERT INTO sources (id, kind, created_at) VALUES ('cap_a', 'capture', ?)").run(T);
    first.connection.exec("CREATE TABLE scratch (x TEXT) STRICT");

    expect(count(first, "sources")).toBe(1);
    expect(count(second, "sources")).toBe(0);
    // Nor does a write reach the databases made afterwards.
    const third = testDatabase();
    expect(count(third, "sources")).toBe(0);
    expect(schemaFingerprint(third.connection)).toBe(schemaFingerprint(second.connection));
    expect(schemaFingerprint(first.connection)).not.toBe(schemaFingerprint(second.connection));
  });

  it("puts the handle on the connection it returns", () => {
    const { db, connection } = testDatabase();

    db.insert(sources).values({ id: "cap_a", kind: "capture", createdAt: T }).run();

    expect(connection.prepare("SELECT id, kind, created_at FROM sources").all()).toEqual([
      { id: "cap_a", kind: "capture", created_at: T },
    ]);
  });

  it("enforces foreign keys, as the connection of a workspace does", () => {
    const { connection } = testDatabase();

    expect(connection.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() =>
      connection
        .prepare("INSERT INTO captures (id, occurred_on, occurred_on_approximate) VALUES ('cap_a', '2026-10-11', 1)")
        .run(),
    ).toThrow(expect.objectContaining({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" }));
  });

  it("closes its connection, and does not mind being asked twice", () => {
    const database = testDatabase();

    database.close();

    expect(database.connection.open).toBe(false);
    expect(() => database.close()).not.toThrow();
  });

  // What permanent deletion relies on: SQLite writes zeros over what it deletes. Left to itself
  // it only marks the space as free, and the text stays in the file.
  it("leaves nothing of a deleted row in the bytes of the database, as the connection of a workspace does", () => {
    const { connection } = testDatabase();
    const text = "the note of a person, removed for good";
    connection.exec("CREATE TABLE scratch (body TEXT NOT NULL) STRICT");
    connection.prepare("INSERT INTO scratch (body) VALUES (?)").run(text);
    expect(connection.serialize().includes(text)).toBe(true);

    connection.exec("DELETE FROM scratch");

    expect(connection.serialize().includes(text)).toBe(false);
  });
});

// The test database stands in for the connection of a workspace wherever a test is about
// statements and not about the file. It can do that only while both have the same schema and the
// same settings: every setting counts unless it is named below as one that cannot matter here.
describe("the test database and the connection of an opened workspace", () => {
  // What belongs to the file, its log, its locks and the drive, none of which a database in
  // memory has, and what counts the changes the file has seen.
  const OF_THE_FILE = [
    // The header that the workspace layer writes, the count of changes to the schema, the name of the file.
    "application_id",
    "user_version",
    "schema_version",
    "database_list",
    // The log.
    "journal_mode",
    "journal_size_limit",
    "wal_autocheckpoint",
    // Waiting for the drive.
    "synchronous",
    "fullfsync",
    "checkpoint_fullfsync",
    "mmap_size",
    // Locks.
    "locking_mode",
    "lock_proxy_file",
    "busy_timeout",
    // Counters.
    "data_version",
    "page_count",
    "freelist_count",
  ];
  // Pragmas that do something, or that ask about one table or one index: none of them is a setting.
  const NOT_SETTINGS = [
    "foreign_key_check",
    "foreign_key_list",
    "incremental_vacuum",
    "index_info",
    "index_list",
    "index_xinfo",
    "integrity_check",
    "optimize",
    "quick_check",
    "shrink_memory",
    "table_info",
    "table_list",
    "table_xinfo",
    "wal_checkpoint",
  ];

  /**
   * Every setting the library has, with what the connection says of it. The rows of a list are
   * sorted: their order is no setting.
   */
  function settingsOf(connection: TestDatabase["connection"]): Record<string, string[]> {
    const names = (connection.pragma("pragma_list") as { name: string }[]).map(({ name }) => name);
    const compared = names.filter((name) => !OF_THE_FILE.includes(name) && !NOT_SETTINGS.includes(name));
    return Object.fromEntries(
      compared.map((name) => [name, (connection.pragma(name) as unknown[]).map((row) => JSON.stringify(row)).sort()]),
    );
  }

  /** What no setting tells: how a statement behaves, and what it can find beside the schema. */
  function behaviourOf(connection: TestDatabase["connection"]): Record<string, unknown> {
    const one = (sql: string) => connection.prepare(sql).pluck().get();
    // The driver opens a connection in the defensive mode of SQLite and can take it off again
    // (unsafeMode). Nothing reads that mode, but only without it does this setting stay on.
    connection.pragma("writable_schema = ON");
    const schemaCanBeWritten = connection.pragma("writable_schema", { simple: true });
    connection.pragma("writable_schema = OFF");
    return {
      // case_sensitive_like can be set and not read.
      "LIKE ignores the case of ASCII letters": one("SELECT 'a' LIKE 'A'"),
      // The driver can hand out integers as BigInt.
      "an integer is a": typeof one("SELECT 1"),
      // A statement looks for a name among the temporary tables first and in an attached
      // database last, and a temporary trigger fires on a table of the schema: with either,
      // the same statement finds or does something else.
      "databases beside the main and the temporary one": (connection.pragma("database_list") as { name: string }[])
        .map(({ name }) => name)
        .filter((name) => name !== "main" && name !== "temp"),
      "temporary tables, views, indexes and triggers": one("SELECT count(*) FROM sqlite_temp_schema"),
      "the table of the schema can be written by a statement": schemaCanBeWritten,
    };
  }

  /** A test database, and the connection of a workspace that was created and opened as the application does it. */
  function theTwo(): { test: TestDatabase; real: OpenWorkspace } {
    const workspace = createTestWorkspace();
    workspaces.push(workspace);
    const real = openWorkspace({ dir: workspace.dir, source: "variable" }, {}, DIRECT_TRANSPORT);
    openedWorkspaces.push(real);
    return { test: testDatabase(), real };
  }

  it("have the same schema", () => {
    const { test, real } = theTwo();

    expect(pendingMigrations(real.database)).toEqual([]);
    expect(schemaFingerprint(test.connection)).toBe(schemaFingerprint(real.database));
    expect(schemaFingerprint(test.connection)).toBe(readMigrations().at(-1)?.schema);
  });

  it("have the same settings, but for those of the file and the drive", () => {
    const { test, real } = theTwo();

    const [inTest, inWorkspace] = [settingsOf(test.connection), settingsOf(real.database)];

    expect(inTest).toEqual(inWorkspace);
    expect(behaviourOf(test.connection)).toEqual(behaviourOf(real.database));
    // Two different kinds of database were compared, and none of the settings that matter most
    // has found its way onto a list of exceptions.
    expect([test.connection.memory, real.database.memory]).toEqual([true, false]);
    expect(Object.keys(inTest)).toEqual(
      expect.arrayContaining([
        "foreign_keys",
        "recursive_triggers",
        "defer_foreign_keys",
        "legacy_alter_table",
        "ignore_check_constraints",
        "secure_delete",
        "automatic_index",
        "trusted_schema",
        "reverse_unordered_selects",
        "collation_list",
        "function_list",
      ]),
    );
  });

  // A name that the library does not know has been mistyped, or is gone from the library.
  it("are compared with exceptions that all name a setting of the library", () => {
    const { connection } = testDatabase();

    const known = (connection.pragma("pragma_list") as { name: string }[]).map(({ name }) => name);

    expect([...OF_THE_FILE, ...NOT_SETTINGS].filter((name) => !known.includes(name))).toEqual([]);
  });
});
