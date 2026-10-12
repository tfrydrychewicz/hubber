// What was extracted from sources: mentions of persons, facts about items, and the links
// between a source and the items it concerns.
import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { SourceId } from "../../../shared/ids.ts";
import type { FactType } from "../../../shared/vocabulary.ts";
import { day, flag, id, instant } from "./columns.ts";
import { items } from "./items.ts";
import { persons } from "./persons.ts";
import { sources } from "./sources.ts";
import { factTypes } from "./vocabularies.ts";

/**
 * A person named in a source. Resolved when personId is set, skipped when skippedAt is set,
 * unresolved while both are NULL: the state is derived, there is no column for it.
 */
export const mentions = sqliteTable(
  "mentions",
  {
    id: id("mention").primaryKey(),
    sourceId: text("source_id")
      .$type<SourceId>()
      .notNull()
      .references(() => sources.id),
    personId: id("person", "person_id").references(() => persons.id),
    skippedAt: instant("skipped_at"),
    createdAt: instant("created_at").notNull(),
    /** As written in the source. */
    surface: text("surface").notNull(),
    /** The base form the agent gave, and its spelling folded by foldName() for the look-up. */
    baseForm: text("base_form"),
    baseNorm: text("base_norm"),
  },
  (t) => [
    index("mentions_by_source").on(t.sourceId),
    index("mentions_by_person").on(t.personId, t.createdAt).where(sql`person_id IS NOT NULL`),
    index("mentions_unresolved").on(t.baseNorm).where(sql`person_id IS NULL AND skipped_at IS NULL`),
  ],
);

/** An extracted statement about one item, from one source, with the quote. Never edited. */
export const facts = sqliteTable(
  "facts",
  {
    id: id("fact").primaryKey(),
    /** Changes when the fact is moved or its item is merged. */
    itemId: id("item", "item_id")
      .notNull()
      .references(() => items.id),
    type: text("type")
      .$type<FactType>()
      .notNull()
      .references(() => factTypes.code),
    /** The day the thing happened or was said. */
    occurredOn: day("occurred_on").notNull(),
    occurredOnApproximate: flag("occurred_on_approximate").notNull(),
    /** After permanent deletion the source is the registry row with deletedAt set. */
    sourceId: text("source_id")
      .$type<SourceId>()
      .references(() => sources.id),
    /** A fact is marked outdated, optionally with the fact that replaced it. */
    outdatedAt: instant("outdated_at"),
    supersededByFactId: id("fact", "superseded_by_fact_id").references((): AnySQLiteColumn => facts.id),
    createdAt: instant("created_at").notNull(),
    /** A piece of the source, word for word. Removed, and only removed, when the source is deleted for good. */
    quote: text("quote"),
    /** The statement, as accepted. */
    text: text("text").notNull(),
  },
  (t) => [
    index("facts_by_item").on(t.itemId, t.occurredOn),
    index("facts_by_source").on(t.sourceId).where(sql`source_id IS NOT NULL`),
    index("facts_superseded_by").on(t.supersededByFactId).where(sql`superseded_by_fact_id IS NOT NULL`),
  ],
);

/** The persons a fact is about. Persons of the directory only. */
export const factPersons = sqliteTable(
  "fact_persons",
  {
    id: id("factPerson").primaryKey(),
    factId: id("fact", "fact_id")
      .notNull()
      .references(() => facts.id),
    personId: id("person", "person_id")
      .notNull()
      .references(() => persons.id),
  },
  (t) => [
    uniqueIndex("fact_persons_one_per_fact").on(t.factId, t.personId),
    index("fact_persons_by_person").on(t.personId),
  ],
);

/** A source concerns an item. A source has any number of links, also none. */
export const sourceLinks = sqliteTable(
  "source_links",
  {
    id: id("sourceLink").primaryKey(),
    sourceId: text("source_id")
      .$type<SourceId>()
      .notNull()
      .references(() => sources.id),
    itemId: id("item", "item_id")
      .notNull()
      .references(() => items.id),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("source_links_one_per_item").on(t.sourceId, t.itemId),
    index("source_links_by_item").on(t.itemId, t.createdAt),
  ],
);

export type Mention = typeof mentions.$inferSelect;
export type NewMention = typeof mentions.$inferInsert;
export type Fact = typeof facts.$inferSelect;
export type NewFact = typeof facts.$inferInsert;
export type FactPerson = typeof factPersons.$inferSelect;
export type NewFactPerson = typeof factPersons.$inferInsert;
export type SourceLink = typeof sourceLinks.$inferSelect;
export type NewSourceLink = typeof sourceLinks.$inferInsert;
