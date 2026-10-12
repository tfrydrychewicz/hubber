// Statements that the database must refuse and statements that it must accept: a case for every
// rule that the migrations write as a CHECK, as a trigger or as a foreign key. Nothing else holds
// the CHECKs and the triggers. They are hand-written SQL, no generator reads them, and the
// Drizzle declaration does not repeat them.
//
// A case gets a database of its own and judges one statement: it is accepted and writes a row,
// or it is refused for the reason the case names. The reason is part of the case. A statement
// that another rule refuses first would go on "failing as expected" after its own rule is gone.
//
// The last tests of the file ask the database for its triggers, CHECKs and foreign keys and name
// the ones that no case stands for.
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { foldName } from "../../shared/fold.ts";
import { ID_PREFIXES, type IdKind, idKindOf } from "../../shared/ids.ts";
import { parseDay, parseInstant } from "../../shared/time.ts";
import { DATE_PRECISIONS, DEFAULT_ITEM_IMPORTANCE, ITEM_IMPORTANCES } from "../../shared/vocabulary.ts";
import { MIGRATIONS_TABLE } from "./migrate.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";

type Connection = TestDatabase["connection"];
type Row = Record<string, unknown>;

interface Statement {
  sql: string;
  params: unknown[];
}

/** Why the database refused a statement. */
interface Refusal {
  code: string;
  message: string;
}

interface Case {
  label: string;
  statement: Statement;
  /** The reason of the refusal, or undefined for a statement that must be accepted. */
  refusal: Refusal | undefined;
  /** Rows that are written first, on top of those of the scene. */
  first: Statement[];
}

// ---------------------------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------------------------

const ACCEPTED = "accepted";

const databases: TestDatabase[] = [];

const closeDatabases = () => {
  for (const database of databases.splice(0)) database.close();
};

afterEach(closeDatabases);

/** What the database says to a statement: that it is accepted, or why not. */
function attempt(db: Connection, { sql, params }: Statement): Refusal | string {
  try {
    const { changes } = db.prepare(sql).run(...params);
    // A statement that wrote no row was judged by no rule. Without this an UPDATE with a misspelt
    // id would count as accepted.
    return changes > 0 ? ACCEPTED : "accepted, but no row was written";
  } catch (error) {
    if (error instanceof Database.SqliteError) return { code: error.code, message: error.message };
    throw error;
  }
}

/**
 * A database of its own that holds the rows of the statements. Each of them has to be accepted.
 * A function among them changes the database itself, when its turn comes.
 */
function given(...statements: (Statement | ((db: Connection) => void))[]): Connection {
  const database = createTestDatabase();
  databases.push(database);
  for (const statement of statements) {
    if (typeof statement === "function") {
      statement(database.connection);
      continue;
    }
    const outcome = attempt(database.connection, statement);
    if (outcome !== ACCEPTED) {
      throw new Error(
        `A row that the case starts from was not written: ${statement.sql} -> ${JSON.stringify(outcome)}`,
      );
    }
  }
  return database.connection;
}

/**
 * What the database says to each statement of one transaction in which the check of foreign keys
 * is put off to the commit: a row can then point at one that is not there yet. The transaction is
 * taken back.
 */
function deferred(db: Connection, ...statements: Statement[]): (Refusal | string)[] {
  db.exec("BEGIN");
  db.pragma("defer_foreign_keys = ON");
  const outcomes = statements.map((statement) => attempt(db, statement));
  db.exec("ROLLBACK");
  return outcomes;
}

/** The database without some of its triggers: for a rule that no statement reaches while they stand in front of it. */
const without =
  (...triggers: string[]) =>
  (db: Connection) => {
    for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger}`);
  };

/** A refusal that a case of this file expects, with all that leads up to it: for the last tests of the file. */
interface Expected {
  rows: Statement[];
  statement: Statement;
  refusal: Refusal;
  /** The triggers that the case drops first. */
  dropped: string[];
}
const expected: Expected[] = [];

const accepts = (label: string, statement: Statement): Case => ({ label, statement, refusal: undefined, first: [] });
const refuses = (label: string, refusal: Refusal, statement: Statement): Case => ({
  label,
  statement,
  refusal,
  first: [],
});

/** The same cases with more rows under them: the statements are run first, in this order. */
const following = (statements: Statement[], ...cases: Case[]): Case[] =>
  cases.map((one) => ({ ...one, first: [...statements, ...one.first] }));

/**
 * One test for every case: the rows of the scene, the rows of the case, then the statement. A
 * scene of rules that stand behind triggers names the triggers, and its databases are without them.
 */
function scene(name: string, rows: Statement[], cases: (Case | Case[])[], dropped: string[] = []): void {
  const all = cases.flat();
  const labels = all.map(({ label, refusal }) => `${refusal === undefined ? "accepts" : "refuses"} ${label}`);
  const twice = labels.filter((label, index) => labels.indexOf(label) !== index);
  if (twice.length > 0) throw new Error(`Two cases of "${name}" have one name: ${twice.join("; ")}`);
  for (const { statement, refusal, first } of all) {
    if (refusal !== undefined) expected.push({ rows: [...rows, ...first], statement, refusal, dropped });
  }

  describe(name, () => {
    all.forEach(({ statement, refusal, first }, index) => {
      it(labels[index] as string, () => {
        const db = given(without(...dropped), ...rows, ...first);

        expect(attempt(db, statement)).toEqual(refusal ?? ACCEPTED);
      });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------------------------

/** A CHECK has no name: SQLite reports the text of its condition. */
const check = (condition: string): Refusal => ({
  code: "SQLITE_CONSTRAINT_CHECK",
  message: `CHECK constraint failed: ${condition}`,
});
const FOREIGN_KEY: Refusal = { code: "SQLITE_CONSTRAINT_FOREIGNKEY", message: "FOREIGN KEY constraint failed" };
const unique = (...columns: string[]): Refusal => ({
  code: "SQLITE_CONSTRAINT_UNIQUE",
  message: `UNIQUE constraint failed: ${columns.join(", ")}`,
});
const primaryKey = (...columns: string[]): Refusal => ({ ...unique(...columns), code: "SQLITE_CONSTRAINT_PRIMARYKEY" });
const notNull = (column: string): Refusal => ({
  code: "SQLITE_CONSTRAINT_NOTNULL",
  message: `NOT NULL constraint failed: ${column}`,
});
const wrongType = (stored: string, column: string): Refusal => ({
  code: "SQLITE_CONSTRAINT_DATATYPE",
  message: `cannot store ${stored} value in ${column}`,
});
/** A trigger refuses with the sentence that states its rule. */
const rule = (sentence: string): Refusal => ({ code: "SQLITE_CONSTRAINT_TRIGGER", message: sentence });

// A text is read by GLOB, length() and json_valid() only as far as its first NUL character, so
// every rule that is written with one of them also refuses a text that holds one.
const noNul = (column: string) => `instr(${column}, char(0)) = 0`;
const idOf = (prefix: string) => check(`id GLOB '${prefix}_?*' AND id NOT GLOB '*[^0-9a-z_]*' AND ${noNul("id")}`);
const SOURCE_ID = check(`id GLOB '[a-z][a-z][a-z]_?*' AND id NOT GLOB '*[^0-9a-z_]*' AND ${noNul("id")}`);
const identifier = (column: string) =>
  check(`${column} GLOB '[a-z]*' AND ${column} NOT GLOB '*[^a-z0-9_]*' AND ${noNul(column)}`);
const anchorOf = (column: string, prefix: string) =>
  check(`${column} GLOB '${prefix}_?*' AND ${column} NOT GLOB '*[^0-9a-z_]*' AND ${noNul(column)}`);
const SHA_256 = check(`length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*' AND ${noNul("sha256")}`);
// SQLite reads a value back through its own date functions and the rule takes it when it comes
// back unchanged. A year with a minus sign does, so the rule also asks for a digit at the start.
const instantOf = (column: string) =>
  check(`${column} IS strftime('%Y-%m-%dT%H:%M:%fZ', ${column}, '+0 seconds') AND ${column} GLOB '[0-9]*'`);
const dayOf = (column: string) => check(`${column} IS date(${column}) AND ${column} GLOB '[0-9]*'`);
const json = (column: string) => check(`json_valid(${column}) AND ${noNul(column)}`);
const jsonObject = (column: string) =>
  check(`json_valid(${column}) AND json_type(${column}) = 'object' AND ${noNul(column)}`);
const jsonOrNull = (column: string) => check(`${column} IS NULL OR (json_valid(${column}) AND ${noNul(column)})`);

const SOURCE_TAKEN = rule("sources: the id is taken, and a row is never replaced");
const SOURCE_FIXED = rule("sources: a source keeps its id, kind and dates");
const SOURCE_KEPT = rule("sources: a registry row is never deleted; it outlives its content");
const FILE_FIXED = rule("files: a stored file keeps its hash, size, type and date");
const FILE_IN_USE = rule("files: a stored file is deleted only when no part uses it");
const PART_NEVER_EDITED = rule("capture_parts: a capture is never edited");
const PART_OF_DELETED_SOURCE = rule("capture_parts: a source that is marked deleted takes no new part");
const PART_GOES_WITH_SOURCE = rule("capture_parts: a part is deleted only when its source is marked deleted");
const REVISION_NEVER_EDITED = rule("capture_part_texts: a revision is never edited; add a new revision");
const REVISION_OF_DELETED_SOURCE = rule("capture_part_texts: a source that is marked deleted takes no new revision");
const REVISION_GOES_WITH_SOURCE = rule(
  "capture_part_texts: a revision is deleted only when its source is marked deleted",
);
const FACT_STARTS_WITH_SOURCE = rule("facts: a fact starts with a source and a quote");
const FACT_NEVER_EDITED = rule("facts: a fact is never edited; mark it outdated and add the fact that replaces it");
const ITEM_ID_FIXED = rule("items: an item keeps its id");
const PERSON_ID_FIXED = rule("persons: a person keeps its id");
const ITEM_MERGE = rule(
  "items: merge into an item that is not merged, after re-pointing what was merged into this one",
);
const PERSON_MERGE = rule(
  "persons: merge into a person that is not merged, after re-pointing who was merged into this one",
);
const FACT_ITEM_MERGED = rule("facts: the item was merged into another one");
const LINK_ITEM_MERGED = rule("source_links: the item was merged into another one");
const ITEM_PERSON_MERGED = rule("item_persons: the item or the person was merged into another one");
const ITEM_ALIAS_MERGED = rule("item_aliases: the item was merged into another one");
const DESCRIPTION_ITEM_MERGED = rule("item_descriptions: the item was merged into another one");
const PERSON_ALIAS_MERGED = rule("person_aliases: the person was merged into another one");
const FACT_PERSON_MERGED = rule("fact_persons: the person was merged into another one");
const MENTION_PERSON_MERGED = rule("mentions: the person was merged into another one");
const PARENT_MERGED = rule("items: the parent was merged into another item");
const NO_PARENT = rule("items: a project has no parent");
const OWN_ANCESTOR = rule("items: an item is not its own ancestor");
const CLOSED_AT = rule("items: closed_at is set exactly when the status is a closed one");
const PRECISION_WITHOUT_DAY = rule("items: a precision is about a day that is set");
const MILESTONE_WITH_START = rule("items: a milestone is a point in time and has no start");
const PROJECT_AS_MILESTONE = rule("items: a project is not a milestone");
const RUN_TAKEN = rule("runs: the id is taken or the job already has such a run, and a row is never replaced");
const RUN_KEPT = rule("runs: a run is never deleted");
const RUN_IDENTITY = rule("runs: what a run is never changes; after it ended only its texts can be removed");
const RUN_ENDED = rule("runs: a run that has ended does not change state");
const OPERATION_TAKEN = rule("operations: the id is taken, and a row is never replaced");
const STAGING = rule("operations: a run stages its operations while it is running");
const WITHOUT_RUN = rule("operations: an operation without a run is inserted as applied");
const COMMAND_QUOTE = rule("operations: origin command needs the quote of the command");
const TRANSITION = rule("operations: illegal state transition");
const DEPENDENCY_ORDER = rule(
  "operations: dependency order (apply what it depends on first; reject or undo what depends on it first)",
);
const EDGE_HISTORY = rule("operation_dependencies: the edges of a decided operation are history");
const EDGE_CYCLE = rule("operation_dependencies: the edge would close a cycle");
const EDGE_NEVER_CHANGED = rule("operation_dependencies: an edge is added or removed, never changed");
const OPERATION_IDENTITY = rule("operations: what an operation is never changes");
const OPERATION_HISTORY = rule("operations: a decided operation is history; its text can be removed, not rewritten");
const OPERATION_DELETE = rule("operations: only staged operations are deleted, and only until their run is committed");
const EFFECTS_APPEND_ONLY = rule("operation_effects: effects are append-only");
const EFFECTS_ONLY_APPLIED = rule("operation_effects: only an applied operation has effects");
const EFFECTS_IN_ORDER = rule("operation_effects: the id is the order of all changes; a new effect takes the next one");
const EFFECTS_ONLY_SCRUBBED = rule("operation_effects: effects are append-only; an effect can only be scrubbed");

// ---------------------------------------------------------------------------------------------
// Statements and rows
// ---------------------------------------------------------------------------------------------

const T = "2026-10-12T08:00:00.000Z";
const T2 = "2026-10-12T09:00:00.000Z";
const T3 = "2026-10-12T10:00:00.000Z";
const T4 = "2026-10-13T08:00:00.000Z";
const DAY = "2026-10-12";
const SHA = "a".repeat(64);
/** The last hour of a day spelled as hour 24: the same moment as hour 0 of the next day, in another spelling. */
const HOUR_24 = "2026-10-11T24:00:00.000Z";
const NO_SUCH_DAY = "2026-02-30";
/** A year before the year 0, as SQLite writes it and as toISOString() never does. */
const MINUS_INSTANT = "-2026-10-12T08:00:00.000Z";
const MINUS_DAY = "-2026-10-16";
/** The character at which GLOB, length() and json_valid() stop reading. */
const NUL = "\u0000";

const sql = (text: string, ...params: unknown[]): Statement => ({ sql: text, params });

/** An INSERT of the columns that have a value. */
function insert(table: string, row: Row): Statement {
  const columns = Object.keys(row).filter((column) => row[column] !== undefined);
  return {
    sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    params: columns.map((column) => row[column]),
  };
}

/** An UPDATE of one row, found by its id. */
function update(table: string, id: string | number, set: Row): Statement {
  const columns = Object.keys(set);
  return {
    sql: `UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`,
    params: [...columns.map((column) => set[column]), id],
  };
}

const remove = (table: string, id: string) => sql(`DELETE FROM ${table} WHERE id = ?`, id);

/** An UPDATE that writes columns of a row back as they are, as an ORM does that sends every column. */
const itsOwn = (table: string, id: string, ...columns: string[]) =>
  sql(`UPDATE ${table} SET ${columns.map((column) => `${column} = ${column}`).join(", ")} WHERE id = ?`, id);

const rowsOf = (db: Connection, table: string, where = "1") =>
  db.prepare(`SELECT count(*) FROM ${table} WHERE ${where}`).pluck().get() as number;

// The forms of INSERT that put a row over an existing one, or step around it. The replacing form
// is one that application code never writes, and a search of the sources holds that. Its two
// words are put together here, so that this file holds no such statement for the search to find.
const over = (statement: Statement, resolution: string): Statement => ({
  ...statement,
  sql: statement.sql.replace(/^(INSERT|UPDATE)\b/, `$1 ${["OR", resolution].join(" ")}`),
});
/** Also of an UPDATE: there it removes the other row, the one that stands in the way of a unique key. */
const replacing = (statement: Statement) => over(statement, "REPLACE");
const ignoring = (statement: Statement) => over(statement, "IGNORE");
const onConflict = (statement: Statement, clause: string): Statement => ({
  ...statement,
  sql: `${statement.sql} ON CONFLICT ${clause}`,
});

const item = (id: unknown, kind: string, parentId: string | null = null, more: Row = {}) =>
  insert("items", {
    id,
    kind,
    parent_id: parentId,
    title: `T ${id}`,
    title_norm: `t ${id}`,
    status: "todo",
    importance: DEFAULT_ITEM_IMPORTANCE,
    is_milestone: 0,
    created_at: T,
    last_activity_at: T,
    ...more,
  });
/** Moving an item is one UPDATE of its parent: nothing under the item is written. */
const move = (id: string, parentId: string | null) => update("items", id, { parent_id: parentId });
const mergeItem = (id: string, into: string | null) => update("items", id, { merged_into_id: into });
const description = (id: unknown, itemId: string, more: Row = {}) =>
  insert("item_descriptions", { id, item_id: itemId, updated_at: T, body: '{"type":"doc","content":[]}', ...more });
const itemAlias = (id: unknown, itemId: string, alias: string, more: Row = {}) =>
  insert("item_aliases", { id, item_id: itemId, alias, alias_norm: foldName(alias), created_at: T, ...more });
const itemPerson = (id: unknown, itemId: string, personId: string, role: string, more: Row = {}) =>
  insert("item_persons", { id, item_id: itemId, person_id: personId, role, created_at: T, ...more });

const person = (id: unknown, name: string, more: Row = {}) =>
  insert("persons", { id, name, name_norm: foldName(name), is_me: 0, created_at: T, ...more });
const mergePerson = (id: string, into: string | null) => update("persons", id, { merged_into_id: into });
const personAlias = (id: unknown, personId: string, alias: string, more: Row = {}) =>
  insert("person_aliases", {
    id,
    person_id: personId,
    alias,
    alias_norm: foldName(alias),
    context: "",
    created_at: T,
    ...more,
  });

const source = (id: unknown, more: Row = {}) => insert("sources", { id, kind: "capture", created_at: T, ...more });
const capture = (id: unknown, more: Row = {}) =>
  insert("captures", { id, occurred_on: DAY, occurred_on_approximate: 1, ...more });
const file = (sha256: unknown = SHA, more: Row = {}) =>
  insert("files", { sha256, byte_size: 1234, media_type: "image/png", created_at: T, ...more });
const part = (id: unknown, captureId: string, position: number, kind: string, content: Row) =>
  insert("capture_parts", { id, capture_id: captureId, position, kind, ...content });
const partText = (id: unknown, partId: string, revision: number, more: Row = {}) =>
  insert("capture_part_texts", {
    id,
    part_id: partId,
    revision,
    origin: "transcription",
    created_at: T,
    text: "Piotr: Atlas ma ryzyko",
    ...more,
  });

const mention = (id: unknown, more: Row = {}) =>
  insert("mentions", { id, source_id: "cap_c1", created_at: T, surface: "Magdy", ...more });
const fact = (id: unknown, more: Row = {}) =>
  insert("facts", {
    id,
    item_id: "itm_p1",
    type: "risk",
    occurred_on: DAY,
    occurred_on_approximate: 1,
    source_id: "cap_c1",
    created_at: T,
    quote: "Atlas ma ryzyko",
    text: "Ryzyko opóźnienia",
    ...more,
  });
const factPerson = (id: unknown, factId: string, personId: string) =>
  insert("fact_persons", { id, fact_id: factId, person_id: personId });
const link = (id: unknown, sourceId: string, itemId: string, more: Row = {}) =>
  insert("source_links", { id, source_id: sourceId, item_id: itemId, created_at: T, ...more });

const job = (id: unknown, more: Row = {}) =>
  insert("queue_jobs", {
    id,
    kind: "process_capture",
    state: "queued",
    source_id: "cap_c1",
    attempts: 0,
    max_attempts: 5,
    run_after: T,
    created_at: T,
    payload: "{}",
    ...more,
  });
/** A job that a worker has taken. */
const runningJob = (id: unknown, more: Row = {}) =>
  job(id, { state: "running", attempts: 1, started_at: T, leased_until: T3, ...more });
const run = (id: unknown, more: Row = {}) =>
  insert("runs", {
    id,
    kind: "process_capture",
    state: "running",
    source_id: "cap_c1",
    job_id: "job_1",
    model: "model-x",
    prompt_version: "p1",
    started_at: T,
    ...more,
  });
const modelCall = (more: Row = {}) =>
  insert("model_calls", {
    job_id: "job_1",
    role: "processing",
    purpose: "transcription",
    model: "model-x",
    started_at: T,
    duration_ms: 900,
    ...more,
  });

/** An operation of a run, as the run stages it. */
const operation = (id: unknown, more: Row = {}) =>
  insert("operations", {
    id,
    kind: "add_fact",
    origin: "inference",
    state: "staged",
    created_at: T,
    payload: "{}",
    ...more,
  });
/** An operation that the owner made by hand: it has no run and is applied by the statement that inserts it. */
const manual = (id: unknown, more: Row = {}) =>
  operation(id, { kind: "update_item", origin: "user", state: "applied", approval: "manual", applied_at: T, ...more });
const edge = (operationId: string, dependsOnId: string) =>
  insert("operation_dependencies", { operation_id: operationId, depends_on_id: dependsOnId });
const effect = (operationId: string, more: Row = {}) =>
  insert("operation_effects", {
    operation_id: operationId,
    entity_kind: "item",
    entity_id: "itm_p1",
    change: "touch",
    scrubbed: 0,
    ...more,
  });

// Rows that many scenes start from.
const PROJECT = item("itm_p1", "project");
/** Two projects, a task in the first, a task that stands alone, and a task under each of the two tasks. */
const ITEMS = [
  PROJECT,
  item("itm_p2", "project"),
  item("itm_t10", "task", "itm_p1"),
  item("itm_t11", "task"),
  item("itm_s20", "task", "itm_t10"),
  item("itm_s21", "task", "itm_t11"),
];
/** The first project five levels deep: itm_p1 > itm_t10 > itm_s20 > itm_d30 > itm_d40. */
const DEEP = [...ITEMS, item("itm_d30", "task", "itm_s20"), item("itm_d40", "task", "itm_d30")];
const PERSONS = [
  person("per_me", "Ja", { is_me: 1 }),
  person("per_piotr", "Piotr Nowak", { relation: "peer" }),
  person("per_anna", "Anna Kowalska", { relation: "report" }),
];
/** An input of two parts: what the owner typed, and a screenshot. */
const CAPTURE = [
  source("cap_c1"),
  capture("cap_c1"),
  file(),
  part("prt_1", "cap_c1", 0, "typed", { text: "dodaj zadanie" }),
  part("prt_2", "cap_c1", 1, "image", { file_sha256: SHA, file_name: "zrzut.png" }),
];
/** An input that has no parts yet. */
const EMPTY_CAPTURE = [source("cap_c2"), capture("cap_c2")];
/** A registry row of a kind that has no table of its own yet. */
const OTHER_SOURCE = source("cap_c3", { kind: "note" });
const TRANSCRIPT = partText("ptx_1", "prt_2", 1);

// ---------------------------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------------------------

// A row of every kind of object that has an id of its own, and the rows it needs under it.
const WITH_ID: Record<IdKind, { rows: Statement[]; row: (id: string) => Statement }> = {
  capture: { rows: [source("cap_ok1")], row: (id) => capture(id) },
  capturePart: { rows: CAPTURE, row: (id) => part(id, "cap_c1", 5, "pasted", { text: "wklejony tekst" }) },
  capturePartText: { rows: CAPTURE, row: (id) => partText(id, "prt_2", 1) },
  person: { rows: [], row: (id) => person(id, "Ktoś Nowy") },
  personAlias: { rows: PERSONS, row: (id) => personAlias(id, "per_anna", "Ania") },
  item: { rows: [], row: (id) => item(id, "project") },
  itemDescription: { rows: [PROJECT], row: (id) => description(id, "itm_p1") },
  itemAlias: { rows: [PROJECT], row: (id) => itemAlias(id, "itm_p1", "ATL") },
  itemPerson: { rows: [PROJECT, ...PERSONS], row: (id) => itemPerson(id, "itm_p1", "per_anna", "owner") },
  mention: { rows: CAPTURE, row: (id) => mention(id) },
  fact: { rows: [PROJECT, ...CAPTURE], row: (id) => fact(id) },
  factPerson: {
    rows: [PROJECT, ...CAPTURE, ...PERSONS, fact("fct_1")],
    row: (id) => factPerson(id, "fct_1", "per_anna"),
  },
  sourceLink: { rows: [PROJECT, ...CAPTURE], row: (id) => link(id, "cap_c1", "itm_p1") },
  job: { rows: CAPTURE, row: (id) => job(id) },
  run: { rows: [...CAPTURE, runningJob("job_1")], row: (id) => run(id) },
  operation: { rows: [], row: (id) => manual(id) },
};

describe("an id", () => {
  for (const kind of Object.keys(WITH_ID) as IdKind[]) {
    const prefix = ID_PREFIXES[kind];
    const { rows, row } = WITH_ID[kind];
    // The id of a capture is the id of its registry row, which holds the rule about characters:
    // the capture's own CHECK is about the prefix, and the rest is the foreign key's.
    const shape = kind === "capture" ? check("id GLOB 'cap_?*'") : idOf(prefix);
    const characters = kind === "capture" ? FOREIGN_KEY : shape;

    scene(`of the kind ${kind}`, rows, [
      accepts(`the prefix "${prefix}" and lower-case characters after it`, row(`${prefix}_ok1`)),
      refuses("the prefix of no kind", shape, row("xyz_ok1")),
      refuses("the prefix alone", shape, row(`${prefix}_`)),
      refuses("no underscore after the prefix", shape, row(`${prefix}ok1`)),
      refuses("an upper-case character", characters, row(`${prefix}_OK1`)),
      refuses("punctuation", characters, row(`${prefix}_a-b`)),
      // What stands behind the character is read by none of the two GLOBs.
      refuses("a NUL character, whatever stands behind it", characters, row(`${prefix}_ok1${NUL}B-! <x>`)),
      refuses("a NUL character at the end", characters, row(`${prefix}_ok1${NUL}`)),
    ]);

    // The application reads the kind of an id off its prefix. What it takes for an id of this kind
    // has to be what the table of the kind stores as one.
    it(`of the kind ${kind} is one to idKindOf() exactly when the database stores it`, () => {
      const candidates = [
        `${prefix}_ok1`,
        `${prefix}_ilou_0`,
        `${prefix}_${"z".repeat(40)}`,
        `${prefix}_`,
        `${prefix}ok1`,
        `${prefix}_OK1`,
        `${prefix}_a-b`,
        `${prefix}_a b`,
        `${prefix}_ok1\n`,
        `${prefix}_ż`,
        `${prefix}_a${NUL}b`,
        `${prefix}_ok1${NUL}`,
        `${prefix}_${NUL}ok1`,
        `x${prefix}_ok1`,
        "xyz_ok1",
      ];

      const disagreements = candidates.filter((candidate) => {
        const db = given(...rows);
        // A capture sits on the registry row of the same id, where there can be one.
        if (kind === "capture") attempt(db, source(candidate));
        const stored = attempt(db, row(candidate)) === ACCEPTED;
        return stored !== (idKindOf(candidate) === kind);
      });

      expect(disagreements).toEqual([]);
    });
  }

  scene(
    "of an item",
    [PROJECT],
    [
      refuses("that is the id of a person", idOf("itm"), item("per_x1", "project")),
      // A STRICT table stores the number as the text "42", which has no prefix.
      refuses("that is a number", idOf("itm"), item(42, "project")),
      refuses("that is NULL", notNull("items.id"), item(null, "project")),
      refuses("that another item has", primaryKey("items.id"), item("itm_p1", "task")),
    ],
  );

  scene(
    "of a source",
    [],
    [
      accepts("three letters, an underscore and more", source("nte_n1", { kind: "note" })),
      refuses("a prefix of two letters", SOURCE_ID, source("ca_c1")),
      refuses("a prefix of four letters", SOURCE_ID, source("capt_c1")),
      refuses("an upper-case character", SOURCE_ID, source("cap_C1")),
      refuses("a NUL character, whatever stands behind it", SOURCE_ID, source(`cap_c1${NUL}B-! <x>`)),
    ],
  );
});

// ---------------------------------------------------------------------------------------------
// Instants, days and types
// ---------------------------------------------------------------------------------------------

// Every way a moment can be spelled that is not the one spelling of toISOString().
const NOT_INSTANTS: [what: string, value: unknown][] = [
  ["a space in place of the T", "2026-10-12 08:00:00.000Z"],
  ["no milliseconds", "2026-10-12T08:00:00Z"],
  ["four fractional digits", "2026-10-12T08:00:00.0000Z"],
  ["an offset in place of the Z", "2026-10-12T10:00:00.000+02:00"],
  ["no zone", "2026-10-12T08:00:00.000"],
  ["lower-case letters", "2026-10-12t08:00:00.000z"],
  ["month 13", "2026-13-12T08:00:00.000Z"],
  ["the thirtieth of February", "2026-02-30T08:00:00.000Z"],
  ["the 29th of February of 1900, which was no leap year", "1900-02-29T08:00:00.000Z"],
  ["hour 24", HOUR_24],
  ["hour 24 with minutes", "2026-10-11T24:30:15.123Z"],
  ["second 60", "2026-10-11T23:59:60.000Z"],
  ["a year of six digits", "+002026-10-12T08:00:00.000Z"],
  // SQLite reads a minus sign as a year before the year 0 and writes such a year back the same way.
  ["a year with a minus sign", MINUS_INSTANT],
  ["a year with a minus sign and six digits, as toISOString() writes one", "-002026-10-12T08:00:00.000Z"],
  ["the oldest moment that SQLite counts from", "-4713-11-24T12:00:00.000Z"],
  ["a NUL character behind", `2026-10-12T08:00:00.000Z${NUL}`],
  ["a space behind", "2026-10-12T08:00:00.000Z "],
  ["milliseconds since 1970 as a number", 1791792000000],
  ["milliseconds since 1970 as text", "1791792000000"],
  ["a day alone", "2026-10-12"],
  ["a word", "yesterday"],
  ["the empty text", ""],
];
const INSTANTS = [
  "2026-10-12T08:00:00.123Z",
  "2026-10-12T00:30:15.123Z",
  "2024-02-29T23:59:59.999Z",
  "0000-01-01T00:00:00.000Z",
  "9999-12-31T23:59:59.999Z",
];

const NOT_DAYS: [what: string, value: unknown][] = [
  ["the thirtieth of February", NO_SUCH_DAY],
  ["the 29th of February in a year that has none", "2026-02-29"],
  ["the 29th of February of 1900, which was no leap year", "1900-02-29"],
  ["month 13", "2026-13-01"],
  ["a day with a time", "2026-10-16T00:00:00.000Z"],
  ["a month without its leading zero", "2026-1-05"],
  ["a year with a minus sign", MINUS_DAY],
  ["the last day before the year 0", "-0001-12-31"],
  ["a year with a plus sign", "+2026-10-16"],
  ["a NUL character behind", `2026-10-16${NUL}`],
  ["a number", 20261016],
  ["a space behind", "2026-10-16 "],
  ["the empty text", ""],
];
const DAYS = ["2026-10-16", "2024-02-29", "2000-02-29", "0000-01-01", "0000-02-29", "9999-12-31"];

// A statement that writes the given value into each column that holds an instant.
const INSTANT_COLUMNS: [column: string, rows: Statement[], write: (value: unknown) => Statement][] = [
  ["sources.created_at", [], (value) => source("cap_x", { created_at: value })],
  ["sources.deleted_at", [source("cap_x")], (value) => update("sources", "cap_x", { deleted_at: value })],
  ["files.created_at", [], (value) => file(SHA, { created_at: value })],
  ["capture_part_texts.created_at", CAPTURE, (value) => partText("ptx_x", "prt_2", 1, { created_at: value })],
  ["persons.created_at", [], (value) => person("per_x", "Ktoś", { created_at: value })],
  ["person_aliases.created_at", PERSONS, (value) => personAlias("pal_x", "per_anna", "Ania", { created_at: value })],
  ["items.created_at", [], (value) => item("itm_x", "project", null, { created_at: value, last_activity_at: value })],
  ["items.closed_at", [], (value) => item("itm_x", "project", null, { status: "done", closed_at: value })],
  ["items.last_activity_at", [], (value) => item("itm_x", "project", null, { last_activity_at: value })],
  ["item_descriptions.updated_at", [PROJECT], (value) => description("ide_x", "itm_p1", { updated_at: value })],
  ["item_aliases.created_at", [PROJECT], (value) => itemAlias("ial_x", "itm_p1", "ATL", { created_at: value })],
  [
    "item_persons.created_at",
    [PROJECT, ...PERSONS],
    (value) => itemPerson("itp_x", "itm_p1", "per_anna", "owner", { created_at: value }),
  ],
  ["mentions.skipped_at", CAPTURE, (value) => mention("mnt_x", { skipped_at: value })],
  ["mentions.created_at", CAPTURE, (value) => mention("mnt_x", { created_at: value })],
  ["facts.outdated_at", [PROJECT, ...CAPTURE], (value) => fact("fct_x", { outdated_at: value })],
  ["facts.created_at", [PROJECT, ...CAPTURE], (value) => fact("fct_x", { created_at: value })],
  [
    "source_links.created_at",
    [PROJECT, ...CAPTURE],
    (value) => link("lnk_x", "cap_c1", "itm_p1", { created_at: value }),
  ],
  ["queue_jobs.run_after", CAPTURE, (value) => job("job_x", { run_after: value })],
  ["queue_jobs.leased_until", CAPTURE, (value) => runningJob("job_x", { leased_until: value })],
  ["queue_jobs.created_at", CAPTURE, (value) => job("job_x", { created_at: value })],
  ["queue_jobs.started_at", CAPTURE, (value) => runningJob("job_x", { started_at: value })],
  [
    "queue_jobs.finished_at",
    CAPTURE,
    (value) => job("job_x", { state: "done", attempts: 1, started_at: T, finished_at: value }),
  ],
  ["runs.started_at", CAPTURE, (value) => run("run_x", { job_id: null, started_at: value })],
  [
    "runs.ended_at",
    CAPTURE,
    (value) => run("run_x", { job_id: null, state: "failed", error_code: "interrupted", ended_at: value }),
  ],
  ["model_calls.started_at", [], (value) => modelCall({ job_id: null, started_at: value })],
  ["operations.created_at", [], (value) => manual("opr_x", { created_at: value })],
  ["operations.decided_at", [], (value) => manual("opr_x", { decided_at: value })],
  ["operations.applied_at", [], (value) => manual("opr_x", { applied_at: value })],
  ["operations.scrubbed_at", [], (value) => manual("opr_x", { scrubbed_at: value })],
];

const DAY_COLUMNS: [column: string, rows: Statement[], write: (value: unknown) => Statement][] = [
  ["captures.occurred_on", [source("cap_x")], (value) => capture("cap_x", { occurred_on: value })],
  ["items.my_role_set_on", [], (value) => item("itm_x", "task", null, { my_role: "waiting", my_role_set_on: value })],
  ["items.start_on", [], (value) => item("itm_x", "task", null, { start_on: value })],
  ["items.due_on", [], (value) => item("itm_x", "task", null, { due_on: value })],
  ["facts.occurred_on", [PROJECT, ...CAPTURE], (value) => fact("fct_x", { occurred_on: value })],
];

