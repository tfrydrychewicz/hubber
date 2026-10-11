import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { egressLogBeside } from "../e2e/egress.ts";
import { type Exit, spawnNode, TEST_WORKSPACE } from "../src/server/testing.ts";
import { parseWorkspaceConfig } from "../src/server/workspace/config.ts";
import { defaultWorkspaceDir } from "../src/server/workspace/location.ts";
import { openWorkspace } from "../src/server/workspace/open.ts";
import { createTestWorkspaceAt } from "../src/server/workspace/testing.ts";
import { DIRECT_TRANSPORT } from "../src/server/workspace/transport.ts";

const SPAWN_TIMEOUT_MS = 30_000;
const LAYOUT = ["files", "hubber.sqlite", "workspace.json"];

// Loaded into the script ahead of its own code. It sets the usual umask, so that the one in
// force later is the script's own doing, and reports the umask at the moment the creation of
// the workspace begins: when its staging directory is made.
const UMASK_AT_CREATION = `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
process.umask(0o022);
const { mkdirSync } = fs;
let reported = false;
fs.mkdirSync = (path, options) => {
  if (!reported && String(path).includes(".creating-")) {
    reported = true;
    process.stderr.write(\`umask \${process.umask().toString(8)}\\n\`);
  }
  return mkdirSync(path, options);
};
syncBuiltinESMExports();
`;

const children: ChildProcess[] = [];
// The script goes by the temporary directory of its own process. Each test gives it one that
// holds nothing else, so that neither a refusal nor a mistake can reach a directory of a real run.
let temporary: string;

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "hubber-e2e-workspace-"));
});

afterEach(() => {
  // A run that outlived its test: the test timeout ended the wait for it, not the process.
  for (const child of children.splice(0)) child.kill("SIGKILL");
  // A test may have closed the directory to make creating in it fail.
  chmodSync(temporary, 0o700);
  rmSync(temporary, { recursive: true, force: true });
});

interface Run extends Exit {
  stdout: string;
  stderr: string;
}

/** Runs the script the way the web server command does, with the place of the workspace in its environment. */
async function run(
  workspace: string | undefined,
  env: Record<string, string> = {},
  nodeArgs: string[] = [],
): Promise<Run> {
  const script = spawnNode("scripts/e2e-workspace.ts", {
    nodeArgs,
    // With the slash at its end that macOS gives this variable.
    env: { TMPDIR: `${temporary}/`, ...(workspace !== undefined && { HUBBER_WORKSPACE: workspace }), ...env },
  });
  children.push(script.child);
  const exit = await script.exited;
  return { ...exit, stdout: script.stdout(), stderr: script.stderr() };
}

/** Everything under a directory, each file with a digest of its bytes: what a refusal must leave as it was. */
function contentsOf(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true, recursive: true })
      .map((entry) => join(entry.parentPath, entry.name))
      .sort()
      .map((path) => [
        path,
        statSync(path).isDirectory() ? "directory" : createHash("sha256").update(readFileSync(path)).digest("hex"),
      ]),
  );
}

const mode = (path: string): string => (statSync(path).mode & 0o777).toString(8);

