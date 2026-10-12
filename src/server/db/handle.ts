// The typed handle on a workspace database: Drizzle on top of the one connection that
// openWorkspaceDatabase() hands out.
//
// The only module that imports Drizzle's driver (lint). Given a path, the driver opens a
// database file by itself, past the check of the endpoint pin; here it only ever gets a
// connection that has passed it. Nothing is opened in this file.
//
// Loading this file changes Drizzle for the whole process: execute() of a statement throws from
// then on (see notAnEnding()).
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import {
  SQLiteDeleteBase,
  SQLiteInsertBase,
  SQLitePreparedQuery,
  SQLiteSelectBase,
  SQLiteUpdateBase,
} from "drizzle-orm/sqlite-core";
import type { WorkspaceDatabase } from "../workspace/database.ts";

/** What queries take. */
export type Db = BetterSQLite3Database;

/**
 * What the body of a transaction gets, and what applying and undoing an operation take: they
 * then run inside a transaction or not at all. A function that asks for a Db accepts a Tx.
 *
 * A transaction is synchronous, so none spans a model call, and a Tx is good for as long as
 * the body it was handed to runs. createDb() holds both, for a transaction of the handle and
 * for one inside another:
 *   - a body that is an async function is refused before any of it runs. It would return at
 *     its first await, and the rest of it would run when the transaction is over;
 *   - a body that returns a promise is refused when it returns, and what it wrote is taken
 *     back. A query counts as a promise, since it has a then(): a body that returns one has
 *     built a statement and not run it;
 *   - a Tx that is used after its body has returned or thrown throws. Without that it would
 *     write straight to the connection, each statement in a commit of its own.
 *
 * A statement is synchronous too: it runs where it ends in .run(), .all(), .get() or .values().
 * One that is ended in .execute(), or awaited, throws there: see notAnEnding().
 *
 * Three things a caller can still get wrong:
 *   - a query that is built inside a transaction and run after it. A query holds the
 *     connection and not the Tx it was built from, so nothing stops it then: it runs outside
 *     the transaction it was meant for, in a commit of its own or inside whichever
 *     transaction is open at that moment. Whatever builds a query runs it before the body
 *     returns: it ends in .run(), .all(), .get() or .values();
 *   - an async function that the body calls without returning its promise: the body drops
 *     the promise, or hands it back inside an object or a list. What that function wrote
 *     before its first await is committed with the transaction. The rest of it runs when the
 *     Tx has ended and is refused there, and with nobody waiting for the promise that
 *     rejection ends the process. A body calls no async function;
 *   - rows of a statement that are still being read when a body returns or throws. That takes
 *     the connection itself: a query of the handle reads all its rows at once, an iterator of
 *     the connection reads them one by one. While rows are being read the driver runs neither
 *     COMMIT nor ROLLBACK, and the connection stays inside the transaction. For the outermost
 *     transaction createDb() sees that and throws a TransactionNotEndedError. For one inside
 *     another nothing tells: it fails with the refusal of the driver, and if the outer body
 *     catches that and goes on, its commit takes along what the inner body wrote. A body
 *     reads every statement of the connection to its end, or closes it, before it returns.
 */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The connection is still inside a transaction of the handle that should have ended: the driver
 * could run neither COMMIT nor ROLLBACK, and `cause` is what it said. Whatever the connection
 * is given from then on joins that transaction and waits for a commit that never comes, so the
 * handle refuses every further use with an error of this kind. What the transaction wrote is
 * not committed, and is gone when the connection is closed: closing it is all that is left to
 * do with the connection.
 */
export class TransactionNotEndedError extends Error {
  override name = "TransactionNotEndedError";

  constructor(cause: unknown) {
    super("The transaction could not be ended: the connection is still inside it and has to be closed.", { cause });
  }
}

/** The words the driver has for the same refusal. */
const NOT_SYNCHRONOUS = "Transaction function cannot return a promise";

// The language gives the constructor of async functions no name; this is the way to it.
const AsyncFunction = (async () => {}).constructor;

/**
 * Makes every use of a handle throw from now on: every query of a handle begins by reading its
 * session. Not enumerable, so that copying or printing the handle, as a failed assertion does,
 * is no use of it.
 */
function end(handle: object, refusal: () => Error): void {
  Object.defineProperty(handle, "session", {
    enumerable: false,
    get: () => {
      throw refusal();
    },
  });
}

/**
 * Replaces transaction() of a handle by one that keeps the three rules of a Tx, and that hands
 * its body a Tx whose own transaction() keeps them too.
 */
