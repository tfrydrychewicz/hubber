// The directory of persons and their other names.
import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { PersonRelation } from "../../../shared/vocabulary.ts";
import { flag, id, instant } from "./columns.ts";
import { personRelations } from "./vocabularies.ts";

export const persons = sqliteTable(
  "persons",
  {
    id: id("person").primaryKey(),
    /** The name as shown. */
    name: text("name").notNull(),
    /** The name folded for matching by foldName(). */
    nameNorm: text("name_norm").notNull(),
    /** What the person does, free text. */
    jobTitle: text("job_title"),
    /** Team or organisation, free text. */
    team: text("team"),
    relation: text("relation")
      .$type<PersonRelation>()
      .references(() => personRelations.code),
    /** The owner. At most one row carries it. */
    isMe: flag("is_me").notNull(),
    /** The person this one was merged into. The row stays as a signpost; lists read mergedIntoId IS NULL. */
    mergedIntoId: id("person", "merged_into_id").references((): AnySQLiteColumn => persons.id),
    createdAt: instant("created_at").notNull(),
    /** The owner's own note about the person, plain text. */
    note: text("note"),
  },
  (t) => [
    uniqueIndex("persons_one_me").on(t.isMe).where(sql`is_me = 1`),
    index("persons_by_name").on(t.nameNorm),
    index("persons_merged_into").on(t.mergedIntoId).where(sql`merged_into_id IS NOT NULL`),
  ],
);

/**
 * Other names of a person: diminutives, initials, handles, addresses, and names that hold only
 * in a context. The same alias may belong to several persons: that is what makes a mention
 * ambiguous.
 */
export const personAliases = sqliteTable(
  "person_aliases",
  {
    id: id("personAlias").primaryKey(),
    personId: id("person", "person_id")
      .notNull()
      .references(() => persons.id),
    alias: text("alias").notNull(),
    aliasNorm: text("alias_norm").notNull(),
    /** The context in which the alias means this person; "" when it holds everywhere. */
    context: text("context").notNull(),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("person_aliases_one_per_context").on(t.personId, t.aliasNorm, t.context),
    index("person_aliases_by_norm").on(t.aliasNorm),
  ],
);

export type Person = typeof persons.$inferSelect;
export type NewPerson = typeof persons.$inferInsert;
export type PersonAlias = typeof personAliases.$inferSelect;
export type NewPersonAlias = typeof personAliases.$inferInsert;
