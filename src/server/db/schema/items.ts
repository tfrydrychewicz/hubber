// Items (projects and tasks, in trees of any depth), their prose, their aliases and the persons in them.
import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type {
  DatePrecision,
  ItemHealth,
  ItemImportance,
  ItemKind,
  ItemPersonRole,
  ItemStatus,
  MyRole,
} from "../../../shared/vocabulary.ts";
import { day, flag, id, instant, json } from "./columns.ts";
import { persons } from "./persons.ts";
import { itemHealths, itemImportances, itemPersonRoles, itemStatuses, myRoles } from "./vocabularies.ts";

export const items = sqliteTable(
  "items",
  {
    id: id("item").primaryKey(),
    /** A project or a task. "Podzadanie" is the interface's word for a task whose parent is a task, not a kind. */
    kind: text("kind").$type<ItemKind>().notNull(),
    /**
     * The item this one sits under: NULL for a project and for a task that stands alone. A task sits in a
     * project or under another task, to any depth. Triggers hold the rules of the tree: a project has no
     * parent, and no item is its own ancestor.
     */
    parentId: id("item", "parent_id").references((): AnySQLiteColumn => items.id),
    title: text("title").notNull(),
    /** The title folded for matching by foldName(). */
    titleNorm: text("title_norm").notNull(),
    status: text("status")
      .$type<ItemStatus>()
      .notNull()
      .references(() => itemStatuses.code),
    /** Every item has one. No default: the statement that inserts the item writes it. */
    importance: text("importance")
      .$type<ItemImportance>()
      .notNull()
      .references(() => itemImportances.code),
    /** The health of the item itself, a project or a task at any depth; NULL is "not assessed". */
    health: text("health")
      .$type<ItemHealth>()
      .references(() => itemHealths.code),
    /** NULL: not said yet. */
    myRole: text("my_role")
      .$type<MyRole>()
      .references(() => myRoles.code),
    /** The day from which myRole holds, by the event date of the material that said so. */
    myRoleSetOn: day("my_role_set_on"),
    /** The day the work starts. With dueOn it is the period of the item; no rule orders the two days. */
    startOn: day("start_on"),
    /** How exactly the start is known; NULL is "to the day". For a named period startOn is its first day. */
    startOnPrecision: text("start_on_precision").$type<DatePrecision>(),
    /** The deadline: the end of the period of the item, or alone a point in time. */
    dueOn: day("due_on"),
    /** As startOnPrecision; for a named period dueOn is its last day. */
    dueOnPrecision: text("due_on_precision").$type<DatePrecision>(),
    /**
     * 1 marks a task, at any depth of its tree, as a point in time: it stands on its due day and has no
     * start. No default: the statement that inserts the item writes it.
     */
    isMilestone: flag("is_milestone").notNull(),
    /** The external reference: system, key and address, such as "jira", "PAY-123" and the ticket's URL. */
    externalSystem: text("external_system"),
    externalKey: text("external_key"),
    externalUrl: text("external_url"),
    /** The item this one was merged into. The row stays as a signpost; lists read mergedIntoId IS NULL. */
    mergedIntoId: id("item", "merged_into_id").references((): AnySQLiteColumn => items.id),
    createdAt: instant("created_at").notNull(),
    /** When the status became a closed one; NULL while the item is open. */
    closedAt: instant("closed_at"),
    /**
     * The instant of the newest operation in force that concerned the item. Kept by triggers:
     * application code writes it at the insert, equal to createdAt, and never again.
     */
    lastActivityAt: instant("last_activity_at").notNull(),
  },
  (t) => [
    index("items_active").on(t.myRole, t.dueOn).where(sql`closed_at IS NULL AND merged_into_id IS NULL`),
    index("items_by_parent").on(t.parentId).where(sql`parent_id IS NOT NULL`),
    index("items_by_title").on(t.titleNorm),
    index("items_merged_into").on(t.mergedIntoId).where(sql`merged_into_id IS NOT NULL`),
  ],
);

/** The prose of an item, apart from its fields: saved by autosave, and large. */
export const itemDescriptions = sqliteTable(
  "item_descriptions",
  {
    id: id("itemDescription").primaryKey(),
    itemId: id("item", "item_id")
      .notNull()
      .references(() => items.id),
    updatedAt: instant("updated_at").notNull(),
    /** The document of the editor, as JSON. */
    body: json("body").notNull(),
  },
  (t) => [uniqueIndex("item_descriptions_one_per_item").on(t.itemId)],
);

export const itemAliases = sqliteTable(
  "item_aliases",
  {
    id: id("itemAlias").primaryKey(),
    itemId: id("item", "item_id")
      .notNull()
      .references(() => items.id),
    alias: text("alias").notNull(),
    aliasNorm: text("alias_norm").notNull(),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("item_aliases_one_per_item").on(t.itemId, t.aliasNorm),
    index("item_aliases_by_norm").on(t.aliasNorm),
  ],
);

/** The role of a person in an item. The owner of an item is the row with the role "owner". */
export const itemPersons = sqliteTable(
  "item_persons",
  {
    id: id("itemPerson").primaryKey(),
    itemId: id("item", "item_id")
      .notNull()
      .references(() => items.id),
    personId: id("person", "person_id")
      .notNull()
      .references(() => persons.id),
    role: text("role")
      .$type<ItemPersonRole>()
      .notNull()
      .references(() => itemPersonRoles.code),
    createdAt: instant("created_at").notNull(),
    expectations: text("expectations"),
  },
  (t) => [
    uniqueIndex("item_persons_one_role").on(t.itemId, t.personId),
    uniqueIndex("item_persons_one_owner").on(t.itemId).where(sql`role = 'owner'`),
    index("item_persons_by_person").on(t.personId, t.role),
  ],
);

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type ItemDescription = typeof itemDescriptions.$inferSelect;
export type NewItemDescription = typeof itemDescriptions.$inferInsert;
export type ItemAlias = typeof itemAliases.$inferSelect;
export type NewItemAlias = typeof itemAliases.$inferInsert;
export type ItemPerson = typeof itemPersons.$inferSelect;
export type NewItemPerson = typeof itemPersons.$inferInsert;