function guardTransactions(handle: Pick<Db, "transaction">, connection: WorkspaceDatabase): void {
  const begin = handle.transaction.bind(handle);
  const transaction: Db["transaction"] = (body, config) => {
    if (body instanceof AsyncFunction) throw new TypeError(NOT_SYNCHRONOUS);
    // A transaction inside another one is a savepoint: the connection is inside a transaction
    // before it and after it.
    const outermost = !connection.inTransaction;
    try {
      return begin((tx) => {
        guardTransactions(tx, connection);
        try {
          const result = body(tx);
          // Looked at and never called: then() of a query throws, in the words of notAnEnding().
          if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
            throw new TypeError(NOT_SYNCHRONOUS);
          }
          return result;
        } finally {
          end(tx, () => new Error("The transaction of this handle has ended."));
        }
      }, config);
    } catch (error) {
      // The driver ends a transaction whether its body returned or threw, and throws when it
      // cannot: a transaction that is still open has always come this way.
      if (!outermost || !connection.inTransaction) throw error;
      end(handle, () => new TransactionNotEndedError(error));
      throw new TransactionNotEndedError(error);
    }
  };
  // Writable and configurable, as the method it stands for: the test of something that calls
  // the handle watches transaction() or puts a function of its own in its place.
  Object.defineProperty(handle, "transaction", { value: transaction, writable: true, configurable: true });
}

/**
 * Stands in the place of execute() of a statement.
 *
 * Drizzle gives a statement a fifth ending, execute(), and lets a statement be awaited, which
 * calls execute(). On this driver Drizzle's execute() hands back a promise, whatever becomes of
 * the statement:
 *   - a select, an insert or an update runs at once, and a refusal of the database goes to the
 *     promise. It is not thrown where the statement stands: a transaction body goes on, and
 *     commits what it wrote before and after;
 *   - a delete does not run at the call. It runs as soon as the code that is running has
 *     returned, and for a statement of a transaction body the transaction has ended by then,
 *     committed or taken back: the delete is a commit of its own;
 *   - a prepared statement is not run by execute(): what that hands back runs it when it is
 *     awaited.
 * A statement that is awaited fares as the delete does: it runs when the code that is running
 * has returned. One that an async function of a transaction body awaits runs after the
 * transaction.
 *
 * So execute() throws instead: at the call, before anything is sent to the database, on a
 * handle and on a Tx alike. Awaiting a statement, or calling its then(), fails with the same
 * error.
 */
function notAnEnding(): never {
  throw new Error("A statement is not run with .execute() or await: it ends in .run(), .all(), .get() or .values().");
}

// The refusal is put on the classes of Drizzle, and so on every statement of this process,
// whichever handle built it. A handle has no place for it: a statement takes nothing from its
// handle but the session and the dialect, and neither can tell execute() from an ending, since
// execute() of a select, an insert or an update calls the statement's own .all() or .run().
//
// It rests on this of drizzle-orm. A handle and a Tx without relational queries, as createDb()
// makes them, give out statements of four classes: one each for select, insert, update and
// delete, whichever entry point builds it, with() or not. prepare() of each gives a statement
// whose class extends a fifth. execute() is a method of each of the five, and awaiting goes
// through it. And run(), all(), get() and values() of a handle, which take SQL, run it at the
// call and give back no statement. handle.test.ts has a case for each of these and one for the
// list of the entry points, and fails when a later drizzle-orm differs.
//
// What remains. Nothing tells before a statement is reached: the type check accepts execute()
// and await, and lint does not report execute() of a statement that a handle builds. And the
// refusal does not reach $count(), which has no execute() and none of the four endings. Inside
// another statement it is a part of that one. Alone it gives its number only to whoever awaits
// it, and so not to a transaction body; it reads and never writes.
for (const statement of [SQLiteSelectBase, SQLiteInsertBase, SQLiteUpdateBase, SQLiteDeleteBase, SQLitePreparedQuery]) {
  // Writable and configurable, as the method it stands for: when this file is loaded once more
  // in the same process, as a test runner may do, its refusal takes the place of the first.
  Object.defineProperty(statement.prototype, "execute", { value: notAnEnding, writable: true, configurable: true });
}

export function createDb(connection: WorkspaceDatabase): Db {
  // Without the schema, and so without Drizzle's relational queries (db.query): each of them
  // is built with the session in it, and would go on reading through a Tx that has ended.
  const db = drizzle(connection);
  guardTransactions(db, connection);
  return db;
}