const columnOf = (qualified: string) => qualified.slice(qualified.indexOf(".") + 1);
// "now" is a time to SQLite, and one that differs from call to call. It refuses to evaluate a
// CHECK with such a value at all, which keeps the word out as well as the CHECK would.
const notTheClock = (reader: string): Refusal => ({
  code: "SQLITE_ERROR",
  message: `non-deterministic use of ${reader}() in a CHECK constraint`,
});

describe("an instant", () => {
  scene(
    "is stored in the one spelling of toISOString()",
    [],
    [
      ...INSTANTS.map((value) => accepts(value, source("cap_x", { created_at: value }))),
      ...NOT_INSTANTS.map(([what, value]) =>
        refuses(`${what}`, instantOf("created_at"), source("cap_x", { created_at: value })),
      ),
      refuses("the word for the present moment", notTheClock("strftime"), source("cap_x", { created_at: "now" })),
    ],
  );

  // Hour 24 is what the check lets through when it does not make SQLite normalise the value, and
  // a year with a minus sign when it does not ask for a digit at the start.
  scene(
    "is held to that spelling in every column that stores one",
    [],
    INSTANT_COLUMNS.flatMap(([column, rows, write]) =>
      following(
        rows,
        accepts(`${column}: an instant`, write(T2)),
        refuses(`${column}: hour 24`, instantOf(columnOf(column)), write(HOUR_24)),
        refuses(`${column}: a year with a minus sign`, instantOf(columnOf(column)), write(MINUS_INSTANT)),
      ),
    ),
  );

  // The application decides with parseInstant() what it writes. A text that the one accepts
  // and the other refuses would be a write that fails, or a value that reads back as no instant.
  it("is the same thing to parseInstant() and to the database", () => {
    const db = given();
    const spellings = [...INSTANTS, ...NOT_INSTANTS.map(([, value]) => value), "now"].filter(
      (value): value is string => typeof value === "string",
    );

    const disagreements = spellings.filter((text, index) => {
      const stored = attempt(db, source(`cap_s${index}`, { created_at: text })) === ACCEPTED;
      return stored !== (parseInstant(text) !== undefined);
    });

    expect(disagreements).toEqual([]);
    expect(spellings.length).toBeGreaterThan(20);
  });
});

describe("a calendar day", () => {
  scene(
    "is stored as YYYY-MM-DD, and is a day that exists",
    [item("itm_t1", "task")],
    [
      ...DAYS.map((value) => accepts(value, update("items", "itm_t1", { due_on: value }))),
      ...NOT_DAYS.map(([what, value]) =>
        refuses(`${what}`, dayOf("due_on"), update("items", "itm_t1", { due_on: value })),
      ),
      refuses("the word for today", notTheClock("date"), update("items", "itm_t1", { due_on: "now" })),
      following(
        [update("items", "itm_t1", { due_on: "2026-10-16" })],
        accepts("no day at all, after there was one", update("items", "itm_t1", { due_on: null })),
      ),
    ],
  );

  scene(
    "is held to that spelling in every column that stores one",
    [],
    DAY_COLUMNS.flatMap(([column, rows, write]) =>
      following(
        rows,
        accepts(`${column}: a day`, write("2026-10-16")),
        refuses(`${column}: a day that does not exist`, dayOf(columnOf(column)), write(NO_SUCH_DAY)),
        refuses(`${column}: a year with a minus sign`, dayOf(columnOf(column)), write(MINUS_DAY)),
      ),
    ),
  );

  it("is the same thing to parseDay() and to the database", () => {
    const db = given(item("itm_t1", "task"));
    const spellings = [...DAYS, ...NOT_DAYS.map(([, value]) => value), "now"].filter(
      (value): value is string => typeof value === "string",
    );

    const disagreements = spellings.filter((text) => {
      const stored = attempt(db, update("items", "itm_t1", { due_on: text })) === ACCEPTED;
      return stored !== (parseDay(text) !== undefined);
    });

    expect(disagreements).toEqual([]);
    expect(spellings.length).toBeGreaterThan(10);
  });
});