describe("scripts/e2e-workspace.ts", { timeout: SPAWN_TIMEOUT_MS }, () => {
  it("creates the throwaway workspace at the place the run names, for the owner alone", async () => {
    const dir = join(temporary, "hubber-e2e-4999");

    expect(await run(dir)).toEqual({ code: 0, signal: null, stdout: "", stderr: "" });

    expect(readdirSync(dir).sort()).toEqual(LAYOUT);
    expect([dir, join(dir, "files"), join(dir, "hubber.sqlite"), join(dir, "workspace.json")].map(mode)).toEqual([
      "700",
      "700",
      "600",
      "600",
    ]);
    // A workspace that the server opens: the checks of the pin pass, and it is the one the
    // browser tests expect to find.
    const opened = openWorkspace(
      { dir, source: "variable" },
      { ANTHROPIC_BASE_URL: TEST_WORKSPACE.endpoint },
      // Whatever the shell that runs the tests does to Node's connections.
      DIRECT_TRANSPORT,
    );
    try {
      expect(opened.config.name).toBe(TEST_WORKSPACE.name);
      expect(opened.endpoint.href).toBe(TEST_WORKSPACE.endpoint);
    } finally {
      opened.close();
    }
  });

  it("creates it anew on every run, with nothing of the run before", async () => {
    const dir = join(temporary, "hubber-e2e-4999");
    await run(dir);
    const first = parseWorkspaceConfig(readFileSync(join(dir, "workspace.json"), "utf8"));
    // What a run leaves behind: a file that was dropped, and the files of a database that a
    // killed server did not close.
    writeFileSync(join(dir, "files", "left-by-the-last-run.txt"), "x");
    writeFileSync(join(dir, "hubber.sqlite-wal"), "x");

    expect(await run(dir)).toEqual({ code: 0, signal: null, stdout: "", stderr: "" });

    expect(readdirSync(dir).sort()).toEqual(LAYOUT);
    expect(readdirSync(join(dir, "files"))).toEqual([]);
    // Another workspace under the same name, not the old one put in order.
    const second = parseWorkspaceConfig(readFileSync(join(dir, "workspace.json"), "utf8"));
    expect(second.createdAt).not.toBe(first.createdAt);
    expect({ ...second, createdAt: first.createdAt }).toEqual(first);
  });

  it("empties the log of the observer that the server of the run works under, and nothing else beside the workspace", async () => {
    const dir = join(temporary, "hubber-e2e-4999");
    const log = egressLogBeside(dir);
    // What the last run on this port left: the observer adds to the file it is given.
    writeFileSync(log, '{"kind":"loaded"}\n');
    writeFileSync(`${log}.kept`, "x");
    writeFileSync(`${dir}-notes.txt`, "x");

    expect(await run(dir)).toEqual({ code: 0, signal: null, stdout: "", stderr: "" });

    expect(readdirSync(temporary).sort()).toEqual([
      "hubber-e2e-4999",
      "hubber-e2e-4999-egress.jsonl.kept",
      "hubber-e2e-4999-notes.txt",
    ]);
  });

  // Whatever TMPDIR looks like, the directory that the configuration of the run makes of it is
  // the run's own: the script reads the temporary directory the same way.
  it.each(["", "/", "//"])("takes the directory of the run for its own when TMPDIR ends in %j", async (ending) => {
    const dir = join(temporary, "hubber-e2e-4999");

    expect(await run(dir, { TMPDIR: `${temporary}${ending}` })).toEqual({
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
    });

    expect(readdirSync(dir).sort()).toEqual(LAYOUT);
  });

  describe("given a link under the name of its own directory", () => {
    // Someone's workspace with data in it, and a link to it where the run's directory would be.
    let victim: string;
    let link: string;

    beforeEach(() => {
      victim = join(temporary, "someone's workspace");
      createTestWorkspaceAt(victim);
      writeFileSync(join(victim, "files", "notes.txt"), "data");
      link = join(temporary, "hubber-e2e-4999");
      symlinkSync(victim, link);
    });

    // With a slash at its end the path names the directory behind the link, and deleting "it"
    // would empty that directory.
    it.each(["/", "//", "/."])("refuses the link with %j at its end, and deletes nothing", async (ending) => {
      const before = contentsOf(temporary);

      expect(await run(`${link}${ending}`)).toEqual({
        code: 2,
        signal: null,
        stdout: "",
        stderr: `Niepoprawna wartość HUBBER_WORKSPACE: "${link}${ending}". Testy end-to-end używają katalogu ${temporary}/hubber-e2e-<port>, który ustawia playwright.config.ts.\n`,
      });

      expect(contentsOf(temporary)).toEqual(before);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    });

    it("replaces the link itself by a workspace of its own, and leaves alone what the link led to", async () => {
      const before = contentsOf(victim);

      expect(await run(link)).toEqual({ code: 0, signal: null, stdout: "", stderr: "" });

      expect(lstatSync(link).isDirectory()).toBe(true);
      expect(readdirSync(link).sort()).toEqual(LAYOUT);
      expect(readdirSync(join(link, "files"))).toEqual([]);
      expect(contentsOf(victim)).toEqual(before);
    });
  });

  describe("asked for anything but a directory of its own kind", () => {
    const refusal = (value: string) =>
      `Niepoprawna wartość HUBBER_WORKSPACE: "${value}". Testy end-to-end używają katalogu ${temporary}/hubber-e2e-<port>, który ustawia playwright.config.ts.\n`;

    it.each([
      ["a directory under another name", () => join(temporary, "workspace")],
      ["a directory that only begins like its own", () => join(temporary, "hubber-e2e-4999-kopia")],
      ["a directory inside one of its own", () => join(temporary, "hubber-e2e-4999", "workspace")],
      [
        "a directory of its own name that is not in the temporary directory",
        () => join(temporary, "x", "hubber-e2e-4999"),
      ],
      ["its own directory spelled through another one", () => `${temporary}/x/../hubber-e2e-4999`],
      ["the temporary directory itself", () => temporary],
    ])("refuses %s with code 2, and deletes nothing", async (_what, place) => {
      const dir = place();
      // A workspace with data in it, where the script would delete if it went on.
      createTestWorkspaceAt(join(temporary, "hubber-e2e-4999"));
      mkdirSync(join(temporary, "x"));
      for (const path of [join(temporary, "workspace"), join(temporary, "hubber-e2e-4999-kopia")]) {
        createTestWorkspaceAt(path);
        writeFileSync(join(path, "files", "notes.txt"), "data");
      }
      const before = contentsOf(temporary);

      expect(await run(dir)).toEqual({ code: 2, signal: null, stdout: "", stderr: refusal(dir) });

      expect(contentsOf(temporary)).toEqual(before);
    });

    it("refuses the workspace that the developer's own environment names, and leaves it alone", async () => {
      const home = join(temporary, "home");
      const own = defaultWorkspaceDir(home);
      createTestWorkspaceAt(own);
      writeFileSync(join(own, "files", "notes.txt"), "data");
      const before = contentsOf(temporary);

      expect(await run(own, { HOME: home })).toEqual({ code: 2, signal: null, stdout: "", stderr: refusal(own) });

      expect(contentsOf(temporary)).toEqual(before);
    });

    it("refuses to pick a place by itself when the run names none", async () => {
      const home = join(temporary, "home");
      mkdirSync(home);

      // With a home directory at hand: the default workspace there is not its to create either.
      expect(await run(undefined, { HOME: home })).toEqual({ code: 2, signal: null, stdout: "", stderr: refusal("") });

      expect(readdirSync(home)).toEqual([]);
      expect(readdirSync(temporary)).toEqual(["home"]);
    });
  });

  it("works under a umask that keeps other accounts out of whatever it creates", async () => {
    const standIn = join(temporary, "umask-at-creation.mjs");
    writeFileSync(standIn, UMASK_AT_CREATION);

    const outcome = await run(join(temporary, "hubber-e2e-4999"), {}, ["--import", pathToFileURL(standIn).href]);

    expect(outcome).toEqual({ code: 0, signal: null, stdout: "", stderr: "umask 77\n" });
  });

  it("says why when the workspace cannot be created, in one line, and exits with code 1", async () => {
    const dir = join(temporary, "hubber-e2e-4999");
    // Nothing can be created in the temporary directory now.
    chmodSync(temporary, 0o500);

    const outcome = await run(dir);

    expect(outcome).toMatchObject({ code: 1, signal: null, stdout: "" });
    expect(outcome.stderr).toContain(`Nie udało się utworzyć workspace'u w katalogu "${dir}": EACCES`);
    expect(outcome.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(existsSync(dir)).toBe(false);
  });
});
