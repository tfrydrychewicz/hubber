import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type Exit,
  freePorts,
  type OccupiedPort,
  occupyPort,
  rawGet,
  type SpawnedNode,
  spawnNode,
  TEST_WORKSPACE,
} from "./testing.ts";
import { createTestWorkspace, createTestWorkspaceAt, type TestWorkspace } from "./workspace/testing.ts";

const MAIN = join(import.meta.dirname, "main.ts");
const RUN_SERVER = join(import.meta.dirname, "run-server.ts");
const SCRUB_ENV = join(import.meta.dirname, "llm/credentials/scrub-env.ts");
const CREATE_COMMAND = "scripts/workspace-create.ts";
const HOST = "127.0.0.1";
// Any allowed value puts the server in development mode, where it needs no built web app.
const DEV_ORIGIN = "http://127.0.0.1:5173";
const START_TIMEOUT_MS = 10_000;
const INDEX_HTML = '<!doctype html><html lang="pl"><head><title>Hubber</title></head><body></body></html>';
const LAYOUT = ["files", "hubber.sqlite", "workspace.json"];
const ROUTER = "https://router.corp.example/llm";
const OTHER_ROUTER = "https://other.corp.example/llm";
const PUBLIC_API = "https://api.anthropic.com";
// Invented, and sent nowhere: nothing in these tests calls a model.
const TOKEN = "invented-token-for-tests";
const CREATE_HINT = 'Utworzysz go poleceniem "npm run workspace:create -- --name <nazwa> --kind <anthropic|router>".';
const WITHOUT_CREDENTIAL =
  "Serwer działa dalej, ale wywołania modelu będą kończyć się błędem, dopóki tego nie poprawisz.";

// Loaded before the entry point. It sends the process a signal from inside the call that
// prints the first line: no one who waits for that line can react any earlier.
const SIGNAL_AT_FIRST_LINE = `const { log } = console;
console.log = (...args) => {
  console.log = log;
  log(...args);
  process.kill(process.pid, "SIGTERM");
};
`;

// Loaded before the entry point. It tells what only the process itself can see: which of the
// SDK's variables are in its live environment, at load and whenever SIGUSR2 asks, and the umask
// it runs with. The umask is set to the usual one first, so that the one reported later is the
// server's own doing and not what the tests happened to be started with.
const REPORT_PROCESS_STATE = `process.umask(0o022);
const sdkVariables = () =>
  JSON.stringify(
    Object.keys(process.env)
      .filter((name) => name.startsWith("ANTHROPIC_"))
      .sort(),
  );
console.error(\`at load: \${sdkVariables()}\`);
process.on("SIGUSR2", () => console.error(\`now: \${sdkVariables()} umask \${process.umask().toString(8)}\`));
`;

interface Launched extends SpawnedNode {
  /** Resolves with the address the server printed. Rejects if the process ends first. */
  url: Promise<string>;
}

interface LaunchOptions {
  /** What to start in place of main.ts. */
  script?: string;
  nodeArgs?: string[];
  /** The workspace to open in place of this file's own; null leaves the process without one. */
  workspace?: TestWorkspace | null;
}

const children: ChildProcess[] = [];
const sockets: Socket[] = [];
const workspaces: TestWorkspace[] = [];
let taken: OccupiedPort | undefined;

let workDir: string;
let webRoot: string;
let productionEntry: string;
let signalAtFirstLine: string;
let reportProcessState: string;
// Ways of switching a proxy on that are files: a Node configuration file, a file of variables,
// and modules to load before the entry point.
let nodeConfigFile: string;
let nodeOptionsEnvFile: string;
let proxyFromEnvironment: string;
let dispatcherOfItsOwn: string;
let uncheckedDispatcher: string;
// And of switching the certificate check off.
let uncheckedEnvFile: string;
let uncheckedModule: string;
// The throwaway workspace that every start of this file opens unless the test names another.
let shared: TestWorkspace;

// Stands in for main.ts, which adds to runServer() the directory of the built web app. With a
// directory of its own, this one starts the production mode without the real build. Like
// main.ts, it takes the environment first.
function writeEntry(name: string, root: string): string {
  const entry = join(workDir, name);
  writeFileSync(
    entry,
    `import { takeEnvironment } from ${JSON.stringify(pathToFileURL(SCRUB_ENV).href)};
import { runServer } from ${JSON.stringify(pathToFileURL(RUN_SERVER).href)};
const env = takeEnvironment();
await runServer({ env, webRoot: ${JSON.stringify(root)} });
`,
  );
  return entry;
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "hubber-main-"));
  webRoot = join(workDir, "web");
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, "index.html"), INDEX_HTML);
  productionEntry = writeEntry("production.mjs", webRoot);

  signalAtFirstLine = join(workDir, "signal-at-first-line.mjs");
  writeFileSync(signalAtFirstLine, SIGNAL_AT_FIRST_LINE);
  reportProcessState = join(workDir, "report-process-state.mjs");
  writeFileSync(reportProcessState, REPORT_PROCESS_STATE);

  nodeConfigFile = join(workDir, "node-options.json");
  writeFileSync(nodeConfigFile, JSON.stringify({ nodeOptions: { "use-env-proxy": true } }));
  nodeOptionsEnvFile = join(workDir, "node-options.env");
  writeFileSync(nodeOptionsEnvFile, "NODE_OPTIONS=--use_env_proxy\n");
  proxyFromEnvironment = join(workDir, "proxy-from-environment.mjs");
  writeFileSync(proxyFromEnvironment, 'import http from "node:http";\nhttp.setGlobalProxyFromEnv();\n');
  // Built from the class of the default dispatcher itself, which Node creates at the first use of
  // what it shares the code with.
  uncheckedDispatcher = join(workDir, "unchecked-dispatcher.cjs");
  writeFileSync(
    uncheckedDispatcher,
    'new Headers();\nconst key = Symbol.for("undici.globalDispatcher.2");\nconst Agent = globalThis[key].constructor;\nglobalThis[key] = new Agent({ connect: { rejectUnauthorized: false } });\n',
  );
  uncheckedEnvFile = join(workDir, "unchecked.env");
  writeFileSync(uncheckedEnvFile, "NODE_TLS_REJECT_UNAUTHORIZED=0\n");
  uncheckedModule = join(workDir, "unchecked.cjs");
  writeFileSync(uncheckedModule, 'process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";\n');
  dispatcherOfItsOwn = join(workDir, "dispatcher-of-its-own.cjs");
  writeFileSync(
    dispatcherOfItsOwn,
    'globalThis[Symbol.for("undici.globalDispatcher.2")] = new (class ProxyAgent {\n  dispatch() {\n    return false;\n  }\n})();\n',
  );

  shared = createTestWorkspace();
});

