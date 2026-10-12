-- =====================================================================================================
-- Hubber, M1a-4: the application schema (the first migration).
--
-- Applied by the migration runner (src/server/db/migrate.ts) to the file that M1a-3 creates. The rules
-- below are written for the connection that openWorkspaceDatabase() hands out (journal_mode = WAL,
-- foreign_keys = ON, synchronous = FULL, fullfsync = ON, recursive_triggers at its default, off). Not
-- in this file: workspace_pin and PRAGMA user_version (workspace layer) and schema_migrations (the
-- migration runner).
-- Tested on SQLite 3.53.4 (better-sqlite3 13.0.3).
--
-- Conventions
--   ids        TEXT, assigned by the application: a three-letter prefix that names the kind of object,
--              an underscore, twelve characters of lower-case Crockford base32 (60 random bits), e.g.
--              itm_7k3m9x2p4q8w. The database checks the prefix and that what follows it is lower-case
--              letters, digits and underscores, at least one; it does not check the length.
--              Two logs that nothing refers to before the row exists have INTEGER keys
--              (operation_effects, model_calls); files are keyed by the SHA-256 of their content.
--   *_at       an instant: TEXT, UTC, exactly as Date.prototype.toISOString() writes it for the years
--              0000 to 9999 (2026-10-11T09:36:07.123Z). The CHECK takes a value that strftime() gives
--              back unchanged and that begins with a digit: a year with a minus sign can come back as
--              it went in. That leaves one spelling, so text order is time order. Two instants have
--              another name: queue_jobs.run_after and queue_jobs.leased_until. Every instant comes from
--              the application; no trigger reads the clock.
--   *_on       a calendar day without a time zone: TEXT 'YYYY-MM-DD', held to that one spelling in the
--              same way, through date().
--   booleans   INTEGER 0 or 1.
--   JSON       TEXT with json_valid().
--   NUL        GLOB, length() and json_valid() read a text only as far as its first NUL character. The
--              CHECKs of ids, labels, vocabulary codes, the hash of a file and JSON therefore also refuse
--              a text that holds one: instr(x, char(0)) = 0.
--   *_norm     a name folded for matching by one function of the application, foldName(). The database
--              checks only that the folded name is not empty; SQLite's lower() is ASCII only.
--   words      four classes, each with its own treatment:
--              1. vocabularies the owner may adjust (PRD 8.4, 8.5): a table per vocabulary, foreign key;
--              2. life-cycle states (operations, runs, queue jobs): a table per list, foreign key,
--                 because a misspelt state would drop a row out of a partial index without a sound;
--              3. labels that the code's registries own and later packages extend (kinds of operation,
--                 run, job, source, part and entity; the origin of an operation and of a derived text;
--                 approval; confidence; the role and the purpose of a model call; the precision of a
--                 day): only the shape of a lower-case identifier is checked. The comment of a column
--                 gives the values known when this file was written; the lists of the code
--                 (src/shared/vocabulary.ts) are the ones that count;
--              4. structural words that other constraints of this file are built on (items.kind,
--                 operation_effects.change): CHECK lists.
--   deletes    no foreign key has an action: none cascades, none sets NULL. A row disappears only by a
--              DELETE that names its table (a statement of the application, or one of the two in the
--              trigger that discards what a run staged, section 12), or by a replacing INSERT or UPDATE,
--              which no statement of the application uses (section 11). A table rebuilt with foreign
--              keys left on therefore fails instead of emptying the tables that point at it.
--   uniqueness a rule that a later package may change is a named unique index, never a table
--              constraint, so it changes with DROP INDEX and no rebuild. Apart from the primary keys,
--              the one UNIQUE constraint of a table, UNIQUE (id, kind) on sources, is the parent key of
--              a composite foreign key.
--   defaults   none: every value is written by the statement that inserts the row, except the two
--              INTEGER keys, which the database can number.
--   columns    long text comes last in a table.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. Vocabularies the owner may still adjust (PRD open question 3). A value is added with one INSERT in a
--    migration. Codes are English and are also what Zod, the API and the model's tools use; the Polish
--    labels live in src/web/messages.ts. "position" is the order in lists and in sorted queries.
--    A migration never renames a code in place: codes are also stored inside journal values, and no
--    foreign key reaches those. The foreign keys refuse a rename or a removal only while a row has the code.
-- -----------------------------------------------------------------------------------------------------

-- ITM-2. is_closed is what "active item" is computed from (NFR-6, VIEW-1, PRD 11.2).
CREATE TABLE item_statuses (
  code TEXT PRIMARY KEY NOT NULL CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z0-9_]*' AND instr(code, char(0)) = 0),
  position INTEGER NOT NULL,
  is_closed INTEGER NOT NULL CHECK (is_closed IN (0, 1))
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
INSERT INTO item_statuses (code, position, is_closed) VALUES
  ('todo', 1, 0),          -- do zrobienia
  ('in_progress', 2, 0),   -- w toku
  ('blocked', 3, 0),       -- zablokowane
  ('done', 4, 1),          -- zrobione
  ('cancelled', 5, 1);     -- anulowane
--> statement-breakpoint
-- ITM-2. severity 0 is "no concern"; the list of items at risk reads severity > 0.
CREATE TABLE item_healths (
  code TEXT PRIMARY KEY NOT NULL CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z0-9_]*' AND instr(code, char(0)) = 0),
  position INTEGER NOT NULL,
  severity INTEGER NOT NULL CHECK (severity >= 0)
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
INSERT INTO item_healths (code, position, severity) VALUES
  ('green', 1, 0), ('yellow', 2, 1), ('red', 3, 2);   -- zielona, żółta, czerwona
--> statement-breakpoint
-- ITM-13. weight is what "more important" is computed from: a list in order of importance reads it,
-- largest first. 0 is the ordinary importance, the one a new item gets; the application writes it.
CREATE TABLE item_importances (
  code TEXT PRIMARY KEY NOT NULL CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z0-9_]*' AND instr(code, char(0)) = 0),
  position INTEGER NOT NULL,
  weight INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
INSERT INTO item_importances (code, position, weight) VALUES
  ('high', 1, 1), ('normal', 2, 0), ('low', 3, -1);   -- wysoka, normalna, niska
--> statement-breakpoint
-- ITM-3.
CREATE TABLE my_roles (
  code TEXT PRIMARY KEY NOT NULL CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z0-9_]*' AND instr(code, char(0)) = 0),
  position INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
INSERT INTO my_roles (code, position) VALUES
  ('doing', 1),        -- robię
  ('delegating', 2),   -- deleguję
  ('waiting', 3),      -- czekam
  ('watching', 4);     -- obserwuję
--> statement-breakpoint
-- ITM-5. The code 'owner' is named by the index item_persons_one_owner.
CREATE TABLE item_person_roles (
  code TEXT PRIMARY KEY NOT NULL CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z0-9_]*' AND instr(code, char(0)) = 0),
  position INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
INSERT INTO item_person_roles (code, position) VALUES
  ('owner', 1),         -- właściciel
  ('requester', 2),     -- zleceniodawca
  ('stakeholder', 3),   -- interesariusz
  ('executor', 4),      -- wykonawca
  ('informed', 5);      -- informowany
--> statement-breakpoint
-- ITM-6.
CREATE TABLE fact_types (
  code TEXT PRIMARY KEY NOT NULL CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z0-9_]*' AND instr(code, char(0)) = 0),
  position INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
INSERT INTO fact_types (code, position) VALUES
  ('decision', 1), ('requirement', 2), ('risk', 3), ('info', 4), ('question', 5);
--> statement-breakpoint
-- PER-4.
CREATE TABLE person_relations (
  code TEXT PRIMARY KEY NOT NULL CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z0-9_]*' AND instr(code, char(0)) = 0),
  position INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
INSERT INTO person_relations (code, position) VALUES
  ('report', 1),        -- podwładny
  ('manager', 2),       -- przełożony
  ('peer', 3),          -- współpracownik
  ('stakeholder', 4),   -- interesariusz
  ('external', 5);      -- zewnętrzny
--> statement-breakpoint
-- -----------------------------------------------------------------------------------------------------
-- 2. Life-cycle states. Tables and not CHECK lists, so that a state a later package needs is one INSERT
--    and not a rebuild of operations, runs or queue_jobs. The states that indexes, triggers and CHECKs of
--    this file name are marked; a migration that retires one of those recreates what names it.
-- -----------------------------------------------------------------------------------------------------

-- The life cycle of the plan (M1a-5). All six are named below.
--   staged    recorded by a run and not moved on yet: the run is still running, or was committed a moment
--             ago; has no effect and no view reads it
--   proposed  waits in the Inbox for a decision
--   invalid   failed the checks after the agent's retries; waits in the Inbox for a manual decision
--   applied   its effect is in the data; an entry of the journal
--   rejected  the owner said no
--   undone    was applied and taken back; still an entry of the journal
CREATE TABLE operation_states (
  code TEXT PRIMARY KEY NOT NULL CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z0-9_]*' AND instr(code, char(0)) = 0)
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
INSERT INTO operation_states (code) VALUES
  ('staged'), ('proposed'), ('invalid'), ('applied'), ('rejected'), ('undone');
--> statement-breakpoint
-- All three are named below. A run that ends in any state other than 'committed' discards what it staged.
-- A run that a killed process left behind becomes 'failed' with error_code 'interrupted'.
CREATE TABLE run_states (
  code TEXT PRIMARY KEY NOT NULL CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z0-9_]*' AND instr(code, char(0)) = 0)
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
INSERT INTO run_states (code) VALUES ('running'), ('committed'), ('failed');
--> statement-breakpoint
-- 'queued' and 'running' are named below. What CAP-2 shows for a capture is the state of its newest job:
-- queued = "w kolejce", running = "przetwarzane", done = "gotowe", failed = "błąd".
CREATE TABLE job_states (
  code TEXT PRIMARY KEY NOT NULL CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z0-9_]*' AND instr(code, char(0)) = 0)
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
INSERT INTO job_states (code) VALUES ('queued'), ('running'), ('done'), ('failed');
--> statement-breakpoint
-- -----------------------------------------------------------------------------------------------------
-- 3. Sources: the registry of everything information can come from and a run can process (PRD chapter 7,
--    "Źródło"). One row per capture now; a later kind (a note, a note fragment, a document, a conversation
--    message) is a new table whose key references this one, and nothing that points at sources changes.
--    The row outlives its content: permanent deletion (AUD-4) sets deleted_at and then removes the content,
--    so a fact kept "bez źródła", a journal entry and a run can still say which source it was.
-- -----------------------------------------------------------------------------------------------------

CREATE TABLE sources (
  -- The same value as the key of the row in the kind's own table.
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB '[a-z][a-z][a-z]_?*' AND id NOT GLOB '*[^0-9a-z_]*' AND instr(id, char(0)) = 0),
  -- Label. M1a-4: 'capture'. Later: 'note', 'note_fragment', 'document', 'message'.
  kind TEXT NOT NULL CHECK (kind GLOB '[a-z]*' AND kind NOT GLOB '*[^a-z0-9_]*' AND instr(kind, char(0)) = 0),
  -- CAP-7 "data dodania".
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds') AND created_at GLOB '[0-9]*'),
  -- Set once, by permanent deletion.
  deleted_at TEXT CHECK (deleted_at IS strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at, '+0 seconds') AND deleted_at GLOB '[0-9]*'),
  -- The parent key of the kind tables: a capture can only sit on a row whose kind is 'capture'.
  UNIQUE (id, kind)
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
-- The list of sent inputs, newest first (CAP-2); days with a capture (PRD chapter 12).
CREATE INDEX sources_by_kind ON sources (kind, created_at);
--> statement-breakpoint
-- -----------------------------------------------------------------------------------------------------
-- 4. Files: originals under <workspace>/files, addressed by the hash of their content (plan, M1a-7).
--    The path is derived from the hash, so no path is stored and the workspace stays movable (NFR-8).
-- -----------------------------------------------------------------------------------------------------

