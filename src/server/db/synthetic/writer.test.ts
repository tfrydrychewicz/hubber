import { afterEach, describe, expect, it } from "vitest";
import type { CaptureId, ItemId, OperationId } from "../../../shared/ids.ts";
import { createTestDatabase, type TestDatabase } from "../testing.ts";
import type { Change, ItemFields, Sink, WorldCapture, WorldOperation } from "./world.ts";
import { createWriter } from "./writer.ts";

const AT = Date.parse("2026-10-12T09:00:00.000Z");

const databases: TestDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function writing(): TestDatabase & { sink: Sink; rows: <Row>(sql: string) => Row[] } {
  const database = createTestDatabase();
  databases.push(database);
  return {
    ...database,
    sink: createWriter(database.db),
    rows: <Row>(sql: string) => database.connection.prepare(sql).all() as Row[],
  };
}

const item = (id: ItemId, more: Partial<ItemFields> = {}): ItemFields => ({
  id,
  kind: "task",
  parentId: null,
  title: "Sprawdzić licencję",
  status: "todo",
  importance: "normal",
  health: null,
  myRole: null,
  myRoleSetOn: null,
  startOn: null,
  startOnPrecision: null,
  dueOn: null,
  dueOnPrecision: null,
  isMilestone: false,
  externalSystem: null,
  externalKey: null,
  externalUrl: null,
  mergedIntoId: null,
  createdAt: AT,
  closedAt: null,
  ...more,
});
/** An operation as the owner makes one by hand: applied by the statement that inserts it. */
const byHand = (id: OperationId, at = AT): WorldOperation => ({
  id,
  runId: null,
  seq: null,
  kind: "update_item",
  origin: "user",
  state: "applied",
  confidence: null,
  approval: "manual",
  sourceId: null,
  undoneById: null,
  createdAt: at,
  decidedAt: null,
  appliedAt: at,
  quote: null,
  commandQuote: null,
  rationale: null,
  answer: null,
  annotations: null,
  problems: null,
  proposedPayload: null,
  payload: {},
});
const capture = (id: CaptureId): WorldCapture => ({
  id,
  createdAt: AT,
  occurredOn: "2026-10-12" as WorldCapture["occurredOn"],
  occurredOnApproximate: true,
  parts: [
    { id: "prt_1", position: 0, kind: "typed", text: "zobacz", file: null, fileName: null },
    {
      id: "prt_2",
      position: 1,
      kind: "image",
      text: null,
      file: { sha256: "9c".repeat(32), byteSize: 90_211, mediaType: "image/png", createdAt: AT },
      fileName: "watek.png",
    },
  ],
});

interface Effect {
  id: number;
  operation_id: string;
  entity_kind: string;
  entity_id: string;
  change: string;
  field: string | null;
  item_id: string | null;
  person_id: string | null;
  before_value: string | null;
  after_value: string | null;
}
const EFFECTS = "SELECT * FROM operation_effects ORDER BY id";

