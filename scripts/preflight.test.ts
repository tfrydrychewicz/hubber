import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnNode } from "../src/server/testing.ts";

// Absolute, so that the tests do not depend on the directory Vitest was started from.
const REPO_ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts/preflight.cjs");

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  engines: { node: string };
  scripts: { [name: string]: string; start: string };
  dependencies: { [name: string]: string };
  devDependencies: { [name: string]: string };
  allowScripts: { [name: string]: boolean };
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hubber-preflight-"));
  tempDirs.push(dir);
  return dir;
}

/** Runs the script, or a copy of it, to its end. */
async function preflight(version?: string, script = SCRIPT) {
  const run = spawnNode(script, { args: version === undefined ? [] : [version] });
  const { code } = await run.exited;
  return { code, stdout: run.stdout(), stderr: run.stderr() };
}

const ASKS_FOR_INSTALL = { code: 1, stdout: "", stderr: 'Brak zainstalowanych zależności. Uruchom "npm install".\n' };
const PASSES = { code: 0, stdout: "", stderr: "" };
const DEPENDENCIES = [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)];

/**
 * A stand-in for a checkout in which nothing is installed: a copy of the script at its place and
 * a package.json beside it, the real one unless another is given. The script looks for
 * node_modules beside its own directory, so the copy never sees the real install.
 */
function checkout(packageJson = readFileSync(join(REPO_ROOT, "package.json"), "utf8")) {
  const root = tempDir();
  const script = join(root, "scripts/preflight.cjs");
  mkdirSync(join(root, "scripts"));
  copyFileSync(SCRIPT, script);
  writeFileSync(join(root, "package.json"), packageJson);
  return { root, script };
}

/** Puts packages into a stand-in as far as the script looks: each with its package.json. */
function install(root: string, names: readonly string[]): void {
  for (const name of names) {
    mkdirSync(join(root, "node_modules", name), { recursive: true });
    writeFileSync(join(root, "node_modules", name, "package.json"), "{}");
  }
}