CREATE TABLE files (
  sha256 TEXT PRIMARY KEY NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*' AND instr(sha256, char(0)) = 0),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  -- As the server established it from the content, e.g. image/png. Never the browser's word as is.
  media_type TEXT NOT NULL CHECK (media_type <> ''),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds') AND created_at GLOB '[0-9]*')
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
-- -----------------------------------------------------------------------------------------------------
-- 5. Captures (wrzutki): raw material exactly as the owner dropped it (CAP-5, principle 2).
-- -----------------------------------------------------------------------------------------------------

-- One row per input sent from the input field. The date of adding is sources.created_at; the state that
-- CAP-2 shows is the state of the newest job of this source.
CREATE TABLE captures (
  -- The id of its registry row. The rule about the characters of an id is held there: by the foreign key
  -- below, this id is one that the registry stores.
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'cap_?*'),
  -- Always 'capture': ties the row to a registry row of that kind.
  source_kind TEXT GENERATED ALWAYS AS ('capture') VIRTUAL,
  -- CAP-7 "data zdarzenia". Written at saving as the local day of adding with approximate = 1; processing
  -- replaces it when the material states a date. Relative dates in the material are counted from it.
  occurred_on TEXT NOT NULL CHECK (occurred_on IS date(occurred_on) AND occurred_on GLOB '[0-9]*'),
  occurred_on_approximate INTEGER NOT NULL CHECK (occurred_on_approximate IN (0, 1)),
  FOREIGN KEY (id, source_kind) REFERENCES sources (id, kind)
) STRICT;
--> statement-breakpoint
-- The pieces of one input, in the order the owner put them (CAP-3, CAP-4). Never updated, and deleted only
-- when the source is deleted for good (section 11).
CREATE TABLE capture_parts (
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'prt_?*' AND id NOT GLOB '*[^0-9a-z_]*' AND instr(id, char(0)) = 0),
  capture_id TEXT NOT NULL REFERENCES captures (id),
  position INTEGER NOT NULL CHECK (position >= 0),
  -- Label. 'typed' is named below: the text the owner typed, the only place where commands and questions
  -- are recognised (CAP-3). Also: 'pasted' (longer pasted text, attached as material), 'image' (from the
  -- clipboard or a dropped image file), 'file' (any other dropped file).
  kind TEXT NOT NULL CHECK (kind GLOB '[a-z]*' AND kind NOT GLOB '*[^a-z0-9_]*' AND instr(kind, char(0)) = 0),
  -- The original of an image or file part.
  file_sha256 TEXT REFERENCES files (sha256),
  -- The name the file came with. Two parts can share content and differ in name.
  file_name TEXT CHECK (file_name <> ''),
  -- The original text of a typed or pasted part, character for character.
  text TEXT CHECK (text <> ''),
  CHECK ((text IS NULL) <> (file_sha256 IS NULL)),
  CHECK (file_name IS NULL OR file_sha256 IS NOT NULL),
  CHECK (kind <> 'typed' OR text IS NOT NULL)
) STRICT;
--> statement-breakpoint
-- The order of the parts of an input.
CREATE UNIQUE INDEX capture_parts_one_per_position ON capture_parts (capture_id, position);
--> statement-breakpoint
-- One typed text per input.
CREATE UNIQUE INDEX capture_parts_one_typed ON capture_parts (capture_id) WHERE kind = 'typed';
--> statement-breakpoint
-- Is a file still used by any part? Asked before the file is removed from disk (AUD-4), and by the guard
-- that keeps the row of a file in use (section 11). Also the child side of the foreign key to files.
CREATE INDEX capture_parts_by_file ON capture_parts (file_sha256) WHERE file_sha256 IS NOT NULL;
--> statement-breakpoint
-- Text derived from a part that is not text itself: the transcription of an image (CAP-6), the text of a
-- dropped text file. Quotes are verified against it (ING-8). Append-only until the source is deleted for
-- good: a correction (CAP-9) or a new transcription is a new revision, and the newest revision is the
-- current one.
CREATE TABLE capture_part_texts (
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'ptx_?*' AND id NOT GLOB '*[^0-9a-z_]*' AND instr(id, char(0)) = 0),
  part_id TEXT NOT NULL REFERENCES capture_parts (id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  -- Label: 'transcription' (by the model, M1a-7), 'extraction' (local), 'correction' (by the owner, CAP-9).
  origin TEXT NOT NULL CHECK (origin GLOB '[a-z]*' AND origin NOT GLOB '*[^a-z0-9_]*' AND instr(origin, char(0)) = 0),
  -- The model call that wrote a transcription: which model and which version of the prompt (plan section 3,
  -- "Prompty"). NULL for a local extraction and for a correction.
  model_call_id INTEGER REFERENCES model_calls (id),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds') AND created_at GLOB '[0-9]*'),
  -- CAP-6: participants, time stamps and content message by message, and the date visible in the image.
  structure TEXT CHECK (structure IS NULL OR (json_valid(structure) AND instr(structure, char(0)) = 0)),
  -- The flat text: what is searched, quoted and shown to the agent.
  text TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX capture_part_texts_one_per_revision ON capture_part_texts (part_id, revision);
--> statement-breakpoint
-- -----------------------------------------------------------------------------------------------------
-- 6. Persons (PER-4, PER-5).
-- -----------------------------------------------------------------------------------------------------

CREATE TABLE persons (
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'per_?*' AND id NOT GLOB '*[^0-9a-z_]*' AND instr(id, char(0)) = 0),
  -- "Imię i nazwisko" as shown.
  name TEXT NOT NULL CHECK (trim(name) <> ''),
  name_norm TEXT NOT NULL CHECK (name_norm <> ''),
  -- PER-4 "rola": what the person does, free text.
  job_title TEXT,
  -- PER-4 "zespół lub organizacja", free text.
  team TEXT,
  relation TEXT REFERENCES person_relations (code),
  -- PER-5: the owner. At most one row carries it.
  is_me INTEGER NOT NULL CHECK (is_me IN (0, 1)),
  -- PER-7: the person this one was merged into. The row stays as a signpost, so identifiers in notes,
  -- addresses and the journal keep resolving. Lists read merged_into_id IS NULL.
  merged_into_id TEXT REFERENCES persons (id),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds') AND created_at GLOB '[0-9]*'),
  -- PER-4: the owner's own note about the person, plain text.
  note TEXT,
  CHECK (merged_into_id IS NULL OR merged_into_id <> id),
  CHECK (is_me = 0 OR merged_into_id IS NULL)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX persons_one_me ON persons (is_me) WHERE is_me = 1;
--> statement-breakpoint
-- Is this name known, and to how many persons? (ING-4, the confidence guard of M1a-5, M1b-2.)
CREATE INDEX persons_by_name ON persons (name_norm);
--> statement-breakpoint
CREATE INDEX persons_merged_into ON persons (merged_into_id) WHERE merged_into_id IS NOT NULL;
--> statement-breakpoint
-- Other names of a person (PER-2, PER-3): diminutives, initials, nicknames, messenger handles, e-mail
-- addresses, and names that hold only in a context ("Ania z płatności"). The same alias may belong to
-- several persons: that is what makes a mention ambiguous, and the answer is a question, never a guess.
CREATE TABLE person_aliases (
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'pal_?*' AND id NOT GLOB '*[^0-9a-z_]*' AND instr(id, char(0)) = 0),
  person_id TEXT NOT NULL REFERENCES persons (id),
  alias TEXT NOT NULL CHECK (trim(alias) <> ''),
  alias_norm TEXT NOT NULL CHECK (alias_norm <> ''),
  -- The context in which the alias means this person; '' when it holds everywhere.
  context TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds') AND created_at GLOB '[0-9]*')
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX person_aliases_one_per_context ON person_aliases (person_id, alias_norm, context);
--> statement-breakpoint
-- Which persons answer to this name?
CREATE INDEX person_aliases_by_norm ON person_aliases (alias_norm);
--> statement-breakpoint
-- -----------------------------------------------------------------------------------------------------
-- 7. Items: projects and tasks, in trees of any depth (ITM-1 to ITM-5).
-- -----------------------------------------------------------------------------------------------------

CREATE TABLE items (
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'itm_?*' AND id NOT GLOB '*[^0-9a-z_]*' AND instr(id, char(0)) = 0),
  -- Structural, ITM-1's "typ": a project or a task. The triggers of the hierarchy and of the schedule
  -- (section 11) name 'project'. "Podzadanie" is a word of the interface for a task whose parent is a task;
  -- it is not a kind.
  kind TEXT NOT NULL CHECK (kind IN ('project', 'task')),
  -- ITM-4: the item this one sits under. NULL for a project and for a task that stands alone. A task sits in
  -- a project or under another task, to any depth: the database sets no limit. That the parent exists is this
  -- foreign key. The other rules of the tree are triggers of section 11 (items_hierarchy_insert and
  -- items_hierarchy_update, and the two guards against a merged parent), so that such a rule changes without
  -- a rebuild of this table.
  parent_id TEXT REFERENCES items (id),
  title TEXT NOT NULL CHECK (trim(title) <> ''),
  title_norm TEXT NOT NULL CHECK (title_norm <> ''),
  status TEXT NOT NULL REFERENCES item_statuses (code),
  -- ITM-13. Every item has one; a new item gets the ordinary one.
  importance TEXT NOT NULL REFERENCES item_importances (code),
  -- ITM-2: the health of the item itself, a project or a task at any depth; NULL is "not assessed".
  health TEXT REFERENCES item_healths (code),
  -- ITM-3. NULL: not said yet.
  my_role TEXT REFERENCES my_roles (code),
  -- The day from which my_role holds, by the event date of the material that said so: "how long have I
  -- been waiting" (Q2, VIEW-1). Written by the operation that sets my_role.
  my_role_set_on TEXT CHECK (my_role_set_on IS date(my_role_set_on) AND my_role_set_on GLOB '[0-9]*'),
  -- SCH-1 "data rozpoczęcia": the day the work starts, as planned or as it happened; NULL: not said. With
  -- due_on it is the period of the item, which a chart draws as a bar. No rule orders the two days: a start
  -- after the due day is work that begins late, and the views mark it.
  start_on TEXT CHECK (start_on IS date(start_on) AND start_on GLOB '[0-9]*'),
  -- Label, SCH-1: how exactly the start is known. NULL: to the day. 'approximate': about that day. A period
  -- that was named ('week', 'month', 'quarter', 'half', 'year'): start_on is the first day of that period.
  -- The application counts the periods; the database checks the shape of the label and that its day is set
  -- (section 11), nothing about the period.
  start_on_precision TEXT CHECK (start_on_precision GLOB '[a-z]*' AND start_on_precision NOT GLOB '*[^a-z0-9_]*' AND instr(start_on_precision, char(0)) = 0),
  -- ITM-1 "termin": a day. The end of the period of the item; alone, a point in time.
  due_on TEXT CHECK (due_on IS date(due_on) AND due_on GLOB '[0-9]*'),
  -- Label, as start_on_precision; for a period that was named, due_on is its last day.
  due_on_precision TEXT CHECK (due_on_precision GLOB '[a-z]*' AND due_on_precision NOT GLOB '*[^a-z0-9_]*' AND instr(due_on_precision, char(0)) = 0),
  -- SCH-2 "kamień milowy": 1 marks a task, at any depth of its tree, as a point in time and not a stretch of
  -- work. It stands on its due day and has no start. A project is never one.
  is_milestone INTEGER NOT NULL CHECK (is_milestone IN (0, 1)),
  -- ITM-1 "odnośnik zewnętrzny (system, klucz, adres)", e.g. 'jira', 'PAY-123', the address of the ticket.
  external_system TEXT CHECK (external_system <> ''),
  external_key TEXT CHECK (external_key <> ''),
  external_url TEXT CHECK (external_url <> ''),
  -- ITM-10: the item this one was merged into. The row stays as a signpost. Lists read merged_into_id IS NULL.
  merged_into_id TEXT REFERENCES items (id),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds') AND created_at GLOB '[0-9]*'),
  -- When the status became a closed one; NULL while the item is open. Written by the operation that
  -- changes the status and checked by the triggers of section 11.
  closed_at TEXT CHECK (closed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', closed_at, '+0 seconds') AND closed_at GLOB '[0-9]*'),
  -- The instant at which the newest operation in force that concerned the item itself was applied; section
  -- 12 says which operation counts as the newest. Kept by the triggers of that section. The application
  -- writes it once, at the insert, where it equals created_at; no rule of the database stops a later write.
  last_activity_at TEXT NOT NULL CHECK (last_activity_at IS strftime('%Y-%m-%dT%H:%M:%fZ', last_activity_at, '+0 seconds') AND last_activity_at GLOB '[0-9]*'),
  CHECK (my_role_set_on IS NULL OR my_role IS NOT NULL),
  CHECK (external_key IS NULL OR external_system IS NOT NULL),
  CHECK (merged_into_id IS NULL OR merged_into_id <> id),
  CHECK (last_activity_at >= created_at)
) STRICT;
--> statement-breakpoint
-- The active items (about 300): the agent's index (PRD 11.2), the list (ITM-11) and every list of "Dziś"
-- (VIEW-1) start here, so they stay as fast as today however long the history grows.
CREATE INDEX items_active ON items (my_role, due_on) WHERE closed_at IS NULL AND merged_into_id IS NULL;
--> statement-breakpoint
-- Children of an item (ITM-8). Every read of an item with everything under it walks down through this index,
-- level by level. Also the child side of the foreign key of parent_id.
CREATE INDEX items_by_parent ON items (parent_id) WHERE parent_id IS NOT NULL;
--> statement-breakpoint
-- Is this title known, and to how many items? (ING-4, the confidence guard.)
CREATE INDEX items_by_title ON items (title_norm);
--> statement-breakpoint
CREATE INDEX items_merged_into ON items (merged_into_id) WHERE merged_into_id IS NOT NULL;
--> statement-breakpoint
-- ITM-1 "opis": the prose of an item (TipTap JSON, EDT-2), apart from its fields. Prose is saved by
-- autosave, grows large and gets version history later (EDT-5); the fields are small, filtered and
-- touched by every operation.
CREATE TABLE item_descriptions (
  -- Its own id, like every row that operations change: an effect names one row by one id.
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'ide_?*' AND id NOT GLOB '*[^0-9a-z_]*' AND instr(id, char(0)) = 0),
  item_id TEXT NOT NULL REFERENCES items (id),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 seconds') AND updated_at GLOB '[0-9]*'),
  body TEXT NOT NULL CHECK (json_valid(body) AND instr(body, char(0)) = 0)
) STRICT;
--> statement-breakpoint
-- One description per item. Version history (EDT-5) changes this rule by dropping the index.
CREATE UNIQUE INDEX item_descriptions_one_per_item ON item_descriptions (item_id);
--> statement-breakpoint
-- ITM-1 "aliasy (nazwy potoczne, skróty, klucze)".
CREATE TABLE item_aliases (
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'ial_?*' AND id NOT GLOB '*[^0-9a-z_]*' AND instr(id, char(0)) = 0),
  item_id TEXT NOT NULL REFERENCES items (id),
  alias TEXT NOT NULL CHECK (trim(alias) <> ''),
  alias_norm TEXT NOT NULL CHECK (alias_norm <> ''),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds') AND created_at GLOB '[0-9]*')
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX item_aliases_one_per_item ON item_aliases (item_id, alias_norm);
--> statement-breakpoint
CREATE INDEX item_aliases_by_norm ON item_aliases (alias_norm);
--> statement-breakpoint
-- ITM-5: the role of a person in an item, with expectations. One role per person and item (Appendix A,
-- set_item_person). The owner of ITM-1 is the row with role 'owner': there is no owner column on items.
CREATE TABLE item_persons (
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'itp_?*' AND id NOT GLOB '*[^0-9a-z_]*' AND instr(id, char(0)) = 0),
  item_id TEXT NOT NULL REFERENCES items (id),
  person_id TEXT NOT NULL REFERENCES persons (id),
  role TEXT NOT NULL REFERENCES item_person_roles (code),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds') AND created_at GLOB '[0-9]*'),
  -- ITM-5 "oczekiwania" (Q7).
  expectations TEXT
) STRICT;
--> statement-breakpoint
-- One role per person and item, which the owner may still decide otherwise. An index and not a table
-- constraint: the rule then changes with DROP INDEX and no rebuild. Also the child side of the foreign key
-- to items.
CREATE UNIQUE INDEX item_persons_one_role ON item_persons (item_id, person_id);
--> statement-breakpoint
-- ITM-1: one owner. Also the index by which a list finds the owner of each of its items.
CREATE UNIQUE INDEX item_persons_one_owner ON item_persons (item_id) WHERE role = 'owner';
--> statement-breakpoint
-- PER-6: what she owes me (role owner), what I owe her (role requester), the items she appears in;
-- ITM-11: the filter by person.
CREATE INDEX item_persons_by_person ON item_persons (person_id, role);
--> statement-breakpoint
-- -----------------------------------------------------------------------------------------------------
-- 8. What was extracted from sources: mentions, facts, links.
-- -----------------------------------------------------------------------------------------------------

