import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freePorts, spawnNode } from "../testing.ts";
import {
  defaultWorkspaceDir,
  e2eWorkspaceDir,
  expandHome,
  isE2eWorkspaceDir,
  locateWorkspace,
  resolveWorkspaceDir,
  WORKSPACE_VARIABLE,
  WorkspaceLocationError,
} from "./location.ts";

const HOME = "/Users/ola";
const DEFAULT_DIR = "/Users/ola/Library/Application Support/Hubber/workspaces/default";

function failure(run: () => unknown): WorkspaceLocationError {
  try {
    run();
  } catch (error) {
    if (error instanceof WorkspaceLocationError) return error;
    throw error;
  }
  throw new Error("The location was accepted.");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("locateWorkspace", () => {
  it("takes the directory that HUBBER_WORKSPACE names", () => {
    expect(locateWorkspace({ HUBBER_WORKSPACE: "/data/praca" })).toEqual({ dir: "/data/praca", source: "variable" });
    // The variable wins over the default place, and needs no HOME.
    expect(locateWorkspace({ HUBBER_WORKSPACE: "/data/praca", HOME })).toEqual({
      dir: "/data/praca",
      source: "variable",
    });
  });

  it("spells one directory one way, whatever slashes and dot segments it was given with", () => {
    expect(locateWorkspace({ HUBBER_WORKSPACE: "/data/praca/" }).dir).toBe("/data/praca");
    expect(locateWorkspace({ HUBBER_WORKSPACE: "/data//x/../praca/." }).dir).toBe("/data/praca");
  });

  it("expands a tilde at the start with HOME, because a value in quotes arrives unexpanded", () => {
    expect(locateWorkspace({ HUBBER_WORKSPACE: "~/hub", HOME })).toEqual({ dir: "/Users/ola/hub", source: "variable" });
    expect(locateWorkspace({ HUBBER_WORKSPACE: "~", HOME }).dir).toBe(HOME);
  });

  it("falls back to the default place under HOME", () => {
    expect(locateWorkspace({ HOME })).toEqual({ dir: DEFAULT_DIR, source: "default" });
  });

  it("treats an empty HUBBER_WORKSPACE as not set", () => {
    expect(locateWorkspace({ HUBBER_WORKSPACE: "", HOME })).toEqual({ dir: DEFAULT_DIR, source: "default" });
  });

  // What keeps a coding agent off the owner's own workspace. An agent runs its commands in the
  // owner's account, each in a shell of its own, so a variable that one command exported is not
  // there for the next, and the default place of that HOME is the owner's real data.
  describe("in the session of a coding agent", () => {
    const refusal = (variable: string) =>
      `Nie wskazano workspace'u. Ustaw zmienną HUBBER_WORKSPACE na katalog workspace'u; w sesji agenta (zmienna ${variable}) nie ma katalogu domyślnego.`;

    it.each([
      ["CLAUDECODE", "1"],
      ["CLAUDE_CODE_ENTRYPOINT", "cli"],
      ["AI_AGENT", "claude-code_2-1-295_agent"],
      // Whatever the value says: that the variable has one is the sign.
      ["CLAUDECODE", "0"],
      ["AI_AGENT", "false"],
      ["AI_AGENT", " "],
    ])("has no default place when %s is %j, and names the variable", (variable, value) => {
      expect(failure(() => locateWorkspace({ HOME, [variable]: value })).message).toBe(refusal(variable));
      // An empty HUBBER_WORKSPACE names nothing, here as everywhere.
      expect(failure(() => locateWorkspace({ HOME, HUBBER_WORKSPACE: "", [variable]: value })).message).toBe(
        refusal(variable),
      );
    });

    it("says so whether or not there is a HOME, so that adding one changes nothing", () => {
      expect(failure(() => locateWorkspace({ CLAUDECODE: "1" })).message).toBe(refusal("CLAUDECODE"));
    });

    it("takes the directory that HUBBER_WORKSPACE names, like anyone's", () => {
      const session = { HOME, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", AI_AGENT: "claude-code_2-1-295_agent" };

      expect(locateWorkspace({ ...session, HUBBER_WORKSPACE: "/data/praca" })).toEqual({
        dir: "/data/praca",
        source: "variable",
      });
      expect(locateWorkspace({ ...session, HUBBER_WORKSPACE: "~/hub" }).dir).toBe("/Users/ola/hub");
      // Also the default place, once it is named: the refusal is for a start that names nothing.
      expect(locateWorkspace({ ...session, HUBBER_WORKSPACE: DEFAULT_DIR })).toEqual({
        dir: DEFAULT_DIR,
        source: "variable",
      });
    });

    it("is not what an empty variable shows", () => {
      const notSet = { HOME, CLAUDECODE: "", CLAUDE_CODE_ENTRYPOINT: "", AI_AGENT: "" };

      expect(locateWorkspace(notSet)).toEqual({ dir: DEFAULT_DIR, source: "default" });
    });
  });

  // What keeps a process that a test starts away from the developer's own workspace: such a
  // process gets an environment of its own, without HOME, and the account's home directory
  // must not be found by any other way.
  it.each([
    ["no HOME at all", {}],
    ["an empty HOME", { HOME: "" }],
    ["a relative HOME", { HOME: "relative/home" }],
    ["an empty variable and no HOME", { HUBBER_WORKSPACE: "" }],
  ])("has no default place with %s", (_what, env) => {
    // The account does have a home directory; the environment alone decides.
    expect(homedir()).not.toBe("");

    expect(failure(() => locateWorkspace(env)).message).toBe(
      "Nie wskazano workspace'u. Ustaw zmienną HUBBER_WORKSPACE na katalog workspace'u; bez zmiennej HOME nie ma katalogu domyślnego.",
    );
  });

  it.each(["workspaces/dev", "./dev", "dev", "~ola/hub"])("refuses the relative path %j", (path) => {
    // npm runs every script in the repository root, so such a path would land inside the repository.
    expect(failure(() => locateWorkspace({ HUBBER_WORKSPACE: path, HOME })).message).toBe(
      `Niepoprawna wartość HUBBER_WORKSPACE: "${path}". Podaj pełną ścieżkę katalogu workspace'u (od "/" albo "~/").`,
    );
  });

  it.each([
    ["no HOME at all", {}],
    ["a relative HOME", { HOME: "relative/home" }],
  ])("refuses a tilde that it cannot expand, with %s", (_what, env) => {
    expect(failure(() => locateWorkspace({ ...env, HUBBER_WORKSPACE: "~/hub" })).message).toBe(
      'Niepoprawna wartość HUBBER_WORKSPACE: "~/hub". Znak "~" wymaga zmiennej HOME; podaj pełną ścieżkę.',
    );
  });

  it("names its variable the way the messages do", () => {
    expect(WORKSPACE_VARIABLE).toBe("HUBBER_WORKSPACE");
  });
});

describe("resolveWorkspaceDir", () => {
  it("resolves a directory for whoever asks, and names that setting when it refuses", () => {
    expect(resolveWorkspaceDir("~/hub/", "--dir", { HOME })).toBe("/Users/ola/hub");
    expect(failure(() => resolveWorkspaceDir("relative/ws", "--dir", { HOME })).message).toBe(
      'Niepoprawna wartość --dir: "relative/ws". Podaj pełną ścieżkę katalogu workspace\'u (od "/" albo "~/").',
    );
    expect(failure(() => resolveWorkspaceDir("~/hub", "--dir", {})).message).toBe(
      'Niepoprawna wartość --dir: "~/hub". Znak "~" wymaga zmiennej HOME; podaj pełną ścieżkę.',
    );
  });

  it("resolves a directory that is named in the session of a coding agent as well", () => {
    expect(resolveWorkspaceDir("~/hub", "--dir", { HOME, CLAUDECODE: "1", AI_AGENT: "agent" })).toBe("/Users/ola/hub");
  });
});

describe("expandHome", () => {
  it("expands a path that starts with a tilde and leaves every other path alone", () => {
    expect(expandHome("~/raporty/a.json", { HOME })).toBe("/Users/ola/raporty/a.json");
    expect(expandHome("~", { HOME })).toBe(HOME);
    expect(expandHome("/data/a.json", {})).toBe("/data/a.json");
    expect(expandHome("raporty/a~.json", {})).toBe("raporty/a~.json");
    expect(expandHome("~ola/a.json", { HOME })).toBe("~ola/a.json");
  });

  it("gives nothing for a tilde without a home directory to put in its place", () => {
    expect(expandHome("~/a.json", {})).toBeUndefined();
    expect(expandHome("~", { HOME: "" })).toBeUndefined();
  });
});

describe("defaultWorkspaceDir", () => {
  it("is the place for application data of the given home directory", () => {
    expect(defaultWorkspaceDir(HOME)).toBe(DEFAULT_DIR);
  });
});

describe("the workspace of an end-to-end run", () => {
  it("lies directly in the temporary directory, one per port", () => {
    expect(e2eWorkspaceDir(4501)).toBe(join(tmpdir(), "hubber-e2e-4501"));
    expect(e2eWorkspaceDir(4502)).not.toBe(e2eWorkspaceDir(4501));
  });

  it("is recognised as a directory the run may delete", () => {
    expect(isE2eWorkspaceDir(e2eWorkspaceDir(4501))).toBe(true);
    expect(isE2eWorkspaceDir(e2eWorkspaceDir(1))).toBe(true);
  });

  // The run deletes its workspace before it creates it anew, so nothing else may pass for one.
  it.each([
    ["the temporary directory itself", tmpdir()],
    ["a directory inside such a workspace", join(tmpdir(), "hubber-e2e-4501", "files")],
    ["the default workspace", DEFAULT_DIR],
    ["an empty path", ""],
    ["another directory in the temporary directory", join(tmpdir(), "hubber-workspace-4501")],
    ["a name without a port", join(tmpdir(), "hubber-e2e-")],
    ["a name with something after the port", join(tmpdir(), "hubber-e2e-4501-kopia")],
    ["a name with something in front", join(tmpdir(), "moj-hubber-e2e-4501")],
    ["the right name in another directory", join("/Users/ola", "hubber-e2e-4501")],
    ["the right name below the temporary directory", join(tmpdir(), "x", "hubber-e2e-4501")],
    ["a path that only leads there", `${tmpdir()}/x/../hubber-e2e-4501`],
    ["a relative path", "hubber-e2e-4501"],
    // With a slash at its end a link names the directory it leads to, which is not the run's to delete.
    ["its own directory with a slash at the end", `${e2eWorkspaceDir(4501)}/`],
    ["its own directory with two slashes at the end", `${e2eWorkspaceDir(4501)}//`],
    ["its own directory with a dot at the end", `${e2eWorkspaceDir(4501)}/.`],
    ["its own directory with two slashes inside", `${tmpdir()}//hubber-e2e-4501`],
    ["a name with a line break after the port", `${e2eWorkspaceDir(4501)}\n`],
  ])("does not take %s for one", (_what, dir) => {
    expect(isE2eWorkspaceDir(dir)).toBe(false);
  });

  // The system's own value of TMPDIR ends with a slash, and a value typed by hand can end with
  // two. Whatever e2eWorkspaceDir() makes of it is the run's own directory.
  it.each(["/tmp/hubber-tests", "/tmp/hubber-tests/", "/tmp/hubber-tests//", "/tmp//hubber-tests/"])(
    "recognises its own directory when TMPDIR is %j",
    (temporary) => {
      vi.stubEnv("TMPDIR", temporary);

      expect(isE2eWorkspaceDir(e2eWorkspaceDir(4501))).toBe(true);
      expect(e2eWorkspaceDir(4501)).toBe("/tmp/hubber-tests/hubber-e2e-4501");
    },
  );
});

// The three commands that ask locateWorkspace() where the workspace is: the server, the
// development runner and the create command. The first and the last are started here as an
// agent's shell starts them, with a HOME and with the agent's variable; the runner has the same
// test among its own, in scripts/dev.test.ts.
describe("a command started in the session of a coding agent", { timeout: 30_000 }, () => {
  // Any allowed value puts the server in development mode, where it needs no built web app.
  const DEV_ORIGIN = "http://127.0.0.1:8000";
  const REFUSAL =
    "Nie wskazano workspace'u. Ustaw zmienną HUBBER_WORKSPACE na katalog workspace'u; w sesji agenta (zmienna CLAUDECODE) nie ma katalogu domyślnego.\n";
  const children: ChildProcess[] = [];
  const homes: string[] = [];

  /** A home directory with nothing in it, standing in for the owner's. */
  function emptyHome(): string {
    const home = mkdtempSync(join(tmpdir(), "hubber-agent-home-"));
    homes.push(home);
    return home;
  }

  async function run(script: string, args: string[], env: Record<string, string>) {
    const command = spawnNode(script, { args, env });
    children.push(command.child);
    const exit = await command.exited;
    return { ...exit, stdout: command.stdout(), stderr: command.stderr() };
  }

  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it("the server refuses the default workspace with code 2, and leaves the home directory alone", async () => {
    const home = emptyHome();
    const [port] = await freePorts(1);
    const settings = { HOME: home, HUBBER_PORT: String(port), HUBBER_DEV_ORIGIN: DEV_ORIGIN };

    const refused = await run("src/server/main.ts", [], { ...settings, CLAUDECODE: "1" });

    expect(refused).toEqual({ code: 2, signal: null, stdout: "", stderr: REFUSAL });
    expect(readdirSync(home)).toEqual([]);

    // The control: the same start outside such a session goes to the default place of that HOME
    // (and finds no workspace there), so the refusal above is the session's doing.
    const outside = await run("src/server/main.ts", [], settings);
    expect(outside).toMatchObject({ code: 1, signal: null, stdout: "" });
    expect(outside.stderr).toContain(`w domyślnym katalogu "${defaultWorkspaceDir(home)}" jeszcze go nie ma`);
  });

  it("the server opens the workspace that the session names", async () => {
    const home = emptyHome();
    const [port] = await freePorts(1);
    const named = join(home, "no-workspace-here");

    const outcome = await run("src/server/main.ts", [], {
      HOME: home,
      HUBBER_PORT: String(port),
      HUBBER_DEV_ORIGIN: DEV_ORIGIN,
      CLAUDECODE: "1",
      AI_AGENT: "claude-code_2-1-295_agent",
      HUBBER_WORKSPACE: named,
    });

    // It went to that directory and nowhere else: the answer is about what it found there.
    expect(outcome).toMatchObject({ code: 1, signal: null, stdout: "" });
    expect(outcome.stderr).toContain(`katalog "${named}" ze zmiennej HUBBER_WORKSPACE nie istnieje`);
  });

  it("the create command refuses the default workspace with code 2, and creates nothing", async () => {
    const home = emptyHome();
    const options = ["--name", "Test", "--kind", "anthropic"];

    const refused = await run("scripts/workspace-create.ts", options, { HOME: home, CLAUDECODE: "1" });

    expect(refused).toEqual({
      code: 2,
      signal: null,
      stdout: "",
      stderr: `${REFUSAL}Pomoc: npm run workspace:create -- --help\n`,
    });
    expect(readdirSync(home)).toEqual([]);
  });

  it.each([
    ["HUBBER_WORKSPACE", (dir: string) => ({ args: [], env: { HUBBER_WORKSPACE: dir } })],
    ["--dir", (dir: string) => ({ args: ["--dir", dir], env: {} })],
  ] as const)("the create command creates the workspace that the session names with %s", async (_how, named) => {
    const home = emptyHome();
    const dir = join(home, "throwaway", "workspace");
    const { args, env } = named(dir);

    const created = await run("scripts/workspace-create.ts", ["--name", "Test", "--kind", "anthropic", ...args], {
      HOME: home,
      CLAUDECODE: "1",
      AI_AGENT: "claude-code_2-1-295_agent",
      ...env,
    });

    expect(created).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(created.stdout).toContain(`Utworzono workspace „Test” w katalogu "${dir}".`);
    // There and nowhere else under that HOME.
    expect(readdirSync(home)).toEqual(["throwaway"]);
    expect(readdirSync(dir).sort()).toEqual(["files", "hubber.sqlite", "workspace.json"]);
  });
});