describe("preflight", () => {
  it("passes silently on the Node that runs the tests", async () => {
    const result = await preflight();
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toBe("");
  });

  it.each(["22.11.0", "25.9.1", "8.0.0"])(
    "rejects Node %s with a Polish message that names the version",
    async (version) => {
      const result = await preflight(version);
      expect(result.code).toBe(1);
      expect(result.stderr).toBe(`Hubber wymaga Node 26 lub nowszego (masz ${version}). Uruchom "nvm use".\n`);
    },
  );

  it.each(["26.0.0", "27.1.0"])("accepts Node %s", async (version) => {
    expect((await preflight(version)).code).toBe(0);
  });

  it("agrees with .nvmrc and with the engines field", async () => {
    const nvmrc = readFileSync(join(REPO_ROOT, ".nvmrc"), "utf8").trim();
    expect(manifest.engines.node).toBe(`>=${nvmrc}`);
    expect((await preflight(`${nvmrc}.0.0`)).code).toBe(0);
    expect((await preflight(`${Number(nvmrc) - 1}.99.0`)).code).toBe(1);
  });

  it("has npm refuse to install on a Node that the engines field rules out", () => {
    // Without this setting npm only warns about the engines field and installs all the same.
    expect(readFileSync(join(REPO_ROOT, ".npmrc"), "utf8").split("\n")).toContain("engine-strict=true");
  });

  it("asks for an install until the dependencies are in place", async () => {
    const { root, script } = checkout();

    expect(await preflight(undefined, script)).toEqual(ASKS_FOR_INSTALL);

    // What an install that was cut short can leave: the directories, with nothing in them yet.
    for (const name of DEPENDENCIES) mkdirSync(join(root, "node_modules", name), { recursive: true });
    expect(await preflight(undefined, script)).toEqual(ASKS_FOR_INSTALL);

    install(root, DEPENDENCIES);
    expect(await preflight(undefined, script)).toEqual(PASSES);
  });

  // What a checkout looks like that was updated to a version with one more dependency and not
  // installed again. Without the check the command would start and fail in the middle, with
  // Node's own error about a package it cannot find. One of each kind: needed to run and needed
  // to develop, with a plain name and with a scope in it, alone in its scope and beside others.
  it.each(["better-sqlite3", "@anthropic-ai/sdk", "vite", "@biomejs/biome", "@types/better-sqlite3"])(
    "asks for an install when %s is the one dependency that is missing",
    async (missing) => {
      const { root, script } = checkout();
      install(
        root,
        DEPENDENCIES.filter((name) => name !== missing),
      );

      expect(await preflight(undefined, script)).toEqual(ASKS_FOR_INSTALL);
    },
  );

  it.each([
    ["dependencies", { devDependencies: { vite: "^8.0.0" } }],
    ["devDependencies", { dependencies: { hono: "^4.0.0" } }],
  ])("reads a package.json that has no %s", async (_absent, packageJson) => {
    const { root, script } = checkout(JSON.stringify(packageJson));

    expect(await preflight(undefined, script)).toEqual(ASKS_FOR_INSTALL);

    install(root, ["vite", "hono"]);
    expect(await preflight(undefined, script)).toEqual(PASSES);
  });

  it("is written in syntax that a Node from before ES modules can read", () => {
    // Such a Node reads the whole file before it runs the first line, so one newer construct
    // anywhere, a comma that the formatter puts behind the last argument of a call broken over
    // lines included, would replace the message about the version by a syntax error. Looked
    // for in the code alone: strings and comments may say what they like.
    const code = readFileSync(SCRIPT, "utf8")
      .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""')
      .replace(/\/\/.*$/gm, "");

    expect(code).toContain("require(");
    expect(code).not.toMatch(/=>|`|\.\.\.|\*\*|\?\?|\?\.|\b(?:const|let|class|import|export|async|await|of)\b/);
    expect(code).not.toMatch(/,\s*\)/);
  });
});

describe("package scripts", () => {
  // In the script itself and not in a "pre" script: npm skips those when ignore-scripts is set.
  it.each([
    "dev",
    "build",
    "start",
    "test",
    "test:watch",
    "check",
    "diagnose",
    "workspace:create",
    "synthetic",
    "perf",
    "db:fixture",
  ])("%s runs the preflight before anything else", (name) => {
    expect(manifest.scripts[name]).toMatch(/^node scripts\/preflight\.cjs && /);
  });

  // exec puts the command in the place of the shell that npm started, so the signals npm passes
  // on reach it. Behind a shell that waits for it, a stopped "npm run" leaves the command running.
  it.each([
    "dev",
    "build",
    "start",
    "test",
    "test:watch",
    "diagnose",
    "workspace:create",
    "synthetic",
    "perf",
    "db:fixture",
  ])("%s hands over to its last command with exec", (name) => {
    expect(manifest.scripts[name]).toMatch(/ && exec [^&;|]+$/);
  });

  // The gate. "biome check" exits with 0 when all it has found are warnings, so a rule that
  // reports as a warning would leave the gate green without this option.
  it("check runs the linter, the type check and the tests, and the linter fails on a warning as on an error", () => {
    expect(manifest.scripts.check).toBe(
      "node scripts/preflight.cjs && npm run lint && npm run typecheck && npm run test",
    );
    expect(manifest.scripts.lint).toBe("biome check --error-on-warnings");
  });

  it("has npm run them without asking the registry whether a newer npm exists", () => {
    // Without this setting npm makes that call now and then when it runs a script, "npm start"
    // included: a connection out of this machine that has nothing to do with the LLM endpoint.
    expect(readFileSync(join(REPO_ROOT, ".npmrc"), "utf8").split("\n")).toContain("update-notifier=false");
  });

  it("start builds the web app, then runs the server without the caller's HUBBER_DEV_ORIGIN", () => {
    // Run for real, the script would rebuild dist/web under a server that may be using it,
    // so node and vite are replaced by stand-ins that only report how they were called.
    const bin = tempDir();
    const reporter = '#!/bin/sh\necho "$(basename "$0") $* (HUBBER_DEV_ORIGIN=$HUBBER_DEV_ORIGIN)"\n';
    for (const command of ["node", "vite"]) writeFileSync(join(bin, command), reporter, { mode: 0o755 });
    const devOrigin = "http://127.0.0.1:5173";

    // npm hands a script to "sh -c" in the same way.
    const result = spawnSync("/bin/sh", ["-c", manifest.scripts.start], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HUBBER_DEV_ORIGIN: devOrigin },
    });

    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      `node scripts/preflight.cjs (HUBBER_DEV_ORIGIN=${devOrigin})`,
      `vite build --logLevel warn (HUBBER_DEV_ORIGIN=${devOrigin})`,
      "node src/server/main.ts (HUBBER_DEV_ORIGIN=)",
    ]);
  });
});

describe("package versions", () => {
  // Biome formats and lints differently from one release to the next, Playwright's browsers
  // are installed for one exact release, and of the two Tailwind packages one runs the other,
  // so they have to be the same release. "npm install <package>" writes a range again.
  it.each(["@biomejs/biome", "@playwright/test", "@tailwindcss/vite", "tailwindcss"])(
    "%s is pinned to an exact version",
    (name) => {
      expect(manifest.devDependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
    },
  );

  // The package carries the SQLite engine that the workspace's data lives in, so a newer one
  // arrives by a deliberate change and not with the next install.
  it("better-sqlite3 is pinned to an exact version", () => {
    expect(manifest.dependencies["better-sqlite3"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // The package writes the SQL of the application's queries, and what SQLite makes of a query
  // depends on how it is written. So a newer one arrives by a deliberate change as well.
  it("drizzle-orm is pinned to an exact version", () => {
    expect(manifest.dependencies["drizzle-orm"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // The package ships its binaries ready-made. Left to itself, npm still runs "node-gyp rebuild"
  // for it on a clean install, which builds nothing and yet fails on a machine without Python
  // and a compiler. The entry is the denial that keeps that run out.
  it("better-sqlite3 is denied its install script", () => {
    expect(manifest.allowScripts["better-sqlite3"]).toBe(false);
  });
});