-- "Wzmianka": a person named in a source (PER-1, PER-3). Resolved when person_id is set, skipped when
-- skipped_at is set (the answer "pomiń"), unresolved while both are NULL.
CREATE TABLE mentions (
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'mnt_?*' AND id NOT GLOB '*[^0-9a-z_]*' AND instr(id, char(0)) = 0),
  source_id TEXT NOT NULL REFERENCES sources (id),
  person_id TEXT REFERENCES persons (id),
  skipped_at TEXT CHECK (skipped_at IS strftime('%Y-%m-%dT%H:%M:%fZ', skipped_at, '+0 seconds') AND skipped_at GLOB '[0-9]*'),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds') AND created_at GLOB '[0-9]*'),
  -- As written in the source ("Kasią").
  surface TEXT NOT NULL CHECK (trim(surface) <> ''),
  -- The base form the agent gave ("Kasia"; PER-2, M1b-2), and its folded spelling for the look-up.
  base_form TEXT CHECK (trim(base_form) <> ''),
  base_norm TEXT CHECK (base_norm <> ''),
  CHECK (person_id IS NULL OR skipped_at IS NULL),
  CHECK ((base_form IS NULL) = (base_norm IS NULL))
) STRICT;
--> statement-breakpoint
-- The mentions of a source: its card, reprocessing, permanent deletion.
CREATE INDEX mentions_by_source ON mentions (source_id);
--> statement-breakpoint
-- PER-6 "wzmianki we wrzutkach"; VIEW-4: the material of a person whatever form the name took.
CREATE INDEX mentions_by_person ON mentions (person_id, created_at) WHERE person_id IS NOT NULL;
--> statement-breakpoint
-- After an answer became an alias: which other mentions were waiting for the same name? (M1b-2.)
CREATE INDEX mentions_unresolved ON mentions (base_norm) WHERE person_id IS NULL AND skipped_at IS NULL;
--> statement-breakpoint
-- ITM-6: an extracted statement about one item, from one source, with the quote.
CREATE TABLE facts (
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'fct_?*' AND id NOT GLOB '*[^0-9a-z_]*' AND instr(id, char(0)) = 0),
  -- "Fakt należy do jednego itemu." Changes when the fact is moved or its item is merged (ITM-10).
  item_id TEXT NOT NULL REFERENCES items (id),
  type TEXT NOT NULL REFERENCES fact_types (code),
  -- ITM-6 "data zdarzenia": the day the thing happened or was said; by default the event date of the source.
  occurred_on TEXT NOT NULL CHECK (occurred_on IS date(occurred_on) AND occurred_on GLOB '[0-9]*'),
  occurred_on_approximate INTEGER NOT NULL CHECK (occurred_on_approximate IN (0, 1)),
  -- Principle 4: every fact has a source. The source of a fact kept after permanent deletion is the
  -- registry row with deleted_at set ("bez źródła").
  source_id TEXT REFERENCES sources (id),
  -- ITM-6: a fact is not edited. It is marked outdated, optionally with the fact that replaced it.
  outdated_at TEXT CHECK (outdated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', outdated_at, '+0 seconds') AND outdated_at GLOB '[0-9]*'),
  superseded_by_fact_id TEXT REFERENCES facts (id),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds') AND created_at GLOB '[0-9]*'),
  -- A piece of the source, word for word. Removed, and only removed, when the source is deleted for good.
  quote TEXT CHECK (quote <> ''),
  -- The statement, as accepted.
  text TEXT NOT NULL CHECK (trim(text) <> ''),
  CHECK (quote IS NULL OR source_id IS NOT NULL),
  CHECK (superseded_by_fact_id IS NULL OR (outdated_at IS NOT NULL AND superseded_by_fact_id <> id))
) STRICT;
--> statement-breakpoint
-- The sections of the item page (ITM-8) and the facts on its timeline since a day (ITM-7).
CREATE INDEX facts_by_item ON facts (item_id, occurred_on);
--> statement-breakpoint
-- The facts a source gave: its card, reprocessing, and the question of AUD-4.
CREATE INDEX facts_by_source ON facts (source_id) WHERE source_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX facts_superseded_by ON facts (superseded_by_fact_id) WHERE superseded_by_fact_id IS NOT NULL;
--> statement-breakpoint
-- ITM-6 "powiązane osoby". Persons of the directory only: an unresolved mention is not a person yet.
CREATE TABLE fact_persons (
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'fcp_?*' AND id NOT GLOB '*[^0-9a-z_]*' AND instr(id, char(0)) = 0),
  fact_id TEXT NOT NULL REFERENCES facts (id),
  person_id TEXT NOT NULL REFERENCES persons (id)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX fact_persons_one_per_fact ON fact_persons (fact_id, person_id);
--> statement-breakpoint
-- The facts about a person's matters (Q6, PER-9).
CREATE INDEX fact_persons_by_person ON fact_persons (person_id);
--> statement-breakpoint
-- "Powiązanie źródła": a source concerns an item (ING-2; Appendix A, link_source). A source has any number
-- of links, also none. From M1b the link of a note fragment to an item is a row here as well.
CREATE TABLE source_links (
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'lnk_?*' AND id NOT GLOB '*[^0-9a-z_]*' AND instr(id, char(0)) = 0),
  source_id TEXT NOT NULL REFERENCES sources (id),
  item_id TEXT NOT NULL REFERENCES items (id),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds') AND created_at GLOB '[0-9]*')
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX source_links_one_per_item ON source_links (source_id, item_id);
--> statement-breakpoint
-- The sources of an item, newest first (ITM-8), and their entries on its timeline (ITM-7).
CREATE INDEX source_links_by_item ON source_links (item_id, created_at);
--> statement-breakpoint
-- -----------------------------------------------------------------------------------------------------
-- 9. Work in progress: the queue, agent runs, the log of model calls.
--    None of these holds text of a source, a prompt or a response, except runs.summary.
-- -----------------------------------------------------------------------------------------------------

