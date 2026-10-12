// The database is the truth and the Drizzle declaration a description of it. This test holds
// the description to the truth: it reads what the migrations created, table by table, and
// compares it with what src/server/db/schema declares. It also holds the conventions of the
// schema, so that a later migration that leaves one of them out fails here.
import { getTableColumns, is, SQL } from "drizzle-orm";
import { getTableConfig, SQLiteSyncDialect, SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterAll, describe, expect, it } from "vitest";
import { ID_PREFIXES, type IdKind } from "../../shared/ids.ts";
import { MIGRATIONS_TABLE } from "./migrate.ts";
import * as schema from "./schema/index.ts";
import { createTestDatabase } from "./testing.ts";

/** Tables of other layers. They are in the file and in no declaration. */
const NOT_DECLARED = ["workspace_pin", MIGRATIONS_TABLE];

/**
 * The tables without a rowid, which are the ones whose key is the row or nearly all of it: the
 * tables of words, the registry of sources, the files and the dependency edges. A new table is
 * on this list or has a rowid.
 */
const WITHOUT_ROWID = [
  "fact_types",
  "files",
  "item_healths",
  "item_importances",
  "item_person_roles",
  "item_statuses",
  "job_states",
  "my_roles",
  "operation_dependencies",
  "operation_states",
  "person_relations",
  "run_states",
  "sources",
];

/** Instants whose names say more than "at": when a job may run, and until when its lease holds. */
const INSTANTS_UNDER_ANOTHER_NAME = ["queue_jobs.run_after", "queue_jobs.leased_until"];

/** The table whose rows carry the ids of each kind. */
const ID_TABLES: Record<IdKind, string> = {
  capture: "captures",
  capturePart: "capture_parts",
  capturePartText: "capture_part_texts",
  person: "persons",
  personAlias: "person_aliases",
  item: "items",
  itemDescription: "item_descriptions",
  itemAlias: "item_aliases",
  itemPerson: "item_persons",
  mention: "mentions",
  fact: "facts",
  factPerson: "fact_persons",
  sourceLink: "source_links",
  job: "queue_jobs",
  run: "runs",
  operation: "operations",
};

interface ColumnShape {
  name: string;
  type: string;
  notNull: boolean;
  generated: string | null;
}

interface IndexShape {
  name: string;
  unique: boolean;
  /** The condition of a partial index, or null. */
  where: string | null;
  columns: (string | null)[];
}

interface ForeignKeyShape {
  columns: string[];
  table: string;
  foreignColumns: (string | null)[];
  onDelete: string;
  onUpdate: string;
}

interface TableShape {
  columns: ColumnShape[];
  primaryKey: string[];
  /** UNIQUE constraints of the table itself: the parent keys of composite foreign keys. */
  uniqueConstraints: string[][];
  indexes: IndexShape[];
  foreignKeys: ForeignKeyShape[];
}

const database = createTestDatabase();
const { connection } = database;

afterAll(() => {
  database.close();
});

/** SQL text as the schema fingerprint reads it: without the quotes that a rename adds, with single spaces. */
const plain = (sql: string) => sql.replace(/"/g, "").replace(/\s+/g, " ").trim();
/**
 * A statement without its comments. The database keeps the comments of a table with its text,
 * and a rule that is only named in one of them is no rule. A literal is kept as it is: two
 * hyphens inside one are no comment.
 */
const withoutComments = (sql: string) =>
  sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (found) => (found.startsWith("'") ? found : " "));
const byName = <T extends { name: string }>(rows: T[]) => [...rows].sort((a, b) => a.name.localeCompare(b.name));
const byColumns = <T extends { columns: string[] }>(rows: T[]) =>
  [...rows].sort((a, b) => a.columns.join().localeCompare(b.columns.join()));

const applicationTables = (
  connection
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
    )
    .pluck()
    .all() as string[]
).filter((name) => !NOT_DECLARED.includes(name));

/** The statement that made a table, without its comments. */
const tableSql = (table: string) =>
  plain(
    withoutComments(
      connection
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .pluck()
        .get(table) as string,
    ),
  );

interface TableListRow {
  name: string;
  wr: number;
  strict: number;
}
const tableList = (connection.pragma("table_list") as (TableListRow & { schema: string })[]).filter(
  (row) => row.schema === "main" && applicationTables.includes(row.name),
);

interface XinfoRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
  hidden: number;
}
const xinfo = (table: string) => connection.pragma(`table_xinfo(${table})`) as XinfoRow[];

