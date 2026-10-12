// The boundaries that biome.json draws around the SDK client, the database library, Drizzle, the
// network and the helpers of tests, and its rule against a promise that nobody holds, proven on
// fixtures: a copy of biome.json in a temporary directory, a file that tries everything at each
// path the configuration names and at the path of every TypeScript file of the server, the shared
// code, the web app and the scripts, and the linter's own findings.
//
// Biome replaces the options of a rule when a later override matches the same file. An override
// added for one file or directory therefore switches off, for what it matches, every boundary
// it does not repeat, and "npm run lint" stays green. This test is what turns red. It also turns
// red for the other ways in which a rule can stop holding while the gate stays green: a rule
// that reports without failing the gate, a rule that is set where Biome does not run it, and a
// comment that switches a rule off for one file.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..");
const BIOME = join(REPO_ROOT, "node_modules/@biomejs/biome/bin/biome");
/** Stands for the web app: a module that server code must not import. */
const WEB_MODULE = "src/web/page.ts";
/** What only tests may import: a helper of tests, a test file, and the observer that tests load into a process. */
const TEST_HELPER = "src/server/testing.ts";
const TEST_FILE = "src/server/new-module.test.ts";
const EGRESS_OBSERVER = "src/server/egress-observer.ts";
/**
 * The database library and Drizzle's driver by their places in node_modules: the modules that the
 * names lead to, asked for by a path.
 */
const LIBRARY_FILE = "node_modules/better-sqlite3/lib/index.js";
const DRIVER_FILE = "node_modules/drizzle-orm/better-sqlite3/driver.js";
/**
 * What the database library exports below its name: an entry for each platform it ships a binary
 * for, each with a Database constructor of its own. They are read from the installed package, so
 * that an entry which a later version adds is tried as well. The manifest, which the package
 * exports too, is left out: it leads to no database.
 */