-- The queue (plan section 2: a table of jobs, one worker in the server process; ING-10, NFR-7).
CREATE TABLE queue_jobs (
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'job_?*' AND id NOT GLOB '*[^0-9a-z_]*' AND instr(id, char(0)) = 0),
  -- Label. M1a-7: 'process_capture'. M1a-12: 'summarize_item'. Later packages add theirs.
  kind TEXT NOT NULL CHECK (kind GLOB '[a-z]*' AND kind NOT GLOB '*[^a-z0-9_]*' AND instr(kind, char(0)) = 0),
  state TEXT NOT NULL REFERENCES job_states (code),
  -- The material the job works on, when it works on material.
  source_id TEXT REFERENCES sources (id),
  -- At most one job per key waits for its first attempt: a second request for the same work joins the
  -- first (M1a-12 delays and merges series of changes this way). A job that is running, or that waits
  -- again after an attempt, does not block a new one.
  dedupe_key TEXT CHECK (dedupe_key <> ''),
  -- Attempts started so far.
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
  -- Not before this instant: the delay of a new job, or the growing gap before a retry.
  run_after TEXT NOT NULL CHECK (run_after IS strftime('%Y-%m-%dT%H:%M:%fZ', run_after, '+0 seconds') AND run_after GLOB '[0-9]*'),
  -- The lease: a running job whose lease has passed belongs to a worker that is gone.
  leased_until TEXT CHECK (leased_until IS strftime('%Y-%m-%dT%H:%M:%fZ', leased_until, '+0 seconds') AND leased_until GLOB '[0-9]*'),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds') AND created_at GLOB '[0-9]*'),
  -- Start of the newest attempt.
  started_at TEXT CHECK (started_at IS strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '+0 seconds') AND started_at GLOB '[0-9]*'),
  finished_at TEXT CHECK (finished_at IS strftime('%Y-%m-%dT%H:%M:%fZ', finished_at, '+0 seconds') AND finished_at GLOB '[0-9]*'),
  -- The newest failure, also while the job waits for its next attempt. Text has passed redact().
  last_error_code TEXT,
  last_error_message TEXT,
  -- Arguments of the job: identifiers and options, never content of material.
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object' AND instr(payload, char(0)) = 0),
  CHECK (attempts <= max_attempts),
  CHECK ((state = 'running') = (leased_until IS NOT NULL)),
  CHECK ((state IN ('queued', 'running')) = (finished_at IS NULL))
) STRICT;
--> statement-breakpoint
-- The worker's claim: the oldest job that is due.
CREATE INDEX queue_jobs_due ON queue_jobs (run_after) WHERE state = 'queued';
--> statement-breakpoint
-- Start-up and the lease check: jobs left running by a process that died.
CREATE INDEX queue_jobs_running ON queue_jobs (leased_until) WHERE state = 'running';
--> statement-breakpoint
-- CAP-2: the newest job of a capture gives its state.
CREATE INDEX queue_jobs_by_source ON queue_jobs (source_id, created_at) WHERE source_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX queue_jobs_one_queued_per_key ON queue_jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state = 'queued' AND attempts = 0;
--> statement-breakpoint
-- A run: one execution of the agent loop (plan section 2: the operations of a run are staged and applied
-- only after "finish"). Each attempt of a job is a new run. source_id is what the run processes, and
-- what its Inbox card is about (INB-1).
CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'run_?*' AND id NOT GLOB '*[^0-9a-z_]*' AND instr(id, char(0)) = 0),
  -- Label. M1a-7: 'process_capture'. Later: 'process_note', 'conversation_turn'.
  kind TEXT NOT NULL CHECK (kind GLOB '[a-z]*' AND kind NOT GLOB '*[^a-z0-9_]*' AND instr(kind, char(0)) = 0),
  state TEXT NOT NULL REFERENCES run_states (code),
  source_id TEXT REFERENCES sources (id),
  job_id TEXT REFERENCES queue_jobs (id),
  -- Plan section 3, "Prompty": every run of the agent records the versions of model and prompt.
  model TEXT CHECK (model <> ''),
  prompt_version TEXT CHECK (prompt_version <> ''),
  started_at TEXT NOT NULL CHECK (started_at IS strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '+0 seconds') AND started_at GLOB '[0-9]*'),
  ended_at TEXT CHECK (ended_at IS strftime('%Y-%m-%dT%H:%M:%fZ', ended_at, '+0 seconds') AND ended_at GLOB '[0-9]*'),
  -- Why a run failed: 'interrupted', 'max_tokens', 'refusal', 'no_finish', 'credential', ... A word of
  -- the code; the database does not check its shape.
  error_code TEXT,
  -- After redact().
  error_message TEXT,
  -- The text given with "finish". Written by the agent about the material: removed with it (AUD-4).
  summary TEXT,
  CHECK ((state = 'running') = (ended_at IS NULL)),
  CHECK (state <> 'failed' OR error_code IS NOT NULL)
) STRICT;
--> statement-breakpoint
-- NFR-7: a job is committed at most once, so a retried job cannot apply its operations twice.
CREATE UNIQUE INDEX runs_one_commit_per_job ON runs (job_id) WHERE job_id IS NOT NULL AND state = 'committed';
--> statement-breakpoint
-- A job has at most one run in progress: whoever claims a job first ends the run an earlier attempt left.
CREATE UNIQUE INDEX runs_one_running_per_job ON runs (job_id) WHERE job_id IS NOT NULL AND state = 'running';
--> statement-breakpoint
-- The runs of a source, newest first: the Inbox card and reprocessing (ING-11).
CREATE INDEX runs_by_source ON runs (source_id, started_at) WHERE source_id IS NOT NULL;
--> statement-breakpoint
-- Start-up: runs that a killed process left behind.
CREATE INDEX runs_running ON runs (started_at) WHERE state = 'running';
--> statement-breakpoint
-- The log of model calls (plan M1a-6: model, tokens, cache reads, time, stop_reason, error; CFG-7 later).
-- One row per request, written when the request ends. No prompt and no response: the log must not become
-- a second copy of the material.
CREATE TABLE model_calls (
  id INTEGER PRIMARY KEY,
  run_id TEXT REFERENCES runs (id),
  -- For calls made outside a run, such as the transcription of an image.
  job_id TEXT REFERENCES queue_jobs (id),
  -- Label, the roles of CFG-6 as in workspace.json: 'processing', 'conversation', 'synthesis'.
  role TEXT NOT NULL CHECK (role GLOB '[a-z]*' AND role NOT GLOB '*[^a-z0-9_]*' AND instr(role, char(0)) = 0),
  -- Label: 'agent_turn', 'transcription', 'summary', ...
  purpose TEXT NOT NULL CHECK (purpose GLOB '[a-z]*' AND purpose NOT GLOB '*[^a-z0-9_]*' AND instr(purpose, char(0)) = 0),
  model TEXT NOT NULL CHECK (model <> ''),
  -- The version of the prompt, for a call that has a prompt of its own (a transcription, a summary). The
  -- calls of an agent run share runs.prompt_version and leave this NULL.
  prompt_version TEXT CHECK (prompt_version <> ''),
  started_at TEXT NOT NULL CHECK (started_at IS strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '+0 seconds') AND started_at GLOB '[0-9]*'),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  -- Time to the first streamed token (NFR-5 for the conversation). NULL when nothing arrived.
  first_token_ms INTEGER CHECK (first_token_ms >= 0),
  -- As the API reports them; NULL when the call ended without usage.
  input_tokens INTEGER CHECK (input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens >= 0),
  cache_read_input_tokens INTEGER CHECK (cache_read_input_tokens >= 0),
  cache_creation_input_tokens INTEGER CHECK (cache_creation_input_tokens >= 0),
  http_status INTEGER,
  stop_reason TEXT,
  -- The request identifier the endpoint returned, for a question to its operator.
  request_id TEXT,
  -- Class of the SDK exception; text after redact().
  error_type TEXT,
  error_message TEXT,
  -- Events of the call that are not errors, e.g. {"retriedWithoutThinking": true} (plan, LLM rules).
  detail TEXT CHECK (detail IS NULL OR (json_valid(detail) AND instr(detail, char(0)) = 0))
) STRICT;
--> statement-breakpoint
-- -----------------------------------------------------------------------------------------------------
-- 10. Operations: the proposal ("Propozycja") and the journal entry ("Zmiana") of PRD chapter 7 are one
--     row at two moments of its life. Every change of the hub is one (plan section 2), also a manual edit
--     and an undo. What an applied operation did is in operation_effects.
-- -----------------------------------------------------------------------------------------------------