describe("createWriter", () => {
  it("writes a created row and the effect that records it, without what follows from the row itself", () => {
    const { sink, rows } = writing();
    const created = item("itm_1", { dueOn: "2026-10-16" as ItemFields["dueOn"], dueOnPrecision: "approximate" });
    const operation = byHand("opr_1");

    sink.operation(operation, []);
    sink.changes(operation, [{ kind: "item", change: "create", row: created, item: "itm_1", person: null }]);

    expect(rows("SELECT id, title, title_norm, is_milestone, created_at, last_activity_at FROM items")).toEqual([
      {
        id: "itm_1",
        title: "Sprawdzić licencję",
        title_norm: "sprawdzic licencje",
        is_milestone: 0,
        created_at: "2026-10-12T09:00:00.000Z",
        last_activity_at: "2026-10-12T09:00:00.000Z",
      },
    ]);
    const [effect, ...others] = rows<Effect>(EFFECTS);
    expect(others).toEqual([]);
    expect(effect).toMatchObject({
      id: 1,
      operation_id: "opr_1",
      entity_kind: "item",
      entity_id: "itm_1",
      change: "create",
      field: null,
      item_id: "itm_1",
      person_id: null,
      before_value: null,
    });
    const recorded = JSON.parse(effect?.after_value ?? "") as Record<string, unknown>;
    // The row as the table stores it, under the names of its columns: the five of the schedule among them.
    expect(recorded).toMatchObject({
      id: "itm_1",
      kind: "task",
      parent_id: null,
      start_on: null,
      start_on_precision: null,
      due_on: "2026-10-16",
      due_on_precision: "approximate",
      is_milestone: 0,
      created_at: "2026-10-12T09:00:00.000Z",
    });
    // What is derived from other columns is in no effect: a later version of the folding may spell it otherwise.
    expect(Object.keys(recorded)).not.toContain("title_norm");
    expect(Object.keys(recorded)).not.toContain("last_activity_at");
  });

  it("writes an update as one statement, with an effect for every column that changed", () => {
    const { sink, rows, connection } = writing();
    const row = item("itm_1", {
      startOn: "2026-10-12" as ItemFields["startOn"],
      dueOn: "2026-10-16" as ItemFields["dueOn"],
    });
    const creation = byHand("opr_1");
    sink.operation(creation, []);
    sink.changes(creation, [{ kind: "item", change: "create", row, item: "itm_1", person: null }]);
    // Marking a task with a period as a milestone removes its start: either half alone is refused
    // by the database, so only one statement for both can pass.
    const mark = byHand("opr_2", AT + 60_000);
    const was = { isMilestone: false, startOn: row.startOn, title: row.title };
    Object.assign(row, { isMilestone: true, startOn: null, title: "Podpisanie umowy" });

    sink.operation(mark, []);
    sink.changes(mark, [{ kind: "item", change: "update", row, was, item: "itm_1", person: null }]);

    expect(rows("SELECT is_milestone, start_on, title, title_norm, last_activity_at FROM items")).toEqual([
      {
        is_milestone: 1,
        start_on: null,
        title: "Podpisanie umowy",
        // The folded spelling goes where the name goes.
        title_norm: "podpisanie umowy",
        // Kept by the trigger of the journal: the instant of the operation that concerned the item.
        last_activity_at: "2026-10-12T09:01:00.000Z",
      },
    ]);
    expect(
      rows<Effect>(EFFECTS)
        .filter((effect) => effect.operation_id === "opr_2")
        .map(({ change, field, before_value, after_value }) => [change, field, before_value, after_value]),
    ).toEqual([
      ["update", "is_milestone", "0", "1"],
      ["update", "start_on", '"2026-10-12"', "null"],
      ["update", "title", '"Sprawdzić licencję"', '"Podpisanie umowy"'],
    ]);
    expect(connection.prepare("SELECT count(*) FROM operation_effects WHERE field = 'title_norm'").pluck().get()).toBe(
      0,
    );
  });

  it("writes a delete as the row that was, and a touch as an effect that changes nothing", () => {
    const { sink, rows } = writing();
    const row = item("itm_1");
    const creation = byHand("opr_1");
    sink.operation(creation, []);
    sink.changes(creation, [{ kind: "item", change: "create", row, item: "itm_1", person: null }]);
    const touch = byHand("opr_2", AT + 1_000);
    const removal = byHand("opr_3", AT + 2_000);

    sink.operation(touch, []);
    sink.changes(touch, [{ kind: "item", change: "touch", row, item: "itm_1", person: null }]);
    sink.operation(removal, []);
    sink.changes(removal, [{ kind: "item", change: "delete", row, item: "itm_1", person: null }]);

    expect(rows("SELECT id FROM items")).toEqual([]);
    const effects = rows<Effect>(EFFECTS);
    expect(effects.map(({ id, change }) => [id, change])).toEqual([
      [1, "create"],
      [2, "touch"],
      [3, "delete"],
    ]);
    expect(effects[1]).toMatchObject({ field: null, before_value: null, after_value: null });
    // What a delete records is what the creation recorded: the row, column for column.
    expect(effects[2]?.before_value).toBe(effects[0]?.after_value);
    expect(effects[2]?.after_value).toBeNull();
  });

  it("goes through the guards: what the application could not write, it does not write either", () => {
    const { sink } = writing();
    const row = item("itm_1");
    const project = item("itm_2", { kind: "project", isMilestone: true });
    const operation = byHand("opr_1");
    const change: Change = { kind: "item", change: "create", row, item: "itm_1", person: null };

    // An effect belongs to an operation that exists and is applied.
    expect(() => sink.changes(operation, [change])).toThrow("operation_effects: only an applied operation has effects");
    sink.operation(operation, []);
    expect(() =>
      sink.changes(operation, [{ kind: "item", change: "create", row: project, item: "itm_2", person: null }]),
    ).toThrow("items: a project is not a milestone");
    expect(() => sink.operation(operation, [])).toThrow("operations: the id is taken, and a row is never replaced");
    const staged = { ...byHand("opr_2"), state: "staged" as const, approval: null, appliedAt: null };
    expect(() => sink.operation(staged, [])).toThrow("operations: an operation without a run is inserted as applied");
  });

  it("stores a capture as it came: its registry row, the capture, its parts, and each original once", () => {
    const { sink, rows } = writing();
    const first = capture("cap_1");
    const second = {
      ...capture("cap_2"),
      parts: capture("cap_2").parts.map((part, at) => ({ ...part, id: `prt_${at + 3}` as const })),
    };

    for (const saved of [first, second]) {
      for (const part of saved.parts) if (part.file !== null) sink.file(part.file);
      sink.capture(saved);
    }

    expect(rows("SELECT id, kind, created_at, deleted_at FROM sources ORDER BY id")).toEqual([
      { id: "cap_1", kind: "capture", created_at: "2026-10-12T09:00:00.000Z", deleted_at: null },
      { id: "cap_2", kind: "capture", created_at: "2026-10-12T09:00:00.000Z", deleted_at: null },
    ]);
    expect(
      rows("SELECT id, source_kind, occurred_on, occurred_on_approximate FROM captures WHERE id = 'cap_1'"),
    ).toEqual([{ id: "cap_1", source_kind: "capture", occurred_on: "2026-10-12", occurred_on_approximate: 1 }]);
    expect(
      rows("SELECT capture_id, position, kind, text, file_name FROM capture_parts WHERE capture_id = 'cap_1'"),
    ).toEqual([
      { capture_id: "cap_1", position: 0, kind: "typed", text: "zobacz", file_name: null },
      { capture_id: "cap_1", position: 1, kind: "image", text: null, file_name: "watek.png" },
    ]);
    // Two parts share the picture, and its original is stored once.
    expect(rows("SELECT sha256 FROM files")).toEqual([{ sha256: "9c".repeat(32) }]);
    expect(rows("SELECT count(*) AS parts FROM capture_parts WHERE file_sha256 IS NOT NULL")).toEqual([{ parts: 2 }]);
  });
});