afterAll(() => {
  shared.remove();
  rmSync(workDir, { recursive: true, force: true });
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const workspace of workspaces.splice(0)) workspace.remove();
  await taken?.release();
  taken = undefined;
});

// spawnNode() builds the environment from scratch: no HOME and none of the developer's own
// variables. So a server started here opens the workspace it is given or none at all.
function launch(
  env: Record<string, string>,
  { script = MAIN, nodeArgs = [], workspace = shared }: LaunchOptions = {},
): Launched {
  const server = spawnNode(script, { nodeArgs, env: { ...workspace?.env, ...env } });
  children.push(server.child);
  const output = () => `${server.stdout()}${server.stderr()}`;
  const url = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`No address within ${START_TIMEOUT_MS} ms.\n${output()}`)),
      START_TIMEOUT_MS,
    );
    server.child.stdout.on("data", () => {
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(server.stdout());
      if (!match) return;
      clearTimeout(timer);
      resolve(match[0]);
    });
    void server.exited.then(({ code }) => {
      clearTimeout(timer);
      reject(new Error(`The server exited with code ${code} before printing its address.\n${output()}`));
    });
  });
  // A test that fails early never gets to await the address.
  url.catch(() => {});
  return { ...server, url };
}

/**
 * Waits for a start that has to fail and resolves with how the process ended. The wait for the
 * address is part of it, for what that wait reports: a start that hangs shows the server output.
 */
async function failedStart(server: Launched): Promise<Exit> {
  await expect(server.url).rejects.toThrow("before printing its address");
  return server.exited;
}

// The server takes its port as a number and refuses 0, so the number is found beforehand.
async function launchDev(
  env: Record<string, string> = {},
  options: LaunchOptions = {},
): Promise<Launched & { port: number }> {
  const [port] = await freePorts(1);
  const server = launch({ HUBBER_PORT: String(port), HUBBER_DEV_ORIGIN: DEV_ORIGIN, ...env }, options);
  await server.url;
  return { ...server, port };
}

/** Stops a running server the way a closing terminal does, and resolves with how it ended. */
function stop(server: SpawnedNode): Promise<Exit> {
  server.child.kill("SIGTERM");
  return server.exited;
}

// A request that never completes keeps its connection busy, the way an event stream does.
// It is sent in one write with a complete request: the answer to that one proves that the
// server has read both. A signal sent earlier could find the connection still idle.
async function holdRequestOpen(port: number): Promise<void> {
  const socket = connect({ host: HOST, port });
  sockets.push(socket);
  socket.on("error", () => {});
  await once(socket, "connect");
  const unfinished = `GET /api/health HTTP/1.1\r\nHost: ${HOST}:${port}\r\n`;
  socket.write(`${unfinished}\r\n${unfinished}`);
  await once(socket, "data");
}

/** Whether anything accepts a connection on the port. */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port });
    socket.once("error", () => resolve(false));
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
  });
}

/** A throwaway workspace of the test's own, for a test that changes it or looks at what a start leaves in it. */
function ownWorkspace(...profile: Parameters<typeof createTestWorkspace>): TestWorkspace {
  const created = createTestWorkspace(...profile);
  workspaces.push(created);
  return created;
}

/** What a directory holds, each file with a digest of its bytes: what a refused start must leave as it was. */
function contentsOf(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((entry) => [
        entry.name,
        entry.isDirectory()
          ? `directory with ${readdirSync(join(dir, entry.name)).length} entries`
          : createHash("sha256")
              .update(readFileSync(join(dir, entry.name)))
              .digest("hex"),
      ]),
  );
}

const refusal = (reason: string, name?: string) =>
  `Nie można otworzyć workspace'u${name === undefined ? "" : ` „${name}”`}: ${reason}\n`;

/**
 * What every start that is refused has in common, whatever the reason: the reason on stderr and
 * nothing else, nothing on stdout, the exit code that names the kind of refusal, and nobody left
 * on the port.
 */
async function expectRefusal(
  server: Launched,
  port: number,
  expected: { code: number; stderr: string },
): Promise<void> {
  expect(await failedStart(server)).toEqual({ code: expected.code, signal: null });
  expect(server.stderr()).toBe(expected.stderr);
  expect(server.stdout()).toBe("");
  expect(await accepts(port)).toBe(false);
}