CREATE TABLE operations (
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'opr_?*' AND id NOT GLOB '*[^0-9a-z_]*' AND instr(id, char(0)) = 0),
  -- The run that staged it. NULL for what the owner did by hand in the interface, and for an undo.
  run_id TEXT REFERENCES runs (id),
  -- Position among the operations of the run, in the order the agent issued them.
  seq INTEGER CHECK (seq >= 0),
  -- Label: the registry of operations in code is the one list (Appendix A: 'create_item', 'update_item',
  -- 'link_source', 'add_fact', 'supersede_fact', 'set_item_person', 'create_person', 'update_person',
  -- 'resolve_mention', 'merge_items', 'merge_people', 'ask_user'; the framework adds 'undo', which the
  -- triggers of section 12 name). "finish" changes no data and is not a row: its text is runs.summary.
  kind TEXT NOT NULL CHECK (kind GLOB '[a-z]*' AND kind NOT GLOB '*[^a-z0-9_]*' AND instr(kind, char(0)) = 0),
  -- Label, "pochodzenie": 'command' (the owner's typed words; named by triggers of section 12),
  -- 'inference' (the agent's conclusion from material), 'user' (a manual edit); M3 adds 'sync'.
  origin TEXT NOT NULL CHECK (origin GLOB '[a-z]*' AND origin NOT GLOB '*[^a-z0-9_]*' AND instr(origin, char(0)) = 0),
  state TEXT NOT NULL REFERENCES operation_states (code),
  -- Label, ING-6: 'high' or 'low', after the guard of M1a-5 had its say. NULL where it has no meaning.
  confidence TEXT CHECK (confidence GLOB '[a-z]*' AND confidence NOT GLOB '*[^a-z0-9_]*' AND instr(confidence, char(0)) = 0),
  -- Label, AUD-1 "sposób zatwierdzenia": 'command', 'auto', 'accepted', 'manual'. Set when applied.
  approval TEXT CHECK (approval GLOB '[a-z]*' AND approval NOT GLOB '*[^a-z0-9_]*' AND instr(approval, char(0)) = 0),
  -- The material the operation follows from (Appendix A). NULL for a manual edit.
  source_id TEXT REFERENCES sources (id),
  -- The 'undo' operation that took this one back (AUD-2: the undo is itself a journal entry). One undo
  -- can take back a chain of operations.
  undone_by_id TEXT REFERENCES operations (id),
  -- When it was staged, or made by hand.
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds') AND created_at GLOB '[0-9]*'),
  -- When the owner accepted or rejected it in the Inbox.
  decided_at TEXT CHECK (decided_at IS strftime('%Y-%m-%dT%H:%M:%fZ', decided_at, '+0 seconds') AND decided_at GLOB '[0-9]*'),
  -- When it changed the data. A row with applied_at is an entry of the journal.
  applied_at TEXT CHECK (applied_at IS strftime('%Y-%m-%dT%H:%M:%fZ', applied_at, '+0 seconds') AND applied_at GLOB '[0-9]*'),
  -- Set when AUD-4 removed the material this operation came from.
  scrubbed_at TEXT CHECK (scrubbed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', scrubbed_at, '+0 seconds') AND scrubbed_at GLOB '[0-9]*'),
  -- The piece of the material it follows from, word for word (ING-5, ING-8).
  quote TEXT CHECK (quote <> ''),
  -- The owner's typed words that make it a command (the provenance guard of M1a-5).
  command_quote TEXT CHECK (command_quote <> ''),
  -- "Uzasadnienie".
  rationale TEXT,
  -- The owner's answer to an 'ask_user' operation (INB-3).
  answer TEXT CHECK (answer IS NULL OR (json_valid(answer) AND instr(answer, char(0)) = 0)),
  -- What the framework attached: duplicate candidates (ING-4), what the guards lowered and why.
  annotations TEXT CHECK (annotations IS NULL OR (json_valid(annotations) AND instr(annotations, char(0)) = 0)),
  -- Why the checks of ING-8 refused it.
  problems TEXT CHECK (problems IS NULL OR (json_valid(problems) AND instr(problems, char(0)) = 0)),
  -- What the agent proposed, kept when the owner changed fields or the target before accepting (INB-2).
  -- NULL means accepted as proposed: the metric of PRD chapter 12 and the corrections of ING-12 read it.
  proposed_payload TEXT CHECK (proposed_payload IS NULL OR (json_valid(proposed_payload) AND instr(proposed_payload, char(0)) = 0)),
  -- The input of the operation as validated: the identifiers of the objects it creates (assigned at
  -- staging, before anything is stored) and of the objects it changes, and the new values. Never a quote.
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object' AND instr(payload, char(0)) = 0),
  CHECK ((run_id IS NULL) = (seq IS NULL)),
  CHECK (state <> 'staged' OR run_id IS NOT NULL),
  CHECK ((applied_at IS NOT NULL) = (state IN ('applied', 'undone'))),
  CHECK ((approval IS NOT NULL) = (applied_at IS NOT NULL)),
  CHECK ((undone_by_id IS NOT NULL) = (state = 'undone')),
  CHECK (undone_by_id IS NULL OR undone_by_id <> id),
  CHECK (state <> 'rejected' OR decided_at IS NOT NULL),
  CHECK (state <> 'invalid' OR problems IS NOT NULL),
  CHECK (quote IS NULL OR source_id IS NOT NULL),
  CHECK (command_quote IS NULL OR source_id IS NOT NULL),
  CHECK (scrubbed_at IS NULL OR (quote IS NULL AND command_quote IS NULL))
) STRICT;
--> statement-breakpoint
-- The operations of a run in order: one Inbox card.
CREATE UNIQUE INDEX operations_by_run ON operations (run_id, seq) WHERE run_id IS NOT NULL;
--> statement-breakpoint
-- The Inbox: what waits for a decision, and the counter on every screen (INB-1, INB-4).
CREATE INDEX operations_pending ON operations (run_id) WHERE state IN ('proposed', 'invalid');
--> statement-breakpoint
-- The journal, newest first, with its filters by date, kind and way of approval (AUD-3).
CREATE INDEX operations_journal ON operations (applied_at, kind, approval) WHERE applied_at IS NOT NULL;
--> statement-breakpoint
-- Everything a source gave: reprocessing (ING-11), clearing at deletion (AUD-4).
CREATE INDEX operations_by_source ON operations (source_id) WHERE source_id IS NOT NULL;
--> statement-breakpoint
-- What one undo took back.
CREATE INDEX operations_undone_by ON operations (undone_by_id) WHERE undone_by_id IS NOT NULL;
--> statement-breakpoint
-- "Operation A needs operation B" (plan section 2): accepting A accepts B, rejecting B rejects A.
CREATE TABLE operation_dependencies (
  operation_id TEXT NOT NULL REFERENCES operations (id),
  depends_on_id TEXT NOT NULL REFERENCES operations (id),
  PRIMARY KEY (operation_id, depends_on_id),
  CHECK (operation_id <> depends_on_id)
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
-- The cascade of a rejection: who depends on this one?
CREATE INDEX operation_dependencies_reverse ON operation_dependencies (depends_on_id, operation_id);
--> statement-breakpoint
-- What an applied operation did, row by row and field by field (AUD-1 "stan przed i po"). Append-only.
-- Undo is the inverse of these rows; the timeline of an item, the journal's filters by item and person,
-- and the last activity of an item read them. Replayed in the order of id they give the tables of
-- sections 6 to 8 again.
CREATE TABLE operation_effects (
  -- The order of all changes: a logical clock that does not depend on the wall clock. The numbers run
  -- from 1 without a gap (section 12).
  id INTEGER PRIMARY KEY CHECK (id > 0),
  operation_id TEXT NOT NULL REFERENCES operations (id),
  -- Label, the table of the row in the singular: 'item', 'item_description', 'item_alias', 'item_person',
  -- 'person', 'person_alias', 'mention', 'fact', 'fact_person', 'source_link', and 'capture' for its event
  -- date; later packages add theirs.
  entity_kind TEXT NOT NULL CHECK (entity_kind GLOB '[a-z]*' AND entity_kind NOT GLOB '*[^a-z0-9_]*' AND instr(entity_kind, char(0)) = 0),
  -- The key of the row, as text that is not empty. No foreign key: the row may be gone (an undone
  -- creation), the effect stays.
  entity_id TEXT NOT NULL CHECK (entity_id <> ''),
  -- Structural: the checks below are built on it. 'touch' records that the operation concerned the row
  -- without changing it.
  change TEXT NOT NULL CHECK (change IN ('create', 'update', 'delete', 'touch')),
  -- The column, for an update.
  field TEXT CHECK (field <> ''),
  -- The item and the person the change is about, for the timeline, the journal's filters and the last
  -- activity. No foreign keys, for the same reason as entity_id; each has the shape of an id of its kind.
  item_id TEXT CHECK (item_id GLOB 'itm_?*' AND item_id NOT GLOB '*[^0-9a-z_]*' AND instr(item_id, char(0)) = 0),
  person_id TEXT CHECK (person_id GLOB 'per_?*' AND person_id NOT GLOB '*[^0-9a-z_]*' AND instr(person_id, char(0)) = 0),
  -- 1 when permanent deletion of a source removed the values.
  scrubbed INTEGER NOT NULL CHECK (scrubbed IN (0, 1)),
  -- JSON: the whole row for create and delete, one value for an update. JSON null means the column was
  -- NULL; SQL NULL means there is no value.
  before_value TEXT CHECK (before_value IS NULL OR (json_valid(before_value) AND instr(before_value, char(0)) = 0)),
  after_value TEXT CHECK (after_value IS NULL OR (json_valid(after_value) AND instr(after_value, char(0)) = 0)),
  CHECK ((change = 'update') = (field IS NOT NULL)),
  CHECK (change NOT IN ('create', 'touch') OR before_value IS NULL),
  CHECK (change NOT IN ('delete', 'touch') OR after_value IS NULL),
  CHECK (scrubbed = 1 OR change NOT IN ('update', 'delete') OR before_value IS NOT NULL),
  CHECK (scrubbed = 1 OR change NOT IN ('update', 'create') OR after_value IS NOT NULL)
) STRICT;
--> statement-breakpoint
-- The effects of one operation in order: undo, and the journal entry's "before and after".
CREATE INDEX operation_effects_by_operation ON operation_effects (operation_id, id);
--> statement-breakpoint
-- Later changes of the same row: may this operation be undone alone? (plan, M1a-5)
CREATE INDEX operation_effects_by_entity ON operation_effects (entity_id, id);
--> statement-breakpoint
-- The timeline of an item (ITM-7) and the journal's filter by item (AUD-3). entity_kind and change ride
-- along so that "the field changes of this item" is filtered inside the index, before any row is fetched.
CREATE INDEX operation_effects_by_item ON operation_effects (item_id, id, entity_kind, change) WHERE item_id IS NOT NULL;
--> statement-breakpoint
-- The journal's filter by person (AUD-3).
CREATE INDEX operation_effects_by_person ON operation_effects (person_id, id) WHERE person_id IS NOT NULL;
--> statement-breakpoint
-- -----------------------------------------------------------------------------------------------------
-- 11. Guards on what must not change. Each is a rule of the PRD or the plan that the database then
--     refuses to break. A trigger is replaced by dropping it and creating it again, two statements of a
--     migration: SQLite has no statement that changes a trigger in place. No table is rebuilt to change
--     a rule. The guards compare old and new values, so a statement that writes a row back unchanged
--     passes; the exceptions are capture_parts and capture_part_texts, which refuse every UPDATE, and
--     the three pairs at the end of the section (the hierarchy, closed_at, the schedule), which judge
--     the row as it will be and do not compare it with the row as it was.
--     INSERT OR REPLACE removes the old row without firing UPDATE or DELETE triggers, and UPDATE OR
--     REPLACE the row that stands in the way of a unique key. Seven tables therefore also refuse an
--     INSERT over the id of an existing row, whatever its conflict clause: sources, capture_parts,
--     capture_part_texts and facts here, runs, operations and operation_effects in section 12; parts,
--     revisions and runs refuse it over their other unique keys as well. A save that may run twice
--     looks first whether its row is there. The rows of every other table are safe from REPLACE only
--     because no statement of the application uses it.
-- -----------------------------------------------------------------------------------------------------

-- A registry row is written once and never deleted; afterwards only deleted_at can be set, once.
CREATE TRIGGER sources_no_replace BEFORE INSERT ON sources
WHEN EXISTS (SELECT 1 FROM sources WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'sources: the id is taken, and a row is never replaced'); END;
--> statement-breakpoint
CREATE TRIGGER sources_fixed BEFORE UPDATE ON sources
WHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT OLD.deleted_at)
BEGIN SELECT RAISE(ABORT, 'sources: a source keeps its id, kind and dates'); END;
--> statement-breakpoint
CREATE TRIGGER sources_no_delete BEFORE DELETE ON sources
BEGIN SELECT RAISE(ABORT, 'sources: a registry row is never deleted; it outlives its content'); END;
--> statement-breakpoint
-- What was recorded about a stored original stays as it is, and the row stays while a part uses the file.
-- The foreign key of the part says the second as well, but its check can be put off to the commit, and a
-- row that was deleted and written again in between would carry another size, type and date. The row can
-- go once no part uses the file, and the same content saved a second time finds its row: INSERT ... ON
-- CONFLICT DO NOTHING passes.
CREATE TRIGGER files_fixed BEFORE UPDATE ON files
WHEN NEW.sha256 IS NOT OLD.sha256 OR NEW.byte_size IS NOT OLD.byte_size
  OR NEW.media_type IS NOT OLD.media_type OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'files: a stored file keeps its hash, size, type and date'); END;
--> statement-breakpoint
CREATE TRIGGER files_delete_guard BEFORE DELETE ON files
WHEN EXISTS (SELECT 1 FROM capture_parts WHERE file_sha256 = OLD.sha256)
BEGIN SELECT RAISE(ABORT, 'files: a stored file is deleted only when no part uses it'); END;
--> statement-breakpoint
-- CAP-5: a capture is stored as it came and is never edited. Its parts go only when the source is deleted
-- for good: the registry row is marked first (deleted_at), and from then on the capture takes no new part,
-- so that nothing is written into a place that the deletion freed. The id of a deleted part is free again
-- for a part of another capture: the application gives every part a new id.
CREATE TRIGGER capture_parts_no_update BEFORE UPDATE ON capture_parts
BEGIN SELECT RAISE(ABORT, 'capture_parts: a capture is never edited'); END;
--> statement-breakpoint
CREATE TRIGGER capture_parts_no_replace BEFORE INSERT ON capture_parts
WHEN EXISTS (SELECT 1 FROM capture_parts
              WHERE id = NEW.id
                 OR (capture_id = NEW.capture_id AND (position = NEW.position OR (kind = 'typed' AND NEW.kind = 'typed'))))
BEGIN SELECT RAISE(ABORT, 'capture_parts: a capture is never edited'); END;
--> statement-breakpoint
CREATE TRIGGER capture_parts_source_not_deleted BEFORE INSERT ON capture_parts
WHEN (SELECT deleted_at FROM sources WHERE id = NEW.capture_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'capture_parts: a source that is marked deleted takes no new part'); END;
--> statement-breakpoint
CREATE TRIGGER capture_parts_delete_guard BEFORE DELETE ON capture_parts
WHEN (SELECT deleted_at FROM sources WHERE id = OLD.capture_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'capture_parts: a part is deleted only when its source is marked deleted'); END;
--> statement-breakpoint
-- Derived text is append-only: a correction is a new revision. Revisions go as parts do, when the source
-- is deleted for good, and a source that is marked deleted takes no new one.
CREATE TRIGGER capture_part_texts_no_update BEFORE UPDATE ON capture_part_texts
BEGIN SELECT RAISE(ABORT, 'capture_part_texts: a revision is never edited; add a new revision'); END;
--> statement-breakpoint
CREATE TRIGGER capture_part_texts_no_replace BEFORE INSERT ON capture_part_texts
WHEN EXISTS (SELECT 1 FROM capture_part_texts WHERE id = NEW.id OR (part_id = NEW.part_id AND revision = NEW.revision))
BEGIN SELECT RAISE(ABORT, 'capture_part_texts: a revision is never edited; add a new revision'); END;
--> statement-breakpoint
CREATE TRIGGER capture_part_texts_source_not_deleted BEFORE INSERT ON capture_part_texts
WHEN (SELECT s.deleted_at FROM capture_parts p JOIN sources s ON s.id = p.capture_id WHERE p.id = NEW.part_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'capture_part_texts: a source that is marked deleted takes no new revision'); END;
--> statement-breakpoint
CREATE TRIGGER capture_part_texts_delete_guard BEFORE DELETE ON capture_part_texts
WHEN (SELECT s.deleted_at FROM capture_parts p JOIN sources s ON s.id = p.capture_id WHERE p.id = OLD.part_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'capture_part_texts: a revision is deleted only when its source is marked deleted'); END;
--> statement-breakpoint
-- Principle 4: a fact starts with a source and a quote.
CREATE TRIGGER facts_start_with_source BEFORE INSERT ON facts
WHEN NEW.source_id IS NULL OR NEW.quote IS NULL
BEGIN SELECT RAISE(ABORT, 'facts: a fact starts with a source and a quote'); END;
--> statement-breakpoint
-- ITM-6: a fact is never edited. What may change: the item it belongs to (move, merge), the outdated mark
-- and its successor, and the quote, which can only be removed, and only once its source is marked deleted.
-- A fact can be deleted, which is how adding it is undone. Nothing here stops a new fact from taking the
-- id of a deleted one: the application gives every fact a new id.
CREATE TRIGGER facts_never_edited BEFORE UPDATE ON facts
WHEN NEW.id IS NOT OLD.id OR NEW.type IS NOT OLD.type OR NEW.text IS NOT OLD.text
  OR NEW.occurred_on IS NOT OLD.occurred_on OR NEW.occurred_on_approximate IS NOT OLD.occurred_on_approximate
  OR NEW.source_id IS NOT OLD.source_id OR NEW.created_at IS NOT OLD.created_at
  OR (NEW.quote IS NOT OLD.quote AND (NEW.quote IS NOT NULL
        OR (SELECT deleted_at FROM sources WHERE id = OLD.source_id) IS NULL))
BEGIN SELECT RAISE(ABORT, 'facts: a fact is never edited; mark it outdated and add the fact that replaces it'); END;
--> statement-breakpoint
CREATE TRIGGER facts_no_replace BEFORE INSERT ON facts
WHEN EXISTS (SELECT 1 FROM facts WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'facts: a fact is never edited; mark it outdated and add the fact that replaces it'); END;
--> statement-breakpoint
-- An item and a person keep their id. The guards of the merges below judge a row against the ids that the
-- other rows carry at that moment. A row that took another id afterwards, in a transaction that puts the
-- check of foreign keys off to the commit or by a replacing UPDATE, would stand where those guards let no
-- row be put: a merged row that another merged row points at, a fact on a merged item, a task under one.
-- And an effect names a row by its id without a foreign key. A statement that writes the id back as it is
-- passes.
CREATE TRIGGER items_id_fixed BEFORE UPDATE OF id ON items
WHEN NEW.id IS NOT OLD.id
BEGIN SELECT RAISE(ABORT, 'items: an item keeps its id'); END;
--> statement-breakpoint
CREATE TRIGGER persons_id_fixed BEFORE UPDATE OF id ON persons
WHEN NEW.id IS NOT OLD.id
BEGIN SELECT RAISE(ABORT, 'persons: a person keeps its id'); END;
--> statement-breakpoint
-- Merges. The survivor is not merged itself and no merged row is left pointing at a row that is being merged,
-- so a signpost resolves in one hop and two rows cannot hide each other; a row that is inserted as merged is
-- held to the same. A merged row takes no new rows: an operation merges by moving first and marking last, and
-- its inverse then unmarks first. The guards judge a row when it is written, against the rows that are there:
-- what stayed on a row that was marked first is not judged, nor is a row that was written, with the check of
-- foreign keys put off or switched off, before the item or the person it names arrived as a merged row. The
-- fields of a merged row can still be written, and so can the rows that stayed on it: before it changes an
-- item, a person or a description, the application looks whether the row was merged. A merged row that no row
-- points at can be deleted like any other: that it stays as the signpost is the application's doing.
CREATE TRIGGER items_merge_guard BEFORE UPDATE OF merged_into_id ON items
WHEN NEW.merged_into_id IS NOT NULL AND NEW.merged_into_id IS NOT OLD.merged_into_id AND (
     (SELECT merged_into_id FROM items WHERE id = NEW.merged_into_id) IS NOT NULL
  OR EXISTS (SELECT 1 FROM items WHERE merged_into_id = OLD.id))
BEGIN SELECT RAISE(ABORT, 'items: merge into an item that is not merged, after re-pointing what was merged into this one'); END;
--> statement-breakpoint
CREATE TRIGGER items_merge_guard_insert BEFORE INSERT ON items
WHEN NEW.merged_into_id IS NOT NULL AND (
     (SELECT merged_into_id FROM items WHERE id = NEW.merged_into_id) IS NOT NULL
  OR EXISTS (SELECT 1 FROM items WHERE merged_into_id = NEW.id))
BEGIN SELECT RAISE(ABORT, 'items: merge into an item that is not merged, after re-pointing what was merged into this one'); END;
--> statement-breakpoint
CREATE TRIGGER persons_merge_guard BEFORE UPDATE OF merged_into_id ON persons
WHEN NEW.merged_into_id IS NOT NULL AND NEW.merged_into_id IS NOT OLD.merged_into_id AND (
     (SELECT merged_into_id FROM persons WHERE id = NEW.merged_into_id) IS NOT NULL
  OR EXISTS (SELECT 1 FROM persons WHERE merged_into_id = OLD.id))
BEGIN SELECT RAISE(ABORT, 'persons: merge into a person that is not merged, after re-pointing who was merged into this one'); END;
--> statement-breakpoint
CREATE TRIGGER persons_merge_guard_insert BEFORE INSERT ON persons
WHEN NEW.merged_into_id IS NOT NULL AND (
     (SELECT merged_into_id FROM persons WHERE id = NEW.merged_into_id) IS NOT NULL
  OR EXISTS (SELECT 1 FROM persons WHERE merged_into_id = NEW.id))
BEGIN SELECT RAISE(ABORT, 'persons: merge into a person that is not merged, after re-pointing who was merged into this one'); END;
--> statement-breakpoint
CREATE TRIGGER facts_item_not_merged_insert BEFORE INSERT ON facts
WHEN (SELECT merged_into_id FROM items WHERE id = NEW.item_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'facts: the item was merged into another one'); END;
--> statement-breakpoint
CREATE TRIGGER facts_item_not_merged_update BEFORE UPDATE OF item_id ON facts
WHEN NEW.item_id IS NOT OLD.item_id AND (SELECT merged_into_id FROM items WHERE id = NEW.item_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'facts: the item was merged into another one'); END;
--> statement-breakpoint
CREATE TRIGGER source_links_item_not_merged_insert BEFORE INSERT ON source_links
WHEN (SELECT merged_into_id FROM items WHERE id = NEW.item_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'source_links: the item was merged into another one'); END;
--> statement-breakpoint
CREATE TRIGGER source_links_item_not_merged_update BEFORE UPDATE OF item_id ON source_links
WHEN NEW.item_id IS NOT OLD.item_id AND (SELECT merged_into_id FROM items WHERE id = NEW.item_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'source_links: the item was merged into another one'); END;
--> statement-breakpoint
CREATE TRIGGER item_persons_not_merged_insert BEFORE INSERT ON item_persons
WHEN (SELECT merged_into_id FROM items WHERE id = NEW.item_id) IS NOT NULL
  OR (SELECT merged_into_id FROM persons WHERE id = NEW.person_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'item_persons: the item or the person was merged into another one'); END;
--> statement-breakpoint
CREATE TRIGGER item_persons_not_merged_update BEFORE UPDATE OF item_id, person_id ON item_persons
WHEN (NEW.item_id IS NOT OLD.item_id AND (SELECT merged_into_id FROM items WHERE id = NEW.item_id) IS NOT NULL)
  OR (NEW.person_id IS NOT OLD.person_id AND (SELECT merged_into_id FROM persons WHERE id = NEW.person_id) IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'item_persons: the item or the person was merged into another one'); END;
--> statement-breakpoint
CREATE TRIGGER item_aliases_item_not_merged_insert BEFORE INSERT ON item_aliases
WHEN (SELECT merged_into_id FROM items WHERE id = NEW.item_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'item_aliases: the item was merged into another one'); END;
--> statement-breakpoint
CREATE TRIGGER item_aliases_item_not_merged_update BEFORE UPDATE OF item_id ON item_aliases
WHEN NEW.item_id IS NOT OLD.item_id AND (SELECT merged_into_id FROM items WHERE id = NEW.item_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'item_aliases: the item was merged into another one'); END;
--> statement-breakpoint
CREATE TRIGGER item_descriptions_item_not_merged_insert BEFORE INSERT ON item_descriptions
WHEN (SELECT merged_into_id FROM items WHERE id = NEW.item_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'item_descriptions: the item was merged into another one'); END;
--> statement-breakpoint
CREATE TRIGGER item_descriptions_item_not_merged_update BEFORE UPDATE OF item_id ON item_descriptions
WHEN NEW.item_id IS NOT OLD.item_id AND (SELECT merged_into_id FROM items WHERE id = NEW.item_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'item_descriptions: the item was merged into another one'); END;
--> statement-breakpoint
CREATE TRIGGER person_aliases_person_not_merged_insert BEFORE INSERT ON person_aliases
WHEN (SELECT merged_into_id FROM persons WHERE id = NEW.person_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'person_aliases: the person was merged into another one'); END;
--> statement-breakpoint
CREATE TRIGGER person_aliases_person_not_merged_update BEFORE UPDATE OF person_id ON person_aliases
WHEN NEW.person_id IS NOT OLD.person_id AND (SELECT merged_into_id FROM persons WHERE id = NEW.person_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'person_aliases: the person was merged into another one'); END;
--> statement-breakpoint
CREATE TRIGGER fact_persons_person_not_merged_insert BEFORE INSERT ON fact_persons
WHEN (SELECT merged_into_id FROM persons WHERE id = NEW.person_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'fact_persons: the person was merged into another one'); END;
--> statement-breakpoint
CREATE TRIGGER fact_persons_person_not_merged_update BEFORE UPDATE OF person_id ON fact_persons
WHEN NEW.person_id IS NOT OLD.person_id AND (SELECT merged_into_id FROM persons WHERE id = NEW.person_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'fact_persons: the person was merged into another one'); END;
--> statement-breakpoint
CREATE TRIGGER mentions_person_not_merged_insert BEFORE INSERT ON mentions
WHEN (SELECT merged_into_id FROM persons WHERE id = NEW.person_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'mentions: the person was merged into another one'); END;
--> statement-breakpoint
CREATE TRIGGER mentions_person_not_merged_update BEFORE UPDATE OF person_id ON mentions
WHEN NEW.person_id IS NOT OLD.person_id AND (SELECT merged_into_id FROM persons WHERE id = NEW.person_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'mentions: the person was merged into another one'); END;
--> statement-breakpoint
CREATE TRIGGER items_parent_not_merged_insert BEFORE INSERT ON items
WHEN NEW.parent_id IS NOT NULL AND (SELECT merged_into_id FROM items WHERE id = NEW.parent_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'items: the parent was merged into another item'); END;
--> statement-breakpoint
CREATE TRIGGER items_parent_not_merged_update BEFORE UPDATE OF parent_id ON items
WHEN NEW.parent_id IS NOT NULL AND NEW.parent_id IS NOT OLD.parent_id
 AND (SELECT merged_into_id FROM items WHERE id = NEW.parent_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'items: the parent was merged into another item'); END;
--> statement-breakpoint
-- The hierarchy of items (ITM-4). A project is the top of a tree and has no parent; a task stands alone, sits
-- in a project or sits under another task, to any depth; no item is its own ancestor. Triggers and not table
-- constraints, as for the schedule below: a rule of the tree (a project under a project, a limit of depth)
-- then changes by replacing the pair, and items is not rebuilt for it. That the parent exists is the foreign
-- key of parent_id; that an item is not put directly under a merged one, the two guards above.
-- The pair judges the row as it will be and does not compare it with the row as it was. The walk goes up from
-- the new parent, one row a level, by the primary key: it costs the depth of the parent, whatever the size of
-- the tree, and it starts at the parent, so a row that names itself is found at once. It runs for an INSERT as
-- well: a new row can name itself, a replacing INSERT can put an item under what sits under it, and with
-- foreign keys deferred or off a child can be written before its parent. UNION and not UNION ALL, so that the
-- walk ends on any data. The trigger of UPDATE is also asked when the id is written, although an item keeps
-- its id (above): the rule of the tree does not rest on that guard.
CREATE TRIGGER items_hierarchy_insert BEFORE INSERT ON items
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'items: a project has no parent')
   WHERE NEW.kind = 'project';
  SELECT RAISE(ABORT, 'items: an item is not its own ancestor')
   WHERE EXISTS (
     WITH RECURSIVE ancestors (id) AS (
       SELECT NEW.parent_id
       UNION
       SELECT i.parent_id FROM items i JOIN ancestors ON i.id = ancestors.id WHERE i.parent_id IS NOT NULL)
     SELECT 1 FROM ancestors WHERE id = NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER items_hierarchy_update BEFORE UPDATE OF id, kind, parent_id ON items
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'items: a project has no parent')
   WHERE NEW.kind = 'project';
  SELECT RAISE(ABORT, 'items: an item is not its own ancestor')
   WHERE EXISTS (
     WITH RECURSIVE ancestors (id) AS (
       SELECT NEW.parent_id
       UNION
       SELECT i.parent_id FROM items i JOIN ancestors ON i.id = ancestors.id WHERE i.parent_id IS NOT NULL)
     SELECT 1 FROM ancestors WHERE id = NEW.id);
