import { type ChildProcess, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FullConfig } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { egressLogBeside, egressProblems, observerOptions, readEgressLog, SERVER_SCRIPT } from "./e2e/egress.ts";
import checkEgress from "./e2e/global-teardown.ts";
import type { EgressRecord } from "./src/server/egress-observer.ts";
import { DEFAULT_E2E_PORT } from "./src/server/ports.ts";
import { spawnNode, TEST_WORKSPACE } from "./src/server/testing.ts";
import { e2eWorkspaceDir, isE2eWorkspaceDir } from "./src/server/workspace/location.ts";

const REPO_ROOT = import.meta.dirname;
const OBSERVER = join(REPO_ROOT, "src/server/egress-observer.ts");

interface RunVariables {
  HUBBER_E2E_PORT?: string | undefined;
  HUBBER_E2E_CHROME?: string | undefined;
}

/** Loads the configuration as a run started with exactly these variables would. */
async function loadConfig(variables: RunVariables) {
  vi.stubEnv("HUBBER_E2E_PORT", variables.HUBBER_E2E_PORT);
  vi.stubEnv("HUBBER_E2E_CHROME", variables.HUBBER_E2E_CHROME);
  // The configuration reads the environment while it is imported.
  vi.resetModules();
  return (await import("./playwright.config.ts")).default;
}

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hubber-e2e-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("playwright.config", () => {
  it.each([
    { state: "not set", value: undefined, port: DEFAULT_E2E_PORT },
    { state: "empty", value: "", port: DEFAULT_E2E_PORT },
    { state: "4999", value: "4999", port: 4999 },
  ])(
    "starts the app on port $port and sends the tests there when HUBBER_E2E_PORT is $state",
    async ({ value, port }) => {
      const config = await loadConfig({ HUBBER_E2E_PORT: value });

      expect(config).toMatchObject({
        use: { baseURL: `http://127.0.0.1:${port}` },
        webServer: {
          url: `http://127.0.0.1:${port}/api/health`,
          // A workspace of the run's own, named after its port like the output directory: two
          // runs in the same checkout do not delete each other's.
          env: { HUBBER_PORT: String(port), HUBBER_WORKSPACE: e2eWorkspaceDir(port) },
        },
      });
    },
  );

  it("creates the workspace of the run before it starts the app, and checks the Node version before both", async () => {
    const config = await loadConfig({});

    expect(config).toMatchObject({
      webServer: {
        command:
          'node scripts/preflight.cjs && node scripts/e2e-workspace.ts && NODE_OPTIONS="$HUBBER_E2E_NODE_OPTIONS" npm start',
      },
    });
  });

  it("starts the app under the egress observer, with a log beside the run's workspace that the run reads at its end", async () => {
    const config = await loadConfig({ HUBBER_E2E_PORT: "4999" });
    const webServer = Array.isArray(config.webServer) ? undefined : config.webServer;
    const options = webServer?.env?.HUBBER_E2E_NODE_OPTIONS ?? "";

    // One option, which loads the observer ahead of everything: nothing in it for a shell or for
    // Node to split in two.
    expect(options).toMatch(/^--import=file:\/\/\S+$/);
    const observer = new URL(options.slice("--import=".length));
    expect(fileURLToPath(observer)).toBe(OBSERVER);
    expect(existsSync(OBSERVER)).toBe(true);
    expect([...observer.searchParams]).toEqual([
      ["log", `${e2eWorkspaceDir(4999)}-egress.jsonl`],
      // The run sends nothing out, even when the code under test has just started to.
      ["deny", "remote"],
    ]);
    expect(options).toBe(observerOptions(egressLogBeside(e2eWorkspaceDir(4999))));
    // The check of the log is part of every run: Playwright calls it when the tests are over.
    expect(config.globalTeardown).toBe("./e2e/global-teardown.ts");
    expect(existsSync(join(REPO_ROOT, "e2e/global-teardown.ts"))).toBe(true);
  });

  it("hands the observer to the app alone, so that the step before can still tell an old Node what is wrong", async () => {
    const config = await loadConfig({ HUBBER_E2E_PORT: "4999" });
    const webServer = Array.isArray(config.webServer) ? undefined : config.webServer;
    // An old Node cannot load the observer, which is TypeScript: with it in NODE_OPTIONS, the
    // check of the Node version would end in Node's own error instead of its message.
    expect(webServer?.env).not.toHaveProperty("NODE_OPTIONS");

    // The command as a shell runs it, with stand-ins that only report how they were called. The
    // options hold what a path can hold, a space and a quote among it.
    const bin = tempDir();
    const reporter = '#!/bin/sh\necho "$(basename "$0") $* [$NODE_OPTIONS]"\n';
    for (const command of ["node", "npm"]) writeFileSync(join(bin, command), reporter, { mode: 0o755 });
    const options = observerOptions(join(tempDir(), "it's a log & more.jsonl"));
    const result = spawnSync("/bin/sh", ["-c", webServer?.command ?? ""], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HUBBER_E2E_NODE_OPTIONS: options, NODE_OPTIONS: "--developers-own" },
    });

    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      "node scripts/preflight.cjs [--developers-own]",
      "node scripts/e2e-workspace.ts [--developers-own]",
      `npm start [${options}]`,
    ]);
  });

  it("starts the app on the throwaway workspace with an invented credential, whatever the shell of the run holds", async () => {
    // What a shell set up for daily work on a real workspace holds.
    const developers = {
      HUBBER_WORKSPACE: "/Users/someone/Library/Application Support/Hubber/workspaces/default",
      HUBBER_CREDENTIALS_FILE: "/Users/someone/.config/hubber/credentials.json",
      ANTHROPIC_BASE_URL: "https://router.corp.example/llm",
      ANTHROPIC_AUTH_TOKEN: "the-developers-own-token",
      ANTHROPIC_API_KEY: "the-developers-own-key",
    };
    for (const [name, value] of Object.entries(developers)) vi.stubEnv(name, value);

    const config = await loadConfig({ HUBBER_E2E_PORT: "4999" });
    const webServer = Array.isArray(config.webServer) ? undefined : config.webServer;
    // Playwright starts the server with its own environment and lays these values over it.
    const environment: NodeJS.ProcessEnv = { ...process.env, ...webServer?.env };

    // What decides which data the server opens and which credential it holds: none of it
    // reaches the server as the shell had it.
    const inherited = Object.entries(developers).filter(([name, value]) => environment[name] === value);
    expect(inherited).toEqual([]);
    expect(environment).toMatchObject({
      HUBBER_WORKSPACE: e2eWorkspaceDir(4999),
      // The address the throwaway workspace is pinned to: any other would keep it closed.
      ANTHROPIC_BASE_URL: TEST_WORKSPACE.endpoint,
      ANTHROPIC_AUTH_TOKEN: "e2e-placeholder-not-a-credential",
      ANTHROPIC_API_KEY: "",
      // Beside the workspace, not in it; nothing ever creates the file.
      HUBBER_CREDENTIALS_FILE: `${e2eWorkspaceDir(4999)}-no-credentials.json`,
    });
    // The one kind of directory that the script of the web server command agrees to delete.
    expect(isE2eWorkspaceDir(environment.HUBBER_WORKSPACE ?? "")).toBe(true);
  });

  it.each(["abc", "0", "80", "4735.5", "65536"])("rejects HUBBER_E2E_PORT=%s under its own name", async (value) => {
    await expect(loadConfig({ HUBBER_E2E_PORT: value })).rejects.toThrow(
      `Niepoprawna wartość HUBBER_E2E_PORT: "${value}". Podaj numer portu od 1024 do 65535.`,
    );
  });

  it("adds Google Chrome to the browsers only when HUBBER_E2E_CHROME is 1", async () => {
    const browsers = async (variables: RunVariables) =>
      (await loadConfig(variables)).projects?.map((project) => project.use?.channel ?? project.use?.browserName);

    expect(await browsers({})).toEqual(["chromium", "webkit"]);
    expect(await browsers({ HUBBER_E2E_CHROME: "0" })).toEqual(["chromium", "webkit"]);
    expect(await browsers({ HUBBER_E2E_CHROME: "1" })).toEqual(["chromium", "webkit", "chrome"]);
  });
});

