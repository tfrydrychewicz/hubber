import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { count, DrizzleError, eq, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureId } from "../../shared/ids.ts";
import { type Day, instantOf } from "../../shared/time.ts";
import { createDb, type Db, TransactionNotEndedError, type Tx } from "./handle.ts";
import { captures, sources } from "./schema/index.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";

const T = instantOf(new Date("2026-10-11T08:00:00.000Z"));

const databases: TestDatabase[] = [];
const connections: Database.Database[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
  for (const connection of connections.splice(0)) if (connection.open) connection.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function testDatabase(): TestDatabase {
  const database = createTestDatabase();
  databases.push(database);
  return database;
}

/** A connection of the test's own: to a file, to a new database in memory, or to the bytes of a database. */
function raw(file: string | Buffer = ":memory:", options: Database.Options = {}): Database.Database {
  const connection = new Database(file, options);
  connections.push(connection);
  return connection;
}

const source = (id: CaptureId) => ({ id, kind: "capture" as const, createdAt: T });
/** A query as any module would write it: it asks for a Db. */
const sourceIds = (db: Db) =>
  db
    .select({ id: sources.id })
    .from(sources)
    .orderBy(sources.id)
    .all()
    .map((row) => row.id);
/** A change as the framework of operations would write it: it asks for a Tx, so it cannot run outside a transaction. */
const addSource = (tx: Tx, id: CaptureId) => tx.insert(sources).values(source(id)).run();
/** A row that is there before the transaction under test begins. */
const seed = (db: Db, id: CaptureId) => db.insert(sources).values(source(id)).run();

/** How a body that is not synchronous is refused: the words of the driver. */
const NOT_SYNCHRONOUS = new TypeError("Transaction function cannot return a promise");
/** What a Tx says when it is used after its transaction. */
const ENDED = "The transaction of this handle has ended.";
/** What a statement says when it is ended in execute() or awaited: the endings that there are. */
const NOT_AN_ENDING = new Error(
  "A statement is not run with .execute() or await: it ends in .run(), .all(), .get() or .values().",
);
/** What the driver says when it is asked to write while rows of a statement are still being read. */
const BUSY = new TypeError("This database connection is busy executing a query");

/** Writes one row at once and one after an await: the second write comes when the caller has long returned. */
async function writeNowAndLater(tx: Tx): Promise<void> {
  addSource(tx, "cap_now");
  await Promise.resolve();
  addSource(tx, "cap_late");
}

/** Resolves when everything that was waiting on a settled promise has run: a turn of the event loop later. */
const whatWaitsHasRun = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("createDb", () => {
  it("puts the handle on the connection it is given", () => {
    const connection = raw();
    connection.exec("CREATE TABLE notes (body TEXT NOT NULL) STRICT");

    const db = createDb(connection);
    db.run(sql`INSERT INTO notes (body) VALUES (${"first"})`);

    expect(connection.prepare("SELECT body FROM notes").pluck().all()).toEqual(["first"]);
    expect(db.all(sql`SELECT count(*) AS n FROM notes`)).toEqual([{ n: 1 }]);
  });

  it("takes a connection and never a path, which the driver would open by itself", () => {
    // @ts-expect-error a path is not a connection that has passed the check of the endpoint pin
    const withPath = () => createDb("/somewhere/hubber.sqlite");

    expect(withPath).toBeTypeOf("function");
  });

  // The values of a statement are the material of the owner. Drizzle can print every statement
  // with its values; the handle is made without that.
  it("prints neither a statement nor its values", () => {
    const printed = (["log", "info", "debug", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const { db } = testDatabase();

    seed(db, "cap_a");
    db.transaction((tx) => addSource(tx, "cap_b"));
    const found = db.all(sql`SELECT id FROM sources WHERE id > ${"cap_a"}`);

    expect(found).toEqual([{ id: "cap_b" }]);
    expect(printed.flatMap((method) => method.mock.calls)).toEqual([]);
  });

  // Drizzle builds its relational queries (db.query) when a handle is made, each with the
  // session in it: they would go on reading through a Tx that has ended. The handle is made
  // without the schema that they are built from.
  it("has no relational queries, on the handle or on a Tx", () => {
    const { db } = testDatabase();

    const ofATx = db.transaction((tx) => Object.keys(tx.query));

    expect(Object.keys(db.query)).toEqual([]);
    expect(ofATx).toEqual([]);
  });
});

describe("a transaction", () => {
  it("returns what its body returns, and its writes are there afterwards", () => {
    const { db } = testDatabase();

    const result = db.transaction((tx) => {
      addSource(tx, "cap_a");
      addSource(tx, "cap_b");
      return sourceIds(tx).length;
    });

    expect(result).toBe(2);
    expect(sourceIds(db)).toEqual(["cap_a", "cap_b"]);
  });

  it("takes back everything when its body throws, and lets the error through", () => {
    const { db, connection } = testDatabase();
    seed(db, "cap_before");
    const failure = new Error("the third step failed");

    expect(() =>
      db.transaction((tx) => {
        addSource(tx, "cap_a");
        addSource(tx, "cap_b");
        throw failure;
      }),
    ).toThrow(failure);

    expect(sourceIds(db)).toEqual(["cap_before"]);
    expect(connection.inTransaction).toBe(false);
  });

  it("takes back everything when the database refuses one of its statements", () => {
    const { db } = testDatabase();

    expect(() =>
      db.transaction((tx) => {
        addSource(tx, "cap_a");
        // No registry row for this capture.
        tx.insert(captures)
          .values({ id: "cap_zz", occurredOn: "2026-10-11" as Day, occurredOnApproximate: 1 })
          .run();
      }),
    ).toThrow(expect.objectContaining({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" }));

    expect(sourceIds(db)).toEqual([]);
  });

  // An async body returns a promise at its first await, before the rest of it has run, and the
  // rest would run when the transaction is over. So such a body is refused before any of it runs.
  it("refuses a body that is an async function, and runs none of it", () => {
    const { db, connection } = testDatabase();
    let ran = false;

    expect(() =>
      db.transaction(async (tx) => {
        ran = true;
        addSource(tx, "cap_a");
        return "done";
      }),
    ).toThrow(NOT_SYNCHRONOUS);

    expect(ran).toBe(false);
    expect(sourceIds(db)).toEqual([]);
    expect(connection.inTransaction).toBe(false);
  });

  it("lets nothing of an async body reach the database, also not what follows its first await", async () => {
    const { db } = testDatabase();

    expect(() =>
      db.transaction(async (tx) => {
        await Promise.resolve();
        addSource(tx, "cap_late");
      }),
    ).toThrow(NOT_SYNCHRONOUS);
    await whatWaitsHasRun();

    expect(sourceIds(db)).toEqual([]);
  });

  it("refuses an async body of a transaction inside another one, and the outer one goes on", async () => {
    const { db } = testDatabase();
    let ran = false;

    db.transaction((tx) => {
      addSource(tx, "cap_a");
      expect(() =>
        tx.transaction(async (inner) => {
          ran = true;
          await Promise.resolve();
          addSource(inner, "cap_late");
        }),
      ).toThrow(NOT_SYNCHRONOUS);
      addSource(tx, "cap_c");
    });
    await whatWaitsHasRun();

    expect(ran).toBe(false);
    expect(sourceIds(db)).toEqual(["cap_a", "cap_c"]);
  });

  // Not every body that returns a promise is an async function to look at: this one calls one.
  // It has run up to its first await by the time the promise is seen.
  it("refuses a body that hands back a promise, takes back what it wrote and lets the rest write nothing", async () => {
    const { db, connection } = testDatabase();
    let rest: Promise<void> | undefined;

    expect(() =>
      db.transaction((tx) => {
        rest = writeNowAndLater(tx);
        return rest;
      }),
    ).toThrow(NOT_SYNCHRONOUS);

    expect(connection.inTransaction).toBe(false);
    await expect(rest).rejects.toThrow(ENDED);
    expect(sourceIds(db)).toEqual([]);
  });

  it("refuses a promise from the body of a transaction inside another one all the same", async () => {
    const { db } = testDatabase();
    let rest: Promise<void> | undefined;

    db.transaction((tx) => {
      addSource(tx, "cap_a");
      expect(() =>
        tx.transaction((inner) => {
          rest = writeNowAndLater(inner);
          return rest;
        }),
      ).toThrow(NOT_SYNCHRONOUS);
      // What the inner body wrote before it returned went with the inner transaction.
      expect(sourceIds(tx)).toEqual(["cap_a"]);
    });

    await expect(rest).rejects.toThrow(ENDED);
    expect(sourceIds(db)).toEqual(["cap_a"]);
  });

  // A query has a then(), so it is a promise to the check: a body that returns one has built
  // a statement and has not run it.
  it("refuses a body that returns a query it has not run", () => {
    const { db } = testDatabase();

    expect(() => db.transaction((tx) => tx.insert(sources).values(source("cap_a")))).toThrow(NOT_SYNCHRONOUS);
    db.transaction((tx) => {
      expect(() => tx.transaction((inner) => inner.insert(sources).values(source("cap_b")))).toThrow(NOT_SYNCHRONOUS);
    });

    expect(sourceIds(db)).toEqual([]);
  });

  it("hands its body a handle that is accepted wherever a Db is asked for", () => {
    const { db } = testDatabase();
    seed(db, "cap_a");

    const seen = db.transaction((tx) => {
      addSource(tx, "cap_b");
      // The query takes a Db and is given the Tx: it sees the write that is not committed yet.
      return sourceIds(tx);
    });

    expect(seen).toEqual(["cap_a", "cap_b"]);
  });

  it("is what a function that asks for a Tx cannot do without", () => {
    const { db } = testDatabase();
    // @ts-expect-error a Db is not a Tx: such a function runs inside db.transaction() or not at all
    const outside = () => addSource(db, "cap_a");

    expect(outside).toBeTypeOf("function");
    expect(sourceIds(db)).toEqual([]);
  });

  it("can be one inside another: the inner one alone is taken back when it fails", () => {
    const { db } = testDatabase();

    db.transaction((tx) => {
      addSource(tx, "cap_a");
      expect(() =>
        tx.transaction((inner) => {
          addSource(inner, "cap_b");
          throw new Error("the inner step failed");
        }),
      ).toThrow("the inner step failed");
      addSource(tx, "cap_c");
    });

    expect(sourceIds(db)).toEqual(["cap_a", "cap_c"]);
  });

  // "immediate" takes the write lock when the transaction begins and not at its first write, so
  // that what the body has read cannot change under it before it writes.
  it("holds the write lock from its first moment when it is asked to begin immediately", () => {
    const dir = mkdtempSync(join(tmpdir(), "hubber-handle-"));
    tempDirs.push(dir);
    const path = join(dir, "two-connections.sqlite");
    const first = raw(path);
    first.pragma("journal_mode = WAL");
    first.exec("CREATE TABLE notes (body TEXT NOT NULL) STRICT");
    // Does not wait for a lock: a taken one is an error at once.
    const second = raw(path, { timeout: 0 });
    const db = createDb(first);
    const secondCanWrite = () => {
      try {
        second.exec("BEGIN IMMEDIATE");
        second.exec("ROLLBACK");
        return true;
      } catch (error) {
        expect(error).toMatchObject({ code: "SQLITE_BUSY" });
        return false;
      }
    };

    const immediate = db.transaction(() => secondCanWrite(), { behavior: "immediate" });
    const deferred = db.transaction(() => secondCanWrite());

    expect(immediate).toBe(false);
    expect(deferred).toBe(true);
  });
});

// The test of something that calls the handle counts its transactions, or has one of them fail:
// it watches transaction() or puts a function of its own in its place.
describe("transaction() of a handle, in the test of what calls it", () => {
  it("can be watched, and keeps its rules while it is", () => {
    const { db } = testDatabase();
    const watched = vi.spyOn(db, "transaction");

    db.transaction((tx) => addSource(tx, "cap_a"));
    expect(() => db.transaction(async (tx) => addSource(tx, "cap_b"))).toThrow(NOT_SYNCHRONOUS);

    expect(watched).toHaveBeenCalledTimes(2);
    expect(sourceIds(db)).toEqual(["cap_a"]);
  });

  it("can be watched on a Tx as well", () => {
    const { db } = testDatabase();

    const seen = db.transaction((tx) => {
      const watched = vi.spyOn(tx, "transaction");
      tx.transaction((inner) => addSource(inner, "cap_a"));
      return watched.mock.calls.length;
    });

    expect(seen).toBe(1);
    expect(sourceIds(db)).toEqual(["cap_a"]);
  });

  it("can be replaced by a spy, and is itself again when the spy is taken off", () => {
    const { db } = testDatabase();
    const failure = new Error("the commit failed");

    vi.spyOn(db, "transaction").mockImplementation(() => {
      throw failure;
    });
    expect(() => db.transaction((tx) => addSource(tx, "cap_a"))).toThrow(failure);
    vi.restoreAllMocks();
    db.transaction((tx) => addSource(tx, "cap_b"));

    expect(sourceIds(db)).toEqual(["cap_b"]);
  });

  it("can be replaced by a plain assignment", () => {
    const { db } = testDatabase();
    const failure = new Error("the commit failed");

    db.transaction = () => {
      throw failure;
    };

    expect(() => db.transaction((tx) => addSource(tx, "cap_a"))).toThrow(failure);
    expect(sourceIds(db)).toEqual([]);
  });

  // What a tool for tests may rely on when it puts a stand-in on an object and takes it off again.
  it("is a property as the method of a class is one: it can be written and defined anew, and is not listed", () => {
    const { db } = testDatabase();
    const asAMethod = { writable: true, configurable: true, enumerable: false };

    const ofATx = db.transaction((tx) => Object.getOwnPropertyDescriptor(tx, "transaction"));

    expect(Object.getOwnPropertyDescriptor(db, "transaction")).toMatchObject(asAMethod);
    expect(ofATx).toMatchObject(asAMethod);
  });
});

// The driver ends a transaction with COMMIT or ROLLBACK, and runs neither while rows of a
// statement of the connection are still being read. The connection then stays inside the
// transaction: what the handle did afterwards would wait for a COMMIT that never comes.
describe("a transaction that could not be ended", () => {
  /** A statement of the connection with its first row read and the others waiting; close() gives them up. */
  function halfRead(connection: Database.Database): { close(): void } {
    const rows = connection.prepare("SELECT id FROM sources").iterate();
    rows.next();
    return {
      close: () => {
        rows.return?.();
      },
    };
  }

  /** What another connection would find: the rows that were committed. */
  const committed = (connection: Database.Database) =>
    raw(connection.serialize()).prepare("SELECT id FROM sources ORDER BY id").pluck().all();

  it.each([
    ["returns", () => "done"],
    [
      "throws",
      () => {
        throw new Error("the second step failed");
      },
    ],
  ])("is reported in words of the handle when its body %s with rows of the connection still unread", (_how, end) => {
    const { db, connection } = testDatabase();
    seed(db, "cap_a");
    let rows: { close(): void } | undefined;

    let thrown: unknown;
    try {
      db.transaction((tx) => {
        addSource(tx, "cap_b");
        rows = halfRead(connection);
        return end();
      });
    } catch (error) {
      thrown = error;
    }
    rows?.close();

    expect(thrown).toBeInstanceOf(TransactionNotEndedError);
    expect(thrown).toMatchObject({
      name: "TransactionNotEndedError",
      message: "The transaction could not be ended: the connection is still inside it and has to be closed.",
      // What the driver said when it was asked to end the transaction.
      cause: BUSY,
    });
    expect(connection.inTransaction).toBe(true);
    expect(committed(connection)).toEqual(["cap_a"]);
  });

  it("is reported for the outermost transaction when the rows were left unread by one inside it", () => {
    const { db, connection } = testDatabase();
    let rows: { close(): void } | undefined;

    expect(() =>
      db.transaction((tx) => {
        tx.transaction((inner) => {
          addSource(inner, "cap_a");
          rows = halfRead(connection);
        });
      }),
    ).toThrow(TransactionNotEndedError);
    rows?.close();

    expect(connection.inTransaction).toBe(true);
  });

  // Each of these would report success and stay inside the transaction that never commits.
  it.each([
    ["a transaction", (db: Db) => db.transaction((tx) => addSource(tx, "cap_late"))],
    ["a write", (db: Db) => seed(db, "cap_late")],
    ["a read", (db: Db) => sourceIds(db)],
    ["a statement in SQL", (db: Db) => db.run(sql`DELETE FROM sources`)],
  ])("leaves the handle of no use: %s is refused with an error of the same kind", (_what, use) => {
    const { db, connection } = testDatabase();
    seed(db, "cap_a");
    let rows: { close(): void } | undefined;
    let first: unknown;
    try {
      db.transaction(() => {
        rows = halfRead(connection);
      });
    } catch (error) {
      first = error;
    }
    rows?.close();

    expect(first).toBeInstanceOf(TransactionNotEndedError);
    expect(() => use(db)).toThrow(TransactionNotEndedError);
    // Seen from inside the transaction that is still open: nothing was added to it or taken away.
    expect(connection.prepare("SELECT id FROM sources").pluck().all()).toEqual(["cap_a"]);
  });

  it("is not reported for a transaction that failed and was taken back", () => {
    const { db, connection } = testDatabase();
    const failure = new Error("the second step failed");

    expect(() =>
      db.transaction((tx) => {
        addSource(tx, "cap_a");
        throw failure;
      }),
    ).toThrow(failure);

    expect(connection.inTransaction).toBe(false);
    // The handle goes on.
    db.transaction((tx) => addSource(tx, "cap_b"));
    expect(committed(connection)).toEqual(["cap_b"]);
  });

  // A transaction inside another is a savepoint, and nothing tells whether a savepoint is still
  // open. When the outer body catches the error and goes on, its commit takes along what the
  // inner body wrote.
  it("is not seen for a transaction inside another one, when the outer body catches the error and goes on", () => {
    const { db, connection } = testDatabase();

    db.transaction((tx) => {
      let rows: { close(): void } | undefined;
      expect(() =>
        tx.transaction((inner) => {
          addSource(inner, "cap_inner");
          rows = halfRead(connection);
          throw new Error("the inner step failed");
        }),
      ).toThrow(expect.objectContaining({ cause: BUSY }));
      rows?.close();
      addSource(tx, "cap_outer");
    });

    expect(committed(connection)).toEqual(["cap_inner", "cap_outer"]);
  });
});

// A Tx stands for "inside this transaction". Kept in a variable it would outlive the transaction
// and write straight to the connection, each statement in a commit of its own.
describe("a Tx after its transaction", () => {
  /** A Tx whose transaction has committed. */
  function committedTx(db: Db): Tx {
    let kept: Tx | undefined;
    db.transaction((tx) => {
      kept = tx;
    });
    return kept as Tx;
  }

  it("writes nothing once the transaction has committed", () => {
    const { db, connection } = testDatabase();
    let kept: Tx | undefined;
    db.transaction((tx) => {
      kept = tx;
      addSource(tx, "cap_a");
    });

    expect(() => addSource(kept as Tx, "cap_late")).toThrow(ENDED);

    expect(sourceIds(db)).toEqual(["cap_a"]);
    expect(connection.inTransaction).toBe(false);
  });

  it("writes nothing once the transaction was taken back", () => {
    const { db } = testDatabase();
    let kept: Tx | undefined;
    expect(() =>
      db.transaction((tx) => {
        kept = tx;
        addSource(tx, "cap_a");
        throw new Error("the second step failed");
      }),
    ).toThrow("the second step failed");

    expect(() => addSource(kept as Tx, "cap_late")).toThrow(ENDED);

    expect(sourceIds(db)).toEqual([]);
  });

  it.each([
    ["select()", (tx: Tx) => tx.select().from(sources).all()],
    ["selectDistinct()", (tx: Tx) => tx.selectDistinct().from(sources).all()],
    ["insert()", (tx: Tx) => tx.insert(sources).values(source("cap_late")).run()],
    ["update()", (tx: Tx) => tx.update(sources).set({ deletedAt: T }).run()],
    ["delete()", (tx: Tx) => tx.delete(sources).run()],
    [
      "with()",
      (tx: Tx) => {
        const all = tx.$with("all_sources").as((query) => query.select().from(sources));
        return tx.with(all).select().from(all).all();
      },
    ],
    ["$count()", (tx: Tx) => tx.$count(sources)],
    ["run()", (tx: Tx) => tx.run(sql`DELETE FROM sources`)],
    ["all()", (tx: Tx) => tx.all(sql`SELECT id FROM sources`)],
    ["get()", (tx: Tx) => tx.get(sql`SELECT id FROM sources`)],
    ["values()", (tx: Tx) => tx.values(sql`SELECT id FROM sources`)],
    ["transaction()", (tx: Tx) => tx.transaction((inner) => addSource(inner, "cap_late"))],
  ])("refuses %s", (_what, use) => {
    const { db } = testDatabase();
    seed(db, "cap_a");

    expect(() => use(committedTx(db))).toThrow(ENDED);

    // The row that was there is as it was, and no other has joined it.
    expect(db.select({ id: sources.id, deletedAt: sources.deletedAt }).from(sources).all()).toEqual([
      { id: "cap_a", deletedAt: null },
    ]);
  });

  // A failed assertion prints the objects it compared, and a logger may copy them: reading a
  // Tx as an object must not be a use of it.
  it("can still be copied and printed", () => {
    const { db } = testDatabase();
    const kept = committedTx(db);

    expect(() => ({ ...kept })).not.toThrow();
    expect(() => Object.entries(kept)).not.toThrow();
  });

  it("ends for the inner of two transactions with its own body, while the outer one goes on", () => {
    const { db } = testDatabase();
    let inner: Tx | undefined;

    db.transaction((tx) => {
      tx.transaction((nested) => {
        inner = nested;
        addSource(nested, "cap_a");
      });
      expect(() => addSource(inner as Tx, "cap_late")).toThrow(ENDED);
      addSource(tx, "cap_c");
    });

    expect(sourceIds(db)).toEqual(["cap_a", "cap_c"]);
  });

  // What the end of a Tx does not reach. A query holds the connection and not the Tx it was
  // built from: run after the transaction, it runs outside it. Whatever builds a query runs it
  // before the body returns.
  it("does not stop a query that was built inside the transaction and is run after it", () => {
    const { db, connection } = testDatabase();

    // Inside an object: a body that returns the query itself is refused.
    const { query } = db.transaction((tx) => ({ query: tx.insert(sources).values(source("cap_late")) }));
    expect(sourceIds(db)).toEqual([]);
    query.run();

    expect(connection.inTransaction).toBe(false);
    expect(sourceIds(db)).toEqual(["cap_late"]);
  });

  // Nor does it reach back. A body that calls an async function and does not return the promise
  // itself is not refused: what that function wrote before its first await is committed with
  // the transaction, and only the rest is stopped. In the application nobody holds the promise,
  // and its rejection ends the process; the test keeps it to look at it. A body calls no async
  // function.
  it.each([
    ["drops its promise", (_rest: Promise<void>): unknown => undefined],
    ["returns its promise inside an object", (rest: Promise<void>): unknown => ({ rest })],
    ["returns its promise inside a list", (rest: Promise<void>): unknown => [rest]],
  ])("does not stop what an async function wrote before its first await when the body %s", async (_how, handBack) => {
    const { db } = testDatabase();
    let rest: Promise<void> | undefined;

    db.transaction((tx) => {
      rest = writeNowAndLater(tx);
      return handBack(rest);
    });

    expect(sourceIds(db)).toEqual(["cap_now"]);
    await expect(rest).rejects.toThrow(ENDED);
    expect(sourceIds(db)).toEqual(["cap_now"]);
  });
});

// Drizzle gives a statement a fifth ending, execute(), and lets it be awaited, which calls
// execute(). On this driver Drizzle's own execute() hands back a promise: a refusal of the
// database goes to the promise and the body goes on, a delete runs when its transaction has
// ended, and a prepared statement does not run at all. The handle puts a refusal in its place.
// There is a case for every kind of statement that a handle gives out, in every place where one
// can stand: a kind that a later drizzle-orm lets through turns its case red.
describe("a statement that is ended in execute() or awaited", () => {
  /** A table of the test's own, where every statement is allowed: one that ran would show. */
  const notes = sqliteTable("notes", { id: integer("id").primaryKey(), body: text("body").notNull() });
  const FIRST = { id: 1, body: "first" };
  const SECOND = { id: 2, body: "second" };

  /** A handle on a database that holds the table with one row. */
  function withOneNote(): { db: Db; connection: Database.Database } {
    const connection = raw();
    connection.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT");
    const db = createDb(connection);
    db.insert(notes).values(FIRST).run();
    return { db, connection };
  }

  /** The rows as the connection finds them. */
  const rows = (connection: Database.Database) => connection.prepare("SELECT id, body FROM notes ORDER BY id").all();

  interface Prepared {
    execute(values?: Record<string, unknown>): unknown;
  }
  interface Built extends Prepared, PromiseLike<unknown> {}

  const everyNote = (db: Db) => db.$with("every_note").as(db.select().from(notes));

  // Every kind of statement that the entry points of a handle build. Each would read the row,
  // or change the table, if it ran.
  const BUILT: [string, (db: Db) => Built][] = [
    ["select()", (db) => db.select().from(notes)],
    ["selectDistinct()", (db) => db.selectDistinct().from(notes)],
    ["insert() of values", (db) => db.insert(notes).values(SECOND)],
    ["insert() of a select", (db) => db.insert(notes).select(sql`SELECT id + 1, body FROM notes`)],
    ["update()", (db) => db.update(notes).set({ body: "changed" })],
    ["delete()", (db) => db.delete(notes)],
    ["with().select()", (db) => db.with(everyNote(db)).select().from(notes)],
    ["with().selectDistinct()", (db) => db.with(everyNote(db)).selectDistinct().from(notes)],
    ["with().insert()", (db) => db.with(everyNote(db)).insert(notes).values(SECOND)],
    ["with().update()", (db) => db.with(everyNote(db)).update(notes).set({ body: "changed" })],
    ["with().delete()", (db) => db.with(everyNote(db)).delete(notes)],
  ];

  // The statements that are compiled once and run many times, and one that takes a value when
  // it is run.
  const PREPARED: [string, (db: Db) => Prepared, Record<string, unknown>?][] = [
    ["a prepared select()", (db) => db.select().from(notes).prepare()],
    ["a prepared insert()", (db) => db.insert(notes).values(SECOND).prepare()],
    ["a prepared update()", (db) => db.update(notes).set({ body: "changed" }).prepare()],
    ["a prepared delete()", (db) => db.delete(notes).prepare()],
    [
      "a prepared statement that takes a value",
      (db) =>
        db
          .delete(notes)
          .where(eq(notes.id, sql.placeholder("id")))
          .prepare(),
      { id: 1 },
    ],
  ];

  /** Where a statement can stand. */
  const PLACES: [string, (db: Db, use: (handle: Db) => void) => void][] = [
    ["on the handle", (db, use) => use(db)],
    ["in the body of a transaction", (db, use) => db.transaction((tx) => use(tx))],
    ["in a transaction inside another one", (db, use) => db.transaction((tx) => tx.transaction((inner) => use(inner)))],
  ];

  describe.each(PLACES)("%s", (_where, at) => {
    it.each([...BUILT, ...PREPARED])(
      "refuses %s at the call, and sends nothing to the database",
      async (_what, build, values) => {
        const { db, connection } = withOneNote();
        let thrown: unknown;
        let sent: number | undefined;

        // The refusal is caught where it is thrown, so that a transaction around it commits: what
        // the statement wrote would stay.
        at(db, (handle) => {
          const compiled = vi.spyOn(connection, "prepare");
          const statement = build(handle);
          // A prepared statement is compiled when it is built: what reaches the database later is
          // its run. Any other statement is compiled when it is run.
          const run = compiled.mock.results.flatMap(({ value }) =>
            (["run", "all", "get", "iterate"] as const).map((step) => vi.spyOn(value as Database.Statement, step)),
          );
          compiled.mockClear();
          try {
            statement.execute(values);
          } catch (error) {
            thrown = error;
          }
          sent = compiled.mock.calls.length + run.filter((step) => step.mock.calls.length > 0).length;
          compiled.mockRestore();
        });
        // A statement that was put off and not refused has run by now.
        await whatWaitsHasRun();

        expect(thrown).toEqual(NOT_AN_ENDING);
        expect(sent).toBe(0);
        expect(rows(connection)).toEqual([FIRST]);
      },
    );

    // On this driver the four of a handle that take SQL run it at the call and give back what the
    // database answered: there is no statement in between that could be ended in execute().
    it.each([
      ["run()", (db: Db) => db.run(sql`UPDATE notes SET body = 'changed'`), { changes: 1, lastInsertRowid: 1 }],
      ["all()", (db: Db) => db.all(sql`SELECT id FROM notes`), [{ id: 1 }]],
      ["get()", (db: Db) => db.get(sql`SELECT id FROM notes`), { id: 1 }],
      ["values()", (db: Db) => db.values(sql`SELECT id FROM notes`), [[1]]],
    ])("has nothing to refuse in %s of SQL, which gives back the answer of the database", (_what, use, answer) => {
      const { db } = withOneNote();
      let given: unknown;

      at(db, (handle) => {
        given = use(handle);
      });

      // Plain data, and so neither a statement nor a promise.
      expect(given).toStrictEqual(answer);
    });
  });

  it.each(BUILT)("refuses %s that is awaited, and sends nothing to the database", async (_what, build) => {
    const { db, connection } = withOneNote();
    const statement = build(db);
    const compiled = vi.spyOn(connection, "prepare");

    let thrown: unknown;
    try {
      await statement;
    } catch (error) {
      thrown = error;
    }
    await whatWaitsHasRun();

    expect(thrown).toEqual(NOT_AN_ENDING);
    expect(compiled).not.toHaveBeenCalled();
    expect(rows(connection)).toEqual([FIRST]);
  });

  // Drizzle's own execute() gives a refusal of the database to a promise that nobody holds: the
  // body goes on, and the transaction commits what it wrote before and after. The refusal of the
  // handle is thrown in the body.
  it("ends the body of a transaction where the statement stands, and the transaction is taken back", () => {
    const { db, connection } = withOneNote();

    expect(() =>
      db.transaction((tx) => {
        tx.insert(notes).values(SECOND).run();
        tx.insert(notes).values({ id: 3, body: "third" }).execute();
        tx.insert(notes).values({ id: 4, body: "fourth" }).run();
      }),
    ).toThrow(NOT_AN_ENDING);

    expect(rows(connection)).toEqual([FIRST]);
    expect(connection.inTransaction).toBe(false);
  });

  // An await calls execute() when the code that is running has returned. With Drizzle's own
  // execute(), a statement that an async function of a body awaits is built inside the
  // transaction and runs after it, in a commit of its own: the end of a Tx does not reach a
  // statement that is built already.
  it("lets a statement that an async function of a body awaits write nothing after the transaction", async () => {
    const { db, connection } = withOneNote();
    const addsWhenAwaited = async (tx: Tx): Promise<void> => {
      await tx.insert(notes).values(SECOND);
    };
    let rest: Promise<void> | undefined;

    db.transaction((tx) => {
      rest = addsWhenAwaited(tx);
    });

    await expect(rest).rejects.toEqual(NOT_AN_ENDING);
    expect(rows(connection)).toEqual([FIRST]);
  });

  // The refusal is put on Drizzle's classes when the module of the handle is loaded. A test
  // runner may load that module anew while Drizzle stays loaded, and so twice in one process.
  it("is put in place anew when the module of the handle is loaded once more", async () => {
    const { db } = withOneNote();
    const inPlace = () => db.select().from(notes).execute;
    const first = inPlace();

    vi.resetModules();
    await import("./handle.ts");

    expect(inPlace()).not.toBe(first);
    expect(() => db.select().from(notes).execute()).toThrow(NOT_AN_ENDING);
  });

  it.each([
    ["a statement", (db: Db) => ({ write: db.update(notes).set({ body: "changed" }), read: db.select().from(notes) })],
    [
      "a prepared statement",
      (db: Db) => ({
        write: db.update(notes).set({ body: "changed" }).prepare(),
        read: db.select().from(notes).prepare(),
      }),
    ],
  ])("leaves %s the four endings that the refusal names", (_what, build) => {
    const { db } = withOneNote();
    const { write, read } = build(db);

    expect(write.run()).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(read.all()).toEqual([{ id: 1, body: "changed" }]);
    expect(read.get()).toEqual({ id: 1, body: "changed" });
    expect(read.values()).toEqual([[1, "changed"]]);
  });

  // What the refusal does not reach. $count() gives no statement: it has none of the four
  // endings and no execute(). Inside another statement it is a part of that one; alone it gives
  // its number only to whoever awaits it. It reads and never writes.
  it("does not reach $count(), which is awaited when it stands alone", async () => {
    const { db } = withOneNote();
    const counted = db.$count(notes);

    expect("execute" in counted).toBe(false);
    expect(db.select({ notes: counted }).from(notes).get()).toEqual({ notes: 1 });
    expect(await counted).toBe(1);
  });

  // The cases of this file name the entry points of a handle by hand. A drizzle-orm that gives a
  // handle another one fails here, and its statements get their cases before this list is
  // written anew.
  it("has been tried at every entry point: a handle and a Tx have these members and no others", () => {
    const { db } = withOneNote();
    const members = (handle: object) => {
      const names = new Set<string>();
      for (let object = handle; object !== Object.prototype; object = Object.getPrototypeOf(object)) {
        for (const name of Object.getOwnPropertyNames(object)) names.add(name);
      }
      names.delete("constructor");
      return [...names].sort();
    };
    const ofEveryHandle = [
      "$cache",
      "$count",
      "$with",
      "_",
      "all",
      "delete",
      "dialect",
      "get",
      "insert",
      "query",
      "resultKind",
      "run",
      "select",
      "selectDistinct",
      "session",
      "transaction",
      "update",
      "values",
      "with",
    ];

    const [ofATx, ofAnInnerTx] = db.transaction((tx) => [members(tx), tx.transaction((inner) => members(inner))]);

    // The connection under the handle.
    expect(members(db)).toEqual([...ofEveryHandle, "$client"].sort());
    // What a Tx adds is its place among the transactions, and rollback(), which throws.
    expect(ofATx).toEqual([...ofEveryHandle, "nestedIndex", "rollback", "schema"].sort());
    expect(ofAnInnerTx).toEqual(ofATx);
  });
});

describe("a refusal of the database", () => {
  it("of a trigger comes out of a query builder as the driver's error, with its code and the trigger's sentence", () => {
    const { db } = testDatabase();
    seed(db, "cap_a");

    let thrown: unknown;
    try {
      db.update(sources)
        .set({ kind: "note" as never })
        .where(eq(sources.id, "cap_a"))
        .run();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Database.SqliteError);
    expect(thrown).toMatchObject({
      code: "SQLITE_CONSTRAINT_TRIGGER",
      message: "sources: a source keeps its id, kind and dates",
    });
  });

  it("of a constraint comes out the same way, with the code of the constraint", () => {
    const { db } = testDatabase();

    expect(() =>
      db
        .insert(sources)
        .values({ ...source("cap_a"), createdAt: "yesterday" as never })
        .run(),
    ).toThrow(expect.objectContaining({ code: "SQLITE_CONSTRAINT_CHECK" }));
    expect(db.select({ n: count() }).from(sources).get()).toEqual({ n: 0 });
  });

  // The wrapper's message is the text of the statement. Values are bound, so none of them is in
  // it, but a log line still takes the code from the cause and leaves the message out.
  it("comes out of db.run() wrapped: the driver's error is the cause, and the message is the statement without its values", () => {
    const { db } = testDatabase();
    seed(db, "cap_a");

    let thrown: unknown;
    try {
      db.run(sql`UPDATE sources SET kind = ${"a kind that must not be logged"} WHERE id = ${"cap_a"}`);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DrizzleError);
    const { message, cause } = thrown as DrizzleError;
    expect(cause).toBeInstanceOf(Database.SqliteError);
    expect(cause).toMatchObject({
      code: "SQLITE_CONSTRAINT_TRIGGER",
      message: "sources: a source keeps its id, kind and dates",
    });
    expect(message).toContain("UPDATE sources SET kind = ? WHERE id = ?");
    expect(message).not.toContain("must not be logged");
  });
});