END;
--> statement-breakpoint
-- closed_at is set exactly when the status is a closed one. (A status that does not exist is left to the
-- foreign key, which says so.) The rule is asked when an item is inserted and when its status or its
-- closed_at is written, not when the closed mark of a status changes: a migration that changes the mark
-- fixes the closing times in the same step.
CREATE TRIGGER items_closed_at_insert BEFORE INSERT ON items
WHEN (NEW.closed_at IS NOT NULL) <> (SELECT is_closed FROM item_statuses WHERE code = NEW.status)
BEGIN SELECT RAISE(ABORT, 'items: closed_at is set exactly when the status is a closed one'); END;
--> statement-breakpoint
CREATE TRIGGER items_closed_at_update BEFORE UPDATE OF status, closed_at ON items
WHEN (NEW.closed_at IS NOT NULL) <> (SELECT is_closed FROM item_statuses WHERE code = NEW.status)
BEGIN SELECT RAISE(ABORT, 'items: closed_at is set exactly when the status is a closed one'); END;
--> statement-breakpoint
-- The schedule of an item (SCH-1, SCH-2): start_on and due_on with their precisions, and is_milestone. A
-- precision is about a day that is set, and a milestone is a task, at any depth, without a start. Triggers
-- and not table CHECKs: a rule of the schedule then changes by replacing the two triggers, and items, the
-- table everything refers to, is not rebuilt for it. They look at the new row only: a migration that makes
-- a rule stricter repairs the rows that break it in the same step.
CREATE TRIGGER items_schedule_insert BEFORE INSERT ON items
BEGIN
  SELECT RAISE(ABORT, 'items: a precision is about a day that is set')
   WHERE (NEW.start_on_precision IS NOT NULL AND NEW.start_on IS NULL)
      OR (NEW.due_on_precision IS NOT NULL AND NEW.due_on IS NULL);
  SELECT RAISE(ABORT, 'items: a milestone is a point in time and has no start')
   WHERE NEW.is_milestone = 1 AND NEW.start_on IS NOT NULL;
  SELECT RAISE(ABORT, 'items: a project is not a milestone')
   WHERE NEW.is_milestone = 1 AND NEW.kind = 'project';