/** What the migrations created, read from the database. */
function inDatabase(table: string): TableShape {
  const rows = xinfo(table);
  const primaryKey = rows.filter((row) => row.pk > 0).sort((a, b) => a.pk - b.pk);
  // An INTEGER PRIMARY KEY of a table with a rowid is the rowid. SQLite does not report it as
  // NOT NULL, and it never holds NULL: a row inserted without it is given the next number.
  const rowid =
    primaryKey.length === 1 && primaryKey[0]?.type === "INTEGER" && !WITHOUT_ROWID.includes(table)
      ? primaryKey[0].name
      : undefined;
  const columns = rows.map((row) => ({
    name: row.name,
    type: row.type,
    notNull: row.notnull === 1 || row.name === rowid,
    generated: ({ 2: "virtual", 3: "stored" } as Record<number, string>)[row.hidden] ?? null,
  }));

  const indexList = connection.pragma(`index_list(${table})`) as {
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];
  const keyColumns = (index: string) =>
    (
      connection.pragma(`index_xinfo(${index})`) as {
        seqno: number;
        name: string | null;
        desc: number;
        coll: string;
        key: number;
      }[]
    )
      .filter((column) => column.key === 1)
      .sort((a, b) => a.seqno - b.seqno)
      // An index on an expression has no column name here; one in descending order or with a
      // collation of its own says so. None of them can be declared as a plain list of columns.
      .map(({ name, desc, coll }) =>
        name === null ? null : `${name}${desc === 1 ? " DESC" : ""}${coll === "BINARY" ? "" : ` COLLATE ${coll}`}`,
      );
  const indexes = indexList
    .filter((index) => index.origin === "c")
    .map((index) => {
      const sql = plain(
        connection
          .prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?")
          .pluck()
          .get(index.name) as string,
      );
      const where = / WHERE (.*)$/.exec(sql)?.[1] ?? null;
      // The flag of the database and the text of the statement must tell the same story.
      expect(where !== null, `${index.name}: partial`).toBe(index.partial === 1);
      return { name: index.name, unique: index.unique === 1, where, columns: keyColumns(index.name) };
    });
  const uniqueConstraints = indexList
    .filter((index) => index.origin === "u")
    .map((index) => keyColumns(index.name).map(String));

  const keyRows = connection.pragma(`foreign_key_list(${table})`) as {
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string | null;
    on_update: string;
    on_delete: string;
  }[];
  const foreignKeys = [...new Set(keyRows.map((row) => row.id))].map((id) => {
    const parts = keyRows.filter((row) => row.id === id).sort((a, b) => a.seq - b.seq);
    const first = parts[0] as (typeof parts)[number];
    return {
      columns: parts.map((part) => part.from),
      table: first.table,
      foreignColumns: parts.map((part) => part.to),
      onDelete: first.on_delete,
      onUpdate: first.on_update,
    };
  });

  return {
    columns,
    primaryKey: primaryKey.map((row) => row.name),
    uniqueConstraints: uniqueConstraints.sort(),
    indexes: byName(indexes),
    foreignKeys: byColumns(foreignKeys),
  };
}

const dialect = new SQLiteSyncDialect();
/** A fragment of the declaration as the SQL text it stands for. Nothing in a declaration is a bound value. */
function textOf(fragment: SQL): string {
  const { sql, params } = dialect.sqlToQuery(fragment);
  expect(params, sql).toEqual([]);
  return plain(sql);
}

const declaredTables = new Map<string, SQLiteTable>(
  Object.values(schema).flatMap((value) => (is(value, SQLiteTable) ? [[getTableConfig(value).name, value]] : [])),
);

/** What src/server/db/schema declares. */
function declared(table: string): TableShape {
  const config = getTableConfig(declaredTables.get(table) as SQLiteTable);
  const columns = config.columns.map((column) => ({
    name: column.name,
    type: column.getSQLType().toUpperCase(),
    notNull: column.notNull,
    generated: column.generated === undefined ? null : (column.generated.mode ?? "virtual"),
  }));
  const ownKey = config.columns.filter((column) => column.primary).map((column) => column.name);
  const tableKeys = config.primaryKeys.map((key) => key.columns.map((column) => column.name));
  // A key is declared on its column or, when it has several columns, on the table. Never twice.
  expect(tableKeys.length + (ownKey.length > 0 ? 1 : 0), `${table}: one primary key`).toBe(1);

  return {
    columns,
    primaryKey: tableKeys[0] ?? ownKey,
    uniqueConstraints: [
      ...config.uniqueConstraints.map((constraint) => constraint.columns.map((column) => column.name)),
      ...config.columns.filter((column) => column.isUnique).map((column) => [column.name]),
    ].sort(),
    indexes: byName(
      config.indexes.map(({ config: index }) => ({
        name: index.name,
        unique: index.unique,
        where: index.where === undefined ? null : textOf(index.where),
        // An index on an expression has no column to name.
        columns: index.columns.map((column) => (is(column, SQL) ? null : column.name)),
      })),
    ),
    foreignKeys: byColumns(
      config.foreignKeys.map((key) => {
        const reference = key.reference();
        return {
          columns: reference.columns.map((column) => column.name),
          table: getTableConfig(reference.foreignTable).name,
          foreignColumns: reference.foreignColumns.map((column) => column.name),
          onDelete: (key.onDelete ?? "no action").toUpperCase(),
          onUpdate: (key.onUpdate ?? "no action").toUpperCase(),
        };
      }),
    ),
  };
}