scene(
  "a STRICT table",
  [],
  [
    refuses(
      "text in a column of integers",
      wrongType("TEXT", "INTEGER column persons.is_me"),
      person("per_x", "Ktoś", { is_me: "yes" }),
    ),
    refuses(
      "a fraction in a column of integers",
      wrongType("REAL", "INTEGER column persons.is_me"),
      person("per_x", "Ktoś", { is_me: 1.5 }),
    ),
    refuses(
      "bytes in a column of text",
      wrongType("BLOB", "TEXT column persons.name"),
      person("per_x", "Ktoś", { name: Buffer.from("Ktoś") }),
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

// Every table of words, with the columns it has beside the word.
const WORD_TABLES: [table: string, beside: Row][] = [
  ["item_statuses", { position: 9, is_closed: 0 }],
  ["item_healths", { position: 9, severity: 0 }],
  ["item_importances", { position: 9, weight: 5 }],
  ["my_roles", { position: 9 }],
  ["item_person_roles", { position: 9 }],
  ["fact_types", { position: 9 }],
  ["person_relations", { position: 9 }],
  ["operation_states", {}],
  ["run_states", {}],
  ["job_states", {}],
];

scene(
  "a table of words",
  [],
  [
    ...WORD_TABLES.flatMap(([table, beside]) => [
      accepts(`${table}: a new word, which is one INSERT`, insert(table, { code: "a_new_word2", ...beside })),
      refuses(
        `${table}: a word that is not a lower-case identifier`,
        identifier("code"),
        insert(table, { code: "Open Point", ...beside }),
      ),
      refuses(
        `${table}: a word that begins with a digit`,
        identifier("code"),
        insert(table, { code: "2nd", ...beside }),
      ),
      refuses(
        `${table}: a word with a NUL character, whatever stands behind it`,
        identifier("code"),
        insert(table, { code: `a_new_word2${NUL}Open Point`, ...beside }),
      ),
    ]),
    refuses(
      "item_statuses: a word that is there already",
      primaryKey("item_statuses.code"),
      insert("item_statuses", { code: "done", position: 9, is_closed: 1 }),
    ),
    refuses(
      "item_statuses: a closed mark that is neither 0 nor 1",
      check("is_closed IN (0, 1)"),
      insert("item_statuses", { code: "paused", position: 9, is_closed: 2 }),
    ),
    refuses(
      "item_healths: a severity below 0",
      check("severity >= 0"),
      insert("item_healths", { code: "unknown", position: 9, severity: -1 }),
    ),
    accepts(
      "item_importances: a weight below 0, which is what the less important have",
      insert("item_importances", { code: "someday", position: 9, weight: -2 }),
    ),
  ],
);

const PAUSED = insert("item_statuses", { code: "paused", position: 6, is_closed: 0 });
const CRITICAL = insert("item_importances", { code: "critical", position: 0, weight: 2 });

scene(
  "the words of an item",
  [PROJECT],
  [
    refuses("a status outside the list", FOREIGN_KEY, update("items", "itm_p1", { status: "paused" })),
    refuses(
      "an item inserted with a status outside the list",
      FOREIGN_KEY,
      item("itm_x", "task", null, { status: "nope" }),
    ),
    following(
      [PAUSED],
      accepts("a new status at once, without anything else changing", update("items", "itm_p1", { status: "paused" })),
    ),
    following(
      [PAUSED, update("items", "itm_p1", { status: "paused" })],
      refuses(
        "deleting a status that an item has",
        FOREIGN_KEY,
        sql("DELETE FROM item_statuses WHERE code = 'paused'"),
      ),
      // A code is also stored inside journal values, and no foreign key reaches those.
      refuses(
        "renaming a status in place while an item has it",
        FOREIGN_KEY,
        sql("UPDATE item_statuses SET code = 'on_hold' WHERE code = 'paused'"),
      ),
    ),
    following(
      [PAUSED, update("items", "itm_p1", { status: "paused" }), update("items", "itm_p1", { status: "todo" })],
      accepts("retiring a status that no item has any more", sql("DELETE FROM item_statuses WHERE code = 'paused'")),
    ),
    refuses("a health outside the list", FOREIGN_KEY, update("items", "itm_p1", { health: "amber" })),
    refuses("a role of mine outside the list", FOREIGN_KEY, update("items", "itm_p1", { my_role: "owning" })),

    // The importance: every item has one, and no default supplies it.
    ...ITEM_IMPORTANCES.map((importance) =>
      accepts(`an item inserted with the importance ${importance}`, item("itm_x", "task", null, { importance })),
    ),
    ...ITEM_IMPORTANCES.map((importance) =>
      accepts(`the importance ${importance} given to an item later`, update("items", "itm_p1", { importance })),
    ),
    refuses(
      "an item inserted without an importance",
      notNull("items.importance"),
      item("itm_x", "task", null, { importance: undefined }),
    ),
    refuses(
      "an item inserted with the importance NULL",
      notNull("items.importance"),
      item("itm_x", "task", null, { importance: null }),
    ),
    refuses("an importance taken away", notNull("items.importance"), update("items", "itm_p1", { importance: null })),
    refuses(
      "an item inserted with an importance outside the list",
      FOREIGN_KEY,
      item("itm_x", "task", null, { importance: "urgent" }),
    ),
    refuses("an importance outside the list", FOREIGN_KEY, update("items", "itm_p1", { importance: "urgent" })),
    refuses("an importance in another case", FOREIGN_KEY, update("items", "itm_p1", { importance: "High" })),
    following([CRITICAL], accepts("a new importance at once", update("items", "itm_p1", { importance: "critical" }))),
    following(
      [CRITICAL, update("items", "itm_p1", { importance: "critical" })],
      refuses(
        "deleting an importance that an item has",
        FOREIGN_KEY,
        sql("DELETE FROM item_importances WHERE code = 'critical'"),
      ),
    ),
  ],
);

// A word that a row uses stays in its table: this is the other side of every foreign key to a
// table of words.
scene(
  "a word in use",
  [...ITEMS, ...PERSONS, ...CAPTURE, runningJob("job_1"), run("run_1"), manual("opr_m1")],
  [
    ["the status of an item", "item_statuses", "todo", []],
    ["the importance of an item", "item_importances", DEFAULT_ITEM_IMPORTANCE, []],
    ["the health of a project", "item_healths", "yellow", [update("items", "itm_p1", { health: "yellow" })]],
    ["the health of a task", "item_healths", "red", [update("items", "itm_s20", { health: "red" })]],
    ["my role in an item", "my_roles", "waiting", [update("items", "itm_p1", { my_role: "waiting" })]],
    ["the relation of a person", "person_relations", "peer", []],
    [
      "the role of a person in an item",
      "item_person_roles",
      "owner",
      [itemPerson("itp_1", "itm_p1", "per_piotr", "owner")],
    ],
    ["the type of a fact", "fact_types", "risk", [fact("fct_1")]],
    ["the state of a job", "job_states", "running", []],
    ["the state of a run", "run_states", "running", []],
    ["the state of an operation", "operation_states", "applied", []],
  ].flatMap(([what, table, code, rows]) =>
    following(
      rows as Statement[],
      refuses(`deleting ${what as string}`, FOREIGN_KEY, sql(`DELETE FROM ${table as string} WHERE code = ?`, code)),
      refuses(
        `renaming ${what as string} in place`,
        FOREIGN_KEY,
        sql(`UPDATE ${table as string} SET code = 'renamed' WHERE code = ?`, code),
      ),
    ),
  ),
);

// ---------------------------------------------------------------------------------------------
// Raw material: sources, files, captures and their parts
// ---------------------------------------------------------------------------------------------

scene(
  "the registry of sources",
  [...CAPTURE, OTHER_SOURCE],
  [
    accepts("a row for a new source", source("cap_new")),
    refuses(
      "a kind that is not a lower-case identifier",
      identifier("kind"),
      source("cap_new", { kind: "Note Fragment" }),
    ),
    // A capture can only sit on a registry row of the kind "capture": the word has to be that word.
    refuses(
      "a kind with a NUL character behind the word",
      identifier("kind"),
      source("cap_new", { kind: `capture${NUL}` }),
    ),
    // A row is written once. Afterwards only the mark of permanent deletion can be set, once.
    refuses("another id for a source", SOURCE_FIXED, update("sources", "cap_c3", { id: "cap_c9" })),
    refuses("another kind for a source", SOURCE_FIXED, update("sources", "cap_c1", { kind: "note" })),
    refuses("another date of adding for a source", SOURCE_FIXED, update("sources", "cap_c1", { created_at: T2 })),
    accepts(
      "a row written back as it is",
      sql("UPDATE sources SET kind = kind, created_at = created_at WHERE id = 'cap_c1'"),
    ),
    accepts("the mark of permanent deletion", update("sources", "cap_c1", { deleted_at: T3 })),
    following(
      [update("sources", "cap_c1", { deleted_at: T3 })],
      refuses("taking the mark of deletion back", SOURCE_FIXED, update("sources", "cap_c1", { deleted_at: null })),
      refuses("moving the mark of deletion", SOURCE_FIXED, update("sources", "cap_c1", { deleted_at: T4 })),
      accepts("the mark of deletion written back as it is", update("sources", "cap_c1", { deleted_at: T3 })),
    ),
    refuses("an id that a source has already", SOURCE_TAKEN, source("cap_c1")),
    // The row outlives its content: it is what a fact, a run and a journal entry still point at.
    refuses("deleting a source", SOURCE_KEPT, remove("sources", "cap_c1")),
    refuses("deleting a source that nothing points at", SOURCE_KEPT, remove("sources", "cap_c3")),
    following(
      [update("sources", "cap_c3", { deleted_at: T3 })],
      refuses("deleting a source that is marked deleted", SOURCE_KEPT, remove("sources", "cap_c3")),
    ),
  ],
);

const OTHER_SHA = "b".repeat(64);
const deleteFile = (sha256: string) => sql("DELETE FROM files WHERE sha256 = ?", sha256);
const changeFile = (set: Row) => {
  const columns = Object.keys(set);
  return sql(
    `UPDATE files SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE sha256 = ?`,
    ...columns.map((column) => set[column]),
    SHA,
  );
};

scene("a file", CAPTURE, [
  accepts("content of another hash", file(OTHER_SHA)),
  refuses("a key that is not a SHA-256", SHA_256, file("abc")),
  refuses("a key of the right length with a character that no hash has", SHA_256, file("g".repeat(64))),
  refuses("a key in upper case", SHA_256, file("A".repeat(64))),
  // To length() the key ends at the character, and to GLOB as well.
  refuses("a key with a NUL character and more behind its 64 characters", SHA_256, file(`${OTHER_SHA}${NUL}../x`)),
  refuses("a size below 0", check("byte_size >= 0"), file(OTHER_SHA, { byte_size: -1 })),
  accepts("an empty file", file(OTHER_SHA, { byte_size: 0 })),
  refuses("an empty media type", check("media_type <> ''"), file(OTHER_SHA, { media_type: "" })),

  // What was recorded about a stored original stays, and so does the row while a part uses the file.
  refuses("another media type for a stored file", FILE_FIXED, changeFile({ media_type: "text/html" })),
  refuses("another size for a stored file", FILE_FIXED, changeFile({ byte_size: 1 })),
  refuses("another date for a stored file", FILE_FIXED, changeFile({ created_at: T2 })),
  following(
    [file(OTHER_SHA)],
    refuses(
      "another hash for a stored file",
      FILE_FIXED,
      sql("UPDATE files SET sha256 = ? WHERE sha256 = ?", "c".repeat(64), OTHER_SHA),
    ),
    accepts("deleting a file that no part uses", deleteFile(OTHER_SHA)),
    // One statement for many rows is refused whole.
    refuses("deleting every file at once, of which a part uses one", FILE_IN_USE, sql("DELETE FROM files")),
  ),
  refuses("deleting a file that a part uses", FILE_IN_USE, deleteFile(SHA)),
  accepts(
    "a file written back as it is",
    sql(
      "UPDATE files SET byte_size = byte_size, media_type = media_type, created_at = created_at WHERE sha256 = ?",
      SHA,
    ),
  ),
  refuses(
    "an upsert that gives a stored file another media type",
    FILE_FIXED,
    onConflict(file(SHA, { media_type: "text/html" }), "(sha256) DO UPDATE SET media_type = excluded.media_type"),
  ),
]);

describe("a file", () => {
  // Two parts can hold the same content. Whoever stores the second one finds the row of the
  // first, and may say so in the statement: files are not among the tables that refuse it.
  it("can be saved a second time by a statement that does nothing when the content is there", () => {
    const db = given(...CAPTURE);
    const before = db.prepare("SELECT * FROM files").all();

    const again = onConflict(file(SHA, { media_type: "text/html", created_at: T4 }), "DO NOTHING");

    expect(db.prepare(again.sql).run(...again.params).changes).toBe(0);
    expect(db.prepare("SELECT * FROM files").all()).toEqual(before);
  });

  // The foreign key of a part can be put off to the commit, and a migration runs with the keys
  // switched off. The row of a file that a part uses stays then as well: deleted and written
  // again, it would say another size, type and date of the same original.
  it("is not deleted and written again while a part uses it, whatever the check of foreign keys does", () => {
    const db = given(...CAPTURE);
    const before = db.prepare("SELECT * FROM files").all();
    const again = file(SHA, { byte_size: 7, media_type: "text/html", created_at: T3 });

    expect(deferred(db, deleteFile(SHA), again)).toEqual([FILE_IN_USE, primaryKey("files.sha256")]);
    db.pragma("foreign_keys = OFF");
    expect(attempt(db, deleteFile(SHA))).toEqual(FILE_IN_USE);

    expect(db.prepare("SELECT * FROM files").all()).toEqual(before);
  });
});

scene(
  "a capture",
  [...CAPTURE, OTHER_SOURCE, source("cap_c4")],
  [
    accepts("a capture on its registry row", capture("cap_c4")),
    refuses("a capture without a registry row", FOREIGN_KEY, capture("cap_c9")),
    refuses("a capture on a registry row of another kind", FOREIGN_KEY, capture("cap_c3")),
    refuses(
      "a value for the column that the database computes",
      { code: "SQLITE_ERROR", message: 'cannot INSERT into generated column "source_kind"' },
      capture("cap_c4", { source_kind: "note" }),
    ),
    refuses(
      "an approximate mark that is neither 0 nor 1",
      check("occurred_on_approximate IN (0, 1)"),
      capture("cap_c4", { occurred_on_approximate: 2 }),
    ),
    accepts(
      "another event date, which processing reads from the material",
      update("captures", "cap_c1", { occurred_on: "2026-10-09", occurred_on_approximate: 0 }),
    ),
    // No foreign key has an action: nothing is deleted because something else was.
    refuses("deleting a capture that has parts", FOREIGN_KEY, remove("captures", "cap_c1")),
  ],
);

// A capture is stored as it came and is never edited.
scene(
  "the parts of a capture",
  [...CAPTURE, ...EMPTY_CAPTURE],
  [
    accepts("a typed part", part("prt_9", "cap_c2", 0, "typed", { text: "odpisać Piotrowi" })),
    accepts("an image part", part("prt_9", "cap_c1", 2, "image", { file_sha256: SHA, file_name: "drugi.png" })),
    accepts("a file part without a name", part("prt_9", "cap_c1", 2, "file", { file_sha256: SHA })),
    following(
      [part("prt_8", "cap_c2", 0, "image", { file_sha256: SHA })],
      accepts("a typed part of an input that has other parts", part("prt_9", "cap_c2", 1, "typed", { text: "x" })),
    ),
    refuses(
      "a second typed part in one input",
      PART_NEVER_EDITED,
      part("prt_9", "cap_c1", 2, "typed", { text: "jeszcze jedno" }),
    ),
    refuses("two parts at one position", PART_NEVER_EDITED, part("prt_9", "cap_c1", 1, "pasted", { text: "wklejone" })),
    refuses("an id that a part has already", PART_NEVER_EDITED, part("prt_1", "cap_c2", 0, "pasted", { text: "x" })),
    refuses(
      "a part with text and a file",
      check("(text IS NULL) <> (file_sha256 IS NULL)"),
      part("prt_9", "cap_c1", 2, "pasted", { text: "x", file_sha256: SHA }),
    ),
    refuses(
      "a part with neither text nor a file",
      check("(text IS NULL) <> (file_sha256 IS NULL)"),
      part("prt_9", "cap_c1", 2, "pasted", {}),
    ),
    refuses(
      "a typed part that is a file",
      check("kind <> 'typed' OR text IS NOT NULL"),
      part("prt_9", "cap_c2", 0, "typed", { file_sha256: SHA }),
    ),
    refuses(
      "a file name without a file",
      check("file_name IS NULL OR file_sha256 IS NOT NULL"),
      part("prt_9", "cap_c1", 2, "pasted", { text: "x", file_name: "a.txt" }),
    ),
    refuses(
      "an empty file name",
      check("file_name <> ''"),
      part("prt_9", "cap_c1", 2, "file", { file_sha256: SHA, file_name: "" }),
    ),
    refuses("an empty text", check("text <> ''"), part("prt_9", "cap_c1", 2, "pasted", { text: "" })),
    refuses("a position below 0", check("position >= 0"), part("prt_9", "cap_c1", -1, "pasted", { text: "x" })),
    refuses(
      "a kind that is not a lower-case identifier",
      identifier("kind"),
      part("prt_9", "cap_c1", 2, "Pasted Text", { text: "x" }),
    ),
    // With the character behind it, the word would not be the one that the rule about typed parts names.
    refuses(
      "a typed part whose kind has a NUL character behind the word, and which is a file",
      identifier("kind"),
      part("prt_9", "cap_c2", 0, `typed${NUL}`, { file_sha256: SHA }),
    ),
    refuses(
      "a part of a file that is not stored",
      FOREIGN_KEY,
      part("prt_9", "cap_c1", 2, "file", { file_sha256: OTHER_SHA }),
    ),
    refuses(
      "a part of a capture that does not exist",
      FOREIGN_KEY,
      part("prt_9", "cap_nowhere", 0, "pasted", { text: "x" }),
    ),

    // Nothing of a part changes, whatever the column.
    refuses("another text for a part", PART_NEVER_EDITED, update("capture_parts", "prt_1", { text: "inne" })),
    refuses("another id for a part", PART_NEVER_EDITED, update("capture_parts", "prt_1", { id: "prt_9" })),
    refuses(
      "a part moved to another capture",
      PART_NEVER_EDITED,
      update("capture_parts", "prt_1", { capture_id: "cap_c2" }),
    ),
    refuses("another position for a part", PART_NEVER_EDITED, update("capture_parts", "prt_1", { position: 5 })),
    refuses("another kind for a part", PART_NEVER_EDITED, update("capture_parts", "prt_1", { kind: "pasted" })),
    refuses(
      "another file name for a part",
      PART_NEVER_EDITED,
      update("capture_parts", "prt_2", { file_name: "inny.png" }),
    ),
    following(
      [file(OTHER_SHA)],
      refuses(
        "another file for a part",
        PART_NEVER_EDITED,
        update("capture_parts", "prt_2", { file_sha256: OTHER_SHA }),
      ),
    ),
    refuses(
      "a part written back as it is",
      PART_NEVER_EDITED,
      sql("UPDATE capture_parts SET text = text WHERE id = 'prt_1'"),
    ),
  ],
);

// Derived text is append-only: a correction is a new revision.
scene(
  "the text derived from a part",
  [...CAPTURE, TRANSCRIPT, runningJob("job_1"), modelCall()],
  [
    accepts(
      "a correction, which is a new revision",
      partText("ptx_2", "prt_2", 2, { origin: "correction", text: "Piotr: Atlas ma ryzyko." }),
    ),
    accepts(
      "a transcription that names the model call that wrote it",
      partText("ptx_2", "prt_2", 2, { model_call_id: 1 }),
    ),
    refuses(
      "a transcription that names a call that was never made",
      FOREIGN_KEY,
      partText("ptx_2", "prt_2", 2, { model_call_id: 999 }),
    ),
    accepts(
      "the structure of a conversation as JSON",
      partText("ptx_2", "prt_2", 2, { structure: '{"messages":[{"author":"Piotr","text":"Atlas ma ryzyko"}]}' }),
    ),
    refuses(
      "a structure that is not JSON",
      jsonOrNull("structure"),
      partText("ptx_2", "prt_2", 2, { structure: "{broken" }),
    ),
    // json_valid() reads as far as the character and finds an object.
    refuses(
      "a structure with a NUL character and more behind the JSON",
      jsonOrNull("structure"),
      partText("ptx_2", "prt_2", 2, { structure: `{}${NUL}not json` }),
    ),
    // JSON.stringify() writes the character as an escape, which is JSON like any other.
    accepts(
      "a structure whose text holds the character, written as JSON writes it",
      partText("ptx_2", "prt_2", 2, { structure: JSON.stringify({ text: `a${NUL}b` }) }),
    ),
    refuses("derived text of a part that does not exist", FOREIGN_KEY, partText("ptx_2", "prt_nowhere", 1)),
    refuses("the same revision twice", REVISION_NEVER_EDITED, partText("ptx_2", "prt_2", 1)),
    following(
      [part("prt_3", "cap_c1", 2, "image", { file_sha256: SHA })],
      accepts("the first revision of another part", partText("ptx_2", "prt_3", 1)),
    ),
    refuses("an id that a revision has already", REVISION_NEVER_EDITED, partText("ptx_1", "prt_2", 2)),
    refuses("a revision below 1", check("revision >= 1"), partText("ptx_2", "prt_2", 0)),
    refuses(
      "an origin that is not a lower-case identifier",
      identifier("origin"),
      partText("ptx_2", "prt_2", 2, { origin: "By Hand" }),
    ),
    refuses(
      "an origin with a NUL character",
      identifier("origin"),
      partText("ptx_2", "prt_2", 2, { origin: `correction${NUL}x` }),
    ),
    // Nothing of a revision changes, whatever the column.
    refuses(
      "another text for a revision",
      REVISION_NEVER_EDITED,
      update("capture_part_texts", "ptx_1", { text: "co innego" }),
    ),
    refuses("another id for a revision", REVISION_NEVER_EDITED, update("capture_part_texts", "ptx_1", { id: "ptx_9" })),
    refuses(
      "a revision moved to another part",
      REVISION_NEVER_EDITED,
      update("capture_part_texts", "ptx_1", { part_id: "prt_1" }),
    ),
    refuses(
      "another number for a revision",
      REVISION_NEVER_EDITED,
      update("capture_part_texts", "ptx_1", { revision: 9 }),
    ),
    refuses(
      "another origin for a revision",
      REVISION_NEVER_EDITED,
      update("capture_part_texts", "ptx_1", { origin: "correction" }),
    ),
    refuses(
      "a model call for a revision that had none",
      REVISION_NEVER_EDITED,
      update("capture_part_texts", "ptx_1", { model_call_id: 1 }),
    ),
    refuses(
      "another time for a revision",
      REVISION_NEVER_EDITED,
      update("capture_part_texts", "ptx_1", { created_at: T4 }),
    ),
    refuses(
      "another structure for a revision",
      REVISION_NEVER_EDITED,
      update("capture_part_texts", "ptx_1", { structure: "{}" }),
    ),
    refuses(
      "a revision written back as it is",
      REVISION_NEVER_EDITED,
      sql("UPDATE capture_part_texts SET text = text WHERE id = 'ptx_1'"),
    ),
  ],
);

// Permanent deletion removes the content of a source and keeps its registry row. The row is
// marked first. A part and a revision cannot be changed, so their text goes by deleting them,
// what points at a row first, and they go only after the mark: until then a part or a revision
// that was deleted could be written again under its key with other words. After the mark the
// source takes no new part and no new revision, for the same reason.
const MARK_DELETED = update("sources", "cap_c1", { deleted_at: T3 });
const CONTENT_GONE = [
  MARK_DELETED,
  remove("capture_part_texts", "ptx_1"),
  remove("capture_parts", "prt_2"),
  remove("capture_parts", "prt_1"),
];

scene(
  "the content of a capture, when its source is deleted for good",
  [...CAPTURE, ...EMPTY_CAPTURE, TRANSCRIPT, mention("mnt_1")],
  [
    refuses(
      "deleting a revision of derived text before the source is marked deleted",
      REVISION_GOES_WITH_SOURCE,
      remove("capture_part_texts", "ptx_1"),
    ),
    refuses(
      "deleting a part before the source is marked deleted",
      PART_GOES_WITH_SOURCE,
      remove("capture_parts", "prt_1"),
    ),
    // Whatever the part and whichever the revision: the image, and a correction.
    refuses(
      "deleting a part that is not the typed one before the source is marked deleted",
      PART_GOES_WITH_SOURCE,
      remove("capture_parts", "prt_2"),
    ),
    following(
      [partText("ptx_2", "prt_2", 2, { origin: "correction" })],
      refuses(
        "deleting a later revision of derived text before the source is marked deleted",
        REVISION_GOES_WITH_SOURCE,
        remove("capture_part_texts", "ptx_2"),
      ),
    ),
    refuses(
      "deleting every part of a capture in one statement before its source is marked deleted",
      PART_GOES_WITH_SOURCE,
      sql("DELETE FROM capture_parts WHERE capture_id = 'cap_c1'"),
    ),
    accepts("the mark of deletion on the registry row", MARK_DELETED),
    accepts("deleting a mention", remove("mentions", "mnt_1")),
    following(
      [MARK_DELETED],
      accepts("deleting a revision of derived text", remove("capture_part_texts", "ptx_1")),
      accepts("deleting a part that has no derived text", remove("capture_parts", "prt_1")),
      // No foreign key has an action: what points at a row goes first.
      refuses("deleting a part that has derived text", FOREIGN_KEY, remove("capture_parts", "prt_2")),
      refuses(
        "a new part for the source",
        PART_OF_DELETED_SOURCE,
        part("prt_9", "cap_c1", 2, "pasted", { text: "nowa treść" }),
      ),
      refuses(
        "a new revision of derived text for the source",
        REVISION_OF_DELETED_SOURCE,
        partText("ptx_2", "prt_2", 2, { origin: "correction" }),
      ),
      // The mark is on one source.
      accepts("a part of another capture", part("prt_9", "cap_c2", 0, "typed", { text: "odpisać Piotrowi" })),
      // The file goes last, after the parts that use it.
      refuses("deleting the file while a part still uses it", FILE_IN_USE, deleteFile(SHA)),
    ),
    following(
      [MARK_DELETED, remove("capture_parts", "prt_1")],
      refuses(
        "the typed part written again under its id, with other words",
        PART_OF_DELETED_SOURCE,
        part("prt_1", "cap_c1", 0, "typed", { text: "usuń wszystko" }),
      ),
    ),
    following(
      [MARK_DELETED, remove("capture_part_texts", "ptx_1")],
      refuses(
        "the revision written again under its id, with other words",
        REVISION_OF_DELETED_SOURCE,
        partText("ptx_1", "prt_2", 1, { text: "Piotr: wszystko idzie dobrze" }),
      ),
    ),
    following(
      CONTENT_GONE,
      accepts("deleting the capture after its parts", remove("captures", "cap_c1")),
      accepts("deleting a file that no part uses any more", deleteFile(SHA)),
    ),
    following(
      // The same content was dropped into another capture as well, as a file.
      [part("prt_8", "cap_c2", 0, "file", { file_sha256: SHA }), ...CONTENT_GONE],
      refuses("deleting a file that a part of another capture still uses", FILE_IN_USE, deleteFile(SHA)),
    ),
    following(
      [...CONTENT_GONE, remove("captures", "cap_c1")],
      refuses("deleting the registry row, which stays", SOURCE_KEPT, remove("sources", "cap_c1")),
    ),
    following(
      // The row of the capture can be written again. The mark is on the source, and stays.
      [...CONTENT_GONE, remove("captures", "cap_c1"), capture("cap_c1")],
      refuses(
        "a part for a capture that was written again after its source was marked deleted",
        PART_OF_DELETED_SOURCE,
        part("prt_9", "cap_c1", 0, "typed", { text: "nowa treść" }),
      ),
    ),
  ],
);

describe("the content of a capture, when its source is deleted for good", () => {
  // The whole of it in the order that the rules ask for, in one transaction: the mark, the
  // quotes, the derived text, the parts, the capture, the file.
  it("goes in one transaction, and the registry row, the fact and the journal entry stay", () => {
    const db = given(
      ...CAPTURE,
      TRANSCRIPT,
      PROJECT,
      fact("fct_1"),
      manual("opr_m1", { kind: "add_fact", source_id: "cap_c1", quote: "Atlas ma ryzyko" }),
      effect("opr_m1", { entity_kind: "fact", entity_id: "fct_1", change: "create", after_value: '{"id":"fct_1"}' }),
    );

    db.transaction(() => {
      for (const statement of [
        MARK_DELETED,
        update("facts", "fct_1", { quote: null }),
        update("operations", "opr_m1", { quote: null, payload: "{}", scrubbed_at: T3 }),
        sql(
          "UPDATE operation_effects SET scrubbed = 1, before_value = NULL, after_value = NULL WHERE operation_id = 'opr_m1'",
        ),
        sql(
          "DELETE FROM capture_part_texts WHERE part_id IN (SELECT id FROM capture_parts WHERE capture_id = 'cap_c1')",
        ),
        sql("DELETE FROM capture_parts WHERE capture_id = 'cap_c1'"),
        remove("captures", "cap_c1"),
        deleteFile(SHA),
      ]) {
        expect(attempt(db, statement), statement.sql).toBe(ACCEPTED);
      }
    })();

    expect(db.prepare("SELECT id, deleted_at FROM sources").all()).toEqual([{ id: "cap_c1", deleted_at: T3 }]);
    expect(db.prepare("SELECT source_id, quote, text FROM facts").all()).toEqual([
      { source_id: "cap_c1", quote: null, text: "Ryzyko opóźnienia" },
    ]);
    expect(db.prepare("SELECT source_id, quote, scrubbed_at FROM operations").all()).toEqual([
      { source_id: "cap_c1", quote: null, scrubbed_at: T3 },
    ]);
    for (const table of ["captures", "capture_parts", "capture_part_texts", "files"]) {
      expect(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get(), table).toBe(0);
    }
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Persons
// ---------------------------------------------------------------------------------------------

scene("a person", PERSONS, [
  accepts("a person with a name", person("per_new", "Magda Wójcik", { relation: "external", job_title: "PM" })),
  refuses("a second person who is the owner", unique("persons.is_me"), person("per_me2", "Ja też", { is_me: 1 })),
  refuses(
    "an owner mark that is neither 0 nor 1",
    check("is_me IN (0, 1)"),
    person("per_new", "Magda Wójcik", { is_me: 2 }),
  ),
  refuses("a blank name", check("trim(name) <> ''"), person("per_new", "   ", { name_norm: "x" })),
  refuses("an empty folded name", check("name_norm <> ''"), person("per_new", "Magda Wójcik", { name_norm: "" })),
  refuses("a relation outside the list", FOREIGN_KEY, person("per_new", "Magda Wójcik", { relation: "friend" })),
  refuses(
    "a person merged into itself",
    check("merged_into_id IS NULL OR merged_into_id <> id"),
    sql("UPDATE persons SET merged_into_id = id WHERE id = 'per_anna'"),
  ),
  refuses(
    "the owner merged into someone",
    check("is_me = 0 OR merged_into_id IS NULL"),
    update("persons", "per_me", { merged_into_id: "per_anna" }),
  ),
  refuses(
    "a person merged into nobody that exists",
    FOREIGN_KEY,
    update("persons", "per_anna", { merged_into_id: "per_nobody" }),
  ),
]);

scene(
  "the other names of a person",
  [...PERSONS, personAlias("pal_1", "per_anna", "Ania")],
  [
    accepts("an alias", personAlias("pal_2", "per_anna", "Anka")),
    refuses(
      "the same alias of the same person again, whatever its case",
      unique("person_aliases.person_id", "person_aliases.alias_norm", "person_aliases.context"),
      personAlias("pal_2", "per_anna", "ANIA"),
    ),
    accepts("the same alias in a context", personAlias("pal_2", "per_anna", "Ania", { context: "z płatności" })),
    // That several persons answer to one name is what makes a mention ambiguous: it is data.
    accepts("the same alias for another person", personAlias("pal_2", "per_piotr", "Ania")),
    refuses("a blank alias", check("trim(alias) <> ''"), personAlias("pal_2", "per_anna", "  ", { alias_norm: "x" })),
    refuses(
      "an empty folded alias",
      check("alias_norm <> ''"),
      personAlias("pal_2", "per_anna", "Anka", { alias_norm: "" }),
    ),
    refuses("deleting a person who has aliases", FOREIGN_KEY, remove("persons", "per_anna")),
  ],
);

// ---------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------

// A project is the top of a tree and has no parent. A task stands alone, sits in a project or sits
// under another task, to any depth. "Podzadanie" is a word of the interface for a task under a
// task: the database knows two kinds.
const ITEM_KIND = check("kind IN ('project', 'task')");

scene("the hierarchy of items", DEEP, [
  accepts("a project", item("itm_x", "project")),
  accepts("a task in a project", item("itm_x", "task", "itm_p1")),
  accepts("a task that stands alone", item("itm_x", "task")),
  accepts("a task under a task of a project", item("itm_x", "task", "itm_t10")),
  accepts("a task under a task that stands alone", item("itm_x", "task", "itm_t11")),
  accepts("a task at the fourth level", item("itm_x", "task", "itm_s20")),
  accepts("a task at the sixth level", item("itm_x", "task", "itm_d40")),
  refuses("a project in a project", NO_PARENT, item("itm_x", "project", "itm_p1")),
  refuses("a project under a task", NO_PARENT, item("itm_x", "project", "itm_d40")),
  refuses("a parent that does not exist", FOREIGN_KEY, item("itm_x", "task", "itm_nowhere")),
  refuses("a kind outside the two", ITEM_KIND, item("itm_x", "epic")),
  // The list is held to its two spellings: no other case, no space.
  refuses("a kind in capitals", ITEM_KIND, item("itm_x", "Project")),
  refuses("a kind with a space after it", ITEM_KIND, item("itm_x", "task ", "itm_p1")),
  // The word that the interface has for a task under a task.
  refuses("the kind subtask", ITEM_KIND, item("itm_x", "subtask", "itm_t10")),
  refuses("an item without a kind", notNull("items.kind"), item("itm_x", "task", null, { kind: null })),
  // A project gets a parent by no form of statement.
  refuses(
    "a replacing INSERT that puts a project into a project",
    NO_PARENT,
    replacing(item("itm_p2", "project", "itm_p1")),
  ),
  refuses("an ignoring INSERT of a project in a project", NO_PARENT, ignoring(item("itm_x", "project", "itm_p1"))),
  refuses("an ignoring UPDATE that puts a project into a project", NO_PARENT, ignoring(move("itm_p2", "itm_p1"))),
  refuses(
    "an upsert whose update puts a project into a project",
    NO_PARENT,
    onConflict(item("itm_p2", "project"), "(id) DO UPDATE SET parent_id = 'itm_p1'"),
  ),
  refuses(
    "an upsert that carries a project with a parent, whatever its update does",
    NO_PARENT,
    onConflict(item("itm_p2", "project", "itm_p1"), "(id) DO UPDATE SET title = excluded.title"),
  ),
  // Nor does any form of statement leave a parent that is not there.
  refuses(
    "a replacing INSERT that gives an item a parent that does not exist",
    FOREIGN_KEY,
    replacing(item("itm_t10", "task", "itm_nowhere")),
  ),
  refuses(
    "an upsert whose update gives an item a parent that does not exist",
    FOREIGN_KEY,
    onConflict(item("itm_t10", "task", "itm_p1"), "(id) DO UPDATE SET parent_id = 'itm_nowhere'"),
  ),
  refuses("deleting a project that has tasks", FOREIGN_KEY, remove("items", "itm_p1")),
  refuses("deleting a parent that has children", FOREIGN_KEY, remove("items", "itm_t10")),
  refuses("deleting an item in the middle of a chain", FOREIGN_KEY, remove("items", "itm_d30")),
  accepts("deleting the item at the end of a chain", remove("items", "itm_d40")),
  accepts("a task written back with its kind and its parent", itsOwn("items", "itm_d40", "kind", "parent_id")),
  accepts("a project written back with its kind and its parent", itsOwn("items", "itm_p1", "kind", "parent_id")),
  // No rule ties the status of a parent to what sits under it.
  following(
    [update("items", "itm_d40", { status: "done", closed_at: T })],
    accepts("a new task under a closed task", item("itm_x", "task", "itm_d40")),
  ),
]);

// No item is its own ancestor. The foreign key alone would take every one of these: each parent exists.
scene("a cycle in the hierarchy of items", DEEP, [
  // Length one.
  refuses("a new item as its own parent", OWN_ANCESTOR, item("itm_x", "task", "itm_x")),
  refuses("an item made its own parent", OWN_ANCESTOR, sql("UPDATE items SET parent_id = id WHERE id = 'itm_t11'")),
  refuses("an item in a tree made its own parent", OWN_ANCESTOR, move("itm_s20", "itm_s20")),
  // Length two.
  refuses("an item moved under its child", OWN_ANCESTOR, move("itm_t10", "itm_s20")),
  refuses("a task that stands alone moved under its child", OWN_ANCESTOR, move("itm_t11", "itm_s21")),
  // Longer.
  refuses("an item moved under the child of its child", OWN_ANCESTOR, move("itm_t10", "itm_d30")),
  refuses("an item moved under the last item of its own chain", OWN_ANCESTOR, move("itm_t10", "itm_d40")),
  // By a change of kind: a project can get a parent only by becoming a task in the same statement.
  refuses(
    "a project made a task under its own task",
    OWN_ANCESTOR,
    update("items", "itm_p1", { kind: "task", parent_id: "itm_t10" }),
  ),
  refuses(
    "a project made a task under the last item of its own tree",
    OWN_ANCESTOR,
    update("items", "itm_p1", { kind: "task", parent_id: "itm_d40" }),
  ),
  following(
    [update("items", "itm_p1", { kind: "task" })],
    refuses("a project made a task, then moved under its own task", OWN_ANCESTOR, move("itm_p1", "itm_s20")),
  ),
  // By the forms of INSERT that write over a row. The replacing form fires no trigger of UPDATE or
  // DELETE: the guard of INSERT is the only one that sees it.
  refuses(
    "a replacing INSERT that puts an item under the last item of its own chain",
    OWN_ANCESTOR,
    replacing(item("itm_t10", "task", "itm_d40")),
  ),
  refuses(
    "a replacing INSERT that makes an item its own parent",
    OWN_ANCESTOR,
    replacing(item("itm_t10", "task", "itm_t10")),
  ),
  refuses(
    "an ignoring INSERT of an item that is its own parent",
    OWN_ANCESTOR,
    ignoring(item("itm_x", "task", "itm_x")),
  ),
  refuses("an ignoring UPDATE that moves an item under its child", OWN_ANCESTOR, ignoring(move("itm_t10", "itm_s20"))),
  // An upsert meets both guards: that of INSERT with the row it carries, then that of UPDATE with
  // the row it leaves.
  refuses(
    "an upsert whose update moves an item under its child",
    OWN_ANCESTOR,
    onConflict(item("itm_t10", "task", "itm_p1"), "(id) DO UPDATE SET parent_id = 'itm_s20'"),
  ),
  refuses(
    "an upsert whose update makes an item its own parent",
    OWN_ANCESTOR,
    onConflict(item("itm_t10", "task", "itm_p1"), "(id) DO UPDATE SET parent_id = excluded.id"),
  ),
  refuses(
    "an upsert that carries a row under its own child, whatever its update does",
    OWN_ANCESTOR,
    onConflict(item("itm_t10", "task", "itm_s20"), "(id) DO UPDATE SET title = excluded.title"),
  ),
  // By one statement over several rows: the rows are judged one after another, each against what
  // the statement has already written.
  refuses(
    "two items made each other's parent by one UPDATE",
    OWN_ANCESTOR,
    sql(
      "UPDATE items SET parent_id = CASE id WHEN 'itm_t10' THEN 'itm_t11' ELSE 'itm_t10' END WHERE id IN ('itm_t10', 'itm_t11')",
    ),
  ),
  refuses(
    "every task of a tree turned upside down by one UPDATE",
    OWN_ANCESTOR,
    sql(
      "UPDATE items SET parent_id = (SELECT c.id FROM items c WHERE c.parent_id = items.id) WHERE id IN ('itm_t10', 'itm_s20', 'itm_d30')",
    ),
  ),
  refuses(
    "an UPDATE with a FROM clause that moves an item under its child",
    OWN_ANCESTOR,
    sql(
      "UPDATE items SET parent_id = c.id FROM (SELECT id FROM items WHERE parent_id = 'itm_t10') AS c WHERE items.id = 'itm_t10'",
    ),
  ),
  refuses(
    "an INSERT from a SELECT of a row that is its own parent",
    OWN_ANCESTOR,
    sql(
      "INSERT INTO items (id, kind, parent_id, title, title_norm, status, importance, is_milestone, created_at, last_activity_at) SELECT 'itm_x', kind, 'itm_x', title, title_norm, status, importance, is_milestone, created_at, last_activity_at FROM items WHERE id = 'itm_t10'",
    ),
  ),
]);

// What moving means: one UPDATE of parent_id on the top of what moves. Nothing under it is written.
scene("an item moved in the hierarchy", DEEP, [
  accepts("a task moved to another project", move("itm_t10", "itm_p2")),
  accepts("a task taken out of its project", move("itm_t10", null)),
  accepts("a task that stands alone put into a project", move("itm_t11", "itm_p1")),
  accepts("a task under a task moved up to the project", move("itm_s20", "itm_p1")),
  following([move("itm_s20", "itm_p1")], accepts("the same task moved back", move("itm_s20", "itm_t10"))),
  accepts("a task with everything under it moved under a task of another tree", move("itm_t10", "itm_s21")),
  accepts("a task moved further down another branch", move("itm_s21", "itm_d40")),
  accepts("a task taken out of the middle of a chain with what is under it", move("itm_d30", null)),
  accepts("the last item of a chain moved to its top", move("itm_d40", "itm_p1")),
  // After the child has left, the old parent may go under it: the walk reads the rows as they are now.
  following([move("itm_s20", "itm_p1")], accepts("an item moved under what was its child", move("itm_t10", "itm_s20"))),
  following(
    [move("itm_d40", null)],
    accepts("an item moved under what was the last item of its chain", move("itm_t10", "itm_d40")),
  ),
  refuses("a project moved into a project", NO_PARENT, move("itm_p2", "itm_p1")),
  refuses("a project moved under a task", NO_PARENT, move("itm_p2", "itm_t11")),
  refuses("an item moved under a parent that does not exist", FOREIGN_KEY, move("itm_t10", "itm_nowhere")),
]);

// What a change of kind means: one UPDATE of the item. What sits under it is never written,
// whatever the item becomes.
scene(
  "the kind of an item changed",
  [
    ...DEEP,
    item("itm_p3", "project", null, { health: "yellow" }),
    item("itm_m1", "task", null, { is_milestone: 1, due_on: DAY }),
  ],
  [
    accepts("a project without tasks made a task", update("items", "itm_p2", { kind: "task" })),
    accepts("a project with a tree under it made a task", update("items", "itm_p1", { kind: "task" })),
    accepts(
      "a project made a task of another project",
      update("items", "itm_p2", { kind: "task", parent_id: "itm_p1" }),
    ),
    accepts(
      "a project with a tree under it made a task under a task of another tree",
      update("items", "itm_p1", { kind: "task", parent_id: "itm_s21" }),
    ),
    following(
      [update("items", "itm_p1", { kind: "task" })],
      accepts("a project made a task and made a project again", update("items", "itm_p1", { kind: "project" })),
      accepts("a project made a task, then put under a task of another tree", move("itm_p1", "itm_s21")),
    ),
    following(
      [update("items", "itm_p2", { kind: "task", parent_id: "itm_p1" })],
      refuses(
        "a project made a task of another project, then made a project again where it is",
        NO_PARENT,
        update("items", "itm_p2", { kind: "project" }),
      ),
      accepts(
        "a project made a task of another project, then made a project again and taken out",
        update("items", "itm_p2", { kind: "project", parent_id: null }),
      ),
    ),
    accepts("a task that stands alone made a project", update("items", "itm_m1", { kind: "project", is_milestone: 0 })),
    accepts(
      "a task that stands alone with tasks under it made a project",
      update("items", "itm_t11", { kind: "project" }),
    ),
    refuses(
      "a task of a project made a project without leaving its parent",
      NO_PARENT,
      update("items", "itm_t10", { kind: "project" }),
    ),
    accepts(
      "a task of a project made a project and taken out, with everything under it",
      update("items", "itm_t10", { kind: "project", parent_id: null }),
    ),
    refuses(
      "a task at the fifth level made a project where it is",
      NO_PARENT,
      update("items", "itm_d40", { kind: "project" }),
    ),
    accepts(
      "a task at the fifth level made a project and taken out",
      update("items", "itm_d40", { kind: "project", parent_id: null }),
    ),
    refuses(
      "a project given a parent while it stays a project",
      NO_PARENT,
      update("items", "itm_p2", { kind: "project", parent_id: "itm_p1" }),
    ),
    // The health is tied to no kind: an item keeps it through a change of kind, or loses it in the
    // same statement. The rules of the tree are asked of such a change as of any other.
    accepts("a project with a health made a task", update("items", "itm_p3", { kind: "task" })),
    accepts(
      "a project with a health made a task without it",
      update("items", "itm_p3", { kind: "task", health: null }),
    ),
    accepts(
      "a project with a health made a task of another project",
      update("items", "itm_p3", { kind: "task", parent_id: "itm_p1" }),
    ),
    following(
      [update("items", "itm_t11", { health: "red" }), update("items", "itm_t10", { health: "green" })],
      accepts("a task with a health that stands alone made a project", update("items", "itm_t11", { kind: "project" })),
      accepts(
        "a task with a health made a project and taken out of its project",
        update("items", "itm_t10", { kind: "project", parent_id: null }),
      ),
      refuses(
        "a task with a health made a project without leaving its parent",
        NO_PARENT,
        update("items", "itm_t10", { kind: "project" }),
      ),
    ),
    // The one other column that the kind is tied to is the mark of a milestone (a trigger).
    refuses("a milestone made a project", PROJECT_AS_MILESTONE, update("items", "itm_m1", { kind: "project" })),
    refuses("a kind outside the two given to an item", ITEM_KIND, update("items", "itm_t10", { kind: "subtask" })),
  ],
);

// A milestone is a mark on a task at any depth; a project is not one. No rule looks at what is
// under a milestone.
scene("a milestone in the hierarchy", DEEP, [
  accepts("a milestone in a project", item("itm_x", "task", "itm_p1", { is_milestone: 1, due_on: DAY })),
  accepts("a milestone at the sixth level", item("itm_x", "task", "itm_d40", { is_milestone: 1, due_on: DAY })),
  accepts("a task at the fifth level marked as a milestone", update("items", "itm_d40", { is_milestone: 1 })),
  accepts("a task with tasks under it marked as a milestone", update("items", "itm_s20", { is_milestone: 1 })),
  following(
    [update("items", "itm_d30", { is_milestone: 1 })],
    accepts("a task under a milestone", item("itm_x", "task", "itm_d30")),
  ),
  following(
    [update("items", "itm_s20", { is_milestone: 1 })],
    refuses(
      "a start for a milestone that has tasks under it",
      MILESTONE_WITH_START,
      update("items", "itm_s20", { start_on: DAY }),
    ),
  ),
  refuses("a project marked as a milestone", PROJECT_AS_MILESTONE, update("items", "itm_p1", { is_milestone: 1 })),
  refuses("a project that is a milestone", PROJECT_AS_MILESTONE, item("itm_x", "project", null, { is_milestone: 1 })),
]);

// The parent is not a merged item. The two guards ask about the parent itself, at any level.
scene(
  "a merged item in the hierarchy",
  [...DEEP, item("itm_dup", "task", "itm_s20"), mergeItem("itm_dup", "itm_d30")],
  [
    refuses("a task under a merged task", PARENT_MERGED, item("itm_x", "task", "itm_dup")),
    refuses("a task moved under a merged task", PARENT_MERGED, move("itm_s21", "itm_dup")),
    refuses(
      "a project made a task under a merged task",
      PARENT_MERGED,
      update("items", "itm_p2", { kind: "task", parent_id: "itm_dup" }),
    ),
    refuses(
      "a replacing INSERT that puts an item under a merged task",
      PARENT_MERGED,
      replacing(item("itm_s21", "task", "itm_dup")),
    ),
    refuses(
      "an upsert whose update moves an item under a merged task",
      PARENT_MERGED,
      onConflict(item("itm_s21", "task", "itm_t11"), "(id) DO UPDATE SET parent_id = 'itm_dup'"),
    ),
    accepts("a merged task moved", move("itm_dup", "itm_p2")),
    following(
      // A merge that marks before it has moved the children leaves them where they were.
      [mergeItem("itm_s20", "itm_s21")],
      accepts("a task written back with its merged parent", itsOwn("items", "itm_d30", "kind", "parent_id")),
      accepts("a task moved out from under its merged parent", move("itm_d30", "itm_s21")),
      refuses("a task moved under a merged item that still has children", PARENT_MERGED, move("itm_s21", "itm_s20")),
      // Below the first level under a merged item nothing is asked.
      accepts("a new task under a task that sits under a merged item", item("itm_x", "task", "itm_d30")),
      accepts("a task with a tree moved under a task that sits under a merged item", move("itm_t11", "itm_d40")),
    ),
    following(
      [mergeItem("itm_s20", "itm_s21"), move("itm_d30", "itm_s21")],
      refuses("a task moved back under its merged parent", PARENT_MERGED, move("itm_d30", "itm_s20")),
    ),
    refuses("an item merged into a merged item", ITEM_MERGE, mergeItem("itm_d40", "itm_dup")),
    // The guard of a merge asks nothing about the tree. Merged into an item above it, an item
    // leaves nothing in a wrong place. Merged into an item under it, it leaves its survivor below
    // a merged item: the application refuses such a merge.
    accepts("an item merged into an item of its own chain", mergeItem("itm_d40", "itm_t10")),
    accepts("an item merged into an item under it", mergeItem("itm_t10", "itm_d40")),
  ],
);

/** The columns of an item that is closed. */
const CLOSED = { status: "done", closed_at: T2 };

// The rules of the tree hold whatever else the items are: the item that is written, and the items
// that the walk passes on its way up. A trigger that asked a rule only of an item that is open,
// that is not merged, that is no milestone or that has no health would pass every case above.
scene(
  "the rules of the tree, whatever else the items are",
  [...DEEP, item("itm_p3", "project", null, { health: "yellow" })],
  [
    // The item that is written: merged, closed, a milestone, a project or a task with a health.
    following(
      [mergeItem("itm_t10", "itm_t11"), mergeItem("itm_p2", "itm_p1")],
      refuses("a merged item moved under its own descendant", OWN_ANCESTOR, move("itm_t10", "itm_d40")),
      refuses("a merged project given a parent", NO_PARENT, move("itm_p2", "itm_t11")),
    ),
    refuses(
      "an item inserted as merged and as its own parent",
      OWN_ANCESTOR,
      item("itm_x", "task", "itm_x", { merged_into_id: "itm_p2" }),
    ),
    refuses(
      "a project inserted as merged, with a parent",
      NO_PARENT,
      item("itm_x", "project", "itm_t11", { merged_into_id: "itm_p2" }),
    ),
    refuses("a closed item inserted as its own parent", OWN_ANCESTOR, item("itm_x", "task", "itm_x", CLOSED)),
    refuses("a closed project inserted with a parent", NO_PARENT, item("itm_x", "project", "itm_t11", CLOSED)),
    following(
      [update("items", "itm_t10", CLOSED), update("items", "itm_p2", CLOSED)],
      refuses("a closed item moved under its own descendant", OWN_ANCESTOR, move("itm_t10", "itm_d40")),
      refuses("a closed project given a parent", NO_PARENT, move("itm_p2", "itm_t11")),
    ),
    following(
      [update("items", "itm_t10", { is_milestone: 1 })],
      refuses("a milestone moved under its own descendant", OWN_ANCESTOR, move("itm_t10", "itm_d40")),
    ),
    refuses(
      "a milestone inserted as its own parent",
      OWN_ANCESTOR,
      item("itm_x", "task", "itm_x", { is_milestone: 1 }),
    ),
    refuses("a project with a health given a parent", NO_PARENT, move("itm_p3", "itm_t11")),
    refuses(
      "a project with a health inserted with a parent",
      NO_PARENT,
      item("itm_x", "project", "itm_t11", { health: "yellow" }),
    ),
    following(
      [update("items", "itm_t10", { health: "red" })],
      refuses("a task with a health moved under its own descendant", OWN_ANCESTOR, move("itm_t10", "itm_d40")),
    ),
    refuses(
      "a task with a health inserted as its own parent",
      OWN_ANCESTOR,
      item("itm_x", "task", "itm_x", { health: "red" }),
    ),
    // The items on the way up: the walk passes a merged item, a closed item, a milestone and a task
    // with a health.
    ...(
      [
        ["a merged item", mergeItem("itm_s20", "itm_s21")],
        ["a closed item", update("items", "itm_s20", CLOSED)],
        ["a milestone", update("items", "itm_s20", { is_milestone: 1 })],
        ["a task that has a health", update("items", "itm_s20", { health: "red" })],
      ] as [string, Statement][]
    ).map(([what, between]) =>
      following(
        [between],
        refuses(
          `an item moved under its own descendant, with ${what} between them`,
          OWN_ANCESTOR,
          move("itm_t10", "itm_d40"),
        ),
        refuses(
          `a replacing INSERT of an item under its own descendant, with ${what} between them`,
          OWN_ANCESTOR,
          replacing(item("itm_t10", "task", "itm_d40")),
        ),
      ),
    ),
    // The guards against a merged parent ask about the parent, whatever the item is that goes there.
    following(
      [
        item("itm_dup", "task", "itm_s20"),
        mergeItem("itm_dup", "itm_d30"),
        mergeItem("itm_s21", "itm_t10"),
        update("items", "itm_d40", CLOSED),
        update("items", "itm_t11", { is_milestone: 1 }),
      ],
      refuses("a merged item moved under a merged item", PARENT_MERGED, move("itm_s21", "itm_dup")),
      refuses("a closed item moved under a merged item", PARENT_MERGED, move("itm_d40", "itm_dup")),
      refuses("a milestone moved under a merged item", PARENT_MERGED, move("itm_t11", "itm_dup")),
      refuses(
        "an item inserted as merged under a merged item",
        PARENT_MERGED,
        item("itm_x", "task", "itm_dup", { merged_into_id: "itm_p2" }),
      ),
      refuses("an item inserted closed under a merged item", PARENT_MERGED, item("itm_x", "task", "itm_dup", CLOSED)),
      refuses(
        "a milestone inserted under a merged item",
        PARENT_MERGED,
        item("itm_x", "task", "itm_dup", { is_milestone: 1 }),
      ),
    ),
    following(
      [
        item("itm_dup", "task", "itm_s20"),
        mergeItem("itm_dup", "itm_d30"),
        update("items", "itm_t11", { health: "red" }),
      ],
      refuses("a task with a health moved under a merged item", PARENT_MERGED, move("itm_t11", "itm_dup")),
      refuses(
        "a task with a health inserted under a merged item",
        PARENT_MERGED,
        item("itm_x", "task", "itm_dup", { health: "red" }),
      ),
    ),
  ],
);

describe("the rules of the tree, on rows that are there already", () => {
  const PAIR = ["items_hierarchy_insert", "items_hierarchy_update"];
  /** The two triggers that hold the rules, each as the database spells it. */
  const pairOf = (db: Connection) => {
    const text = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").pluck();
    return PAIR.map((name) => text.get(name) as string);
  };
  /** A database that lost the pair for a while: a cycle of two with a row under it, and a project in a project. */
  const broken = () => {
    let pair: string[] = [];
    return given(
      ...DEEP,
      (db) => {
        pair = pairOf(db);
      },
      without(...PAIR),
      item("itm_ca", "task"),
      item("itm_cb", "task", "itm_ca"),
      move("itm_ca", "itm_cb"),
      item("itm_under", "task", "itm_cb"),
      move("itm_p2", "itm_p1"),
      (db) => {
        for (const trigger of pair) db.exec(trigger);
      },
    );
  };

  // The pair judges the row as it will be and does not compare it with the row as it was.
  it("refuse a row that breaks a rule when it is written back with its kind, its parent or its id", () => {
    const db = broken();

    expect(attempt(db, itsOwn("items", "itm_ca", "kind"))).toEqual(OWN_ANCESTOR);
    expect(attempt(db, itsOwn("items", "itm_cb", "parent_id"))).toEqual(OWN_ANCESTOR);
    expect(attempt(db, itsOwn("items", "itm_ca", "id"))).toEqual(OWN_ANCESTOR);
    expect(attempt(db, itsOwn("items", "itm_p2", "kind"))).toEqual(NO_PARENT);
    // A statement that names none of the three columns does not meet the pair, and one that
    // repairs the row passes it.
    expect(attempt(db, itsOwn("items", "itm_ca", "title"))).toBe(ACCEPTED);
    expect(attempt(db, move("itm_ca", null))).toBe(ACCEPTED);
    expect(attempt(db, update("items", "itm_p2", { kind: "task" }))).toBe(ACCEPTED);
  });

  // UNION and not UNION ALL: the walk ends on any data. That is asked of the walk itself, as each
  // trigger spells it, with a limit on the rows it may gather: a walk that met a row of the cycle
  // again and again would fill the limit here, and a statement under the cycle would never return.
  it("walk up from a row on a cycle and come to an end, with each row of the cycle met once", () => {
    const db = broken();

    for (const trigger of pairOf(db)) {
      const walk = /WITH RECURSIVE ancestors[\s\S]*(?=\)\s*SELECT 1 FROM ancestors)/
        .exec(trigger)?.[0]
        .replaceAll("NEW.parent_id", "'itm_cb'");
      expect(walk, "the walk of the trigger").toBeDefined();
      expect(db.prepare(`${walk} LIMIT 1000) SELECT count(*) FROM ancestors`).pluck().get()).toBe(2);
    }
    expect(attempt(db, item("itm_x", "task", "itm_under"))).toBe(ACCEPTED);
    expect(attempt(db, move("itm_t11", "itm_under"))).toBe(ACCEPTED);
  });
});

describe("the hierarchy of items, changed by several statements", () => {
  const write = (db: Connection, { sql: text, params }: Statement) => db.prepare(text).run(...params);
  /** Every row under an item, at any depth, as it is stored. */
  const rowsUnder = (db: Connection, id: string) =>
    db
      .prepare(
        "WITH RECURSIVE tree (id) AS (SELECT ? UNION ALL SELECT c.id FROM tree JOIN items c ON c.parent_id = tree.id) SELECT i.* FROM tree CROSS JOIN items i ON i.id = tree.id WHERE i.id <> ? ORDER BY i.id",
      )
      .all(id, id);
  /** How many items stand above an item. */
  const depthOf = (db: Connection, id: string) =>
    db
      .prepare(
        "WITH RECURSIVE up (id, n) AS (SELECT ?, 0 UNION ALL SELECT i.parent_id, up.n + 1 FROM up JOIN items i ON i.id = up.id WHERE i.parent_id IS NOT NULL) SELECT max(n) FROM up",
      )
      .pluck()
      .get(id);
  const parentOf = (db: Connection, id: string) =>
    db.prepare("SELECT parent_id FROM items WHERE id = ?").pluck().get(id);
  /** The items that sit on a cycle, found by following the parents in code, without a walk in SQL: none in a forest. */
  const onACycle = (db: Connection) => {
    const rows = db.prepare("SELECT id, parent_id FROM items").all() as { id: string; parent_id: string | null }[];
    const parents = new Map(rows.map(({ id, parent_id }) => [id, parent_id]));
    return rows
      .map(({ id }) => id)
      .filter((start) => {
        const seen = new Set<string>();
        for (let at = parents.get(start); typeof at === "string" && !seen.has(at); at = parents.get(at)) {
          if (at === start) return true;
          seen.add(at);
        }
        return false;
      });
  };
  /** Statements in one transaction that is committed, with the check of foreign keys put off to the commit. */
  const commitDeferred = (db: Connection, ...statements: Statement[]) =>
    db.transaction(() => {
      db.pragma("defer_foreign_keys = ON");
      for (const statement of statements) write(db, statement);
    })();
  /** A chain of tasks under the project, each under the one before it: itm_p1 > itm_c1 > itm_c2 and so on. */
  const chain = (db: Connection, levels: number) => {
    const link = db.prepare(
      "INSERT INTO items (id, kind, parent_id, title, title_norm, status, importance, is_milestone, created_at, last_activity_at) VALUES (?, 'task', ?, 't', 't', 'todo', ?, 0, ?, ?)",
    );
    db.transaction(() => {
      for (let level = 1; level <= levels; level++) {
        link.run(`itm_c${level}`, level === 1 ? "itm_p1" : `itm_c${level - 1}`, DEFAULT_ITEM_IMPORTANCE, T, T);
      }
    })();
  };

  it("moves a task with everything under it by one UPDATE that writes one row", () => {
    const db = given(...DEEP);
    const under = rowsUnder(db, "itm_t10");
    const written = () => db.prepare("SELECT total_changes()").pluck().get() as number;
    const before = written();

    expect(write(db, move("itm_t10", "itm_s21")).changes).toBe(1);

    expect(written() - before).toBe(1);
    expect(rowsUnder(db, "itm_t10")).toEqual(under);
    expect(under).toHaveLength(3);
    // itm_t11 > itm_s21 > itm_t10 > itm_s20 > itm_d30 > itm_d40: what was the fifth level is the sixth.
    expect(depthOf(db, "itm_d40")).toBe(5);
  });

  it("makes a task with tasks under it a project by one UPDATE; the tasks under it are not written", () => {
    const db = given(...DEEP);
    const under = rowsUnder(db, "itm_t10");

    expect(write(db, update("items", "itm_t10", { kind: "project", parent_id: null })).changes).toBe(1);

    expect(rowsUnder(db, "itm_t10")).toEqual(under);
    expect(db.prepare("SELECT kind, parent_id FROM items WHERE id = 'itm_t10'").get()).toEqual({
      kind: "project",
      parent_id: null,
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("makes a project with a tree under it a task and a project again; the tree is not written", () => {
    const db = given(...DEEP);
    const under = rowsUnder(db, "itm_p1");

    write(db, update("items", "itm_p1", { kind: "task", parent_id: "itm_s21" }));
    expect(rowsUnder(db, "itm_p1")).toEqual(under);
    expect(depthOf(db, "itm_d40")).toBe(6);
    write(db, update("items", "itm_p1", { kind: "project", parent_id: null }));

    expect(rowsUnder(db, "itm_p1")).toEqual(under);
    expect(depthOf(db, "itm_d40")).toBe(4);
  });

  it("refuses a cycle that one UPDATE of several rows would close, and nothing of the statement stays", () => {
    const db = given(...DEEP);
    const rows = () => db.prepare("SELECT * FROM items ORDER BY id").all();
    const before = rows();

    expect(
      attempt(
        db,
        sql(
          "UPDATE items SET parent_id = CASE id WHEN 'itm_t10' THEN 'itm_t11' ELSE 'itm_t10' END WHERE id IN ('itm_t10', 'itm_t11')",
        ),
      ),
    ).toEqual(OWN_ANCESTOR);

    expect(rows()).toEqual(before);
  });

  it("swaps a parent and its child by statements that each leave a tree", () => {
    const db = given(...DEEP);

    // itm_t10 > itm_s20 becomes itm_s20 > itm_t10: the child leaves first.
    expect(attempt(db, move("itm_s20", "itm_p1"))).toBe(ACCEPTED);
    expect(attempt(db, move("itm_t10", "itm_s20"))).toBe(ACCEPTED);

    expect(parentOf(db, "itm_s20")).toBe("itm_p1");
    expect(parentOf(db, "itm_t10")).toBe("itm_s20");
    expect(onACycle(db)).toEqual([]);
  });

  // With the check of foreign keys put off to the commit a transaction may pass through a parent
  // that is not there yet. It may not pass through a cycle: the guard judges every statement.
  it("refuses the same swap in the other order, also while the check of foreign keys waits for the commit", () => {
    const db = given(...DEEP);

    // The parent goes under its child first.
    expect(deferred(db, move("itm_t10", "itm_s20"), move("itm_s20", "itm_p1"))).toEqual([OWN_ANCESTOR, ACCEPTED]);
  });

  it("accepts a child that is written before its parent while the check of foreign keys waits for the commit", () => {
    const db = given(...ITEMS);

    commitDeferred(db, item("itm_child", "task", "itm_late"), item("itm_late", "task", "itm_p1"));

    expect(depthOf(db, "itm_child")).toBe(2);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  // That a project has no parent is asked of the row that is written, whether or not the row it
  // names is there.
  it("refuses a project that is written before the parent it names, with the check of foreign keys put off or switched off", () => {
    const db = given(...ITEMS);

    expect(deferred(db, item("itm_a", "project", "itm_late"), item("itm_late", "task", "itm_p1"))).toEqual([
      NO_PARENT,
      ACCEPTED,
    ]);
    db.pragma("foreign_keys = OFF");
    expect(attempt(db, item("itm_a", "project", "itm_late"))).toEqual(NO_PARENT);
  });

  it("refuses, at the second INSERT, two new items that are each other's parent", () => {
    const db = given(...ITEMS);

    expect(deferred(db, item("itm_a", "task", "itm_b"), item("itm_b", "task", "itm_a"))).toEqual([
      ACCEPTED,
      OWN_ANCESTOR,
    ]);
  });

  it("refuses a cycle of three new items that are written from the bottom, at the INSERT that closes it", () => {
    const db = given(...ITEMS);

    expect(
      deferred(db, item("itm_a", "task", "itm_b"), item("itm_b", "task", "itm_c"), item("itm_c", "task", "itm_a")),
    ).toEqual([ACCEPTED, ACCEPTED, OWN_ANCESTOR]);
  });

  // An item keeps its id, so this is refused twice over. The guard of the tree is asked as well
  // when an id is written: it holds its rule on a database that has lost the guard of ids.
  it("refuses an item that becomes its own parent by a change of its id, also without the guard that keeps ids", () => {
    const renamed = [item("itm_a", "task", "itm_b"), update("items", "itm_a", { id: "itm_b" })];

    const [first, second] = deferred(given(...ITEMS), ...renamed);
    expect(first).toBe(ACCEPTED);
    expect([ITEM_ID_FIXED, OWN_ANCESTOR]).toContainEqual(second);
    expect(deferred(given(...ITEMS, without("items_id_fixed")), ...renamed)).toEqual([ACCEPTED, OWN_ANCESTOR]);
  });

  it("refuses, at the commit, a parent that never came, and nothing of the transaction stays", () => {
    const db = given(...ITEMS);

    expect(() => commitDeferred(db, item("itm_child", "task", "itm_never"))).toThrow(
      expect.objectContaining(FOREIGN_KEY),
    );

    expect(rowsOf(db, "items", "id = 'itm_child'")).toBe(0);
  });

  it("holds the two rules of the tree with foreign keys switched off, as a migration runs", () => {
    const db = given(...DEEP);
    db.pragma("foreign_keys = OFF");

    expect(attempt(db, item("itm_a", "task", "itm_b"))).toBe(ACCEPTED);
    expect(attempt(db, item("itm_b", "task", "itm_a"))).toEqual(OWN_ANCESTOR);
    expect(attempt(db, move("itm_t10", "itm_d40"))).toEqual(OWN_ANCESTOR);
    expect(attempt(db, item("itm_q", "project", "itm_p1"))).toEqual(NO_PARENT);
    // What only the foreign key holds is found by the check that the runner makes before it commits.
    expect(
      (db.pragma("foreign_key_check") as { table: string; parent: string }[]).map(
        ({ table, parent }) => `${table} -> ${parent}`,
      ),
    ).toEqual(["items -> items"]);
  });

  it("builds a chain of 50 levels and refuses each way of closing it", () => {
    const db = given(PROJECT);
    chain(db, 50);
    expect(depthOf(db, "itm_c50")).toBe(50);

    expect(attempt(db, move("itm_c1", "itm_c50"))).toEqual(OWN_ANCESTOR);
    expect(attempt(db, move("itm_c25", "itm_c50"))).toEqual(OWN_ANCESTOR);
    expect(attempt(db, move("itm_c49", "itm_c50"))).toEqual(OWN_ANCESTOR);
    expect(attempt(db, update("items", "itm_p1", { kind: "task", parent_id: "itm_c50" }))).toEqual(OWN_ANCESTOR);
    expect(attempt(db, move("itm_c50", "itm_c1"))).toBe(ACCEPTED);
    expect(attempt(db, move("itm_c25", "itm_c50"))).toBe(ACCEPTED);

    expect(onACycle(db)).toEqual([]);
    // itm_p1 > c1 > c50 > c25 > ... > c49, and c2 to c24 still under c1.
    expect(depthOf(db, "itm_c49")).toBe(27);
  });

  // The guard walks up from the new parent at every INSERT: two million steps to build the chain.
  it("builds a chain of 2,000 levels: the database sets no limit of depth", { timeout: 30_000 }, () => {
    const db = given(PROJECT);
    chain(db, 2000);
    expect(depthOf(db, "itm_c2000")).toBe(2000);

    expect(attempt(db, move("itm_c1", "itm_c2000"))).toEqual(OWN_ANCESTOR);
    expect(attempt(db, move("itm_c2000", "itm_p1"))).toBe(ACCEPTED);
  });

  it("builds a tree of 5,000 tasks under one task and refuses to put the task under one of them", () => {
    const db = given(...ITEMS);
    const leaf = db.prepare(
      "INSERT INTO items (id, kind, parent_id, title, title_norm, status, importance, is_milestone, created_at, last_activity_at) VALUES (?, 'task', 'itm_t10', 't', 't', 'todo', ?, 0, ?, ?)",
    );
    db.transaction(() => {
      for (let n = 1; n <= 5000; n++) leaf.run(`itm_w${n}`, DEFAULT_ITEM_IMPORTANCE, T, T);
    })();
    expect(rowsOf(db, "items", "parent_id = 'itm_t10'")).toBe(5001);

    expect(attempt(db, move("itm_t10", "itm_w2500"))).toEqual(OWN_ANCESTOR);
    expect(attempt(db, move("itm_w1", "itm_w5000"))).toBe(ACCEPTED);
    expect(attempt(db, move("itm_t10", "itm_p2"))).toBe(ACCEPTED);
    expect(attempt(db, remove("items", "itm_t10"))).toEqual(FOREIGN_KEY);
  });

  // The order in which an undo that writes several rows of a tree has to write them. The row above
  // itm_c that is also written is not its parent but its parent's parent: the order goes by the
  // depth in the tree that is restored.
  it("restores a tree by writing its rows from the top down; the same rows written from the bottom up are refused", () => {
    // Now: itm_c > itm_a > itm_b. To restore: itm_a > itm_b > itm_c.
    const rows = [item("itm_c", "task"), item("itm_a", "task", "itm_c"), item("itm_b", "task", "itm_a")];

    const bottomUp = given(...rows);
    expect(attempt(bottomUp, move("itm_c", "itm_b"))).toEqual(OWN_ANCESTOR);

    const topDown = given(...rows);
    expect(attempt(topDown, move("itm_a", null))).toBe(ACCEPTED);
    expect(attempt(topDown, move("itm_c", "itm_b"))).toBe(ACCEPTED);
    expect(topDown.prepare("SELECT id, parent_id FROM items ORDER BY id").all()).toEqual([
      { id: "itm_a", parent_id: null },
      { id: "itm_b", parent_id: "itm_a" },
      { id: "itm_c", parent_id: "itm_b" },
    ]);
  });

  // The guard judges each row of a statement against what the statement has already written, and
  // the order in which SQLite visits the rows is its own: here, the row that was inserted first.
  // A statement that moves two items which stand above one another is therefore one that no
  // operation writes.
  it("accepts or refuses one UPDATE of two rows that stand above one another by which row is older", () => {
    // itm_up > itm_down becomes itm_down > itm_up.
    const turn = sql(
      "UPDATE items SET parent_id = CASE id WHEN 'itm_up' THEN 'itm_down' ELSE 'itm_p1' END WHERE id IN ('itm_up', 'itm_down')",
    );

    const parentOlder = given(PROJECT, item("itm_up", "task", "itm_p1"), item("itm_down", "task", "itm_up"));
    expect(attempt(parentOlder, turn)).toEqual(OWN_ANCESTOR);

    const childOlder = given(
      PROJECT,
      item("itm_down", "task", "itm_p1"),
      item("itm_up", "task", "itm_p1"),
      move("itm_down", "itm_up"),
    );
    expect(attempt(childOlder, turn)).toBe(ACCEPTED);
    expect(parentOf(childOlder, "itm_down")).toBe("itm_p1");
    expect(parentOf(childOlder, "itm_up")).toBe("itm_down");
  });

  // Which of two sentences answers is the order in which the triggers were made, the newest
  // first, and a migration that replaces a trigger changes that order: nothing may count on it.
  it("answers a statement that breaks two rules with the sentence of one of them", () => {
    // The schedule and the hierarchy: a milestone with a parent made a project where it is.
    const milestone = given(...ITEMS, item("itm_m2", "task", "itm_p1", { is_milestone: 1, due_on: DAY }));
    expect([PROJECT_AS_MILESTONE, NO_PARENT]).toContainEqual(
      attempt(milestone, update("items", "itm_m2", { kind: "project" })),
    );
    // The hierarchy and the guard of a merged parent: a new project under a merged item.
    const merged = given(...ITEMS, mergeItem("itm_s20", "itm_s21"));
    expect([NO_PARENT, PARENT_MERGED]).toContainEqual(attempt(merged, item("itm_x", "project", "itm_s20")));
    // closed_at and the hierarchy: an open task closed without its closing time and put under itself.
    const closed = given(...ITEMS);
    expect([CLOSED_AT, OWN_ANCESTOR]).toContainEqual(
      attempt(closed, sql("UPDATE items SET status = 'done', parent_id = id WHERE id = 'itm_t11'")),
    );
  });

  it("is held without a third kind: no object of the schema names a subtask or the kind of a parent", () => {
    const db = given();

    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE sql LIKE '%subtask%' OR sql LIKE '%parent_kind%'").pluck().all(),
    ).toEqual([]);
  });
});

const CLOSE = update("items", "itm_t11", { status: "done", closed_at: T2 });

scene("the fields of an item", ITEMS, [
  refuses(
    "the day of my role without a role",
    check("my_role_set_on IS NULL OR my_role IS NOT NULL"),
    update("items", "itm_t11", { my_role_set_on: DAY }),
  ),
  accepts("my role with its day", update("items", "itm_t11", { my_role: "waiting", my_role_set_on: "2026-10-09" })),
  refuses(
    "an external key without a system",
    check("external_key IS NULL OR external_system IS NOT NULL"),
    update("items", "itm_t11", { external_key: "PAY-123" }),
  ),
  accepts(
    "an external reference",
    update("items", "itm_t11", {
      external_system: "jira",
      external_key: "PAY-123",
      external_url: "https://tracker.corp.example/PAY-123",
    }),
  ),
  refuses(
    "an empty external system",
    check("external_system <> ''"),
    update("items", "itm_t11", { external_system: "" }),
  ),
  refuses(
    "an empty external key",
    check("external_key <> ''"),
    update("items", "itm_t11", { external_system: "jira", external_key: "" }),
  ),
  refuses("an empty external address", check("external_url <> ''"), update("items", "itm_t11", { external_url: "" })),
  refuses("a blank title", check("trim(title) <> ''"), update("items", "itm_t11", { title: "  " })),
  refuses("an empty folded title", check("title_norm <> ''"), update("items", "itm_t11", { title_norm: "" })),
  refuses(
    "a last activity before the creation",
    check("last_activity_at >= created_at"),
    update("items", "itm_t11", { last_activity_at: "2026-10-11T08:00:00.000Z" }),
  ),
  refuses(
    "an item merged into itself",
    check("merged_into_id IS NULL OR merged_into_id <> id"),
    sql("UPDATE items SET merged_into_id = id WHERE id = 'itm_t11'"),
  ),

  // closed_at is set exactly when the status is a closed one.
  refuses("a closing time on an open item", CLOSED_AT, update("items", "itm_t11", { closed_at: T2 })),
  refuses("a closed status without its closing time", CLOSED_AT, update("items", "itm_t11", { status: "done" })),
  accepts("closing: the status and its time together", CLOSE),
  following(
    [CLOSE],
    refuses("reopening that leaves the closing time", CLOSED_AT, update("items", "itm_t11", { status: "in_progress" })),
    refuses("taking the closing time off a closed item", CLOSED_AT, update("items", "itm_t11", { closed_at: null })),
    accepts("one closed status for another", update("items", "itm_t11", { status: "cancelled" })),
    accepts("reopening", update("items", "itm_t11", { status: "in_progress", closed_at: null })),
  ),
  refuses(
    "an item inserted closed without its closing time",
    CLOSED_AT,
    item("itm_x", "task", null, { status: "done" }),
  ),
  refuses("an item inserted open with a closing time", CLOSED_AT, item("itm_x", "task", null, { closed_at: T })),
  accepts("an item inserted closed", item("itm_x", "task", null, { status: "done", closed_at: T })),
  // The same rule wherever the item sits.
  refuses(
    "a closed status without its closing time on a task of a project",
    CLOSED_AT,
    update("items", "itm_t10", { status: "done" }),
  ),
  refuses("a closing time on an open task under a task", CLOSED_AT, update("items", "itm_s20", { closed_at: T2 })),
  refuses(
    "a task inserted closed under a task, without its closing time",
    CLOSED_AT,
    item("itm_x", "task", "itm_t10", { status: "done" }),
  ),
  refuses(
    "a task inserted open in a project, with a closing time",
    CLOSED_AT,
    item("itm_x", "task", "itm_p1", { closed_at: T }),
  ),
]);

// The health of an item is its own. A project or a task may have one, wherever the task sits in
// its tree and whatever else it is, and NULL is "not assessed". The one rule about it is the
// foreign key to the list of healths: no rule ties it to the kind of the item, to its status or
// to the health of the items above and under it.
/** A task of every sort, each with the id of such a row of the scene and the columns that make it one. */
const ANY_TASK: [what: string, id: string, as: Row][] = [
  ["a task that stands alone", "itm_h_alone", {}],
  ["a task of a project", "itm_h_in", { parent_id: "itm_p1" }],
  ["a task under a task", "itm_h_under", { parent_id: "itm_t10" }],
  ["a task at the sixth level", "itm_h_deep", { parent_id: "itm_d40" }],
  ["a milestone", "itm_h_ms", { parent_id: "itm_p1", is_milestone: 1, due_on: DAY }],
  ["a closed task", "itm_h_closed", CLOSED],
];

scene(
  "the health of an item",
  [...DEEP, ...ANY_TASK.map(([, id, as]) => item(id, "task", null, as))],
  [
    accepts("a health on a project", update("items", "itm_p1", { health: "yellow" })),
    ...ANY_TASK.flatMap(([what, id, as]) => [
      accepts(`a health on ${what}`, update("items", id, { health: "red" })),
      accepts(`${what} inserted with a health`, item("itm_x", "task", null, { ...as, health: "yellow" })),
    ]),
    // A row may arrive merged, and then with a health as with any other column. A health given to
    // a row that is merged already is with the statements that no guard stops.
    accepts(
      "a task inserted as merged, with a health",
      item("itm_x", "task", null, { merged_into_id: "itm_t11", health: "green" }),
    ),
    // NULL is "not assessed", and an item may go back to it.
    following(
      [update("items", "itm_h_under", { health: "red" })],
      accepts("the health of a task taken away again", update("items", "itm_h_under", { health: null })),
      accepts("another health for a task that has one", update("items", "itm_h_under", { health: "green" })),
    ),
    // The foreign key asks of a task what it asks of a project: a word of the list.
    refuses("a health outside the list on a task", FOREIGN_KEY, update("items", "itm_h_under", { health: "amber" })),
    refuses(
      "a task inserted with a health outside the list",
      FOREIGN_KEY,
      item("itm_x", "task", "itm_p1", { health: "amber" }),
    ),
    // Nothing is derived: no rule compares the health of an item with that of the items above or
    // under it.
    following(
      [update("items", "itm_p1", { health: "green" })],
      accepts("a red task in a green project", update("items", "itm_h_in", { health: "red" })),
    ),
    following(
      [update("items", "itm_t10", { health: "red" })],
      accepts("a green task under a red task", update("items", "itm_h_under", { health: "green" })),
      accepts("a green project over a red task", update("items", "itm_p1", { health: "green" })),
    ),
    // The other rules of the table ask of an item with a health what they ask of any other: the
    // mark of a milestone, the closing time, the id and the guard of a merge. The rules of the tree
    // and of the days have such cases in their own scenes.
    refuses(
      "a project inserted with a health and the mark of a milestone",
      PROJECT_AS_MILESTONE,
      item("itm_x", "project", null, { health: "yellow", is_milestone: 1 }),
    ),
    following(
      [update("items", "itm_p1", { health: "yellow" })],
      refuses(
        "the mark of a milestone on a project that has a health",
        PROJECT_AS_MILESTONE,
        update("items", "itm_p1", { is_milestone: 1 }),
      ),
    ),
    refuses(
      "a task inserted closed with a health, without its closing time",
      CLOSED_AT,
      item("itm_x", "task", null, { health: "red", status: "done" }),
    ),
    following(
      [update("items", "itm_h_in", { health: "red" })],
      refuses(
        "a task with a health closed without its closing time",
        CLOSED_AT,
        update("items", "itm_h_in", { status: "done" }),
      ),
      refuses("another id for a task with a health", ITEM_ID_FIXED, update("items", "itm_h_in", { id: "itm_h_other" })),
    ),
    following(
      [item("itm_dup", "task"), mergeItem("itm_dup", "itm_h_alone"), update("items", "itm_h_in", { health: "red" })],
      refuses("a task with a health merged into a merged item", ITEM_MERGE, mergeItem("itm_h_in", "itm_dup")),
      refuses(
        "a task inserted with a health as merged into a merged item",
        ITEM_MERGE,
        item("itm_x", "task", null, { merged_into_id: "itm_dup", health: "red" }),
      ),
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// The schedule of an item
// ---------------------------------------------------------------------------------------------

// The day the work starts and the day it is due, each with a word for how exactly it is known,
// and the mark that makes a task, at any depth, a milestone. Three rules, held by a pair of
// triggers: a precision is about a day that is set; a milestone is a point in time and has no
// start; a project is not a milestone. No rule orders the two days.
const task = (id: string, more: Row = {}) => item(id, "task", null, more);
const reschedule = (id: string, set: Row) => update("items", id, set);
/** An INSERT of an item whose values SQL itself writes: for a value that the driver would bind as another type. */
const itemWritten = (id: string, columns: string, values: string) =>
  sql(
    `INSERT INTO items (id, kind, title, title_norm, status, importance, created_at, last_activity_at, ${columns}) VALUES (?, 'task', 't', 't', 'todo', ?, ?, ?, ${values})`,
    id,
    DEFAULT_ITEM_IMPORTANCE,
    T,
    T,
  );
/** A copy of the task of the scene under another id, with some of its columns written otherwise. */
const copyOfTask = (id: string, startOn: string, dueOn: string, isMilestone: string) =>
  sql(
    `INSERT INTO items (id, kind, title, title_norm, status, importance, is_milestone, created_at, last_activity_at, start_on, due_on) SELECT ?, kind, title, title_norm, status, importance, ${isMilestone}, created_at, last_activity_at, ${startOn}, ${dueOn} FROM items WHERE id = 'itm_task'`,
    id,
  );

/** A project and a task of it with a period each, a task with a rough due day, and two milestones. */
const SCHEDULED = [
  item("itm_proj", "project", null, { start_on: "2026-10-01", due_on: "2027-03-31" }),
  item("itm_task", "task", "itm_proj", { start_on: "2026-11-03", due_on: "2026-11-13" }),
  task("itm_rough", { due_on: "2026-11-15", due_on_precision: "approximate" }),
  item("itm_ms", "task", "itm_proj", { is_milestone: 1, due_on: "2026-11-20" }),
  task("itm_alone", { is_milestone: 1, due_on: "2026-12-01" }),
];

scene(
  "a day of the schedule",
  [task("itm_t1", { start_on: "2026-11-05", due_on: "2026-11-05" })],
  [
    ...(
      [
        ["a month and a day that are not padded", "2026-11-5"],
        ["month 13", "2026-13-01"],
        ["the thirtieth of February", NO_SUCH_DAY],
        ["the 29th of February in a year that has none", "2026-02-29"],
        ["an instant", "2026-11-05T00:00:00.000Z"],
        ["a day with a time", "2026-11-05 10:00"],
        ["a space behind", "2026-11-05 "],
        ["the empty text", ""],
        ["digits alone", "20261105"],
        ["a quarter written out", "2027-Q1"],
        ["a month alone", "2026-11"],
        ["the Polish order", "05.11.2026"],
        ["a word", "jutro"],
        // A STRICT table stores both numbers as text, and neither text is a day.
        ["a whole number", 20261105],
        ["a number with a fraction, which SQLite would read as a Julian day", 2461350.5],
        ["a year with a minus sign", "-2026-11-05"],
        ["the first day before the year 0", "-0001-01-01"],
        ["a leap day in a year with a minus sign", "-2024-02-29"],
      ] as [string, unknown][]
    ).map(([what, value]) => refuses(`a start that is ${what}`, dayOf("start_on"), task("itm_x", { start_on: value }))),
    refuses("a due day in a year with a minus sign", dayOf("due_on"), task("itm_x", { due_on: "-2026-11-05" })),
    refuses("a due day in the year 45 with a minus sign", dayOf("due_on"), task("itm_x", { due_on: "-0045-01-01" })),
    refuses(
      "a period in years with a minus sign",
      dayOf("start_on"),
      task("itm_x", { start_on: "-0045-01-01", due_on: "-0044-03-15" }),
    ),
    refuses(
      "a due day moved into a year with a minus sign",
      dayOf("due_on"),
      reschedule("itm_t1", { due_on: "-2026-11-05" }),
    ),
    refuses(
      "a start changed to a text that is no day",
      dayOf("start_on"),
      reschedule("itm_t1", { start_on: "2026-11-5" }),
    ),
    refuses("the word for today as a start", notTheClock("date"), task("itm_x", { start_on: "now" })),
    refuses("the word for today as a due day", notTheClock("date"), task("itm_x", { due_on: "now" })),
    refuses(
      "bytes as a start",
      wrongType("BLOB", "TEXT column items.start_on"),
      task("itm_x", { start_on: Buffer.from("2026-11-05") }),
    ),
    // The same rule in the column beside them.
    refuses(
      "the day of my role in a year with a minus sign",
      dayOf("my_role_set_on"),
      task("itm_x", { my_role: "doing", my_role_set_on: "-2026-11-05" }),
    ),
    accepts("a start", task("itm_x", { start_on: "2026-11-05" })),
    accepts("a start on the 29th of February of a leap year", task("itm_x", { start_on: "2028-02-29" })),
    accepts("no start, which is a start that was not said", task("itm_x", { start_on: null })),
    accepts("a period in the year 0000", task("itm_x", { start_on: "0000-01-01", due_on: "0000-12-31" })),
    accepts("a due day in the year 9999", task("itm_x", { due_on: "9999-12-31" })),
  ],
);

// How exactly a day is known is a label: the code owns the list, the database checks the shape.
scene(
  "the precision of a day",
  [],
  (
    [
      ["start_on_precision", { start_on: "2026-11-02" }],
      ["due_on_precision", { due_on: "2026-11-30" }],
    ] as [string, Row][]
  ).flatMap(([column, day]) => [
    ...(
      [
        ["an upper-case letter", "Month"],
        ["a space behind", "month "],
        ["the empty text", ""],
        ["a digit at the start", "1q"],
        ["a hyphen", "half-year"],
        ["a Polish letter", "miesiąc"],
        ["a NUL character and more behind the word", `month${NUL}Not A Label`],
        // A STRICT table stores the number as the text "1".
        ["a number", 1],
      ] as [string, unknown][]
    ).map(([what, value]) =>
      refuses(`${column}: ${what}`, identifier(column), task("itm_x", { ...day, [column]: value })),
    ),
    ...DATE_PRECISIONS.map((precision) =>
      accepts(`${column}: ${precision}`, task("itm_x", { ...day, [column]: precision })),
    ),
    accepts(
      `${column}: a word that a later package adds, without a migration`,
      task("itm_x", { ...day, [column]: "sprint" }),
    ),
    accepts(
      `${column}: no word beside a day, which is a day known to the day`,
      task("itm_x", { ...day, [column]: null }),
    ),
  ]),
);

scene(
  "the mark of a milestone",
  [task("itm_t1", { due_on: "2026-11-13" })],
  [
    accepts("an item that is no milestone", task("itm_x", { is_milestone: 0 })),
    accepts("an item that is one", task("itm_x", { is_milestone: 1 })),
    // No default supplies the mark: the statement that inserts the item writes it.
    refuses(
      "an item inserted without the mark",
      notNull("items.is_milestone"),
      task("itm_x", { is_milestone: undefined }),
    ),
    refuses(
      "an item inserted with the mark NULL",
      notNull("items.is_milestone"),
      task("itm_x", { is_milestone: null }),
    ),
    refuses("the mark taken away", notNull("items.is_milestone"), reschedule("itm_t1", { is_milestone: null })),
    refuses("a mark of 2", check("is_milestone IN (0, 1)"), task("itm_x", { is_milestone: 2 })),
    refuses("a mark below 0", check("is_milestone IN (0, 1)"), task("itm_x", { is_milestone: -1 })),
    refuses(
      "a word as the mark",
      wrongType("TEXT", "INTEGER column items.is_milestone"),
      task("itm_x", { is_milestone: "yes" }),
    ),
    refuses(
      "a fraction as the mark",
      wrongType("REAL", "INTEGER column items.is_milestone"),
      task("itm_x", { is_milestone: 0.5 }),
    ),
  ],
);

// A start after the due day is work that begins late. It is stored as it was said, and the
// views mark it.
scene("the two days of the schedule, which no rule orders", SCHEDULED, [
  accepts("a start after the due day", task("itm_x", { start_on: "2026-11-20", due_on: "2026-11-13" })),
  accepts("a start in the year after the due day", task("itm_x", { start_on: "2027-01-01", due_on: "2026-12-31" })),
  accepts(
    "a project that starts after its due day",
    item("itm_x", "project", null, { start_on: "2026-11-20", due_on: "2026-11-13" }),
  ),
  accepts("a period of one day", task("itm_x", { start_on: "2026-11-10", due_on: "2026-11-10" })),
  accepts("a start alone: work without a known end", task("itm_x", { start_on: "2026-11-03" })),
  accepts("a due day alone: a point in time", task("itm_x", { due_on: "2026-12-15" })),
  accepts("neither day", task("itm_x")),
  // No rule ties the days of an item to those of its parent either.
  accepts(
    "a task that starts before its project",
    item("itm_x", "task", "itm_proj", { start_on: "2026-09-01", due_on: "2026-09-30" }),
  ),
  accepts(
    "a task under a task that ends after it",
    item("itm_x", "task", "itm_task", { start_on: "2026-11-10", due_on: "2026-12-24" }),
  ),
  accepts("a due day moved before the start", reschedule("itm_task", { due_on: "2026-11-02" })),
  accepts("a start moved behind the due day", reschedule("itm_task", { start_on: "2026-11-14" })),
  accepts("the due day removed", reschedule("itm_task", { due_on: null })),
  // A period can be moved one day at a time: the row in between is as good as any.
  accepts("a period moved later, the start first", reschedule("itm_task", { start_on: "2026-11-17" })),
  following(
    [reschedule("itm_task", { start_on: "2026-11-17" })],
    accepts("a period moved later, then the due day", reschedule("itm_task", { due_on: "2026-11-27" })),
  ),
  accepts("a period moved earlier, the due day first", reschedule("itm_task", { due_on: "2026-10-30" })),
  following(
    [reschedule("itm_task", { due_on: "2026-10-30" })],
    accepts("a period moved earlier, then the start", reschedule("itm_task", { start_on: "2026-10-20" })),
  ),
  accepts("a period moved in one statement", reschedule("itm_task", { start_on: "2026-11-17", due_on: "2026-11-27" })),
  accepts(
    "a period moved as one value of two columns",
    sql("UPDATE items SET (start_on, due_on) = ('2026-11-17', '2026-11-27') WHERE id = 'itm_task'"),
  ),
  accepts(
    "a start after the due day as one value of two columns",
    sql("UPDATE items SET (start_on, due_on) = ('2026-11-28', '2026-11-27') WHERE id = 'itm_task'"),
  ),
  accepts(
    "the two days written back as they are",
    sql("UPDATE items SET start_on = start_on, due_on = due_on WHERE id = 'itm_task'"),
  ),
  accepts(
    "another title, which leaves the schedule alone",
    reschedule("itm_task", { title: "Testy", title_norm: "testy" }),
  ),
  accepts("a copy of a task with its two days swapped", copyOfTask("itm_x", "due_on", "start_on", "is_milestone")),
  accepts(
    "a start after the due day that comes from another table of the statement",
    sql("UPDATE items SET start_on = v.s FROM (SELECT '2027-06-01' AS s) AS v WHERE items.id = 'itm_task'"),
  ),
  accepts(
    "a period on an item that is closed",
    task("itm_x", { status: "done", closed_at: T, start_on: "2026-10-01", due_on: "2026-10-10" }),
  ),
  accepts("a merge of an item that has a schedule", reschedule("itm_rough", { merged_into_id: "itm_alone" })),
]);

scene("the precision of a day, which is about a day that is set", SCHEDULED, [
  refuses(
    "a precision of the start without a start",
    PRECISION_WITHOUT_DAY,
    task("itm_x", { start_on_precision: "month" }),
  ),
  refuses(
    "a precision of the due day without a due day",
    PRECISION_WITHOUT_DAY,
    task("itm_x", { due_on_precision: "quarter" }),
  ),
  // A precision belongs to its own day.
  refuses(
    "a precision of the due day beside a start alone",
    PRECISION_WITHOUT_DAY,
    task("itm_x", { start_on: "2026-11-02", due_on_precision: "month" }),
  ),
  accepts("a due day with its precision", task("itm_x", { due_on: "2027-03-31", due_on_precision: "quarter" })),
  accepts(
    "both days with their precisions: a quarter as a period",
    task("itm_x", {
      start_on: "2027-01-01",
      start_on_precision: "quarter",
      due_on: "2027-03-31",
      due_on_precision: "quarter",
    }),
  ),
  accepts(
    "a start known to the day and a due day known to the month",
    task("itm_x", { start_on: "2026-11-03", due_on: "2026-12-31", due_on_precision: "month" }),
  ),
  refuses("a day removed while its precision stays", PRECISION_WITHOUT_DAY, reschedule("itm_rough", { due_on: null })),
  accepts(
    "a day removed together with its precision",
    reschedule("itm_rough", { due_on: null, due_on_precision: null }),
  ),
  refuses(
    "a precision of the start alone on an item without a start",
    PRECISION_WITHOUT_DAY,
    reschedule("itm_alone", { start_on_precision: "week" }),
  ),
  following(
    [reschedule("itm_rough", { due_on: null, due_on_precision: null })],
    refuses(
      "a precision of the due day alone on an item without a due day",
      PRECISION_WITHOUT_DAY,
      reschedule("itm_rough", { due_on_precision: "week" }),
    ),
  ),
  accepts(
    "a day and its precision together",
    reschedule("itm_rough", { due_on: "2026-11-30", due_on_precision: "month" }),
  ),
  accepts(
    "a day made exact: another day, and no precision",
    reschedule("itm_rough", { due_on: "2026-11-27", due_on_precision: null }),
  ),
  accepts("another precision for a day that is set", reschedule("itm_rough", { due_on_precision: "week" })),
  // That a day beside a named period is the first or the last day of that period is a rule of
  // the application, which counts the periods.
  accepts(
    "a day in the middle of the month that its precision names",
    task("itm_x", { due_on: "2026-11-15", due_on_precision: "month" }),
  ),
]);

scene("a milestone, which is a point in time", SCHEDULED, [
  refuses(
    "a milestone with a start and a due day",
    MILESTONE_WITH_START,
    task("itm_x", { is_milestone: 1, start_on: "2026-11-03", due_on: "2026-11-13" }),
  ),
  refuses(
    "a milestone with a start alone",
    MILESTONE_WITH_START,
    task("itm_x", { is_milestone: 1, start_on: "2026-11-03" }),
  ),
  // A STRICT table turns both into the number 1 before the rule sees them.
  refuses(
    "a milestone with a start whose mark is written as text",
    MILESTONE_WITH_START,
    task("itm_x", { is_milestone: "1", start_on: "2026-11-03" }),
  ),
  refuses(
    "a milestone with a start whose mark is written with a fraction of zero",
    MILESTONE_WITH_START,
    itemWritten("itm_x", "is_milestone, start_on", "1.0, '2026-11-03'"),
  ),
  accepts(
    "a milestone of a project, with its day",
    item("itm_x", "task", "itm_proj", { is_milestone: 1, due_on: "2026-11-20" }),
  ),
  accepts("a milestone that has no day yet", task("itm_x", { is_milestone: 1 })),
  accepts("a milestone that stands alone", task("itm_x", { is_milestone: 1, due_on: "2026-12-15" })),
  accepts(
    "a milestone among the tasks under a task",
    item("itm_x", "task", "itm_task", { is_milestone: 1, due_on: "2026-11-12" }),
  ),
  accepts(
    "a milestone whose day is known to the quarter",
    task("itm_x", { is_milestone: 1, due_on: "2027-03-31", due_on_precision: "quarter" }),
  ),
  refuses("a start given to a milestone", MILESTONE_WITH_START, reschedule("itm_ms", { start_on: "2026-11-16" })),
  refuses("the mark on a task that has a start", MILESTONE_WITH_START, reschedule("itm_task", { is_milestone: 1 })),
  refuses(
    "the mark, written as text, on a task that has a start",
    MILESTONE_WITH_START,
    reschedule("itm_task", { is_milestone: "1" }),
  ),
  // The operation that sets the mark removes the start in the same statement.
  accepts("the mark together with the start removed", reschedule("itm_task", { is_milestone: 1, start_on: null })),
  following(
    [reschedule("itm_task", { is_milestone: 1, start_on: null })],
    accepts(
      "the mark taken off together with the start put back",
      reschedule("itm_task", { is_milestone: 0, start_on: "2026-11-03" }),
    ),
  ),
  accepts("a milestone reached", reschedule("itm_ms", { status: "done", closed_at: T2 })),
  accepts("a milestone moved to another day", reschedule("itm_ms", { due_on: "2026-11-27" })),
  refuses(
    "a copy of a task that has a start, with the mark",
    MILESTONE_WITH_START,
    copyOfTask("itm_x", "start_on", "due_on", "1"),
  ),
  // One statement for many rows is refused whole when one of the rows would break a rule.
  refuses(
    "the mark on every task at once, of which one has a start",
    MILESTONE_WITH_START,
    sql("UPDATE items SET is_milestone = 1 WHERE kind = 'task'"),
  ),
]);

scene("a project, which is no milestone", SCHEDULED, [
  refuses(
    "a project inserted with the mark",
    PROJECT_AS_MILESTONE,
    item("itm_x", "project", null, { is_milestone: 1 }),
  ),
  refuses("the mark on a project", PROJECT_AS_MILESTONE, reschedule("itm_proj", { is_milestone: 1, start_on: null })),
  refuses("a milestone made a project", PROJECT_AS_MILESTONE, reschedule("itm_alone", { kind: "project" })),
  accepts(
    "a milestone made a project together with the mark taken off",
    reschedule("itm_alone", { kind: "project", is_milestone: 0 }),
  ),
]);

// A CHECK is skipped without a word by a statement that ignores conflicts. A trigger is not:
// the rules of the schedule hold whatever form the statement has.
scene("the rules of the schedule, in every form of statement", SCHEDULED, [
  refuses(
    "an ignoring INSERT of a milestone with a start",
    MILESTONE_WITH_START,
    ignoring(task("itm_x", { is_milestone: 1, start_on: "2026-11-20", due_on: "2026-11-27" })),
  ),
  refuses(
    "an ignoring UPDATE that leaves a precision without its day",
    PRECISION_WITHOUT_DAY,
    ignoring(reschedule("itm_task", { start_on: null, start_on_precision: "month" })),
  ),
  refuses(
    "an upsert that leaves a precision without its day",
    PRECISION_WITHOUT_DAY,
    onConflict(item("itm_task", "task", "itm_proj"), "(id) DO UPDATE SET due_on = NULL, due_on_precision = 'week'"),
  ),
  refuses(
    "an upsert that marks an item which has a start",
    MILESTONE_WITH_START,
    onConflict(item("itm_task", "task", "itm_proj"), "(id) DO UPDATE SET is_milestone = 1"),
  ),
  refuses(
    "a replacing INSERT of a milestone with a start over an item",
    MILESTONE_WITH_START,
    replacing(item("itm_task", "task", "itm_proj", { is_milestone: 1, start_on: "2026-12-13", due_on: "2026-12-20" })),
  ),
  refuses(
    "a replacing INSERT of a project with the mark over an item",
    PROJECT_AS_MILESTONE,
    replacing(item("itm_proj", "project", null, { is_milestone: 1 })),
  ),
]);

// The rules ask about the columns of the schedule and about the kind, and about nothing else of
// the row: an item that sits under a task, one that is closed and one that was merged are held to
// them like any other.
const WHATEVER_ELSE: [what: string, id: string, as: Row][] = [
  ["a task under a task", "itm_under", { parent_id: "itm_task" }],
  ["a closed task", "itm_closed", { status: "done", closed_at: T }],
  ["a merged task", "itm_merged", { merged_into_id: "itm_rough" }],
];

scene(
  "the rules of the schedule, whatever else the item is",
  [
    ...SCHEDULED,
    ...WHATEVER_ELSE.map(([, id, as]) =>
      task(id, { ...as, start_on: "2026-11-03", due_on: "2026-11-13", due_on_precision: "week" }),
    ),
    item("itm_proj_closed", "project", null, { status: "done", closed_at: T }),
    item("itm_proj_merged", "project", null, { merged_into_id: "itm_proj" }),
  ],
  [
    ...WHATEVER_ELSE.flatMap(([what, id, as]) => [
      refuses(
        `${what} inserted with a precision and no day`,
        PRECISION_WITHOUT_DAY,
        task("itm_x", { ...as, due_on_precision: "month" }),
      ),
      refuses(
        `${what} inserted as a milestone with a start`,
        MILESTONE_WITH_START,
        task("itm_x", { ...as, is_milestone: 1, start_on: "2026-11-03" }),
      ),
      refuses(
        `the due day of ${what} removed while its precision stays`,
        PRECISION_WITHOUT_DAY,
        reschedule(id, { due_on: null }),
      ),
      refuses(`the mark on ${what} that has a start`, MILESTONE_WITH_START, reschedule(id, { is_milestone: 1 })),
    ]),
    // A task with a health is held to them like any other as well.
    refuses(
      "a task with a health inserted with a precision and no day",
      PRECISION_WITHOUT_DAY,
      task("itm_x", { health: "red", due_on_precision: "month" }),
    ),
    refuses(
      "a task with a health inserted as a milestone with a start",
      MILESTONE_WITH_START,
      task("itm_x", { health: "red", is_milestone: 1, start_on: "2026-11-03" }),
    ),
    following(
      [task("itm_assessed", { health: "red", start_on: "2026-11-03", due_on: "2026-11-13", due_on_precision: "week" })],
      refuses(
        "the due day of a task with a health removed while its precision stays",
        PRECISION_WITHOUT_DAY,
        reschedule("itm_assessed", { due_on: null }),
      ),
      refuses(
        "the mark on a task with a health that has a start",
        MILESTONE_WITH_START,
        reschedule("itm_assessed", { is_milestone: 1 }),
      ),
    ),
    refuses(
      "a closed project inserted with the mark",
      PROJECT_AS_MILESTONE,
      item("itm_x", "project", null, { status: "done", closed_at: T, is_milestone: 1 }),
    ),
    refuses(
      "a merged project inserted with the mark",
      PROJECT_AS_MILESTONE,
      item("itm_x", "project", null, { merged_into_id: "itm_proj", is_milestone: 1 }),
    ),
    refuses("the mark on a closed project", PROJECT_AS_MILESTONE, reschedule("itm_proj_closed", { is_milestone: 1 })),
    refuses("the mark on a merged project", PROJECT_AS_MILESTONE, reschedule("itm_proj_merged", { is_milestone: 1 })),
  ],
);

describe("the rules of the schedule", () => {
  const DAYS_OF = { start_on: "2026-11-03", due_on: "2026-11-13" };
  /** Every row that the six columns of the rules can make, one value for "set" and one for "not set". */
  const SHAPES = ["project", "task"].flatMap((kind) =>
    [0, 1].flatMap((is_milestone) =>
      [null, DAYS_OF.start_on].flatMap((start_on) =>
        [null, "month"].flatMap((start_on_precision) =>
          [null, DAYS_OF.due_on].flatMap((due_on) =>
            [null, "week"].map((due_on_precision) => ({
              kind,
              start_on,
              start_on_precision,
              due_on,
              due_on_precision,
              is_milestone,
            })),
          ),
        ),
      ),
    ),
  );
  type Shape = (typeof SHAPES)[number];
  /** What the three rules say to a row, in the order in which the triggers ask them. */
  const verdict = (row: Shape): Refusal | string => {
    if (
      (row.start_on_precision !== null && row.start_on === null) ||
      (row.due_on_precision !== null && row.due_on === null)
    ) {
      return PRECISION_WITHOUT_DAY;
    }
    if (row.is_milestone === 1 && row.start_on !== null) return MILESTONE_WITH_START;
    if (row.is_milestone === 1 && row.kind === "project") return PROJECT_AS_MILESTONE;
    return ACCEPTED;
  };

  // The triggers look at the row that a statement would leave and at nothing else: not at the
  // row that was there, and not at which of the columns the statement names.
  it("are asked of the row that a statement leaves, whichever row it starts from", () => {
    const db = given();
    const allowed = SHAPES.filter((row) => verdict(row) === ACCEPTED);

    for (const [index, row] of SHAPES.entries()) {
      expect(attempt(db, item(`itm_i${index}`, row.kind, null, row)), JSON.stringify(row)).toEqual(verdict(row));
    }
    expect(rowsOf(db, "items")).toBe(allowed.length);
    for (const [index, from] of allowed.entries()) {
      attempt(db, item(`itm_u${index}`, from.kind, null, from));
      for (const to of SHAPES) {
        const outcome = attempt(db, reschedule(`itm_u${index}`, to));
        expect(outcome, `${JSON.stringify(from)} -> ${JSON.stringify(to)}`).toEqual(verdict(to));
        // Back to where it started, for the next change.
        if (outcome === ACCEPTED) attempt(db, reschedule(`itm_u${index}`, from));
      }
    }
    // The control: both answers were given, and each of the three sentences.
    expect(allowed.length).toBeGreaterThan(0);
    expect(new Set(SHAPES.map((row) => JSON.stringify(verdict(row)))).size).toBe(4);
  });

  it("leave every row as it was when one statement for many rows is refused", () => {
    const db = given(...SCHEDULED);
    const marks = () => db.prepare("SELECT id, is_milestone FROM items ORDER BY id").all();
    const before = marks();

    expect(attempt(db, sql("UPDATE items SET is_milestone = 1 WHERE kind = 'task'"))).toEqual(MILESTONE_WITH_START);

    expect(marks()).toEqual(before);
  });

  // The query that is run over a database after its migrations: a row that breaks a rule.
  it("are what the query for rows that break them asks", () => {
    const db = given(...SCHEDULED, without("items_schedule_insert"));
    const broken = () =>
      rowsOf(
        db,
        "items",
        "(start_on_precision IS NOT NULL AND start_on IS NULL) OR (due_on_precision IS NOT NULL AND due_on IS NULL) OR (is_milestone = 1 AND (start_on IS NOT NULL OR kind = 'project'))",
      );
    expect(broken()).toBe(0);

    for (const [index, row] of SHAPES.entries()) attempt(db, item(`itm_i${index}`, row.kind, null, row));

    expect(broken()).toBe(SHAPES.filter((row) => verdict(row) !== ACCEPTED).length);
  });
});

scene(
  "the description and the aliases of an item",
  [...ITEMS, description("ide_p1", "itm_p1"), itemAlias("ial_1", "itm_p1", "ATL")],
  [
    accepts("a description", description("ide_p2", "itm_p2")),
    refuses("a second description of an item", unique("item_descriptions.item_id"), description("ide_p9", "itm_p1")),
    refuses("a description that is not JSON", json("body"), update("item_descriptions", "ide_p1", { body: "{broken" })),
    refuses(
      "a description with a NUL character and more behind the JSON",
      json("body"),
      update("item_descriptions", "ide_p1", { body: `{"type":"doc"}${NUL}not json` }),
    ),
    accepts(
      "a new body for a description",
      update("item_descriptions", "ide_p1", { body: '{"type":"doc"}', updated_at: T2 }),
    ),
    refuses("a description of an item that does not exist", FOREIGN_KEY, description("ide_x1", "itm_nowhere")),
    accepts("an alias", itemAlias("ial_2", "itm_p1", "Atlas 2")),
    refuses(
      "the same alias of the same item again, whatever its case",
      unique("item_aliases.item_id", "item_aliases.alias_norm"),
      itemAlias("ial_2", "itm_p1", "Atl"),
    ),
    accepts("the same alias of another item", itemAlias("ial_2", "itm_p2", "ATL")),
    refuses("an alias of an item that does not exist", FOREIGN_KEY, itemAlias("ial_2", "itm_nowhere", "ATL")),
    refuses("a blank alias", check("trim(alias) <> ''"), itemAlias("ial_2", "itm_p1", " ", { alias_norm: "x" })),
    refuses(
      "an empty folded alias",
      check("alias_norm <> ''"),
      itemAlias("ial_2", "itm_p1", "Atlas 2", { alias_norm: "" }),
    ),
  ],
);

// One role per person and item, and one owner per item: the owner is the row with that role.
scene(
  "the persons in an item",
  [...ITEMS, ...PERSONS, itemPerson("itp_1", "itm_p1", "per_piotr", "owner")],
  [
    accepts("an owner", itemPerson("itp_2", "itm_p2", "per_piotr", "owner")),
    accepts(
      "a stakeholder with expectations",
      itemPerson("itp_2", "itm_p1", "per_anna", "stakeholder", { expectations: "chce terminu przed listopadem" }),
    ),
    refuses(
      "a second owner of an item",
      unique("item_persons.item_id"),
      itemPerson("itp_2", "itm_p1", "per_anna", "owner"),
    ),
    refuses(
      "a second role of a person in an item",
      unique("item_persons.item_id", "item_persons.person_id"),
      itemPerson("itp_2", "itm_p1", "per_piotr", "stakeholder"),
    ),
    refuses("a role outside the list", FOREIGN_KEY, update("item_persons", "itp_1", { role: "boss" })),
    following(
      [itemPerson("itp_2", "itm_p1", "per_anna", "stakeholder")],
      refuses(
        "a stakeholder made owner while the item has one",
        unique("item_persons.item_id"),
        update("item_persons", "itp_2", { role: "owner" }),
      ),
    ),
    // The pair is still the target of a conflict clause, as it was when the rule was a table constraint.
    accepts(
      "another role for the same person, written as an upsert on the pair",
      onConflict(
        itemPerson("itp_2", "itm_p1", "per_piotr", "requester"),
        "(item_id, person_id) DO UPDATE SET role = excluded.role",
      ),
    ),
    refuses(
      "a role in an item that does not exist",
      FOREIGN_KEY,
      itemPerson("itp_2", "itm_nowhere", "per_anna", "owner"),
    ),
    refuses("a role of a person who does not exist", FOREIGN_KEY, itemPerson("itp_2", "itm_p2", "per_nobody", "owner")),
    following(
      // A task that nothing sits under, so that nothing but the role points at the item.
      [itemPerson("itp_2", "itm_s21", "per_anna", "executor")],
      refuses("deleting an item that has persons", FOREIGN_KEY, remove("items", "itm_s21")),
    ),
    refuses("deleting a person who has a role in an item", FOREIGN_KEY, remove("persons", "per_piotr")),
  ],
);

describe("the persons in an item", () => {
  // The rule is a named index and not a constraint of the table, so that it can change with
  // one statement and without rebuilding the table.
  it("can have two roles each once the index that holds the rule is dropped", () => {
    const db = given(...ITEMS, ...PERSONS, itemPerson("itp_1", "itm_p1", "per_piotr", "owner"));
    const second = itemPerson("itp_2", "itm_p1", "per_piotr", "requester");
    const tableBefore = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'item_persons'").pluck().get();

    expect(attempt(db, second)).toEqual(unique("item_persons.item_id", "item_persons.person_id"));
    db.exec("DROP INDEX item_persons_one_role");

    expect(attempt(db, second)).toBe(ACCEPTED);
    expect(db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'item_persons'").pluck().get()).toBe(tableBefore);
  });
});

// ---------------------------------------------------------------------------------------------
// What was extracted from sources
// ---------------------------------------------------------------------------------------------

scene(
  "a mention",
  [...PERSONS, ...CAPTURE, mention("mnt_1", { base_form: "Magda", base_norm: "magda" })],
  [
    accepts("a mention that is not resolved yet", mention("mnt_2", { base_form: "Kasia", base_norm: "kasia" })),
    // Two people can share a name.
    accepts(
      "the same spelling a second time in one source",
      mention("mnt_2", { base_form: "Magda", base_norm: "magda" }),
    ),
    accepts("a mention without a base form", mention("mnt_2", { surface: "@pnowak" })),
    accepts("a mention resolved at once", mention("mnt_2", { person_id: "per_piotr" })),
    refuses(
      "a base form without its folded spelling",
      check("(base_form IS NULL) = (base_norm IS NULL)"),
      mention("mnt_2", { base_form: "Kasia" }),
    ),
    refuses(
      "a folded spelling without the base form",
      check("(base_form IS NULL) = (base_norm IS NULL)"),
      mention("mnt_2", { base_norm: "kasia" }),
    ),
    refuses("a blank surface", check("trim(surface) <> ''"), mention("mnt_2", { surface: "  " })),
    refuses("a blank base form", check("trim(base_form) <> ''"), mention("mnt_2", { base_form: " ", base_norm: "x" })),
    refuses(
      "an empty folded base form",
      check("base_norm <> ''"),
      mention("mnt_2", { base_form: "Kasia", base_norm: "" }),
    ),
    accepts("resolving a mention", update("mentions", "mnt_1", { person_id: "per_piotr" })),
    accepts("skipping a mention", update("mentions", "mnt_1", { skipped_at: T2 })),
    following(
      [update("mentions", "mnt_1", { skipped_at: T2 })],
      refuses(
        "resolving a mention that was skipped",
        check("person_id IS NULL OR skipped_at IS NULL"),
        update("mentions", "mnt_1", { person_id: "per_anna" }),
      ),
    ),
    refuses(
      "resolving a mention to nobody that exists",
      FOREIGN_KEY,
      update("mentions", "mnt_1", { person_id: "per_nobody" }),
    ),
    following(
      [update("mentions", "mnt_1", { person_id: "per_piotr" })],
      refuses("deleting a person who has mentions", FOREIGN_KEY, remove("persons", "per_piotr")),
    ),
    refuses("a mention in a source that does not exist", FOREIGN_KEY, mention("mnt_2", { source_id: "cap_nowhere" })),
  ],
);

const OUTDATE = update("facts", "fct_1", { outdated_at: T2, superseded_by_fact_id: "fct_2" });
const DELETE_SOURCE = update("sources", "cap_c1", { deleted_at: T3 });

// A fact starts with a source and a quote, and is never edited: it is marked outdated, and the
// fact that replaces it is added.
scene(
  "a fact",
  [
    ...ITEMS,
    ...PERSONS,
    ...CAPTURE,
    OTHER_SOURCE,
    fact("fct_1"),
    fact("fct_2", { type: "decision", text: "Decyzja", quote: "decyzja" }),
  ],
  [
    accepts("a fact with a source and a quote", fact("fct_3")),
    refuses(
      "a fact without a source and a quote",
      FACT_STARTS_WITH_SOURCE,
      fact("fct_3", { source_id: null, quote: null }),
    ),
    refuses("a fact with a quote and no source", FACT_STARTS_WITH_SOURCE, fact("fct_3", { source_id: null })),
    refuses("a fact without a quote", FACT_STARTS_WITH_SOURCE, fact("fct_3", { quote: null })),
    refuses("an empty quote", check("quote <> ''"), fact("fct_3", { quote: "" })),
    refuses("a blank statement", check("trim(text) <> ''"), fact("fct_3", { text: "  " })),
    refuses(
      "an approximate mark that is neither 0 nor 1",
      check("occurred_on_approximate IN (0, 1)"),
      fact("fct_3", { occurred_on_approximate: 2 }),
    ),
    refuses("a fact of a source that does not exist", FOREIGN_KEY, fact("fct_3", { source_id: "cap_nowhere" })),
    refuses("a fact of an item that does not exist", FOREIGN_KEY, fact("fct_3", { item_id: "itm_nowhere" })),
    refuses("a type outside the list", FOREIGN_KEY, fact("fct_3", { type: "rumour" })),
    refuses("an id that a fact has already", FACT_NEVER_EDITED, fact("fct_1", { text: "Podmieniony" })),

    refuses("another id for a fact", FACT_NEVER_EDITED, update("facts", "fct_1", { id: "fct_9" })),
    refuses("another statement", FACT_NEVER_EDITED, update("facts", "fct_1", { text: "Inne" })),
    refuses("another type", FACT_NEVER_EDITED, update("facts", "fct_1", { type: "info" })),
    refuses("another event date", FACT_NEVER_EDITED, update("facts", "fct_1", { occurred_on: "2026-10-11" })),
    refuses("another approximate mark", FACT_NEVER_EDITED, update("facts", "fct_1", { occurred_on_approximate: 0 })),
    refuses("another source", FACT_NEVER_EDITED, update("facts", "fct_1", { source_id: "cap_c3" })),
    refuses("no source any more", FACT_NEVER_EDITED, update("facts", "fct_1", { source_id: null, quote: null })),
    refuses("another creation time", FACT_NEVER_EDITED, update("facts", "fct_1", { created_at: T2 })),
    refuses("another quote", FACT_NEVER_EDITED, update("facts", "fct_1", { quote: "inny cytat" })),
    // An ORM that sends every column must be able to save a fact it did not change.
    accepts(
      "a fact written back as it is",
      sql(
        "UPDATE facts SET type = type, text = text, occurred_on = occurred_on, source_id = source_id, quote = quote, created_at = created_at WHERE id = 'fct_1'",
      ),
    ),

    // What may change: the item, the outdated mark with its successor, and the quote, once.
    accepts("a fact moved to another item", update("facts", "fct_1", { item_id: "itm_p2" })),
    refuses(
      "a successor without the outdated mark",
      check("superseded_by_fact_id IS NULL OR (outdated_at IS NOT NULL AND superseded_by_fact_id <> id)"),
      update("facts", "fct_1", { superseded_by_fact_id: "fct_2" }),
    ),
    refuses(
      "a fact that replaces itself",
      check("superseded_by_fact_id IS NULL OR (outdated_at IS NOT NULL AND superseded_by_fact_id <> id)"),
      update("facts", "fct_1", { outdated_at: T2, superseded_by_fact_id: "fct_1" }),
    ),
    refuses(
      "a successor that does not exist",
      FOREIGN_KEY,
      update("facts", "fct_1", { outdated_at: T2, superseded_by_fact_id: "fct_nowhere" }),
    ),
    accepts("the outdated mark with the successor", OUTDATE),
    accepts("the outdated mark without a successor", update("facts", "fct_1", { outdated_at: T2 })),
    following(
      [OUTDATE],
      refuses("deleting the fact that replaced another", FOREIGN_KEY, remove("facts", "fct_2")),
      accepts(
        "taking the outdated mark back, as the undo of the replacement does",
        update("facts", "fct_1", { outdated_at: null, superseded_by_fact_id: null }),
      ),
    ),

    // The quote is a piece of the source. It goes when the source is deleted for good, and only then.
    refuses(
      "removing the quote while the source is there",
      FACT_NEVER_EDITED,
      update("facts", "fct_1", { quote: null }),
    ),
    following(
      [DELETE_SOURCE],
      accepts("removing the quote after the source was deleted for good", update("facts", "fct_1", { quote: null })),
      refuses(
        "another quote after the source was deleted",
        FACT_NEVER_EDITED,
        update("facts", "fct_1", { quote: "inny" }),
      ),
    ),
    following(
      [DELETE_SOURCE, update("facts", "fct_1", { quote: null })],
      refuses("putting the quote back", FACT_NEVER_EDITED, update("facts", "fct_1", { quote: "Atlas ma ryzyko" })),
    ),
    following(
      // A fact of a task that nothing sits under, so that nothing but the fact points at the item.
      [fact("fct_3", { item_id: "itm_s21" })],
      refuses("deleting an item that has facts", FOREIGN_KEY, remove("items", "itm_s21")),
    ),

    accepts("a person of a fact", factPerson("fcp_1", "fct_1", "per_piotr")),
    refuses("a person of a fact who does not exist", FOREIGN_KEY, factPerson("fcp_1", "fct_1", "per_nobody")),
    refuses("a person of a fact that does not exist", FOREIGN_KEY, factPerson("fcp_1", "fct_nowhere", "per_piotr")),
    following(
      [factPerson("fcp_1", "fct_1", "per_piotr")],
      refuses(
        "the same person of the same fact again",
        unique("fact_persons.fact_id", "fact_persons.person_id"),
        factPerson("fcp_2", "fct_1", "per_piotr"),
      ),
      accepts("a second person of a fact", factPerson("fcp_2", "fct_1", "per_anna")),
      refuses("deleting a fact that has persons", FOREIGN_KEY, remove("facts", "fct_1")),
    ),
  ],
);

scene(
  "a link between a source and an item",
  [...ITEMS, ...CAPTURE, link("lnk_1", "cap_c1", "itm_p1")],
  [
    accepts("a link to a second item", link("lnk_2", "cap_c1", "itm_p2")),
    refuses(
      "the same link again",
      unique("source_links.source_id", "source_links.item_id"),
      link("lnk_2", "cap_c1", "itm_p1"),
    ),
    refuses("a link to an item that does not exist", FOREIGN_KEY, link("lnk_2", "cap_c1", "itm_nowhere")),
    refuses("a link from a source that does not exist", FOREIGN_KEY, link("lnk_2", "cap_nowhere", "itm_p2")),
  ],
);

// ---------------------------------------------------------------------------------------------
// Merges
// ---------------------------------------------------------------------------------------------

// A merged row stays as a signpost to its survivor. The survivor is not merged itself and no
// merged row is left pointing at a row that is being merged, so a signpost resolves in one hop.
// A merged row takes no new rows: a merge moves the rows first and marks last.
/** "itm_dup" is merged into the first project, "per_dup" into Anna. */
const MERGED = [
  ...ITEMS,
  ...PERSONS,
  ...CAPTURE,
  item("itm_dup", "project"),
  mergeItem("itm_dup", "itm_p1"),
  person("per_dup", "Anna Kowalska-Nowak"),
  mergePerson("per_dup", "per_anna"),
  fact("fct_1"),
  link("lnk_1", "cap_c1", "itm_p1"),
  itemPerson("itp_1", "itm_p1", "per_piotr", "stakeholder"),
  itemAlias("ial_1", "itm_p1", "ATL"),
  description("ide_1", "itm_p1"),
  personAlias("pal_1", "per_anna", "Ania"),
  factPerson("fcp_1", "fct_1", "per_piotr"),
  mention("mnt_1"),
];

scene("a merge", MERGED, [
  accepts("an item merged into one that is not merged", mergeItem("itm_p2", "itm_p1")),
  accepts("a person merged into one that is not merged", mergePerson("per_piotr", "per_anna")),
  refuses("an item merged into nothing that exists", FOREIGN_KEY, mergeItem("itm_p2", "itm_nowhere")),

  // A row that is inserted as merged is held to the same as one that is merged later.
  accepts(
    "an item inserted as merged into one that is not merged",
    item("itm_x", "project", null, { merged_into_id: "itm_p1" }),
  ),
  refuses(
    "an item inserted as merged into a merged item",
    ITEM_MERGE,
    item("itm_x", "project", null, { merged_into_id: "itm_dup" }),
  ),
  accepts(
    "a person inserted as merged into one who is not merged",
    person("per_x", "A. Kowalska", { merged_into_id: "per_anna" }),
  ),
  refuses(
    "a person inserted as merged into a merged person",
    PERSON_MERGE,
    person("per_x", "A. Kowalska", { merged_into_id: "per_dup" }),
  ),
  refuses("the survivor of an item merged into the item that points at it", ITEM_MERGE, mergeItem("itm_p1", "itm_dup")),
  refuses(
    "the survivor of a person merged into the person who points at it",
    PERSON_MERGE,
    mergePerson("per_anna", "per_dup"),
  ),
  refuses("an item merged into a merged item", ITEM_MERGE, mergeItem("itm_p2", "itm_dup")),
  refuses("a person merged into a merged person", PERSON_MERGE, mergePerson("per_piotr", "per_dup")),
  refuses("an item merged while another still points at it", ITEM_MERGE, mergeItem("itm_p1", "itm_p2")),
  refuses("a person merged while another still points at it", PERSON_MERGE, mergePerson("per_anna", "per_piotr")),
  following(
    [mergeItem("itm_dup", "itm_p2")],
    accepts("an item merged after what pointed at it was pointed at the new survivor", mergeItem("itm_p1", "itm_p2")),
  ),
  following(
    [mergePerson("per_dup", "per_piotr")],
    accepts(
      "a person merged after who pointed at it was pointed at the new survivor",
      mergePerson("per_anna", "per_piotr"),
    ),
  ),
  accepts("an item taken out of its merge", mergeItem("itm_dup", null)),
  accepts("a person taken out of its merge", mergePerson("per_dup", null)),
  accepts(
    "a merged item written back as it is",
    sql("UPDATE items SET merged_into_id = merged_into_id WHERE id = 'itm_dup'"),
  ),

  // New rows on a merged item.
  refuses("a fact on a merged item", FACT_ITEM_MERGED, fact("fct_2", { item_id: "itm_dup" })),
  refuses("a fact moved to a merged item", FACT_ITEM_MERGED, update("facts", "fct_1", { item_id: "itm_dup" })),
  accepts("a fact moved to an item that is not merged", update("facts", "fct_1", { item_id: "itm_p2" })),
  refuses("a link to a merged item", LINK_ITEM_MERGED, link("lnk_2", "cap_c1", "itm_dup")),
  refuses("a link moved to a merged item", LINK_ITEM_MERGED, update("source_links", "lnk_1", { item_id: "itm_dup" })),
  accepts("a link moved to an item that is not merged", update("source_links", "lnk_1", { item_id: "itm_p2" })),
  refuses("a person in a merged item", ITEM_PERSON_MERGED, itemPerson("itp_2", "itm_dup", "per_anna", "owner")),
  refuses("a merged person in an item", ITEM_PERSON_MERGED, itemPerson("itp_2", "itm_p1", "per_dup", "owner")),
  refuses("a role moved to a merged item", ITEM_PERSON_MERGED, update("item_persons", "itp_1", { item_id: "itm_dup" })),
  refuses(
    "a role moved to a merged person",
    ITEM_PERSON_MERGED,
    update("item_persons", "itp_1", { person_id: "per_dup" }),
  ),
  accepts("a role moved to a person who is not merged", update("item_persons", "itp_1", { person_id: "per_anna" })),
  refuses("an alias of a merged item", ITEM_ALIAS_MERGED, itemAlias("ial_2", "itm_dup", "Atlas")),
  refuses(
    "an alias moved to a merged item",
    ITEM_ALIAS_MERGED,
    update("item_aliases", "ial_1", { item_id: "itm_dup" }),
  ),
  accepts("an alias moved to an item that is not merged", update("item_aliases", "ial_1", { item_id: "itm_p2" })),
  refuses("a description of a merged item", DESCRIPTION_ITEM_MERGED, description("ide_2", "itm_dup")),
  refuses(
    "a description moved to a merged item",
    DESCRIPTION_ITEM_MERGED,
    update("item_descriptions", "ide_1", { item_id: "itm_dup" }),
  ),
  accepts(
    "a description moved to an item that is not merged",
    update("item_descriptions", "ide_1", { item_id: "itm_p2" }),
  ),
  refuses("a task under a merged project", PARENT_MERGED, item("itm_x", "task", "itm_dup")),
  refuses("a task moved under a merged project", PARENT_MERGED, update("items", "itm_t10", { parent_id: "itm_dup" })),

  // New rows on a merged person.
  refuses("an alias of a merged person", PERSON_ALIAS_MERGED, personAlias("pal_2", "per_dup", "Anka")),
  refuses(
    "an alias moved to a merged person",
    PERSON_ALIAS_MERGED,
    update("person_aliases", "pal_1", { person_id: "per_dup" }),
  ),
  accepts(
    "an alias moved to a person who is not merged",
    update("person_aliases", "pal_1", { person_id: "per_piotr" }),
  ),
  refuses("a merged person as a person of a fact", FACT_PERSON_MERGED, factPerson("fcp_2", "fct_1", "per_dup")),
  refuses(
    "a person of a fact changed to a merged person",
    FACT_PERSON_MERGED,
    update("fact_persons", "fcp_1", { person_id: "per_dup" }),
  ),
  accepts(
    "a person of a fact changed to a person who is not merged",
    update("fact_persons", "fcp_1", { person_id: "per_anna" }),
  ),
  refuses(
    "a mention resolved to a merged person at once",
    MENTION_PERSON_MERGED,
    mention("mnt_2", { person_id: "per_dup" }),
  ),
  refuses(
    "a mention resolved to a merged person",
    MENTION_PERSON_MERGED,
    update("mentions", "mnt_1", { person_id: "per_dup" }),
  ),
  accepts("a mention resolved to the survivor", update("mentions", "mnt_1", { person_id: "per_anna" })),
]);

// A rule that judges a row against another row asks the same when that other row has a health:
// the merged item that a row is hung on or merged into, the item that a merged item points at,
// and the parent.
scene(
  "an item with a health, as the other row of a rule",
  [
    ...MERGED,
    update("items", "itm_dup", { health: "red" }),
    update("items", "itm_p1", { health: "yellow" }),
    update("items", "itm_t10", { health: "red" }),
  ],
  [
    refuses("an item merged into a merged item that has a health", ITEM_MERGE, mergeItem("itm_p2", "itm_dup")),
    refuses(
      "an item inserted as merged into a merged item that has a health",
      ITEM_MERGE,
      item("itm_x", "project", null, { merged_into_id: "itm_dup" }),
    ),
    refuses("an item merged while an item with a health still points at it", ITEM_MERGE, mergeItem("itm_p1", "itm_p2")),
    refuses("a task inserted under a merged item that has a health", PARENT_MERGED, item("itm_x", "task", "itm_dup")),
    refuses("a task moved under a merged item that has a health", PARENT_MERGED, move("itm_t11", "itm_dup")),
    refuses("a project inserted under a task that has a health", NO_PARENT, item("itm_x", "project", "itm_t10")),
    refuses("a project moved under a project that has a health", NO_PARENT, move("itm_p2", "itm_p1")),
    refuses("a fact on a merged item that has a health", FACT_ITEM_MERGED, fact("fct_2", { item_id: "itm_dup" })),
    refuses(
      "a fact moved to a merged item that has a health",
      FACT_ITEM_MERGED,
      update("facts", "fct_1", { item_id: "itm_dup" }),
    ),
    refuses("a link to a merged item that has a health", LINK_ITEM_MERGED, link("lnk_2", "cap_c1", "itm_dup")),
    refuses(
      "a link moved to a merged item that has a health",
      LINK_ITEM_MERGED,
      update("source_links", "lnk_1", { item_id: "itm_dup" }),
    ),
    refuses(
      "a person in a merged item that has a health",
      ITEM_PERSON_MERGED,
      itemPerson("itp_2", "itm_dup", "per_anna", "owner"),
    ),
    refuses(
      "a role moved to a merged item that has a health",
      ITEM_PERSON_MERGED,
      update("item_persons", "itp_1", { item_id: "itm_dup" }),
    ),
    refuses("an alias of a merged item that has a health", ITEM_ALIAS_MERGED, itemAlias("ial_2", "itm_dup", "Atlas")),
    refuses(
      "an alias moved to a merged item that has a health",
      ITEM_ALIAS_MERGED,
      update("item_aliases", "ial_1", { item_id: "itm_dup" }),
    ),
    refuses(
      "a description of a merged item that has a health",
      DESCRIPTION_ITEM_MERGED,
      description("ide_2", "itm_dup"),
    ),
    refuses(
      "a description moved to a merged item that has a health",
      DESCRIPTION_ITEM_MERGED,
      update("item_descriptions", "ide_1", { item_id: "itm_dup" }),
    ),
  ],
);

// A merge that marks before it has moved everything leaves rows on the merged row. They are not
// new rows: a statement that writes one of them back without moving it is accepted, as it is
// from an ORM that sends every column.
scene(
  "a row that stayed on a merged row",
  [
    ...ITEMS,
    ...PERSONS,
    ...CAPTURE,
    person("per_old", "A. Kowalska"),
    fact("fct_1", { item_id: "itm_t11" }),
    link("lnk_1", "cap_c1", "itm_t11"),
    itemPerson("itp_1", "itm_t11", "per_old", "owner"),
    itemAlias("ial_1", "itm_t11", "plan testów"),
    description("ide_1", "itm_t11"),
    personAlias("pal_1", "per_old", "Ania"),
    factPerson("fcp_1", "fct_1", "per_old"),
    mention("mnt_1", { person_id: "per_old" }),
    mergeItem("itm_t11", "itm_t10"),
    mergePerson("per_old", "per_anna"),
  ],
  [
    accepts("a fact written back with its item", itsOwn("facts", "fct_1", "item_id")),
    accepts("a link written back with its item", itsOwn("source_links", "lnk_1", "item_id")),
    accepts(
      "a role written back with its item and its person",
      itsOwn("item_persons", "itp_1", "item_id", "person_id"),
    ),
    accepts("an alias of the item written back with its item", itsOwn("item_aliases", "ial_1", "item_id")),
    accepts("a description written back with its item", itsOwn("item_descriptions", "ide_1", "item_id")),
    accepts("a task written back with its parent", itsOwn("items", "itm_s21", "parent_id")),
    accepts("an alias of the person written back with its person", itsOwn("person_aliases", "pal_1", "person_id")),
    accepts("a person of a fact written back with its person", itsOwn("fact_persons", "fcp_1", "person_id")),
    accepts("a mention written back with its person", itsOwn("mentions", "mnt_1", "person_id")),
  ],
);

// The guards of a merge judge a change of the signpost and nothing else: a merged row that is
// written back as it is passes, whatever points at it. No statement can leave a merged row that
// another row points at, so the scene makes the pair on databases that have lost the guards of
// rows which are inserted as merged.
scene(
  "a merged row that another merged row points at",
  [
    ...MERGED,
    item("itm_chain", "project", null, { merged_into_id: "itm_dup" }),
    person("per_chain", "A. K.", { merged_into_id: "per_dup" }),
  ],
  [
    accepts(
      "the merged item written back as it is",
      sql("UPDATE items SET merged_into_id = merged_into_id WHERE id = 'itm_dup'"),
    ),
    accepts(
      "the merged person written back as it is",
      sql("UPDATE persons SET merged_into_id = merged_into_id WHERE id = 'per_dup'"),
    ),
    refuses("the merged item merged into another item", ITEM_MERGE, mergeItem("itm_dup", "itm_p2")),
    refuses("the merged person merged into another person", PERSON_MERGE, mergePerson("per_dup", "per_piotr")),
  ],
  ["items_merge_guard_insert", "persons_merge_guard_insert"],
);

describe("a merge, while the check of foreign keys is put off to the commit", () => {
  // Then a row can point at one that is not there yet, and a statement finds rows that the
  // foreign keys would have kept out. The signposts still resolve in one hop.
  it("refuses two items that are inserted as merged into each other", () => {
    const db = given(...ITEMS);

    expect(
      deferred(
        db,
        item("itm_a", "project", null, { merged_into_id: "itm_b" }),
        item("itm_b", "project", null, { merged_into_id: "itm_a" }),
      ),
    ).toEqual([ACCEPTED, ITEM_MERGE]);
  });

  it("refuses an item that is inserted as merged while another one points at it already", () => {
    const db = given(...ITEMS);

    expect(
      deferred(
        db,
        item("itm_a", "project", null, { merged_into_id: "itm_b" }),
        item("itm_b", "project", null, { merged_into_id: "itm_p1" }),
      ),
    ).toEqual([ACCEPTED, ITEM_MERGE]);
  });

  it("refuses the same of two persons", () => {
    const db = given(...PERSONS);

    expect(
      deferred(
        db,
        person("per_a", "A. Kowalska", { merged_into_id: "per_b" }),
        person("per_b", "Anna K.", { merged_into_id: "per_a" }),
      ),
    ).toEqual([ACCEPTED, PERSON_MERGE]);
    expect(
      deferred(
        db,
        person("per_a", "A. Kowalska", { merged_into_id: "per_b" }),
        person("per_b", "Anna K.", { merged_into_id: "per_anna" }),
      ),
    ).toEqual([ACCEPTED, PERSON_MERGE]);
  });

  it("accepts a merged item that is inserted before the item it points at", () => {
    const db = given(...ITEMS);

    expect(deferred(db, item("itm_a", "project", null, { merged_into_id: "itm_b" }), item("itm_b", "project"))).toEqual(
      [ACCEPTED, ACCEPTED],
    );
  });
});

// The guards that keep new rows off a merged row judge a row when it is written, against the rows
// that are there. While the check of foreign keys is put off or switched off, a row can be written
// before the item or the person it names, and it is not judged again when that one arrives as a
// merged row. No operation writes in that order: a merge marks a row that is there.
describe("a row that is written before the merged item or the merged person it names", () => {
  /** A task, a fact and an alias, each written before the item or the person it names; then those two, merged. */
  const ROWS = [
    item("itm_child", "task", "itm_late"),
    fact("fct_9", { item_id: "itm_late" }),
    personAlias("pal_9", "per_late", "Ania"),
    item("itm_late", "task", "itm_p1", { merged_into_id: "itm_t11" }),
    person("per_late", "A. Kowalska", { merged_into_id: "per_anna" }),
  ];
  const write = (db: Connection) => {
    for (const statement of ROWS) expect(attempt(db, statement), statement.sql).toBe(ACCEPTED);
  };
  /** The three rows stand on merged rows and every key holds; rows of the same kinds are refused from then on. */
  const standsOnMergedRows = (db: Connection) => {
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(rowsOf(db, "items", "parent_id = 'itm_late'")).toBe(1);
    expect(rowsOf(db, "facts", "item_id = 'itm_late'")).toBe(1);
    expect(rowsOf(db, "person_aliases", "person_id = 'per_late'")).toBe(1);
    expect(attempt(db, item("itm_child2", "task", "itm_late"))).toEqual(PARENT_MERGED);
    expect(attempt(db, fact("fct_10", { item_id: "itm_late" }))).toEqual(FACT_ITEM_MERGED);
    expect(attempt(db, personAlias("pal_10", "per_late", "Anka"))).toEqual(PERSON_ALIAS_MERGED);
  };

  it("is accepted while the check of foreign keys is put off to the commit, and so is the row that arrives merged", () => {
    const db = given(...ITEMS, ...PERSONS, ...CAPTURE);

    db.transaction(() => {
      db.pragma("defer_foreign_keys = ON");
      write(db);
    })();

    standsOnMergedRows(db);
  });

  it("is accepted with foreign keys switched off, as a migration runs, and so is the row that arrives merged", () => {
    const db = given(...ITEMS, ...PERSONS, ...CAPTURE);

    db.pragma("foreign_keys = OFF");
    write(db);
    db.pragma("foreign_keys = ON");

    standsOnMergedRows(db);
  });
});

// An item and a person keep their id. The guards of a merge judge a row against the ids that the
// other rows carry at that moment. A row that took another id afterwards would stand where those
// guards let no row be put: a merged row that another merged row points at, a fact on a merged
// item, a task under one.
scene(
  "the id of an item and of a person",
  [...ITEMS, ...PERSONS],
  [
    refuses("another id for an item", ITEM_ID_FIXED, update("items", "itm_p2", { id: "itm_p9" })),
    refuses(
      "another id for an item that has items under it",
      ITEM_ID_FIXED,
      update("items", "itm_t10", { id: "itm_t19" }),
    ),
    refuses("another id for a person", PERSON_ID_FIXED, update("persons", "per_piotr", { id: "per_p9" })),
    refuses(
      "another id for the person who is the owner",
      PERSON_ID_FIXED,
      update("persons", "per_me", { id: "per_ja" }),
    ),
    // The replacing form removes the row that has the id: what sat under that row, or pointed at
    // it, would then sit under the row that took the id.
    refuses(
      "a replacing UPDATE that gives an item the id of another item",
      ITEM_ID_FIXED,
      replacing(update("items", "itm_s21", { id: "itm_t10" })),
    ),
    refuses(
      "a replacing UPDATE that gives a person the id of another person",
      PERSON_ID_FIXED,
      replacing(update("persons", "per_piotr", { id: "per_anna" })),
    ),
    refuses(
      "an ignoring UPDATE of the id of an item",
      ITEM_ID_FIXED,
      ignoring(update("items", "itm_p2", { id: "itm_p9" })),
    ),
    refuses(
      "an upsert whose update gives an item another id",
      ITEM_ID_FIXED,
      onConflict(item("itm_p2", "project"), "(id) DO UPDATE SET id = 'itm_p9'"),
    ),
    refuses(
      "an upsert whose update gives a person another id",
      PERSON_ID_FIXED,
      onConflict(person("per_piotr", "Piotr Nowak"), "(id) DO UPDATE SET id = 'per_p9'"),
    ),
    refuses("another id for every item at once", ITEM_ID_FIXED, sql("UPDATE items SET id = id || '_x'")),
    // An ORM that sends every column writes the id back as it is.
    accepts("an item written back with its id", itsOwn("items", "itm_p2", "id", "title")),
    accepts("a person written back with its id", itsOwn("persons", "per_piotr", "id", "name")),
    accepts(
      "an upsert that names the id of an item with its own value",
      onConflict(item("itm_p2", "project"), "(id) DO UPDATE SET id = excluded.id, title = excluded.title"),
    ),
  ],
);

describe("the id of an item and of a person, while the check of foreign keys is put off to the commit", () => {
  // Then one row can step aside and another take its id, and every foreign key holds at the commit.
  /** "itm_p" is merged into "itm_q" and "itm_r" into "itm_s", and the same of four persons. */
  const PAIRS = [
    item("itm_q", "project"),
    item("itm_p", "project", null, { merged_into_id: "itm_q" }),
    item("itm_s", "project"),
    item("itm_r", "project", null, { merged_into_id: "itm_s" }),
    person("per_q", "Anna Kowalska"),
    person("per_p", "A. Kowalska", { merged_into_id: "per_q" }),
    person("per_s", "Piotr Nowak"),
    person("per_r", "P. Nowak", { merged_into_id: "per_s" }),
  ];
  const rename = (table: string, from: string, to: string) => update(table, from, { id: to });
  const signposts = (db: Connection, table: string) =>
    db.prepare(`SELECT id, merged_into_id FROM ${table} WHERE merged_into_id IS NOT NULL ORDER BY id`).all();

  it.each([
    ["items", "itm", ITEM_ID_FIXED],
    ["persons", "per", PERSON_ID_FIXED],
  ] as const)(
    "refuses every rename of %s that would hand the id of a survivor to a merged row",
    (table, prefix, kept) => {
      const db = given(...PAIRS);
      const before = signposts(db, table);
      const [p, q, r, s] = ["p", "q", "r", "s"].map((row) => `${prefix}_${row}`) as [string, string, string, string];

      // A survivor steps aside and the other merged row takes its id: a chain of two signposts.
      expect(deferred(db, rename(table, q, `${prefix}_tmp`), rename(table, r, q))).toEqual([kept, kept]);
      // Both survivors step aside and each merged row takes the id of the other one's survivor: two
      // merged rows that point at each other.
      expect(
        deferred(
          db,
          rename(table, q, `${prefix}_t1`),
          rename(table, s, `${prefix}_t2`),
          rename(table, p, s),
          rename(table, r, q),
        ),
      ).toEqual([kept, kept, kept, kept]);

      expect(signposts(db, table)).toEqual(before);
    },
  );

  // The control: these are the statements that build it, and neither the guards of a merge nor
  // the foreign keys see them.
  it("is kept by the two guards alone: without them the renames leave merged rows that point at merged rows", () => {
    const db = given(
      ...PAIRS,
      ...CAPTURE,
      fact("fct_1", { item_id: "itm_s" }),
      without("items_id_fixed", "persons_id_fixed"),
    );

    db.transaction(() => {
      db.pragma("defer_foreign_keys = ON");
      for (const [table, prefix] of [
        ["items", "itm"],
        ["persons", "per"],
      ] as const) {
        expect(attempt(db, rename(table, `${prefix}_q`, `${prefix}_tmp`))).toBe(ACCEPTED);
        expect(attempt(db, rename(table, `${prefix}_r`, `${prefix}_q`))).toBe(ACCEPTED);
      }
      // The second survivor of the items steps aside as well, and the first merged item takes its id.
      expect(attempt(db, rename("items", "itm_s", "itm_gone"))).toBe(ACCEPTED);
      expect(attempt(db, rename("items", "itm_p", "itm_s"))).toBe(ACCEPTED);
    })();

    // A chain of two signposts.
    expect(signposts(db, "persons")).toEqual([
      { id: "per_p", merged_into_id: "per_q" },
      { id: "per_q", merged_into_id: "per_s" },
    ]);
    // Two merged items that point at each other, and the fact is on one of them.
    expect(signposts(db, "items")).toEqual([
      { id: "itm_q", merged_into_id: "itm_s" },
      { id: "itm_s", merged_into_id: "itm_q" },
    ]);
    expect(db.prepare("SELECT item_id FROM facts").pluck().all()).toEqual(["itm_s"]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Work in progress: the queue, runs, model calls
// ---------------------------------------------------------------------------------------------

const KEY = "process_capture:cap_c1";
const TAKE_JOB = update("queue_jobs", "job_1", { state: "running", attempts: 1, started_at: T, leased_until: T2 });

scene(
  "a job of the queue",
  [...CAPTURE, job("job_1", { dedupe_key: KEY })],
  [
    accepts("a job without a key", job("job_2")),
    // A second request for the same work joins the first.
    refuses(
      "a second job that waits for the same work",
      unique("queue_jobs.dedupe_key"),
      job("job_2", { dedupe_key: KEY }),
    ),
    refuses("a state outside the list", FOREIGN_KEY, job("job_2", { state: "waiting", finished_at: T2 })),
    refuses(
      "running without a lease",
      check("(state = 'running') = (leased_until IS NOT NULL)"),
      update("queue_jobs", "job_1", { state: "running", attempts: 1, started_at: T }),
    ),
    refuses(
      "a lease without running",
      check("(state = 'running') = (leased_until IS NOT NULL)"),
      update("queue_jobs", "job_1", { leased_until: T2 }),
    ),
    accepts("taking a job: running, with a lease", TAKE_JOB),
    refuses(
      "a finishing time on a job that waits",
      check("(state IN ('queued', 'running')) = (finished_at IS NULL)"),
      update("queue_jobs", "job_1", { finished_at: T2 }),
    ),
    refuses(
      "a finished job without its finishing time",
      check("(state IN ('queued', 'running')) = (finished_at IS NULL)"),
      job("job_2", { state: "done", attempts: 1 }),
    ),
    refuses(
      "more attempts than allowed",
      check("attempts <= max_attempts"),
      update("queue_jobs", "job_1", { attempts: 6 }),
    ),
    refuses("attempts below 0", check("attempts >= 0"), job("job_2", { attempts: -1 })),
    refuses("no attempt allowed at all", check("max_attempts >= 1"), job("job_2", { max_attempts: 0 })),
    refuses("an empty key", check("dedupe_key <> ''"), job("job_2", { dedupe_key: "" })),
    refuses(
      "a kind that is not a lower-case identifier",
      identifier("kind"),
      job("job_2", { kind: "Process Capture" }),
    ),
    refuses(
      "a payload that is not an object",
      jsonObject("payload"),
      update("queue_jobs", "job_1", { payload: "[1]" }),
    ),
    refuses("a payload that is not JSON", jsonObject("payload"), update("queue_jobs", "job_1", { payload: "{broken" })),
    refuses(
      "a payload with a NUL character and more behind the object",
      jsonObject("payload"),
      update("queue_jobs", "job_1", { payload: `{}${NUL}not json` }),
    ),
    refuses("a kind with a NUL character", identifier("kind"), job("job_2", { kind: `process_capture${NUL}x` })),
    refuses("a job for a source that does not exist", FOREIGN_KEY, job("job_2", { source_id: "cap_nowhere" })),
    following(
      [TAKE_JOB],
      // A job that is being worked on does not stand in the way of a new request.
      accepts("a new waiting job for the same work while the first one runs", job("job_2", { dedupe_key: KEY })),
      refuses(
        "done with the lease still set",
        check("(state = 'running') = (leased_until IS NOT NULL)"),
        update("queue_jobs", "job_1", { state: "done", finished_at: T2 }),
      ),
      accepts("done", update("queue_jobs", "job_1", { state: "done", finished_at: T2, leased_until: null })),
    ),
    // A job that goes back to waiting after an attempt has its attempt counted, and the rule
    // about one waiting job per key is about jobs that no attempt has started.
    following(
      [TAKE_JOB, job("job_2", { dedupe_key: KEY })],
      accepts(
        "a job back to waiting after a failed attempt, beside a newer job for the same work",
        update("queue_jobs", "job_1", { state: "queued", leased_until: null, last_error_code: "overloaded" }),
      ),
      refuses("a third request for the same work", unique("queue_jobs.dedupe_key"), job("job_3", { dedupe_key: KEY })),
    ),
    following(
      [insert("job_states", { code: "cancelled" })],
      accepts("a new state at once", update("queue_jobs", "job_1", { state: "cancelled", finished_at: T2 })),
    ),
  ],
);

describe("a job of the queue", () => {
  // What a start does after a process was killed: the runs it left are failed, and their jobs wait
  // again, beside whatever was queued for the same work meanwhile.
  it("goes back to waiting at start-up together with every other job that a dead process left running", () => {
    const db = given(
      ...CAPTURE,
      runningJob("job_1", { dedupe_key: KEY }),
      job("job_2", { dedupe_key: KEY }),
      runningJob("job_3", { source_id: null }),
      run("run_1"),
    );

    const recovered = db.transaction(() => {
      db.prepare(
        "UPDATE runs SET state = 'failed', error_code = 'interrupted', ended_at = ? WHERE state = 'running'",
      ).run(T2);
      return db.prepare("UPDATE queue_jobs SET state = 'queued', leased_until = NULL WHERE state = 'running'").run()
        .changes;
    })();

    expect(recovered).toBe(2);
    expect(db.prepare("SELECT id, state, attempts FROM queue_jobs ORDER BY id").all()).toEqual([
      { id: "job_1", state: "queued", attempts: 1 },
      { id: "job_2", state: "queued", attempts: 0 },
      { id: "job_3", state: "queued", attempts: 1 },
    ]);
    expect(db.prepare("SELECT state, error_code FROM runs").all()).toEqual([
      { state: "failed", error_code: "interrupted" },
    ]);
  });
});

const END_RUN = update("runs", "run_1", { state: "committed", ended_at: T2, summary: "Ryzyko w Atlasie." });
const FAILED_RUN = run("run_f", {
  job_id: null,
  state: "failed",
  ended_at: T2,
  error_code: "max_tokens",
  error_message: "za długo",
});

scene(
  "a run",
  [...CAPTURE, OTHER_SOURCE, runningJob("job_1"), runningJob("job_2", { source_id: null }), run("run_1")],
  [
    accepts("a run of a job", run("run_2", { job_id: "job_2" })),
    accepts("a run without a job", run("run_2", { job_id: null })),
    accepts("a run that failed", FAILED_RUN),
    refuses(
      "running with an end",
      check("(state = 'running') = (ended_at IS NULL)"),
      run("run_2", { job_id: null, ended_at: T2 }),
    ),
    refuses(
      "committed without an end",
      check("(state = 'running') = (ended_at IS NULL)"),
      run("run_2", { job_id: null, state: "committed" }),
    ),
    refuses(
      "failed without an error code",
      check("state <> 'failed' OR error_code IS NOT NULL"),
      run("run_2", { job_id: null, state: "failed", ended_at: T2 }),
    ),
    refuses("a state outside the list", FOREIGN_KEY, run("run_2", { job_id: null, state: "paused", ended_at: T2 })),
    refuses("an empty model", check("model <> ''"), run("run_2", { job_id: null, model: "" })),
    refuses(
      "an empty prompt version",
      check("prompt_version <> ''"),
      run("run_2", { job_id: null, prompt_version: "" }),
    ),
    refuses(
      "a kind that is not a lower-case identifier",
      identifier("kind"),
      run("run_2", { job_id: null, kind: "Process" }),
    ),
    refuses("a kind with a NUL character", identifier("kind"), run("run_2", { job_id: null, kind: `process${NUL}x` })),
    refuses("a run of a job that does not exist", FOREIGN_KEY, run("run_2", { job_id: "job_nowhere" })),
    refuses(
      "a run on a source that does not exist",
      FOREIGN_KEY,
      run("run_2", { job_id: null, source_id: "cap_nowhere" }),
    ),

    // A run row is inserted once and never deleted, and a job has at most one run in progress and
    // one that committed.
    refuses("an id that a run has already", RUN_TAKEN, run("run_1", { job_id: null })),
    refuses("a second run in progress for a job", RUN_TAKEN, run("run_2")),
    accepts(
      "a run recorded as failed for a job that has a run in progress",
      run("run_2", { state: "failed", ended_at: T2, error_code: "credential" }),
    ),
    refuses("deleting a run in progress", RUN_KEPT, remove("runs", "run_1")),
    following(
      [FAILED_RUN],
      // It could be inserted again under its id as a run that committed.
      refuses("deleting a run that has ended and that nothing points at", RUN_KEPT, remove("runs", "run_f")),
    ),
    following(
      [END_RUN],
      refuses("a second committed run of a job", RUN_TAKEN, run("run_2", { state: "committed", ended_at: T3 })),
      // Each attempt of a job is a new run.
      accepts("a new run of a job whose earlier run has ended", run("run_2")),
    ),
    following(
      [END_RUN, run("run_2")],
      // NFR-7: a job that is retried cannot apply its operations twice.
      refuses(
        "a second run of a job committing",
        RUN_TAKEN,
        update("runs", "run_2", { state: "committed", ended_at: T3 }),
      ),
      // The replacing form would commit the second run by removing the first.
      refuses(
        "a second run of a job committing in a statement that removes the first",
        RUN_TAKEN,
        replacing(update("runs", "run_2", { state: "committed", ended_at: T3 })),
      ),
      accepts(
        "a second run of a job failing",
        update("runs", "run_2", { state: "failed", ended_at: T3, error_code: "interrupted" }),
      ),
    ),
    following(
      [END_RUN, run("run_2", { job_id: "job_2" })],
      accepts("the run of another job committing", update("runs", "run_2", { state: "committed", ended_at: T3 })),
    ),
    following(
      [
        run("run_2", { job_id: null }),
        run("run_3", { job_id: null }),
        update("runs", "run_2", { state: "committed", ended_at: T2 }),
      ],
      accepts("a second run without a job committing", update("runs", "run_3", { state: "committed", ended_at: T3 })),
    ),

    // What a run is never changes.
    refuses("another id for a run", RUN_IDENTITY, update("runs", "run_1", { id: "run_9" })),
    refuses("another kind for a run", RUN_IDENTITY, update("runs", "run_1", { kind: "process_note" })),
    refuses("another source for a run", RUN_IDENTITY, update("runs", "run_1", { source_id: "cap_c3" })),
    refuses("another job for a run", RUN_IDENTITY, update("runs", "run_1", { job_id: "job_2" })),
    refuses("another start for a run", RUN_IDENTITY, update("runs", "run_1", { started_at: T2 })),
    accepts(
      "the model and the prompt version of a run in progress",
      update("runs", "run_1", { model: "model-y", prompt_version: "p2" }),
    ),
    accepts("committing a run, with its summary", END_RUN),
    accepts(
      "failing a run, with its error",
      update("runs", "run_1", { state: "failed", ended_at: T2, error_code: "interrupted", error_message: "przerwano" }),
    ),

    // A run that has ended stays as it ended: only its texts can be removed.
    following(
      [END_RUN],
      refuses("a committed run back to running", RUN_ENDED, update("runs", "run_1", { state: "running" })),
      refuses("a committed run made a failed one", RUN_ENDED, update("runs", "run_1", { state: "failed" })),
      // It is the committed run of its job, and stays that when a statement names its state again.
      accepts(
        "a committed run written back as it is",
        sql("UPDATE runs SET state = state, ended_at = ended_at, summary = summary WHERE id = 'run_1'"),
      ),
      refuses("another end for a run that has ended", RUN_IDENTITY, update("runs", "run_1", { ended_at: T3 })),
      refuses("another model for a run that has ended", RUN_IDENTITY, update("runs", "run_1", { model: "model-y" })),
      refuses(
        "another prompt version for a run that has ended",
        RUN_IDENTITY,
        update("runs", "run_1", { prompt_version: "p9" }),
      ),
      refuses(
        "another summary for a run that has ended",
        RUN_IDENTITY,
        update("runs", "run_1", { summary: "Co innego." }),
      ),
      accepts("the summary of a run removed", update("runs", "run_1", { summary: null })),
      refuses(
        "a committed run moved to another source and job, with another model and start",
        RUN_IDENTITY,
        update("runs", "run_1", {
          source_id: "cap_c3",
          job_id: "job_2",
          model: "inny",
          started_at: "2020-01-01T00:00:00.000Z",
        }),
      ),
    ),
    following(
      [FAILED_RUN],
      refuses("a failed run made a committed one", RUN_ENDED, update("runs", "run_f", { state: "committed" })),
      accepts(
        "a run that has ended written back as it is",
        sql("UPDATE runs SET state = state, ended_at = ended_at, error_code = error_code WHERE id = 'run_f'"),
      ),
      refuses(
        "another error code for a run that has ended",
        RUN_IDENTITY,
        update("runs", "run_f", { error_code: "refusal" }),
      ),
      refuses(
        "another error message for a run that has ended",
        RUN_IDENTITY,
        update("runs", "run_f", { error_message: "co innego" }),
      ),
      accepts("the error message of a run removed", update("runs", "run_f", { error_message: null })),
    ),
  ],
);

scene(
  "a model call",
  [...CAPTURE, runningJob("job_1"), run("run_1")],
  [
    accepts("a call of a job", modelCall({ prompt_version: "transcribe-3", input_tokens: 1500, output_tokens: 300 })),
    accepts(
      "a call of a run",
      modelCall({ job_id: null, run_id: "run_1", purpose: "agent_turn", detail: '{"retriedWithoutThinking":true}' }),
    ),
    refuses("a role that is not a lower-case identifier", identifier("role"), modelCall({ role: "Processing" })),
    refuses(
      "a purpose that is not a lower-case identifier",
      identifier("purpose"),
      modelCall({ purpose: "agent turn" }),
    ),
    refuses("an empty model", check("model <> ''"), modelCall({ model: "" })),
    refuses("an empty prompt version", check("prompt_version <> ''"), modelCall({ prompt_version: "" })),
    refuses("a duration below 0", check("duration_ms >= 0"), modelCall({ duration_ms: -1 })),
    refuses("a time to the first token below 0", check("first_token_ms >= 0"), modelCall({ first_token_ms: -1 })),
    refuses("input tokens below 0", check("input_tokens >= 0"), modelCall({ input_tokens: -1 })),
    refuses("output tokens below 0", check("output_tokens >= 0"), modelCall({ output_tokens: -1 })),
    refuses("cache reads below 0", check("cache_read_input_tokens >= 0"), modelCall({ cache_read_input_tokens: -1 })),
    refuses(
      "cache writes below 0",
      check("cache_creation_input_tokens >= 0"),
      modelCall({ cache_creation_input_tokens: -1 }),
    ),
    refuses("a detail that is not JSON", jsonOrNull("detail"), modelCall({ detail: "{broken" })),
    refuses(
      "a detail with a NUL character and more behind the JSON",
      jsonOrNull("detail"),
      modelCall({ detail: `{}${NUL}not json` }),
    ),
    refuses("a role with a NUL character", identifier("role"), modelCall({ role: `processing${NUL}x` })),
    refuses("a purpose with a NUL character", identifier("purpose"), modelCall({ purpose: `summary${NUL}x` })),
    refuses("a call of a run that does not exist", FOREIGN_KEY, modelCall({ job_id: null, run_id: "run_nowhere" })),
    refuses("a call of a job that does not exist", FOREIGN_KEY, modelCall({ job_id: "job_nowhere" })),
  ],
);

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

/** A capture, an item, a job that is being worked on with its run, and a second run beside it. */
const WORK = [
  ...CAPTURE,
  OTHER_SOURCE,
  PROJECT,
  item("itm_p2", "project"),
  runningJob("job_1"),
  run("run_1"),
  run("run_2", { job_id: null }),
];
const staged = (id: unknown, seq: number, more: Row = {}) =>
  operation(id, { run_id: "run_1", seq, source_id: "cap_c1", quote: "Atlas ma ryzyko", confidence: "high", ...more });
const COMMAND = staged("opr_4", 4, {
  kind: "create_item",
  origin: "command",
  quote: undefined,
  confidence: undefined,
  command_quote: "dodaj zadanie",
});
/** Four operations of one run: a fact, a person, the person's role, which needs the person, and a command. */
const STAGED = [
  ...WORK,
  staged("opr_1", 1, { rationale: "Piotr pisze o ryzyku." }),
  staged("opr_2", 2, { kind: "create_person", quote: "Magdy", confidence: "low" }),
  staged("opr_3", 3, { kind: "set_item_person", quote: "Magdy" }),
  edge("opr_3", "opr_2"),
  COMMAND,
];
const COMMIT = update("runs", "run_1", {
  state: "committed",
  ended_at: T2,
  summary: "Ryzyko w Atlasie; pytanie o Magdę.",
});
const failRun = (id: string) => update("runs", id, { state: "failed", ended_at: T2, error_code: "interrupted" });
const COMMITTED = [...STAGED, COMMIT];

const apply = (id: string, approval: string, at: string, more: Row = {}) =>
  update("operations", id, { state: "applied", approval, applied_at: at, ...more });
const accept = (id: string) => apply(id, "accepted", T3, { decided_at: T3 });
const propose = (id: string) => update("operations", id, { state: "proposed" });
const reject = (id: string) => update("operations", id, { state: "rejected", decided_at: T3 });
const invalidate = (id: string) =>
  update("operations", id, { state: "invalid", problems: '["cytatu nie ma w źródle"]' });
/** The fact and the command are applied; the person and the role wait in the Inbox. */
const PROPOSED = [
  ...COMMITTED,
  apply("opr_1", "auto", T2),
  apply("opr_4", "command", T2),
  propose("opr_2"),
  propose("opr_3"),
];
/** The owner has accepted both: all four are entries of the journal. */
const DECIDED = [...PROPOSED, accept("opr_2"), accept("opr_3")];

const FACT_EFFECT = effect("opr_1", {
  entity_kind: "fact",
  entity_id: "fct_1",
  change: "create",
  item_id: "itm_p1",
  after_value: '{"id":"fct_1"}',
});
const STATUS_EFFECT = effect("opr_4", {
  change: "update",
  field: "status",
  item_id: "itm_p1",
  before_value: '"todo"',
  after_value: '"blocked"',
});
const ROLE_EFFECT = effect("opr_3", {
  entity_kind: "item_person",
  entity_id: "itp_2",
  change: "touch",
  item_id: "itm_p1",
});
const EFFECTS = [...DECIDED, FACT_EFFECT, STATUS_EFFECT, ROLE_EFFECT];

/** An undo is an operation of its own: it has no run and is applied by the statement that inserts it. */
const anUndo = (id: string) =>
  operation(id, {
    kind: "undo",
    origin: "user",
    state: "applied",
    approval: "manual",
    applied_at: T4,
    payload: '{"operations":["opr_3"]}',
  });
const UNDO = anUndo("opr_u1");
const undo = (id: string, by = "opr_u1") => update("operations", id, { state: "undone", undone_by_id: by });

// An operation of a run starts staged, while the run is running. An operation without a run is
// applied by the statement that inserts it. A command carries the owner's words.
scene(
  "an operation as it is recorded",
  [...WORK, FAILED_RUN],
  [
    accepts("an operation that a running run stages", staged("opr_1", 1)),
    accepts("an operation that the owner made by hand", manual("opr_m1")),
    accepts("a command with the owner's words", COMMAND),
    refuses(
      "an operation of a run without a position in it",
      check("(run_id IS NULL) = (seq IS NULL)"),
      staged("opr_1", 1, { seq: undefined }),
    ),
    refuses("a position without a run", check("(run_id IS NULL) = (seq IS NULL)"), manual("opr_m1", { seq: 1 })),
    refuses("a position below 0", check("seq >= 0"), staged("opr_1", -1)),
    refuses("an operation of a run inserted as proposed", STAGING, staged("opr_1", 1, { state: "proposed" })),
    refuses(
      "an operation of a run inserted as applied",
      STAGING,
      staged("opr_1", 1, { state: "applied", approval: "auto", applied_at: T }),
    ),
    refuses(
      "an operation of a run inserted in a state outside the list",
      STAGING,
      staged("opr_1", 1, { state: "pending" }),
    ),
    refuses("staging into a run that has ended", STAGING, staged("opr_1", 1, { run_id: "run_f" })),
    refuses("staging into a run that does not exist", STAGING, staged("opr_1", 1, { run_id: "run_nowhere" })),
    refuses("a staged operation without a run", WITHOUT_RUN, operation("opr_1")),
    refuses("an operation without a run inserted as proposed", WITHOUT_RUN, operation("opr_1", { state: "proposed" })),
    refuses(
      "an operation made by hand without the time it was applied",
      check("(applied_at IS NOT NULL) = (state IN ('applied', 'undone'))"),
      manual("opr_m1", { applied_at: undefined }),
    ),
    refuses(
      "an operation made by hand without the way it was approved",
      check("(approval IS NOT NULL) = (applied_at IS NOT NULL)"),
      manual("opr_m1", { approval: undefined }),
    ),
    refuses("a command of a run without the owner's words", COMMAND_QUOTE, staged("opr_1", 1, { origin: "command" })),
    refuses("a command made by hand without the owner's words", COMMAND_QUOTE, manual("opr_m1", { origin: "command" })),
    refuses(
      "a quote without a source",
      check("quote IS NULL OR source_id IS NOT NULL"),
      staged("opr_1", 1, { source_id: null }),
    ),
    refuses(
      "the quote of a command without a source",
      check("command_quote IS NULL OR source_id IS NOT NULL"),
      staged("opr_1", 1, { origin: "command", quote: undefined, command_quote: "dodaj zadanie", source_id: null }),
    ),
    refuses("an empty quote", check("quote <> ''"), staged("opr_1", 1, { quote: "" })),
    refuses(
      "an empty quote of a command",
      check("command_quote <> ''"),
      staged("opr_1", 1, { origin: "command", command_quote: "" }),
    ),
    refuses("a kind that is not a lower-case identifier", identifier("kind"), staged("opr_1", 1, { kind: "Add Fact" })),
    refuses(
      "an origin that is not a lower-case identifier",
      identifier("origin"),
      staged("opr_1", 1, { origin: "The Agent" }),
    ),
    refuses(
      "a confidence that is not a lower-case identifier",
      identifier("confidence"),
      staged("opr_1", 1, { confidence: "Very High" }),
    ),
    refuses(
      "a way of approval that is not a lower-case identifier",
      identifier("approval"),
      manual("opr_m1", { approval: "By Hand" }),
    ),
    // Behind a NUL character the word is another word to every rule that names it, and the rule
    // that asks a command for the owner's words would not see a command.
    refuses(
      "a command without the owner's words whose origin has a NUL character behind the word",
      identifier("origin"),
      staged("opr_1", 1, { origin: `command${NUL}` }),
    ),
    refuses("a kind with a NUL character", identifier("kind"), staged("opr_1", 1, { kind: `undo${NUL}` })),
    refuses(
      "a confidence with a NUL character",
      identifier("confidence"),
      staged("opr_1", 1, { confidence: `high${NUL}x` }),
    ),
    refuses(
      "a way of approval with a NUL character",
      identifier("approval"),
      manual("opr_m1", { approval: `manual${NUL}x` }),
    ),
    refuses("a payload that is not an object", jsonObject("payload"), staged("opr_1", 1, { payload: '"x"' })),
    refuses("a payload that is not JSON", jsonObject("payload"), staged("opr_1", 1, { payload: "{broken" })),
    refuses(
      "a payload with a NUL character and more behind the object",
      jsonObject("payload"),
      staged("opr_1", 1, { payload: `{}${NUL}not json` }),
    ),
    ...["answer", "annotations", "problems", "proposed_payload"].flatMap((column) => [
      refuses(`${column} that is not JSON`, jsonOrNull(column), staged("opr_1", 1, { [column]: "{broken" })),
      refuses(
        `${column} with a NUL character and more behind the JSON`,
        jsonOrNull(column),
        staged("opr_1", 1, { [column]: `[]${NUL}not json` }),
      ),
    ]),
    refuses(
      "an operation from a source that does not exist",
      FOREIGN_KEY,
      staged("opr_1", 1, { source_id: "cap_nowhere" }),
    ),
    following(
      [staged("opr_1", 1)],
      refuses("the same position in a run twice", unique("operations.run_id", "operations.seq"), staged("opr_9", 1)),
      refuses("an id that an operation has already", OPERATION_TAKEN, staged("opr_1", 9)),
      accepts("the same position in another run", staged("opr_9", 1, { run_id: "run_2" })),
    ),
  ],
);

// Staged operations move on only after their run is committed.
scene("an operation that is staged", STAGED, [
  refuses("applying it before its run is committed", TRANSITION, apply("opr_1", "auto", T2)),
  refuses("proposing it before its run is committed", TRANSITION, propose("opr_1")),
  refuses("marking it invalid before its run is committed", TRANSITION, invalidate("opr_1")),
  refuses("an effect of it", EFFECTS_ONLY_APPLIED, effect("opr_1")),
  refuses(
    "taking the owner's words off a command",
    COMMAND_QUOTE,
    update("operations", "opr_4", { command_quote: null }),
  ),
  accepts(
    "no words of the owner, written on an operation that is no command",
    update("operations", "opr_1", { command_quote: null }),
  ),
  refuses("another kind for it", OPERATION_IDENTITY, update("operations", "opr_1", { kind: "update_item" })),
  // It is not history yet: the framework may still correct it.
  accepts(
    "another payload and another quote for it",
    update("operations", "opr_1", { payload: '{"x":1}', quote: "ryzyko" }),
  ),
  accepts("deleting it", remove("operations", "opr_1")),
  refuses("deleting it while another operation needs it", FOREIGN_KEY, remove("operations", "opr_2")),
  refuses("moving it to another run", OPERATION_IDENTITY, update("operations", "opr_1", { run_id: "run_2" })),
  // The scrub mark is what stands for the owner's words once permanent deletion has removed them.
  accepts(
    "the owner's words taken off a command together with the scrub mark",
    update("operations", "opr_4", { command_quote: null, scrubbed_at: T3 }),
  ),
  following(
    [update("operations", "opr_4", { command_quote: null, scrubbed_at: T3 })],
    refuses(
      "the scrub mark taken off a command whose words are gone",
      COMMAND_QUOTE,
      update("operations", "opr_4", { scrubbed_at: null }),
    ),
    accepts(
      "the scrub mark taken off a command together with new words",
      update("operations", "opr_4", { command_quote: "dodaj zadanie", scrubbed_at: null }),
    ),
  ),
  following(
    [update("operations", "opr_1", { quote: null, scrubbed_at: T3 })],
    accepts(
      "the scrub mark taken off an operation that is no command",
      update("operations", "opr_1", { scrubbed_at: null }),
    ),
  ),
]);

describe("a run that ends without being committed", () => {
  const SECOND_RUN = [
    ...STAGED,
    operation("opr_21", { run_id: "run_2", seq: 1 }),
    operation("opr_22", { run_id: "run_2", seq: 2 }),
    edge("opr_22", "opr_21"),
    // One of its operations needs an operation of the other run.
    edge("opr_22", "opr_1"),
  ];

  it("leaves nothing of what it staged, and nothing else is touched", () => {
    const db = given(...SECOND_RUN);

    expect(attempt(db, failRun("run_2"))).toBe(ACCEPTED);

    expect(rowsOf(db, "operations", "run_id = 'run_2'")).toBe(0);
    expect(rowsOf(db, "operation_dependencies", "operation_id = 'opr_22' OR depends_on_id = 'opr_21'")).toBe(0);
    // The other run still has its four operations and its edge.
    expect(rowsOf(db, "operations", "run_id = 'run_1' AND state = 'staged'")).toBe(4);
    expect(rowsOf(db, "operation_dependencies")).toBe(1);
  });

  it("takes along the edges that lead to what it staged, also those of operations that were decided meanwhile", () => {
    // The role of the first run is proposed, linked by the owner to an operation that the second
    // run has staged, and then rejected. Its edges are history now, except the one that hangs on
    // an operation which is about to disappear.
    const db = given(...SECOND_RUN, COMMIT, propose("opr_3"), edge("opr_3", "opr_21"), reject("opr_3"));

    expect(attempt(db, failRun("run_2"))).toBe(ACCEPTED);

    expect(rowsOf(db, "operations", "run_id = 'run_2'")).toBe(0);
    expect(rowsOf(db, "operation_dependencies", "operation_id = 'opr_3'")).toBe(1);
    expect(db.prepare("SELECT state FROM operations WHERE id = 'opr_3'").pluck().get()).toBe("rejected");
  });

  it("is the only kind of run that loses anything: a committed run keeps what it staged", () => {
    const db = given(...SECOND_RUN);
    const edges = rowsOf(db, "operation_dependencies");

    expect(attempt(db, COMMIT)).toBe(ACCEPTED);

    expect(rowsOf(db, "operations", "run_id = 'run_1' AND state = 'staged'")).toBe(4);
    expect(rowsOf(db, "operation_dependencies")).toBe(edges);
  });

  // The rule is "any end but a commit", not a list of the ends that exist today.
  it("leaves nothing also when it ends in a state that a later migration adds", () => {
    const db = given(...SECOND_RUN, insert("run_states", { code: "cancelled" }));

    expect(attempt(db, update("runs", "run_2", { state: "cancelled", ended_at: T2 }))).toBe(ACCEPTED);

    expect(rowsOf(db, "operations", "run_id = 'run_2'")).toBe(0);
    expect(rowsOf(db, "operations", "run_id = 'run_1' AND state = 'staged'")).toBe(4);
  });
});

// The life cycle: staged, then proposed, applied or invalid; proposed and invalid wait for a
// decision; applied can be undone, once, by an undo.
scene("an operation after its run is committed", COMMITTED, [
  accepts("applying it at once", apply("opr_1", "auto", T2)),
  accepts("applying a command", apply("opr_4", "command", T2)),
  accepts("proposing it", propose("opr_2")),
  accepts("marking it invalid, with what is wrong", invalidate("opr_2")),
  refuses(
    "marking it invalid without saying what is wrong",
    check("state <> 'invalid' OR problems IS NOT NULL"),
    update("operations", "opr_2", { state: "invalid" }),
  ),
  refuses("rejecting it before it was proposed", TRANSITION, reject("opr_1")),
  refuses("staging into the committed run", STAGING, staged("opr_9", 9)),
  // Between the commit and the decision about it, a proposal must not vanish.
  refuses("deleting it while it is still staged", OPERATION_DELETE, remove("operations", "opr_1")),
  refuses(
    "applying it without the time",
    check("(applied_at IS NOT NULL) = (state IN ('applied', 'undone'))"),
    update("operations", "opr_1", { state: "applied", approval: "auto" }),
  ),
  refuses(
    "applying it without the way of approval",
    check("(approval IS NOT NULL) = (applied_at IS NOT NULL)"),
    update("operations", "opr_1", { state: "applied", applied_at: T2 }),
  ),
  refuses("the dependant applied before what it needs", DEPENDENCY_ORDER, apply("opr_3", "auto", T2)),
  following(
    [apply("opr_2", "auto", T2)],
    accepts("the dependant applied after what it needs", apply("opr_3", "auto", T2)),
  ),
]);

scene("an operation that waits for a decision", PROPOSED, [
  refuses(
    "the time it was applied while it is only proposed",
    check("(applied_at IS NOT NULL) = (state IN ('applied', 'undone'))"),
    update("operations", "opr_2", { applied_at: T3, approval: "accepted" }),
  ),
  refuses(
    "rejecting it without the time of the decision",
    check("state <> 'rejected' OR decided_at IS NOT NULL"),
    update("operations", "opr_3", { state: "rejected" }),
  ),
  refuses("the dependant accepted before what it needs", DEPENDENCY_ORDER, accept("opr_3")),
  refuses("what another operation needs rejected while that one still waits", DEPENDENCY_ORDER, reject("opr_2")),
  refuses("putting it back to staged", TRANSITION, update("operations", "opr_2", { state: "staged" })),
  // The owner changes fields before accepting, and what the agent proposed is kept beside it.
  accepts(
    "another payload before the decision",
    sql(
      "UPDATE operations SET proposed_payload = payload, payload = '{\"name\":\"Magdalena Wójcik\"}' WHERE id = 'opr_2'",
    ),
  ),
  accepts("marking it invalid", invalidate("opr_3")),
  accepts("rejecting the dependant", reject("opr_3")),
  accepts("accepting what another operation needs", accept("opr_2")),
  following([reject("opr_3")], accepts("rejecting, after its dependant, what the dependant needed", reject("opr_2"))),
  following([accept("opr_2")], accepts("accepting the dependant after what it needs", accept("opr_3"))),
  following(
    [invalidate("opr_3")],
    accepts("an invalid operation proposed again", propose("opr_3")),
    accepts("an invalid operation rejected", reject("opr_3")),
    refuses("an invalid operation put back to staged", TRANSITION, update("operations", "opr_3", { state: "staged" })),
  ),
  following(
    [invalidate("opr_3"), accept("opr_2")],
    accepts("an invalid operation applied by the owner's decision", accept("opr_3")),
  ),
  following(
    [reject("opr_3")],
    refuses("a rejected operation proposed again", TRANSITION, propose("opr_3")),
    refuses("an effect of a rejected operation", EFFECTS_ONLY_APPLIED, effect("opr_3")),
    refuses("deleting a rejected operation", OPERATION_DELETE, remove("operations", "opr_3")),
    refuses(
      "another payload for a rejected operation",
      OPERATION_HISTORY,
      update("operations", "opr_3", { payload: '{"x":1}' }),
    ),
    refuses(
      "another time of decision for a rejected operation",
      OPERATION_HISTORY,
      update("operations", "opr_3", { decided_at: T4 }),
    ),
  ),
  following(
    // What it needs is applied, so that the order of dependencies has nothing to say.
    [accept("opr_2"), reject("opr_3")],
    refuses("a rejected operation applied", TRANSITION, update("operations", "opr_3", { state: "applied" })),
  ),
  refuses("deleting an operation that waits for a decision", OPERATION_DELETE, remove("operations", "opr_2")),
  refuses("an effect of an operation that is only proposed", EFFECTS_ONLY_APPLIED, effect("opr_2")),
  following([UNDO], refuses("undoing an operation that was never applied", TRANSITION, undo("opr_3"))),
  // Only an undo takes an operation back, and the mark that says which one belongs to that state alone.
  refuses("an applied operation marked as undone by one that is not an undo", TRANSITION, undo("opr_1", "opr_4")),
  refuses(
    "the mark of an undo on an operation that is not undone",
    check("(undone_by_id IS NOT NULL) = (state = 'undone')"),
    update("operations", "opr_1", { undone_by_id: "opr_4" }),
  ),
]);

// What an operation is never changes, and once decided it is history: its text can be removed
// when its source is deleted for good, and never rewritten.
scene("an operation that was applied", DECIDED, [
  refuses("another id", OPERATION_IDENTITY, update("operations", "opr_1", { id: "opr_9" })),
  refuses("another run", OPERATION_IDENTITY, update("operations", "opr_1", { run_id: "run_2" })),
  refuses("another position", OPERATION_IDENTITY, update("operations", "opr_1", { seq: 7 })),
  refuses("another kind", OPERATION_IDENTITY, update("operations", "opr_1", { kind: "update_item" })),
  refuses("another origin", OPERATION_IDENTITY, update("operations", "opr_1", { origin: "user" })),
  refuses("another creation time", OPERATION_IDENTITY, update("operations", "opr_1", { created_at: T3 })),

  refuses("another source", OPERATION_HISTORY, update("operations", "opr_1", { source_id: "cap_c3" })),
  refuses("another confidence", OPERATION_HISTORY, update("operations", "opr_1", { confidence: "low" })),
  refuses("another way of approval", OPERATION_HISTORY, update("operations", "opr_1", { approval: "manual" })),
  refuses("another time of decision", OPERATION_HISTORY, update("operations", "opr_2", { decided_at: T4 })),
  refuses("another time of applying", OPERATION_HISTORY, update("operations", "opr_1", { applied_at: T3 })),
  refuses("another quote", OPERATION_HISTORY, update("operations", "opr_1", { quote: "inny" })),
  refuses(
    "other words of the owner for a command",
    OPERATION_HISTORY,
    update("operations", "opr_4", { command_quote: "usuń zadanie" }),
  ),
  refuses("another rationale", OPERATION_HISTORY, update("operations", "opr_1", { rationale: "bo tak" })),
  refuses("an answer written afterwards", OPERATION_HISTORY, update("operations", "opr_1", { answer: '"tak"' })),
  refuses("annotations written afterwards", OPERATION_HISTORY, update("operations", "opr_1", { annotations: "[]" })),
  refuses("problems written afterwards", OPERATION_HISTORY, update("operations", "opr_1", { problems: "[]" })),
  refuses(
    "a proposed payload written afterwards",
    OPERATION_HISTORY,
    update("operations", "opr_1", { proposed_payload: "{}" }),
  ),
  refuses("another payload", OPERATION_HISTORY, update("operations", "opr_1", { payload: '{"x":1}' })),
  refuses("going back to proposed", TRANSITION, update("operations", "opr_1", { state: "proposed" })),
  refuses("going back to staged", TRANSITION, update("operations", "opr_1", { state: "staged" })),
  refuses("becoming rejected", TRANSITION, update("operations", "opr_1", { state: "rejected" })),
  refuses("deleting it", OPERATION_DELETE, remove("operations", "opr_1")),
  accepts(
    "a row written back as it is",
    sql(
      "UPDATE operations SET state = state, payload = payload, quote = quote, kind = kind, applied_at = applied_at WHERE id = 'opr_1'",
    ),
  ),

  // Permanent deletion of the source: the texts go, and the payload goes with the scrub mark.
  accepts("the quote and the rationale removed", update("operations", "opr_1", { quote: null, rationale: null })),
  refuses(
    "the scrub mark while the quote is still there",
    check("scrubbed_at IS NULL OR (quote IS NULL AND command_quote IS NULL)"),
    update("operations", "opr_1", { scrubbed_at: T3 }),
  ),
  accepts(
    "the texts removed and the payload emptied, with the scrub mark",
    update("operations", "opr_1", { quote: null, rationale: null, payload: "{}", scrubbed_at: T3 }),
  ),
  refuses(
    "the owner's words taken off a command without the scrub mark",
    COMMAND_QUOTE,
    update("operations", "opr_4", { command_quote: null }),
  ),
  accepts(
    "the owner's words taken off a command with the scrub mark",
    update("operations", "opr_4", { command_quote: null, scrubbed_at: T3 }),
  ),
  following(
    [update("operations", "opr_1", { quote: null, rationale: null, payload: "{}", scrubbed_at: T3 })],
    refuses("the scrub mark moved", OPERATION_HISTORY, update("operations", "opr_1", { scrubbed_at: T4 })),
    refuses("the scrub mark taken back", OPERATION_HISTORY, update("operations", "opr_1", { scrubbed_at: null })),
    refuses(
      "the payload of a scrubbed operation written again",
      OPERATION_HISTORY,
      update("operations", "opr_1", { payload: '{"x":1}' }),
    ),
    refuses(
      "the payload written again with the scrub mark taken back",
      OPERATION_HISTORY,
      update("operations", "opr_1", { payload: '{"x":1}', scrubbed_at: null }),
    ),
  ),
]);

// What the owner answered and what the framework attached can hold text of the source too.
const ATTACHED = ["answer", "annotations", "problems", "proposed_payload"];

scene(
  "what was attached to an operation that was applied",
  [
    ...PROPOSED,
    update("operations", "opr_2", {
      answer: '"Magda z płatności"',
      annotations: '["możliwy duplikat"]',
      problems: "[]",
      proposed_payload: '{"name":"Magda"}',
    }),
    accept("opr_2"),
  ],
  [
    ...ATTACHED.map((column) => accepts(`${column} removed`, update("operations", "opr_2", { [column]: null }))),
    ...ATTACHED.map((column) =>
      refuses(`${column} rewritten`, OPERATION_HISTORY, update("operations", "opr_2", { [column]: '"co innego"' })),
    ),
  ],
);
// "A needs B": B is applied first, and A is rejected or undone first. An edge never closes a
// cycle, because the operations of a cycle could be neither applied nor rejected. Edges are
// added and removed only while the operation that needs something is undecided.
scene("a dependency between operations", STAGED, [
  accepts("an edge to an operation staged earlier", edge("opr_4", "opr_1")),
  // The owner links a proposal to an item that is proposed further down the same card.
  accepts("an edge to an operation staged later", edge("opr_1", "opr_4")),
  refuses("an operation that needs itself", EDGE_CYCLE, edge("opr_3", "opr_3")),
  refuses("an edge back along an existing one, which is a cycle of two", EDGE_CYCLE, edge("opr_2", "opr_3")),
  following(
    [edge("opr_4", "opr_3")],
    refuses("an edge that closes a cycle of three", EDGE_CYCLE, edge("opr_2", "opr_4")),
    accepts("an edge that joins two chains without closing a cycle", edge("opr_1", "opr_4")),
  ),
  following(
    [edge("opr_2", "opr_1"), edge("opr_1", "opr_4")],
    refuses("an edge that closes a cycle of four", EDGE_CYCLE, edge("opr_4", "opr_3")),
  ),
  refuses(
    "the same edge twice",
    primaryKey("operation_dependencies.operation_id", "operation_dependencies.depends_on_id"),
    edge("opr_3", "opr_2"),
  ),
  refuses("an edge to an operation that does not exist", FOREIGN_KEY, edge("opr_3", "opr_nowhere")),
  refuses("an edge from an operation that does not exist", FOREIGN_KEY, edge("opr_nowhere", "opr_2")),
  refuses(
    "another target for an edge",
    EDGE_NEVER_CHANGED,
    sql("UPDATE operation_dependencies SET depends_on_id = 'opr_1' WHERE operation_id = 'opr_3'"),
  ),
  refuses(
    "an edge given to another operation",
    EDGE_NEVER_CHANGED,
    sql("UPDATE operation_dependencies SET operation_id = 'opr_1' WHERE operation_id = 'opr_3'"),
  ),
  refuses(
    "an edge written back as it is",
    EDGE_NEVER_CHANGED,
    sql("UPDATE operation_dependencies SET depends_on_id = depends_on_id WHERE operation_id = 'opr_3'"),
  ),
  accepts(
    "removing an edge of an operation that is not decided",
    sql("DELETE FROM operation_dependencies WHERE operation_id = 'opr_3'"),
  ),
  following(
    [COMMIT, apply("opr_1", "auto", T2), propose("opr_2"), propose("opr_3"), propose("opr_4")],
    refuses("an edge added to an applied operation", EDGE_HISTORY, edge("opr_1", "opr_4")),
    accepts("an edge added to a proposed operation", edge("opr_4", "opr_1")),
    accepts(
      "an edge of a proposed operation removed",
      sql("DELETE FROM operation_dependencies WHERE operation_id = 'opr_3'"),
    ),
  ),
  following(
    [COMMIT, propose("opr_2"), propose("opr_3"), reject("opr_3")],
    refuses("an edge added to a rejected operation", EDGE_HISTORY, edge("opr_3", "opr_1")),
    refuses(
      "an edge of a rejected operation removed",
      EDGE_HISTORY,
      sql("DELETE FROM operation_dependencies WHERE operation_id = 'opr_3'"),
    ),
  ),
  following(
    [COMMIT, apply("opr_2", "auto", T2), apply("opr_3", "auto", T2)],
    refuses(
      "an edge of an applied operation removed",
      EDGE_HISTORY,
      sql("DELETE FROM operation_dependencies WHERE operation_id = 'opr_3'"),
    ),
  ),
  following(
    [COMMIT, apply("opr_2", "auto", T2), apply("opr_3", "auto", T2), UNDO, undo("opr_3")],
    refuses("an edge added to an undone operation", EDGE_HISTORY, edge("opr_3", "opr_1")),
    refuses(
      "an edge of an undone operation removed",
      EDGE_HISTORY,
      sql("DELETE FROM operation_dependencies WHERE operation_id = 'opr_3'"),
    ),
  ),
]);

// ---------------------------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------------------------

const SCRUB_EFFECTS = sql(
  "UPDATE operation_effects SET scrubbed = 1, before_value = NULL, after_value = NULL WHERE id = 1",
);
const changeEffect = (set: Row) => update("operation_effects", 1, set);
/** The one change an effect allows, together with another one. */
const scrubAnd = (more: Row) => changeEffect({ scrubbed: 1, before_value: null, after_value: null, ...more });

// What an applied operation did, row by row and field by field. Effects belong to applied
// operations and are append-only: an effect can lose its values and nothing else.
scene(
  "an effect",
  [...DECIDED, operation("opr_21", { run_id: "run_2", seq: 1 })],
  [
    accepts("the creation of a row, with the row", FACT_EFFECT),
    accepts("the change of one field, with the value before and after", STATUS_EFFECT),
    accepts(
      "the deletion of a row, with the row",
      effect("opr_1", { change: "delete", before_value: '{"id":"itm_p1"}' }),
    ),
    accepts("a touch: the operation concerned the row without changing it", ROLE_EFFECT),
    accepts(
      "an effect that names no item and no person",
      effect("opr_1", { entity_kind: "person", entity_id: "per_x" }),
    ),
    accepts(
      "an effect about a person",
      effect("opr_2", {
        entity_kind: "person",
        entity_id: "per_magda",
        change: "create",
        person_id: "per_magda",
        after_value: "{}",
      }),
    ),
    // JSON null says that the column was NULL; SQL NULL says that there is no value.
    accepts(
      "a field that was NULL before",
      effect("opr_4", { change: "update", field: "due_on", before_value: "null", after_value: '"2026-10-16"' }),
    ),
    accepts(
      "the event date of a capture, changed by an operation",
      effect("opr_1", {
        entity_kind: "capture",
        entity_id: "cap_c1",
        change: "update",
        field: "occurred_on",
        before_value: '"2026-10-12"',
        after_value: '"2026-10-09"',
      }),
    ),

    refuses(
      "an update without a field",
      check("(change = 'update') = (field IS NOT NULL)"),
      effect("opr_1", { change: "update", before_value: "1", after_value: "2" }),
    ),
    refuses(
      "a field on what is not an update",
      check("(change = 'update') = (field IS NOT NULL)"),
      effect("opr_1", { change: "create", field: "status", after_value: "1" }),
    ),
    refuses(
      "an empty field",
      check("field <> ''"),
      effect("opr_1", { change: "update", field: "", before_value: "1", after_value: "2" }),
    ),
    refuses(
      "a creation with a value before",
      check("change NOT IN ('create', 'touch') OR before_value IS NULL"),
      effect("opr_1", { change: "create", before_value: "{}", after_value: "{}" }),
    ),
    refuses(
      "a touch with a value before",
      check("change NOT IN ('create', 'touch') OR before_value IS NULL"),
      effect("opr_1", { before_value: "1" }),
    ),
    refuses(
      "a deletion with a value after",
      check("change NOT IN ('delete', 'touch') OR after_value IS NULL"),
      effect("opr_1", { change: "delete", before_value: "{}", after_value: "{}" }),
    ),
    refuses(
      "a touch with a value after",
      check("change NOT IN ('delete', 'touch') OR after_value IS NULL"),
      effect("opr_1", { after_value: "1" }),
    ),
    refuses(
      "a deletion without the row",
      check("scrubbed = 1 OR change NOT IN ('update', 'delete') OR before_value IS NOT NULL"),
      effect("opr_1", { change: "delete" }),
    ),
    refuses(
      "an update without the value before",
      check("scrubbed = 1 OR change NOT IN ('update', 'delete') OR before_value IS NOT NULL"),
      effect("opr_1", { change: "update", field: "status", after_value: '"done"' }),
    ),
    refuses(
      "a creation without the row",
      check("scrubbed = 1 OR change NOT IN ('update', 'create') OR after_value IS NOT NULL"),
      effect("opr_1", { change: "create" }),
    ),
    refuses(
      "an update without the value after",
      check("scrubbed = 1 OR change NOT IN ('update', 'create') OR after_value IS NOT NULL"),
      effect("opr_1", { change: "update", field: "status", before_value: '"todo"' }),
    ),
    refuses(
      "a change outside the four",
      check("change IN ('create', 'update', 'delete', 'touch')"),
      effect("opr_1", { change: "move" }),
    ),
    refuses(
      "a value before that is not JSON",
      jsonOrNull("before_value"),
      effect("opr_1", { change: "update", field: "status", before_value: "todo", after_value: '"done"' }),
    ),
    refuses(
      "a value after that is not JSON",
      jsonOrNull("after_value"),
      effect("opr_1", { change: "update", field: "status", before_value: '"todo"', after_value: "done" }),
    ),
    refuses(
      "a kind of entity that is not a lower-case identifier",
      identifier("entity_kind"),
      effect("opr_1", { entity_kind: "Item Person" }),
    ),
    refuses("an empty key of the entity", check("entity_id <> ''"), effect("opr_1", { entity_id: "" })),
    refuses("a scrub mark that is neither 0 nor 1", check("scrubbed IN (0, 1)"), effect("opr_1", { scrubbed: 2 })),
    // The item and the person an effect is about are held to the shape of the ids they name. No
    // foreign key holds them: an anchor that is not the id, by one character, would move no last
    // activity and be found by no timeline, and nothing would say so.
    refuses(
      "the id of a person where the item belongs",
      anchorOf("item_id", "itm"),
      effect("opr_1", { item_id: "per_piotr" }),
    ),
    refuses("a name where the item belongs", anchorOf("item_id", "itm"), effect("opr_1", { item_id: "Atlas" })),
    refuses(
      "the prefix of an item alone where the item belongs",
      anchorOf("item_id", "itm"),
      effect("opr_1", { item_id: "itm_" }),
    ),
    refuses(
      "the id of an item with a space behind it where the item belongs",
      anchorOf("item_id", "itm"),
      effect("opr_1", { item_id: "itm_p1 " }),
    ),
    refuses(
      "the id of an item in upper case where the item belongs",
      anchorOf("item_id", "itm"),
      effect("opr_1", { item_id: "itm_P1" }),
    ),
    refuses(
      "the id of an item with a NUL character where the item belongs",
      anchorOf("item_id", "itm"),
      effect("opr_1", { item_id: `itm_p1${NUL}x` }),
    ),
    refuses(
      "the id of an item where the person belongs",
      anchorOf("person_id", "per"),
      effect("opr_1", { person_id: "itm_p1" }),
    ),
    refuses(
      "a name behind the prefix where the person belongs",
      anchorOf("person_id", "per"),
      effect("opr_1", { person_id: "per_Anna Kowalska" }),
    ),
    refuses(
      "the id of a person with a line end behind it where the person belongs",
      anchorOf("person_id", "per"),
      effect("opr_1", { person_id: "per_piotr\n" }),
    ),
    refuses(
      "the id of a person with a NUL character where the person belongs",
      anchorOf("person_id", "per"),
      effect("opr_1", { person_id: `per_piotr${NUL}x` }),
    ),
    refuses(
      "a kind of entity with a NUL character",
      identifier("entity_kind"),
      effect("opr_1", { entity_kind: `item${NUL}x` }),
    ),
    refuses(
      "a value before with a NUL character and more behind the JSON",
      jsonOrNull("before_value"),
      effect("opr_1", { change: "update", field: "status", before_value: `"todo"${NUL}x`, after_value: '"done"' }),
    ),
    refuses(
      "a value after with a NUL character and more behind the JSON",
      jsonOrNull("after_value"),
      effect("opr_1", { change: "update", field: "status", before_value: '"todo"', after_value: `"done"${NUL}x` }),
    ),

    // Effects belong to applied operations.
    refuses("an effect of an operation that is staged", EFFECTS_ONLY_APPLIED, effect("opr_21")),
    refuses("an effect of an operation that does not exist", EFFECTS_ONLY_APPLIED, effect("opr_nowhere")),

    // The id is the order of all changes: 1, 2, 3 and so on. A new effect takes the next number.
    // One at the last number there is would leave none for the effects after it.
    refuses("an id below 0", check("id > 0"), effect("opr_1", { id: -5 })),
    refuses("the id 0", check("id > 0"), effect("opr_1", { id: 0 })),
    accepts("the id 1 for the first effect, given by the statement", effect("opr_1", { id: 1 })),
    refuses("the id 2 for the first effect", EFFECTS_IN_ORDER, effect("opr_1", { id: 2 })),
    following(
      [STATUS_EFFECT],
      refuses("an id that an effect has already", EFFECTS_APPEND_ONLY, effect("opr_1", { id: 1 })),
      accepts("the next id, given by the database", effect("opr_1")),
      accepts("the next id, given by the statement", effect("opr_1", { id: 2 })),
      refuses("an id that leaves one out", EFFECTS_IN_ORDER, effect("opr_1", { id: 3 })),
      refuses("an id far ahead of the newest", EFFECTS_IN_ORDER, effect("opr_1", { id: 9_000_000 })),
      refuses("the last id there is", EFFECTS_IN_ORDER, effect("opr_1", { id: 9_223_372_036_854_775_807n })),
    ),
    following(
      [STATUS_EFFECT, FACT_EFFECT],
      refuses("the id 1 again, below the newest", EFFECTS_APPEND_ONLY, effect("opr_1", { id: 1 })),
    ),

    // An effect can lose its values and nothing else.
    following(
      [STATUS_EFFECT],
      refuses("another value", EFFECTS_ONLY_SCRUBBED, changeEffect({ after_value: '"done"' })),
      refuses("another item", EFFECTS_ONLY_SCRUBBED, changeEffect({ item_id: "itm_p2" })),
      refuses("another scrub mark alone", EFFECTS_ONLY_SCRUBBED, changeEffect({ scrubbed: 1 })),
      refuses(
        "the scrub mark with the value after left",
        EFFECTS_ONLY_SCRUBBED,
        changeEffect({ scrubbed: 1, before_value: null }),
      ),
      refuses(
        "the scrub mark with the value before left",
        EFFECTS_ONLY_SCRUBBED,
        changeEffect({ scrubbed: 1, after_value: null }),
      ),
      refuses(
        "the values removed without the scrub mark",
        EFFECTS_ONLY_SCRUBBED,
        changeEffect({ before_value: null, after_value: null }),
      ),
      refuses(
        "a row written back as it is",
        EFFECTS_ONLY_SCRUBBED,
        sql("UPDATE operation_effects SET field = field WHERE id = 1"),
      ),
      accepts("the scrub mark, with both values removed", SCRUB_EFFECTS),
      // A scrub removes the values and leaves everything that says what the effect was about.
      refuses("a scrub that gives another item", EFFECTS_ONLY_SCRUBBED, scrubAnd({ item_id: "itm_p2" })),
      refuses("a scrub that adds a person", EFFECTS_ONLY_SCRUBBED, scrubAnd({ person_id: "per_piotr" })),
      refuses("a scrub that gives another operation", EFFECTS_ONLY_SCRUBBED, scrubAnd({ operation_id: "opr_1" })),
      refuses("a scrub that gives another kind of entity", EFFECTS_ONLY_SCRUBBED, scrubAnd({ entity_kind: "fact" })),
      refuses("a scrub that gives another entity", EFFECTS_ONLY_SCRUBBED, scrubAnd({ entity_id: "itm_p2" })),
      refuses("a scrub that gives another field", EFFECTS_ONLY_SCRUBBED, scrubAnd({ field: "health" })),
      refuses("a scrub that gives another change", EFFECTS_ONLY_SCRUBBED, scrubAnd({ change: "delete" })),
      refuses("a scrub that gives another id", EFFECTS_ONLY_SCRUBBED, scrubAnd({ id: 7 })),
      refuses("deleting it", EFFECTS_APPEND_ONLY, sql("DELETE FROM operation_effects WHERE id = 1")),
    ),
    following(
      [STATUS_EFFECT, SCRUB_EFFECTS],
      accepts("a scrubbed effect scrubbed again", SCRUB_EFFECTS),
      refuses("the scrub mark taken back", EFFECTS_ONLY_SCRUBBED, changeEffect({ scrubbed: 0 })),
      refuses(
        "a value put back into a scrubbed effect",
        EFFECTS_ONLY_SCRUBBED,
        changeEffect({ after_value: '"blocked"' }),
      ),
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// Undo, and the last activity of an item
// ---------------------------------------------------------------------------------------------

// An undo is itself an entry of the journal. It takes applied operations back, dependants
// first; what was undone is not applied again, and an undo is not undone.
scene(
  "an undo",
  [...EFFECTS, UNDO],
  [
    accepts("a second undo, recorded like any operation made by hand", anUndo("opr_u2")),
    accepts("the effect of an undo, which is the inverse of what it takes back", effect("opr_u1", { change: "touch" })),
    accepts("an operation taken back by it", undo("opr_3")),
    refuses(
      "an operation marked undone without the undo that did it",
      TRANSITION,
      update("operations", "opr_3", { state: "undone" }),
    ),
    refuses("an operation undone by itself", TRANSITION, undo("opr_3", "opr_3")),
    refuses("an operation undone by one that is no undo", TRANSITION, undo("opr_3", "opr_1")),
    refuses("an operation undone by one that does not exist", TRANSITION, undo("opr_3", "opr_nowhere")),
    refuses("what another operation needed undone while that one is still applied", DEPENDENCY_ORDER, undo("opr_2")),
    following(
      [undo("opr_3")],
      accepts("what the undone operation needed undone after it", undo("opr_2")),
      refuses("an undone operation applied again", TRANSITION, update("operations", "opr_3", { state: "applied" })),
      refuses("an undone operation proposed again", TRANSITION, update("operations", "opr_3", { state: "proposed" })),
      refuses("an effect of an undone operation", EFFECTS_ONLY_APPLIED, effect("opr_3")),
      refuses("deleting an undone operation", OPERATION_DELETE, remove("operations", "opr_3")),
      refuses(
        "another payload for an undone operation",
        OPERATION_HISTORY,
        update("operations", "opr_3", { payload: '{"x":1}' }),
      ),
    ),
    following(
      [undo("opr_3"), anUndo("opr_u2")],
      refuses(
        "an undone operation pointed at another undo",
        OPERATION_HISTORY,
        update("operations", "opr_3", { undone_by_id: "opr_u2" }),
      ),
    ),
    following([anUndo("opr_u2")], refuses("an undo taken back by another undo", TRANSITION, undo("opr_u1", "opr_u2"))),
    refuses("deleting an undo", OPERATION_DELETE, remove("operations", "opr_u1")),

    // Only an undo that is itself in the journal takes anything back.
    following(
      [operation("opr_21", { run_id: "run_2", seq: 1, kind: "undo" })],
      refuses("an operation undone by an undo that is only staged", TRANSITION, undo("opr_3", "opr_21")),
    ),
    following(
      [
        operation("opr_21", { run_id: "run_2", seq: 1, kind: "undo" }),
        update("runs", "run_2", { state: "committed", ended_at: T3 }),
        propose("opr_21"),
      ],
      refuses("an operation undone by an undo that is only proposed", TRANSITION, undo("opr_3", "opr_21")),
    ),
    // What was undone is not in force, and nothing that needs it is applied.
    following(
      [
        operation("opr_21", { run_id: "run_2", seq: 1 }),
        update("runs", "run_2", { state: "committed", ended_at: T3 }),
        propose("opr_21"),
        undo("opr_1"),
        edge("opr_21", "opr_1"),
      ],
      refuses("applying an operation that needs one that was undone", DEPENDENCY_ORDER, accept("opr_21")),
      accepts("rejecting an operation that needs one that was undone", reject("opr_21")),
    ),
  ],
);

describe("a dependency between operations", () => {
  // The walk that looks for a cycle has no depth at which it gives up.
  it("is refused when it closes a cycle of forty operations", () => {
    const ids = Array.from({ length: 40 }, (_, index) => `opr_c${String(index).padStart(2, "0")}`);
    const db = given(
      ...WORK,
      ...ids.map((id, index) => operation(id, { run_id: "run_2", seq: index })),
      ...ids.slice(1).map((id, index) => edge(ids[index] as string, id)),
    );

    expect(attempt(db, edge(ids.at(-1) as string, ids[0] as string))).toEqual(EDGE_CYCLE);
    expect(attempt(db, edge(ids[0] as string, ids.at(-1) as string))).toBe(ACCEPTED);
  });
});

// The instant of the newest operation in force that concerned the item itself. An operation
// concerns an item when one of its effects names the item. "In force" leaves out operations
// that were undone and the undo itself. The value never comes from the clock.
describe("the last activity of an item", () => {
  const activity = (db: Connection, id = "itm_p1") =>
    db.prepare("SELECT last_activity_at FROM items WHERE id = ?").pluck().get(id);
  const write = (db: Connection, ...statements: Statement[]) => {
    for (const statement of statements) expect(attempt(db, statement), statement.sql).toBe(ACCEPTED);
  };

  it("is the creation of the item until an operation concerns it", () => {
    const db = given(...DECIDED);

    expect(activity(db)).toBe(T);
  });

  it("becomes the time at which an operation that concerns the item was applied", () => {
    const db = given(...DECIDED);

    write(db, FACT_EFFECT);
    expect(activity(db)).toBe(T2);

    write(db, ROLE_EFFECT);
    expect(activity(db)).toBe(T3);
  });

  it("does not go back when an operation that was applied earlier gets an effect later", () => {
    const db = given(...DECIDED, ROLE_EFFECT);

    write(db, FACT_EFFECT, STATUS_EFFECT);

    expect(activity(db)).toBe(T3);
  });

  it("is moved only for the item that the effect names", () => {
    const db = given(...DECIDED);

    write(db, effect("opr_3", { entity_kind: "person", entity_id: "per_x" }), effect("opr_3", { item_id: "itm_p2" }));

    expect(activity(db, "itm_p1")).toBe(T);
    expect(activity(db, "itm_p2")).toBe(T3);
  });

  it("is not moved by an undo, which is no activity of its own", () => {
    const db = given(...EFFECTS, UNDO);

    write(db, effect("opr_u1", { entity_kind: "item_person", entity_id: "itp_2", item_id: "itm_p1" }));

    expect(activity(db)).toBe(T3);
  });

  it("goes back to the newest operation that is still in force when the newest one is undone", () => {
    // The undo has written its own effect on the item, the inverse of what it takes back.
    const inverse = effect("opr_u1", {
      entity_kind: "item_person",
      entity_id: "itp_2",
      change: "delete",
      item_id: "itm_p1",
      before_value: "{}",
    });
    const db = given(...EFFECTS, UNDO, inverse);
    expect(activity(db)).toBe(T3);

    write(db, undo("opr_3"));

    // The fact and the command, both applied at the second instant, are what is left.
    expect(activity(db)).toBe(T2);
  });

  it("goes back to the creation when the only operation that concerned the item is undone", () => {
    const db = given(...DECIDED, ROLE_EFFECT, UNDO);
    expect(activity(db)).toBe(T3);

    write(db, undo("opr_3"));

    expect(activity(db)).toBe(T);
  });

  it("stays when the operation that is undone was not the newest", () => {
    const db = given(...EFFECTS, UNDO);

    write(db, undo("opr_1"));

    expect(activity(db)).toBe(T3);
  });

  it("stays also when the effect of the newest operation was not the last one written", () => {
    // The role was applied last and its effect was written first.
    const db = given(...DECIDED, ROLE_EFFECT, FACT_EFFECT, STATUS_EFFECT, UNDO);

    write(db, undo("opr_4"));

    expect(activity(db)).toBe(T3);
  });
  it("goes back to the newest of the operations still in force, not to the oldest", () => {
    const later = manual("opr_m1", { applied_at: T4 });
    const db = given(
      ...DECIDED,
      FACT_EFFECT,
      ROLE_EFFECT,
      later,
      effect("opr_m1", { item_id: "itm_p1" }),
      anUndo("opr_u1"),
    );
    expect(activity(db)).toBe(T4);

    write(db, undo("opr_m1"));

    // The fact was applied at the second instant and the role at the third.
    expect(activity(db)).toBe(T3);
  });

  it("stays for an item that the undone operation did not concern", () => {
    // The second project was concerned by the role, applied at the third instant, and then by an
    // effect of the fact, which was applied before. A later operation on the first project is undone.
    const db = given(
      ...DECIDED,
      effect("opr_3", { item_id: "itm_p2" }),
      effect("opr_1", { item_id: "itm_p2" }),
      manual("opr_m1", { applied_at: T4 }),
      effect("opr_m1", { item_id: "itm_p1" }),
      anUndo("opr_u1"),
    );

    write(db, undo("opr_m1"));

    expect(activity(db, "itm_p2")).toBe(T3);
  });

  it("goes back past an effect whose values were removed: the effect still says that the item was concerned", () => {
    const db = given(...EFFECTS, SCRUB_EFFECTS, UNDO);

    write(db, undo("opr_3"));

    expect(activity(db)).toBe(T2);
  });

  // The date is the item's own, wherever the item sits: nothing is moved for what is above or under it.
  it("is kept for a task under a task as for a project, and for no item above or under it", () => {
    const db = given(
      ...DECIDED,
      item("itm_t10", "task", "itm_p1"),
      item("itm_s20", "task", "itm_t10"),
      item("itm_d30", "task", "itm_s20"),
      manual("opr_m1", { applied_at: T4 }),
      anUndo("opr_u1"),
    );
    const around = () => ["itm_p1", "itm_t10", "itm_d30"].map((id) => activity(db, id));

    write(db, effect("opr_m1", { entity_id: "itm_s20", item_id: "itm_s20" }));
    expect(activity(db, "itm_s20")).toBe(T4);
    expect(around()).toEqual([T, T, T]);

    write(db, undo("opr_m1"));
    expect(activity(db, "itm_s20")).toBe(T);
    expect(around()).toEqual([T, T, T]);
  });

  it("does not go back before the creation of the item when the operation left in force was applied earlier", () => {
    // The clock stepped back between the operation and the insert of the item it concerned.
    const before = "2026-10-12T07:59:59.990Z";
    const db = given(
      ...DECIDED,
      manual("opr_m0", { kind: "create_item", created_at: before, applied_at: before }),
      effect("opr_m0", { change: "create", item_id: "itm_p1", after_value: '{"id":"itm_p1"}' }),
      manual("opr_m1", { applied_at: T4 }),
      effect("opr_m1", { item_id: "itm_p1" }),
      anUndo("opr_u1"),
    );
    expect(activity(db)).toBe(T4);

    write(db, undo("opr_m1"));

    expect(activity(db)).toBe(T);
  });
});

// ---------------------------------------------------------------------------------------------
// Statements that write over a row, or step around it
// ---------------------------------------------------------------------------------------------

// The replacing form of INSERT removes the old row without firing the triggers for UPDATE and
// DELETE. So every table whose rows must not change also refuses an INSERT over an existing key,
// by any of its unique keys. The same triggers refuse the forms that would silently skip the
// row: a save that may run twice looks first whether the row is there.
const WRITTEN = [
  ...ITEMS,
  ...CAPTURE,
  TRANSCRIPT,
  fact("fct_1"),
  runningJob("job_1"),
  run("run_1"),
  manual("opr_m1"),
  effect("opr_m1"),
];
const OVER_A_ROW: [what: string, sentence: Refusal, again: Statement][] = [
  ["a source", SOURCE_TAKEN, source("cap_c1", { created_at: T2 })],
  ["a part", PART_NEVER_EDITED, part("prt_1", "cap_c1", 0, "typed", { text: "inne" })],
  ["a revision of derived text", REVISION_NEVER_EDITED, partText("ptx_1", "prt_2", 1, { text: "inne" })],
  ["a fact", FACT_NEVER_EDITED, fact("fct_1", { text: "Podmieniony" })],
  ["a run", RUN_TAKEN, run("run_1")],
  ["an operation", OPERATION_TAKEN, manual("opr_m1")],
  ["an effect", EFFECTS_APPEND_ONLY, effect("opr_m1", { id: 1 })],
];

scene("a statement that writes over a row", WRITTEN, [
  ...OVER_A_ROW.flatMap(([what, sentence, again]) => [
    refuses(`a replacing INSERT over ${what}`, sentence, replacing(again)),
    refuses(`an ignoring INSERT over ${what}`, sentence, ignoring(again)),
    refuses(`an INSERT over ${what} that does nothing on a conflict`, sentence, onConflict(again, "DO NOTHING")),
  ]),
  // Through the other unique keys of the same tables, with an id that is new.
  refuses(
    "a replacing INSERT of a new part at a position that is taken",
    PART_NEVER_EDITED,
    replacing(part("prt_9", "cap_c1", 1, "pasted", { text: "PODMIENIONY TEKST" })),
  ),
  refuses(
    "a replacing INSERT of a new typed part beside the one that is there",
    PART_NEVER_EDITED,
    replacing(part("prt_9", "cap_c1", 7, "typed", { text: "usuń wszystko" })),
  ),
  refuses(
    "a replacing INSERT of a new revision with a number that is taken",
    REVISION_NEVER_EDITED,
    replacing(partText("ptx_9", "prt_2", 1, { origin: "correction", text: "zupełnie inny tekst" })),
  ),
  refuses("a replacing INSERT of a second run in progress for a job", RUN_TAKEN, replacing(run("run_9"))),
  following(
    [update("runs", "run_1", { state: "committed", ended_at: T2 })],
    // It would put a committed run back to running, or remove it to make room for another.
    refuses("a replacing INSERT that puts a committed run back to running", RUN_TAKEN, replacing(run("run_1"))),
    refuses(
      "a replacing INSERT of a second committed run of a job",
      RUN_TAKEN,
      replacing(run("run_9", { state: "committed", ended_at: T3 })),
    ),
  ),
  // An upsert reaches the row through UPDATE, where the other guards stand.
  refuses(
    "an upsert that rewrites a fact",
    FACT_NEVER_EDITED,
    onConflict(fact("fct_1"), "(id) DO UPDATE SET text = 'zmieniony'"),
  ),
  refuses(
    "an upsert that closes an item without its closing time",
    CLOSED_AT,
    onConflict(item("itm_p1", "project"), "(id) DO UPDATE SET status = 'done'"),
  ),
]);

describe("a statement that writes over a row", () => {
  it("leaves every row as it was when it is refused", () => {
    const db = given(...WRITTEN);
    const tables = [
      "sources",
      "capture_parts",
      "capture_part_texts",
      "facts",
      "runs",
      "operations",
      "operation_effects",
    ];
    const dump = () => tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    const before = dump();

    for (const [, sentence, again] of OVER_A_ROW) {
      expect(attempt(db, replacing(again))).toEqual(sentence);
      expect(attempt(db, ignoring(again))).toEqual(sentence);
    }

    expect(dump()).toEqual(before);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// What the database leaves to the code
// ---------------------------------------------------------------------------------------------

// Statements that the database accepts although nothing good comes of them. Each is known, and
// each is held somewhere else. They are here so that the limit of the guards is written down:
// a case that turns red says that a guard was added, and that its rule can leave the code.
scene(
  "a statement that no guard stops",
  [...WRITTEN, ...PERSONS],
  [
    // No statement of the application uses the replacing form: a search of the sources holds that.
    accepts(
      "a replacing INSERT over an item",
      replacing(
        item("itm_p2", "project", null, {
          title: "Inny tytuł",
          created_at: "2020-01-01T00:00:00.000Z",
          last_activity_at: "2020-01-01T00:00:00.000Z",
        }),
      ),
    ),
    accepts("a replacing INSERT over a person", replacing(person("per_piotr", "Ktoś Inny"))),
    accepts("a replacing INSERT over a job that is being worked on", replacing(job("job_1"))),
    // The one statement that gives a stored file another media type.
    accepts("a replacing INSERT over a file", replacing(file(SHA, { media_type: "text/html", byte_size: 1 }))),
    accepts(
      "a replacing INSERT over a capture",
      replacing(capture("cap_c1", { occurred_on: "2020-01-01", occurred_on_approximate: 0 })),
    ),
    accepts(
      "a replacing INSERT over a word that rows use",
      replacing(insert("item_statuses", { code: "todo", position: 9, is_closed: 1 })),
    ),
    // An operation is kept from being replaced under its id. Under its position in the run it is
    // not: what goes is an operation that its run has only staged, which may be deleted as well.
    following(
      [staged("opr_1", 1)],
      accepts(
        "a replacing INSERT of an operation at the position of one that its run has staged",
        replacing(staged("opr_9", 1)),
      ),
    ),
    // The replacing form of UPDATE removes the row that stands in the way: here the owner the item had.
    following(
      [itemPerson("itp_1", "itm_p1", "per_piotr", "owner"), itemPerson("itp_2", "itm_p1", "per_anna", "stakeholder")],
      accepts(
        "a replacing UPDATE that makes a second person the owner of an item",
        replacing(update("item_persons", "itp_2", { role: "owner" })),
      ),
    ),

    // Readers follow the successor of a fact one step and never walk a chain.
    following(
      [fact("fct_2"), update("facts", "fct_1", { outdated_at: T2, superseded_by_fact_id: "fct_2" })],
      accepts(
        "two facts that replace each other",
        update("facts", "fct_2", { outdated_at: T2, superseded_by_fact_id: "fct_1" }),
      ),
    ),
    // Adding a fact is undone by deleting it, so a fact can be deleted, and nothing remembers the
    // id it had. The application gives every fact a new id.
    following(
      [remove("facts", "fct_1")],
      accepts(
        "a fact deleted and written again under its id, with another statement",
        fact("fct_1", { type: "decision", text: "Zupełnie co innego" }),
      ),
    ),
    following(
      [MARK_DELETED],
      accepts("a new fact with a quote from a source that is marked deleted", fact("fct_2")),
      accepts("a mention in a source that is marked deleted", mention("mnt_9")),
      accepts("a job for a source that is marked deleted", job("job_9")),
    ),
    // A source that is deleted for good takes no new part. The id that a part of it had is free
    // again for any other capture: the application gives every part a new id.
    following(
      [...EMPTY_CAPTURE, MARK_DELETED, remove("capture_parts", "prt_1")],
      accepts(
        "the id of a part that was deleted for good, used again in another capture",
        part("prt_1", "cap_c2", 0, "typed", { text: "zupełnie co innego" }),
      ),
    ),
    // The row of a capture holds no content, and nothing keeps it from being written again after
    // the content is gone, with another event date. It takes no part: its source stays marked.
    following(
      [...CONTENT_GONE, remove("captures", "cap_c1")],
      accepts(
        "a capture written again for a source that is marked deleted",
        capture("cap_c1", { occurred_on: "2020-01-01", occurred_on_approximate: 0 }),
      ),
    ),

    // The parts of a capture are saved with it, in one transaction. To the database a part that
    // comes later is a part like any other, and so is a revision.
    accepts(
      "a part added to a capture after it was saved",
      part("prt_9", "cap_c1", 2, "pasted", { text: "dopisane później" }),
    ),
    following(
      [partText("ptx_5", "prt_2", 5)],
      accepts("a revision with a number below the newest", partText("ptx_3", "prt_2", 3)),
    ),
    accepts("derived text for a part that is text itself", partText("ptx_9", "prt_1", 1)),

    // No rule compares two instants of a row with each other, apart from the last activity: a
    // clock that stepped back would make a change that is in order fail.
    accepts(
      "a closing time before the creation of the item",
      update("items", "itm_t11", { status: "done", closed_at: "2026-10-11T08:00:00.000Z" }),
    ),
    following(
      [CLOSE],
      accepts("the closing time of a closed item moved", update("items", "itm_t11", { closed_at: T4 })),
    ),
    accepts(
      "a mark of deletion before the date of adding",
      update("sources", "cap_c1", { deleted_at: "2026-10-11T08:00:00.000Z" }),
    ),
    following(
      [anUndo("opr_u1"), manual("opr_m2", { applied_at: "2026-10-14T08:00:00.000Z" })],
      accepts("an operation undone by an undo that was applied before it", undo("opr_m2")),
    ),
    // Only the triggers write it after the insert. A statement of its own is not stopped.
    accepts("the last activity of an item written by hand", update("items", "itm_p1", { last_activity_at: T4 })),

    // The framework writes the effects of an operation in the transaction that applies it.
    accepts("an effect added long after its operation was applied", effect("opr_m1", { change: "touch" })),
    // The scrub empties the payload. The database sees that it changes once, with the mark, and
    // not what it changes to.
    accepts(
      "the payload of a decided operation replaced by another object together with the scrub mark",
      update("operations", "opr_m1", { payload: '{"anything":"else"}', scrubbed_at: T3 }),
    ),

    // A merged row takes no new rows. Its own fields, and the rows that stayed on it, are held by
    // the application, which looks whether a row was merged before it changes it.
    following(
      [description("ide_2", "itm_p2"), mergeItem("itm_p2", "itm_p1"), mergePerson("per_piotr", "per_anna")],
      accepts(
        "the fields of a merged item changed",
        update("items", "itm_p2", {
          title: "Inny tytuł",
          title_norm: "inny tytul",
          importance: "high",
          due_on: "2026-11-01",
        }),
      ),
      accepts(
        "a new body for the description of a merged item",
        update("item_descriptions", "ide_2", { body: '{"type":"doc"}', updated_at: T2 }),
      ),
      accepts(
        "the fields of a merged person changed",
        update("persons", "per_piotr", { name: "Ktoś Inny", name_norm: "ktos inny", team: "Płatności" }),
      ),
      accepts(
        "an effect that names a merged item, which moves the last activity of that item",
        effect("opr_m1", { item_id: "itm_p2" }),
      ),
    ),
    // The health is one of those fields, of a task as of a project.
    following(
      [mergeItem("itm_s21", "itm_s20")],
      accepts("a health given to a merged task", update("items", "itm_s21", { health: "red" })),
    ),
    // A merged row stays as the signpost to its survivor because the application leaves it there.
    // To the database it is a row that nothing points at, and such a row can be deleted.
    following(
      [mergeItem("itm_p2", "itm_p1"), person("per_dup", "A. Kowalska", { merged_into_id: "per_anna" })],
      accepts("deleting a merged item that nothing points at", remove("items", "itm_p2")),
      accepts("deleting a merged person whom nothing points at", remove("persons", "per_dup")),
    ),

    // The database keeps the id of a source, a part, a revision, a fact, an item, a person, a run,
    // an operation and an effect. The id of any other row is a column like the others to it, and
    // an effect that names such a row would name nothing afterwards. The application gives an id
    // once and never writes it again.
    following(
      [
        ...EMPTY_CAPTURE,
        source("cap_c5"),
        personAlias("pal_1", "per_anna", "Ania"),
        description("ide_1", "itm_p1"),
        itemAlias("ial_1", "itm_p1", "ATL"),
        itemPerson("itp_1", "itm_p1", "per_anna", "owner"),
        mention("mnt_1"),
        factPerson("fcp_1", "fct_1", "per_anna"),
        link("lnk_1", "cap_c1", "itm_p1"),
        job("job_2"),
        modelCall(),
      ],
      ...(
        [
          ["a capture, to that of another registry row", "captures", "cap_c2", "cap_c5"],
          ["an alias of a person", "person_aliases", "pal_1", "pal_9"],
          ["a description", "item_descriptions", "ide_1", "ide_9"],
          ["an alias of an item", "item_aliases", "ial_1", "ial_9"],
          ["the role of a person in an item", "item_persons", "itp_1", "itp_9"],
          ["a mention", "mentions", "mnt_1", "mnt_9"],
          ["a person of a fact", "fact_persons", "fcp_1", "fcp_9"],
          ["a link", "source_links", "lnk_1", "lnk_9"],
          ["a job", "queue_jobs", "job_2", "job_9"],
          ["a model call", "model_calls", 1, 9],
        ] as const
      ).map(([what, table, from, to]) => accepts(`another id for ${what}`, update(table, from, { id: to }))),
    ),

    // A migration that changes which statuses are closed fixes the closing times in the same step.
    accepts(
      "an open status declared closed while open items have it",
      sql("UPDATE item_statuses SET is_closed = 1 WHERE code = 'todo'"),
    ),
    // The words that triggers and indexes spell out stay as they are: a migration that retires
    // one of them recreates what names it. A foreign key holds a word only while a row has it.
    accepts(
      "a state that triggers and an index name, renamed while no row has it",
      sql("UPDATE run_states SET code = 'finished' WHERE code = 'committed'"),
    ),
  ],
);

describe("a status that was declared closed under an open item", () => {
  it("leaves the item writable, and refuses its status until the closing time follows", () => {
    const db = given(item("itm_t1", "task", null, { status: "blocked" }));
    db.prepare("UPDATE item_statuses SET is_closed = 1 WHERE code = 'blocked'").run();

    expect(attempt(db, update("items", "itm_t1", { title: "x", title_norm: "x" }))).toBe(ACCEPTED);
    expect(attempt(db, update("items", "itm_t1", { status: "blocked" }))).toEqual(CLOSED_AT);
    expect(attempt(db, update("items", "itm_t1", { status: "blocked", closed_at: T2 }))).toBe(ACCEPTED);
  });
});

describe("the last activity of an item, after the clock has stepped back", () => {
  // After the undo of an operation that was applied at or after the date, the date is read from
  // the newest effect that an operation in force has on the item, by the id of the effect. That is
  // the newest such operation as long as the clock only goes forward.
  it("falls behind an operation that is still in force when a newer one is undone", () => {
    const db = given(
      PROJECT,
      manual("opr_w", { applied_at: T3 }),
      effect("opr_w", { item_id: "itm_p1" }),
      // Applied an hour before the first one, and its effect written after that one's.
      manual("opr_x", { applied_at: T2 }),
      effect("opr_x", { item_id: "itm_p1" }),
      manual("opr_z", { applied_at: T4 }),
      effect("opr_z", { item_id: "itm_p1" }),
      anUndo("opr_u1"),
    );
    const activity = () => db.prepare("SELECT last_activity_at FROM items WHERE id = 'itm_p1'").pluck().get();
    expect(activity()).toBe(T4);

    expect(attempt(db, undo("opr_z"))).toBe(ACCEPTED);

    // The first operation, applied at the third instant, is in force.
    expect(activity()).toBe(T2);
  });
});

// ---------------------------------------------------------------------------------------------
// Rules that stand behind another rule
// ---------------------------------------------------------------------------------------------

// A CHECK, a unique index or a foreign key that a trigger stands in front of: the trigger
// refuses the same statement first, with a sentence that says more, and no statement reaches the
// rule behind it. Each is shown here on a database that has lost the trigger, so that the rule
// is not mistaken for dead text.
const BEHIND_A_TRIGGER: [trigger: string, rows: Statement[], one: Case][] = [
  [
    "facts_start_with_source",
    [...ITEMS, ...CAPTURE],
    refuses(
      "a fact with a quote and no source",
      check("quote IS NULL OR source_id IS NOT NULL"),
      fact("fct_1", { source_id: null }),
    ),
  ],
  [
    "operations_insert_guard",
    WORK,
    refuses("a staged operation without a run", check("state <> 'staged' OR run_id IS NOT NULL"), operation("opr_1")),
  ],
  [
    "operations_state_guard",
    DECIDED,
    refuses(
      "an operation that is undone by itself",
      check("undone_by_id IS NULL OR undone_by_id <> id"),
      undo("opr_1", "opr_1"),
    ),
  ],
  [
    "operation_dependencies_no_cycle",
    STAGED,
    refuses("an operation that needs itself", check("operation_id <> depends_on_id"), edge("opr_1", "opr_1")),
  ],
  [
    "runs_one_commit_guard",
    [...WORK, END_RUN, run("run_3")],
    refuses(
      "a second run of a job committing",
      unique("runs.job_id"),
      update("runs", "run_3", { state: "committed", ended_at: T3 }),
    ),
  ],
  ["files_delete_guard", CAPTURE, refuses("deleting a file that a part uses", FOREIGN_KEY, deleteFile(SHA))],
  ["runs_no_delete", STAGED, refuses("deleting a run that has operations", FOREIGN_KEY, remove("runs", "run_1"))],
  [
    "operations_delete_guard",
    [...DECIDED, UNDO, undo("opr_3")],
    refuses("deleting the undo that took an operation back", FOREIGN_KEY, remove("operations", "opr_u1")),
  ],
  [
    "operation_effects_insert_guard",
    DECIDED,
    refuses("an effect of an operation that does not exist", FOREIGN_KEY, effect("opr_nowhere")),
  ],
];
for (const [trigger, rows, one] of BEHIND_A_TRIGGER)
  scene(`a rule that stands behind ${trigger}`, rows, [one], [trigger]);

describe("the rule that a new effect is the newest", () => {
  // The ids of effects have no gap, so an id that is free is the next one. On a table that had
  // a gap, an effect written into it would sort before a change that is recorded already.
  it("stands behind the rule that its id is the next one: with a gap in the ids, an effect is not written into it", () => {
    const db = given(...DECIDED, STATUS_EFFECT, FACT_EFFECT);
    const order = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'operation_effects_in_order'").pluck().get();
    db.exec("DROP TRIGGER operation_effects_in_order");
    expect(attempt(db, effect("opr_1", { id: 5 }))).toBe(ACCEPTED);
    db.exec(order as string);

    // The effect before it is there, and one after it is as well.
    expect(attempt(db, effect("opr_1", { id: 3 }))).toEqual(EFFECTS_IN_ORDER);
    expect(attempt(db, effect("opr_1", { id: 6 }))).toBe(ACCEPTED);
  });
});

// ---------------------------------------------------------------------------------------------
// Nothing left out
// ---------------------------------------------------------------------------------------------

// A rule that a later migration adds needs a case in this file. These tests ask the database
// for its rules and name the ones that no case of the scenes above stands for.
describe("the cases of this file", () => {
  interface SchemaObject {
    name: string;
    sql: string;
  }
  /** The tables or the triggers of the application, without the table in which the runner keeps its record. */
  const schema = (type: string) =>
    given()
      .prepare("SELECT name, sql FROM sqlite_schema WHERE type = ? AND tbl_name <> ? ORDER BY name")
      .all(type, MIGRATIONS_TABLE) as SchemaObject[];
  const expectedWith = (code: string) => expected.filter(({ refusal }) => refusal.code === code);
  /** What the database says to an expected refusal on a database of its own that is changed first. */
  const againAfter = (change: (db: Connection) => void, { rows, statement, dropped }: Expected) => {
    const outcome = attempt(given(without(...dropped), change, ...rows), statement);
    // These tests ask many times over: the databases go as they are done with.
    closeDatabases();
    return outcome;
  };
  const sentencesOf = (trigger: string) =>
    [...trigger.matchAll(/RAISE\(ABORT, '([^']*)'\)/g)].map(([, sentence]) => sentence as string);
  /** The table that a statement writes to. */
  const tableOf = ({ sql: text }: Statement) =>
    /^(?:INSERT(?: OR \w+)? INTO|UPDATE(?: OR \w+)?|DELETE FROM) (\w+)/.exec(text)?.[1] ?? text;
  /** The conditions of the CHECKs of a table, each as SQLite words it when it refuses. */
  function checksOf(table: string): string[] {
    // Without the comments, which speak of checks and have parentheses of their own. A literal stays as it is.
    const text = table.replace(/'(?:[^']|'')*'|--[^\n]*/g, (found) => (found.startsWith("'") ? found : ""));
    return [...text.matchAll(/\bCHECK \(/g)].map(({ index }) => {
      const start = index + "CHECK (".length;
      let [end, depth, quoted] = [start, 1, false];
      for (; depth > 0; end++) {
        if (text[end] === "'") quoted = !quoted;
        else if (!quoted && text[end] === "(") depth++;
        else if (!quoted && text[end] === ")") depth--;
      }
      return text.slice(start, end - 1).trim();
    });
  }

  it("expect every sentence with which a trigger of the database refuses", () => {
    const sentences = new Set(schema("trigger").flatMap(({ sql: text }) => sentencesOf(text)));
    const expectedSentences = new Set(expectedWith("SQLITE_CONSTRAINT_TRIGGER").map(({ refusal }) => refusal.message));

    expect([...sentences].filter((sentence) => !expectedSentences.has(sentence))).toEqual([]);
    // And no case expects a sentence that no trigger has.
    expect([...expectedSentences].filter((sentence) => !sentences.has(sentence))).toEqual([]);
    expect(sentences.size).toBeGreaterThan(0);
  });

  // Several triggers can refuse with one sentence, and a new one that borrows the sentence of
  // another would hide behind that one's cases. So each trigger is taken away in turn: a case
  // that expects one of its sentences must then get another answer.
  it("need every trigger that refuses: without it, a case is no longer refused as it expects", () => {
    const refusing = schema("trigger").filter(({ sql: text }) => sentencesOf(text).length > 0);
    const cases = expectedWith("SQLITE_CONSTRAINT_TRIGGER");

    const idle = refusing.filter(({ name, sql: text }) => {
      const sentences = sentencesOf(text);
      return !cases.some(
        (one) =>
          sentences.includes(one.refusal.message) &&
          !one.dropped.includes(name) &&
          JSON.stringify(againAfter(without(name), one)) !== JSON.stringify(one.refusal),
      );
    });

    expect(idle.map(({ name }) => name)).toEqual([]);
    expect(refusing.length).toBeGreaterThan(0);
  });

  // ABORT undoes the statement and leaves the transaction to its caller. ROLLBACK would end the
  // transaction of the caller, FAIL would keep the rows that a statement for many rows wrote
  // before the one that is refused, and IGNORE would skip a row without a word.
  it("are refused by ABORT wherever a trigger refuses, and by no other action", () => {
    const actions = schema("trigger").flatMap(({ sql: text }) =>
      [...text.matchAll(/\bRAISE\s*\(\s*(\w+)/gi)].map(([, action]) => action as string),
    );

    expect([...new Set(actions)]).toEqual(["ABORT"]);
  });

  it("see every trigger that refuses: each of them raises a sentence", () => {
    const silent = schema("trigger")
      .filter(({ sql: text }) => sentencesOf(text).length === 0)
      .map(({ name }) => name);

    // The three that refuse nothing: they keep derived data, and have tests of their own above.
    expect(silent).toEqual([
      "operation_effects_item_activity",
      "operations_undone_item_activity",
      "runs_discard_staged",
    ]);
  });

  // A CHECK has no name. SQLite reports the text of its condition, and the statement of the case
  // says which table it is in.
  it("expect every CHECK of every table, by the text of its condition", () => {
    const inDatabase = schema("table").flatMap(({ name, sql: text }) =>
      checksOf(text).map((condition) => `${name}: ${condition}`),
    );
    const inCases = new Set(
      expectedWith("SQLITE_CONSTRAINT_CHECK").map(
        ({ statement, refusal }) =>
          `${tableOf(statement)}: ${refusal.message.replace("CHECK constraint failed: ", "")}`,
      ),
    );

    expect(inDatabase.filter((one) => !inCases.has(one))).toEqual([]);
    // And no case expects a CHECK that its table does not have.
    expect([...inCases].filter((one) => !inDatabase.includes(one))).toEqual([]);
    // No table states one condition twice, so there are as many CHECKs as there are cases for them.
    expect(inDatabase.length).toBe(inCases.size);
    expect(inDatabase.length).toBeGreaterThan(0);
  });

  // SQLite does not say which foreign key refused a statement. With the keys switched off the
  // statement is accepted, and the check of the keys then names every key that it breaks. A case
  // stands for a key when that key is the only one.
  it("break every foreign key of the database, each of them alone in at least one case", () => {
    interface Key {
      id: number;
      table: string;
      from: string;
    }
    const tables = schema("table").map(({ name }) => name);
    const nameOf = (db: Connection, child: string, id: number) => {
      const parts = (db.pragma(`foreign_key_list(${child})`) as Key[]).filter((part) => part.id === id);
      return `${child} (${parts.map((part) => part.from).join(", ")}) -> ${parts[0]?.table}`;
    };
    const every = given();
    const keys = tables.flatMap((child) => [
      ...new Set((every.pragma(`foreign_key_list(${child})`) as Key[]).map(({ id }) => nameOf(every, child, id))),
    ]);
    /** The keys that rows of the database break. */
    const brokenIn = (db: Connection) => [
      ...new Set(
        (db.pragma("foreign_key_check") as { table: string; fkid: number }[]).map(({ table, fkid }) =>
          nameOf(db, table, fkid),
        ),
      ),
    ];

    const alone = new Set<string>();
    for (const { rows, statement, dropped } of expectedWith("SQLITE_CONSTRAINT_FOREIGNKEY")) {
      const db = given(without(...dropped), (connection) => connection.pragma("foreign_keys = OFF"), ...rows);
      const broken = attempt(db, statement) === ACCEPTED ? brokenIn(db) : [];
      if (broken.length === 1) alone.add(broken[0] as string);
      closeDatabases();
    }

    expect(keys.filter((key) => !alone.has(key))).toEqual([]);
    expect(keys.length).toBeGreaterThan(0);
  });
});