END;
--> statement-breakpoint
CREATE TRIGGER items_schedule_update
BEFORE UPDATE OF kind, start_on, start_on_precision, due_on, due_on_precision, is_milestone ON items
BEGIN
  SELECT RAISE(ABORT, 'items: a precision is about a day that is set')
   WHERE (NEW.start_on_precision IS NOT NULL AND NEW.start_on IS NULL)
      OR (NEW.due_on_precision IS NOT NULL AND NEW.due_on IS NULL);
  SELECT RAISE(ABORT, 'items: a milestone is a point in time and has no start')
   WHERE NEW.is_milestone = 1 AND NEW.start_on IS NOT NULL;
  SELECT RAISE(ABORT, 'items: a project is not a milestone')
   WHERE NEW.is_milestone = 1 AND NEW.kind = 'project';
END;
--> statement-breakpoint
-- -----------------------------------------------------------------------------------------------------
-- 12. Guards on how the journal moves, and the last activity of an item. Two tables of this section
--     refuse an UPDATE that writes a row back as it is: an edge between operations is never updated, and
--     an effect only to lose its values.
-- -----------------------------------------------------------------------------------------------------

-- A run row is inserted once and never deleted. Written again under its id it would put a committed run
-- back to running, and REPLACE would remove the committed run of a job to make room for another, in an
-- INSERT or in the UPDATE that commits a second run of the job: all of these are refused.
-- The look-ups have the states written out: a partial index is only used when its state is in the text of
-- the query, and "state = NEW.state" made the first trigger read every run (12 ms an insert at three years).
CREATE TRIGGER runs_no_replace BEFORE INSERT ON runs
WHEN EXISTS (SELECT 1 FROM runs WHERE id = NEW.id)
  OR (NEW.state = 'committed' AND EXISTS (SELECT 1 FROM runs WHERE job_id = NEW.job_id AND state = 'committed'))
  OR (NEW.state = 'running' AND EXISTS (SELECT 1 FROM runs WHERE job_id = NEW.job_id AND state = 'running'))
BEGIN SELECT RAISE(ABORT, 'runs: the id is taken or the job already has such a run, and a row is never replaced'); END;
--> statement-breakpoint
CREATE TRIGGER runs_one_commit_guard BEFORE UPDATE OF state ON runs
WHEN NEW.state = 'committed' AND OLD.state IS NOT 'committed'
 AND EXISTS (SELECT 1 FROM runs WHERE job_id = NEW.job_id AND state = 'committed')
BEGIN SELECT RAISE(ABORT, 'runs: the id is taken or the job already has such a run, and a row is never replaced'); END;
--> statement-breakpoint
CREATE TRIGGER runs_no_delete BEFORE DELETE ON runs
BEGIN SELECT RAISE(ABORT, 'runs: a run is never deleted'); END;
--> statement-breakpoint
-- What a run is never changes: its operations, its Inbox card and its cost hang on these columns.
CREATE TRIGGER runs_identity_guard BEFORE UPDATE ON runs
WHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR NEW.source_id IS NOT OLD.source_id
  OR NEW.job_id IS NOT OLD.job_id OR NEW.started_at IS NOT OLD.started_at
  OR (OLD.state <> 'running' AND (NEW.ended_at IS NOT OLD.ended_at OR NEW.model IS NOT OLD.model
        OR NEW.prompt_version IS NOT OLD.prompt_version OR NEW.error_code IS NOT OLD.error_code
        OR (NEW.summary IS NOT OLD.summary AND NEW.summary IS NOT NULL)
        OR (NEW.error_message IS NOT OLD.error_message AND NEW.error_message IS NOT NULL)))