describe("the Drizzle declaration and the migrated database", () => {
  it("name the same tables, apart from the two that belong to other layers", () => {
    expect([...declaredTables.keys()].sort()).toEqual(applicationTables);
    for (const foreign of NOT_DECLARED) expect(declaredTables.has(foreign), foreign).toBe(false);
    // Two empty lists would agree as well.
    expect(applicationTables.length).toBeGreaterThan(0);
  });

  it.each(applicationTables)("agree on the columns of %s: order, type, NOT NULL and what is generated", (table) => {
    expect(declaredTables.has(table), "declared").toBe(true);
    expect(declared(table).columns).toEqual(inDatabase(table).columns);
  });

  it.each(applicationTables)("agree on the keys of %s: primary key and UNIQUE constraints", (table) => {
    const [code, real] = [declared(table), inDatabase(table)];

    expect(code.primaryKey).toEqual(real.primaryKey);
    expect(code.uniqueConstraints).toEqual(real.uniqueConstraints);
  });

  it.each(applicationTables)("agree on the indexes of %s: name, uniqueness, condition and columns", (table) => {
    expect(declared(table).indexes).toEqual(inDatabase(table).indexes);
  });

  it.each(applicationTables)("agree on the foreign keys of %s: columns, target and no action", (table) => {
    expect(declared(table).foreignKeys).toEqual(inDatabase(table).foreignKeys);
  });

  it("agree on the expression of every generated column", () => {
    const generated = [...declaredTables.keys()].flatMap((table) =>
      getTableConfig(declaredTables.get(table) as SQLiteTable)
        .columns.filter((column) => column.generated !== undefined)
        .map((column) => {
          const as = column.generated?.as as SQL | (() => SQL);
          const expression = textOf(typeof as === "function" ? as() : as);
          const definition = `${column.name} ${column.getSQLType().toUpperCase()} GENERATED ALWAYS AS (${expression}) ${(column.generated?.mode ?? "virtual").toUpperCase()}`;
          return { column: `${table}.${column.name}`, definition, inDatabase: tableSql(table).includes(definition) };
        }),
    );

    expect(generated.filter((column) => !column.inDatabase)).toEqual([]);
    expect(generated.length).toBeGreaterThan(0);
  });

  // The comparison above is of names and shapes. This is the declaration at work: a SELECT of
  // every declared column, generated ones included, that the database has to accept.
  it.each(applicationTables)("let every column of %s be read through the handle", (table) => {
    const rows = database.db
      .select()
      .from(declaredTables.get(table) as SQLiteTable)
      .limit(1)
      .all();
    const stored = connection.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;

    expect(rows).toHaveLength(Math.min(stored, 1));
  });

  it("leave no index of the database out of the comparison", () => {
    const compared = applicationTables.flatMap((table) => inDatabase(table).indexes.map((index) => index.name));
    const inFile = connection
      .prepare(
        `SELECT name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL AND tbl_name NOT IN (${NOT_DECLARED.map(() => "?").join(", ")})`,
      )
      .pluck()
      .all(...NOT_DECLARED) as string[];

    expect(compared.sort()).toEqual(inFile.sort());
    expect(compared.length).toBeGreaterThan(0);
  });
});

