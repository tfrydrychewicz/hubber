import { type ChildProcess, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createFakeEndpoint } from "../src/server/llm/diagnostics/fake-endpoint.ts";
import { runDiagnostics } from "../src/server/llm/diagnostics/run.ts";
import type { DiagnosticsReport } from "../src/server/llm/diagnostics/types.ts";
import { type Exit, spawnNode } from "../src/server/testing.ts";
import type { WorkspaceConfig } from "../src/server/workspace/config.ts";
import { openWorkspace } from "../src/server/workspace/open.ts";
import { scanWorkspaceForSecret } from "../src/server/workspace/testing.ts";
import { DIRECT_TRANSPORT } from "../src/server/workspace/transport.ts";

const REPO_ROOT = join(import.meta.dirname, "..");
const SCRIPT = "scripts/workspace-create.ts";
const SPAWN_TIMEOUT_MS = 30_000;
const HELP_LINE = "Pomoc: npm run workspace:create -- --help";
const LAYOUT = ["files", "hubber.sqlite", "workspace.json"];
const ROUTER = "https://router.corp.example/llm";
// Unique per run, so that a finding can only come from this run.
const SECRET = `hubber-planted-${randomUUID()}`;
// A relative directory lands in the working directory of the command, which is the repository.
// The command refuses it; the name is one that nothing else can have, so that the test can
// remove whatever a broken command would leave there.
const RELATIVE_ROOT = `hubber-test-relative-${randomUUID()}`;
const RELATIVE_DIR = `${RELATIVE_ROOT}/ws`;

// Loaded into the command ahead of its own code. At the moment the staging directory is
// created, when the creation is under way and nothing of it is finished, it reports the umask
// of the process and, if the address it was loaded from names a signal, sends the process
// that signal.
const AT_STAGING = `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const signal = new URL(import.meta.url).searchParams.get("signal");
const { mkdirSync } = fs;
let reported = false;
fs.mkdirSync = (path, options) => {
  const made = mkdirSync(path, options);
  if (!reported && String(path).includes(".creating-")) {
    reported = true;
    process.stderr.write(\`umask \${process.umask().toString(8)}\\n\`);
    if (signal) process.kill(process.pid, signal);
  }
  return made;
};
syncBuiltinESMExports();
`;

// Loaded into the command ahead of its own code. It does what a recursive removal by another
// process would have done by then: when the staging directory is whole and about to be moved into
// place (its fsync, the second of a creation), everything in it is deleted.
const EMPTY_THE_STAGING = `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
const { fsyncSync } = fs;
let calls = 0;
fs.fsyncSync = (fd) => {
  if (++calls === 2) {
    const parent = dirname(process.argv[process.argv.indexOf("--dir") + 1]);
    for (const entry of fs.readdirSync(parent)) {
      if (!entry.includes(".creating-")) continue;
      for (const child of fs.readdirSync(join(parent, entry))) fs.rmSync(join(parent, entry, child), { recursive: true });
    }
  }
  return fsyncSync(fd);
};
syncBuiltinESMExports();
`;

interface RunResult extends Exit {
  stdout: string;
  stderr: string;
}

