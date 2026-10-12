// Column builders for the conventions of the schema. A column holds what SQLite stores, and the
// builders say so in its type: an id is text with its prefix, an instant and a day are text in
// their one spelling, a flag is 0 or 1, JSON is the JSON text.
//
// No column modes ("json", "boolean", "timestamp"). In "json" mode a JavaScript null is written
// as SQL NULL, and the values of an effect tell the two apart; a Date or a boolean handed to a
// raw SQL fragment fails at the driver, because nothing converts it there.
import { integer, text } from "drizzle-orm/sqlite-core";
import type { Id, IdKind } from "../../../shared/ids.ts";
import type { Day, Instant } from "../../../shared/time.ts";

/**
 * The names of the columns that each builder made. A builder gives a column its type and nothing
 * else: the rule that makes the type true is a CHECK of the migration. src/server/db/schema.test.ts
 * reads these names and asks the database for the rule of every such column.
 */
export const BUILT_COLUMNS = {
  instant: new Set<string>(),
  day: new Set<string>(),
  flag: new Set<string>(),
  json: new Set<string>(),
};

/**
 * An id of the given kind: the key of a row, or, with a name, a reference to such a row. The
 * kind is there for the type alone: the database checks the prefix.
 */
export const id = <K extends IdKind, N extends string = "id">(_kind: K, name: N = "id" as N) =>
  text(name).$type<Id<K>>();

/** An instant. The name of such a column ends in "_at", or says more: "run_after", "leased_until". */
export const instant = <N extends string>(name: N) => {
  BUILT_COLUMNS.instant.add(name);
  return text(name).$type<Instant>();
};

/** A calendar day, for a column whose name ends in "_on". */
export const day = <N extends string>(name: N) => {
  BUILT_COLUMNS.day.add(name);
  return text(name).$type<Day>();
};

/** A boolean as the database stores it. */
export const flag = <N extends string>(name: N) => {
  BUILT_COLUMNS.flag.add(name);
  return integer(name).$type<0 | 1>();
};

/** JSON as text: written with JSON.stringify() and read with JSON.parse() by whoever owns the value. */
export const json = <N extends string>(name: N) => {
  BUILT_COLUMNS.json.add(name);
  return text(name);
};