describe("the declaration", () => {
  const columns = [...declaredTables.entries()].flatMap(([table, declaration]) =>
    getTableConfig(declaration).columns.map((column) => ({ table, column })),
  );

  // A column holds what SQLite stores. A mode would convert on the way: "json" writes a
  // JavaScript null as SQL NULL, "boolean" and "timestamp" hand a raw SQL fragment a value that
  // the driver refuses.
  it("uses no column mode: every column is plain text or a plain integer", () => {
    const others = columns
      .filter(({ column }) => !["SQLiteText", "SQLiteInteger"].includes(column.columnType))
      .map(({ table, column }) => `${table}.${column.name}: ${column.columnType}`);

    expect(others).toEqual([]);
  });

  // Every value is written by the statement that inserts the row. A default in the declaration
  // would be a value that the code writes without the statement saying so.
  it("gives no column a default or a value on update", () => {
    const withDefault = columns
      .filter(
        ({ column }) =>
          column.default !== undefined || column.defaultFn !== undefined || column.onUpdateFn !== undefined,
      )
      .map(({ table, column }) => `${table}.${column.name}`);

    expect(withDefault).toEqual([]);
  });

  it("declares no CHECK: the rules of the database are in the migrations only", () => {
    const withChecks = [...declaredTables.entries()]
      .filter(([, declaration]) => getTableConfig(declaration).checks.length > 0)
      .map(([table]) => table);

    expect(withChecks).toEqual([]);
  });

  // The types of the columns are held by the type-check, in schema.types.test.ts. That file
  // names the columns by their properties, so a property has one possible name.
  it("names every property after its column, in camelCase", () => {
    const camelCase = (name: string) => name.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
    const others = [...declaredTables.entries()].flatMap(([table, declaration]) =>
      Object.entries(getTableColumns(declaration))
        .filter(([property, column]) => property !== camelCase(column.name))
        .map(([property, column]) => `${table}.${column.name}: ${property}`),
    );

    expect(others).toEqual([]);
  });
});