const children: ChildProcess[] = [];
// Directories that a broken command would create inside the repository. Removed after every test.
const insideRepository: string[] = [];
let work: string;
let atStaging: string;
let emptyTheStaging: string;
let report: DiagnosticsReport;
let reportFile: string;
let counter = 0;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "hubber-workspace-create-"));
  atStaging = join(work, "at-staging.mjs");
  writeFileSync(atStaging, AT_STAGING);
  emptyTheStaging = join(work, "empty-the-staging.mjs");
  writeFileSync(emptyTheStaging, EMPTY_THE_STAGING);

  // A report as the diagnostics write it, from a run against the repository's stand-in for an
  // endpoint. The stand-in answers at the root of its origin; the address the report names is
  // a value of its own.
  const endpoint = createFakeEndpoint({ model: "router-opus", reject: ["output_config"] });
  const client = new Anthropic({
    apiKey: "invented-key",
    baseURL: "https://router.corp.example",
    fetch: endpoint.fetch,
    maxRetries: 0,
  });
  report = await runDiagnostics({
    client,
    meta: {
      endpoint: ROUTER,
      endpointIsDefault: false,
      credentialSource: "ANTHROPIC_AUTH_TOKEN",
      customHeaderNames: ["X-Team"],
      model: "router-opus",
      modelSource: "--model",
      label: "router.corp.example",
    },
    sleep: async () => {},
  });
  reportFile = writeReport("report.json", report);
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of insideRepository.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeReport(name: string, content: unknown): string {
  const path = join(work, name);
  writeFileSync(path, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  return path;
}

/** A place for a workspace that does not exist yet, in a directory of its own. */
function freshDir(): string {
  const parent = join(work, `case-${++counter}`);
  mkdirSync(parent);
  return join(parent, "ws");
}

// spawnNode() builds the environment from scratch: no HOME, no HUBBER_WORKSPACE, no credentials
// of the developer. So the command can never reach the developer's own workspace from here.
async function run(
  args: readonly string[],
  env: Record<string, string> = {},
  nodeArgs: string[] = [],
): Promise<RunResult> {
  const script = spawnNode(SCRIPT, { args, env, nodeArgs });
  children.push(script.child);
  const exit = await script.exited;
  return { ...exit, stdout: script.stdout(), stderr: script.stderr() };
}

function readConfig(dir: string): WorkspaceConfig {
  return JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8")) as WorkspaceConfig;
}

const mode = (path: string) => (lstatSync(path).mode & 0o7777).toString(8);

describe("scripts/workspace-create.ts", { timeout: SPAWN_TIMEOUT_MS }, () => {
  describe("a creation that succeeds", () => {
    it("creates the default workspace of the given HOME for the Anthropic API, and says how to start it", async () => {
      const home = join(work, "home");
      mkdirSync(home);
      const dir = join(home, "Library/Application Support/Hubber/workspaces/default");

      const result = await run(["--name", "Dev", "--kind", "anthropic"], { HOME: home });

      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(
        `Utworzono workspace „Dev” w katalogu "${dir}".
  Profil:            anthropic
  Endpoint:          https://api.anthropic.com
  Uwierzytelnianie:  klucz w nagłówku x-api-key
  Modele:            claude-opus-5-5 (wszystkie role)
  Diagnostyka:       brak; funkcje opcjonalne pozostają wyłączone
Workspace jest przypięty do tego endpointu i z innym się nie otworzy.
Poświadczeń nie zapisano; skąd aplikacja je bierze, opisuje README w rozdziale „Poświadczenia”.
Uruchomienie: npm start
`,
      );
      expect(readdirSync(dir).sort()).toEqual(LAYOUT);
      expect(readConfig(dir)).toMatchObject({
        schemaVersion: 1,
        name: "Dev",
        profile: {
          kind: "anthropic",
          endpoint: "https://api.anthropic.com",
          auth: "x-api-key",
          models: { default: "claude-opus-5-5" },
          diagnostics: null,
        },
      });
      // Everything it created is for the owner alone, the directories on the way included.
      for (const made of [
        "Library",
        "Library/Application Support",
        "Library/Application Support/Hubber",
        "Library/Application Support/Hubber/workspaces",
        "Library/Application Support/Hubber/workspaces/default",
        "Library/Application Support/Hubber/workspaces/default/files",
      ]) {
        expect(mode(join(home, made)), made).toBe("700");
      }
      expect(mode(join(dir, "hubber.sqlite"))).toBe("600");
      expect(mode(join(dir, "workspace.json"))).toBe("600");
    });

    it("creates a router workspace from its options, in the canonical spelling of the address", async () => {
      const dir = freshDir();

      const result = await run([
        "--name",
        "  Praca ",
        "--kind",
        "router",
        "--endpoint",
        "HTTPS://Router.Corp.Example:443/llm/",
        "--model",
        "router-opus",
        "--model-synthesis",
        "router-sonnet",
        // The common model again: no exception to it, so it is not written down.
        "--model-processing",
        "router-opus",
        "--dir",
        dir,
      ]);

      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(
        `Utworzono workspace „Praca” w katalogu "${dir}".
  Profil:            router
  Endpoint:          https://router.corp.example/llm
  Uwierzytelnianie:  token w nagłówku Authorization
  Modele:            router-opus; synteza: router-sonnet
  Diagnostyka:       brak; funkcje opcjonalne pozostają wyłączone
Workspace jest przypięty do tego endpointu i z innym się nie otworzy.
Poświadczeń nie zapisano; skąd aplikacja je bierze, opisuje README w rozdziale „Poświadczenia”.
Uruchomienie: HUBBER_WORKSPACE="${dir}" npm start
`,
      );
      expect(readConfig(dir).name).toBe("Praca");
      expect(readConfig(dir).profile).toEqual({
        kind: "router",
        endpoint: ROUTER,
        auth: "bearer",
        models: { default: "router-opus", synthesis: "router-sonnet" },
        diagnostics: null,
      });
    });

    it("creates what the server then opens, pinned to the address it was given", async () => {
      const dir = freshDir();
      await run(["--name", "Praca", "--kind", "router", "--endpoint", ROUTER, "--model", "router-opus", "--dir", dir]);

      const workspace = openWorkspace({ dir, source: "variable" }, { ANTHROPIC_BASE_URL: ROUTER }, DIRECT_TRANSPORT);
      try {
        expect(workspace.endpoint.href).toBe(ROUTER);
        expect(workspace.warnings).toEqual([]);
      } finally {
        workspace.close();
      }
      expect(() =>
        openWorkspace(
          { dir, source: "variable" },
          { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
          DIRECT_TRANSPORT,
        ),
      ).toThrow(/jest przypięty do endpointu/);
    });

    it("takes the address, the model and the capabilities of a router from a diagnostics report", async () => {
      const dir = freshDir();

      const result = await run([
        "--name=Praca",
        "--kind",
        "router",
        "--diagnostics",
        reportFile,
        "--model-synthesis",
        "router-sonnet",
        "--model-conversation",
        "router-haiku",
        "--dir",
        dir,
      ]);

      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(readConfig(dir).profile).toEqual({
        kind: "router",
        endpoint: ROUTER,
        auth: "bearer",
        models: { default: "router-opus", conversation: "router-haiku", synthesis: "router-sonnet" },
        diagnostics: {
          checkedAt: report.startedAt,
          model: "router-opus",
          coreReady: true,
          capabilities: { promptCache: true, effort: false, thinking: true, pdfInput: true },
        },
      });
      expect(result.stdout).toContain(
        "  Modele:            router-opus; rozmowa: router-haiku, synteza: router-sonnet\n",
      );
      expect(result.stdout).toContain(
        `  Diagnostyka:       z ${report.startedAt.slice(0, 10)}: cache_control tak, effort nie, thinking tak, PDF tak\n`,
      );
      // The endpoint of the report lists one model; the two others get a line each.
      expect(result.stdout).toContain(
        "  Uwaga: modelu router-haiku nie ma na liście modeli endpointu z raportu.\n" +
          "  Uwaga: modelu router-sonnet nie ma na liście modeli endpointu z raportu.\n" +
          "Workspace jest przypięty",
      );
      expect(result.stdout).not.toContain("modelu router-opus nie ma");
      // Nothing of the report's transcript reached the workspace: here, what the endpoint
      // answered to the feature it rejected.
      expect(JSON.stringify(report)).toContain("Extra inputs are not permitted");
      for (const name of ["workspace.json", "hubber.sqlite"]) {
        expect(readFileSync(join(dir, name)).includes("Extra inputs")).toBe(false);
      }
    });

    it("takes a report by a path relative to the repository, where the diagnostics write theirs", async () => {
      const dir = freshDir();

      const result = await run([
        "--name",
        "Praca",
        "--kind",
        "router",
        "--endpoint",
        ROUTER,
        "--model",
        "router-opus",
        "--diagnostics",
        relative(REPO_ROOT, reportFile),
        "--dir",
        dir,
      ]);

      expect(result.code, result.stderr).toBe(0);
      expect(readConfig(dir).profile.diagnostics?.coreReady).toBe(true);
    });

    it("takes a report by a path under the home directory as well", async () => {
      const dir = freshDir();

      const result = await run(
        ["--name", "Praca", "--kind", "router", "--diagnostics", "~/report.json", "--dir", dir],
        { HOME: work },
      );

      expect(result.code, result.stderr).toBe(0);
      expect(readConfig(dir).profile.endpoint).toBe(ROUTER);
    });

    it("warns about no model when the endpoint of the report lists none", async () => {
      const dir = freshDir();
      const withoutList = writeReport("without-list.json", { ...report, availableModels: [] });

      const result = await run([
        "--name",
        "Praca",
        "--kind",
        "router",
        "--diagnostics",
        withoutList,
        "--model-synthesis",
        "router-sonnet",
        "--dir",
        dir,
      ]);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("Uwaga");
    });

    it("takes a value that starts with a dash when it is tied to its option, and a lone dash anywhere", async () => {
      const tied = freshDir();
      const lone = freshDir();

      const first = await run(["--name=-Praca-", "--kind", "anthropic", "--dir", tied]);
      const second = await run(["--name", "-", "--kind", "anthropic", "--dir", lone]);

      expect(first.code, first.stderr).toBe(0);
      expect(readConfig(tied).name).toBe("-Praca-");
      expect(second.code, second.stderr).toBe(0);
      expect(readConfig(lone).name).toBe("-");
    });

    it("sends the key in the x-api-key header for a router that is asked to", async () => {
      const dir = freshDir();

      const result = await run([
        "--name",
        "Klucz",
        "--kind",
        "router",
        "--endpoint",
        ROUTER,
        "--model",
        "m",
        "--auth",
        "x-api-key",
        "--dir",
        dir,
      ]);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("  Uwierzytelnianie:  klucz w nagłówku x-api-key\n");
      expect(result.stdout).toContain("  Modele:            m (wszystkie role)\n");
      expect(readConfig(dir).profile.auth).toBe("x-api-key");
    });

    it("accepts the address of the Anthropic API spelled out for the Anthropic profile", async () => {
      const dir = freshDir();

      const result = await run([
        "--name",
        "Dev",
        "--kind",
        "anthropic",
        "--endpoint",
        "https://API.anthropic.com/",
        "--dir",
        dir,
      ]);

      expect(result.code, result.stderr).toBe(0);
      expect(readConfig(dir).profile.endpoint).toBe("https://api.anthropic.com");
    });

    it("honours HUBBER_WORKSPACE, so that it creates what the server would open", async () => {
      const dir = freshDir();

      const result = await run(["--name", "X", "--kind", "anthropic"], { HUBBER_WORKSPACE: dir });

      expect(result.code, result.stderr).toBe(0);
      expect(readdirSync(dir).sort()).toEqual(LAYOUT);
      expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(`Uruchomienie: HUBBER_WORKSPACE="${dir}" npm start`);
    });

    describe("the line it prints for starting the application", () => {
      const SHELLS = ["/bin/sh", "/bin/zsh", "/bin/bash"].filter((shell) => existsSync(shell));

      /** What a shell makes of the printed line: the directory that "npm start" would be given. */
      function pasted(line: string, shell: string, cwd: string): { status: number | null; value: string } {
        const assignment = line.replace(/^Uruchomienie: /, "").replace(/ npm start$/, "");
        const result = spawnSync(shell, ["-c", `${assignment} /usr/bin/printenv HUBBER_WORKSPACE`], {
          cwd,
          // A home directory of its own, so that a "$HOME" taken for a variable shows.
          env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent-home" },
          encoding: "utf8",
        });
        return { status: result.status, value: result.stdout.replace(/\n$/, "") };
      }

      it.each([
        ["a dollar sign", "dane$HOME"],
        ["a command for the shell to run", "x$(touch MARK)"],
        ["a command in backticks", "x`touch MARK`"],
        ["a double quote", 'pra"ca'],
        ["two backslashes", "pra\\\\ca"],
        ["an apostrophe beside a dollar sign", "it's $HOME"],
        ["an exclamation mark", "Praca!"],
        // These two need no single quotes: a shell changes nothing in them between double quotes.
        ["a space", "moja praca"],
        ["an apostrophe", "it's"],
      ])("names the directory it created to every shell, although the name holds %s", async (_what, name) => {
        const parent = join(freshDir(), "..");
        const dir = join(parent, name, "ws");

        const result = await run(["--name", "X", "--kind", "anthropic", "--dir", dir]);

        expect(result.code, result.stderr).toBe(0);
        const line = result.stdout.trimEnd().split("\n").at(-1) ?? "";
        expect(line).toMatch(/^Uruchomienie: HUBBER_WORKSPACE=.* npm start$/);
        expect(SHELLS).not.toEqual([]);
        for (const shell of SHELLS) {
          expect(pasted(line, shell, parent), shell).toEqual({ status: 0, value: dir });
        }
        // The shells ran nothing that the name spelled out.
        expect(readdirSync(parent)).toEqual([name]);
      });

      it("puts a name between single quotes when an interactive shell would act on it between double quotes", async () => {
        // No shell that is started for one command expands "!", so here the form is what is checked.
        const dir = join(freshDir(), "..", "Praca!", "ws");

        const result = await run(["--name", "X", "--kind", "anthropic", "--dir", dir]);

        expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(`Uruchomienie: HUBBER_WORKSPACE='${dir}' npm start`);
      });
    });

    it("prefers --dir to the variable, and expands a tilde in it with HOME", async () => {
      const home = join(work, `home-${++counter}`);
      mkdirSync(home);
      const elsewhere = freshDir();

      const result = await run(["--name", "X", "--kind", "anthropic", "--dir", "~/hub/ws/"], {
        HOME: home,
        HUBBER_WORKSPACE: elsewhere,
      });

      expect(result.code, result.stderr).toBe(0);
      expect(readdirSync(join(home, "hub", "ws")).sort()).toEqual(LAYOUT);
      expect(existsSync(elsewhere)).toBe(false);
    });

    it("leaves a credential of its environment in no file of the new workspace, and names no endpoint by it", async () => {
      const dir = freshDir();

      const result = await run(["--name", "Dev", "--kind", "anthropic", "--dir", dir], {
        ANTHROPIC_API_KEY: SECRET,
        ANTHROPIC_AUTH_TOKEN: SECRET,
        // Another address in the environment is not the address to pin either.
        ANTHROPIC_BASE_URL: `https://ola:${SECRET}@router.corp.example/llm`,
      });

      expect(result.code, result.stderr).toBe(0);
      expect(scanWorkspaceForSecret(dir, SECRET)).toEqual([]);
      expect(result.stdout + result.stderr).not.toContain(SECRET);
      expect(readConfig(dir).profile.endpoint).toBe("https://api.anthropic.com");
    });

    it("works under a umask that keeps other accounts out of whatever it creates", async () => {
      const dir = freshDir();

      const result = await run(["--name", "X", "--kind", "anthropic", "--dir", dir], {}, [
        "--import",
        pathToFileURL(atStaging).href,
      ]);

      expect(result.stderr).toBe("umask 77\n");
      expect(result.code).toBe(0);
    });
  });

  describe("options it cannot use", () => {
    // Each case: the options, what the command says, and optionally the environment.
    type Case = [
      what: string,
      args: (dir: string) => string[],
      message: string | ((dir: string) => string),
      env?: Record<string, string>,
    ];
    const anthropic = (dir: string) => ["--dir", dir, "--name", "X", "--kind", "anthropic"];
    const router = (dir: string) => ["--dir", dir, "--name", "X", "--kind", "router"];
    const pinned = (dir: string) => [...router(dir), "--endpoint", ROUTER, "--model", "m"];

    const CASES: Case[] = [
      [
        "no options at all, as when the -- is missing",
        () => [],
        'Nie podano opcji. Opcje polecenia podaje się po "--".',
      ],
      // What npm 11 leaves of "npm run workspace:create --name Praca --kind anthropic --dir <dir>":
      // the values as arguments, and each option it kept as a variable of its own.
      [
        "the values of options that npm kept for itself, as when the -- is missing",
        (dir) => ["anthropic", dir],
        'npm zabrał dla siebie: --name, --kind, --dir. Opcje polecenia podaje się po "--".',
        { npm_config_name: "Praca", npm_config_kind: "true", npm_config_dir: "true" },
      ],
      [
        "nothing at all because npm kept every option, as with --name=Praca and no --",
        () => [],
        'npm zabrał dla siebie: --name, --kind, --model-synthesis. Opcje polecenia podaje się po "--".',
        { npm_config_name: "Praca", npm_config_kind: "anthropic", npm_config_model_synthesis: "m" },
      ],
      [
        "options of which npm kept one, as when the -- comes too late",
        (dir) => ["anthropic", "--name", "Praca", "--dir", dir],
        'npm zabrał dla siebie: --kind. Opcje polecenia podaje się po "--".',
        { npm_config_kind: "true" },
      ],
      ["an option it does not know", (dir) => [...anthropic(dir), "--frobnicate"], "Nieznana opcja: --frobnicate."],
      [
        "an option it does not know, with a value",
        (dir) => [...anthropic(dir), "--region=eu"],
        "Nieznana opcja: --region.",
      ],
      ["a short option", (dir) => [...anthropic(dir), "-x"], "Nieznana opcja: -x."],
      [
        "an option named like something every object has",
        (dir) => [...anthropic(dir), "--constructor=x"],
        "Nieznana opcja: --constructor.",
      ],
      [
        "a stray argument",
        (dir) => [...anthropic(dir), "stray"],
        'Nieoczekiwany argument: "stray". Każdą wartość poprzedza nazwa opcji; wartość ze spacjami ujmij w cudzysłów.',
      ],
      [
        "a stray argument with an apostrophe in it",
        (dir) => [...anthropic(dir), "it's"],
        'Nieoczekiwany argument: "it\'s". Każdą wartość poprzedza nazwa opcji; wartość ze spacjami ujmij w cudzysłów.',
      ],
      [
        "a name of several words without quotes",
        (dir) => ["--dir", dir, "--kind", "anthropic", "--name", "Moja", "praca"],
        'Nieoczekiwany argument: "praca". Każdą wartość poprzedza nazwa opcji; wartość ze spacjami ujmij w cudzysłów.',
      ],
      [
        "an option without its value at the end",
        (dir) => ["--dir", dir, "--kind", "anthropic", "--name"],
        'Opcja --name wymaga wartości. Wartość zaczynającą się od "-" podaj w postaci --name=wartość.',
      ],
      [
        "an option without its value before another option",
        (dir) => ["--dir", dir, "--name", "--kind", "anthropic"],
        'Opcja --name wymaga wartości. Wartość zaczynającą się od "-" podaj w postaci --name=wartość.',
      ],
      [
        "an option given twice",
        (dir) => [...anthropic(dir), "--kind", "router"],
        "Opcja --kind została podana więcej niż raz.",
      ],
      ["no name", (dir) => ["--dir", dir, "--kind", "anthropic"], "Podaj nazwę workspace'u opcją --name."],
      [
        "a blank name",
        (dir) => ["--dir", dir, "--name", "   ", "--kind", "anthropic"],
        "Niepoprawna wartość --name: nazwa jest pusta.",
      ],
      [
        "a name of characters that leave nothing on screen",
        (dir) => ["--dir", dir, "--name", "\u200b\u2800\u00ad", "--kind", "anthropic"],
        "Niepoprawna wartość --name: nazwa jest pusta.",
      ],
      [
        "a name that is too long",
        (dir) => ["--dir", dir, "--name", "x".repeat(61), "--kind", "anthropic"],
        "Niepoprawna wartość --name: nazwa ma więcej niż 60 znaków.",
      ],
      [
        "a name with a line break",
        (dir) => ["--dir", dir, "--name", "Pra\nca", "--kind", "anthropic"],
        "Niepoprawna wartość --name: nazwa zawiera znak sterujący albo znak nowego wiersza.",
      ],
      ["no kind", (dir) => ["--dir", dir, "--name", "X"], "Podaj rodzaj profilu opcją --kind: anthropic albo router."],
      [
        "a kind it does not know",
        (dir) => ["--dir", dir, "--name", "X", "--kind", "bedrock"],
        'Niepoprawna wartość --kind: "bedrock". Dozwolone: anthropic, router.',
      ],
      [
        "a router without an address",
        (dir) => [...router(dir), "--model", "m"],
        'Profil "router" wymaga adresu: podaj go opcją --endpoint albo dołącz raport diagnostyki opcją --diagnostics.',
      ],
      [
        "a router without an address, although the environment names one",
        (dir) => [...router(dir), "--model", "m"],
        'Profil "router" wymaga adresu: podaj go opcją --endpoint albo dołącz raport diagnostyki opcją --diagnostics.',
        { ANTHROPIC_BASE_URL: ROUTER },
      ],
      [
        "a router without a model",
        (dir) => [...router(dir), "--endpoint", ROUTER],
        'Profil "router" wymaga identyfikatora modelu: podaj go opcją --model albo dołącz raport diagnostyki.',
      ],
      [
        "an address without a scheme",
        (dir) => [...router(dir), "--endpoint", "router.corp.example", "--model", "m"],
        'Tego adresu nie da się przypiąć. "router.corp.example" nie jest poprawnym adresem. Podaj pełny adres, na przykład https://router.corp.example.',
      ],
      [
        "an http address of another machine",
        (dir) => [...router(dir), "--endpoint", "http://router.corp.example", "--model", "m"],
        'Tego adresu nie da się przypiąć. Adres "http://router.corp.example" używa nieszyfrowanego http://. Poza tym komputerem (127.0.0.1, localhost) dozwolone jest tylko https://.',
      ],
      [
        "an address with a password, which it does not repeat",
        (dir) => [...router(dir), "--endpoint", `https://ola:${SECRET}@router.corp.example`, "--model", "m"],
        'Tego adresu nie da się przypiąć. Adres endpointu zawiera nazwę użytkownika lub hasło: "https://***@router.corp.example". Poświadczeń nie podaje się w adresie: trafiłyby do konfiguracji i do bazy.',
      ],
      [
        "an address with a query string, which it does not repeat",
        (dir) => [...router(dir), "--endpoint", `https://router.corp.example/llm?key=${SECRET}`, "--model", "m"],
        'Tego adresu nie da się przypiąć. Adres endpointu nie może zawierać znaku "?" ani "#": "https://router.corp.example/llm?…".',
      ],
      [
        "the address of the Anthropic API for a router",
        (dir) => [...router(dir), "--endpoint", "https://api.anthropic.com", "--model", "m"],
        'Niepoprawny adres endpointu: adres https://api.anthropic.com należy do profilu "anthropic", nie "router".',
      ],
      [
        "another address for the Anthropic profile",
        (dir) => [...anthropic(dir), "--endpoint", "https://router.corp.example"],
        'Niepoprawny adres endpointu: profil "anthropic" ma stały adres https://api.anthropic.com; dla innego adresu wybierz profil "router".',
      ],
      [
        "a model identifier with a space",
        (dir) => [...anthropic(dir), "--model", "claude opus"],
        "Niepoprawna wartość --model: identyfikator modelu zawiera odstęp albo znak sterujący.",
      ],
      [
        "an empty model identifier",
        (dir) => [...anthropic(dir), "--model", ""],
        "Niepoprawna wartość --model: identyfikator modelu jest pusty.",
      ],
      [
        "a model identifier for one role that is too long",
        (dir) => [...anthropic(dir), "--model-synthesis", "m".repeat(201)],
        "Niepoprawna wartość --model-synthesis: identyfikator modelu ma więcej niż 200 znaków.",
      ],
      [
        "a way of authenticating it does not know, which it does not repeat",
        (dir) => [...pinned(dir), "--auth", SECRET],
        "Niepoprawna wartość --auth. Dozwolone: x-api-key, bearer. Poświadczeń nie podaje się w poleceniu.",
      ],
      [
        "a bearer token for the Anthropic profile",
        (dir) => [...anthropic(dir), "--auth", "bearer"],
        'Niepoprawna wartość --auth: profil "anthropic" uwierzytelnia się wyłącznie kluczem w nagłówku x-api-key.',
      ],
      [
        "a report that is not there",
        (dir) => [...router(dir), "--diagnostics", join(work, "no-such-report.json")],
        () => `Nie można odczytać raportu diagnostyki: ${join(work, "no-such-report.json")}`,
      ],
      [
        "a report that is not JSON",
        (dir) => [...router(dir), "--diagnostics", writeReport("broken.json", `{"apiKey": "${SECRET}" oops`)],
        () => `Raport diagnostyki nie jest poprawnym JSON-em. (${join(work, "broken.json")})`,
      ],
      [
        "a file that is no report",
        (dir) => [...router(dir), "--diagnostics", join(REPO_ROOT, "package.json")],
        () =>
          `Plik nie jest raportem diagnostyki w obsługiwanym formacie. Utwórz go poleceniem "npm run diagnose". (${join(REPO_ROOT, "package.json")})`,
      ],
      [
        "a report of a run whose core is not ready",
        (dir) => [
          ...router(dir),
          "--diagnostics",
          writeReport("partial.json", { ...report, summary: { ...report.summary, coreReady: false } }),
        ],
        "Raport diagnostyki nie potwierdza rdzenia (pełny zestaw testów nie przeszedł albo uruchomiono tylko część). Uruchom pełną diagnostykę albo pomiń --diagnostics.",
      ],
      [
        "a report written without its address, and no address beside it",
        (dir) => [
          ...router(dir),
          "--diagnostics",
          writeReport("redacted.json", { ...report, meta: { ...report.meta, endpoint: null } }),
        ],
        'Profil "router" wymaga adresu: podaj go opcją --endpoint albo dołącz raport diagnostyki opcją --diagnostics.',
      ],
      [
        "a report for another address than --endpoint",
        (dir) => [...router(dir), "--endpoint", "https://other.corp.example", "--diagnostics", reportFile],
        `Raport diagnostyki dotyczy endpointu ${ROUTER}, a opcja --endpoint wskazuje https://other.corp.example. Workspace przypina się do jednego adresu.`,
      ],
      [
        "a report for another model than --model",
        (dir) => [...router(dir), "--model", "router-sonnet", "--diagnostics", reportFile],
        "Raport diagnostyki dotyczy modelu router-opus, a workspace ma używać router-sonnet. Uruchom diagnostykę dla tego modelu albo pomiń --diagnostics.",
      ],
      [
        "a relative --dir",
        () => ["--dir", RELATIVE_DIR, "--name", "X", "--kind", "anthropic"],
        `Niepoprawna wartość --dir: "${RELATIVE_DIR}". Podaj pełną ścieżkę katalogu workspace'u (od "/" albo "~/").`,
      ],
      [
        "a tilde in --dir without HOME",
        () => ["--dir", "~/ws", "--name", "X", "--kind", "anthropic"],
        'Niepoprawna wartość --dir: "~/ws". Znak "~" wymaga zmiennej HOME; podaj pełną ścieżkę.',
      ],
      [
        "no directory at all: neither --dir, nor the variable, nor HOME",
        () => ["--name", "X", "--kind", "anthropic"],
        "Nie wskazano workspace'u. Ustaw zmienną HUBBER_WORKSPACE na katalog workspace'u; bez zmiennej HOME nie ma katalogu domyślnego.",
      ],
      [
        "a relative HUBBER_WORKSPACE",
        () => ["--name", "X", "--kind", "anthropic"],
        `Niepoprawna wartość HUBBER_WORKSPACE: "${RELATIVE_DIR}". Podaj pełną ścieżkę katalogu workspace'u (od "/" albo "~/").`,
        { HUBBER_WORKSPACE: RELATIVE_DIR },
      ],
    ];

    it.each(CASES)(
      "refuses %s with code 2, points at the help and creates nothing",
      async (_what, args, message, env) => {
        const dir = freshDir();
        insideRepository.push(join(REPO_ROOT, RELATIVE_ROOT));

        const result = await run(args(dir), env);

        expect(result.stderr).toBe(`${typeof message === "string" ? message : message(dir)}\n${HELP_LINE}\n`);
        expect(result.code).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain(SECRET);
        // Neither the workspace nor anything on the way to it.
        expect(readdirSync(join(dir, ".."))).toEqual([]);
        // A relative directory would have landed in the repository.
        expect(existsSync(join(REPO_ROOT, RELATIVE_ROOT))).toBe(false);
      },
    );
  });

  describe("a directory inside the repository", () => {
    const unique = `hubber-test-${randomUUID()}`;
    // Where the volume ignores letter case, the repository can be typed in other letters.
    const shouted = REPO_ROOT.toUpperCase();
    const ignoresCase = existsSync(shouted) && realpathSync.native(shouted) === realpathSync.native(REPO_ROOT);

    /** The directory is named by --dir unless the test names it through the environment instead. */
    async function refusal(dir: string, created: string, env?: Record<string, string>): Promise<void> {
      insideRepository.push(created);

      const result = await run(
        ["--name", "X", "--kind", "anthropic", ...(env === undefined ? ["--dir", dir] : [])],
        env,
      );

      expect(result.stderr).toBe(
        `Katalog "${dir}" leży w repozytorium Hubbera, a dane workspace'u muszą leżeć poza nim. Wskaż inny katalog.\n${HELP_LINE}\n`,
      );
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(existsSync(created)).toBe(false);
    }

    it("is refused", async () => {
      await refusal(join(REPO_ROOT, unique, "dev"), join(REPO_ROOT, unique));
    });

    // The rule is about the directory, wherever its name came from.
    it("is refused when HUBBER_WORKSPACE names it and there is no --dir", async () => {
      const dir = join(REPO_ROOT, unique, "from-the-variable");

      await refusal(dir, join(REPO_ROOT, unique), { HUBBER_WORKSPACE: dir });
    });

    it("is refused when it is the default place of a home directory inside the repository", async () => {
      const home = join(REPO_ROOT, unique, "home");

      await refusal(join(home, "Library/Application Support/Hubber/workspaces/default"), join(REPO_ROOT, unique), {
        HOME: home,
      });
    });

    it("is refused when it is the repository itself", async () => {
      const result = await run(["--name", "X", "--kind", "anthropic", "--dir", REPO_ROOT]);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("leży w repozytorium Hubbera");
    });

    it("is refused when a link leads there", async () => {
      const link = join(work, "link-into-repository");
      symlinkSync(REPO_ROOT, link);

      await refusal(join(link, unique, "dev"), join(REPO_ROOT, unique));
    });

    it("is refused when its name merely starts with two dots", async () => {
      await refusal(join(REPO_ROOT, `..${unique}`, "dev"), join(REPO_ROOT, `..${unique}`));
    });

    it.skipIf(!ignoresCase)("is refused when the repository is typed in other letter case", async () => {
      await refusal(join(shouted, unique, "dev"), join(REPO_ROOT, unique));
    });
  });

  describe("a creation that cannot be done", () => {
    it("exits with 1 when the directory exists, and leaves it alone", async () => {
      const dir = freshDir();
      mkdirSync(dir);
      writeFileSync(join(dir, "precious.txt"), "data");

      const result = await run(["--name", "X", "--kind", "anthropic", "--dir", dir]);

      expect(result.stderr).toBe(
        `Katalog "${dir}" już istnieje. Polecenie tworzy wyłącznie nowy katalog i niczego nie nadpisuje; wskaż inny opcją --dir.\n`,
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(readdirSync(dir)).toEqual(["precious.txt"]);
      expect(readdirSync(join(dir, ".."))).toEqual(["ws"]);
    });

    it("exits with 1 and the system's own words when the place cannot be used", async () => {
      const blocker = freshDir();
      writeFileSync(blocker, "data");
      const dir = join(blocker, "ws");

      const result = await run(["--name", "X", "--kind", "anthropic", "--dir", dir]);

      expect(result.stderr.startsWith(`Nie udało się utworzyć workspace'u w katalogu "${dir}": ENOTDIR`)).toBe(true);
      // One line, and no stack trace behind it.
      expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
    });

    it("exits with 1, one line and nothing left on disk when the name is too long to work beside", async () => {
      // A name the disk takes. The staging directory beside it has a longer one, which it does not.
      const parent = join(freshDir(), "..");
      const dir = join(parent, "made", "on-the-way", "d".repeat(250));

      const result = await run(["--name", "X", "--kind", "anthropic", "--dir", dir]);

      expect(result.stderr.startsWith(`Nie udało się utworzyć workspace'u w katalogu "${dir}": ENAMETOOLONG`)).toBe(
        true,
      );
      expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      // What the help promises: neither the workspace nor the directories made on the way to it.
      expect(readdirSync(parent)).toEqual([]);
    });

    it("reports no workspace, and leaves none, when its files are gone by the time it is in place", async () => {
      const dir = freshDir();

      const result = await run(["--name", "X", "--kind", "anthropic", "--dir", dir], {}, [
        "--import",
        pathToFileURL(emptyTheStaging).href,
      ]);

      expect(result.stderr).toBe(
        `Nie udało się utworzyć workspace'u w katalogu "${dir}": inna operacja usunęła pliki tworzonego workspace'u. Spróbuj ponownie\n`,
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(readdirSync(join(dir, ".."))).toEqual([]);
    });
  });

  describe("creations of one directory at the same time", () => {
    it("end with one workspace: one of them creates it, the others find it there", async () => {
      const dir = freshDir();
      const names = ["Pierwszy", "Drugi", "Trzeci"];

      const results = await Promise.all(
        names.map((name) => run(["--name", name, "--kind", "anthropic", "--dir", dir])),
      );

      const winners = results.filter((result) => result.code === 0);
      const losers = results.filter((result) => result.code !== 0);
      expect(winners).toHaveLength(1);
      for (const loser of losers) {
        expect(loser.stderr).toBe(
          `Katalog "${dir}" już istnieje. Polecenie tworzy wyłącznie nowy katalog i niczego nie nadpisuje; wskaż inny opcją --dir.\n`,
        );
        expect(loser.code).toBe(1);
        expect(loser.stdout).toBe("");
      }
      // The one workspace is whole, it is the winner's, and nothing lies beside it.
      expect(readdirSync(join(dir, ".."))).toEqual(["ws"]);
      expect(readdirSync(dir).sort()).toEqual(LAYOUT);
      expect(winners[0]?.stdout).toContain(`Utworzono workspace „${readConfig(dir).name}” w katalogu "${dir}".`);
      openWorkspace({ dir, source: "variable" }, {}, DIRECT_TRANSPORT).close();
    });
  });

  describe("--help", () => {
    it("prints the usage and creates nothing, whatever else is given", async () => {
      const dir = freshDir();

      const result = await run(["--name", "X", "--kind", "anthropic", "--dir", dir, "--help"]);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^Tworzy workspace: katalog danych przypięty do jednego endpointu LLM\.\n/);
      expect(result.stdout).toContain("npm run workspace:create -- --name <nazwa> --kind <anthropic|router> [opcje]");
      for (const option of [
        "--name <nazwa>",
        "--kind <anthropic|router>",
        "--endpoint <adres>",
        "--auth <bearer|x-api-key>",
        "--model <id>",
        "--model-processing <id>",
        "--model-conversation <id>",
        "--model-synthesis <id>",
        "--diagnostics <plik>",
        "--dir <katalog>",
        "--help",
      ]) {
        expect(result.stdout, option).toContain(`  ${option}`);
      }
      expect(result.stdout).toContain("anthropic: domyślnie claude-opus-5-5;");
      expect(result.stdout).toContain("~/Library/Application Support/Hubber/workspaces/default");
      expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(
        "Kod wyjścia: 0 po utworzeniu, 1 gdy się nie udało (nic nie zostaje na dysku), 2 przy błędnych opcjach.",
      );
      expect(existsSync(dir)).toBe(false);
    });

    it("prints the usage also for whoever gives the option a value", async () => {
      const result = await run(["--help=tak"]);

      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/^Tworzy workspace: /);
    });
  });

  describe("a signal in the middle of a creation", () => {
    function interrupted(signal: string, dir: string): Promise<RunResult> {
      return run(["--name", "X", "--kind", "anthropic", "--dir", dir], {}, [
        "--import",
        `${pathToFileURL(atStaging).href}?signal=${signal}`,
      ]);
    }

    it.each(["SIGINT", "SIGTERM", "SIGHUP"])(
      "does not stop the creation: %s waits until the workspace is whole",
      async (signal) => {
        const dir = freshDir();

        const result = await interrupted(signal, dir);

        expect({ code: result.code, signal: result.signal }, result.stderr).toEqual({ code: 0, signal: null });
        expect(result.stdout).toContain(`Utworzono workspace „X” w katalogu "${dir}".`);
        expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(`Uruchomienie: HUBBER_WORKSPACE="${dir}" npm start`);
        expect(readdirSync(dir).sort()).toEqual(LAYOUT);
        expect(readdirSync(join(dir, ".."))).toEqual(["ws"]);
      },
    );

    it("leaves only a staging directory when the process is killed outright, and a later run clears it", async () => {
      const dir = freshDir();
      const parent = join(dir, "..");

      const killed = await interrupted("SIGKILL", dir);

      expect({ code: killed.code, signal: killed.signal }).toEqual({ code: null, signal: "SIGKILL" });
      expect(killed.stdout).toBe("");
      // Never a half-made workspace under the real name.
      expect(readdirSync(parent)).toHaveLength(1);
      const [left = ""] = readdirSync(parent);
      expect(left).toMatch(/^\.ws\.creating-[0-9a-f]{8}$/);
      // Later: a staging directory that was touched a moment ago may be somebody's work in progress.
      const anHourAgo = new Date(Date.now() - 3_600_000);
      utimesSync(join(parent, left), anHourAgo, anHourAgo);

      const again = await run(["--name", "X", "--kind", "anthropic", "--dir", dir]);

      expect(again.code, again.stderr).toBe(0);
      expect(readdirSync(parent)).toEqual(["ws"]);
      expect(readdirSync(dir).sort()).toEqual(LAYOUT);
    });
  });
});
