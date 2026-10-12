// The synthetic world: who exists, what happens on each day, what the agent and the owner make
// of it. It speaks the words of the requirements (item, person, capture, run, operation, fact,
// mention) and hands plain objects to a Sink. It knows no table and no column: writer.ts does.
//
// Everything is a function of the scale, the seed and "now". The days count back from "now", so
// the newest capture is always minutes old and "due today" always has members, whatever day the
// generator runs on.
//
// The world lives through its history in the order of the clock. What is applied later is written
// later: every change is judged by the database against the rows as they stood at that moment,
// which is how the application will meet its guards.
import { foldName } from "../../../shared/fold.ts";
import {
  type CaptureId,
  type CapturePartId,
  type CapturePartTextId,
  type FactId,
  type FactPersonId,
  ID_PREFIXES,
  type Id,
  type IdKind,
  type ItemAliasId,
  type ItemDescriptionId,
  type ItemId,
  type ItemPersonId,
  type JobId,
  type MentionId,
  type OperationId,
  type PersonAliasId,
  type PersonId,
  type RunId,
  type SourceLinkId,
} from "../../../shared/ids.ts";
import { addDays, type Day, periodEnd, periodStart } from "../../../shared/time.ts";
import {
  type Approval,
  type Confidence,
  type DatePrecision,
  DEFAULT_ITEM_IMPORTANCE,
  type EffectChange,
  FACT_TYPES,
  type FactType,
  ITEM_HEALTHS,
  ITEM_IMPORTANCES,
  type ItemHealth,
  type ItemImportance,
  type ItemKind,
  type ItemPersonRole,
  type ItemStatus,
  type JobKind,
  type JobState,
  type ModelPurpose,
  type ModelRole,
  type MyRole,
  NAMED_PERIODS,
  type NamedPeriod,
  type OperationKind,
  type OperationOrigin,
  type OperationState,
  type PartKind,
  type PartTextOrigin,
  type PersonRelation,
  type RunKind,
  type RunState,
} from "../../../shared/vocabulary.ts";
import {
  CALL_ERRORS,
  CODENAMES,
  DESCRIPTIVE_PROJECTS,
  DUE_EN,
  DUE_PL,
  EXPECTATIONS,
  FILLERS,
  GIVEN_NAMES,
  type GivenName,
  JOB_TITLES,
  MILESTONES,
  MODELS,
  NOTE_DAYS,
  NOTE_HEADERS,
  NOTE_PROSE,
  PERSON_NOTES,
  PROJECT_SUFFIXES,
  RATIONALES,
  REMARKS,
  RUN_ERRORS,
  SENTENCES,
  type Sentence,
  type Signal,
  STATEMENTS,
  SUMMARY_SENTENCES,
  SURNAMES_EN,
  SURNAMES_PL,
  TASK_VERBS_EN,
  TASK_VERBS_PL,
  TEAMS,
  type Team,
  THINGS_EN,
  THINGS_PL,
  TITLE_MARKS,
} from "./banks.ts";
import { createStreams, type Rng } from "./rng.ts";
import type { Channels, Scale, TreeShape } from "./scale.ts";

// ---------------------------------------------------------------------------------------------------
// What the world hands over. Instants are milliseconds, days are days, flags are booleans, and what
// the database keeps as JSON is the value itself: how each of them is stored is the writer's matter.
// ---------------------------------------------------------------------------------------------------

export interface PersonFields {
  id: PersonId;
  name: string;
  jobTitle: string | null;
  team: string | null;
  relation: PersonRelation | null;
  isMe: boolean;
  mergedIntoId: PersonId | null;
  createdAt: number;
  note: string | null;
}
export interface PersonAliasFields {
  id: PersonAliasId;
  personId: PersonId;
  alias: string;
  context: string;
  createdAt: number;
}
export interface ItemFields {
  id: ItemId;
  kind: ItemKind;
  parentId: ItemId | null;
  title: string;
  status: ItemStatus;
  importance: ItemImportance;
  health: ItemHealth | null;
  myRole: MyRole | null;
  myRoleSetOn: Day | null;
  startOn: Day | null;
  startOnPrecision: DatePrecision | null;
  dueOn: Day | null;
  dueOnPrecision: DatePrecision | null;
  isMilestone: boolean;
  externalSystem: string | null;
  externalKey: string | null;
  externalUrl: string | null;
  mergedIntoId: ItemId | null;
  createdAt: number;
  closedAt: number | null;
}
export interface ItemDescriptionFields {
  id: ItemDescriptionId;
  itemId: ItemId;
  updatedAt: number;
  /** The document of the editor. */
  body: object;
}
export interface ItemAliasFields {
  id: ItemAliasId;
  itemId: ItemId;
  alias: string;
  createdAt: number;
}
export interface ItemPersonFields {
  id: ItemPersonId;
  itemId: ItemId;
  personId: PersonId;
  role: ItemPersonRole;
  createdAt: number;
  expectations: string | null;
}
export interface MentionFields {
  id: MentionId;
  sourceId: CaptureId;
  personId: PersonId | null;
  skippedAt: number | null;
  createdAt: number;
  surface: string;
  baseForm: string | null;
}
export interface FactFields {
  id: FactId;
  itemId: ItemId;
  type: FactType;
  occurredOn: Day;
  occurredOnApproximate: boolean;
  sourceId: CaptureId;
  outdatedAt: number | null;
  supersededByFactId: FactId | null;
  createdAt: number;
  quote: string;
  text: string;
}
export interface FactPersonFields {
  id: FactPersonId;
  factId: FactId;
  personId: PersonId;
}
export interface SourceLinkFields {
  id: SourceLinkId;
  sourceId: CaptureId;
  itemId: ItemId;
  createdAt: number;
}

/** The rows that only operations change, by the kind of entity that an effect names. */
export interface Ledgered {
  item: ItemFields;
  item_description: ItemDescriptionFields;
  item_alias: ItemAliasFields;
  item_person: ItemPersonFields;
  person: PersonFields;
  person_alias: PersonAliasFields;
  mention: MentionFields;
  fact: FactFields;
  fact_person: FactPersonFields;
  source_link: SourceLinkFields;
}
export type LedgeredKind = keyof Ledgered;

/** What an applied operation did to one row. */
export type Change = {
  [K in LedgeredKind]: {
    kind: K;
    change: EffectChange;
    /** The row as it is after the change; for a delete, as it was. */
    row: Ledgered[K];
    /** For an update: the fields that changed, with the values they had. */
    was?: Partial<Ledgered[K]>;
    /** The item and the person the change is about: where a timeline shows it. */
    item: ItemId | null;
    person: PersonId | null;
  };
}[LedgeredKind];

export interface WorldFile {
  sha256: string;
  byteSize: number;
  mediaType: string;
  createdAt: number;
}
export interface WorldPart {
  id: CapturePartId;
  position: number;
  kind: PartKind;
  text: string | null;
  file: WorldFile | null;
  fileName: string | null;
}
export interface WorldCapture {
  id: CaptureId;
  createdAt: number;
  /** The event date as it is saved: the day of adding, marked approximate until the material says otherwise. */
  occurredOn: Day;
  occurredOnApproximate: boolean;
  parts: WorldPart[];
}
export interface WorldPartText {
  id: CapturePartTextId;
  partId: CapturePartId;
  revision: number;
  origin: PartTextOrigin;
  /** The number of the model call that wrote a transcription. */
  modelCallId: number | null;
  createdAt: number;
  structure: object | null;
  text: string;
}
export interface WorldJob {
  id: JobId;
  kind: JobKind;
  state: JobState;
  sourceId: CaptureId | null;
  dedupeKey: string | null;
  attempts: number;
  maxAttempts: number;
  runAfter: number;
  leasedUntil: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  payload: object;
}
export interface WorldRun {
  id: RunId;
  kind: RunKind;
  state: RunState;
  sourceId: CaptureId | null;
  jobId: JobId | null;
  model: string;
  promptVersion: string;
  startedAt: number;
  endedAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  summary: string | null;
}
export interface WorldModelCall {
  /** Counted by the world from 1: the generator fills an empty database. */
  id: number;
  runId: RunId | null;
  jobId: JobId | null;
  role: ModelRole;
  purpose: ModelPurpose;
  model: string;
  promptVersion: string | null;
  startedAt: number;
  durationMs: number;
  firstTokenMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  httpStatus: number | null;
  stopReason: string | null;
  requestId: string | null;
  errorType: string | null;
  errorMessage: string | null;
  detail: object | null;
}
export interface WorldOperation {
  id: OperationId;
  /** The run that staged it; null for what the owner did by hand, and for an undo. */
  runId: RunId | null;
  seq: number | null;
  kind: OperationKind;
  origin: OperationOrigin;
  state: OperationState;
  confidence: Confidence | null;
  approval: Approval | null;
  sourceId: CaptureId | null;
  undoneById: OperationId | null;
  createdAt: number;
  decidedAt: number | null;
  appliedAt: number | null;
  quote: string | null;
  commandQuote: string | null;
  rationale: string | null;
  answer: object | null;
  annotations: object | null;
  problems: object | null;
  proposedPayload: object | null;
  payload: object;
}

/**
 * Where the world goes. Everything arrives in an order in which the guards of the schema let it
 * be written: what a row refers to is there before the row, an operation is applied before its
 * changes, and what depends on another operation moves after it.
 */
export interface Sink {
  /** The original of a dropped file. The same content can arrive twice. */
  file(file: WorldFile): void;
  /** An input as the owner dropped it: its registry row, the capture and its parts. */
  capture(capture: WorldCapture): void;
  /** A revision of the text derived from a part. */
  partText(text: WorldPartText): void;
  /** A new job of the queue. */
  job(job: WorldJob): void;
  /** The job has moved on: claimed, put back, finished. */
  jobChanged(job: WorldJob): void;
  /** A run that has just started. */
  run(run: WorldRun): void;
  /** The run has ended: committed or failed. A run that fails takes what it staged along. */
  runEnded(run: WorldRun): void;
  modelCall(call: WorldModelCall): void;
  /** A new operation: staged by its run, with what it can only follow, or applied by hand. */
  operation(operation: WorldOperation, needs: readonly WorldOperation[]): void;
  /** The operation has moved on to the state it has now. */
  operationMoved(operation: WorldOperation): void;
  /** What an applied operation did, row by row, in the order it did it. */
  changes(operation: WorldOperation, changes: readonly Change[]): void;
}

export interface WorldOptions {
  scale: Scale;
  seed: number;
  /** The instant the history ends at. */
  now: number;
}

export interface WorldSummary {
  /** The owner. */
  me: PersonId;
  /** The project that every eighth link goes to: the one with the longest history. */
  busiestItem: ItemId;
  /** The newest capture whose card still has something to decide. */
  openCardSource: CaptureId | undefined;
}

export interface World {
  /** Lives through one day of the history. Days are numbered from 0 and are lived in order. */
  day(index: number): void;
  /** Leaves what is under way at "now" as it stands, and says what a test can address by its role. */
  finish(): WorldSummary;
}

// ---------------------------------------------------------------------------------------------------
// The world's own bookkeeping.
// ---------------------------------------------------------------------------------------------------

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY_MS = 24 * HOUR;
/** The characters of an id, as the application draws them. */
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
/** How long a worker may hold a job before it counts as gone. */
const LEASE = 10 * MINUTE;
const MAX_ATTEMPTS = 5;

interface WorldPerson {
  fields: PersonFields;
  given: GivenName;
  team: Team;
  /** The short form of the given name, or the name itself. */
  short: string;
  aliases: PersonAliasFields[];
  /** The rows that name this person, kept for one that is a duplicate and will be merged. */
  rows?: { mentions: MentionFields[]; roles: ItemPersonFields[]; facts: { row: FactPersonFields; fact: WorldFact }[] };
}

/** The tasks that will come to sit under an item, with the tasks under each of them. */
interface Plan {
  children: Plan[];
}

interface WorldItem {
  fields: ItemFields;
  parent: WorldItem | null;
  children: WorldItem[];
  team: Team;
  /** How texts speak of it: its title, then its aliases. */
  names: string[];
  people: Map<PersonId, ItemPersonFields>;
  aliases: ItemAliasFields[];
  description: ItemDescriptionFields | null;
  /** The newest fact that is still in force. */
  recentFact: WorldFact | null;
  /** When the owner means to close it; undefined for an item that stays open. */
  closeAt: number | undefined;
  /** The operation that last changed each group of fields that are tied together. */
  lastChange: Map<string, OperationId>;
  /** Left alone by everything that is drawn at random: an item that is here to show a shape. */
  pinned: boolean;
  /** Its creation was undone. */
  gone: boolean;
  /** Its links and facts, kept for an item that is a duplicate or has one. */
  rows?: { links: SourceLinkFields[]; facts: WorldFact[] };
  /** How many rows hang on it besides its own: what stands in the way of undoing its creation. */
  uses: number;
}

interface WorldFact {
  fields: FactFields;
  persons: FactPersonFields[];
  item: WorldItem;
  /** It replaced an older fact, which names it. */
  successor: boolean;
  gone: boolean;
}

/** One thing that changes the data: what an operation does when it is applied. */
interface Intent {
  kind: OperationKind;
  payload: Record<string, unknown>;
  /** The sentence that states it in a text, and what the sentence speaks of. */
  signal: Signal;
  subject: string;
  team: Team;
  /** The item a text about it concerns, when there is one. */
  about: WorldItem | null;
  /** The words of a command that asks for it. */
  command: string;
  /** For a person nobody has heard of: the name that the text gives. */
  newName?: string;
  /**
   * Writes it into the world as of the given instant and says what changed. Undefined when it can
   * no longer be done: its item is gone, or is not what it was when this was planned.
   */
  apply(at: number, operation: WorldOperation): Change[] | undefined;
  /** Takes it back, once it was applied. Undefined when it cannot be taken back alone any more. */
  undo?: (at: number) => Change[] | undefined;
  /** What can only follow it: applied after it, rejected with it. */
  followers: Intent[];
}

/** What becomes of an operation once its run has committed. */
type Fate =
  /** Applied at once. */
  | "auto"
  /** Goes to the Inbox and is accepted there. */
  | "accept"
  /** Goes to the Inbox and is rejected there. */
  | "reject"
  /** Goes to the Inbox and is left there: nobody comes back to it. */
  | "wait"
  /** Fails the checks for good. */
  | "invalid";

interface Staged extends WorldOperation {
  intent: Intent;
  fate: Fate;
  needs: Staged[];
  dependants: Staged[];
}

/** A capture with everything that its processing will bring. */
interface Script {
  capture: WorldCapture;
  files: WorldFile[];
  /** The text derived from the part that is no text itself. */
  derived: { part: WorldPart; origin: PartTextOrigin; text: string } | undefined;
  job: WorldJob;
  /** What the agent stages, in its order. */
  steps: Step[];
  /** The planned changes that this material brings, which are among the steps. */
  planned: Intent[];
  summary: string;
  /** How the first attempt at it ends. */
  attempt: "ok" | "interrupted" | "failed";
  /** Where "now" finds it: done, still waiting, being processed, or waiting for its second attempt. */
  tail: "none" | "queued" | "processing" | "retry";
  /** Its card is never decided. */
  forgotten: boolean;
  /** What failed the checks is left on its card as it is. */
  keepsInvalid: boolean;
  reprocessed: boolean;
  corrected: boolean;
  r: Rng;
  /** When its job is claimed, when its run starts and when the run ends. */
  claimedAt: number;
  runAt: number;
  endAt: number;
  model: string;
  promptVersion: string;
  /** Set once it was processed. */
  staged: Staged[];
}

interface Step {
  intent: Intent;
  origin: OperationOrigin;
  confidence: Confidence | null;
  quote: string | null;
  commandQuote: string | null;
  fate: Fate;
  /** The steps it can only follow, by their place in the list. */
  needs: Step[];
  annotations: object | null;
}

/** A change that is planned for a day, and the ways in which it can come about. */
interface Planned {
  /** The intent as of that day; undefined when it is no longer wanted. */
  make: () => Intent | undefined;
  channels: Channels;
  r: Rng;
}

interface Named {
  person: WorldPerson;
  surface: string;
  base: string;
}

const NO_CHANNEL: Channels = { hand: 1, command: 0, agent: 0 };
const SLOT = /\{(item|pn|pg|pd|pi|thing|due|team|key|new)\}/g;

/** What an operation did to one row. `item` and `person` say what the change is about; `was` holds, for an update, what the changed fields held. */
function change<Kind extends LedgeredKind>(
  kind: Kind,
  how: EffectChange,
  row: Ledgered[Kind],
  item: ItemId | null,
  person: PersonId | null,
  was?: Partial<Ledgered[Kind]>,
): Change {
  return { kind, change: how, row, item, person, ...(was === undefined ? {} : { was }) } as Change;
}

/** Ranks drawn so that a few are busy and the rest form a long tail. `flat` takes weight off the very top. */
function skewedIndex(r: Rng, length: number, flat: number): number {
  if (length <= 1) return 0;
  const at = Math.floor(flat * ((length + flat) / flat) ** r.next()) - flat;
  return Math.min(length - 1, Math.max(0, at));
}

