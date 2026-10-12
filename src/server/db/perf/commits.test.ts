import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceDatabase } from "../../workspace/database.ts";
import { type OpenWorkspace, openWorkspace } from "../../workspace/open.ts";
import { createTestWorkspace, type TestWorkspace } from "../../workspace/testing.ts";
import { DIRECT_TRANSPORT } from "../../workspace/transport.ts";
import { commitsDuring } from "./commits.ts";

const workspaces: TestWorkspace[] = [];
const open: OpenWorkspace[] = [];

afterEach(() => {
  for (const workspace of open.splice(0)) workspace.close();
  for (const workspace of workspaces.splice(0)) workspace.remove();
});

/** The connection of a workspace, as the application has it, and the log beside its database. */
function workspace(): { connection: WorkspaceDatabase; wal: string } {
  const created = createTestWorkspace();
  workspaces.push(created);
  const opened = openWorkspace({ dir: created.dir, source: "variable" }, {}, DIRECT_TRANSPORT);
  open.push(opened);
  return { connection: opened.database, wal: `${opened.paths.database}-wal` };
}

/** A statement that writes one small row: the row of a file that no part uses. */
function writer(connection: WorkspaceDatabase): () => void {
  const insert = connection.prepare(
    "INSERT INTO files (sha256, byte_size, media_type, created_at) VALUES (?, 0, 'text/plain', '2026-10-12T09:00:00.000Z')",
  );
  let written = 0;
  return () => {
    insert.run((written++).toString(16).padStart(64, "0"));
  };
}

/** A transaction that writes about a hundred pages, as often as asked: enough of them and the log is started anew. */
function largeCommits(connection: WorkspaceDatabase, count: number): void {
  connection.exec("CREATE TABLE IF NOT EXISTS filler (id INTEGER PRIMARY KEY, body TEXT) STRICT");
  const insert = connection.prepare("INSERT INTO filler (body) VALUES (?)");
  const row = "x".repeat(3_000);
  for (let commit = 0; commit < count; commit++) {
    connection.transaction(() => {
      for (let written = 0; written < 150; written++) insert.run(row);
    })();
  }
}

describe("commitsDuring", () => {
  it("counts a statement outside a transaction as a commit of its own", () => {
    const { connection, wal } = workspace();
    const write = writer(connection);
    write();

    expect(commitsDuring(wal, write)).toBe(1);
    expect(
      commitsDuring(wal, () => {
        write();
        write();
        write();
      }),
    ).toBe(3);
  });

  it("counts a transaction as one commit, whatever it writes", () => {
    const { connection, wal } = workspace();
    const write = writer(connection);
    write();

    expect(
      commitsDuring(wal, () => {
        connection.transaction(() => {
          for (let row = 0; row < 40; row++) write();
        })();
      }),
    ).toBe(1);
    expect(connection.prepare("SELECT count(*) FROM files").pluck().get()).toBe(41);
  });

  it("counts nothing for what only reads, and nothing for a transaction that is taken back", () => {
    const { connection, wal } = workspace();
    const write = writer(connection);
    write();

    expect(commitsDuring(wal, () => connection.prepare("SELECT count(*) FROM files").get())).toBe(0);
    expect(
      commitsDuring(wal, () => {
        connection.exec("BEGIN");
        write();
        connection.exec("ROLLBACK");
      }),
    ).toBe(0);
  });

  it("refuses to count from a log that is empty or not there: a log that is started anew meanwhile would not show", () => {
    const { connection, wal } = workspace();
    const write = writer(connection);
    const emptied = () => {
      // What was written so far is folded into the database, and the log is emptied.
      connection.pragma("wal_checkpoint(TRUNCATE)");
    };
    const refused = /is empty or not there: commit once before commits are counted/;

    emptied();
    expect(() => commitsDuring(wal, write)).toThrow(refused);
    expect(() => commitsDuring(`${wal}.missing`, () => {})).toThrow(refused);
    // Counted from an empty log, each of these gave a number, and the wrong one: 5 for 40, and 1 for 2.
    emptied();
    expect(() => commitsDuring(wal, () => largeCommits(connection, 40))).toThrow(refused);
    emptied();
    expect(() =>
      commitsDuring(wal, () => {
        write();
        emptied();
        write();
      }),
    ).toThrow(refused);
    // The function was not run by a count that was refused: nothing of the last one was written.
    expect(connection.prepare("SELECT count(*) FROM files").pluck().get()).toBe(0);
  });

  it("refuses to count across a log that grew until it was started anew", () => {
    const { connection, wal } = workspace();
    writer(connection)();

    // Forty transactions of a hundred pages each pass the thousand pages at which the log is folded into the database.
    expect(() => commitsDuring(wal, () => largeCommits(connection, 40))).toThrow(
      /was started anew while commits were counted/,
    );
  });

  it("refuses to count across a checkpoint that starts the log anew", () => {
    const { connection, wal } = workspace();
    const write = writer(connection);
    write();

    expect(() =>
      commitsDuring(wal, () => {
        write();
        connection.pragma("wal_checkpoint(RESTART)");
        write();
      }),
    ).toThrow(/was started anew while commits were counted/);
    // The frames of the generation before are still in the file behind the new ones: they are not counted.
    expect(commitsDuring(wal, write)).toBe(1);
  });
});