const LIBRARY_ENTRIES = Object.keys(
  (
    JSON.parse(readFileSync(join(REPO_ROOT, "node_modules/better-sqlite3/package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    }
  ).exports,
)
  .filter((entry) => entry !== "." && entry !== "./package.json")
  .map((entry) => `better-sqlite3${entry.slice(1)}`);
/**
 * The rules that a fixture tries: the three that draw the boundaries, and the one that reports a
 * promise nobody holds. A finding of any other rule means that a fixture is broken. The third
 * keeps Node's own modules out of the code that the browser loads. The only such module that a
 * fixture tries is node:sqlite, which this version of the linter does not count among them, so
 * the rule finds nothing here today. It is listed for a version that does: its finding is then
 * one more on a line that the first rule reports in src/shared already.
 */
const BOUNDARY_RULES = [
  "lint/style/noRestrictedImports",
  "lint/style/noRestrictedGlobals",
  "lint/correctness/noNodejsModules",
  "lint/nursery/noFloatingPromises",
];
/** The script that every package script runs first. It is CommonJS, so its fixture is one of its own. */
const PREFLIGHT = "scripts/preflight.cjs";
// Biome needs a fraction of a second; this is for a machine that is busy with other things.
const LINT_TIMEOUT_MS = 20_000;

/** An import specifier that leads from one file of the repository to another. */
function specifier(from: string, to: string): string {
  const path = relative(dirname(from), to);
  return path.startsWith(".") ? path : `./${path}`;
}

// A promise that nobody holds, dropped where it costs most: in the synchronous body of a
// transaction. What the async helper did before its first await is committed with the rest of
// the body, and what it does afterwards comes when the transaction is over.
const DROPPED_IN_A_BODY =
  "export const halfDone = (db: { transaction(body: () => void): void }, apply: () => Promise<void>) => db.transaction(() => { apply(); });";

// What a fixture tries, one line each. A finding is named after the line the linter points at.
const PROBES: ReadonlyArray<readonly [name: string, line: (path: string) => string]> = [
  ["browser code", (path) => `import { page } from "${specifier(path, WEB_MODULE)}";`],
  ["test helper", (path) => `import { helper } from "${specifier(path, TEST_HELPER)}";`],
  ["test file", (path) => `import { tested } from "${specifier(path, TEST_FILE)}";`],
  ["egress observer", (path) => `import { observed } from "${specifier(path, EGRESS_OBSERVER)}";`],
  ["SDK client", () => 'import Anthropic from "@anthropic-ai/sdk";'],
  ["SDK client by name", () => 'import { Anthropic as Client } from "@anthropic-ai/sdk";'],
  ["SDK base client by name", () => 'import { BaseAnthropic } from "@anthropic-ai/sdk";'],
  ["SDK namespace", () => 'import * as sdk from "@anthropic-ai/sdk";'],
  ["SDK through import()", () => 'export const lazySdk = () => import("@anthropic-ai/sdk");'],
  ["SDK client module", () => 'import { Anthropic as FromClientModule } from "@anthropic-ai/sdk/client";'],
  ["SDK index module", () => 'import FromIndexModule from "@anthropic-ai/sdk/index.mjs";'],
  ["SDK error classes and types", () => 'import { APIError, type Message } from "@anthropic-ai/sdk";'],
  ["SDK version", () => 'import { VERSION } from "@anthropic-ai/sdk/version";'],
  ["better-sqlite3", () => 'import Database from "better-sqlite3";'],
  ["better-sqlite3 through import()", () => 'export const lazyDatabase = () => import("better-sqlite3");'],
  ["better-sqlite3 platform entry", () => 'import PlatformDatabase from "better-sqlite3/darwin-arm64";'],
  [
    "better-sqlite3 platform entry through import()",
    () => 'export const lazyPlatformDatabase = () => import("better-sqlite3/darwin-arm64");',
  ],
  ...LIBRARY_ENTRIES.map(
    (entry, index) =>
      [`${entry} through require()`, () => `export const requiredEntry${index} = () => require("${entry}");`] as const,
  ),
  ["better-sqlite3 manifest", () => 'import libraryManifest from "better-sqlite3/package.json" with { type: "json" };'],
  ["better-sqlite3 by its path", (path) => `import DatabaseByPath from "${specifier(path, LIBRARY_FILE)}";`],
  [
    "better-sqlite3 by its path through import()",
    (path) => `export const lazyByPath = () => import("${specifier(path, LIBRARY_FILE)}");`,
  ],
  [
    "better-sqlite3 by its path through require()",
    (path) => `export const requiredByPath = () => require("${specifier(path, LIBRARY_FILE)}");`,
  ],
  ["node:sqlite", () => 'import { DatabaseSync } from "node:sqlite";'],
  ["sqlite", () => 'import { open } from "sqlite";'],
  ["Drizzle driver", () => 'import { drizzle } from "drizzle-orm/better-sqlite3";'],
  ["Drizzle driver through import()", () => 'export const lazyDrizzle = () => import("drizzle-orm/better-sqlite3");'],
  [
    "Drizzle driver through require()",
    () => 'export const requiredDrizzle = () => require("drizzle-orm/better-sqlite3");',
  ],
  ["Drizzle driver module", () => 'import { drizzle as fromDriverModule } from "drizzle-orm/better-sqlite3/driver";'],
  [
    "Drizzle driver module through require()",
    () => 'export const requiredDriverModule = () => require("drizzle-orm/better-sqlite3/driver");',
  ],
  ["Drizzle driver session", () => 'import { BetterSQLiteSession } from "drizzle-orm/better-sqlite3/session";'],
  [
    "Drizzle driver session through require()",
    () => 'export const requiredSession = () => require("drizzle-orm/better-sqlite3/session");',
  ],
  ["Drizzle migrator", () => 'import { migrate } from "drizzle-orm/better-sqlite3/migrator";'],
  [
    "Drizzle migrator through require()",
    () => 'export const requiredMigrator = () => require("drizzle-orm/better-sqlite3/migrator");',
  ],
  ["Drizzle migration reader", () => 'import { readMigrationFiles } from "drizzle-orm/migrator";'],
  [
    "Drizzle migration reader through require()",
    () => 'export const requiredReader = () => require("drizzle-orm/migrator");',
  ],
  ["another Drizzle driver", () => 'import { drizzle as overLibsql } from "drizzle-orm/libsql";'],
  [
    "another Drizzle driver through require()",
    () => 'export const requiredLibsql = () => require("drizzle-orm/libsql");',
  ],
  [
    "Drizzle driver by its path",
    (path) => `import { drizzle as driverByPath } from "${specifier(path, DRIVER_FILE)}";`,
  ],
  ["Drizzle query helpers", () => 'import { eq } from "drizzle-orm";'],
  ["Drizzle query helpers through require()", () => 'export const requiredHelpers = () => require("drizzle-orm");'],
  ["Drizzle tables", () => 'import { sqliteTable } from "drizzle-orm/sqlite-core";'],
  ["Drizzle tables through require()", () => 'export const requiredTables = () => require("drizzle-orm/sqlite-core");'],
  ["Drizzle table columns", () => 'import { text } from "drizzle-orm/sqlite-core/columns";'],
  ["fetch", () => 'export const viaFetch = () => fetch("https://router.corp.example/");'],
  ["WebSocket", () => 'export const viaWebSocket = () => new WebSocket("wss://router.corp.example/");'],
  ["EventSource", () => 'export const viaEventSource = () => new EventSource("https://router.corp.example/");'],
  ["dropped promise", () => DROPPED_IN_A_BODY],
];
// Keeps the imports in use, so that the boundaries are all the linter has to say about a fixture.
const USES = `export const used = [
  page,
  helper,
  tested,
  observed,
  Anthropic,
  Client,
  BaseAnthropic,
  sdk,
  FromClientModule,
  FromIndexModule,
  APIError,
  VERSION,
  Database,
  PlatformDatabase,
  libraryManifest,
  DatabaseByPath,
  DatabaseSync,
  open,
  drizzle,
  fromDriverModule,
  BetterSQLiteSession,
  migrate,
  readMigrationFiles,
  overLibsql,
  driverByPath,
  eq,
  sqliteTable,
  text,
];
export type Reply = Message;
`;

// The same attempts as a CommonJS script makes them, under the text of the real script: what
// its own comments switch off is switched off here as well.
const PREFLIGHT_PROBES: ReadonlyArray<readonly [name: string, line: string]> = [
  ["SDK client", 'var probeSdk = require("@anthropic-ai/sdk");'],
  ["SDK client module", 'var probeSdkClient = require("@anthropic-ai/sdk/client");'],
  ["better-sqlite3", 'var probeDatabase = require("better-sqlite3");'],
  ["better-sqlite3 platform entry", 'var probePlatformDatabase = require("better-sqlite3/darwin-arm64");'],
  ["better-sqlite3 by its path", `var probeDatabaseByPath = require("${specifier(PREFLIGHT, LIBRARY_FILE)}");`],
  ["node:sqlite", 'var probeNodeSqlite = require("node:sqlite");'],
  ["sqlite", 'var probeSqlite = require("sqlite");'],
  ["Drizzle driver", 'var probeDrizzle = require("drizzle-orm/better-sqlite3");'],
  ["Drizzle migrator", 'var probeDrizzleMigrator = require("drizzle-orm/better-sqlite3/migrator");'],
  ["another Drizzle driver", 'var probeOtherDrizzle = require("drizzle-orm/libsql");'],
  ["fetch", 'var probeFetch = fetch("https://router.corp.example/");'],
  ["WebSocket", 'var probeWebSocket = new WebSocket("wss://router.corp.example/");'],
  ["EventSource", 'var probeEventSource = new EventSource("https://router.corp.example/");'],
  ["dropped promise", "Promise.resolve(probeSdk);"],
];
const PREFLIGHT_USES = `console.log(
  probeSdk,
  probeSdkClient,
  probeDatabase,
  probePlatformDatabase,
  probeDatabaseByPath,
  probeNodeSqlite,
  probeSqlite,
  probeDrizzle,
  probeDrizzleMigrator,
  probeOtherDrizzle,
  probeFetch,
  probeWebSocket,
  probeEventSource
);
`;

const WEB = ["browser code"];
const TEST_CODE = ["test helper", "test file", "egress observer"];
// A file of an installed package, asked for by its path into node_modules. That leads past every
// rule that names the package, so no application code does it, whatever the package.
const NODE_MODULES = [
  "better-sqlite3 by its path",
  "better-sqlite3 by its path through import()",
  "Drizzle driver by its path",
];
const SDK = [
  "SDK client",
  "SDK client by name",
  "SDK base client by name",
  "SDK namespace",
  "SDK through import()",
  "SDK client module",
  "SDK index module",
];
// What the database library has below its name, which no application code imports: its entries
// for single platforms, and for import and import() whatever else is there, of which the
// manifest is tried.
const DATABASE_LIBRARY_BELOW_ITS_NAME = [
  "better-sqlite3 platform entry",
  "better-sqlite3 platform entry through import()",
  ...LIBRARY_ENTRIES.map((entry) => `${entry} through require()`),
  "better-sqlite3 manifest",
];
const DATABASE_LIBRARY = ["better-sqlite3", "better-sqlite3 through import()", ...DATABASE_LIBRARY_BELOW_ITS_NAME];
const OTHER_SQLITE = ["node:sqlite", "sqlite"];
const NETWORK = ["fetch", "WebSocket", "EventSource"];
// Drizzle's driver for better-sqlite3. Given a path, it opens a database file by itself.
const DRIZZLE_DRIVER = ["Drizzle driver", "Drizzle driver through import()", "Drizzle driver through require()"];
// What no application code imports: the modules that this driver is made of, Drizzle's own
// migrator, which is not what runs the migrations here, and every other driver.
const DRIZZLE_BESIDE_THE_DRIVER = [
  "Drizzle driver module",
  "Drizzle driver module through require()",
  "Drizzle driver session",
  "Drizzle driver session through require()",
  "Drizzle migrator",
  "Drizzle migrator through require()",
  "Drizzle migration reader",
  "Drizzle migration reader through require()",
  "another Drizzle driver",
];
const DRIZZLE = [...DRIZZLE_DRIVER, ...DRIZZLE_BESIDE_THE_DRIVER];
// Query helpers and tables. Every file of the server and every script may import them; the code
// that the browser loads may not.
const DRIZZLE_FOR_QUERIES = [
  "Drizzle query helpers",
  "Drizzle query helpers through require()",
  "Drizzle tables",
  "Drizzle tables through require()",
  "Drizzle table columns",
];
// The linter holds import and import() against the patterns of biome.json, and require() only
// against the modules that are listed there by their exact name. So each of those is tried
// through require() as well, and two attempts are in no list at all, so that nothing reports
// them. "another Drizzle driver through require()": such a driver needs the client package it
// was written for before it can open anything, and of those packages only better-sqlite3 is
// installed. "better-sqlite3 by its path through require()": a path has more spellings than a
// list can hold. Nor does the linter see a module that is asked for in a way it does not read:
// through createRequire(), unless the function it gives is called require, by an import() of
// anything but a literal text, or under a name in another letter case, which the file system of
// a Mac takes for the same name.

// A promise that nobody holds: it is not awaited, not returned, not given a handler for its
// failure and not let go on purpose with void. The application code of the server and of the
// scripts drops none. Tests may, to show what follows, and the code that the browser loads is
// not held to it. Biome runs the rule only when it is on at the top level of the configuration:
// there it is on for everything, and two overrides switch it off again for the rest. Set to
// "error" in an override alone, it reports nothing.
//
// The rule goes by the types that the linter works out by itself, so it is silent where it
// cannot tell that a call gives a promise: about a call on a parameter that has its type from
// the place the function is handed to, such as the next() of a middleware, about what Node's
// own modules and the SDK client give back, and about a query of Drizzle that is built and never
// run, or run with execute() of its builder. A promise that leaves a body inside an object or
// an array is not dropped to it either. Two things it reports that are no promise: a call whose
// result has a conditional type with a promise in one of its branches, whichever branch applies,
// and a call of an async generator function.
const DROPPED_PROMISE = ["dropped promise"];

// What must be reported at each path, and nothing else. The SDK's error classes, its types and
// its version are in no list: every file may import them by name.
const FIXTURES = {
  // Code that has no business with any of it: a new module on the server, a new script.
  "src/server/new-module.ts": [
    ...WEB,
    ...TEST_CODE,
    ...NODE_MODULES,
    ...SDK,
    ...DATABASE_LIBRARY,
    ...OTHER_SQLITE,
    ...NETWORK,
    ...DRIZZLE,
    ...DROPPED_PROMISE,
  ],
  "scripts/new-script.ts": [
    ...TEST_CODE,
    ...NODE_MODULES,
    ...SDK,
    ...DATABASE_LIBRARY,
    ...OTHER_SQLITE,
    ...NETWORK,
    ...DRIZZLE,
    ...DROPPED_PROMISE,
  ],
  // The places that build SDK clients and call out. Each keeps every other boundary.
  "src/server/llm/client.ts": [
    ...WEB,
    ...TEST_CODE,
    ...NODE_MODULES,
    ...DATABASE_LIBRARY,
    ...OTHER_SQLITE,
    ...DRIZZLE,
    ...DROPPED_PROMISE,
  ],
  "src/server/llm/diagnostics/run.ts": [
    ...WEB,
    ...TEST_CODE,
    ...NODE_MODULES,
    ...DATABASE_LIBRARY,
    ...OTHER_SQLITE,
    ...DRIZZLE,
    ...DROPPED_PROMISE,
  ],
  "scripts/diagnose.ts": [
    ...TEST_CODE,
    ...NODE_MODULES,
    ...DATABASE_LIBRARY,
    ...OTHER_SQLITE,
    ...DRIZZLE,
    ...DROPPED_PROMISE,
  ],
  // The one place that opens the database. It imports the library by its name and nothing below it.
  "src/server/workspace/database.ts": [
    ...WEB,
    ...TEST_CODE,
    ...NODE_MODULES,
    ...SDK,
    ...DATABASE_LIBRARY_BELOW_ITS_NAME,
    ...OTHER_SQLITE,
    ...NETWORK,
    ...DRIZZLE,
    ...DROPPED_PROMISE,
  ],
  // The one place that puts Drizzle on the connection opened there. It imports the driver by its
  // entry and nothing beside it, and not the database library: it opens nothing itself.
  "src/server/db/handle.ts": [
    ...WEB,
    ...TEST_CODE,
    ...NODE_MODULES,
    ...SDK,
    ...DATABASE_LIBRARY,
    ...OTHER_SQLITE,
    ...NETWORK,
    ...DRIZZLE_BESIDE_THE_DRIVER,
    ...DROPPED_PROMISE,
  ],
  // Tests and their helpers may use all of it, except a second SQLite library, and may drop a
  // promise. On the server they stay clear of browser code as well.
  "src/server/new-module.test.ts": [...WEB, ...OTHER_SQLITE],
  "src/server/testing.ts": [...WEB, ...OTHER_SQLITE],
  "scripts/new-script.test.ts": [...OTHER_SQLITE],
  // The script that gives the end-to-end run its workspace is a tool of the tests: it creates
  // that workspace with their helper, and is a script like any other in everything else.
  "scripts/e2e-workspace.ts": [
    ...NODE_MODULES,
    ...SDK,
    ...DATABASE_LIBRARY,
    ...OTHER_SQLITE,
    ...NETWORK,
    ...DRIZZLE,
    ...DROPPED_PROMISE,
  ],
  // What the server and the web app share is loaded by the server, so it is held to the server's
  // boundaries. Importing from the server at all is out of bounds there, which covers the helpers.
  // It is loaded by the browser too, so nothing of Drizzle belongs in it, tables included.
  "src/shared/new-module.ts": [
    ...WEB,
    ...TEST_CODE,
    ...NODE_MODULES,
    ...SDK,
    ...DATABASE_LIBRARY,
    ...OTHER_SQLITE,
    ...NETWORK,
    ...DRIZZLE,
    ...DRIZZLE_FOR_QUERIES,
  ],
  "src/shared/new-module.test.ts": [
    ...WEB,
    ...TEST_CODE,
    ...NODE_MODULES,
    ...SDK,
    ...DATABASE_LIBRARY,
    ...OTHER_SQLITE,
    ...DRIZZLE,
    ...DRIZZLE_FOR_QUERIES,
  ],
  // The web app is what the browser loads, and its tests are held to the same as its modules. It
  // is kept from the server, which is where a fixture looks for the three modules that only tests
  // import, from paths into node_modules, from the database library and from Drizzle. Of what a
  // fixture tries, that is all the linter keeps it from.
  "src/web/new-module.ts": [...TEST_CODE, ...NODE_MODULES, ...DATABASE_LIBRARY, ...DRIZZLE, ...DRIZZLE_FOR_QUERIES],
  "src/web/new-module.test.ts": [
    ...TEST_CODE,
    ...NODE_MODULES,
    ...DATABASE_LIBRARY,
    ...DRIZZLE,
    ...DRIZZLE_FOR_QUERIES,
  ],
} as const satisfies Record<string, readonly string[]>;
// The one CommonJS script, which is a script like any other. All it can do is require(), so the
// other Drizzle driver and the database library by its path are not found here either.
const PREFLIGHT_FINDINGS = [
  "SDK client",
  "SDK client module",
  ...OTHER_SQLITE,
  "better-sqlite3",
  "better-sqlite3 platform entry",
  "Drizzle driver",
  "Drizzle migrator",
  ...NETWORK,
  ...DROPPED_PROMISE,
];

type Fixture = keyof typeof FIXTURES;

/** The fixture whose rules a file under src/server, src/shared, src/web or scripts comes under. */
function fixtureFor(path: string): Fixture {
  if (path in FIXTURES) return path as Fixture;
  if (path.startsWith("src/web/")) {
    return /\.test\.tsx?$/.test(path) ? "src/web/new-module.test.ts" : "src/web/new-module.ts";
  }
  // The configuration knows a test by the name *.test.ts and a helper by the name testing.ts:
  // under any other extension a file is held to the rules of a module.
  const isTest = path.endsWith(".test.ts");
  if (path.startsWith("src/shared/")) return isTest ? "src/shared/new-module.test.ts" : "src/shared/new-module.ts";
  const onServer = path.startsWith("src/server/");
  if (isTest) return onServer ? "src/server/new-module.test.ts" : "scripts/new-script.test.ts";
  if (onServer && path.endsWith("/testing.ts")) return "src/server/testing.ts";
  if (path.startsWith("src/server/llm/diagnostics/")) return "src/server/llm/diagnostics/run.ts";
  return onServer ? "src/server/new-module.ts" : "scripts/new-script.ts";
}

/**
 * The TypeScript files of the repository under a directory, under every extension that the
 * compiler reads, as paths from the repository root.
 */
function sourcesUnder(directory: string): string[] {
  return readdirSync(join(REPO_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourcesUnder(path);
    return /\.[cm]?tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** In the order of the probes, so that two lists of findings compare whatever order they came in. */
function inProbeOrder(names: readonly string[]): string[] {
  const order = PROBES.map(([name]) => name);
  return [...names].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

interface Report {
  summary: { errors: number; warnings: number; infos: number };
  diagnostics: {
    category: string;
    severity: string;
    message: string;
    location: { path: string; start: { line: number } };
  }[];
}

/**
 * Puts a fixture at every path, lints the lot with the repository's configuration, and gives
 * back what was found at each path.
 */
function lint(dir: string, paths: readonly string[]): Map<string, string[]> {
  copyFileSync(join(REPO_ROOT, "biome.json"), join(dir, "biome.json"));
  mkdirSync(join(dir, dirname(WEB_MODULE)), { recursive: true });
  writeFileSync(join(dir, WEB_MODULE), "export const page = 1;\n");
  for (const path of paths) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), `${PROBES.map(([, line]) => line(path)).join("\n")}\n${USES}`);
  }
  // The real script, comments and all, with the attempts under it.
  const preflight = readFileSync(join(REPO_ROOT, PREFLIGHT), "utf8");
  const preflightLines = preflight.split("\n").length - 1;
  writeFileSync(
    join(dir, PREFLIGHT),
    `${preflight}${PREFLIGHT_PROBES.map(([, line]) => line).join("\n")}\n${PREFLIGHT_USES}`,
  );

  // Run in the directory, the way "npm run lint" runs in the repository: the configuration is
  // found there and its paths are read from there. There is no git and so no ignore file to use.
  const run = spawnSync(process.execPath, [BIOME, "lint", "--reporter=json", "--vcs-enabled=false", "."], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
    // The report has a few hundred bytes for each finding and grows with the repository; the
    // megabyte allowed by default would cut it off one day.
    maxBuffer: 64 * 1024 * 1024,
    // A synchronous call cannot be interrupted by the test's own time limit.
    timeout: LINT_TIMEOUT_MS,
  });
  let report: Partial<Report> | null = null;
  try {
    report = JSON.parse(run.stdout) as Partial<Report> | null;
  } catch {
    // Reported below, with what Biome printed instead.
  }
  // Biome calls this reporter experimental: its shape may change with any release.
  if (!Array.isArray(report?.diagnostics) || report.summary === undefined) {
    const outcome = run.error?.message ?? `exit code ${run.status}`;
    const printed = `${String(run.stdout).slice(0, 2_000)}\n${String(run.stderr).slice(0, 2_000)}`;
    throw new Error(`Biome printed no report of the expected shape (${outcome}).\n${printed}`);
  }
  const { errors, warnings, infos } = report.summary;
  // A list cut short would read as boundaries that hold.
  if (report.diagnostics.length !== errors + warnings + infos) {
    throw new Error(`Biome printed ${report.diagnostics.length} of its ${errors + warnings + infos} findings.`);
  }

  const found = new Map([...paths, PREFLIGHT].map((path): [string, string[]] => [path, []]));
  for (const { category, severity, message, location } of report.diagnostics) {
    const names = found.get(location.path);
    if (names === undefined) {
      throw new Error(`Biome reports a file that is no fixture: ${location.path} (${category}).`);
    }
    const probe =
      location.path === PREFLIGHT
        ? PREFLIGHT_PROBES[location.start.line - 1 - preflightLines]
        : PROBES[location.start.line - 1];
    let name = probe !== undefined && BOUNDARY_RULES.includes(category) ? probe[0] : `${category}: ${message}`;
    // "npm run lint" fails for an error and, as it is called, for a warning; a finding of any
    // lower rank is printed and the gate stays green. A boundary is a rule that fails the gate.
    if (severity !== "error") name += ` (reported as ${severity}, which is not an error)`;
    // One attempt can break two rules. It is one attempt all the same.
    if (!names.includes(name)) names.push(name);
  }
  return found;
}

/**
 * The comments in a file that switch lint rules off, each as the rule or the group of rules it
 * names: "lint/style/useTemplate", "lint/style", "lint". One comment can name several, and a rule
 * can come with a value in brackets, which is left out.
 */
function suppressions(text: string): string[] {
  return [...text.matchAll(/biome-ignore(?:-all|-start)?[ \t]+([^:\n]*)/g)].flatMap(([, named = ""]) =>
    named
      .split(/\s+/)
      .map((category) => category.replace(/\(.*$/, ""))
      .filter(Boolean),
  );
}

/** Every file that the linter reads under a directory, whatever its language. */
function filesUnder(directory: string): string[] {
  return readdirSync(join(REPO_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

describe("the lint boundaries", () => {
  // Every TypeScript file there is, beside the fixtures: an override written for one of them must
  // not go unnoticed.
  const sources = ["src/server", "src/shared", "src/web", "scripts"].flatMap(sourcesUnder);
  let dir: string;
  let found: Map<string, string[]>;

  const foundAt = (path: string): string[] => inProbeOrder(found.get(path) ?? [`not linted: ${path}`]);
  const expectedAt = (fixture: Fixture): string[] => inProbeOrder(FIXTURES[fixture]);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "hubber-lint-"));
    found = lint(dir, [...new Set([...Object.keys(FIXTURES), ...sources])]);
  }, LINT_TIMEOUT_MS + 5_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(Object.keys(FIXTURES) as Fixture[])("report in %s what is out of bounds there, and nothing else", (path) => {
    expect(foundAt(path)).toEqual(expectedAt(path));
  });

  it("are tried with every entry that the database library has below its name", () => {
    // The control: the entries are read from the installed package, and the one that the fixtures
    // import is among them.
    expect(LIBRARY_ENTRIES).toContain("better-sqlite3/darwin-arm64");
  });

  it("let every file import the SDK's error classes, types and version by name", () => {
    const refusing = [...found.keys()].filter((path) =>
      foundAt(path).some((name) => name.startsWith("SDK error classes and types") || name.startsWith("SDK version")),
    );
    expect(refusing).toEqual([]);
  });

  it("hold every TypeScript file under src/server, src/shared, src/web and scripts to the rules of its kind", () => {
    const actual = Object.fromEntries(sources.map((path) => [path, foundAt(path)]));
    const expected = Object.fromEntries(sources.map((path) => [path, expectedAt(fixtureFor(path))]));
    expect(actual).toEqual(expected);
  });

  it("hold the script that every package script runs first, under the comments it really has", () => {
    // In the order of the attempts in that fixture.
    const order = PREFLIGHT_PROBES.map(([name]) => name);
    const sorted = (names: readonly string[]) => [...names].sort((a, b) => order.indexOf(a) - order.indexOf(b));

    expect(sorted(found.get(PREFLIGHT) ?? ["not linted"])).toEqual(sorted(PREFLIGHT_FINDINGS));
  });

  it("are switched off by no comment in any file of the server, the shared code, the web app, the scripts or the browser tests", () => {
    // A comment can name one rule, a group of rules, or all of them. Whatever it names must not
    // be a boundary rule or contain one. The rule against a dropped promise is held the same way:
    // a promise that is meant to go is let go with void, which says so where it happens.
    const switchesOffABoundary = (category: string) =>
      BOUNDARY_RULES.some((rule) => rule === category || rule.startsWith(`${category}/`));
    const files = ["src", "scripts", "e2e"].flatMap(filesUnder);
    const offenders = files.flatMap((path) =>
      suppressions(readFileSync(join(REPO_ROOT, path), "utf8"))
        .filter(switchesOffABoundary)
        .map((category) => `${path}: ${category}`),
    );

    expect(offenders).toEqual([]);
    // The search does find such comments where there are some: these are the ones of today.
    expect(suppressions(readFileSync(join(REPO_ROOT, PREFLIGHT), "utf8"))).toEqual([
      "lint/style/useNodejsImportProtocol",
      "lint/style/useTemplate",
    ]);
    // Put together here, so that this file holds no such comment for the search above to find.
    const ignore = ["biome", "ignore"].join("-");
    const sample = [
      `// ${ignore} lint/style/noRestrictedGlobals: once`,
      `/* ${ignore}-all lint/suspicious/noExplicitAny lint/style: two in one */`,
      `// ${ignore}-start lint/correctness/noNodejsModules(node:fs): with a value`,
      `// ${ignore}-end lint/correctness/noNodejsModules(node:fs): the end of a range switches nothing off`,
      `// ${ignore} format: not a lint rule`,
    ];
    expect(suppressions(sample.join("\n"))).toEqual([
      "lint/style/noRestrictedGlobals",
      "lint/suspicious/noExplicitAny",
      "lint/style",
      "lint/correctness/noNodejsModules",
      "format",
    ]);
    const groups = ["lint", "lint/style", "lint/correctness", "lint/nursery"];
    expect([...groups, ...BOUNDARY_RULES].filter(switchesOffABoundary)).toEqual([...groups, ...BOUNDARY_RULES]);
    expect(["lint/style/useTemplate", "lint/suspicious", "format", "lint/styles"].filter(switchesOffABoundary)).toEqual(
      [],
    );
  });
});

// Node's own modules for the network and for starting programs. The client opens its connections
// with node:http and node:https, so the ban on fetch does not say where the server can call out
// from: a request made with node:https in any other module would pass the linter. Biome could
// ban these modules for a directory, but an exception for one file replaces every other ban for
// that file, and each of the files below would need an override that repeats them all. So this
// boundary is drawn here, on the text of the sources, and it is exact: a file that is not listed
// uses none of the modules, and a listed file uses the ones it is listed with.
const OUTWARD_MODULES = [
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dgram",
  "dns",
  "dns/promises",
  "child_process",
  "worker_threads",
  "cluster",
  "inspector",
  "inspector/promises",
];
/** Who may use which of them, and what for. */
const OUTWARD_USE: Record<string, { modules: string[]; purpose: string }> = {
  "src/server/listen.ts": { modules: ["http", "net"], purpose: "the server's own port on the loopback address" },
  "src/server/llm/client.ts": { modules: ["http", "https"], purpose: "the connection to the pinned endpoint" },
  "src/server/workspace/transport.ts": {
    modules: ["http", "https"],
    purpose: "reads how Node would connect; opens nothing",
  },
  "src/server/llm/credentials/helper-source.ts": { modules: ["child_process"], purpose: "the helper command" },
  "src/server/busy-port.ts": { modules: ["child_process"], purpose: "lsof and ps, to name who holds the port" },
  "scripts/dev.ts": { modules: ["child_process", "net"], purpose: "the two servers, and the check of their ports" },
  "scripts/diagnose.ts": { modules: ["child_process"], purpose: "the credential command of Claude Code's settings" },
};
// Other ways to the same modules and to the network that the linter does not see either.
const OUTWARD_SPELLINGS: ReadonlyArray<readonly [name: string, pattern: RegExp]> = [
  ["process.binding", /\bprocess\s*\.\s*binding\b/],
  ["process.getBuiltinModule", /\bgetBuiltinModule\b/],
  ["globalThis.fetch", /\bglobalThis\s*(?:\.\s*|\[\s*["'])(?:fetch|WebSocket|EventSource)\b/],
];

/** The outward modules a source text imports, in any of the ways a module can be asked for, with or without "node:". */
function outwardModulesIn(text: string): string[] {
  const names = OUTWARD_MODULES.map((name) => name.replace("/", "\\/")).join("|");
  const asked = new RegExp(
    `(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)["'](?:node:)?(${names})["']`,
    "g",
  );
  const found = new Set([...text.matchAll(asked)].flatMap(([, name]) => (name === undefined ? [] : [name])));
  for (const [name, pattern] of OUTWARD_SPELLINGS) if (pattern.test(text)) found.add(name);
  return [...found].sort();
}

describe("the modules that lead out of the process", () => {
  // Application code: everything the server, the shared code and the scripts are made of, apart
  // from tests, their helpers and the observer, which only tests load. It is code under every
  // extension that Node or the bundler takes for a script. A test is a file named *.test.ts,
  // which is what Vitest runs outside the web app: under any other extension a file is
  // application code, whatever it is called.
  const isApplicationCode = (path: string) =>
    /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path) &&
    !path.endsWith(".test.ts") &&
    !path.endsWith("/testing.ts") &&
    path !== EGRESS_OBSERVER;
  const files = ["src/server", "src/shared", "scripts"].flatMap(filesUnder).filter(isApplicationCode);

  it("are used by the files that are listed for them, and by no other application code", () => {
    const used = Object.fromEntries(
      files.flatMap((path) => {
        const modules = outwardModulesIn(readFileSync(join(REPO_ROOT, path), "utf8"));
        return modules.length === 0 ? [] : [[path, modules]];
      }),
    );
    const listed = Object.fromEntries(
      Object.entries(OUTWARD_USE).map(([path, { modules }]) => [path, [...modules].sort()]),
    );

    // A file that is missing from the right-hand side uses a module without being listed: say
    // what it needs the module for in OUTWARD_USE, or do without it.
    expect(used).toEqual(listed);
    expect(files.length).toBeGreaterThan(40);
  });

  it("are looked for in every file that holds code, whatever its extension, and in no test", () => {
    const code = [
      "src/server/app.ts",
      "src/server/db/module.mts",
      "src/server/db/module.cts",
      "src/shared/component.tsx",
      "src/shared/component.jsx",
      "scripts/tool.js",
      "scripts/tool.mjs",
      PREFLIGHT,
      // Tests by their names only: Vitest runs none of them.
      "src/server/db/module.test.mts",
      "src/shared/component.test.tsx",
      "scripts/tool.test.cjs",
    ];
    const noCode = [
      "src/server/app.test.ts",
      "src/server/db/testing.ts",
      EGRESS_OBSERVER,
      "src/server/db/migrations/0002_example.sql",
      "src/server/db/migrations/manifest.json",
      "src/server/db/fixtures/after-0002_example.sqlite.gz",
      "scripts/notes.ts.md",
      "scripts/ts",
    ];

    expect(code.filter(isApplicationCode)).toEqual(code);
    expect(noCode.filter(isApplicationCode)).toEqual([]);
  });

  it("are found in every way a module can be asked for", () => {
    const sample = [
      'import { get } from "node:https";',
      'import tls from "tls";',
      'import type { AddressInfo } from "node:net";',
      'import {\n  spawn,\n} from "node:child_process";',
      'const dgram = await import("node:dgram");',
      'var http2 = require("http2");',
      'import "node:cluster";',
      'export { lookup } from "node:dns/promises";',
      "const binding = process.binding('tcp_wrap');",
      'const net = process.getBuiltinModule("node:net");',
      'globalThis.fetch("https://router.corp.example/");',
      'new globalThis["WebSocket"]("wss://router.corp.example/");',
    ].join("\n");

    expect(outwardModulesIn(sample)).toEqual(
      [
        "child_process",
        "cluster",
        "dgram",
        "dns/promises",
        "globalThis.fetch",
        "http2",
        "https",
        "net",
        "process.binding",
        "process.getBuiltinModule",
        "tls",
      ].sort(),
    );
    // What only looks alike: other modules, and words in a comment or a message.
    const harmless = [
      'import { readFileSync } from "node:fs";',
      'import { createRequire } from "node:module";',
      'import { Hono } from "hono";',
      'import { parse } from "./http.ts";',
      "// Connections are opened with node:http and node:https.",
      'const text = "opcje --require i --import";',
      "app.fetch(request);",
    ].join("\n");
    expect(outwardModulesIn(harmless)).toEqual([]);
  });
});
