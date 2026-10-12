// What creating and opening a workspace load into a process. Loading drizzle-orm costs a process
// about a fifth of a second, and the tests start hundreds of processes that create or open a
// workspace; neither needs it: the migrations are plain SQL over the connection. Nothing fails
// when one of these modules starts to import the ORM, only every run gets slower, so the modules
// that a fresh process loads are counted here.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnNode } from "../testing.ts";

// Imports what its arguments name and prints the address of every module that was loaded on the
// way, by "import" or by "require", in a package or in this repository.
const RECORD_LOADS = `import { registerHooks } from "node:module";
const loaded = [];
registerHooks({
  load(url, context, nextLoad) {
    loaded.push(url);
    return nextLoad(url, context);
  },
});
for (const target of process.argv.slice(2)) await import(target);
console.log(JSON.stringify(loaded));
`;

// Does the work itself, and prints the address of every module that was loaded up to its end: a
// module can also be asked for inside a function, by "import()" or by "require", and is then
// loaded when the function runs and not when its module is imported. The process creates a
// workspace at the schema of this code, and one whose database holds the pin alone, and opens
// both, so the runner of the migrations goes down each of its ways: without a copy, with nothing
// to apply, and with a copy made first. With a module named as its last argument, it asks for that
// one the way such a function would, without waiting for it: the control.
const RECORD_THE_WORK = `import { registerHooks } from "node:module";
const loaded = [];
registerHooks({
  load(url, context, nextLoad) {
    loaded.push(url);
    return nextLoad(url, context);
  },
});
const [testing, open, transport, lazy] = process.argv.slice(2);
const { createTestWorkspace, createUnmigratedTestWorkspace } = await import(testing);
const { openWorkspace } = await import(open);
const { DIRECT_TRANSPORT } = await import(transport);
const applied = [];
for (const workspace of [createTestWorkspace(), createUnmigratedTestWorkspace()]) {
  try {
    const opened = openWorkspace({ dir: workspace.dir, source: "variable" }, {}, DIRECT_TRANSPORT);
    applied.push(opened.migration.applied.length);
    opened.close();
  } finally {
    workspace.remove();
  }
}
if (lazy !== undefined) void import(lazy);
// What nobody waits for is loaded a moment later.
await new Promise((resolve) => setTimeout(resolve, 250));
console.log(JSON.stringify({ applied, loaded }));
`;

const moduleOf = (path: string) => pathToFileURL(join(import.meta.dirname, path)).href;
const ofDrizzle = (url: string) => url.includes("/node_modules/drizzle-orm/");

let workDir: string;
let recordLoads: string;
let recordTheWork: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "hubber-module-graph-"));
  recordLoads = join(workDir, "record-loads.mjs");
  writeFileSync(recordLoads, RECORD_LOADS);
  recordTheWork = join(workDir, "record-the-work.mjs");
  writeFileSync(recordTheWork, RECORD_THE_WORK);
});

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

/** The modules a fresh process loads when it imports the given ones, in the order of loading. */
async function loadedBy(...targets: string[]): Promise<string[]> {
  const run = spawnNode(recordLoads, { args: targets });
  const exit = await run.exited;
  expect({ ...exit, stderr: run.stderr() }).toEqual({ code: 0, signal: null, stderr: "" });
  return JSON.parse(run.stdout()) as string[];
}

/** The modules a fresh process has loaded once it has created two workspaces and opened them, and how many migrations each open applied. */
async function loadedByTheWork(lazy?: string): Promise<{ applied: number[]; loaded: string[] }> {
  const run = spawnNode(recordTheWork, {
    args: [
      moduleOf("testing.ts"),
      moduleOf("open.ts"),
      moduleOf("transport.ts"),
      ...(lazy === undefined ? [] : [lazy]),
    ],
    // The throwaway workspaces of the process go where those of this test go.
    env: { TMPDIR: workDir },
  });
  const exit = await run.exited;
  expect({ ...exit, stderr: run.stderr() }).toEqual({ code: 0, signal: null, stderr: "" });
  return JSON.parse(run.stdout()) as { applied: number[]; loaded: string[] };
}

describe("the modules that a process loads", () => {
  it.each([
    ["creating a workspace", "create.ts"],
    ["opening a workspace", "open.ts"],
    ["migrating a database", "../db/migrate.ts"],
  ])("include nothing of drizzle-orm for %s", async (_what, path) => {
    const loaded = await loadedBy(moduleOf(path));

    expect(loaded.filter(ofDrizzle)).toEqual([]);
    // The control: the modules were seen, the runner of the migrations and the database library among them.
    expect(loaded).toEqual(expect.arrayContaining([moduleOf(path), moduleOf("../db/migrate.ts")]));
    expect(loaded.some((url) => url.includes("/node_modules/better-sqlite3/"))).toBe(true);
  });

  it("would show drizzle-orm if anything loaded it", async () => {
    // The other control: the package is installed, and a process that imports it is seen to load it.
    const drizzle = pathToFileURL(createRequire(import.meta.url).resolve("drizzle-orm")).href;

    expect((await loadedBy(drizzle)).filter(ofDrizzle).length).toBeGreaterThan(10);
  });

  it("include nothing of drizzle-orm once a workspace was created, migrated and opened: no function asks for it either", async () => {
    const { applied, loaded } = await loadedByTheWork();

    expect(loaded.filter(ofDrizzle)).toEqual([]);
    // The control: the work was done. The first open found nothing to apply, the second one migrated.
    expect(applied[0]).toBe(0);
    expect(applied[1]).toBeGreaterThan(0);
    expect(loaded).toEqual(
      expect.arrayContaining([moduleOf("open.ts"), moduleOf("create.ts"), moduleOf("../db/migrate.ts")]),
    );
  });

  it("would show drizzle-orm if a function asked for it without waiting", async () => {
    // The control for the wait at the end of the work: what is asked for there has been loaded by then.
    const drizzle = pathToFileURL(createRequire(import.meta.url).resolve("drizzle-orm")).href;

    expect((await loadedByTheWork(drizzle)).loaded.filter(ofDrizzle).length).toBeGreaterThan(10);
  });
});