describe("the conventions of the schema", () => {
  it("every table is STRICT", () => {
    expect(tableList.filter((row) => row.strict !== 1).map((row) => row.name)).toEqual([]);
    expect(tableList.map((row) => row.name).sort()).toEqual(applicationTables);
  });

  it("the tables without a rowid are the ones on the list", () => {
    expect(
      tableList
        .filter((row) => row.wr === 1)
        .map((row) => row.name)
        .sort(),
    ).toEqual(WITHOUT_ROWID);
  });

  it("no column has a default", () => {
    const withDefault = applicationTables.flatMap((table) =>
      xinfo(table)
        .filter((column) => column.dflt_value !== null)
        .map((column) => `${table}.${column.name}`),
    );

    expect(withDefault).toEqual([]);
  });

  it("no foreign key has an action", () => {
    const withAction = applicationTables.flatMap((table) =>
      (connection.pragma(`foreign_key_list(${table})`) as { from: string; on_update: string; on_delete: string }[])
        .filter((key) => key.on_delete !== "NO ACTION" || key.on_update !== "NO ACTION")
        .map((key) => `${table}.${key.from}`),
    );

    expect(withAction).toEqual([]);
  });

  // What neither the comparison above nor a list of columns shows, and what changes how a
  // statement behaves: a collation makes two spellings one word, a conflict clause lets a
  // statement step around a rule without a sound, a deferred key puts its check off to the
  // commit, and AUTOINCREMENT numbers rows by another rule.
  it("no table and no index states a collation, a conflict clause, a deferred key or AUTOINCREMENT", () => {
    const statements = connection
      .prepare(
        `SELECT name, sql FROM sqlite_schema WHERE type IN ('table', 'index') AND sql IS NOT NULL AND tbl_name NOT IN (${NOT_DECLARED.map(() => "?").join(", ")})`,
      )
      .all(...NOT_DECLARED) as { name: string; sql: string }[];
    const found = statements.flatMap(({ name, sql }) =>
      [
        // Without the literals as well: a word of a rule may be any word.
        ...withoutComments(sql)
          .replace(/'(?:[^']|'')*'/g, "''")
          .matchAll(/\b(COLLATE|ON\s+CONFLICT|DEFERRABLE|AUTOINCREMENT)\b/gi),
      ].map(([word]) => `${name}: ${word}`),
    );

    expect(found).toEqual([]);
    expect(statements.length).toBeGreaterThan(applicationTables.length);
  });

  // The comparison of the indexes reads an index on an expression as a column without a name, on
  // both sides: two different expressions would compare equal. Whoever adds the first such index
  // adds the comparison of the expressions with it.
  it("no index is on an expression", () => {
    const onExpressions = applicationTables.flatMap((table) =>
      inDatabase(table)
        .indexes.filter((index) => index.columns.includes(null))
        .map((index) => index.name),
    );

    expect(onExpressions).toEqual([]);
  });

  // A builder of src/server/db/schema/columns.ts gives a column its type. What makes the type
  // true is a CHECK. The CHECK of an instant and of a day reads the value back through SQLite's
  // own date functions and accepts it only when it comes back unchanged and begins with a digit:
  // one spelling each. '+0 seconds' makes the function normalise the value, without which hour 24
  // comes back as it went in; the digit keeps out a year with a minus sign, which also does.
  const RULES: [builder: keyof typeof schema.BUILT_COLUMNS, rule: (column: string) => string[]][] = [
    [
      "instant",
      (column) => [
        `CHECK (${column} IS strftime('%Y-%m-%dT%H:%M:%fZ', ${column}, '+0 seconds') AND ${column} GLOB '[0-9]*')`,
      ],
    ],
    ["day", (column) => [`CHECK (${column} IS date(${column}) AND ${column} GLOB '[0-9]*')`]],
    ["flag", (column) => [`CHECK (${column} IN (0, 1))`]],
    // json_valid() reads a text as far as its first NUL character.
    ["json", (column) => [`json_valid(${column})`, `instr(${column}, char(0)) = 0`]],
  ];

  it.each(RULES)("the columns built with %s() are the ones that have its rule in the database", (builder, rule) => {
    const columns = applicationTables.flatMap((table) =>
      xinfo(table).map(({ name }) => ({
        column: `${table}.${name}`,
        built: schema.BUILT_COLUMNS[builder].has(name),
        // The first text of a rule is what tells it from every other rule.
        ruled: tableSql(table).includes(rule(name)[0] as string),
        whole: rule(name).every((text) => tableSql(table).includes(text)),
      })),
    );

    // Built so, and without the rule or with half of it: the type would promise more than the database holds.
    expect(columns.filter(({ built, whole }) => built && !whole).map(({ column }) => column)).toEqual([]);
    // With the rule, and built otherwise: the type would say less than the database holds.
    expect(columns.filter(({ built, ruled }) => !built && ruled).map(({ column }) => column)).toEqual([]);
    expect(columns.some(({ built }) => built)).toBe(true);
  });

  it("an instant is named *_at, or is one of the instants under another name; a day is named *_on", () => {
    const names = applicationTables.flatMap((table) => xinfo(table).map(({ name }) => ({ table, name })));
    const instants = names.filter(({ name }) => schema.BUILT_COLUMNS.instant.has(name));
    const days = names.filter(({ name }) => schema.BUILT_COLUMNS.day.has(name));
    const isInstantByName = ({ table, name }: { table: string; name: string }) =>
      name.endsWith("_at") || INSTANTS_UNDER_ANOTHER_NAME.includes(`${table}.${name}`);

    expect(names.filter(isInstantByName)).toEqual(instants);
    expect(names.filter(({ name }) => name.endsWith("_on"))).toEqual(days);
    expect(instants.map(({ table, name }) => `${table}.${name}`)).toEqual(
      expect.arrayContaining(INSTANTS_UNDER_ANOTHER_NAME),
    );
  });

  // The id of a capture is the id of its registry row, which holds the rule about its characters.
  const ID_OF_A_REGISTRY_ROW = ["captures"];
  // The registry holds the ids of every kind of source: its rule is three letters and an underscore, not one prefix.
  const REGISTRY = "sources";

  it("every table with ids of its own checks the prefix that the code gives that kind, and the characters behind it", () => {
    const checked = Object.fromEntries(
      applicationTables.flatMap((table) => {
        const prefix = /\bid TEXT PRIMARY KEY NOT NULL CHECK \(id GLOB '([a-z]{3})_\?\*'/.exec(tableSql(table))?.[1];
        return prefix === undefined ? [] : [[table, prefix]];
      }),
    );
    // A table with ids of its own is one whose key is a text column named "id". Found by the key
    // and not by the rule: a table that leaves the rule out is on this list as well.
    const keyedByAnId = applicationTables.filter((table) => {
      const key = xinfo(table).filter((column) => column.pk > 0);
      return key.length === 1 && key[0]?.name === "id" && key[0].type === "TEXT";
    });
    const given = Object.fromEntries(
      (Object.keys(ID_TABLES) as IdKind[]).map((kind) => [ID_TABLES[kind], ID_PREFIXES[kind]]),
    );
    const withoutCharacters = Object.entries(checked)
      .filter(
        ([table, prefix]) =>
          !tableSql(table).includes(
            `CHECK (id GLOB '${prefix}_?*' AND id NOT GLOB '*[^0-9a-z_]*' AND instr(id, char(0)) = 0)`,
          ),
      )
      .map(([table]) => table);

    expect(Object.keys(checked)).toEqual(keyedByAnId.filter((table) => table !== REGISTRY));
    expect(keyedByAnId).toContain(REGISTRY);
    expect(checked).toEqual(given);
    expect(withoutCharacters).toEqual(ID_OF_A_REGISTRY_ROW);
  });
});
