// The conditions that partial indexes are built on, as SQL fragments for the WHERE of a query.
//
// The words are written into the SQL text on purpose. SQLite uses a partial index only when it
// can tell that a query asks for rows the index holds. With the words in the text of the query
// it always can. With the words as bound values it cannot for a list of states: the counter of
// the Inbox, asked with its two states as values, reads every operation ever recorded. For a
// single state it gets there by planning the statement again for the value it was given, which
// nothing here relies on. A query that names one of these conditions takes it from here and
// never passes the word as a value.
//
// Every fragment is in parentheses, so that it keeps its meaning under not() and beside or().
import { sql } from "drizzle-orm";
import { itemPersons, items } from "./items.ts";
import { mentions } from "./knowledge.ts";
import { operations } from "./operations.ts";
import { captureParts } from "./sources.ts";
import { queueJobs, runs } from "./work.ts";

/** Waits in the Inbox for a decision. Index: operations_pending. */
export const operationIsPending = sql`(${operations.state} IN ('proposed', 'invalid'))`;

/** Changed the data at some time, also when it was undone since. Index: operations_journal. */
export const operationIsJournalEntry = sql`(${operations.appliedAt} IS NOT NULL)`;

/** Waits for a worker. Index: queue_jobs_due. */
export const jobIsQueued = sql`(${queueJobs.state} = 'queued')`;

/** Held by a worker, or left behind by one that is gone. Index: queue_jobs_running. */
export const jobIsRunning = sql`(${queueJobs.state} = 'running')`;

/** In progress, or left behind by a process that was killed. Indexes: runs_running, runs_one_running_per_job. */
export const runIsRunning = sql`(${runs.state} = 'running')`;

/**
 * Ended with "finish". Index: runs_one_commit_per_job, which holds only the committed runs that
 * have a job. A query uses it when it also asks for the job; alone, the fragment reads every run.
 */
export const runIsCommitted = sql`(${runs.state} = 'committed')`;

/** Open and not merged into another item: what lists show. Index: items_active. */
export const itemIsActive = sql`(${items.closedAt} IS NULL AND ${items.mergedIntoId} IS NULL)`;

/** The row that names the owner of an item. Index: item_persons_one_owner. */
export const itemPersonIsOwner = sql`(${itemPersons.role} = 'owner')`;

/** Neither resolved to a person nor skipped. Index: mentions_unresolved. */
export const mentionIsUnresolved = sql`(${mentions.personId} IS NULL AND ${mentions.skippedAt} IS NULL)`;

/** The text the owner typed: the one part of an input where commands are recognised. Index: capture_parts_one_typed. */
export const partIsTyped = sql`(${captureParts.kind} = 'typed')`;
