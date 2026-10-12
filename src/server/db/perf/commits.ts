// Counting commits instead of milliseconds. On the connection of a workspace every commit waits
// until the drive has written it, about three milliseconds, whatever its size: that wait is what
// makes a write slow, so "how many commits did this take" is the number that says whether writes
// that belong together went in one transaction. It is the same on every machine, busy or not.
//
// The count is read from the write-ahead log beside the database. Every transaction ends in a
// frame whose header carries the size of the database after the commit; every other frame carries
// zero there.
import { closeSync, openSync, readSync, statSync } from "node:fs";

const LOG_HEADER = 32;
const FRAME_HEADER = 24;

/** The commits that the log holds, and the mark of its generation: a checkpoint that starts the log anew changes it. */
function readLog(walFile: string): { generation: string; commits: number } {
  let size: number;
  try {
    size = statSync(walFile).size;
  } catch (error) {
    // No log yet: nothing was written since the database was opened.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { generation: "", commits: 0 };
    throw error;
  }
  if (size < LOG_HEADER) return { generation: "", commits: 0 };
  const file = openSync(walFile, "r");
  try {
    const header = Buffer.alloc(LOG_HEADER);
    readSync(file, header, 0, LOG_HEADER, 0);
    const pageSize = header.readUInt32BE(8);
    const salt = header.subarray(16, 24);
    const frame = Buffer.alloc(FRAME_HEADER);
    let commits = 0;
    for (let at = LOG_HEADER; at + FRAME_HEADER + pageSize <= size; at += FRAME_HEADER + pageSize) {
      readSync(file, frame, 0, FRAME_HEADER, at);
      // A frame of an earlier generation of the log: everything from here on is left over.
      if (!frame.subarray(8, 16).equals(salt)) break;
      if (frame.readUInt32BE(4) !== 0) commits++;
    }
    return { generation: salt.toString("hex"), commits };
  } finally {
    closeSync(file);
  }
}

/**
 * How many transactions the function committed to the database whose write-ahead log is the given
 * file ("hubber.sqlite-wal" beside the database). The function is synchronous, and nothing else
 * may write to the database while it runs.
 *
 * Throws when a checkpoint started the log anew in the meantime: the frames before it are gone,
 * and the count would be wrong. That happens once the log has grown past a thousand pages, so
 * what is counted has to be small.
 *
 * Throws as well, before the function is run, when the log is empty or not there, as it is right
 * after a workspace was opened: an empty log has no mark by which a new start could be told, and
 * the count could be wrong without a word. The caller commits once first.
 */
export function commitsDuring(walFile: string, fn: () => void): number {
  const before = readLog(walFile);
  if (before.generation === "") {
    throw new Error(`The write-ahead log ${walFile} is empty or not there: commit once before commits are counted.`);
  }
  fn();
  const after = readLog(walFile);
  if (after.generation !== before.generation) {
    throw new Error(`The write-ahead log ${walFile} was started anew while commits were counted.`);
  }
  return after.commits - before.commits;
}