BEGIN SELECT RAISE(ABORT, 'runs: what a run is never changes; after it ended only its texts can be removed'); END;
--> statement-breakpoint
-- A run that has ended stays as it ended.
CREATE TRIGGER runs_state_guard BEFORE UPDATE OF state ON runs
WHEN OLD.state <> 'running' AND NEW.state IS NOT OLD.state
BEGIN SELECT RAISE(ABORT, 'runs: a run that has ended does not change state'); END;
--> statement-breakpoint
-- A run that ends without being committed leaves nothing: what it staged goes with it (M1a-5: "przerwany
-- przebieg nie zostawia żadnej zmiany").
CREATE TRIGGER runs_discard_staged AFTER UPDATE OF state ON runs
WHEN OLD.state = 'running' AND NEW.state NOT IN ('running', 'committed')
BEGIN
  DELETE FROM operation_dependencies
   WHERE operation_id IN (SELECT id FROM operations WHERE run_id = NEW.id AND state = 'staged')
      OR depends_on_id IN (SELECT id FROM operations WHERE run_id = NEW.id AND state = 'staged');
  DELETE FROM operations WHERE run_id = NEW.id AND state = 'staged';
END;
--> statement-breakpoint
-- An operation of a run starts staged, while the run is running. An operation without a run (a manual
-- edit, an undo) is applied by the statement that inserts it. A command carries the owner's words.
CREATE TRIGGER operations_insert_guard BEFORE INSERT ON operations
BEGIN
  SELECT RAISE(ABORT, 'operations: the id is taken, and a row is never replaced')
   WHERE EXISTS (SELECT 1 FROM operations WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'operations: a run stages its operations while it is running')
   WHERE NEW.run_id IS NOT NULL
     AND NOT (NEW.state = 'staged' AND (SELECT state FROM runs WHERE id = NEW.run_id) IS 'running');
  SELECT RAISE(ABORT, 'operations: an operation without a run is inserted as applied')
   WHERE NEW.run_id IS NULL AND NEW.state <> 'applied';
  SELECT RAISE(ABORT, 'operations: origin command needs the quote of the command')
   WHERE NEW.origin = 'command' AND NEW.command_quote IS NULL;
END;
--> statement-breakpoint
-- The life cycle. Staged operations move on only after their run is committed ("finish").
CREATE TRIGGER operations_state_guard BEFORE UPDATE OF state ON operations
WHEN NEW.state IS NOT OLD.state AND NOT (
     (OLD.state = 'staged' AND NEW.state IN ('proposed', 'applied', 'invalid')
        AND (SELECT state FROM runs WHERE id = OLD.run_id) IS 'committed')
  OR (OLD.state = 'proposed' AND NEW.state IN ('applied', 'rejected', 'invalid'))
  OR (OLD.state = 'invalid' AND NEW.state IN ('applied', 'rejected', 'proposed'))
  OR (OLD.state = 'applied' AND NEW.state = 'undone' AND OLD.kind <> 'undo'
        AND (SELECT kind || ' ' || state FROM operations WHERE id = NEW.undone_by_id) IS 'undo applied'))
BEGIN SELECT RAISE(ABORT, 'operations: illegal state transition'); END;
--> statement-breakpoint
-- Dependencies. What an operation depends on is applied first; what depends on it is rejected or undone
-- first. A cascade that forgets a member fails instead of leaving it behind.
CREATE TRIGGER operations_dependency_guard BEFORE UPDATE OF state ON operations
WHEN NEW.state IS NOT OLD.state AND (
     (NEW.state = 'applied' AND EXISTS (
        SELECT 1 FROM operation_dependencies d JOIN operations p ON p.id = d.depends_on_id
         WHERE d.operation_id = NEW.id AND p.state <> 'applied'))
  OR (NEW.state IN ('rejected', 'undone') AND EXISTS (
        SELECT 1 FROM operation_dependencies d JOIN operations c ON c.id = d.operation_id
         WHERE d.depends_on_id = NEW.id AND c.state NOT IN ('rejected', 'undone'))))
BEGIN SELECT RAISE(ABORT, 'operations: dependency order (apply what it depends on first; reject or undo what depends on it first)'); END;
--> statement-breakpoint
-- An edge never closes a cycle: operations in a cycle could be neither applied nor rejected. The walk follows
-- "needs" from the operation that would be depended on; any other edge is accepted, also one to an operation
-- staged later in the same run (the owner re-links a proposal to an item proposed further down the card).
-- An edge is added only while the operation that needs something is undecided, and removed only then or
-- while what it leads to is still staged: the order of applying, rejecting and undoing rests on the edges,
-- so those of a decided operation are history. The exception lets a run that ends without being committed
-- take along the edges that lead to what it staged.
CREATE TRIGGER operation_dependencies_insert_guard BEFORE INSERT ON operation_dependencies
WHEN (SELECT state FROM operations WHERE id = NEW.operation_id) IN ('applied', 'rejected', 'undone')
BEGIN SELECT RAISE(ABORT, 'operation_dependencies: the edges of a decided operation are history'); END;
--> statement-breakpoint
CREATE TRIGGER operation_dependencies_no_cycle BEFORE INSERT ON operation_dependencies
WHEN EXISTS (
  WITH RECURSIVE needs (id) AS (
    SELECT NEW.depends_on_id
    UNION
    SELECT d.depends_on_id FROM operation_dependencies d JOIN needs ON d.operation_id = needs.id)
  SELECT 1 FROM needs WHERE id = NEW.operation_id)
BEGIN SELECT RAISE(ABORT, 'operation_dependencies: the edge would close a cycle'); END;
--> statement-breakpoint
CREATE TRIGGER operation_dependencies_delete_guard BEFORE DELETE ON operation_dependencies
WHEN (SELECT state FROM operations WHERE id = OLD.operation_id) IN ('applied', 'rejected', 'undone')
 AND (SELECT state FROM operations WHERE id = OLD.depends_on_id) IS NOT 'staged'
BEGIN SELECT RAISE(ABORT, 'operation_dependencies: the edges of a decided operation are history'); END;
--> statement-breakpoint
CREATE TRIGGER operation_dependencies_no_update BEFORE UPDATE ON operation_dependencies
BEGIN SELECT RAISE(ABORT, 'operation_dependencies: an edge is added or removed, never changed'); END;
--> statement-breakpoint
-- What an operation is never changes.
CREATE TRIGGER operations_identity_guard BEFORE UPDATE ON operations
WHEN NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.seq IS NOT OLD.seq
  OR NEW.kind IS NOT OLD.kind OR NEW.origin IS NOT OLD.origin OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'operations: what an operation is never changes'); END;
--> statement-breakpoint
-- Once decided, an operation is history: its text can be removed (permanent deletion of the source), not
-- rewritten, and the payload changes once, in the statement that sets the scrub mark.
CREATE TRIGGER operations_history_guard BEFORE UPDATE ON operations
WHEN OLD.state IN ('applied', 'undone', 'rejected') AND (
     NEW.source_id IS NOT OLD.source_id OR NEW.confidence IS NOT OLD.confidence
  OR NEW.approval IS NOT OLD.approval OR NEW.decided_at IS NOT OLD.decided_at
  OR NEW.applied_at IS NOT OLD.applied_at
  OR (OLD.state = 'undone' AND NEW.undone_by_id IS NOT OLD.undone_by_id)
  OR (NEW.quote IS NOT OLD.quote AND NEW.quote IS NOT NULL)
  OR (NEW.command_quote IS NOT OLD.command_quote AND NEW.command_quote IS NOT NULL)
  OR (NEW.rationale IS NOT OLD.rationale AND NEW.rationale IS NOT NULL)
  OR (NEW.answer IS NOT OLD.answer AND NEW.answer IS NOT NULL)
  OR (NEW.annotations IS NOT OLD.annotations AND NEW.annotations IS NOT NULL)
  OR (NEW.problems IS NOT OLD.problems AND NEW.problems IS NOT NULL)
  OR (NEW.proposed_payload IS NOT OLD.proposed_payload AND NEW.proposed_payload IS NOT NULL)
  OR (NEW.payload IS NOT OLD.payload AND (NEW.scrubbed_at IS NULL OR OLD.scrubbed_at IS NOT NULL))
  OR (OLD.scrubbed_at IS NOT NULL AND NEW.scrubbed_at IS NOT OLD.scrubbed_at))
BEGIN SELECT RAISE(ABORT, 'operations: a decided operation is history; its text can be removed, not rewritten'); END;
--> statement-breakpoint
-- A command has the owner's words for as long as it carries no scrub mark: permanent deletion removes them
-- in the statement that sets the mark, and the mark does not come off again while they are gone.
CREATE TRIGGER operations_command_quote_guard BEFORE UPDATE OF command_quote, scrubbed_at ON operations
WHEN NEW.origin = 'command' AND NEW.command_quote IS NULL AND NEW.scrubbed_at IS NULL
BEGIN SELECT RAISE(ABORT, 'operations: origin command needs the quote of the command'); END;
--> statement-breakpoint
-- Only what a run staged and has not committed is ever deleted: by a statement while the run is running, or
-- by the run's own end without a commit.
CREATE TRIGGER operations_delete_guard BEFORE DELETE ON operations
WHEN OLD.state <> 'staged' OR (SELECT state FROM runs WHERE id = OLD.run_id) IS 'committed'
BEGIN SELECT RAISE(ABORT, 'operations: only staged operations are deleted, and only until their run is committed'); END;
--> statement-breakpoint
-- Effects belong to applied operations and are append-only. An effect can lose its values (scrubbed = 1)
-- and nothing else.
CREATE TRIGGER operation_effects_insert_guard BEFORE INSERT ON operation_effects
BEGIN
  SELECT RAISE(ABORT, 'operation_effects: effects are append-only')
   WHERE NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM operation_effects WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'operation_effects: only an applied operation has effects')
   WHERE (SELECT state FROM operations WHERE id = NEW.operation_id) IS NOT 'applied';
END;
--> statement-breakpoint
-- A new effect takes the number after the newest one, from the database or from the statement, so the ids
-- run from 1 without a gap. An effect far ahead, at the last number there is, would leave none for the
-- effects after it.
CREATE TRIGGER operation_effects_in_order AFTER INSERT ON operation_effects
WHEN (NEW.id > 1 AND NOT EXISTS (SELECT 1 FROM operation_effects WHERE id = NEW.id - 1))
  OR EXISTS (SELECT 1 FROM operation_effects WHERE id > NEW.id)
BEGIN SELECT RAISE(ABORT, 'operation_effects: the id is the order of all changes; a new effect takes the next one'); END;
--> statement-breakpoint
CREATE TRIGGER operation_effects_update_guard BEFORE UPDATE ON operation_effects
WHEN NOT (NEW.scrubbed = 1 AND NEW.before_value IS NULL AND NEW.after_value IS NULL
      AND NEW.id IS OLD.id AND NEW.operation_id IS OLD.operation_id
      AND NEW.entity_kind IS OLD.entity_kind AND NEW.entity_id IS OLD.entity_id
      AND NEW.change IS OLD.change AND NEW.field IS OLD.field
      AND NEW.item_id IS OLD.item_id AND NEW.person_id IS OLD.person_id)
BEGIN SELECT RAISE(ABORT, 'operation_effects: effects are append-only; an effect can only be scrubbed'); END;
--> statement-breakpoint
CREATE TRIGGER operation_effects_delete_guard BEFORE DELETE ON operation_effects
BEGIN SELECT RAISE(ABORT, 'operation_effects: effects are append-only'); END;
--> statement-breakpoint
-- The last activity of an item (plan, M1a-4: "utrzymywana przy każdej operacji"): the instant at which the
-- newest operation in force that concerned the item itself was applied. An operation concerns an item when
-- one of its effects carries the item in item_id. "In force" leaves out operations that were undone and the
-- undo itself, so apply-then-undo gives the item back the date it had. The value never comes from the clock.
-- An effect moves the date forward and never back. After the undo of an operation that was applied at or
-- after the date, the date is that of the operation in force with the newest effect on the item, by the id
-- of the effect; where there is none, or it was applied before the item was created, the date is the
-- creation of the item. The undo of an earlier operation leaves the date as it is. So "newest" goes by the
-- order of the effects. Where an operation in force was applied later than the one with the newest effect,
-- because the clock stepped back or an effect was written late, the date can fall behind that operation
-- after an undo.
CREATE TRIGGER operation_effects_item_activity AFTER INSERT ON operation_effects
WHEN NEW.item_id IS NOT NULL
 AND (SELECT kind FROM operations WHERE id = NEW.operation_id) IS NOT 'undo'
BEGIN
  UPDATE items
     SET last_activity_at = (SELECT applied_at FROM operations WHERE id = NEW.operation_id)
   WHERE id = NEW.item_id
     AND last_activity_at < (SELECT applied_at FROM operations WHERE id = NEW.operation_id);
END;
--> statement-breakpoint
CREATE TRIGGER operations_undone_item_activity AFTER UPDATE OF state ON operations
WHEN NEW.state = 'undone' AND OLD.state = 'applied'
BEGIN
  UPDATE items
     SET last_activity_at = max(created_at, coalesce(
           (SELECT o.applied_at
              FROM operation_effects e JOIN operations o ON o.id = e.operation_id
             WHERE e.item_id = items.id AND o.state = 'applied' AND o.kind <> 'undo'
             ORDER BY e.id DESC LIMIT 1),
           created_at))
   WHERE id IN (SELECT item_id FROM operation_effects WHERE operation_id = NEW.id AND item_id IS NOT NULL)
     AND last_activity_at <= OLD.applied_at;
END;