export function createWorld({ scale, seed, now }: WorldOptions, sink: Sink): World {
  const streams = createStreams(seed);
  const dayOf = (instant: number): Day => new Date(instant).toISOString().slice(0, 10) as Day;
  const today = dayOf(now);
  /** Midnight of the first day of the history. */
  const start = Date.parse(`${addDays(today, 1 - scale.days)}T00:00:00.000Z`);
  const dayIndex = (instant: number): number => Math.floor((instant - start) / DAY_MS);

  // ---- identifiers: the application assigns them, so the world does as well ----
  const idStreams = new Map<string, Rng>();
  /** `series` names a row of identifiers of its own, for what is made beside the rest: the others stay what they are. */
  function newId<K extends IdKind>(kind: K, series = ""): Id<K> {
    const label = `id of ${kind}${series}`;
    let r = idStreams.get(label);
    if (r === undefined) {
      r = streams.stream(label);
      idStreams.set(label, r);
    }
    // Three words of 32 bits give the sixty of an id: four characters of five bits from each.
    let random = "";
    for (let word = 0; word < 3; word++) {
      const bits = r.u32();
      for (let i = 0; i < 4; i++) random += ID_ALPHABET.charAt((bits >>> (i * 5)) & 31);
    }
    return `${ID_PREFIXES[kind]}_${random}`;
  }

  // ---- the clock ----
  // Events wait in a heap, in the order of their instants and, within one instant, of their making.
  const events: { at: number; order: number; run: () => void }[] = [];
  let eventsMade = 0;
  function at(instant: number, run: () => void): void {
    const event = { at: instant, order: eventsMade++, run };
    let child = events.push(event) - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      const above = events[parent] as (typeof events)[number];
      if (above.at < event.at || (above.at === event.at && above.order < event.order)) break;
      events[child] = above;
      child = parent;
    }
    events[child] = event;
  }
  function nextEvent(): (typeof events)[number] | undefined {
    const first = events[0];
    const last = events.pop();
    if (first === undefined || last === undefined || events.length === 0) return first;
    let parent = 0;
    for (;;) {
      let child = 2 * parent + 1;
      if (child >= events.length) break;
      const right = events[child + 1];
      const left = events[child] as (typeof events)[number];
      let smaller = left;
      if (right !== undefined && (right.at < left.at || (right.at === left.at && right.order < left.order))) {
        smaller = right;
        child += 1;
      }
      if (last.at < smaller.at || (last.at === smaller.at && last.order < smaller.order)) break;
      events[parent] = smaller;
      parent = child;
    }
    events[parent] = last;
    return first;
  }
  // The instant at which something is applied never repeats and never steps back: the order in
  // which changes are written is then the order of their instants, for every item.
  let lastStamp = 0;
  const stamp = (instant: number): number => {
    lastStamp = Math.max(lastStamp + 1, instant);
    return lastStamp;
  };

  // ---- what is planned for a day ----
  const planned = new Map<number, Planned[]>();
  function plan(day: number, entry: Planned): void {
    if (day >= scale.days) return;
    const list = planned.get(day);
    if (list === undefined) planned.set(day, [entry]);
    else list.push(entry);
  }
  function channelOf(r: Rng, channels: Channels): keyof Channels {
    return (
      (["hand", "command", "agent"] as const)[r.weighted([channels.hand, channels.command, channels.agent])] ?? "hand"
    );
  }

  // ---- operations ----
  function operation(
    kind: OperationKind,
    origin: OperationOrigin,
    createdAt: number,
    payload: object,
    id: OperationId = newId("operation"),
  ): WorldOperation {
    return {
      id,
      runId: null,
      seq: null,
      kind,
      origin,
      state: "applied",
      confidence: null,
      approval: null,
      sourceId: null,
      undoneById: null,
      createdAt,
      decidedAt: null,
      appliedAt: null,
      quote: null,
      commandQuote: null,
      rationale: null,
      answer: null,
      annotations: null,
      problems: null,
      proposedPayload: null,
      payload,
    };
  }
  /** What the owner does in the interface: an operation without a run, applied by the statement that inserts it. */
  function byHand(intent: Intent, instant: number): WorldOperation | undefined {
    const appliedAt = stamp(instant);
    const made = operation(intent.kind, "user", appliedAt, intent.payload);
    const changes = intent.apply(appliedAt, made);
    if (changes === undefined) return undefined;
    made.approval = "manual";
    made.appliedAt = appliedAt;
    sink.operation(made, []);
    sink.changes(made, changes);
    for (const next of intent.followers) byHand(next, appliedAt);
    return made;
  }
  /** Applies a staged or proposed operation, or says that it can no longer be applied. */
  function apply(staged: Staged, instant: number, approval: Approval): boolean {
    const appliedAt = stamp(instant);
    const changes = staged.intent.apply(appliedAt, staged);
    if (changes === undefined) return false;
    // Only an operation that waited in the Inbox was decided by the owner.
    if (staged.state !== "staged") staged.decidedAt = appliedAt;
    staged.state = "applied";
    staged.approval = approval;
    staged.appliedAt = appliedAt;
    sink.operationMoved(staged);
    sink.changes(staged, changes);
    return true;
  }
  function reject(staged: Staged, instant: number): void {
    // What depends on it goes first: the database asks for that order.
    for (const dependant of staged.dependants) {
      if (dependant.state === "proposed" || dependant.state === "invalid") reject(dependant, instant);
    }
    staged.state = "rejected";
    staged.decidedAt = stamp(instant);
    sink.operationMoved(staged);
  }
  /**
   * Takes an applied operation back, when that can still be done. What followed it goes with it,
   * by the same undo: the intent of the first one takes back the rows of the whole chain.
   */
  function undo(applied: WorldOperation, intent: Intent, instant: number, withFollowers = false): void {
    if (applied.state !== "applied" || intent.undo === undefined) return;
    const followers = ((applied as Partial<Staged>).dependants ?? []).filter(
      ({ state }) => state !== "rejected" && state !== "undone",
    );
    // What depends on it stands in the way: a proposal that still waits, and an applied operation
    // that this undo does not take along.
    if (followers.some(({ state }) => state !== "applied") || (followers.length > 0 && !withFollowers)) return;
    const undoneAt = stamp(instant);
    const changes = intent.undo(undoneAt);
    if (changes === undefined) return;
    // What depends on it is marked first: the database asks for that order.
    const chain = [...followers, applied];
    const made = operation("undo", "user", undoneAt, { operations: chain.map(({ id }) => id) });
    made.approval = "manual";
    made.appliedAt = undoneAt;
    sink.operation(made, []);
    sink.changes(made, changes);
    for (const member of chain) {
      member.state = "undone";
      member.undoneById = made.id;
      sink.operationMoved(member);
    }
  }

  // ---- persons ----
  const persons: WorldPerson[] = [];
  const usedNames = new Set<string>();
  /** How many persons answer to a short name. */
  const sameShort = new Map<string, number>();
  let me: WorldPerson | undefined;
  const pickPerson = (r: Rng): WorldPerson => persons[skewedIndex(r, persons.length, 2)] as WorldPerson;
  /** The person as it is now: the one it was merged into, for one that was merged. */
  const standing = new Map<PersonId, WorldPerson>();
  const personNow = (person: WorldPerson): WorldPerson => standing.get(person.fields.id) ?? person;

  interface PersonSpec {
    given: GivenName;
    name: string;
    team: Team;
    jobTitle: string;
    relation: PersonRelation | null;
    isMe: boolean;
    aliases: { alias: string; context: string }[];
    /** The person this one is a second entry of. */
    duplicateOf?: WorldPerson;
  }
  function drawPerson(index: number): PersonSpec {
    const r = streams.stream("person", index);
    let given: GivenName;
    let surname: string;
    let name: string;
    do {
      given = r.pick(GIVEN_NAMES);
      if (given.lang === "pl") {
        const both = r.pick(SURNAMES_PL);
        surname = typeof both === "string" ? both : given.feminine ? both[1] : both[0];
      } else surname = r.pick(SURNAMES_EN);
      name = `${given.forms[0]} ${surname}`;
    } while (usedNames.has(name));
    usedNames.add(name);
    const team = r.pick(TEAMS);
    const isMe = index === 0;
    const relation: PersonRelation | null = isMe
      ? null
      : index <= 8
        ? "report"
        : index <= 10
          ? "manager"
          : index <= 45
            ? "peer"
            : r.chance(0.6)
              ? "stakeholder"
              : "external";
    const plain = (text: string) => foldName(text).replace(/[^a-z]/g, "");
    const aliases = [{ alias: `@${plain(given.forms[0]).charAt(0)}${plain(surname)}`, context: "" }];
    if (r.chance(0.7)) aliases.push({ alias: `${plain(given.forms[0])}.${plain(surname)}@firma.example`, context: "" });
    if (given.short !== undefined) aliases.push({ alias: given.short[0], context: "" });
    if (r.chance(0.15))
      aliases.push({ alias: `${given.short?.[0] ?? given.forms[0]} z ${team.name}`, context: team.name });
    // The owner is the manager whose hub this is.
    return {
      given,
      name,
      team,
      jobTitle: isMe ? (JOB_TITLES[0] as string) : r.pick(JOB_TITLES),
      relation,
      isMe,
      aliases,
    };
  }
  /** A new person of the directory, with the names it answers to. */
  function createPerson(spec: PersonSpec): Intent {
    const id = newId("person");
    return {
      kind: "create_person",
      payload: {
        person_id: id,
        name: spec.name,
        team: spec.team.name,
        job_title: spec.jobTitle,
        relation: spec.relation,
      },
      signal: "person",
      subject: spec.name,
      team: spec.team,
      about: null,
      command: `dodaj osobę: ${spec.name}`,
      newName: spec.name,
      followers: [],
      apply(createdAt) {
        const fields: PersonFields = {
          id,
          name: spec.name,
          jobTitle: spec.jobTitle,
          team: spec.team.name,
          relation: spec.relation,
          isMe: spec.isMe,
          mergedIntoId: null,
          createdAt,
          note: null,
        };
        const person: WorldPerson = {
          fields,
          given: spec.given,
          team: spec.team,
          short: spec.given.short?.[0] ?? spec.given.forms[0],
          aliases: [],
        };
        const changes: Change[] = [change("person", "create", fields, null, id)];
        const seen = new Set<string>();
        for (const { alias, context } of spec.aliases) {
          // Two spellings that fold alike are one alias to the database.
          const key = `${foldName(alias)}\u0000${context}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const row: PersonAliasFields = { id: newId("personAlias"), personId: id, alias, context, createdAt };
          person.aliases.push(row);
          changes.push(change("person_alias", "create", row, null, id));
        }
        if (spec.isMe) me = person;
        if (spec.duplicateOf === undefined) {
          persons.push(person);
          sameShort.set(person.short, (sameShort.get(person.short) ?? 0) + 1);
        } else {
          // A duplicate is named by the one capture that brought it, and by nothing drawn at random.
          person.rows = { mentions: [], roles: [], facts: [] };
        }
        created.set(id, person);
        return changes;
      },
    };
  }
  /** The persons that an intent has made, by the id that the intent gave them. */
  const created = new Map<PersonId, WorldPerson>();

  /** One more name for a person, in a context or everywhere. */
  function addPersonAlias(person: WorldPerson, alias: string, context: string): Intent {
    return {
      kind: "update_person",
      payload: { person_id: person.fields.id, add_alias: alias, context },
      signal: "fact",
      subject: person.fields.name,
      team: person.team,
      about: null,
      command: "",
      followers: [],
      apply(createdAt) {
        const target = personNow(person);
        const key = `${foldName(alias)}\u0000${context}`;
        if (target.aliases.some((row) => `${foldName(row.alias)}\u0000${row.context}` === key)) return undefined;
        const row: PersonAliasFields = {
          id: newId("personAlias"),
          personId: target.fields.id,
          alias,
          context,
          createdAt,
        };
        target.aliases.push(row);
        return [change("person_alias", "create", row, null, target.fields.id)];
      },
    };
  }
  /** What the person does or where: an attribute that the owner corrects. */
  function changePerson(person: WorldPerson, r: Rng): Intent {
    const set: Partial<PersonFields> = r.chance(0.5)
      ? { jobTitle: r.pick(JOB_TITLES) }
      : { note: r.pick(PERSON_NOTES) };
    return {
      kind: "update_person",
      payload: { person_id: person.fields.id, set },
      signal: "fact",
      subject: person.fields.name,
      team: person.team,
      about: null,
      command: "",
      followers: [],
      apply() {
        const target = personNow(person);
        const was: Partial<PersonFields> = {};
        for (const field of Object.keys(set) as (keyof PersonFields)[]) {
          if (target.fields[field] !== set[field]) Object.assign(was, { [field]: target.fields[field] });
        }
        if (Object.keys(was).length === 0) return undefined;
        Object.assign(target.fields, set);
        return [change("person", "update", target.fields, null, target.fields.id, was)];
      },
    };
  }
  /** Two entries of one person become one: the rows of the duplicate move, and the duplicate is marked last. */
  function mergePeople(duplicate: WorldPerson, into: WorldPerson): Intent {
    return {
      kind: "merge_people",
      payload: { person_id: duplicate.fields.id, into_person_id: into.fields.id },
      signal: "fact",
      subject: duplicate.fields.name,
      team: into.team,
      about: null,
      command: "",
      followers: [],
      apply(mergedAt) {
        const survivor = personNow(into);
        if (duplicate.fields.mergedIntoId !== null || survivor === duplicate || duplicate.rows === undefined) {
          return undefined;
        }
        const changes: Change[] = [];
        const to = survivor.fields.id;
        for (const mention of duplicate.rows.mentions) {
          if (mention.personId !== duplicate.fields.id) continue;
          mention.personId = to;
          changes.push(change("mention", "update", mention, null, to, { personId: duplicate.fields.id }));
        }
        for (const role of duplicate.rows.roles) {
          const item = items.get(role.itemId);
          if (item === undefined || item.gone || item.people.get(duplicate.fields.id) !== role) continue;
          item.people.delete(duplicate.fields.id);
          if (item.people.has(to)) {
            // The survivor has a role in the item already, and a person has one role in an item.
            item.uses--;
            changes.push(change("item_person", "delete", role, role.itemId, to));
          } else {
            role.personId = to;
            item.people.set(to, role);
            changes.push(change("item_person", "update", role, role.itemId, to, { personId: duplicate.fields.id }));
          }
        }
        for (const { row, fact } of duplicate.rows.facts) {
          if (fact.gone || row.personId !== duplicate.fields.id) continue;
          if (fact.persons.some((other) => other.personId === to)) {
            // The fact names the survivor already.
            drop(fact.persons, row);
            changes.push(change("fact_person", "delete", row, fact.fields.itemId, to));
            continue;
          }
          row.personId = to;
          changes.push(change("fact_person", "update", row, fact.fields.itemId, to, { personId: duplicate.fields.id }));
        }
        const taken = new Set(survivor.aliases.map((row) => `${foldName(row.alias)}\u0000${row.context}`));
        for (const alias of duplicate.aliases) {
          const key = `${foldName(alias.alias)}\u0000${alias.context}`;
          if (taken.has(key)) {
            changes.push(change("person_alias", "delete", alias, null, to));
            continue;
          }
          taken.add(key);
          alias.personId = to;
          survivor.aliases.push(alias);
          changes.push(change("person_alias", "update", alias, null, to, { personId: duplicate.fields.id }));
        }
        duplicate.aliases = [];
        // The spelling that was entered twice stays known: it is an alias of the survivor from now on.
        if (!taken.has(`${foldName(duplicate.fields.name)}\u0000`)) {
          const row: PersonAliasFields = {
            id: newId("personAlias"),
            personId: to,
            alias: duplicate.fields.name,
            context: "",
            createdAt: mergedAt,
          };
          survivor.aliases.push(row);
          changes.push(change("person_alias", "create", row, null, to));
        }
        duplicate.fields.mergedIntoId = to;
        standing.set(duplicate.fields.id, survivor);
        changes.push(change("person", "update", duplicate.fields, null, duplicate.fields.id, { mergedIntoId: null }));
        return changes;
      },
    };
  }

  // ---- items ----
  const items = new Map<ItemId, WorldItem>();
  /** The projects that are open, the busiest first, and the tasks that are open, the newest last. */
  const openProjects: WorldItem[] = [];
  const openTasks: WorldItem[] = [];
  const usedProjectNames = new Set<string>();
  const changedToday = new Set<WorldItem>();
  let projectCount = 0;
  let closesPlanned = 0;
  let outlier: WorldItem | undefined;

  const isOpen = (item: WorldItem): boolean =>
    !item.gone && item.fields.closedAt === null && item.fields.mergedIntoId === null;
  /** The item as it is now: the one it was merged into, for one that was merged; undefined for one that is gone. */
  function itemNow(item: WorldItem): WorldItem | undefined {
    let current = item;
    while (current.fields.mergedIntoId !== null) {
      const next = items.get(current.fields.mergedIntoId);
      if (next === undefined) return undefined;
      current = next;
    }
    return current.gone ? undefined : current;
  }
  const depthOf = (item: WorldItem): number => {
    let depth = 0;
    for (let above = item.parent; above !== null; above = above.parent) depth++;
    return depth;
  };
  const heightOf = (item: WorldItem): number =>
    item.children.reduce((height, child) => Math.max(height, 1 + heightOf(child)), 0);
  const topOf = (item: WorldItem): WorldItem => {
    let top = item;
    while (top.parent !== null) top = top.parent;
    return top;
  };
  const isUnder = (item: WorldItem, ancestor: WorldItem): boolean => {
    for (let above: WorldItem | null = item; above !== null; above = above.parent) if (above === ancestor) return true;
    return false;
  };
  const drop = <T>(list: T[], member: T): void => {
    const index = list.indexOf(member);
    if (index >= 0) list.splice(index, 1);
  };
  const touched = (item: WorldItem, group: string, by: WorldOperation): void => {
    item.lastChange.set(group, by.id);
    changedToday.add(item);
  };

  /** A tree of tasks drawn by a shape: `level` is that of the tasks made here, 1 directly under the top. */
  function growPlan(r: Rng, shape: TreeShape, level: number, count: number): Plan[] {
    return Array.from({ length: count }, () => ({
      children: r.chance(shape.chance[level - 1] ?? 0)
        ? growPlan(r, shape, level + 1, r.int(shape.children[0], shape.children[1]))
        : [],
    }));
  }

  interface ItemSpec {
    kind: ItemKind;
    title: string;
    team: Team;
    status: ItemStatus;
    importance: ItemImportance;
    /** The health it is created with. */
    health: ItemHealth | null;
    /** How a task is found to be doing later: each health with the time from the midnight before the task is created. */
    assessments: { after: number; health: ItemHealth }[];
    myRole: MyRole | null;
    startOn: Day | null;
    startOnPrecision: DatePrecision | null;
    dueOn: Day | null;
    dueOnPrecision: DatePrecision | null;
    isMilestone: boolean;
    externalKey: string | null;
    aliases: string[];
    /** The tasks that come to sit under it. */
    plan: Plan[];
    /** Over how many days the tasks directly under it arrive: from, to. */
    childDelay: readonly [number, number];
    /** How many days after its creation the owner closes it; undefined for one that stays open. */
    closeAfter: number | undefined;
    pinned: boolean;
    /** The random stream of what happens to it later; undefined for an item that nothing happens to. */
    later: Rng | undefined;
    /** It was a task with a period first, and is marked as a milestone later. */
    markLater: boolean;
    owner: WorldPerson | undefined;
  }

  /** The days of an item, drawn from its own stream. `anchor` is the day it is created on, `target` the day it is about. */
  function drawSchedule(
    r: Rng,
    kind: ItemKind,
    anchor: Day,
    target: Day,
  ): Pick<ItemSpec, "startOn" | "startOnPrecision" | "dueOn" | "dueOnPrecision" | "isMilestone" | "markLater"> {
    const which = kind === "project" ? "project" : "task";
    const milestone = kind === "task" && r.chance(scale.milestoneShare);
    const markLater = milestone && r.chance(scale.markedLaterShare);
    let dueOn: Day | null = null;
    let startOn: Day | null = null;
    let startOnPrecision: DatePrecision | null = null;
    let dueOnPrecision: DatePrecision | null = null;
    if (milestone && !markLater) {
      if (!r.chance(scale.milestoneUndatedShare)) dueOn = target;
    } else {
      if (markLater || r.chance(scale.dueShare[which])) dueOn = target;
      if (markLater || r.chance(scale.startShare[which])) {
        // With a due day the two are a period, and now and then the work begins late. Alone, the
        // start says when the work begins and nothing about its end.
        startOn =
          dueOn === null
            ? addDays(anchor, r.int(0, scale.taskStartDays[1]))
            : r.chance(scale.startAfterDueShare)
              ? addDays(target, r.int(1, 10))
              : addDays(target, -r.int(scale.taskStartDays[0], scale.taskStartDays[1]));
      }
    }
    const period = (): NamedPeriod => NAMED_PERIODS[r.weighted(scale.periodWeights)] ?? "month";
    if (startOn !== null && dueOn !== null && r.chance(scale.samePeriodShare)) {
      // The work lies somewhere in one named period: both days are its ends.
      const named = period();
      startOn = periodStart(dueOn, named);
      dueOn = periodEnd(startOn, named);
      startOnPrecision = named;
      dueOnPrecision = named;
    } else {
      if (startOn !== null && r.chance(scale.precisionShare)) {
        if (r.chance(scale.approximateShare)) startOnPrecision = "approximate";
        else {
          startOnPrecision = period();
          startOn = periodStart(startOn, startOnPrecision);
        }
      }
      if (dueOn !== null && r.chance(scale.precisionShare)) {
        if (r.chance(scale.approximateShare)) dueOnPrecision = "approximate";
        else {
          dueOnPrecision = period();
          dueOn = periodEnd(dueOn, dueOnPrecision);
        }
      }
    }
    return { startOn, startOnPrecision, dueOn, dueOnPrecision, isMilestone: milestone && !markLater, markLater };
  }

  /**
   * How a task is doing, where the owner says so, which is of few tasks: the health it is created
   * with or gets a few days later, and for some the health it changes to after that. Drawn from a
   * stream of its own: every other field of the task, and what happens to the task later, is the
   * same whether its health is assessed or not.
   */
  function drawTaskHealth(index: number): Pick<ItemSpec, "health" | "assessments"> {
    const r = streams.stream("health", index);
    if (!r.chance(scale.assessedTaskShare)) return { health: null, assessments: [] };
    const found = (shares: readonly number[]): ItemHealth => ITEM_HEALTHS[r.weighted(shares)] ?? "green";
    const first = found(scale.taskHealthShares);
    const later = r.chance(scale.assessedLaterShare);
    // Within days, while the task is open, at some instant of a working day.
    let days = 0;
    const next = (): number => {
      days += r.int(1, scale.taskDueDays[0] + 1);
      return days * DAY_MS + r.int(8 * HOUR, 18 * HOUR);
    };
    const assessments: ItemSpec["assessments"] = [];
    if (later) assessments.push({ after: next(), health: first });
    if (r.chance(scale.taskHealthChangeShare)) {
      // To one of the other two, each as often as a task is found in it.
      const others = scale.taskHealthShares.map((share, which) => (ITEM_HEALTHS[which] === first ? 0 : share));
      assessments.push({ after: next(), health: found(others) });
    }
    return { health: later ? null : first, assessments };
  }

  let drawnItems = 0;
  /** An item as chance makes it: its fields, the tasks that will come under it, and when it will be closed. */
  function drawItem(
    kind: ItemKind,
    createdOn: number,
    team: Team,
    shape: { plan: Plan[]; childDelay: readonly [number, number] } | undefined,
    title: string | undefined,
  ): ItemSpec {
    const index = drawnItems++;
    const r = streams.stream("item", index);
    const anchor = addDays(dayOf(start), createdOn);
    const english = r.chance(0.25);
    const thing = english ? r.pick(THINGS_EN).replace(/^the /, "") : r.pick(THINGS_PL);
    const inDays =
      kind === "project"
        ? (shape?.childDelay[1] ?? scale.projectSpanDays[1])
        : r.int(scale.taskDueDays[0], scale.taskDueDays[1]);
    const schedule = drawSchedule(r, kind, anchor, addDays(anchor, inDays));
    const named =
      title ??
      (schedule.isMilestone || schedule.markLater
        ? `${r.pick(MILESTONES)}: ${thing}`
        : `${english ? r.pick(TASK_VERBS_EN) : r.pick(TASK_VERBS_PL)} ${thing}`);
    const linger = kind === "task" && r.chance(scale.lingerShare);
    const closeAfter =
      kind === "project"
        ? undefined
        : Math.max(
            1,
            inDays +
              (linger
                ? r.int(scale.lingerDays[0], scale.lingerDays[1])
                : r.int(scale.closeAfterDueDays[0], scale.closeAfterDueDays[1])),
          );
    const externalKey = r.chance(scale.externalKeyShare) ? `${team.key}-${r.int(100, 9999)}` : null;
    const assessed = kind === "task" ? drawTaskHealth(index) : undefined;
    return {
      kind,
      title: named,
      team,
      status: r.pick(["todo", "todo", "in_progress", "in_progress", "blocked"] as const),
      importance: ITEM_IMPORTANCES[r.weighted(scale.importanceShares)] ?? DEFAULT_ITEM_IMPORTANCE,
      // Most projects have a health, and it is drawn with the project; few tasks have one.
      health:
        assessed === undefined ? r.pick(["green", "green", "green", "yellow", "red", null] as const) : assessed.health,
      assessments: assessed?.assessments ?? [],
      myRole: r.chance(scale.myRoleShare)
        ? r.pick(["doing", "doing", "delegating", "waiting", "waiting", "watching"] as const)
        : null,
      ...schedule,
      externalKey,
      aliases: externalKey === null ? [] : [externalKey],
      plan: shape?.plan ?? [],
      childDelay: shape?.childDelay ?? scale.childDelayDays,
      closeAfter,
      pinned: false,
      later: r,
      markLater: schedule.markLater,
      owner: r.chance(0.75) ? pickPerson(r) : undefined,
    };
  }

  /** A new item. `under` is the item it goes under, as it was when this was planned. */
  function createItem(spec: ItemSpec, under: WorldItem | null): Intent {
    const id = newId("item");
    let made: WorldItem | undefined;
    const intent: Intent = {
      kind: "create_item",
      payload: {
        item_id: id,
        kind: spec.kind,
        parent_id: under?.fields.id ?? null,
        title: spec.title,
        importance: spec.importance,
        is_milestone: spec.isMilestone,
        start: spec.startOn === null ? null : { on: spec.startOn, precision: spec.startOnPrecision },
        due: spec.dueOn === null ? null : { on: spec.dueOn, precision: spec.dueOnPrecision },
      },
      signal: "task",
      subject: under?.names[0] ?? spec.title,
      team: spec.team,
      about: under,
      command: `dodaj zadanie: ${spec.title}${under === null ? "" : ` w ${under.fields.title}`}`,
      followers: [],
      apply(createdAt, by) {
        let parent: WorldItem | null = null;
        if (under !== null) {
          const standingParent = itemNow(under);
          // The item it was meant for is gone, or sits as deep as a tree goes.
          if (standingParent === undefined || depthOf(standingParent) >= scale.maxDepth) return undefined;
          parent = standingParent;
        }
        const fields: ItemFields = {
          id,
          kind: spec.kind,
          parentId: parent?.fields.id ?? null,
          title: spec.title,
          status: spec.status,
          importance: spec.importance,
          health: spec.health,
          myRole: spec.myRole,
          myRoleSetOn: spec.myRole === null ? null : dayOf(createdAt),
          startOn: spec.startOn,
          startOnPrecision: spec.startOnPrecision,
          dueOn: spec.dueOn,
          dueOnPrecision: spec.dueOnPrecision,
          isMilestone: spec.isMilestone,
          externalSystem: spec.externalKey === null ? null : "tracker",
          externalKey: spec.externalKey,
          externalUrl: spec.externalKey === null ? null : `https://tracker.example/browse/${spec.externalKey}`,
          mergedIntoId: null,
          createdAt,
          closedAt: null,
        };
        const item: WorldItem = {
          fields,
          parent,
          children: [],
          team: spec.team,
          names: [spec.title],
          people: new Map(),
          aliases: [],
          description: null,
          recentFact: null,
          closeAt: undefined,
          lastChange: new Map(),
          pinned: spec.pinned,
          gone: false,
          uses: 0,
        };
        made = item;
        items.set(id, item);
        parent?.children.push(item);
        // What is here to show a shape is no item that material is drawn about.
        if (!spec.pinned) (spec.kind === "project" ? openProjects : openTasks).push(item);
        changedToday.add(item);
        const changes: Change[] = [change("item", "create", fields, id, null)];
        const seen = new Set<string>([foldName(spec.title)]);
        for (const alias of spec.aliases) {
          if (seen.has(foldName(alias))) continue;
          seen.add(foldName(alias));
          const row: ItemAliasFields = { id: newId("itemAlias"), itemId: id, alias, createdAt };
          item.aliases.push(row);
          item.names.push(alias);
          changes.push(change("item_alias", "create", row, id, null));
        }
        by.payload = { ...intent.payload, parent_id: fields.parentId };
        whatFollows(item, spec, createdAt);
        return changes;
      },
      undo() {
        const item = made;
        // Only an item that nothing was hung on since can go the way it came. The roles that the
        // operations after it gave are all it may hold: they go with it.
        if (item === undefined || !isOpen(item) || item.children.length > 0) return undefined;
        if (item.uses !== item.people.size || item.lastChange.size > 0 || item.description !== null) return undefined;
        item.gone = true;
        items.delete(id);
        if (item.parent !== null) drop(item.parent.children, item);
        drop(item.fields.kind === "project" ? openProjects : openTasks, item);
        changedToday.delete(item);
        const roles = [...item.people.values()];
        item.people.clear();
        item.uses = 0;
        return [
          ...roles.map((row): Change => change("item_person", "delete", row, id, row.personId)),
          ...item.aliases.map((row): Change => change("item_alias", "delete", row, id, null)),
          change("item", "delete", item.fields, id, null),
        ];
      },
    };
    if (spec.owner !== undefined) intent.followers.push(setItemPerson(() => made, spec.owner, "owner", null));
    return intent;
  }

  /** What is planned for an item at the moment it is created: the tasks under it, its end, and what changes on the way. */
  function whatFollows(item: WorldItem, spec: ItemSpec, createdAt: number): void {
    const createdOn = dayIndex(createdAt);
    const r = spec.later;
    for (const child of spec.plan) {
      // Drawn here, and not when the day comes, so that the tree of a project does not depend on
      // what else happened in between.
      const stream = streams.stream("plan", drawnItems, createdOn);
      const delay = stream.int(spec.childDelay[0], spec.childDelay[1]);
      const drawn = drawItem(
        "task",
        createdOn + delay,
        item.team,
        { plan: child.children, childDelay: scale.childDelayDays },
        undefined,
      );
      plan(createdOn + delay, {
        make: () => createItem(drawn, item),
        channels: scale.creationChannels,
        r: stream,
      });
    }
    if (spec.closeAfter !== undefined) planClose(item, createdAt + spec.closeAfter * DAY_MS);
    if (r === undefined) return;
    for (const { after, health } of spec.assessments) {
      const instant = start + createdOn * DAY_MS + after;
      at(instant, () => assess(item, health, instant));
    }
    if (spec.kind === "project" && r.chance(scale.descriptionShare)) {
      const writtenAt = createdAt + r.int(60, 600) * SECOND;
      at(writtenAt, () => void byHand(describe(item, r), writtenAt));
    }
    if (r.chance(scale.importanceChangeShare)) {
      // Within days, while the item is open: a change that comes after the item was closed is not made.
      plan(createdOn + r.int(1, scale.taskDueDays[0] + 1), {
        make: () => changeImportance(item, r),
        channels: NO_CHANNEL,
        r,
      });
    }
    if (spec.markLater) {
      plan(createdOn + r.int(1, Math.max(1, scale.dateChangeGapDays[1])), {
        make: () => markMilestone(item),
        channels: NO_CHANNEL,
        r,
      });
    } else if ((spec.dueOn !== null || spec.startOn !== null) && r.chance(scale.dateChangeShare)) {
      let on = createdOn;
      for (let times = r.int(1, scale.dateChangesMax); times > 0; times--) {
        on += r.int(scale.dateChangeGapDays[0], scale.dateChangeGapDays[1]);
        plan(on, { make: () => moveDays(item, r), channels: scale.dateChannels, r });
      }
    }
    if (spec.kind === "task" && r.chance(scale.moveShare)) {
      plan(createdOn + r.int(scale.moveDelayDays[0], scale.moveDelayDays[1]), {
        make: () => moveItem(item, r),
        channels: NO_CHANNEL,
        r,
      });
    }
  }

  /** The owner means to close the item at that instant; the day's plan brings it about. */
  function planClose(item: WorldItem, closeAt: number): void {
    item.closeAt = closeAt;
    const r = streams.stream("close", closesPlanned++);
    plan(dayIndex(closeAt), {
      make: () => {
        if (!isOpen(item) || item.closeAt === undefined) return undefined;
        // Its days were moved since: it is closed when its new day has come.
        if (dayIndex(item.closeAt) > dayIndex(closeAt)) {
          planClose(item, item.closeAt);
          return undefined;
        }
        return closeItem(item, r.chance(scale.cancelledShare) ? "cancelled" : "done");
      },
      channels: scale.closingChannels,
      r,
    });
  }

  function closeItem(item: WorldItem, status: "done" | "cancelled"): Intent {
    return {
      kind: "update_item",
      payload: { item_id: item.fields.id, set: { status } },
      signal: "done",
      subject: item.names[0] as string,
      team: item.team,
      about: item,
      command: `zamknij ${item.fields.title}`,
      followers: [],
      apply(closedAt, by) {
        if (!isOpen(item)) return undefined;
        const was = { status: item.fields.status, closedAt: null };
        item.fields.status = status;
        item.fields.closedAt = closedAt;
        drop(item.fields.kind === "project" ? openProjects : openTasks, item);
        touched(item, "status", by);
        // Another project takes the place of one that is closed.
        if (item.fields.kind === "project")
          at(closedAt + HOUR, () => void byHand(createProject(dayIndex(closedAt)), closedAt + HOUR));
        return [change("item", "update", item.fields, item.fields.id, null, was)];
      },
    };
  }

  /** A field of the item gets another value: the plain case of an update. */
  function setField<K extends "status" | "health" | "importance" | "title" | "myRole">(
    item: WorldItem,
    field: K,
    value: ItemFields[K],
    signal: Signal = "status",
  ): Intent {
    const intent: Intent = {
      kind: "update_item",
      payload: { item_id: item.fields.id, set: { [field]: value } },
      signal,
      subject: item.names[0] as string,
      team: item.team,
      about: item,
      command: `zmień ${item.fields.title}`,
      followers: [],
      apply(changedAt, by) {
        if (!isOpen(item) || item.fields[field] === value) return undefined;
        const fields = item.fields;
        const was: Partial<ItemFields> = { [field]: fields[field] };
        fields[field] = value;
        if (field === "myRole") {
          // The day from which the role holds is written with the role.
          was.myRoleSetOn = fields.myRoleSetOn;
          fields.myRoleSetOn = value === null ? null : dayOf(changedAt);
          if (was.myRoleSetOn === fields.myRoleSetOn) delete was.myRoleSetOn;
        }
        if (field === "title") item.names[0] = fields.title;
        touched(item, field, by);
        const before = { ...was };
        intent.undo = () => {
          if (!isOpen(item) || item.lastChange.get(field) !== by.id) return undefined;
          const now: Partial<ItemFields> = {};
          for (const key of Object.keys(before) as (keyof ItemFields)[]) {
            Object.assign(now, { [key]: fields[key] });
            Object.assign(fields, { [key]: before[key] });
          }
          if (field === "title") item.names[0] = fields.title;
          return [change("item", "update", fields, fields.id, null, now)];
        };
        return [change("item", "update", fields, fields.id, null, was)];
      },
    };
    return intent;
  }
  function changeImportance(item: WorldItem, r: Rng): Intent | undefined {
    const others = ITEM_IMPORTANCES.filter((importance) => importance !== item.fields.importance);
    return isOpen(item) ? setField(item, "importance", r.pick(others)) : undefined;
  }

  /**
   * The owner says how a task is doing: a change of one field by hand, with its effect, like any
   * other. It is made beside the rest of the history, so that nothing else is different for it.
   * The identifier of its operation comes from a series of its own. It is applied in the
   * millisecond before its instant, which no other change can take: whatever is applied from that
   * instant on is applied at it or later. Where the clock has reached that millisecond already,
   * as after a capture whose second attempt is applied ahead of its event, it waits a second. And
   * it is no reason to write the summary of the task again.
   */
  function assess(item: WorldItem, health: ItemHealth, instant: number): void {
    if (!isOpen(item) || item.fields.health === health) return;
    const appliedAt = instant - 1;
    if (lastStamp >= appliedAt) {
      at(instant + SECOND, () => assess(item, health, instant + SECOND));
      return;
    }
    // The millisecond is taken from here on: two assessments never share one.
    lastStamp = appliedAt;
    const made = operation(
      "update_item",
      "user",
      appliedAt,
      { item_id: item.fields.id, set: { health } },
      newId("operation", " of an assessment"),
    );
    made.approval = "manual";
    made.appliedAt = appliedAt;
    const was = { health: item.fields.health };
    item.fields.health = health;
    // Recorded as every change of a field is: the creation of an item that was changed since is not undone.
    item.lastChange.set("health", made.id);
    sink.operation(made, []);
    sink.changes(made, [change("item", "update", item.fields, item.fields.id, null, was)]);
  }

  /** A day of the item moves, or both do: one change of the item, whatever it writes. */
  function moveDays(item: WorldItem, r: Rng, how?: { both: boolean; exact: boolean }): Intent | undefined {
    if (!isOpen(item) || (item.fields.dueOn === null && item.fields.startOn === null)) return undefined;
    const by = r.int(scale.dateShiftDays[0], scale.dateShiftDays[1]);
    const period = item.fields.startOn !== null && item.fields.dueOn !== null;
    const both = how?.both ?? (period && r.chance(scale.bothDaysMoveShare));
    const exact = how?.exact ?? r.chance(0.5);
    const intent: Intent = {
      kind: "update_item",
      payload: { item_id: item.fields.id, shift: { days: by }, both },
      signal: "date",
      subject: item.names[0] as string,
      team: item.team,
      about: item,
      command: `przesuń ${item.fields.title} o ${by} dni`,
      followers: [],
      apply(_changedAt, operation) {
        const fields = item.fields;
        if (!isOpen(item)) return undefined;
        const was: Partial<ItemFields> = {};
        // A day that was known to a period is no boundary of it once it has moved: its precision
        // goes, or says that the new day is rough.
        const moved = (precision: DatePrecision | null): DatePrecision | null =>
          precision === null || exact ? null : "approximate";
        if (fields.dueOn !== null) {
          was.dueOn = fields.dueOn;
          fields.dueOn = addDays(fields.dueOn, by);
          if (moved(fields.dueOnPrecision) !== fields.dueOnPrecision) {
            was.dueOnPrecision = fields.dueOnPrecision;
            fields.dueOnPrecision = moved(fields.dueOnPrecision);
          }
          if (item.closeAt !== undefined) item.closeAt += by * DAY_MS;
        }
        if (fields.startOn !== null && (both || fields.dueOn === null)) {
          was.startOn = fields.startOn;
          fields.startOn = addDays(fields.startOn, by);
          if (moved(fields.startOnPrecision) !== fields.startOnPrecision) {
            was.startOnPrecision = fields.startOnPrecision;
            fields.startOnPrecision = moved(fields.startOnPrecision);
          }
        }
        if (Object.keys(was).length === 0) return undefined;
        touched(item, "schedule", operation);
        const before = { ...was };
        intent.undo = () => {
          if (!isOpen(item) || item.lastChange.get("schedule") !== operation.id) return undefined;
          const now: Partial<ItemFields> = {};
          for (const key of Object.keys(before) as (keyof ItemFields)[]) {
            Object.assign(now, { [key]: fields[key] });
            Object.assign(fields, { [key]: before[key] });
          }
          return [change("item", "update", fields, fields.id, null, now)];
        };
        return [change("item", "update", fields, fields.id, null, was)];
      },
    };
    return intent;
  }

  /** A task with a period turns out to be a point in time: the mark is set and the start goes, in one change. */
  function markMilestone(item: WorldItem): Intent | undefined {
    if (!isOpen(item) || item.fields.isMilestone || item.fields.kind !== "task") return undefined;
    return {
      kind: "update_item",
      payload: { item_id: item.fields.id, set: { is_milestone: true } },
      signal: "status",
      subject: item.names[0] as string,
      team: item.team,
      about: item,
      command: "",
      followers: [],
      apply(_markedAt, by) {
        const fields = item.fields;
        if (!isOpen(item) || fields.isMilestone) return undefined;
        const was: Partial<ItemFields> = { isMilestone: false };
        fields.isMilestone = true;
        if (fields.startOn !== null) {
          was.startOn = fields.startOn;
          fields.startOn = null;
        }
        if (fields.startOnPrecision !== null) {
          was.startOnPrecision = fields.startOnPrecision;
          fields.startOnPrecision = null;
        }
        touched(item, "schedule", by);
        return [change("item", "update", fields, fields.id, null, was)];
      },
    };
  }

  /** The task goes under another item, with everything under it: one row is written. */
  function moveItem(item: WorldItem, r: Rng, to?: WorldItem | null): Intent | undefined {
    if (!isOpen(item) || item.fields.kind !== "task") return undefined;
    const height = heightOf(item);
    const fits = (target: WorldItem): boolean =>
      isOpen(target) &&
      !target.pinned &&
      target !== item.parent &&
      // Under itself, or under what sits under it, it would be its own ancestor.
      !isUnder(target, item) &&
      depthOf(target) + 1 + height <= scale.maxDepth;
    let target: WorldItem | null | undefined = to;
    if (target === undefined && r.chance(scale.moveWithinTreeShare)) {
      // Within its own tree, as when a plan is put in another order.
      const places: WorldItem[] = [];
      const look = (at: WorldItem): void => {
        if (fits(at)) places.push(at);
        for (const child of at.children) look(child);
      };
      look(topOf(item));
      if (places.length > 0) target = r.pick(places);
    }
    // Or into another tree. A place that does not fit is drawn again, a few times.
    for (let tries = 0; target === undefined && tries < 8; tries++) {
      const candidate = r.chance(0.3) ? r.pick(openProjects) : openTasks[r.int(0, openTasks.length - 1)];
      if (candidate !== undefined && fits(candidate)) target = candidate;
    }
    if (target === undefined) return undefined;
    const under = target;
    const intent: Intent = {
      kind: "update_item",
      payload: { item_id: item.fields.id, set: { parent_id: under?.fields.id ?? null } },
      signal: "status",
      subject: item.names[0] as string,
      team: item.team,
      about: item,
      command: "",
      followers: [],
      apply(_movedAt, by) {
        if (!isOpen(item) || (under !== null && (to === undefined ? !fits(under) : !isOpen(under)))) return undefined;
        const from = item.parent;
        const was = { parentId: item.fields.parentId };
        if (from !== null) drop(from.children, item);
        item.parent = under;
        item.fields.parentId = under?.fields.id ?? null;
        under?.children.push(item);
        touched(item, "parent", by);
        intent.undo = () => {
          // Back where it was, when that is still a place for it.
          if (!isOpen(item) || item.lastChange.get("parent") !== by.id) return undefined;
          if (from !== null && (!isOpen(from) || isUnder(from, item))) return undefined;
          if (from !== null && depthOf(from) + 1 + heightOf(item) > scale.maxDepth) return undefined;
          const now = { parentId: item.fields.parentId };
          if (item.parent !== null) drop(item.parent.children, item);
          item.parent = from;
          item.fields.parentId = from?.fields.id ?? null;
          from?.children.push(item);
          return [change("item", "update", item.fields, item.fields.id, null, now)];
        };
        return [change("item", "update", item.fields, item.fields.id, null, was)];
      },
    };
    return intent;
  }

  /** The prose of an item: written first, or written over. */
  function describe(item: WorldItem, r: Rng): Intent {
    const body = {
      type: "doc",
      content: Array.from({ length: r.int(1, 3) }, () => ({
        type: "paragraph",
        content: [
          { type: "text", text: Array.from({ length: r.int(2, 5) }, () => r.pick(SUMMARY_SENTENCES)).join(" ") },
        ],
      })),
    };
    return {
      kind: "update_item",
      payload: { item_id: item.fields.id, description: true },
      signal: "status",
      subject: item.names[0] as string,
      team: item.team,
      about: item,
      command: "",
      followers: [],
      apply(writtenAt, by) {
        // The application looks first whether the item was merged: a merged item takes no description.
        if (!isOpen(item)) return undefined;
        touched(item, "description", by);
        if (item.description === null) {
          item.description = { id: newId("itemDescription"), itemId: item.fields.id, updatedAt: writtenAt, body };
          return [change("item_description", "create", item.description, item.fields.id, null)];
        }
        const was = { updatedAt: item.description.updatedAt, body: item.description.body };
        item.description.updatedAt = writtenAt;
        item.description.body = body;
        return [change("item_description", "update", item.description, item.fields.id, null, was)];
      },
    };
  }

  /** The role of a person in an item. The item may be one that an earlier operation is still to create. */
  function setItemPerson(
    which: WorldItem | (() => WorldItem | undefined),
    who: WorldPerson,
    role: ItemPersonRole,
    expectations: string | null,
  ): Intent {
    const id = newId("itemPerson");
    const planned = typeof which === "function" ? undefined : which;
    return {
      kind: "set_item_person",
      payload: { item_person_id: id, item_id: planned?.fields.id ?? null, person_id: who.fields.id, role },
      signal: "fact",
      subject: planned?.names[0] ?? "",
      team: planned?.team ?? who.team,
      about: planned ?? null,
      command: "",
      followers: [],
      apply(setAt, by) {
        const first = typeof which === "function" ? which() : which;
        const item = first === undefined ? undefined : itemNow(first);
        const person = personNow(who);
        if (item === undefined) return undefined;
        const itemId = item.fields.id;
        const personId = person.fields.id;
        by.payload = { ...by.payload, item_id: itemId, person_id: personId };
        const existing = item.people.get(personId);
        const owner = [...item.people.values()].find((row) => row.role === "owner");
        // An item has one owner: a second one is a stakeholder until the first is taken off.
        const given = role === "owner" && owner !== undefined && owner !== existing ? "stakeholder" : role;
        changedToday.add(item);
        if (existing !== undefined) {
          if (existing.role === given && existing.expectations === expectations) {
            // The operation concerned the row and found it as it should be.
            return [change("item_person", "touch", existing, itemId, personId)];
          }
          const was: Partial<ItemPersonFields> = {};
          if (existing.role !== given) {
            was.role = existing.role;
            existing.role = given;
          }
          if (existing.expectations !== expectations) {
            was.expectations = existing.expectations;
            existing.expectations = expectations;
          }
          return [change("item_person", "update", existing, itemId, personId, was)];
        }
        const row: ItemPersonFields = { id, itemId, personId, role: given, createdAt: setAt, expectations };
        item.people.set(personId, row);
        item.uses++;
        // A role that follows the creation of the item is a part of it; any other is a change of its own.
        if (planned !== undefined) item.lastChange.set("people", by.id);
        person.rows?.roles.push(row);
        return [change("item_person", "create", row, itemId, personId)];
      },
    };
  }

  /**
   * Two entries of one task become one. What hangs on the duplicate moves to the survivor first,
   * the tasks under it among it, and the duplicate is marked last: it stays as a signpost.
   */
  function mergeItems(duplicate: WorldItem, into: WorldItem): Intent {
    return {
      kind: "merge_items",
      payload: { item_id: duplicate.fields.id, into_item_id: into.fields.id },
      signal: "status",
      subject: duplicate.names[0] as string,
      team: duplicate.team,
      about: into,
      command: "",
      followers: [],
      apply(mergedAt, by) {
        const survivor = itemNow(into);
        if (survivor === undefined || duplicate.gone || duplicate.fields.mergedIntoId !== null) return undefined;
        // Into an item that it contains, the move that the merge needs would close a circle.
        if (survivor === duplicate || isUnder(survivor, duplicate) || duplicate.rows === undefined) return undefined;
        const height = duplicate.children.reduce((most, child) => Math.max(most, 1 + heightOf(child)), 0);
        if (depthOf(survivor) + height > scale.maxDepth) return undefined;
        const to = survivor.fields.id;
        const changes: Change[] = [];
        for (const child of [...duplicate.children]) {
          child.parent = survivor;
          child.fields.parentId = to;
          survivor.children.push(child);
          changes.push(
            change("item", "update", child.fields, child.fields.id, null, { parentId: duplicate.fields.id }),
          );
        }
        duplicate.children = [];
        const linked = new Set((survivor.rows?.links ?? []).map((row) => row.sourceId));
        for (const link of duplicate.rows.links) {
          if (linked.has(link.sourceId)) {
            // The survivor is linked to that source already, and a source is linked to an item once.
            changes.push(change("source_link", "delete", link, to, null));
            continue;
          }
          linked.add(link.sourceId);
          link.itemId = to;
          survivor.rows?.links.push(link);
          survivor.uses++;
          changes.push(change("source_link", "update", link, to, null, { itemId: duplicate.fields.id }));
        }
        for (const fact of duplicate.rows.facts) {
          if (fact.gone) continue;
          fact.fields.itemId = to;
          fact.item = survivor;
          survivor.rows?.facts.push(fact);
          survivor.uses++;
          changes.push(change("fact", "update", fact.fields, to, null, { itemId: duplicate.fields.id }));
        }
        if (duplicate.recentFact !== null && !duplicate.recentFact.gone) survivor.recentFact = duplicate.recentFact;
        const hasOwner = [...survivor.people.values()].some((row) => row.role === "owner");
        for (const role of duplicate.people.values()) {
          if (survivor.people.has(role.personId) || (role.role === "owner" && hasOwner)) {
            changes.push(change("item_person", "delete", role, to, role.personId));
            continue;
          }
          role.itemId = to;
          survivor.people.set(role.personId, role);
          survivor.uses++;
          changes.push(change("item_person", "update", role, to, role.personId, { itemId: duplicate.fields.id }));
        }
        duplicate.people.clear();
        const names = new Set(survivor.names.map(foldName));
        for (const alias of duplicate.aliases) {
          if (names.has(foldName(alias.alias))) {
            changes.push(change("item_alias", "delete", alias, to, null));
            continue;
          }
          names.add(foldName(alias.alias));
          alias.itemId = to;
          survivor.aliases.push(alias);
          survivor.names.push(alias.alias);
          changes.push(change("item_alias", "update", alias, to, null, { itemId: duplicate.fields.id }));
        }
        duplicate.aliases = [];
        // The title that was entered twice stays known: it is an alias of the survivor from now on.
        if (!names.has(foldName(duplicate.fields.title))) {
          const row: ItemAliasFields = {
            id: newId("itemAlias"),
            itemId: to,
            alias: duplicate.fields.title,
            createdAt: mergedAt,
          };
          survivor.aliases.push(row);
          survivor.names.push(row.alias);
          changes.push(change("item_alias", "create", row, to, null));
        }
        if (duplicate.description !== null) {
          if (survivor.description === null) {
            duplicate.description.itemId = to;
            survivor.description = duplicate.description;
            changes.push(
              change("item_description", "update", duplicate.description, to, null, { itemId: duplicate.fields.id }),
            );
          } else {
            changes.push(change("item_description", "delete", duplicate.description, to, null));
          }
          duplicate.description = null;
        }
        duplicate.fields.mergedIntoId = to;
        duplicate.uses = 0;
        drop(openTasks, duplicate);
        touched(survivor, "merge", by);
        changedToday.delete(duplicate);
        changes.push(change("item", "update", duplicate.fields, duplicate.fields.id, null, { mergedIntoId: null }));
        return changes;
      },
    };
  }

  function createProject(createdOn: number, flagship = false, isOutlier = false): Intent {
    const r = streams.stream("project", projectCount++);
    let title: string;
    if (isOutlier) title = CODENAMES[0] as string;
    else {
      do {
        title = `${r.chance(0.6) ? r.pick(CODENAMES) : r.pick(DESCRIPTIVE_PROJECTS)}${r.pick(PROJECT_SUFFIXES)}`;
        if (usedProjectNames.has(title)) title = `${title} ${1 + r.int(1, 97)}`;
      } while (usedProjectNames.has(title));
    }
    usedProjectNames.add(title);
    const shape = isOutlier ? scale.outlierTree : scale.projectTree;
    // The tasks of the outlier arrive through the whole history, those of another project through its span.
    const span = isOutlier ? Math.max(1, scale.days - 2) : r.int(scale.projectSpanDays[0], scale.projectSpanDays[1]);
    const spec = drawItem(
      "project",
      createdOn,
      r.pick(TEAMS),
      { plan: growPlan(r, shape, 1, r.int(shape.top[0], shape.top[1])), childDelay: [1, span] },
      title,
    );
    spec.status = r.chance(0.8) ? "in_progress" : "todo";
    spec.closeAfter = flagship ? undefined : span + r.int(scale.projectTailDays[0], scale.projectTailDays[1]);
    const words = title.split(/[ —]+/).filter((word) => word.length > 2);
    if (words.length > 1) spec.aliases.push(words.map((word) => word.charAt(0).toUpperCase()).join(""));
    const intent = createItem(spec, null);
    // A project has people around it: who asked for it, and who wants to hear of it.
    const seen = new Set<WorldPerson | undefined>([spec.owner]);
    const project = (): WorldItem | undefined => items.get(intent.payload.item_id as ItemId);
    for (let count = r.int(2, 5); count > 0 && persons.length > 0; count--) {
      const person = pickPerson(r);
      if (seen.has(person)) continue;
      seen.add(person);
      const role: ItemPersonRole = seen.size === 2 ? "requester" : "stakeholder";
      intent.followers.push(
        setItemPerson(project, person, role, role === "stakeholder" && r.chance(0.4) ? r.pick(EXPECTATIONS) : null),
      );
    }
    const apply = intent.apply;
    intent.apply = (createdAt, by) => {
      const changes = apply(createdAt, by);
      if (isOutlier) outlier = project();
      return changes;
    };
    return intent;
  }

  // ---- what a capture is, and what its run makes of it ----
  let modelCalls = 0;
  /** The captures that were saved and are not processed yet. */
  const waiting = new Set<Script>();
  /** The captures whose cards were left with something to decide. */
  const openCards: Script[] = [];
  let lastScreenshot: WorldFile | undefined;

  const nameIn = (r: Rng, person: WorldPerson, grammaticalCase: number, english: boolean): Named => {
    const useShort = person.given.short !== undefined && r.chance(0.55);
    const forms = useShort && person.given.short !== undefined ? person.given.short : person.given.forms;
    // In an English sentence a name stays as it is.
    return { person, surface: forms[english ? 0 : grammaticalCase] as string, base: forms[0] };
  };
  function fill(
    r: Rng,
    sentence: Sentence,
    subject: string,
    team: Team,
    key: string | null,
    people: readonly WorldPerson[],
    newName: string | undefined,
  ): { text: string; named: Named[]; thing: string } {
    const named: Named[] = [];
    const english = sentence.lang === "en";
    const thing = r.pick(english ? THINGS_EN : THINGS_PL);
    const person = (grammaticalCase: number): string => {
      const who = nameIn(r, r.pick(people), grammaticalCase, english);
      named.push(who);
      return who.surface;
    };
    const text = sentence.text.replace(SLOT, (_all, slot: string) => {
      switch (slot) {
        case "item":
          return subject;
        case "pn":
          return person(0);
        case "pg":
          return person(1);
        case "pd":
          return person(2);
        case "pi":
          return person(4);
        case "thing":
          return thing;
        case "due":
          return r.pick(english ? DUE_EN : DUE_PL);
        case "team":
          return team.name;
        case "new":
          return newName ?? "";
        default:
          return key ?? `${team.key}-${r.int(100, 9999)}`;
      }
    });
    return { text, named, thing };
  }
  const sentencesOf = (signal: Signal): Sentence[] => SENTENCES.filter((sentence) => sentence.signal === signal);
  const BY_SIGNAL: Record<Signal, Sentence[]> = {
    fact: sentencesOf("fact"),
    task: sentencesOf("task"),
    status: sentencesOf("status"),
    date: sentencesOf("date"),
    done: sentencesOf("done"),
    person: sentencesOf("person"),
  };

  /** One of the items that material is about: the outlier, a busy project, or a task that is under way. */
  function pickItem(r: Rng): WorldItem | undefined {
    const draw = r.next();
    if (draw < scale.outlierShare && outlier !== undefined && isOpen(outlier)) return outlier;
    if (draw < 0.4 || openTasks.length === 0) return openProjects[skewedIndex(r, openProjects.length, 3)];
    // The newest tasks are talked about most.
    const back = Math.min(openTasks.length - 1, Math.floor(-Math.log(1 - r.next()) * 40));
    return openTasks[openTasks.length - 1 - back];
  }

  /** Records that a source concerns an item. */
  function linkSource(capture: WorldCapture, item: WorldItem, linked: Set<WorldItem>): Intent {
    const id = newId("sourceLink");
    let made: { item: WorldItem; row: SourceLinkFields } | undefined;
    return {
      kind: "link_source",
      payload: { link_id: id, source_id: capture.id, item_id: item.fields.id },
      signal: "fact",
      subject: item.names[0] as string,
      team: item.team,
      about: item,
      command: "",
      followers: [],
      apply(linkedAt, by) {
        const target = itemNow(item);
        if (target === undefined) return undefined;
        changedToday.add(target);
        // A source is linked to an item once: a second link finds the first.
        if (linked.has(target)) return [];
        linked.add(target);
        by.payload = { ...by.payload, item_id: target.fields.id };
        const row: SourceLinkFields = { id, sourceId: capture.id, itemId: target.fields.id, createdAt: linkedAt };
        target.uses++;
        target.rows?.links.push(row);
        made = { item: target, row };
        return [change("source_link", "create", row, target.fields.id, null)];
      },
      undo() {
        // After a merge the row is the survivor's, and is left where it is.
        if (made === undefined || made.row.itemId !== made.item.fields.id || !linked.has(made.item)) return undefined;
        if (made.item.fields.mergedIntoId !== null) return undefined;
        linked.delete(made.item);
        made.item.uses--;
        if (made.item.rows !== undefined) drop(made.item.rows.links, made.row);
        return [change("source_link", "delete", made.row, made.row.itemId, null)];
      },
    };
  }

  /** A statement about an item, with the piece of the source it rests on. */
  function addFact(
    r: Rng,
    capture: WorldCapture,
    item: WorldItem,
    type: FactType,
    quote: string,
    text: string,
    named: readonly Named[],
  ): Intent & { fact: () => WorldFact | undefined; before: () => WorldFact | null } {
    const id = newId("fact");
    const withPersons = r.chance(scale.factPersonShare);
    const exact = r.chance(0.3);
    let made: WorldFact | undefined;
    let before: WorldFact | null = null;
    const intent: Intent = {
      kind: "add_fact",
      payload: { fact_id: id, item_id: item.fields.id, type, occurred_on: capture.occurredOn },
      signal: "fact",
      subject: item.names[0] as string,
      team: item.team,
      about: item,
      command: "",
      followers: [],
      apply(addedAt, by) {
        const target = itemNow(item);
        if (target === undefined) return undefined;
        // What the owner chose on the card counts, when it differs from what the agent proposed.
        const accepted = (by.payload as { type?: FactType }).type ?? type;
        const fields: FactFields = {
          id,
          itemId: target.fields.id,
          type: accepted,
          occurredOn: capture.occurredOn,
          occurredOnApproximate: !exact,
          sourceId: capture.id,
          outdatedAt: null,
          supersededByFactId: null,
          createdAt: addedAt,
          quote,
          text,
        };
        const fact: WorldFact = { fields, persons: [], item: target, successor: false, gone: false };
        const changes: Change[] = [change("fact", "create", fields, fields.itemId, null)];
        if (withPersons) {
          const seen = new Set<PersonId>();
          for (const { person } of named) {
            const standingPerson = personNow(person);
            const personId = standingPerson.fields.id;
            if (seen.has(personId)) continue;
            seen.add(personId);
            const row: FactPersonFields = { id: newId("factPerson"), factId: id, personId };
            fact.persons.push(row);
            standingPerson.rows?.facts.push({ row, fact });
            changes.push(change("fact_person", "create", row, fields.itemId, personId));
          }
        }
        by.payload = { ...by.payload, item_id: fields.itemId };
        before = target.recentFact;
        target.recentFact = fact;
        target.uses++;
        target.rows?.facts.push(fact);
        changedToday.add(target);
        made = fact;
        return changes;
      },
      undo() {
        const fact = made;
        // A fact that was marked outdated since, or that another fact names as its successor, has a history of its own.
        if (fact === undefined || fact.gone || fact.successor || fact.fields.outdatedAt !== null) return undefined;
        fact.gone = true;
        fact.item.uses--;
        if (fact.item.recentFact === fact) fact.item.recentFact = before !== null && !before.gone ? before : null;
        const itemId = fact.fields.itemId;
        return [
          ...fact.persons.map((row): Change => change("fact_person", "delete", row, itemId, row.personId)),
          change("fact", "delete", fact.fields, itemId, null),
        ];
      },
    };
    return Object.assign(intent, { fact: () => made, before: () => before });
  }

  /** The newer fact takes the place of the one that was the newest of its item before it. */
  function supersedeFact(
    newer: { fact: () => WorldFact | undefined; before: () => WorldFact | null },
    item: WorldItem,
  ): Intent {
    return {
      kind: "supersede_fact",
      payload: { item_id: item.fields.id },
      signal: "fact",
      subject: item.names[0] as string,
      team: item.team,
      about: item,
      command: "",
      followers: [],
      apply(outdatedAt, by) {
        const fact = newer.fact();
        const older = newer.before();
        if (fact === undefined || fact.gone || older === null || older.gone || older.fields.outdatedAt !== null) {
          return undefined;
        }
        older.fields.outdatedAt = outdatedAt;
        older.fields.supersededByFactId = fact.fields.id;
        fact.successor = true;
        by.payload = { fact_id: older.fields.id, superseded_by_fact_id: fact.fields.id };
        changedToday.add(older.item);
        return [
          change("fact", "update", older.fields, older.fields.itemId, null, {
            outdatedAt: null,
            supersededByFactId: null,
          }),
        ];
      },
    };
  }

  /** A person named in a source. The mention is recorded, resolved when the name says who it is. */
  function resolveMention(
    capture: WorldCapture,
    surface: string,
    base: string,
    who: WorldPerson | (() => WorldPerson | undefined) | undefined,
  ): Intent & { mention: () => MentionFields | undefined } {
    const id = newId("mention");
    let made: MentionFields | undefined;
    const known = typeof who === "function" ? undefined : who;
    const intent: Intent = {
      kind: "resolve_mention",
      payload: { mention_id: id, surface, person_id: known?.fields.id ?? null },
      signal: "fact",
      subject: surface,
      team: known?.team ?? (TEAMS[0] as Team),
      about: null,
      command: "",
      followers: [],
      apply(recordedAt, by) {
        const first = typeof who === "function" ? who() : who;
        // The person it was meant for was never entered: the proposal it followed was not accepted.
        if (typeof who === "function" && first === undefined) return undefined;
        const person = first === undefined ? undefined : personNow(first);
        const row: MentionFields = {
          id,
          sourceId: capture.id,
          personId: person?.fields.id ?? null,
          skippedAt: null,
          createdAt: recordedAt,
          surface,
          baseForm: base,
        };
        by.payload = { ...by.payload, person_id: row.personId };
        person?.rows?.mentions.push(row);
        made = row;
        return [change("mention", "create", row, null, row.personId)];
      },
      undo() {
        const person = made?.personId == null ? undefined : (created.get(made.personId) ?? undefined);
        if (made === undefined || made.skippedAt !== null || person?.rows !== undefined) return undefined;
        const row = made;
        made = undefined;
        return [change("mention", "delete", row, null, row.personId)];
      },
    };
    return Object.assign(intent, { mention: () => made });
  }

  /** The owner's answer to "who is this": one of the candidates, or nobody. */
  function answerMention(
    asked: { mention: () => MentionFields | undefined },
    candidates: WorldPerson[],
    r: Rng,
  ): Intent {
    const skip = r.chance(0.1);
    const chosen = r.pick(candidates);
    return {
      kind: "ask_user",
      payload: { question: "who_is", candidates: candidates.map((person) => person.fields.id) },
      signal: "fact",
      subject: "",
      team: chosen.team,
      about: null,
      command: "",
      followers: [],
      apply(answeredAt, by) {
        const mention = asked.mention();
        if (mention === undefined || mention.personId !== null || mention.skippedAt !== null) return undefined;
        if (skip) {
          mention.skippedAt = answeredAt;
          by.answer = { skip: true };
          return [change("mention", "update", mention, null, null, { skippedAt: null })];
        }
        const person = personNow(chosen);
        mention.personId = person.fields.id;
        by.answer = { person_id: person.fields.id };
        return [change("mention", "update", mention, null, person.fields.id, { personId: null })];
      },
    };
  }

  /** The owner's answer to "is this the same item": the operation concerned the item and changed nothing. */
  function answerAboutItem(candidates: WorldItem[]): Intent {
    return {
      kind: "ask_user",
      payload: { question: "same_item", candidates: candidates.map((item) => item.fields.id) },
      signal: "fact",
      subject: "",
      team: (candidates[0] as WorldItem).team,
      about: candidates[0] ?? null,
      command: "",
      followers: [],
      apply(_answeredAt, by) {
        const item = itemNow(candidates[0] as WorldItem);
        if (item === undefined) return undefined;
        by.answer = { item_id: item.fields.id };
        changedToday.add(item);
        return [change("item", "touch", item.fields, item.fields.id, null)];
      },
    };
  }

  const step = (intent: Intent, fate: Fate, more: Partial<Step> = {}): Step => ({
    intent,
    origin: "inference",
    confidence: "high",
    quote: null,
    commandQuote: null,
    fate,
    needs: [],
    annotations: null,
    ...more,
  });

  /** A capture of the day, with what the agent will stage for it. `assigned` are the planned changes that this material brings. */
  function compose(
    day: number,
    index: number,
    savedAt: number,
    isNote: boolean,
    assigned: { intent: Intent; channel: "command" | "agent" }[],
    tail: Script["tail"],
  ): Script {
    const r = streams.stream("capture", day, index);
    const commands = assigned.filter(({ channel }) => channel === "command");
    const SHAPES = ["chat", "screenshot", "typed", "mixed", "file"] as const;
    let shape: (typeof SHAPES)[number] | "note" = isNote ? "note" : (SHAPES[r.weighted(scale.captureShapes)] ?? "chat");
    // On the first day one capture is a screenshot whose transcript the owner corrects, and one a
    // dropped file: the smallest world holds every kind of raw material, too.
    const shown = day === 0 && !isNote ? ([undefined, "screenshot", "file"] as const)[index] : undefined;
    if (shown !== undefined) shape = shown;
    // What the owner types as a command stands in the typed part, beside the material.
    if (commands.length > 0 && shape !== "typed") shape = "mixed";

    const related: WorldItem[] = [];
    for (const { intent } of assigned) {
      const item = intent.about === null ? undefined : itemNow(intent.about);
      if (item !== undefined && !related.includes(item)) related.push(item);
    }
    const wanted = isNote ? r.int(1, 4) : r.weighted(scale.itemsPerCapture);
    for (let i = 0; i < wanted; i++) {
      const item = pickItem(r);
      if (item !== undefined && !related.includes(item)) related.push(item);
    }
    const people: WorldPerson[] = [];
    for (let count = r.int(1, 3); count > 0; count--) {
      const person = pickPerson(r);
      if (!people.includes(person)) people.push(person);
    }
    const owner = me as WorldPerson;
    const withMe = !isNote && r.chance(0.35);

    const capture: WorldCapture = {
      id: newId("capture"),
      createdAt: savedAt,
      occurredOn: dayOf(savedAt),
      occurredOnApproximate: true,
      parts: [],
    };

    // The text, sentence by sentence; what each sentence gives rise to is staged beside it.
    const lines: string[] = [];
    const authors: WorldPerson[] = [];
    const named: Named[] = [];
    const steps: Step[] = [];
    let minutes = 9 * 60 + r.int(0, 400);
    const say = (text: string): void => {
      if (shape === "note" || shape === "typed") {
        lines.push(text);
        return;
      }
      const author = withMe && r.chance(0.3) ? owner : r.pick(people);
      if (!authors.includes(author)) authors.push(author);
      minutes += r.int(0, 6);
      const clock = `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      lines.push(`[${clock}] ${author.fields.name}: ${text}`);
    };
    const sentence = (signal: Signal, subject: string, team: Team, key: string | null, newName?: string) => {
      const filled = fill(r, r.pick(BY_SIGNAL[signal]), subject, team, key, people, newName);
      say(filled.text);
      named.push(...filled.named);
      return filled;
    };
    const confidence = (): Confidence => (r.chance(scale.lowConfidenceShare) ? "low" : "high");
    const inbox = (): Fate => (r.chance(scale.rejectedShare) ? "reject" : "accept");
    const lowered = (given: Confidence): object | null =>
      given === "low" && r.chance(0.5) ? [{ code: "confidence_lowered", reason: "alias_matches_several" }] : null;

    if (shape === "note") {
      const first = related[0];
      const header = r
        .pick(NOTE_HEADERS)
        .replace("{pi}", nameIn(r, people[0] as WorldPerson, 4, false).surface)
        .replace("{item}", first?.names[0] ?? "zespołu")
        .replace("{team}", (first?.team ?? r.pick(TEAMS)).name);
      lines.push(`${header}, ${r.pick(NOTE_DAYS)}.`);
    }
    // Which items the material is about.
    const linked = new Set<WorldItem>();
    const links = new Map<WorldItem, Step>();
    for (const item of related) {
      const sure = confidence();
      const made = step(linkSource(capture, item, linked), sure === "high" ? "auto" : inbox(), {
        confidence: sure,
        quote: null,
        annotations: lowered(sure),
      });
      links.set(item, made);
      steps.push(made);
    }
    // What the day had planned for this material: a command of the owner is applied at once, and
    // what the agent concludes about new and changed items waits for a decision.
    const typed: string[] = [];
    for (const { intent, channel } of assigned) {
      const byCommand = channel === "command";
      const head = step(intent, byCommand ? "auto" : "accept", {
        origin: byCommand ? "command" : "inference",
        confidence: byCommand ? null : confidence(),
      });
      const chain = [
        head,
        ...intent.followers.map((next) => step(next, head.fate, { ...head, intent: next, needs: [head] })),
      ];
      steps.push(...chain);
      if (byCommand) {
        typed.push(intent.command);
        for (const made of chain) made.commandQuote = intent.command;
        continue;
      }
      const about = intent.about === null ? undefined : itemNow(intent.about);
      const filled = sentence(
        intent.signal,
        intent.signal === "person" ? (related[0]?.names[0] ?? "nowy projekt") : (about?.names[0] ?? intent.subject),
        about?.team ?? intent.team,
        about?.fields.externalKey ?? null,
        intent.newName,
      );
      for (const made of chain) made.quote = filled.text;
      if (intent.signal === "person" && intent.newName !== undefined) {
        // The new person is named in the text: the mention can be resolved once the person is there.
        const who = (): WorldPerson | undefined => created.get(intent.payload.person_id as PersonId);
        steps.push(
          step(resolveMention(capture, intent.newName, intent.newName, who), "accept", {
            quote: intent.newName,
            needs: [head],
            confidence: "low",
          }),
        );
      }
    }
    // What the material says about each item.
    for (const item of related) {
      const facts = (isNote ? 1 : 0) + r.weighted(scale.factsPerItem);
      for (let i = 0; i < facts; i++) {
        const stated = r.pick(BY_SIGNAL.fact);
        const filled = fill(
          r,
          stated,
          r.chance(0.3) ? r.pick(item.names) : (item.names[0] as string),
          item.team,
          item.fields.externalKey,
          people,
          undefined,
        );
        say(filled.text);
        named.push(...filled.named);
        const sure = confidence();
        const statement = r
          .pick(STATEMENTS[stated.type])
          .replace("{item}", item.names[0] as string)
          .replace("{thing}", filled.thing);
        const fact = addFact(r, capture, item, stated.type, filled.text, statement, filled.named);
        const made = step(fact, sure === "high" ? "auto" : inbox(), {
          confidence: sure,
          quote: filled.text,
          annotations: lowered(sure),
        });
        steps.push(made);
        if (r.chance(scale.supersedeShare)) {
          steps.push(
            step(supersedeFact(fact, item), r.chance(0.6) ? "auto" : inbox(), { quote: filled.text, needs: [made] }),
          );
        }
      }
      if (!item.pinned && r.chance(scale.statusProposalShare)) {
        const stated = r.pick(BY_SIGNAL.status);
        const filled = fill(r, stated, item.names[0] as string, item.team, item.fields.externalKey, people, undefined);
        say(filled.text);
        named.push(...filled.named);
        const to: ItemStatus = /zablokowane|blocked/.test(stated.text) ? "blocked" : "in_progress";
        steps.push(step(setField(item, "status", to), inbox(), { confidence: confidence(), quote: filled.text }));
      }
      if (shape !== "note" && shape !== "typed" && r.chance(0.6)) say(r.pick(FILLERS));
    }
    const first = related[0];
    if (first !== undefined && !first.pinned && r.chance(scale.rolePerCaptureShare)) {
      const who = r.pick(people);
      const filled = sentence("fact", first.names[0] as string, first.team, first.fields.externalKey);
      const role = r.pick(["requester", "stakeholder", "executor", "informed"] as const);
      steps.push(
        step(setItemPerson(first, who, role, r.chance(0.4) ? r.pick(EXPECTATIONS) : null), inbox(), {
          confidence: "low",
          quote: filled.text,
        }),
      );
    }
    if (related.length > 1 && r.chance(scale.questionShare)) {
      steps.push(step(answerAboutItem(related.slice(0, 2)), inbox(), { confidence: "low" }));
    }
    if (first !== undefined && r.chance(scale.unwantedTaskShare)) {
      const filled = sentence("task", first.names[0] as string, first.team, first.fields.externalKey);
      const unwanted = drawItem("task", day, first.team, undefined, undefined);
      unwanted.later = undefined;
      unwanted.closeAfter = undefined;
      unwanted.owner = undefined;
      steps.push(
        step(createItem(unwanted, first), "reject", {
          confidence: "low",
          quote: filled.text,
          annotations: [{ code: "duplicate_candidates", items: [first.fields.id] }],
        }),
      );
    }
    // Most of a thread is talk that gives the agent nothing to do; most of a note is prose. What the
    // owner types is short.
    const talk =
      shape === "typed" ? r.int(0, 1) : isNote ? r.int(8, 28) : Math.min(40, Math.round(r.logNormal(7, 0.7)));
    // Material is never empty: at the least it is one line of talk.
    for (let i = Math.max(talk, lines.length === 0 ? 1 : 0); i > 0; i--) {
      say(isNote ? r.pick(NOTE_PROSE) : r.pick(FILLERS));
    }
    const body = lines.join(shape === "note" ? " " : "\n");

    // Who is named: the authors of the lines, and everyone a sentence names. Each person once.
    const mentioned = new Set<WorldPerson>();
    const mentions: Step[] = [];
    const mention = (who: Named): void => {
      if (mentioned.has(who.person) || !body.includes(who.surface)) return;
      mentioned.add(who.person);
      // A short name that several persons answer to cannot be resolved without asking.
      const ambiguous =
        who.surface !== who.person.fields.name &&
        (sameShort.get(who.base) ?? 0) > 1 &&
        r.chance(scale.ambiguousMentionShare);
      const recorded = resolveMention(capture, who.surface, who.base, ambiguous ? undefined : who.person);
      const made = step(recorded, "auto", { confidence: ambiguous ? "low" : "high", quote: who.surface });
      mentions.push(made);
      if (ambiguous) {
        const candidates = persons.filter((person) => person.short === who.base).slice(0, 5);
        mentions.push(
          step(answerMention(recorded, candidates, r), inbox(), {
            confidence: "low",
            quote: who.surface,
            needs: [made],
          }),
        );
      }
    };
    for (const author of authors) mention({ person: author, surface: author.fields.name, base: author.fields.name });
    for (const who of named) mention(who);
    // Mentions come first on the card, as the agent reads the material before it concludes anything.
    steps.unshift(...mentions);
    for (const made of steps) {
      if (r.chance(scale.invalidShare) && made.origin === "inference" && made.needs.length === 0) made.fate = "invalid";
    }

    // The parts, in the order the owner put them.
    const files: WorldFile[] = [];
    let derived: Script["derived"];
    const part = (kind: PartKind, text: string | null, file: WorldFile | null, fileName: string | null): WorldPart => {
      const made: WorldPart = { id: newId("capturePart"), position: capture.parts.length, kind, text, file, fileName };
      capture.parts.push(made);
      return made;
    };
    const fileOf = (mediaType: string): WorldFile => {
      // Now and then the same picture is dropped a second time: its original is stored once.
      if (mediaType === "image/png" && lastScreenshot !== undefined && r.chance(0.01)) return lastScreenshot;
      const sha256 = Array.from({ length: 8 }, () => r.u32().toString(16).padStart(8, "0")).join("");
      return {
        sha256,
        byteSize: Math.round(r.logNormal(mediaType === "image/png" ? 380_000 : 6_000, 0.6)),
        mediaType,
        createdAt: savedAt,
      };
    };
    if (shape === "mixed") part("typed", typed.length > 0 ? typed.join("\n") : r.pick(REMARKS), null, null);
    if (shape === "screenshot") {
      const file = fileOf("image/png");
      lastScreenshot = file;
      files.push(file);
      const name = r.chance(0.5) ? `Zrzut ekranu ${dayOf(savedAt)} ${String(index).padStart(2, "0")}.png` : null;
      derived = { part: part("image", null, file, name), origin: "transcription", text: body };
    } else if (shape === "file") {
      const file = fileOf("text/markdown");
      files.push(file);
      derived = { part: part("file", null, file, `notatki-${dayOf(savedAt)}.md`), origin: "extraction", text: body };
    } else if (shape === "typed") part("typed", typed.length > 0 ? `${typed.join("\n")}\n${body}` : body, null, null);
    else part("pasted", body, null, null);

    const job: WorldJob = {
      id: newId("job"),
      kind: "process_capture",
      state: "queued",
      sourceId: capture.id,
      dedupeKey: `process_capture:${capture.id}`,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      runAfter: savedAt,
      leasedUntil: null,
      createdAt: savedAt,
      startedAt: null,
      finishedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      payload: { capture_id: capture.id },
    };
    const claimedAt = savedAt + r.int(300, 20_000);
    const runAt = claimedAt + (derived?.origin === "transcription" ? r.int(4_000, 12_000) : r.int(20, 200));
    const draw = r.next();
    return {
      capture,
      files,
      derived,
      job,
      steps,
      planned: assigned.map(({ intent }) => intent),
      summary: `Powiązano z ${related.length} itemami.`,
      attempt:
        tail === "retry"
          ? "interrupted"
          : tail !== "none"
            ? "ok"
            : draw < scale.failedShare
              ? "failed"
              : draw < scale.failedShare + scale.interruptedShare
                ? "interrupted"
                : "ok",
      tail,
      forgotten: r.chance(scale.forgottenCardShare),
      keepsInvalid: false,
      reprocessed: r.chance(scale.reprocessedShare),
      corrected: derived?.origin === "transcription" && (shown !== undefined || r.chance(scale.correctionShare)),
      r,
      claimedAt,
      runAt,
      endAt: runAt + Math.round(r.logNormal(14_000, 0.5)),
      model: r.pick(MODELS),
      promptVersion: `process-capture@${1 + Math.min(3, Math.floor((4 * day) / Math.max(1, scale.days)))}`,
      staged: [],
    };
  }

  /** The owner drops the material: it is stored as it came, with the job that will process it. */
  function save(script: Script): void {
    for (const file of script.files) sink.file(file);
    sink.capture(script.capture);
    sink.job(script.job);
    waiting.add(script);
  }

  function call(
    r: Rng,
    owner: { runId: RunId | null; jobId: JobId | null },
    purpose: ModelPurpose,
    role: ModelRole,
    model: string,
    startedAt: number,
    durationMs: number,
    last: boolean,
  ): WorldModelCall {
    const failed = r.chance(0.015);
    const error = failed ? r.pick(CALL_ERRORS) : undefined;
    const made: WorldModelCall = {
      id: ++modelCalls,
      runId: owner.runId,
      jobId: owner.jobId,
      role,
      purpose,
      model,
      promptVersion: purpose === "agent_turn" ? null : `${purpose}@1`,
      startedAt,
      durationMs,
      firstTokenMs: failed ? null : Math.min(durationMs, r.int(300, 1_500)),
      inputTokens: failed ? null : r.int(600, 2_400),
      outputTokens: failed ? null : r.int(150, 1_600),
      cacheReadInputTokens: failed ? null : r.int(0, 14_000),
      cacheCreationInputTokens: failed ? null : r.int(0, 900),
      httpStatus: error === undefined ? 200 : error[2],
      stopReason: failed ? null : last ? "end_turn" : "tool_use",
      requestId: failed && error?.[2] === null ? null : `req_${r.u32().toString(36)}${r.u32().toString(36)}`,
      errorType: error?.[0] ?? null,
      errorMessage: error?.[1] ?? null,
      detail: !failed && r.chance(0.03) ? { retriedWithoutThinking: true } : null,
    };
    sink.modelCall(made);
    return made;
  }

  function claim(job: WorldJob, instant: number): void {
    job.state = "running";
    job.attempts += 1;
    job.startedAt = instant;
    job.leasedUntil = instant + LEASE;
    sink.jobChanged(job);
  }
  function newRun(script: Script, startedAt: number): WorldRun {
    const run: WorldRun = {
      id: newId("run"),
      kind: "process_capture",
      state: "running",
      sourceId: script.capture.id,
      jobId: script.job.id,
      model: script.model,
      promptVersion: script.promptVersion,
      startedAt,
      endedAt: null,
      errorCode: null,
      errorMessage: null,
      summary: null,
    };
    sink.run(run);
    return run;
  }
  function stage(script: Script, run: WorldRun, made: Step, seq: number, createdAt: number, needs: Staged[]): Staged {
    const staged: Staged = {
      ...operation(made.intent.kind, made.origin, createdAt, made.intent.payload),
      runId: run.id,
      seq,
      state: "staged",
      confidence: made.confidence,
      sourceId: script.capture.id,
      quote: made.quote,
      commandQuote: made.commandQuote,
      rationale: made.origin === "command" ? null : script.r.pick(RATIONALES),
      annotations: made.annotations,
      intent: made.intent,
      fate: made.fate,
      needs,
      dependants: [],
    };
    for (const need of needs) need.dependants.push(staged);
    sink.operation(staged, needs);
    return staged;
  }
  /** The text of the part that is no text itself, written when the job is taken up. */
  function derive(script: Script, upTo: number): void {
    if (script.derived === undefined) return;
    let modelCallId: number | null = null;
    if (script.derived.origin === "transcription") {
      if (script.runAt > upTo) return;
      const duration = script.runAt - script.claimedAt - 10;
      modelCallId = call(
        script.r,
        { runId: null, jobId: script.job.id },
        "transcription",
        "processing",
        script.model,
        script.claimedAt,
        duration,
        true,
      ).id;
    }
    sink.partText({
      id: newId("capturePartText"),
      partId: script.derived.part.id,
      revision: 1,
      origin: script.derived.origin,
      modelCallId,
      createdAt: script.runAt - 5,
      structure:
        script.derived.origin === "transcription"
          ? { messages: script.derived.text.split("\n").length, date_visible: false }
          : null,
      text: script.derived.text,
    });
  }

  /** The whole processing of a capture, from the claim of its job to the end of its run. */
  function process(script: Script): void {
    waiting.delete(script);
    const { r, job } = script;
    claim(job, script.claimedAt);
    derive(script, script.runAt);
    let runAt = script.runAt;
    if (script.attempt === "interrupted") {
      // The process dies in the middle of the first attempt. The next start ends the run it left
      // behind, which takes along what it staged, and the job waits for its second attempt.
      const left = newRun(script, runAt);
      const first = script.steps[0];
      const diedAt = runAt + r.int(2_000, 9_000);
      call(r, { runId: left.id, jobId: null }, "agent_turn", "processing", script.model, runAt, 800, false);
      if (first !== undefined) stage(script, left, first, 0, runAt + 900, []);
      left.state = "failed";
      left.endedAt = diedAt;
      left.errorCode = "interrupted";
      sink.runEnded(left);
      job.state = "queued";
      job.leasedUntil = null;
      job.runAfter = diedAt + 30 * SECOND;
      job.lastErrorCode = "interrupted";
      sink.jobChanged(job);
      if (script.tail === "retry") return;
      claim(job, job.runAfter);
      runAt = job.runAfter + r.int(20, 200);
    }
    const run = newRun(script, runAt);
    const endAt = runAt + (script.endAt - script.runAt);
    const turns = 2 + Math.min(4, Math.floor(-Math.log(1 - r.next()) / 0.75));
    const turn = Math.floor((endAt - runAt) / turns);
    for (let i = 0; i < turns; i++) {
      call(
        r,
        { runId: run.id, jobId: null },
        "agent_turn",
        "processing",
        script.model,
        runAt + i * turn,
        turn - 5,
        i === turns - 1,
      );
    }
    if (script.attempt === "failed") {
      // A run that fails for good leaves nothing, and the capture stays in the state of an error.
      const [code, message] = r.pick(RUN_ERRORS);
      run.state = "failed";
      run.endedAt = endAt;
      run.errorCode = code;
      run.errorMessage = message;
      sink.runEnded(run);
      job.state = "failed";
      job.leasedUntil = null;
      job.finishedAt = endAt + 5;
      job.lastErrorCode = code;
      job.lastErrorMessage = message;
      sink.jobChanged(job);
      // What the material was to bring about, the owner does by hand the day after.
      for (const intent of script.planned) {
        plan(dayIndex(endAt) + 1, { make: () => intent, channels: NO_CHANNEL, r });
      }
      return;
    }
    const staged = new Map<Step, Staged>();
    script.steps.forEach((made, seq) => {
      const needs = made.needs.flatMap((need) => staged.get(need) ?? []);
      const createdAt = runAt + Math.floor(((endAt - runAt) * (seq + 1)) / (script.steps.length + 1));
      staged.set(made, stage(script, run, made, seq, createdAt, needs));
    });
    script.staged = [...staged.values()];
    run.state = "committed";
    run.endedAt = endAt;
    run.summary = script.summary;
    sink.runEnded(run);
    settle(script, endAt);
    job.state = "done";
    job.leasedUntil = null;
    job.finishedAt = stamp(endAt);
    sink.jobChanged(job);

    if (script.corrected && script.derived !== undefined) {
      const { part, text } = script.derived;
      const correctedAt = endAt + r.int(60, 900) * SECOND;
      at(correctedAt, () =>
        sink.partText({
          id: newId("capturePartText"),
          partId: part.id,
          revision: 2,
          origin: "correction",
          modelCallId: null,
          createdAt: correctedAt,
          structure: null,
          text: `${text}\n[poprawiono po przeczytaniu]`,
        }),
      );
    }
    if (script.reprocessed) {
      const againAt = endAt + r.int(1, 20) * HOUR;
      at(againAt, () => processAgain(script, againAt));
    }
  }

  /** Every staged operation moves on once its run has committed: applied, to the Inbox, or failed for good. */
  function settle(script: Script, committedAt: number): void {
    const { r } = script;
    for (const staged of script.staged) {
      if (staged.fate === "invalid") {
        staged.state = "invalid";
        staged.problems = [{ code: "quote_not_found" }];
        sink.operationMoved(staged);
        continue;
      }
      const ready = staged.needs.every((need) => need.state === "applied");
      if (staged.fate === "auto" && ready) {
        if (apply(staged, committedAt, staged.origin === "command" ? "command" : "auto")) {
          if (staged.origin === "inference" && r.chance(scale.undoneShare)) {
            const undoneAt = committedAt + r.int(60, 7_200) * SECOND;
            at(undoneAt, () => undo(staged, staged.intent, undoneAt));
          }
          continue;
        }
        staged.state = "invalid";
        staged.problems = [{ code: "target_gone" }];
        sink.operationMoved(staged);
        continue;
      }
      // What was to be applied at once and follows something that waits, waits with it.
      if (staged.fate === "auto") staged.fate = "accept";
      staged.state = "proposed";
      sink.operationMoved(staged);
    }
    if (!script.staged.some(({ state }) => state === "proposed" || state === "invalid")) return;
    // The cards of the last hours are still to be decided, and now and then one is forgotten.
    if (script.forgotten || committedAt > now - scale.openCardHours * HOUR) {
      openCards.push(script);
      return;
    }
    const decideAt = Math.min(now - MINUTE, committedAt + Math.round(r.logNormal(scale.decisionMedianHours * HOUR, 1)));
    at(decideAt, () => decide(script, decideAt));
  }

  /** The owner goes through a card: every proposal is accepted or rejected, in the order of the card. */
  function decide(script: Script, instant: number): void {
    const { r } = script;
    for (const staged of script.staged) {
      if (staged.state === "invalid") {
        // What failed the checks is thrown away by hand, but for the few that are left lying.
        if (!script.keepsInvalid && r.chance(scale.rejectedInvalidShare)) reject(staged, instant);
        continue;
      }
      if (staged.state !== "proposed") continue;
      if (staged.needs.some((need) => need.state !== "applied")) {
        // What it was to follow did not come about.
        if (staged.needs.some((need) => need.state === "rejected")) reject(staged, instant);
        continue;
      }
      if (staged.fate === "wait") continue;
      if (staged.fate === "reject") {
        reject(staged, instant);
        continue;
      }
      if (staged.kind === "add_fact" && r.chance(scale.amendedShare)) {
        // The owner changes a field on the card before accepting: what the agent proposed is kept beside it.
        const proposed = staged.payload as { type?: FactType };
        staged.proposedPayload = staged.payload;
        staged.payload = { ...staged.payload, type: r.pick(FACT_TYPES.filter((type) => type !== proposed.type)) };
      }
      if (!apply(staged, instant, "accepted")) {
        staged.proposedPayload = null;
        reject(staged, instant);
        continue;
      }
      if (staged.kind === "create_item" && r.chance(scale.undoneCreationShare)) {
        const undoneAt = instant + r.int(60, 3_600) * SECOND;
        at(undoneAt, () => undo(staged, staged.intent, undoneAt, true));
      }
    }
    if (script.staged.some(({ state }) => state === "proposed")) openCards.push(script);
  }

  /** The capture is processed a second time on request, which finds nothing that is new. */
  function processAgain(script: Script, requestedAt: number): void {
    const { r } = script;
    const job: WorldJob = {
      ...script.job,
      id: newId("job"),
      state: "queued",
      attempts: 0,
      runAfter: requestedAt,
      leasedUntil: null,
      createdAt: requestedAt,
      startedAt: null,
      finishedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      payload: { capture_id: script.capture.id, again: true },
    };
    sink.job(job);
    claim(job, requestedAt + r.int(300, 5_000));
    const again = { ...script, job };
    const run = newRun(again, (job.startedAt as number) + 50);
    const turn = Math.round(r.logNormal(4_500, 0.4));
    for (let i = 0; i < 2; i++) {
      call(
        r,
        { runId: run.id, jobId: null },
        "agent_turn",
        "processing",
        script.model,
        run.startedAt + i * turn,
        turn - 5,
        i === 1,
      );
    }
    run.state = "committed";
    run.endedAt = run.startedAt + 2 * turn;
    run.summary = "Bez nowych propozycji.";
    sink.runEnded(run);
    job.state = "done";
    job.leasedUntil = null;
    job.finishedAt = run.endedAt + 5;
    sink.jobChanged(job);
  }

  /** Where "now" finds a capture whose processing has begun and not ended. */
  function leaveUnderWay(script: Script): void {
    const { r, job } = script;
    if (script.tail === "retry") {
      process(script);
      return;
    }
    if (script.tail !== "processing") return;
    waiting.delete(script);
    claim(job, script.claimedAt);
    derive(script, now);
    if (script.runAt > now) return;
    const run = newRun(script, script.runAt);
    call(
      r,
      { runId: run.id, jobId: null },
      "agent_turn",
      "processing",
      script.model,
      script.runAt,
      Math.max(1, now - script.runAt - 500),
      false,
    );
    // What the agent has staged so far: nothing of it has an effect, and no view reads it.
    const staged = new Map<Step, Staged>();
    script.steps.slice(0, Math.max(2, Math.ceil(script.steps.length / 2))).forEach((made, seq) => {
      const needs = made.needs.flatMap((need) => staged.get(need) ?? []);
      staged.set(made, stage(script, run, made, seq, Math.min(now - 100 + seq, script.runAt + 500 * (seq + 1)), needs));
    });
  }

  // ---- the days ----
  /** The persons of the first day, and the projects the hub starts with. */
  function setUp(): void {
    const morning = start + 6 * HOUR;
    for (let index = 0; index < scale.personsStart; index++) {
      byHand(createPerson(drawPerson(index)), morning + index * 5 * SECOND);
    }
    nextPerson = scale.personsStart;
    const afterPersons = morning + scale.personsStart * 5 * SECOND;
    byHand(createProject(0, true, true), afterPersons + MINUTE);
    exhibits(afterPersons + 2 * MINUTE);
    for (let index = 1; index < scale.activeProjects; index++) {
      byHand(createProject(0, index < scale.flagshipProjects), afterPersons + (30 + index) * MINUTE);
    }
  }
  let nextPerson = 0;

  /**
   * The items that are here to show a shape, the same at every scale, so that the smallest world
   * holds every shape too: a chain of eight levels, a task that stands alone with a tree of its
   * own, a subtree that was moved, an open task under a closed one, an item of every kind of
   * schedule, a task in every health, a merged item and a merged person, and a capture whose
   * operations end in every state.
   */
  function exhibits(from: number): void {
    let steps = 0;
    const next = (): number => from + ++steps * 10 * SECOND;
    const team = TEAMS[TEAMS.length - 1] as Team;
    const owner = me as WorldPerson;
    const helper = persons[1] ?? owner;
    const shown = (kind: ItemKind, title: string, more: Partial<ItemSpec> = {}): ItemSpec => ({
      kind,
      title,
      team,
      status: "todo",
      importance: DEFAULT_ITEM_IMPORTANCE,
      health: null,
      assessments: [],
      myRole: null,
      startOn: null,
      startOnPrecision: null,
      dueOn: null,
      dueOnPrecision: null,
      isMilestone: false,
      externalKey: null,
      aliases: [],
      plan: [],
      childDelay: scale.childDelayDays,
      closeAfter: undefined,
      pinned: true,
      later: undefined,
      markLater: false,
      owner: undefined,
      ...more,
    });
    const make = (spec: ItemSpec, under: WorldItem | null): WorldItem => {
      const intent = createItem(spec, under);
      byHand(intent, next());
      return items.get(intent.payload.item_id as ItemId) as WorldItem;
    };
    const day = (offset: number): Day => addDays(today, offset);

    // An office move: a project that is no software, with dated work, points in time and rough dates.
    const move = make(
      shown("project", "Przeprowadzka biura", {
        status: "in_progress",
        health: "yellow",
        myRole: "delegating",
        importance: "high",
        startOn: periodStart(today, "quarter"),
        startOnPrecision: "quarter",
        dueOn: periodEnd(day(60), "quarter"),
        dueOnPrecision: "quarter",
        aliases: ["PB"],
        owner,
      }),
      null,
    );
    byHand(setItemPerson(move, helper, "stakeholder", EXPECTATIONS[0] as string), next());
    byHand(describe(move, streams.stream("exhibit", 0)), next());
    // The chain of eight levels: each task sits under the one before it.
    const chain = [
      "Nowa siedziba",
      "Piętro trzecie",
      "Strefa zespołów",
      "Sala Bałtyk",
      "Wyposażenie sali",
      "Sprzęt audiowizualny",
      "Ekran",
    ].reduce<WorldItem[]>((made, title) => {
      made.push(make(shown("task", title, { status: "in_progress" }), made.at(-1) ?? move));
      return made;
    }, []);
    // A milestone at the eighth level: the mark is no matter of depth.
    make(shown("task", "Montaż ekranu zakończony", { isMilestone: true, dueOn: day(30) }), chain.at(-1) as WorldItem);

    // A task is assessed like a project: this one is doing well, and was created with that.
    const packing = make(
      shown("task", "Pakowanie archiwum", { startOn: day(-3), dueOn: day(4), myRole: "watching", health: "green" }),
      move,
    );
    const boxes = make(shown("task", "Zamówić kartony", { dueOn: today, myRole: "doing", owner }), move);
    make(shown("task", "Negocjacje z wynajmującym", { startOn: day(7) }), move);
    // Blocked, and not assessed: the status of a task says nothing of its health.
    make(shown("task", "Przegląd instalacji", { startOn: day(2), dueOn: day(-1), status: "blocked" }), move);
    const lease = make(
      shown("task", "Podpisanie umowy najmu", {
        isMilestone: true,
        dueOn: day(-1),
        importance: "high",
        health: "yellow",
      }),
      move,
    );
    make(shown("task", "Otwarcie biura", { isMilestone: true }), move);
    make(shown("task", "Przeprowadzka serwerowni", { dueOn: day(20), dueOnPrecision: "approximate" }), move);
    const fitOut = make(
      shown("task", "Wykończenie wnętrz", { dueOn: periodEnd(day(10), "week"), dueOnPrecision: "week" }),
      move,
    );
    make(shown("task", "Montaż mebli", { startOn: periodStart(day(17), "week"), startOnPrecision: "week" }), move);
    make(
      shown("task", "Zamówienie mebli", { startOn: periodStart(day(35), "month"), startOnPrecision: "month" }),
      move,
    );
    make(shown("task", "Odbiór techniczny", { dueOn: periodEnd(day(60), "quarter"), dueOnPrecision: "quarter" }), move);
    make(
      shown("task", "Wypowiedzenie starej umowy", { startOn: periodStart(day(120), "half"), startOnPrecision: "half" }),
      move,
    );
    make(shown("task", "Rozliczenie kosztów", { dueOn: periodEnd(today, "year"), dueOnPrecision: "year" }), move);
    make(
      shown("task", "Okablowanie", {
        startOn: periodStart(day(100), "quarter"),
        startOnPrecision: "quarter",
        dueOn: periodEnd(day(100), "quarter"),
        dueOnPrecision: "quarter",
      }),
      move,
    );
    const keys = make(shown("task", "Odbiór kluczy", { startOn: day(10), dueOn: day(12) }), move);

    // A task that stands alone, with a tree of its own.
    const budget = make(
      shown("task", "Budżet działu na przyszły rok", { myRole: "doing", dueOn: day(25), owner }),
      null,
    );
    const figures = make(shown("task", "Zebrać dane z zespołów", { dueOn: day(10) }), budget);
    make(shown("task", "Arkusz kosztów", {}), figures);
    make(shown("task", "Założenia do planu zatrudnienia", { importance: "low" }), budget);

    // A subtree that will be moved, an item that will be closed above an open one, and a duplicate.
    const furniture = make(shown("task", "Wybór dostawcy mebli", { status: "in_progress" }), chain[0] as WorldItem);
    make(shown("task", "Oferta pierwsza", {}), furniture);
    make(shown("task", "Oferta druga", {}), furniture);
    const inventory = make(shown("task", "Inwentaryzacja", { status: "in_progress" }), move);
    make(shown("task", "Lista sprzętu do utylizacji", { myRole: "waiting" }), inventory);
    const again = make(shown("task", "Zamówić kartony do pakowania", { aliases: ["kartony"] }), move);
    boxes.rows = { links: [], facts: [] };
    again.rows = { links: [], facts: [] };
    byHand(setItemPerson(again, helper, "executor", null), next());
    byHand(describe(again, streams.stream("exhibit", 1)), next());
    make(shown("task", "Kartony na dokumenty", {}), again);

    // A person who was entered twice.
    const twice = createPerson({
      given: helper.given,
      name: `${helper.short === helper.given.forms[0] ? `${helper.short.charAt(0)}.` : helper.short} ${helper.fields.name.split(" ").slice(1).join(" ")}`,
      team: helper.team,
      jobTitle: helper.fields.jobTitle ?? (JOB_TITLES[0] as string),
      relation: null,
      isMe: false,
      aliases: [{ alias: `${helper.short} z ${team.name}`, context: team.name }],
      duplicateOf: helper,
    });
    byHand(twice, next());
    const double = created.get(twice.payload.person_id as PersonId) as WorldPerson;
    byHand(setItemPerson(inventory, double, "informed", null), next());

    // A capture whose operations end in every state the journal knows.
    const savedAt = start + 9 * HOUR;
    at(savedAt, () => {
      const script = exhibitCapture(savedAt, move, again, double);
      save(script);
      at(script.endAt, () => process(script));
    });

    // What the owner changes by hand in the afternoon, each change one operation.
    const noon = start + 12 * HOUR;
    const then = (minutes: number, intent: () => Intent | undefined): void =>
      at(noon + minutes * MINUTE, () => {
        const made = intent();
        if (made !== undefined) byHand(made, noon + minutes * MINUTE);
      });
    // A day known to the week gets an exact day: the day moves and its precision goes.
    then(0, () => moveDays(fitOut, streams.stream("exhibit", 2), { both: false, exact: true }));
    // Both days of a period move together.
    then(5, () => moveDays(packing, streams.stream("exhibit", 3), { both: true, exact: true }));
    then(10, () => markMilestone(keys));
    then(15, () => setField(boxes, "importance", "high"));
    then(20, () => moveItem(furniture, streams.stream("exhibit", 4), move));
    then(25, () => closeItem(inventory, "done"));
    // A change that is taken back: both stay in the journal.
    at(noon + 30 * MINUTE, () => {
      const changed = setField(budget, "title", "Budżet działu na rok 2027");
      const made = byHand(changed, noon + 30 * MINUTE);
      if (made !== undefined) at(noon + 40 * MINUTE, () => undo(made, changed, noon + 40 * MINUTE));
    });
    // A role that is set a second time as it stands: the operation concerned the row and changed nothing.
    then(45, () => setItemPerson(move, helper, "stakeholder", EXPECTATIONS[0] as string));
    // How two tasks are doing: a task under a task is assessed for the first time, and the
    // milestone that was missed goes from yellow to red.
    const assessed = (minutes: number, item: WorldItem, health: ItemHealth): void =>
      at(noon + minutes * MINUTE, () => assess(item, health, noon + minutes * MINUTE));
    assessed(50, chain[4] as WorldItem, "yellow");
    assessed(55, lease, "red");
    then(240, () => mergeItems(again, boxes));
    then(250, () => mergePeople(double, helper));
  }

  /** The capture of the exhibits: a typed command beside a pasted thread, processed in two attempts. */
  function exhibitCapture(savedAt: number, project: WorldItem, duplicate: WorldItem, double: WorldPerson): Script {
    const r = streams.stream("exhibit", 5);
    const owner = me as WorldPerson;
    const helper = persons[1] ?? owner;
    const capture: WorldCapture = {
      id: newId("capture"),
      createdAt: savedAt,
      occurredOn: dayOf(savedAt),
      occurredOnApproximate: true,
      parts: [],
    };
    const command = "dodaj zadanie: zamówić wycenę przeprowadzki w Przeprowadzka biura";
    const risk = `Ryzyko: ${project.fields.title} może nie zdążyć do końca miesiąca, wciąż brakuje nam umowy z dostawcą.`;
    const cartons = `Kartony zamawia ${double.fields.name}, potrzebujemy ich na piątek.`;
    const blocked = `${project.fields.title} zablokowane, czekamy na zespół ${project.team.name}.`;
    const stranger = "Do zespołu dołącza Ignacy Sobczak, od przyszłego tygodnia pomaga przy przeprowadzce.";
    const body = [
      `[09:02] ${helper.fields.name}: ${risk}`,
      `[09:04] ${owner.fields.name}: ${cartons}`,
      `[09:05] ${helper.fields.name}: ${blocked}`,
      `[09:07] ${helper.fields.name}: ${stranger}`,
      `[09:08] ${owner.fields.name}: ok, dzięki`,
    ].join("\n");
    capture.parts.push({
      id: newId("capturePart"),
      position: 0,
      kind: "typed",
      text: command,
      file: null,
      fileName: null,
    });
    capture.parts.push({
      id: newId("capturePart"),
      position: 1,
      kind: "pasted",
      text: body,
      file: null,
      fileName: null,
    });

    const linked = new Set<WorldItem>();
    const quote = (text: string, more: Partial<Step> = {}): Partial<Step> => ({ quote: text, ...more });
    const link = step(linkSource(capture, project, linked), "auto");
    const linkDuplicate = step(linkSource(capture, duplicate, linked), "auto");
    const fact = addFact(r, capture, project, "risk", risk, "Brak umowy z dostawcą może przesunąć przeprowadzkę.", []);
    const factStep = step(fact, "auto", quote(risk, { needs: [link] }));
    const duplicateFact = step(
      addFact(r, capture, duplicate, "info", cartons, "Kartony są potrzebne na piątek.", [
        { person: double, surface: double.fields.name, base: double.fields.name },
      ]),
      "auto",
      quote(cartons),
    );
    const wanted: ItemSpec = {
      ...drawItem("task", 0, project.team, undefined, "Zamówić wycenę przeprowadzki"),
      pinned: true,
      later: undefined,
      closeAfter: undefined,
      owner: undefined,
    };
    const commanded = step(createItem(wanted, project), "auto", {
      origin: "command",
      confidence: null,
      commandQuote: command,
    });
    // Waits in the Inbox for good: the owner decided the rest of the card and never came back to it.
    const status = step(setField(project, "status", "blocked"), "wait", quote(blocked, { confidence: "low" }));
    const unknown = drawPerson(scale.personsEnd + 1);
    unknown.name = "Ignacy Sobczak";
    const person = step(createPerson(unknown), "reject", quote(stranger, { confidence: "low" }));
    const follows = step(
      resolveMention(capture, "Ignacy Sobczak", "Ignacy Sobczak", () => undefined),
      "accept",
      quote("Ignacy Sobczak", { needs: [person], confidence: "low" }),
    );
    const mentions = [
      step(resolveMention(capture, helper.fields.name, helper.fields.name, helper), "auto", quote(helper.fields.name)),
      step(resolveMention(capture, owner.fields.name, owner.fields.name, owner), "auto", quote(owner.fields.name)),
      step(resolveMention(capture, double.fields.name, double.fields.name, double), "auto", quote(double.fields.name)),
    ];
    const lost = step(
      addFact(r, capture, project, "decision", "Tego zdania nie ma w materiale.", "Decyzja bez pokrycia.", []),
      "invalid",
      quote("Tego zdania nie ma w materiale."),
    );
    const claimedAt = savedAt + 2 * SECOND;
    return {
      capture,
      files: [],
      derived: undefined,
      job: {
        id: newId("job"),
        kind: "process_capture",
        state: "queued",
        sourceId: capture.id,
        dedupeKey: `process_capture:${capture.id}`,
        attempts: 0,
        maxAttempts: MAX_ATTEMPTS,
        runAfter: savedAt,
        leasedUntil: null,
        createdAt: savedAt,
        startedAt: null,
        finishedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        payload: { capture_id: capture.id },
      },
      steps: [...mentions, link, linkDuplicate, factStep, duplicateFact, commanded, status, person, follows, lost],
      planned: [],
      summary: "Ryzyko w projekcie, zadanie z polecenia i pytanie o nową osobę.",
      attempt: "interrupted",
      tail: "none",
      forgotten: false,
      keepsInvalid: true,
      reprocessed: false,
      corrected: false,
      r,
      claimedAt,
      runAt: claimedAt + 100,
      endAt: claimedAt + 12 * SECOND,
      model: MODELS[0] as string,
      promptVersion: "process-capture@1",
      staged: [],
    };
  }

  function day(index: number): void {
    const dayStart = start + index * DAY_MS;
    const last = index === scale.days - 1;
    const dayEnd = last ? now + 1 : dayStart + DAY_MS;
    const r = streams.stream("day", index);
    if (index === 0) at(dayStart, setUp);

    // New persons join steadily until the last day.
    at(dayStart + 6 * HOUR + 50 * MINUTE, () => {
      const due = scale.personsStart + Math.floor(((scale.personsEnd - scale.personsStart) * (index + 1)) / scale.days);
      while (nextPerson < due) {
        const spec = drawPerson(nextPerson++);
        plan(index, {
          make: () => createPerson(spec),
          channels: { hand: 1 - scale.personProposedShare, command: 0, agent: scale.personProposedShare },
          r: streams.stream("joins", nextPerson),
        });
      }
      // Tasks that belong to no project.
      for (
        let count = Math.floor(scale.looseTasksPerDay) + (r.chance(scale.looseTasksPerDay % 1) ? 1 : 0);
        count > 0;
        count--
      ) {
        const stream = streams.stream("loose", index, count);
        const shape = scale.looseTree;
        const tree = stream.chance(scale.looseTreeShare)
          ? growPlan(stream, shape, 1, stream.int(shape.top[0], shape.top[1]))
          : [];
        const spec = drawItem(
          "task",
          index,
          stream.pick(TEAMS),
          { plan: tree, childDelay: scale.childDelayDays },
          undefined,
        );
        plan(index, { make: () => createItem(spec, null), channels: scale.creationChannels, r: stream });
      }
      // Now and then something is entered a second time, and merged when that is noticed.
      if (r.chance(scale.duplicateItemsPerYear / 365)) duplicateItem(index, r);
      if (r.chance(scale.duplicatePersonsPerYear / 365)) duplicatePerson(index, r);
    });

    // The captures of the day, in the order of the clock, between half past seven and five. The
    // last ones of the last day are still waiting or being processed when the history ends.
    const perDay = scale.capturesPerDay + scale.notesPerDay;
    const noteEvery = Math.max(1, Math.round(perDay / Math.max(1, scale.notesPerDay)));
    const assigned: { intent: Intent; channel: "command" | "agent" }[][] = Array.from({ length: perDay }, () => []);
    at(dayStart + 7 * HOUR, () => {
      // What the day has planned: by hand at some hour, or brought by one of the day's captures.
      for (const entry of planned.get(index) ?? []) {
        const channel = channelOf(entry.r, entry.channels);
        if (channel === "hand" || perDay === 0) {
          const instant = dayStart + entry.r.int(8 * 3_600, 18 * 3_600) * SECOND;
          at(instant, () => {
            const intent = entry.make();
            if (intent !== undefined) byHand(intent, instant);
          });
          continue;
        }
        const intent = entry.make();
        // The first captures of the first day bring nothing that was planned: each of them shows a kind of material.
        const first = index === 0 ? Math.min(3, perDay - 1) : 0;
        if (intent !== undefined) assigned[entry.r.int(first, perDay - 1)]?.push({ intent, channel });
      }
      planned.delete(index);
    });
    const times = Array.from({ length: perDay }, () => dayStart + r.int(27_000, 61_200) * SECOND + r.int(0, 999)).sort(
      (a, b) => a - b,
    );
    for (let n = 0; n < perDay; n++) {
      // The last four captures of the history arrive in its last minutes: two still wait, one is
      // being processed, and one waits for its second attempt.
      const fromEnd = perDay - n;
      const tail: Script["tail"] = !last
        ? "none"
        : fromEnd <= 2
          ? "queued"
          : fromEnd === 3
            ? "processing"
            : fromEnd === 4
              ? "retry"
              : "none";
      const savedAt = !last
        ? (times[n] as number)
        : fromEnd <= 4
          ? now - fromEnd * 45 * SECOND
          : Math.min(times[n] as number, now - 5 * MINUTE);
      const isNote = scale.notesPerDay > 0 && n % noteEvery === 0;
      at(savedAt, () => {
        const script = compose(index, n, savedAt, isNote, assigned[n] ?? [], tail);
        if (tail === "processing") {
          // Its job is taken a moment before the end, and its run outlasts it.
          script.claimedAt = Math.max(savedAt + 300, now - 20 * SECOND);
          script.runAt = script.claimedAt + (script.derived?.origin === "transcription" ? 4_000 : 100);
          script.endAt = now + MINUTE;
        }
        save(script);
        if (tail === "none") at(script.endAt, () => process(script));
      });
    }

    // What the owner changes in the evening, beside what was planned.
    for (let i = 0; i < scale.userEditsPerDay; i++) {
      const instant = dayStart + 17 * HOUR + r.int(0, 5_400) * SECOND;
      at(instant, () => {
        const intent = ownEdit(r);
        if (intent !== undefined) byHand(intent, instant);
      });
    }
    // The summaries of items that changed today are written again.
    at(dayStart + 19 * HOUR, () => {
      const changed = [...changedToday].filter(isOpen);
      changedToday.clear();
      for (let i = 0; i < Math.min(scale.summariesPerDay, changed.length); i++) {
        summarise(changed[r.int(0, changed.length - 1)] as WorldItem, dayStart + 19 * HOUR + i * 20 * SECOND, r);
      }
    });

    for (let event = events[0]; event !== undefined && event.at < dayEnd; event = events[0]) {
      nextEvent();
      event.run();
    }
  }

  /**
   * The title as the owner changes it: with one of the marks they put behind a title, or without
   * the mark it has. One mark at most, however often the title of a busy item is changed, and
   * never the title as it is.
   */
  function retitled(title: string, r: Rng): string {
    const mark = TITLE_MARKS.find((candidate) => title.endsWith(` (${candidate})`));
    const bare = mark === undefined ? title : title.slice(0, -(mark.length + 3));
    return r.pick(
      [bare, ...TITLE_MARKS.map((candidate) => `${bare} (${candidate})`)].filter((other) => other !== title),
    );
  }

  /** One of the changes the owner makes without a plan: a role, a health, a title, a role of a person, the prose. */
  function ownEdit(r: Rng): Intent | undefined {
    const item = pickItem(r);
    if (item === undefined || item.pinned || !isOpen(item)) return undefined;
    const draw = r.next();
    if (draw < 0.35) {
      const roles = (["doing", "delegating", "waiting", "watching"] as const).filter(
        (role) => role !== item.fields.myRole,
      );
      const made = setField(item, "myRole", r.pick(roles));
      if (r.chance(scale.undoneShare * 2)) {
        // Now and then the owner takes a change of their own back.
        const apply = made.apply;
        made.apply = (changedAt, by) => {
          const changes = apply(changedAt, by);
          if (changes !== undefined) at(changedAt + 5 * MINUTE, () => undo(by, made, changedAt + 5 * MINUTE));
          return changes;
        };
      }
      return made;
    }
    // Of a project: how a task is doing is said from the task's own stream (assess()).
    if (draw < 0.5 && item.fields.kind === "project") {
      return setField(
        item,
        "health",
        r.pick((["green", "yellow", "red"] as const).filter((health) => health !== item.fields.health)),
      );
    }
    if (draw < 0.6) return setField(item, "title", retitled(item.fields.title, r));
    if (draw < 0.8)
      return setItemPerson(
        item,
        pickPerson(r),
        r.pick(["stakeholder", "executor", "informed", "requester"] as const),
        r.chance(0.5) ? r.pick(EXPECTATIONS) : null,
      );
    if (draw < 0.9) return describe(item, r);
    const person = pickPerson(r);
    // What the owner corrects in the directory: what a person does, or a name that holds in one team only.
    return r.chance(0.5)
      ? changePerson(person, r)
      : addPersonAlias(person, `${person.short} z ${person.team.name}`, person.team.name);
  }

  function summarise(item: WorldItem, instant: number, r: Rng): void {
    const job: WorldJob = {
      id: newId("job"),
      kind: "summarize_item",
      state: "queued",
      sourceId: null,
      dedupeKey: `summarize_item:${item.fields.id}`,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      runAfter: instant,
      leasedUntil: null,
      createdAt: instant - MINUTE,
      startedAt: null,
      finishedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      payload: { item_id: item.fields.id },
    };
    sink.job(job);
    claim(job, instant);
    call(r, { runId: null, jobId: job.id }, "summary", "synthesis", MODELS[0] as string, instant + 50, 6_000, true);
    job.state = "done";
    job.leasedUntil = null;
    job.finishedAt = instant + 6_100;
    sink.jobChanged(job);
  }

  /** A task is entered a second time by the agent, collects a little, and is merged into the first. */
  function duplicateItem(index: number, r: Rng): void {
    const first = openTasks[r.int(0, Math.max(0, openTasks.length - 1))];
    if (first === undefined || first.pinned || first.rows !== undefined) return;
    first.rows = { links: [], facts: [] };
    const spec = drawItem(
      "task",
      index,
      first.team,
      { plan: r.chance(0.5) ? [{ children: [] }] : [], childDelay: [1, 1] },
      `${first.fields.title} (${first.team.name})`,
    );
    spec.closeAfter = undefined;
    spec.later = undefined;
    const intent = createItem(spec, first.parent);
    const apply = intent.apply;
    intent.apply = (createdAt, by) => {
      const changes = apply(createdAt, by);
      const made = items.get(intent.payload.item_id as ItemId);
      if (changes === undefined || made === undefined) return changes;
      made.rows = { links: [], facts: [] };
      plan(dayIndex(createdAt) + r.int(scale.mergeDelayDays[0], scale.mergeDelayDays[1]), {
        make: () => mergeItems(made, first),
        channels: NO_CHANNEL,
        r,
      });
      return changes;
    };
    plan(index, { make: () => intent, channels: { hand: 0, command: 0, agent: 1 }, r });
  }

  /** A person is entered a second time under a short spelling, and is merged into the first. */
  function duplicatePerson(index: number, r: Rng): void {
    const first = persons[r.int(1, Math.max(1, persons.length - 1))];
    if (first === undefined) return;
    const surname = first.fields.name.split(" ").slice(1).join(" ");
    const name = `${first.short === first.given.forms[0] ? `${first.short.charAt(0)}.` : first.short} ${surname}`;
    if (usedNames.has(name)) return;
    usedNames.add(name);
    const intent = createPerson({
      given: first.given,
      name,
      team: first.team,
      jobTitle: first.fields.jobTitle ?? (JOB_TITLES[0] as string),
      relation: null,
      isMe: false,
      aliases: [],
      duplicateOf: first,
    });
    const apply = intent.apply;
    intent.apply = (createdAt, by) => {
      const changes = apply(createdAt, by);
      const made = created.get(intent.payload.person_id as PersonId);
      if (changes === undefined || made === undefined) return changes;
      plan(dayIndex(createdAt) + r.int(scale.mergeDelayDays[0], scale.mergeDelayDays[1]), {
        make: () => mergePeople(made, first),
        channels: NO_CHANNEL,
        r,
      });
      return changes;
    };
    plan(index, { make: () => intent, channels: { hand: 0, command: 0, agent: 1 }, r });
  }

  return {
    day,
    finish() {
      for (const script of [...waiting]) leaveUnderWay(script);
      // The newest capture whose card has something left to decide.
      const open = openCards
        .filter((script) => script.staged.some(({ state }) => state === "proposed"))
        .reduce<Script | undefined>(
          (newest, script) =>
            newest === undefined || script.capture.createdAt > newest.capture.createdAt ? script : newest,
          undefined,
        );
      if (me === undefined || outlier === undefined)
        throw new Error("The world has no owner or no project: it has not lived a day.");
      return { me: me.fields.id, busiestItem: outlier.fields.id, openCardSource: open?.capture.id };
    },
  };
}
