// Work in progress: the queue, the runs of the agent loop and the log of model calls. None of
// them holds text of a source, a prompt or a response, except the summary of a run.
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { SourceId } from "../../../shared/ids.ts";
import type { JobKind, JobState, ModelPurpose, ModelRole, RunKind, RunState } from "../../../shared/vocabulary.ts";
import { id, instant, json } from "./columns.ts";
import { sources } from "./sources.ts";
import { jobStates, runStates } from "./vocabularies.ts";

export const queueJobs = sqliteTable(
  "queue_jobs",
  {
    id: id("job").primaryKey(),
    kind: text("kind").$type<JobKind>().notNull(),
    state: text("state")
      .$type<JobState>()
      .notNull()
      .references(() => jobStates.code),
    /** The material the job works on, when it works on material. */
    sourceId: text("source_id")
      .$type<SourceId>()
      .references(() => sources.id),
    /** At most one job per key waits for its first attempt: a second request for the same work joins the first. */
    dedupeKey: text("dedupe_key"),
    /** Attempts started so far: counted when an attempt starts. */
    attempts: integer("attempts").notNull(),
    maxAttempts: integer("max_attempts").notNull(),
    /** Not before this instant: the delay of a new job, or the growing gap before a retry. */
    runAfter: instant("run_after").notNull(),
    /** The lease: a running job whose lease has passed belongs to a worker that is gone. */
    leasedUntil: instant("leased_until"),
    createdAt: instant("created_at").notNull(),
    /** Start of the newest attempt. */
    startedAt: instant("started_at"),
    finishedAt: instant("finished_at"),
    /** The newest failure, also while the job waits for its next attempt. */
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    /** Arguments of the job as a JSON object: identifiers and options, never content of material. */
    payload: json("payload").notNull(),
  },
  (t) => [
    index("queue_jobs_due").on(t.runAfter).where(sql`state = 'queued'`),
    index("queue_jobs_running").on(t.leasedUntil).where(sql`state = 'running'`),
    index("queue_jobs_by_source").on(t.sourceId, t.createdAt).where(sql`source_id IS NOT NULL`),
    uniqueIndex("queue_jobs_one_queued_per_key")
      .on(t.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL AND state = 'queued' AND attempts = 0`),
  ],
);

/** One execution of the agent loop. Each attempt of a job is a new run. */
export const runs = sqliteTable(
  "runs",
  {
    id: id("run").primaryKey(),
    kind: text("kind").$type<RunKind>().notNull(),
    state: text("state")
      .$type<RunState>()
      .notNull()
      .references(() => runStates.code),
    /** What the run processes, and what its Inbox card is about. */
    sourceId: text("source_id")
      .$type<SourceId>()
      .references(() => sources.id),
    jobId: id("job", "job_id").references(() => queueJobs.id),
    model: text("model"),
    promptVersion: text("prompt_version"),
    startedAt: instant("started_at").notNull(),
    endedAt: instant("ended_at"),
    /** Why a run failed: a word of the code, whose shape the database does not check. */
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    /** The text given with "finish". Written by the agent about the material, and removed with it. */
    summary: text("summary"),
  },
  (t) => [
    uniqueIndex("runs_one_commit_per_job").on(t.jobId).where(sql`job_id IS NOT NULL AND state = 'committed'`),
    uniqueIndex("runs_one_running_per_job").on(t.jobId).where(sql`job_id IS NOT NULL AND state = 'running'`),
    index("runs_by_source").on(t.sourceId, t.startedAt).where(sql`source_id IS NOT NULL`),
    index("runs_running").on(t.startedAt).where(sql`state = 'running'`),
  ],
);

/** One row per request to the model, written when the request ends. No prompt and no response. */
export const modelCalls = sqliteTable("model_calls", {
  id: integer("id").primaryKey(),
  runId: id("run", "run_id").references(() => runs.id),
  /** For calls made outside a run, such as the transcription of an image. */
  jobId: id("job", "job_id").references(() => queueJobs.id),
  role: text("role").$type<ModelRole>().notNull(),
  purpose: text("purpose").$type<ModelPurpose>().notNull(),
  model: text("model").notNull(),
  /** For a call that has a prompt of its own. The calls of an agent run share the run's and leave this NULL. */
  promptVersion: text("prompt_version"),
  startedAt: instant("started_at").notNull(),
  durationMs: integer("duration_ms").notNull(),
  /** Time to the first streamed token; NULL when nothing arrived. */
  firstTokenMs: integer("first_token_ms"),
  /** As the API reports them; NULL when the call ended without usage. */
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cacheReadInputTokens: integer("cache_read_input_tokens"),
  cacheCreationInputTokens: integer("cache_creation_input_tokens"),
  httpStatus: integer("http_status"),
  stopReason: text("stop_reason"),
  /** The request identifier the endpoint returned. */
  requestId: text("request_id"),
  errorType: text("error_type"),
  errorMessage: text("error_message"),
  /** Events of the call that are not errors, as JSON. */
  detail: json("detail"),
});

export type QueueJob = typeof queueJobs.$inferSelect;
export type NewQueueJob = typeof queueJobs.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type ModelCall = typeof modelCalls.$inferSelect;
export type NewModelCall = typeof modelCalls.$inferInsert;
