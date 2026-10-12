// The words that rows carry: statuses, roles, states, kinds. English codes, which are what the
// database stores and what the API and the model's tools speak; the Polish labels are in
// src/web/messages.ts. Each list is the one place in code that spells its words.
//
// Three classes, as the database treats them:
//   - vocabularies and life-cycle states have a table each, and a row for every word. A word is
//     added by a migration and here, in the order of the table;
//   - structural words are lists that the tables' own rules are built on;
//   - labels are checked by the database for their shape only. The lists here are what the code
//     writes, and a package that needs a new label adds it here. For a label the list is the only
//     spelling: the database holds no second one to compare it with, so nothing notices a label
//     that is misspelt here.

// Vocabularies: a table each, in the order in which the interface offers the words.

/** item_statuses. */
export const ITEM_STATUSES = ["todo", "in_progress", "blocked", "done", "cancelled"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
/** The statuses whose row has is_closed set: an item with one of them is not active. */
export const CLOSED_ITEM_STATUSES = ["done", "cancelled"] as const satisfies readonly ItemStatus[];
export type ClosedItemStatus = (typeof CLOSED_ITEM_STATUSES)[number];

/** item_healths: the health of an item, a project or a task. */
export const ITEM_HEALTHS = ["green", "yellow", "red"] as const;
export type ItemHealth = (typeof ITEM_HEALTHS)[number];

/** item_importances. */
export const ITEM_IMPORTANCES = ["high", "normal", "low"] as const;
export type ItemImportance = (typeof ITEM_IMPORTANCES)[number];
/**
 * The importance of a new item: the ordinary one, the row whose weight is 0. No column of the
 * database has a default, so whatever inserts an item writes this.
 */
export const DEFAULT_ITEM_IMPORTANCE: ItemImportance = "normal";

/** my_roles. */
export const MY_ROLES = ["doing", "delegating", "waiting", "watching"] as const;
export type MyRole = (typeof MY_ROLES)[number];

/** item_person_roles. */
export const ITEM_PERSON_ROLES = ["owner", "requester", "stakeholder", "executor", "informed"] as const;
export type ItemPersonRole = (typeof ITEM_PERSON_ROLES)[number];

/** fact_types. */
export const FACT_TYPES = ["decision", "requirement", "risk", "info", "question"] as const;
export type FactType = (typeof FACT_TYPES)[number];

/** person_relations. */
export const PERSON_RELATIONS = ["report", "manager", "peer", "stakeholder", "external"] as const;
export type PersonRelation = (typeof PERSON_RELATIONS)[number];

// Life-cycle states: a table each.

/** operation_states. */
export const OPERATION_STATES = ["staged", "proposed", "invalid", "applied", "rejected", "undone"] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

/** run_states. */
export const RUN_STATES = ["running", "committed", "failed"] as const;
export type RunState = (typeof RUN_STATES)[number];

/** job_states. */
export const JOB_STATES = ["queued", "running", "done", "failed"] as const;
export type JobState = (typeof JOB_STATES)[number];

// Structural words: the lists of two CHECK constraints.

/** items.kind. A task under a task is a task: "podzadanie" is a word of the interface, not a kind. */
export const ITEM_KINDS = ["project", "task"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** operation_effects.change. */
export const EFFECT_CHANGES = ["create", "update", "delete", "touch"] as const;
export type EffectChange = (typeof EFFECT_CHANGES)[number];

// Labels: lower-case identifiers to the database.

/** sources.kind. */
export const SOURCE_KINDS = ["capture"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** capture_parts.kind. */
export const PART_KINDS = ["typed", "pasted", "image", "file"] as const;
export type PartKind = (typeof PART_KINDS)[number];

/** capture_part_texts.origin. */
export const PART_TEXT_ORIGINS = ["transcription", "extraction", "correction"] as const;
export type PartTextOrigin = (typeof PART_TEXT_ORIGINS)[number];

/**
 * items.start_on_precision and items.due_on_precision: how exactly a day of the schedule is known.
 * No label means known to the day. "approximate" is about that day. A named period says that the
 * day is a boundary of that period: its first day for a start, its last day for a due day.
 */
export const DATE_PRECISIONS = ["approximate", "week", "month", "quarter", "half", "year"] as const;
export type DatePrecision = (typeof DATE_PRECISIONS)[number];
/** The precisions that name a period. */
export const NAMED_PERIODS = ["week", "month", "quarter", "half", "year"] as const satisfies readonly DatePrecision[];
export type NamedPeriod = (typeof NAMED_PERIODS)[number];

/** operations.kind: the operations the agent and the owner can ask for, and the one the framework adds to take others back. */
export const OPERATION_KINDS = [
  "create_item",
  "update_item",
  "link_source",
  "add_fact",
  "supersede_fact",
  "set_item_person",
  "create_person",
  "update_person",
  "resolve_mention",
  "merge_items",
  "merge_people",
  "ask_user",
  "undo",
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/** operations.origin. */
export const OPERATION_ORIGINS = ["command", "inference", "user"] as const;
export type OperationOrigin = (typeof OPERATION_ORIGINS)[number];

/** operations.approval. */
export const APPROVALS = ["command", "auto", "accepted", "manual"] as const;
export type Approval = (typeof APPROVALS)[number];

/** operations.confidence. */
export const CONFIDENCES = ["high", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/** operation_effects.entity_kind: the tables that operations change, in the singular. */
export const ENTITY_KINDS = [
  "item",
  "item_description",
  "item_alias",
  "item_person",
  "person",
  "person_alias",
  "mention",
  "fact",
  "fact_person",
  "source_link",
  "capture",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** queue_jobs.kind. */
export const JOB_KINDS = ["process_capture", "summarize_item"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** runs.kind. */
export const RUN_KINDS = ["process_capture"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/** model_calls.role: the roles a workspace gives its models. */
export const MODEL_ROLES = ["processing", "conversation", "synthesis"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** model_calls.purpose. */
export const MODEL_PURPOSES = ["agent_turn", "transcription", "summary"] as const;
export type ModelPurpose = (typeof MODEL_PURPOSES)[number];
