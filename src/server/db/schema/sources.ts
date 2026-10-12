// Raw material, outside the journal: the registry of sources, the originals of dropped files,
// and captures with their parts and the text derived from them.
import { sql } from "drizzle-orm";
import { foreignKey, index, integer, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { SourceId } from "../../../shared/ids.ts";
import type { PartKind, PartTextOrigin, SourceKind } from "../../../shared/vocabulary.ts";
import { day, flag, id, instant, json } from "./columns.ts";
// This file and work.ts import each other: a transcription names its model call, and a run its
// source. Every reference is a function, which is not called before both files have loaded.
import { modelCalls } from "./work.ts";

/**
 * The registry of everything information can come from. One row per capture for now. The row
 * outlives its content: permanent deletion removes the content and sets deletedAt.
 */
export const sources = sqliteTable(
  "sources",
  {
    /** The same value as the key of the row in the kind's own table. */
    id: text("id").$type<SourceId>().primaryKey(),
    kind: text("kind").$type<SourceKind>().notNull(),
    /** The date of adding. */
    createdAt: instant("created_at").notNull(),
    /** Set once, by permanent deletion. */
    deletedAt: instant("deleted_at"),
  },
  (t) => [
    // The parent key of the kind tables: a capture can only sit on a row whose kind is "capture".
    unique().on(t.id, t.kind),
    index("sources_by_kind").on(t.kind, t.createdAt),
  ],
);

/** Originals, addressed by the hash of their content. The path is derived from the hash. */
export const files = sqliteTable("files", {
  sha256: text("sha256").primaryKey(),
  byteSize: integer("byte_size").notNull(),
  /** As the server established it from the content. */
  mediaType: text("media_type").notNull(),
  createdAt: instant("created_at").notNull(),
});

/** One row per input sent from the input field. Its date of adding is the registry row's. */
export const captures = sqliteTable(
  "captures",
  {
    id: id("capture").primaryKey(),
    /** Always "capture": ties the row to a registry row of that kind. */
    sourceKind: text("source_kind").$type<"capture">().generatedAlwaysAs(sql`'capture'`, { mode: "virtual" }),
    /** The event date. Written at saving as the local day of adding, and replaced by an operation. */
    occurredOn: day("occurred_on").notNull(),
    occurredOnApproximate: flag("occurred_on_approximate").notNull(),
  },
  (t) => [foreignKey({ columns: [t.id, t.sourceKind], foreignColumns: [sources.id, sources.kind] })],
);

/** The pieces of one input, in the order the owner put them. Never updated. */
export const captureParts = sqliteTable(
  "capture_parts",
  {
    id: id("capturePart").primaryKey(),
    captureId: id("capture", "capture_id")
      .notNull()
      .references(() => captures.id),
    position: integer("position").notNull(),
    kind: text("kind").$type<PartKind>().notNull(),
    /** The original of an image or file part. */
    fileSha256: text("file_sha256").references(() => files.sha256),
    /** The name the file came with. */
    fileName: text("file_name"),
    /** The original text of a typed or pasted part, character for character. */
    text: text("text"),
  },
  (t) => [
    uniqueIndex("capture_parts_one_per_position").on(t.captureId, t.position),
    uniqueIndex("capture_parts_one_typed").on(t.captureId).where(sql`kind = 'typed'`),
    index("capture_parts_by_file").on(t.fileSha256).where(sql`file_sha256 IS NOT NULL`),
  ],
);

/**
 * Text derived from a part that is not text itself. Append-only: a correction or a new
 * transcription is a new revision, and the newest revision is the current one.
 */
export const capturePartTexts = sqliteTable(
  "capture_part_texts",
  {
    id: id("capturePartText").primaryKey(),
    partId: id("capturePart", "part_id")
      .notNull()
      .references(() => captureParts.id),
    revision: integer("revision").notNull(),
    origin: text("origin").$type<PartTextOrigin>().notNull(),
    /** The model call that wrote a transcription; NULL for a local extraction and for a correction. */
    modelCallId: integer("model_call_id").references(() => modelCalls.id),
    createdAt: instant("created_at").notNull(),
    /** Participants, time stamps and content message by message, as JSON. */
    structure: json("structure"),
    /** The flat text: what is searched, quoted and shown to the agent. */
    text: text("text").notNull(),
  },
  (t) => [uniqueIndex("capture_part_texts_one_per_revision").on(t.partId, t.revision)],
);

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type StoredFile = typeof files.$inferSelect;
export type NewStoredFile = typeof files.$inferInsert;
export type Capture = typeof captures.$inferSelect;
export type NewCapture = typeof captures.$inferInsert;
export type CapturePart = typeof captureParts.$inferSelect;
export type NewCapturePart = typeof captureParts.$inferInsert;
export type CapturePartText = typeof capturePartTexts.$inferSelect;
export type NewCapturePartText = typeof capturePartTexts.$inferInsert;
