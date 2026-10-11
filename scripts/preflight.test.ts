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
  devDependencies: { [name: string]: string };
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
    // The script looks for node_modules beside its own directory, so a copy in an empty one finds none.
    const root = tempDir();
    const copy = join(root, "scripts/preflight.cjs");
    mkdirSync(join(root, "scripts"));
    copyFileSync(SCRIPT, copy);

    const result = await preflight(undefined, copy);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('Brak zainstalowanych zależności. Uruchom "npm install".\n');

    mkdirSync(join(root, "node_modules", "vite"), { recursive: true });
    writeFileSync(join(root, "node_modules", "vite", "package.json"), "{}");
    expect((await preflight(undefined, copy)).code).toBe(0);
  });
});

describe("package scripts", () => {
  // In the script itself and not in a "pre" script: npm skips those when ignore-scripts is set.
  it.each(["dev", "build", "start", "test", "test:watch", "check", "diagnose"])(
    "%s runs the preflight before anything else",
    (name) => {
      expect(manifest.scripts[name]).toMatch(/^node scripts\/preflight\.cjs && /);
    },
  );

  // exec puts the command in the place of the shell that npm started, so the signals npm passes
  // on reach it. Behind a shell that waits for it, a stopped "npm run" leaves the command running.
  it.each(["dev", "build", "start", "test", "test:watch", "diagnose"])(
    "%s hands over to its last command with exec",
    (name) => {
      expect(manifest.scripts[name]).toMatch(/ && exec [^&;|]+$/);
    },
  );

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
});