// Above the start timeout, so that a slow start reports the server output and not a bare test timeout.
describe("main", { timeout: START_TIMEOUT_MS + 5_000 }, () => {
  it("prints its address in Polish and answers on it", async () => {
    const server = await launchDev();

    expect(server.stdout()).toContain(`API nasłuchuje pod adresem http://${HOST}:${server.port}.`);
    const response = await fetch(`http://${HOST}:${server.port}/api/health`);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("serves the web app from the directory it is given when started for production", async () => {
    const [port] = await freePorts(1);
    const server = launch({ HUBBER_PORT: String(port) }, { script: productionEntry });
    await server.url;

    expect(server.stdout()).toContain(`Hubber działa pod adresem http://${HOST}:${port} (Ctrl-C kończy pracę).`);
    const page = await fetch(`http://${HOST}:${port}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(INDEX_HTML);
  });

  it("refuses a request addressed to another host name", async () => {
    const server = await launchDev();

    const response = await rawGet({
      port: server.port,
      target: "/api/health",
      host: `attacker.example:${server.port}`,
    });

    expect(response).toMatch(/^HTTP\/1\.1 403 /);
    expect(response).toContain('"error":"forbidden_host"');
  });

  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "closes, leaves one database file behind and exits with code 0 on %s",
    async (signal) => {
      const workspace = ownWorkspace();
      const server = await launchDev({}, { workspace });
      // Leaves an idle keep-alive connection behind, as a browser tab would.
      await (await fetch(`http://${HOST}:${server.port}/api/health`)).text();
      // The database is open: only then is there anything for the shutdown to close.
      expect(readdirSync(workspace.dir)).toContain("hubber.sqlite-wal");

      const startedAt = performance.now();
      server.child.kill(signal);

      expect(await server.exited).toEqual({ code: 0, signal: null });
      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(server.stdout()).toContain("Zamykanie serwera…");
      // What makes a copy of the directory a backup: the write-ahead log is back in the one file.
      expect(readdirSync(workspace.dir).sort()).toEqual(LAYOUT);
    },
  );

  it("shuts down cleanly on a signal that arrives the moment its address is printed", async () => {
    const workspace = ownWorkspace();
    const [port] = await freePorts(1);

    const server = launch(
      { HUBBER_PORT: String(port), HUBBER_DEV_ORIGIN: DEV_ORIGIN },
      { nodeArgs: ["--import", pathToFileURL(signalAtFirstLine).href], workspace },
    );
    // Awaited for what it reports when there is no address: a start that hangs shows the server output.
    await server.url;

    expect(await server.exited).toEqual({ code: 0, signal: null });
    expect(server.stdout()).toContain(`API nasłuchuje pod adresem http://${HOST}:${port}.`);
    expect(server.stdout()).toContain("Zamykanie serwera…");
    expect(readdirSync(workspace.dir).sort()).toEqual(LAYOUT);
  });

  it("ends a connection that would never finish, and survives a repeated signal", async () => {
    const server = await launchDev();
    await holdRequestOpen(server.port);

    const startedAt = performance.now();
    server.child.kill("SIGINT");
    // Two signals sent back to back can merge into one, so the second waits until the first was handled.
    await vi.waitFor(() => expect(server.stdout()).toContain("Zamykanie serwera…"));
    server.child.kill("SIGINT");

    expect(await server.exited).toEqual({ code: 0, signal: null });
    const elapsed = performance.now() - startedAt;
    // The held request is cut off after the grace period of one second. An earlier exit
    // means that the process did not wait for the server to close.
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2_500);
    expect(server.stdout().match(/Zamykanie serwera…/g)).toHaveLength(1);
  });

  // What becomes of a shutdown that hangs is tested in shutdown.test.ts. That test waits for the
  // deadline, three seconds; there it runs beside the tests of this file instead of after them.

  it("names the process that holds a taken port and exits with code 1", async () => {
    taken = await occupyPort();

    const server = launch({ HUBBER_PORT: String(taken.port), HUBBER_DEV_ORIGIN: DEV_ORIGIN });

    expect(await failedStart(server)).toEqual({ code: 1, signal: null });
    expect(server.stderr()).toContain(`Port ${taken.port} na ${HOST} jest zajęty przez proces ${process.pid}`);
    expect(server.stderr()).toContain("HUBBER_PORT");
    expect(server.stderr()).not.toMatch(/^\s+at /m);
    expect(server.stdout()).toBe("");
  });

  it("reports a taken port before it looks for the workspace", async () => {
    taken = await occupyPort();
    const nowhere = join(workDir, "no-workspace-here");

    const server = launch({
      HUBBER_PORT: String(taken.port),
      HUBBER_DEV_ORIGIN: DEV_ORIGIN,
      HUBBER_WORKSPACE: nowhere,
    });

    expect(await failedStart(server)).toEqual({ code: 1, signal: null });
    expect(server.stderr()).toContain(`Port ${taken.port} na ${HOST} jest zajęty`);
    expect(server.stderr()).not.toContain(nowhere);
    expect(server.stdout()).toBe("");
    // Still held by whoever had it.
    expect(await accepts(taken.port)).toBe(true);
  });

  // One value is enough here: which values are refused is the business of parsePort() and its tests.
  it("rejects a HUBBER_PORT it cannot use with code 2", async () => {
    const server = launch({ HUBBER_PORT: "0", HUBBER_DEV_ORIGIN: DEV_ORIGIN });

    expect(await failedStart(server)).toEqual({ code: 2, signal: null });
    expect(server.stderr()).toContain('Niepoprawna wartość HUBBER_PORT: "0".');
    expect(server.stderr()).not.toMatch(/^\s+at /m);
    expect(server.stdout()).toBe("");
  });

  it.each([
    "http://192.168.1.10:5173",
    // Names the loopback address, yet in a form that no browser sends as an Origin.
    "http://127.0.0.1:80",
  ])("rejects the development origin %s with code 2", async (origin) => {
    const [port] = await freePorts(1);
    const server = launch({ HUBBER_PORT: String(port), HUBBER_DEV_ORIGIN: origin });

    expect(await failedStart(server)).toEqual({ code: 2, signal: null });
    expect(server.stderr()).toContain(`Niepoprawna wartość HUBBER_DEV_ORIGIN: "${origin}"`);
    expect(server.stderr()).not.toMatch(/^\s+at /m);
    expect(server.stdout()).toBe("");
  });

  describe("on its workspace", () => {
    it("names the workspace and the source of its credential after its address, and tells the page of the workspace", async () => {
      const server = await launchDev({ ANTHROPIC_BASE_URL: TEST_WORKSPACE.endpoint, ANTHROPIC_AUTH_TOKEN: TOKEN });

      const answer = await fetch(`http://${HOST}:${server.port}/api/workspace`);
      expect(await answer.json()).toEqual({
        name: TEST_WORKSPACE.name,
        endpointOrigin: new URL(TEST_WORKSPACE.endpoint).origin,
      });

      expect(await stop(server)).toEqual({ code: 0, signal: null });
      // The address stays the first line: whoever reads the output takes the first address in
      // it for the server's own, and the endpoint in the next line is an address too.
      expect(server.stdout().split("\n")).toEqual([
        `API nasłuchuje pod adresem http://${HOST}:${server.port}.`,
        `Workspace „${TEST_WORKSPACE.name}”: katalog "${shared.dir}", endpoint ${TEST_WORKSPACE.endpoint}.`,
        "Poświadczenia: zmienna ANTHROPIC_AUTH_TOKEN.",
        "Zamykanie serwera…",
        "",
      ]);
      expect(server.stderr()).toBe("");
    });

    it("prints the same lines after its address when started for production", async () => {
      const [port] = await freePorts(1);
      const server = launch(
        { HUBBER_PORT: String(port), ANTHROPIC_BASE_URL: TEST_WORKSPACE.endpoint, ANTHROPIC_AUTH_TOKEN: TOKEN },
        { script: productionEntry },
      );
      expect(await server.url).toBe(`http://${HOST}:${port}`);

      expect(await stop(server)).toEqual({ code: 0, signal: null });
      expect(server.stdout().split("\n")).toEqual([
        `Hubber działa pod adresem http://${HOST}:${port} (Ctrl-C kończy pracę).`,
        `Workspace „${TEST_WORKSPACE.name}”: katalog "${shared.dir}", endpoint ${TEST_WORKSPACE.endpoint}.`,
        "Poświadczenia: zmienna ANTHROPIC_AUTH_TOKEN.",
        "Zamykanie serwera…",
        "",
      ]);
      expect(server.stderr()).toBe("");
    });

    it("starts without a credential, says on stderr what is missing, and answers all the same", async () => {
      const server = await launchDev();

      const response = await fetch(`http://${HOST}:${server.port}/api/health`);
      expect(await response.json()).toEqual({ status: "ok" });

      expect(await stop(server)).toEqual({ code: 0, signal: null });
      expect(server.stderr()).toBe(
        `Brak poświadczeń dla endpointu ${TEST_WORKSPACE.endpoint}.
Sprawdzone po kolei:
  1. środowisko: zmienna ANTHROPIC_AUTH_TOKEN nie jest ustawiona;
  2. plik poświadczeń: nie ma domyślnego pliku, bo zmienna HOME nie jest ustawiona; plik wskażesz zmienną HUBBER_CREDENTIALS_FILE.
Ustaw zmienne ANTHROPIC_AUTH_TOKEN i ANTHROPIC_BASE_URL=${TEST_WORKSPACE.endpoint} albo dodaj do pliku poświadczeń wpis dla tego endpointu z polem "authToken" lub "helper". Opis: README, rozdział „Poświadczenia”.
${WITHOUT_CREDENTIAL}
`,
      );
      expect(server.stdout()).not.toContain("Poświadczenia:");
    });

    it("leaves a token alone that comes without the address of its endpoint: it belongs to the public API", async () => {
      const server = await launchDev({ ANTHROPIC_AUTH_TOKEN: TOKEN });

      expect(await stop(server)).toEqual({ code: 0, signal: null });
      expect(server.stderr()).toContain(
        `  1. środowisko: zmienna ANTHROPIC_AUTH_TOKEN jest ustawiona, ale bez ANTHROPIC_BASE_URL należy do ${PUBLIC_API}, a nie do tego endpointu;\n`,
      );
      expect(server.stderr()).toContain(`${WITHOUT_CREDENTIAL}\n`);
      expect(server.stdout()).not.toContain("Poświadczenia:");
      expect(server.stdout() + server.stderr()).not.toContain(TOKEN);
    });

    it("names the helper command of the credentials file as its source, and does not run it", async () => {
      // A command that would leave a mark. The start only says where the credential will come
      // from: the command may need the owner (a login in a browser), so it runs when a call needs it.
      const mark = join(workDir, "helper-was-run");
      const program = join(workDir, "token.sh");
      writeFileSync(program, `#!/bin/sh\ntouch "${mark}"\necho ${TOKEN}\n`, { mode: 0o700 });
      const file = join(workDir, "credentials.json");
      writeFileSync(
        file,
        JSON.stringify({ version: 1, endpoints: { [TEST_WORKSPACE.endpoint]: { helper: { command: [program] } } } }),
        { mode: 0o600 },
      );

      const server = await launchDev({ HUBBER_CREDENTIALS_FILE: file });

      expect(await stop(server)).toEqual({ code: 0, signal: null });
      expect(server.stdout()).toContain(`Poświadczenia: polecenie pomocnicze "${program}" (z pliku "${file}").\n`);
      expect(server.stderr()).toBe("");
      expect(existsSync(mark)).toBe(false);
    });

    it("reads the address and the credential from a copy of its environment, and keeps neither in the live one", async () => {
      const server = await launchDev(
        {
          ANTHROPIC_BASE_URL: TEST_WORKSPACE.endpoint,
          ANTHROPIC_AUTH_TOKEN: TOKEN,
          ANTHROPIC_CUSTOM_HEADERS: "x-team: alfa",
        },
        { nodeArgs: ["--import", pathToFileURL(reportProcessState).href] },
      );
      // The copy served the application: the pin was compared and the token was found.
      await vi.waitFor(() => expect(server.stdout()).toContain("Poświadczenia: zmienna ANTHROPIC_AUTH_TOKEN."));

      server.child.kill("SIGUSR2");
      await vi.waitFor(() => expect(server.stderr()).toContain("now: "));

      // They were there when the process started, so their absence is the server's doing. Without
      // them an SDK client finds nothing by itself, and no child process inherits a credential.
      expect(server.stderr()).toContain(
        'at load: ["ANTHROPIC_AUTH_TOKEN","ANTHROPIC_BASE_URL","ANTHROPIC_CUSTOM_HEADERS"]\n',
      );
      expect(server.stderr()).toContain("now: [] ");
    });

    it("lets nobody but the owner into what it creates from then on", async () => {
      const server = await launchDev({}, { nodeArgs: ["--import", pathToFileURL(reportProcessState).href] });

      server.child.kill("SIGUSR2");

      await vi.waitFor(() => expect(server.stderr()).toMatch(/^now: .* umask 77$/m));
    });

    it("warns about a workspace directory that other accounts can enter, and opens it", async () => {
      const workspace = ownWorkspace();
      chmodSync(workspace.dir, 0o755);

      const server = await launchDev(
        { ANTHROPIC_BASE_URL: TEST_WORKSPACE.endpoint, ANTHROPIC_AUTH_TOKEN: TOKEN },
        { workspace },
      );

      expect(await stop(server)).toEqual({ code: 0, signal: null });
      expect(server.stderr()).toBe(
        `Uwaga: katalog workspace'u "${workspace.dir}" jest dostępny dla innych kont tego komputera (uprawnienia 755). Zamkniesz go poleceniem "chmod -R go-rwx" na tym katalogu.\n`,
      );
      expect(server.stdout()).toContain(`Workspace „${TEST_WORKSPACE.name}”: katalog "${workspace.dir}"`);
    });

    it("opens the default workspace of the home directory it is given, and looks for the credentials file there", async () => {
      const home = join(workDir, "home-with-workspace");
      const dir = join(home, "Library/Application Support/Hubber/workspaces/default");
      createTestWorkspaceAt(dir);

      const server = await launchDev({ HOME: home }, { workspace: null });

      expect(await stop(server)).toEqual({ code: 0, signal: null });
      expect(server.stdout()).toContain(
        `Workspace „${TEST_WORKSPACE.name}”: katalog "${dir}", endpoint ${TEST_WORKSPACE.endpoint}.\n`,
      );
      expect(server.stderr()).toContain(
        `  2. plik poświadczeń: plik "${join(home, ".config/hubber/credentials.json")}" nie istnieje.\n`,
      );
    });

    it("closes the workspace again when the app cannot be built after all", async () => {
      // A build that the settings accept and the app cannot read: the workspace is open by then.
      const brokenRoot = join(workDir, "web-unreadable");
      mkdirSync(brokenRoot);
      writeFileSync(join(brokenRoot, "index.html"), INDEX_HTML);
      writeFileSync(join(brokenRoot, "unreadable.js"), "", { mode: 0o000 });
      const workspace = ownWorkspace();
      const [port] = await freePorts(1);

      const server = launch(
        { HUBBER_PORT: String(port) },
        { script: writeEntry("unreadable-build.mjs", brokenRoot), workspace },
      );

      expect(await failedStart(server)).toEqual({ code: 1, signal: null });
      expect(server.stderr()).toContain("EACCES");
      expect(server.stdout()).toBe("");
      expect(await accepts(port)).toBe(false);
      // Closed, not abandoned: a database left open keeps its -wal and -shm files.
      expect(readdirSync(workspace.dir).sort()).toEqual(LAYOUT);
    });

    it("starts again on a workspace whose last server was killed, and leaves it as one database file", async () => {
      const workspace = ownWorkspace();
      const killed = await launchDev({}, { workspace });
      killed.child.kill("SIGKILL");
      expect(await killed.exited).toEqual({ code: null, signal: "SIGKILL" });
      // What a process that had no chance to close leaves beside the database.
      expect(readdirSync(workspace.dir)).toContain("hubber.sqlite-wal");

      const server = await launchDev({}, { workspace });

      expect(await stop(server)).toEqual({ code: 0, signal: null });
      expect(readdirSync(workspace.dir).sort()).toEqual(LAYOUT);
    });
  });

  describe("without a workspace it can open", () => {
    it("has no workspace at all with neither HUBBER_WORKSPACE nor HOME, and exits with code 2", async () => {
      const [port] = await freePorts(1);

      // No default is taken from the account database: a process that is started with an
      // environment of its own must never arrive at the workspace of whoever started it.
      const server = launch({ HUBBER_PORT: String(port), HUBBER_DEV_ORIGIN: DEV_ORIGIN }, { workspace: null });

      await expectRefusal(server, port, {
        code: 2,
        stderr:
          "Nie wskazano workspace'u. Ustaw zmienną HUBBER_WORKSPACE na katalog workspace'u; bez zmiennej HOME nie ma katalogu domyślnego.\n",
      });
    });

    it("rejects a HUBBER_WORKSPACE that is not a full path with code 2", async () => {
      const [port] = await freePorts(1);

      const server = launch({
        HUBBER_PORT: String(port),
        HUBBER_DEV_ORIGIN: DEV_ORIGIN,
        HUBBER_WORKSPACE: "dane/praca",
      });

      await expectRefusal(server, port, {
        code: 2,
        stderr:
          'Niepoprawna wartość HUBBER_WORKSPACE: "dane/praca". Podaj pełną ścieżkę katalogu workspace\'u (od "/" albo "~/").\n',
      });
    });

    it("says how to create the workspace that is not at the named place, and exits with code 1", async () => {
      const [port] = await freePorts(1);
      const nowhere = join(workDir, "no-workspace-here");

      const server = launch({ HUBBER_PORT: String(port), HUBBER_DEV_ORIGIN: DEV_ORIGIN, HUBBER_WORKSPACE: nowhere });

      await expectRefusal(server, port, {
        code: 1,
        stderr: refusal(`katalog "${nowhere}" ze zmiennej HUBBER_WORKSPACE nie istnieje. ${CREATE_HINT}`),
      });
    });

    it("says the same of the default place under HOME, and how to name another", async () => {
      const [port] = await freePorts(1);
      const home = join(workDir, "home-without-workspace");
      mkdirSync(home);

      const server = launch(
        { HUBBER_PORT: String(port), HUBBER_DEV_ORIGIN: DEV_ORIGIN, HOME: home },
        { workspace: null },
      );

      await expectRefusal(server, port, {
        code: 1,
        stderr: refusal(
          `w domyślnym katalogu "${join(home, "Library/Application Support/Hubber/workspaces/default")}" jeszcze go nie ma. ${CREATE_HINT} Inny katalog wskażesz zmienną HUBBER_WORKSPACE.`,
        ),
      });
    });

    it("refuses a workspace path that the system cannot follow, in its own words and with code 1", async () => {
      const [port] = await freePorts(1);
      const loop = join(workDir, "link-to-itself");
      symlinkSync("link-to-itself", loop);

      const server = launch({ HUBBER_PORT: String(port), HUBBER_DEV_ORIGIN: DEV_ORIGIN, HUBBER_WORKSPACE: loop });

      await expectRefusal(server, port, {
        code: 1,
        stderr: refusal(`nie udało się odczytać katalogu "${loop}" (ELOOP).`),
      });
    });

    it("lists every problem of a broken configuration file, without the value of a field that looks like a secret", async () => {
      const workspace = ownWorkspace();
      const file = join(workspace.dir, "workspace.json");
      const config = JSON.parse(readFileSync(file, "utf8"));
      delete config.name;
      config.profile.apiKey = "sk-pasted-by-mistake-0123456789";
      writeFileSync(file, JSON.stringify(config));
      const [port] = await freePorts(1);

      const server = launch({ HUBBER_PORT: String(port), HUBBER_DEV_ORIGIN: DEV_ORIGIN }, { workspace });

      await expectRefusal(server, port, {
        code: 1,
        stderr: refusal(`błędy w pliku konfiguracji "${file}":
  name: brak pola
  profile.apiKey: nieznane pole (Konfiguracja nie przechowuje poświadczeń)`),
      });
    });

    it("rejects an ANTHROPIC_BASE_URL that is no address with code 2, without repeating it", async () => {
      const [port] = await freePorts(1);

      const server = launch({
        HUBBER_PORT: String(port),
        HUBBER_DEV_ORIGIN: DEV_ORIGIN,
        ANTHROPIC_BASE_URL: "https://ola:hunter2@router.corp.example/llm",
      });

      await expectRefusal(server, port, {
        code: 2,
        stderr: refusal(
          "zmienna ANTHROPIC_BASE_URL nie nadaje się na adres endpointu: adres zawiera nazwę użytkownika lub hasło.",
        ),
      });
    });

    // A proxy would get every request meant for the endpoint. Node can be told to use one in more
    // ways than its documented option and variable; whatever the way, the start ends here. The
    // address of the proxy is one that nothing listens on.
    describe("in a process whose Node would use a proxy", () => {
      const PROXY = { HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" };
      const PROXY_SUPPORT =
        "w tym procesie Node ma włączoną obsługę serwera proxy, a Hubber łączy się z endpointem wyłącznie bezpośrednio. Obsługę proxy włącza zmienna NODE_USE_ENV_PROXY=1 albo opcja --use-env-proxy (w wierszu poleceń, w zmiennej NODE_OPTIONS lub w pliku konfiguracyjnym Node). Uruchom aplikację bez tego ustawienia.";

      it.each<[string, Record<string, string>, () => string[]]>([
        ["NODE_USE_ENV_PROXY=1", { NODE_USE_ENV_PROXY: "1" }, () => []],
        ["the option --use-env-proxy", {}, () => ["--use-env-proxy"]],
        ["the option spelled --use_env_proxy", {}, () => ["--use_env_proxy"]],
        ["the option spelled --use-env_proxy", {}, () => ["--use-env_proxy"]],
        ["the option with a value, --use-env-proxy=false", {}, () => ["--use-env-proxy=false"]],
        ["the option in NODE_OPTIONS", { NODE_OPTIONS: "--use-env-proxy" }, () => []],
        ["the option spelled --use_env_proxy in NODE_OPTIONS", { NODE_OPTIONS: "--use_env_proxy" }, () => []],
        ["the option with quotes inside it in NODE_OPTIONS", { NODE_OPTIONS: '--use-"env"-proxy' }, () => []],
        ["the option with a backslash inside it in NODE_OPTIONS", { NODE_OPTIONS: '"--use-env\\-proxy"' }, () => []],
        // Node says on stderr that such a file is an experimental feature, unless it is told not to.
        [
          "the option in a Node configuration file",
          {},
          () => ["--no-warnings", `--experimental-config-file=${nodeConfigFile}`],
        ],
        ["the option in a file of variables", {}, () => [`--env-file=${nodeOptionsEnvFile}`]],
        ["a module loaded first that switches the proxy on", {}, () => ["--import", proxyFromEnvironment]],
      ])("refuses a start with %s, with code 2", async (_what, env, nodeArgs) => {
        const workspace = ownWorkspace();
        const [port] = await freePorts(1);

        const server = launch(
          { HUBBER_PORT: String(port), HUBBER_DEV_ORIGIN: DEV_ORIGIN, ...PROXY, ...env },
          { nodeArgs: nodeArgs(), workspace },
        );

        await expectRefusal(server, port, { code: 2, stderr: refusal(PROXY_SUPPORT) });
        // Refused before the database was opened.
        expect(readdirSync(workspace.dir).sort()).toEqual(LAYOUT);
      });

      it("refuses a start with the option in the Node configuration file of the directory it is started in, with code 2", async () => {
        // Node looks for node.config.json in the working directory, which spawnNode() does not
        // let a test choose: this one start is made by hand.
        const cwd = join(workDir, "configured");
        mkdirSync(cwd);
        writeFileSync(join(cwd, "node.config.json"), JSON.stringify({ nodeOptions: { "use-env-proxy": true } }));
        const workspace = ownWorkspace();
        const [port] = await freePorts(1);

        const child = spawn(process.execPath, ["--no-warnings", "--experimental-default-config-file", MAIN], {
          cwd,
          env: {
            PATH: process.env.PATH ?? "",
            HUBBER_PORT: String(port),
            HUBBER_DEV_ORIGIN: DEV_ORIGIN,
            ...workspace.env,
            ...PROXY,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.push(child);
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
        });
        const [code, signal] = await once(child, "close");

        expect({ code, signal, stdout, stderr }).toEqual({
          code: 2,
          signal: null,
          stdout: "",
          stderr: refusal(PROXY_SUPPORT),
        });
        expect(await accepts(port)).toBe(false);
        expect(readdirSync(workspace.dir).sort()).toEqual(LAYOUT);
      });

      it("refuses a start with the proxy support on although no proxy is named yet", async () => {
        const [port] = await freePorts(1);

        const server = launch({ HUBBER_PORT: String(port), HUBBER_DEV_ORIGIN: DEV_ORIGIN, NODE_USE_ENV_PROXY: "1" });

        await expectRefusal(server, port, { code: 2, stderr: refusal(PROXY_SUPPORT) });
      });

      it.each<[string, string, () => string]>([
        ["puts a dispatcher of its own in the place of the default one", "ProxyAgent", () => dispatcherOfItsOwn],
        // What is passed around as the cure for certificate errors behind a company proxy.
        ["builds the default dispatcher anew without the certificate check", "Agent", () => uncheckedDispatcher],
      ])("refuses a start with a module loaded first that %s", async (_what, className, module) => {
        const workspace = ownWorkspace();
        const [port] = await freePorts(1);

        const server = launch(
          { HUBBER_PORT: String(port), HUBBER_DEV_ORIGIN: DEV_ORIGIN },
          { nodeArgs: ["--require", module()], workspace },
        );

        await expectRefusal(server, port, {
          code: 2,
          stderr: refusal(
            `domyślny mechanizm połączeń Node został w tym procesie podmieniony (obiekt klasy "${className}"), więc połączenia mogą iść przez serwer proxy albo bez sprawdzania certyfikatu, a Hubber łączy się z endpointem wyłącznie bezpośrednio. Podmienia go moduł wczytany przed aplikacją (opcje --require i --import, także w zmiennej NODE_OPTIONS). Uruchom aplikację bez niego.`,
          ),
        });
        expect(readdirSync(workspace.dir).sort()).toEqual(LAYOUT);
      });

      // The controls: the refusals above come from what Node does, not from the look of a setting.
      it.each<[string, Record<string, string>, string[]]>([
        ["proxy variables that Node was not told to use", PROXY, []],
        [
          "NODE_USE_ENV_PROXY=1 that an option takes back",
          { ...PROXY, NODE_USE_ENV_PROXY: "1" },
          ["--no-use-env-proxy"],
        ],
      ])("starts with %s", async (_what, env, nodeArgs) => {
        const server = await launchDev(env, { nodeArgs });

        expect(await stop(server)).toEqual({ code: 0, signal: null });
        expect(server.stdout()).toContain(`Workspace „${TEST_WORKSPACE.name}”: katalog "${shared.dir}"`);
      });
    });

    it.each<[string, Record<string, string>, () => string[]]>([
      ["the variable NODE_TLS_REJECT_UNAUTHORIZED=0", { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, () => []],
      ["a file of variables that sets it", {}, () => [`--env-file=${uncheckedEnvFile}`]],
      // Node reads the variable anew for every connection, so one set after the start counts as well.
      ["a module loaded first that sets it", {}, () => ["--require", uncheckedModule]],
    ])(
      "refuses a start with %s, which would not check the certificate of an https endpoint, with code 2",
      async (_what, env, nodeArgs) => {
        const workspace = ownWorkspace({ endpoint: ROUTER });
        const [port] = await freePorts(1);

        const server = launch(
          { HUBBER_PORT: String(port), HUBBER_DEV_ORIGIN: DEV_ORIGIN, ...env },
          { nodeArgs: nodeArgs(), workspace },
        );

        await expectRefusal(server, port, {
          code: 2,
          stderr: refusal(
            `zmienna NODE_TLS_REJECT_UNAUTHORIZED=0 wyłącza sprawdzanie certyfikatu endpointu ${ROUTER}. Usuń ją; własny urząd certyfikacji wskażesz zmienną NODE_EXTRA_CA_CERTS.`,
          ),
        });
        expect(readdirSync(workspace.dir).sort()).toEqual(LAYOUT);
      },
    );
  });

  // A workspace created for one endpoint does not open with another. The two workspaces are
  // created by the real command, once. A test that changes a workspace or gets it opened works
  // on a copy at another place, which a workspace allows: nothing in the directory names a path.
  describe("on a workspace that is pinned to an endpoint", () => {
    const created = { router: "", development: "" };
    const names = { router: "Praca", development: "Dev" };
    let copies = 0;

    async function create(dir: string, args: string[]): Promise<void> {
      const command = spawnNode(CREATE_COMMAND, { args: [...args, "--dir", dir] });
      children.push(command.child);
      const exit = await command.exited;
      expect({ ...exit, stderr: command.stderr() }).toEqual({ code: 0, signal: null, stderr: "" });
    }

    function copyOf(workspace: keyof typeof created): string {
      const copy = join(workDir, `copy-${++copies}`);
      cpSync(created[workspace], copy, { recursive: true });
      return copy;
    }

    beforeAll(async () => {
      created.router = join(workDir, "created", "router");
      created.development = join(workDir, "created", "development");
      await create(created.router, [
        "--name",
        names.router,
        "--kind",
        "router",
        "--endpoint",
        ROUTER,
        "--model",
        "router-opus",
      ]);
      await create(created.development, ["--name", names.development, "--kind", "anthropic"]);
    });

    it.each([
      ["router", "the public API", ROUTER, PUBLIC_API],
      ["development", "a router", PUBLIC_API, ROUTER],
    ] as const)(
      "does not open a %s workspace where the environment names %s, and exits with code 3",
      async (workspace, _named, pin, active) => {
        const dir = created[workspace];
        const before = contentsOf(dir);
        const [port] = await freePorts(1);

        const server = launch({
          HUBBER_PORT: String(port),
          HUBBER_DEV_ORIGIN: DEV_ORIGIN,
          HUBBER_WORKSPACE: dir,
          ANTHROPIC_BASE_URL: active,
          ANTHROPIC_AUTH_TOKEN: TOKEN,
          ANTHROPIC_API_KEY: TOKEN,
        });

        await expectRefusal(server, port, {
          code: 3,
          stderr: refusal(
            `jest przypięty do endpointu ${pin}, a zmienna ANTHROPIC_BASE_URL wskazuje ${active}. Dane workspace'u nie mogą trafić do innego endpointu. Uruchom aplikację ze środowiskiem endpointu ${pin} albo wskaż zmienną HUBBER_WORKSPACE workspace utworzony dla ${active}.`,
            names[workspace],
          ),
        });
        // Not even opened: the three entries are there as they were, with nothing beside them.
        expect(Object.keys(before)).toEqual(LAYOUT);
        expect(contentsOf(dir)).toEqual(before);
      },
    );

    it("does not open a workspace whose configuration file was edited to another endpoint, although the environment agrees with the edit", async () => {
      const dir = copyOf("router");
      const config = join(dir, "workspace.json");
      writeFileSync(config, readFileSync(config, "utf8").replace(ROUTER, OTHER_ROUTER));
      const [port] = await freePorts(1);

      const server = launch({
        HUBBER_PORT: String(port),
        HUBBER_DEV_ORIGIN: DEV_ORIGIN,
        HUBBER_WORKSPACE: dir,
        ANTHROPIC_BASE_URL: OTHER_ROUTER,
        ANTHROPIC_AUTH_TOKEN: TOKEN,
      });

      await expectRefusal(server, port, {
        code: 3,
        stderr: refusal(
          `plik konfiguracji "${config}" podaje endpoint ${OTHER_ROUTER}, a baza "${join(dir, "hubber.sqlite")}" jest przypięta do ${ROUTER}. Wiążący jest adres zapisany w bazie przy utworzeniu workspace'u: przywróć go w pliku konfiguracji albo przywróć plik bazy, który do tego workspace'u należy.`,
          names.router,
        ),
      });
      // The database was looked into and closed again.
      expect(readdirSync(dir).sort()).toEqual(LAYOUT);
    });

    it("does not open a workspace whose database was brought in from a workspace of another endpoint", async () => {
      const dir = copyOf("router");
      const database = join(dir, "hubber.sqlite");
      copyFileSync(join(created.development, "hubber.sqlite"), database);
      const [port] = await freePorts(1);

      const server = launch({
        HUBBER_PORT: String(port),
        HUBBER_DEV_ORIGIN: DEV_ORIGIN,
        HUBBER_WORKSPACE: dir,
        ANTHROPIC_BASE_URL: ROUTER,
        ANTHROPIC_AUTH_TOKEN: TOKEN,
      });

      await expectRefusal(server, port, {
        code: 3,
        stderr: refusal(
          `plik konfiguracji "${join(dir, "workspace.json")}" podaje endpoint ${ROUTER}, a baza "${database}" jest przypięta do ${PUBLIC_API}. Wiążący jest adres zapisany w bazie przy utworzeniu workspace'u: przywróć go w pliku konfiguracji albo przywróć plik bazy, który do tego workspace'u należy.`,
          names.router,
        ),
      });
      expect(readdirSync(dir).sort()).toEqual(LAYOUT);
    });

    // The controls: without them the refusals above could come from anything.
    it.each<[keyof typeof created, string, string, string, Record<string, string>, string | undefined]>([
      [
        "router",
        "its endpoint in another spelling",
        "takes its token",
        ROUTER,
        { ANTHROPIC_BASE_URL: "https://ROUTER.corp.example:443/llm/", ANTHROPIC_AUTH_TOKEN: TOKEN },
        "ANTHROPIC_AUTH_TOKEN",
      ],
      // The token of an environment that names no endpoint belongs to the public API.
      ["router", "no endpoint", "leaves its token alone", ROUTER, { ANTHROPIC_AUTH_TOKEN: TOKEN }, undefined],
      ["development", "no endpoint", "takes its key", PUBLIC_API, { ANTHROPIC_API_KEY: TOKEN }, "ANTHROPIC_API_KEY"],
    ])(
      "opens the %s workspace where the environment names %s, and %s",
      async (workspace, _named, _does, pin, env, variable) => {
        const dir = copyOf(workspace);

        const server = await launchDev({ HUBBER_WORKSPACE: dir, ...env });

        expect(await stop(server)).toEqual({ code: 0, signal: null });
        expect(server.stdout()).toContain(`Workspace „${names[workspace]}”: katalog "${dir}", endpoint ${pin}.\n`);
        if (variable === undefined) expect(server.stdout()).not.toContain("Poświadczenia:");
        else expect(server.stdout()).toContain(`Poświadczenia: zmienna ${variable}.\n`);
        expect(readdirSync(dir).sort()).toEqual(LAYOUT);
      },
    );
  });
});