describe("the egress check of an end-to-end run", () => {
  const PORT = 4999;
  const at = (pid: number, stack: string[] = []) => ({ pid, ppid: 1, thread: 0, stack });
  const loaded = (pid: number, script: string): EgressRecord => ({ kind: "loaded", script, execArgv: [], ...at(pid) });
  const listen = (pid: number, port = PORT, host = "127.0.0.1"): EgressRecord => ({
    kind: "listen",
    host,
    port,
    ...at(pid),
  });
  const connect = (pid: number, host: string, port: number, refused = false, stack: string[] = []): EgressRecord => ({
    kind: "connect",
    transport: "tcp",
    host,
    port,
    tls: false,
    refused,
    ...at(pid, stack),
  });
  // What the log of a run holds when all is well: npm, which starts a shell, the check of the
  // Node version, the build with a thread of its own, and the server with its one port.
  const QUIET_RUN: EgressRecord[] = [
    loaded(10, "/opt/homebrew/bin/npm"),
    { kind: "spawn", file: "sh", args: ["sh", "-c", "node scripts/preflight.cjs && …"], ...at(10) },
    loaded(11, join(REPO_ROOT, "scripts/preflight.cjs")),
    loaded(12, join(REPO_ROOT, "node_modules/.bin/vite")),
    { kind: "worker", script: "file:///somewhere/in/the/build.js", ...at(12) },
    // The build may talk to this machine as it likes.
    connect(12, "127.0.0.1", 5000),
    loaded(13, SERVER_SCRIPT),
    listen(13),
  ];

  it("has nothing to say about a run in which the server opened its port and did nothing else", () => {
    expect(egressProblems(QUIET_RUN, PORT)).toEqual([]);
  });

  it.each([
    ["an empty log", [], "the log has 0 record(s)"],
    ["a log without the start of the server", QUIET_RUN.slice(0, 6), "the log has 6 record(s)"],
    // Another script under the same name is not the server of this checkout.
    [
      "a log of another server",
      [loaded(13, "/somewhere/else/src/server/main.ts"), listen(13)],
      "the log has 2 record(s)",
    ],
  ])("fails for %s: without the observer in the server nothing is known", (_what, records, counted) => {
    const problems = egressProblems(records, PORT);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("The observer was not in the server");
    expect(problems[0]).toContain(counted);
    expect(problems[0]).toContain(SERVER_SCRIPT);
  });

  it("fails for a log that holds more than one start of the server", () => {
    const twice = [...QUIET_RUN, loaded(23, SERVER_SCRIPT), listen(23)];

    expect(egressProblems(twice, PORT)).toEqual([
      "The log holds 2 starts of the server where a run has one: it was not emptied before this run, or the server was started again.",
    ]);
  });

  it.each([
    ["no port at all", [], "the log has none"],
    ["another port", [listen(13, PORT + 1)], `the log has 127.0.0.1:${PORT + 1}`],
    ["its port on every interface", [listen(13, PORT, "(every interface)")], `the log has (every interface):${PORT}`],
    ["a second port", [listen(13), listen(13, PORT + 1)], `the log has 127.0.0.1:${PORT}, 127.0.0.1:${PORT + 1}`],
  ])("fails when the server opened %s: the hooks of the observer may no longer fire", (_what, ports, found) => {
    const records = [...QUIET_RUN.slice(0, 7), ...ports];

    expect(egressProblems(records, PORT)).toEqual([
      `The server must have opened one port, 127.0.0.1:${PORT}, and ${found}.`,
    ]);
  });

  it("names what the server reached for, how often, and from which line of the code", () => {
    const fromTheApp = [
      "Object.connect (node:net:254:17)",
      "Agent.createConnection (node:_http_agent:304:16)",
      "file:///repo/src/server/app.ts:107:59",
      "dispatch (file:///repo/node_modules/hono/dist/compose.js:22:23)",
    ];
    const laterByNode = [
      "node:internal/deps/undici/undici:1:2",
      "process.processTicksAndRejections (node:internal/x:1:2)",
    ];
    const records: EgressRecord[] = [
      ...QUIET_RUN,
      connect(13, "127.0.0.1", 4709, false, fromTheApp),
      connect(13, "127.0.0.1", 4709, false, fromTheApp),
      connect(13, "router.corp.example", 443, true, laterByNode),
      { kind: "udp", host: "127.0.0.1", port: 53, refused: false, ...at(13) },
      { kind: "dns", via: "dns.", name: "router.corp.example", refused: true, ...at(13) },
      { kind: "spawn", file: "/usr/bin/curl", args: ["-s", "https://router.corp.example"], ...at(13) },
      { kind: "worker", script: "(code)", ...at(13) },
    ];

    expect(egressProblems(records, PORT)).toEqual([
      [
        "The server did what can leave its process (NFR-1 allows nothing but calls to the endpoint, and nothing calls it yet):",
        "  2 × connect 127.0.0.1:4709   (first from file:///repo/src/server/app.ts:107:59)",
        "  1 × connect router.corp.example:443   (first from node:internal/deps/undici/undici:1:2 < process.processTicksAndRejections (node:internal/x:1:2))",
        "  1 × udp 127.0.0.1:53",
        "  1 × dns.(router.corp.example)",
        "  1 × spawn /usr/bin/curl -s https://router.corp.example",
        "  1 × worker (code)",
      ].join("\n"),
    ]);
  });

  it("names what npm or the build reached for on another machine, and leaves them their programs and threads", () => {
    const records: EgressRecord[] = [
      ...QUIET_RUN,
      connect(10, "registry.npmjs.org", 443, true, ["request (file:///opt/npm/lib/fetch.js:1:2)"]),
      { kind: "dns", via: "dns.", name: "registry.npmjs.org", refused: true, ...at(10) },
    ];

    expect(egressProblems(records, PORT)).toEqual([
      [
        "What starts the server reached for another machine, and was refused:",
        "  1 × connect registry.npmjs.org:443   (first from request (file:///opt/npm/lib/fetch.js:1:2))",
        "  1 × dns.(registry.npmjs.org)",
      ].join("\n"),
    ]);
  });

  it("knows the server by what its script is, however the checkout was reached", () => {
    // Node names a script the way it was reached, and a checkout can be reached through a link.
    const link = join(tempDir(), "checkout");
    symlinkSync(REPO_ROOT, link);
    const records = [loaded(13, join(link, "src/server/main.ts")), listen(13)];

    expect(egressProblems(records, PORT)).toEqual([]);
  });

  describe("at the end of the run", () => {
    /** The part of Playwright's configuration that the check reads, for a workspace in a directory of the test's own. */
    function run(): { config: FullConfig; logFile: string } {
      const workspace = join(tempDir(), "hubber-e2e-4999");
      const env = { HUBBER_WORKSPACE: workspace, HUBBER_PORT: String(PORT) };
      return { config: { webServer: { env } } as unknown as FullConfig, logFile: egressLogBeside(workspace) };
    }
    const write = (logFile: string, records: EgressRecord[]) =>
      writeFileSync(logFile, records.map((record) => `${JSON.stringify(record)}\n`).join(""));

    it("reads the log beside the workspace of the run, and passes when it is that of a quiet run", () => {
      const { config, logFile } = run();
      write(logFile, QUIET_RUN);

      expect(readEgressLog(logFile)).toEqual(QUIET_RUN);
      expect(() => checkEgress(config)).not.toThrow();
    });

    it("fails the run when there is no log: a run that nobody watched has shown nothing", () => {
      const { config, logFile } = run();

      expect(readEgressLog(logFile)).toEqual([]);
      expect(() => checkEgress(config)).toThrow(/^The observer was not in the server: the log has 0 record\(s\)/);
      expect(() => checkEgress(config)).toThrow(`\nThe whole log: ${logFile}`);
    });

    it("fails the run with what the server reached for, and says where the whole log is", () => {
      const { config, logFile } = run();
      write(logFile, [...QUIET_RUN, connect(13, "127.0.0.1", 4709)]);

      expect(() => checkEgress(config)).toThrow(`  1 × connect 127.0.0.1:4709\nThe whole log: ${logFile}`);
    });

    it("fails the run when the configuration does not say where the server's workspace is", () => {
      expect(() => checkEgress({ webServer: null } as unknown as FullConfig)).toThrow(
        "The configuration names no workspace and port for the server",
      );
    });
  });

  it("is fed by a Node that was started with the options the configuration hands the app", async () => {
    // A directory with a space and a quote in its name: the options are one word all the same.
    const dir = join(tempDir(), "it's a run");
    mkdirSync(dir);
    const logFile = egressLogBeside(join(dir, "hubber-e2e-4999"));
    const script = join(dir, "started.mjs");
    writeFileSync(script, 'console.log("started");\n');

    const started = spawnNode(script, { env: { NODE_OPTIONS: observerOptions(logFile) } });
    children.push(started.child);

    expect(await started.exited, started.stderr()).toEqual({ code: 0, signal: null });
    expect(started.stdout()).toBe("started\n");
    expect(readEgressLog(logFile)).toMatchObject([{ kind: "loaded", script, pid: started.child.pid }]);
  });
});
