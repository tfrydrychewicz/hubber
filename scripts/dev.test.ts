import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { busyPortMessage, listenerOf } from "../src/server/busy-port.ts";
import { contentSecurityPolicy } from "../src/server/security-headers.ts";
import {
  type Exit,
  freePorts,
  type OccupiedPort,
  occupyPort,
  type SpawnedNode,
  spawnNode,
  TEST_WORKSPACE,
} from "../src/server/testing.ts";
import { createTestWorkspace, type TestWorkspace } from "../src/server/workspace/testing.ts";

const HOST = "127.0.0.1";
const READY = "Hubber działa w trybie deweloperskim";
// Longer than the 15 s the runner gives its own children, so that a failed start is reported
// together with what the runner had to say about it.
const START_TIMEOUT_MS = 20_000;
// Longer than the runner's grace period of 5 s.
const STOP_TIMEOUT_MS = 10_000;

// Loaded into the runner ahead of its own code. Stands in for another program that takes a
// port in the moment after the runner has found it free: the probe that the runner closes is
// replaced by a listener before the runner learns the outcome of its check. The ports to take
// are named in the address this module is loaded from.
const TAKE_PORTS_AFTER_CHECK = `import net from "node:net";
const ports = new Set(new URL(import.meta.url).searchParams.getAll("port").map(Number));
const { close } = net.Server.prototype;
net.Server.prototype.close = function (callback) {
  const port = this.address()?.port;
  if (!ports.delete(port)) return close.call(this, callback);
  return close.call(this, () => net.createServer().listen(port, "127.0.0.1", callback));
};
`;

// Loaded into the runner ahead of its own code. Every wait of a second or more passes twenty
// times faster, so that no test has to sit through the grace period.
const FAST_CLOCK = `const { setTimeout: wait } = globalThis;
globalThis.setTimeout = (callback, ms, ...args) => wait(callback, ms >= 1000 ? ms / 20 : ms, ...args);
`;

// Loaded into the runner ahead of its own code. On SIGUSR2 the runner's clock jumps an hour
// ahead, so that the time it gives its servers is over without a test sitting through it.
// The jump comes a moment after the signal, and that moment is longer than the tenth of a
// second between two looks of the runner at its servers: whatever was up when the signal came
// has been seen by then, however slowly the runner gets to run.
const JUMP_AHEAD = `const { now } = Date;
let ahead = 0;
Date.now = () => now() + ahead;
process.on("SIGUSR2", () => setTimeout(() => (ahead = 3_600_000), 150));
`;

// Loaded into every process of a session; it acts in the one that runs the script named in
// the address this module is loaded from. That script is kept from starting until the
// session's other server has been answering for a moment, by which time a runner that took an
// open port for a running server has called the session ready (it looks ten times a second).
// With "answer" in the address, the script's own port answers meanwhile and stops answering
// before the script starts, which is what Vite's port does while Vite tries it out.
// Without "after" in the address there is no other server to wait for, and the script never
// starts: its process stays, like a server that hangs on its way up.
// The line printed first tells a test that the right server was held back. To the runner it
// is a line from that server which is not its address, like the ones Vite prints when it has
// something to say before it listens. Ports are named by the variables that hold them.
const STARTING_LATE = "Starting late.";
const START_LATE = `import net from "node:net";
const options = new URL(import.meta.url).searchParams;
const portIn = (variable) => Number(process.env[variable]);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const answers = (port) =>
  new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("error", () => resolve(false));
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
  });
if (process.argv[1]?.endsWith(options.get("script"))) {
  console.log("${STARTING_LATE}");
  const early = options.has("answer") ? net.createServer((socket) => socket.destroy()) : undefined;
  if (early) await new Promise((resolve) => early.listen(portIn(options.get("answer")), "127.0.0.1", resolve));
  while (!options.has("after") || !(await answers(portIn(options.get("after"))))) await pause(20);
  await pause(300);
  if (early) await new Promise((resolve) => early.close(resolve));
}
`;

// Loaded into the runner ahead of its own code. The runner then says so on stderr whenever it
// starts one of its servers, which run on the Node that runs the runner. The one other program
// it starts is the guard that stops the servers should the runner be killed.
const STARTED_A_SERVER = "Started a server.";
const STARTED_THE_GUARD = "Started the guard.";
const REPORT_STARTS = `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const { spawn } = childProcess;
childProcess.spawn = (file, ...rest) => {
  console.error(file === process.execPath ? "${STARTED_A_SERVER}" : "${STARTED_THE_GUARD}");
  return spawn(file, ...rest);
};
syncBuiltinESMExports();
`;

// Loaded into every process of a session. Each says which of the SDK's variables it was started
// with, and says so before its own code runs: the API server takes them out of its environment
// first thing. The runner passes the line on under the name of the server that printed it.
const SDK_VARIABLES = "SDK variables at start:";
const REPORT_SDK_VARIABLES = `import { isMainThread } from "node:worker_threads";
const names = Object.keys(process.env).filter((name) => name.startsWith("ANTHROPIC_"));
if (isMainThread) console.log(\`${SDK_VARIABLES} \${JSON.stringify(names.sort())}\`);
`;

// The two servers of a session: the script each one runs, and the variable that holds its port.
const SERVERS = {
  api: { script: "src/server/main.ts", port: "HUBBER_PORT" },
  web: { script: "node_modules/vite/bin/vite.js", port: "HUBBER_WEB_PORT" },
};

interface RunnerOptions {
  /** Options for the Node that runs the runner; its servers do not get them. */
  nodeArgs?: string[];
  /** Added to the runner's environment, which already names the workspace of this file. */
  env?: Record<string, string>;
}

interface Session extends SpawnedNode {
  apiPort: number;
  webPort: number;
}

let started: SpawnedNode | undefined;
// Once the runner is gone its children belong to launchd and cannot be found through it,
// so the ones seen while it was alive are kept for afterEach.
let seen: number[] = [];
let occupied: OccupiedPort | undefined;
let fakeApi: Server | undefined;

let workDir: string;
let takePortsAfterCheck: string;
let fastClock: string;
let jumpAhead: string;
let startLate: string;
let reportStarts: string;
let reportSdkVariables: string;
// The throwaway workspace that every session of this file opens unless the test names another.
let workspace: TestWorkspace;
// Stands in for the home directory of the owner, for a session that is given one. It holds nothing.
let emptyHome: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "hubber-dev-"));
  takePortsAfterCheck = join(workDir, "take-ports-after-check.mjs");
  fastClock = join(workDir, "fast-clock.mjs");
  jumpAhead = join(workDir, "jump-ahead.mjs");
  startLate = join(workDir, "start-late.mjs");
  reportStarts = join(workDir, "report-starts.mjs");
  reportSdkVariables = join(workDir, "report-sdk-variables.mjs");
  writeFileSync(takePortsAfterCheck, TAKE_PORTS_AFTER_CHECK);
  writeFileSync(fastClock, FAST_CLOCK);
  writeFileSync(jumpAhead, JUMP_AHEAD);
  writeFileSync(startLate, START_LATE);
  writeFileSync(reportStarts, REPORT_STARTS);
  writeFileSync(reportSdkVariables, REPORT_SDK_VARIABLES);
  workspace = createTestWorkspace();
  emptyHome = join(workDir, "home");
  mkdirSync(emptyHome);
});

afterAll(() => {
  workspace.remove();
  rmSync(workDir, { recursive: true, force: true });
});

afterEach(async () => {
  // Whatever the runner did or failed to do, no test may leave servers on the developer's machine.
  const pid = started?.child.pid;
  const live = pid === undefined ? [] : [...descendants(pid), pid];
  for (const leftover of [...seen, ...live]) {
    try {
      process.kill(leftover, "SIGKILL");
    } catch {
      // Already gone, which is the expected case.
    }
  }
  started = undefined;
  seen = [];
  await occupied?.release();
  occupied = undefined;
  fakeApi?.closeAllConnections();
  fakeApi?.close();
  fakeApi = undefined;
});

/** Node options that make the runner lose the given ports to someone else right after it has checked them. */
function takenAfterCheck(...ports: number[]): string[] {
  const standIn = pathToFileURL(takePortsAfterCheck);
  for (const port of ports) standIn.searchParams.append("port", String(port));
  return ["--import", standIn.href];
}

/**
 * An environment in which one server of the session starts only after the other has come up,
 * with its port answering in the meantime if asked for; see START_LATE.
 */
function startingLate(server: keyof typeof SERVERS, { answeringEarly = false } = {}): Record<string, string> {
  const { script, port } = SERVERS[server];
  const standIn = pathToFileURL(startLate);
  standIn.searchParams.set("script", script);
  standIn.searchParams.set("after", SERVERS[server === "api" ? "web" : "api"].port);
  if (answeringEarly) standIn.searchParams.set("answer", port);
  return { NODE_OPTIONS: `--import=${standIn.href}` };
}

/** An environment in which one server of the session never starts; see START_LATE. */
function neverStarting(server: keyof typeof SERVERS): Record<string, string> {
  const standIn = pathToFileURL(startLate);
  standIn.searchParams.set("script", SERVERS[server].script);
  return { NODE_OPTIONS: `--import=${standIn.href}` };
}

// spawnNode() builds the environment from scratch: no HOME and none of the developer's own
// variables. So a session started here opens the workspace it is given or none at all.
function startRunner(
  apiPort: number | string,
  webPort: number | string,
  { nodeArgs = [], env = {} }: RunnerOptions = {},
): SpawnedNode {
  started = spawnNode("scripts/dev.ts", {
    nodeArgs,
    env: { ...workspace.env, ...env, HUBBER_PORT: String(apiPort), HUBBER_WEB_PORT: String(webPort) },
  });
  return started;
}

/**
 * Waits until the runner has written what the caller looks for. A runner that has ended will
 * not write any more, so the wait ends with it, and a wait in vain fails with everything the
 * runner did write.
 */
async function written(runner: SpawnedNode, what: string, isThere: (stdout: string) => boolean): Promise<void> {
  let over = false;
  void runner.exited.then(() => {
    over = true;
  });
  await vi
    .waitFor(() => expect(isThere(runner.stdout()) || over).toBe(true), { timeout: START_TIMEOUT_MS, interval: 20 })
    .catch(() => {});
  if (!isThere(runner.stdout())) throw new Error(`No ${what}.\n${runner.stdout()}${runner.stderr()}`);
}

/** Starts the runner on two free ports and resolves once it has reported both servers up. */
async function startSession(options?: RunnerOptions): Promise<Session> {
  const [apiPort, webPort] = await freePorts(2);
  const runner = startRunner(apiPort, webPort, options);
  await written(runner, "ready line", (stdout) => stdout.includes(READY));
  seen = descendants(pidOf(runner));
  return { ...runner, apiPort, webPort };
}

// Vite on its own, started the way the runner starts it.
function startVite(apiPort: number, webPort: number): SpawnedNode {
  started = spawnNode("node_modules/vite/bin/vite.js", {
    env: { HUBBER_PORT: String(apiPort), HUBBER_WEB_PORT: String(webPort) },
  });
  return started;
}

/** How the process ended. Rejects with what it printed if it is still running after the time allowed. */
function ended({ exited, stdout, stderr }: SpawnedNode, within = STOP_TIMEOUT_MS): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Still running after ${within} ms.\n${stdout()}${stderr()}`)),
      within,
    );
    void exited.then((exit) => {
      clearTimeout(timer);
      resolve(exit);
    });
  });
}

/**
 * How a runner ended that was expected to end by itself. What it started cannot be found
 * through it once it is gone, so its processes are looked up while it runs and kept for
 * afterEach, until the whole session has been seen: the watcher, the server it runs, Vite, and
 * the guard.
 */
function endedByItself(runner: SpawnedNode, within?: number): Promise<Exit> {
  const pid = pidOf(runner);
  const lookUp = setInterval(() => {
    const running = descendants(pid);
    if (running.length > seen.length) seen = running;
    if (seen.length >= 4) clearInterval(lookUp);
  }, 10);
  return ended(runner, within).finally(() => clearInterval(lookUp));
}

function run(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function pidOf({ child }: SpawnedNode): number {
  if (child.pid === undefined) throw new Error("The process did not start.");
  return child.pid;
}

function children(pid: number): number[] {
  try {
    return run("pgrep", ["-P", String(pid)])
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    // pgrep exits with 1 when the process has no children.
    return [];
  }
}

function descendants(pid: number): number[] {
  return children(pid).flatMap((child) => [child, ...descendants(child)]);
}

/** The command line of a process, or nothing when it is gone. */
function commandOf(pid: number): string {
  try {
    return run("ps", ["-o", "command=", "-p", String(pid)]).trim();
  } catch {
    // ps exits with 1 when there is no such process.
    return "";
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function viteOf({ webPort }: Session): number {
  const vite = listenerOf(webPort);
  if (vite === undefined) throw new Error("Nothing listens on the web port.");
  return vite.pid;
}

/** Every address on which the port is open, as lsof writes them: "127.0.0.1:5173", "[::1]:5173", "*:5173". */
function listenAddresses(port: number): string[] {
  try {
    return run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"])
      .split("\n")
      .filter((line) => line.startsWith("n"))
      .map((line) => line.slice(1));
  } catch {
    // lsof exits with 1 when nothing listens there.
    return [];
  }
}

async function listen(server: Server, port: number): Promise<number> {
  await once(server.listen(port, HOST), "listening");
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await once(server.close(), "close");
}

// Above the two waits together, so that a slow run reports what the process printed and not a bare test timeout.
const TEST_TIMEOUT_MS = START_TIMEOUT_MS + STOP_TIMEOUT_MS + 5_000;

describe("scripts/dev.ts", { timeout: TEST_TIMEOUT_MS }, () => {
  it("serves the web app and proxies the API, behind the protections of the dev server", async () => {
    const session = await startSession();
    const { apiPort, webPort } = session;
    const webOrigin = `http://${HOST}:${webPort}`;

    const health = await fetch(`${webOrigin}/api/health`);
    expect(await health.json()).toEqual({ status: "ok" });
    // The session runs on the workspace it was handed, and the page learns of it through the proxy.
    const openedLine = `[api] Workspace „${TEST_WORKSPACE.name}”: katalog "${workspace.dir}"`;
    await written(session, "line about the workspace", (stdout) => stdout.includes(openedLine));
    const opened = await fetch(`${webOrigin}/api/workspace`);
    expect(await opened.json()).toEqual({
      name: TEST_WORKSPACE.name,
      endpointOrigin: new URL(TEST_WORKSPACE.endpoint).origin,
    });
    // The API is its root and what lies below it. The answer is the API server's own for a
    // route it does not have.
    for (const root of ["/api", "/api?x=1"]) {
      const apiRoot = await fetch(`${webOrigin}${root}`);
      expect(apiRoot.status, root).toBe(404);
      expect(await apiRoot.json()).toMatchObject({ error: "not_found" });
    }
    // What merely begins with the same letters is a route of the web app, as in production.
    for (const route of ["/apix", "/api-docs", "/api.json"]) {
      const appRoute = await fetch(`${webOrigin}${route}`);
      expect(appRoute.status, route).toBe(200);
      expect(await appRoute.text(), route).toContain('<div id="root">');
    }

    // Another loopback origin on purpose: those are the only ones Vite's default CORS policy answers.
    const page = await fetch(`${webOrigin}/`, { headers: { origin: `http://${HOST}:9` } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="root">');
    expect(page.headers.get("content-security-policy")).toBe(contentSecurityPolicy({ dev: true }));
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
    // A file of this package that lies outside src/.
    const outside = await fetch(`${webOrigin}/@fs${new URL("../package.json", import.meta.url).pathname}`);
    expect(outside.status).toBe(403);
    // A write as the page sends it. No POST route exists yet; 403 would mean the proxy rewrote Host.
    const write = await fetch(`${webOrigin}/api/health`, {
      method: "POST",
      headers: { origin: webOrigin },
      body: "{}",
    });
    expect(write.status).not.toBe(403);

    // Vite starts the developer's editor for whoever requests this address. The file does not
    // exist, so nothing is started here even if the guard in vite.config.ts goes missing.
    const openInEditor = (site?: string) =>
      fetch(`${webOrigin}/__open-in-editor?file=no-such-file`, {
        headers: site === undefined ? {} : { "sec-fetch-site": site },
      });
    // Only the dev page itself may ask. "same-site" is what a page on any other port of this
    // address sends, "none" comes from the address bar, and no header at all from outside a browser.
    for (const site of ["cross-site", "same-site", "none", undefined]) {
      expect((await openInEditor(site)).status, `Sec-Fetch-Site: ${site ?? "not sent"}`).toBe(403);
    }
    expect((await openInEditor("same-origin")).status).toBe(200);

    // NFR-3 holds for the dev server too: this one address, so neither "::" nor "0.0.0.0", nor "::1" beside it.
    expect(listenAddresses(webPort)).toEqual([`${HOST}:${webPort}`]);

    // A second start on the same API port has to name the process whose end stops this session
    // as a whole: the runner's own child, not the server which that child would start again.
    const [watcher] = children(pidOf(session)).filter((pid) => commandOf(pid).includes(" --watch "));
    expect(watcher).toBeDefined();
    expect(busyPortMessage(apiPort, "HUBBER_PORT")).toContain(`zatrzymasz go poleceniem "kill ${watcher}"`);
  });

  // What a terminal sends for Ctrl-C, for Ctrl-\ and when it is closed, and what "kill" sends.
  it.each(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const)(
    "stops what it started and exits with code 0 on %s",
    async (signal) => {
      const session = await startSession();
      // The watcher, the server it runs, and Vite.
      expect(seen.length).toBeGreaterThanOrEqual(3);

      const stoppedAt = performance.now();
      session.child.kill(signal);

      // Code 0: nothing had to be killed at the end of the grace period.
      expect(await ended(session)).toEqual({ code: 0, signal: null });
      // And well inside that period, not just before it ran out.
      expect(performance.now() - stoppedAt).toBeLessThan(3000);
      // The server's own line: it was asked to stop. A runner that kills outright is just as quick.
      expect(session.stdout()).toContain("Zamykanie serwera…");
      expect(seen.filter(isAlive)).toEqual([]);
      expect(listenerOf(session.apiPort)).toBeUndefined();
      expect(listenerOf(session.webPort)).toBeUndefined();
      // The server closed its workspace: no file of an open database is left beside the three entries.
      expect(readdirSync(workspace.dir).sort()).toEqual(["files", "hubber.sqlite", "workspace.json"]);
    },
  );

  // No handler of the runner sees this signal. What stops the servers is the guard it left behind.
  it("leaves no server behind when it is killed outright", async () => {
    const session = await startSession();
    // The watcher, the server it runs, Vite, and the guard.
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen.filter((pid) => commandOf(pid).includes("hubber-dev-guard"))).toHaveLength(1);

    session.child.kill("SIGKILL");

    expect(await ended(session)).toEqual({ code: null, signal: "SIGKILL" });
    // Not at once: the servers are asked to stop, and whoever outlives its parent is cleared away
    // by launchd a moment later.
    await vi.waitFor(() => expect(seen.filter(isAlive)).toEqual([]), { timeout: STOP_TIMEOUT_MS, interval: 50 });
    expect(listenerOf(session.apiPort)).toBeUndefined();
    expect(listenerOf(session.webPort)).toBeUndefined();
  });

  it("stops everything when one of the two processes dies", async () => {
    const session = await startSession();

    process.kill(viteOf(session), "SIGKILL");

    expect(await ended(session)).toEqual({ code: 1, signal: null });
    expect(session.stdout()).toContain("Proces web zakończył się nieoczekiwanie (SIGKILL)");
    expect(seen.filter(isAlive)).toEqual([]);
    expect(listenerOf(session.apiPort)).toBeUndefined();
  });

  it("kills what has not stopped by the end of the grace period, and exits with code 1", async () => {
    const session = await startSession({ nodeArgs: ["--import", pathToFileURL(fastClock).href] });
    // A suspended process cannot act on SIGTERM. SIGKILL ends it all the same.
    process.kill(viteOf(session), "SIGSTOP");

    session.child.kill("SIGTERM");

    expect(await ended(session)).toEqual({ code: 1, signal: null });
    expect(session.stdout()).toContain("Procesy nie zakończyły się w ciągu 5 s. Wymuszam zamknięcie.");
    // Not at once: a process killed together with its parent is cleared away by launchd a moment later.
    await vi.waitFor(() => expect(seen.filter(isAlive)).toEqual([]));
    expect(listenerOf(session.webPort)).toBeUndefined();
  });

  it("calls itself ready only once Vite has said that it listens, however early its port answers", async () => {
    const session = await startSession({ env: startingLate("web", { answeringEarly: true }) });
    const address = `http://${HOST}:${session.webPort}/`;

    expect(session.stdout()).toContain(`[web] ${STARTING_LATE}`);
    // By the time of the ready line Vite had given its address, and it serves the first request.
    expect(session.stdout().split(READY)[0]).toContain(address);
    expect((await fetch(address)).status).toBe(200);
  });

  it("recognises Vite's address in the colours that a terminal gets", async () => {
    // The runner asks its servers for colours when it writes to a terminal. Here the test does the asking.
    const session = await startSession({ env: { FORCE_COLOR: "1" } });
    const address = `http://${HOST}:${session.webPort}/`;

    // Vite sets the port in bold, so the address arrives in two pieces.
    expect(session.stdout()).not.toContain(address);
    expect(stripVTControlCharacters(session.stdout())).toContain(address);
  });

  // In the next two tests the server whose port was taken starts late. While the other server
  // is up and the taken port answers, a runner that took an open port for a running server
  // would call the session ready. The runner therefore gets the time of a start and a stop.
  it("stops, without ever calling itself ready, when the API port is taken right after its check", async () => {
    const [apiPort, webPort] = await freePorts(2);

    const runner = startRunner(apiPort, webPort, { nodeArgs: takenAfterCheck(apiPort), env: startingLate("api") });

    expect(await endedByItself(runner, START_TIMEOUT_MS + STOP_TIMEOUT_MS)).toEqual({ code: 1, signal: null });
    expect(runner.stdout()).toContain(`[api] ${STARTING_LATE}`);
    expect(runner.stdout()).not.toContain(READY);
    // The server's own message. The port is held by the runner here, because it loaded the stand-in.
    expect(runner.stderr()).toContain(`Port ${apiPort} na ${HOST} jest zajęty przez proces ${pidOf(runner)}`);
    expect(runner.stdout()).toContain("Serwer API nie wystartował. Zatrzymuję pozostałe.");
    expect(listenerOf(webPort)).toBeUndefined();
  });

  it("stops, without ever calling itself ready, when the web port is taken right after its check", async () => {
    const [apiPort, webPort] = await freePorts(2);

    const runner = startRunner(apiPort, webPort, { nodeArgs: takenAfterCheck(webPort), env: startingLate("web") });

    expect(await endedByItself(runner, START_TIMEOUT_MS + STOP_TIMEOUT_MS)).toEqual({ code: 1, signal: null });
    expect(runner.stdout()).toContain(`[web] ${STARTING_LATE}`);
    expect(runner.stdout()).not.toContain(READY);
    // Vite's own message, and the runner's about the server that gave up.
    expect(runner.stderr()).toContain(`Port ${webPort} is already in use`);
    expect(runner.stdout()).toContain("Proces web zakończył się nieoczekiwanie (kod 1). Zatrzymuję pozostałe.");
    expect(listenerOf(apiPort)).toBeUndefined();
  });

  // The runner gives its servers 15 s. In the next two tests one of them never starts, and the
  // runner's clock jumps past that time once the other one is up: when its wait is over, the
  // runner has one server and has not seen the other.
  it.each([
    ["api", "Serwer API"],
    ["web", "Vite"],
  ] as const)(
    "says so when the %s server has not started in time, without calling itself ready",
    async (missing, name) => {
      const [apiPort, webPort] = await freePorts(2);
      const heldBack = `[${missing}] ${STARTING_LATE}`;
      const otherAddress = `http://${HOST}:${missing === "api" ? webPort : apiPort}`;

      const runner = startRunner(apiPort, webPort, {
        nodeArgs: ["--import", pathToFileURL(jumpAhead).href],
        env: neverStarting(missing),
      });
      // Both in lines that the runner has passed on: one server is held back for good, and the
      // runner knows by now that the other one is up.
      await written(runner, "line of the server held back", (stdout) => stdout.includes(heldBack));
      await written(runner, "address of the other server", (stdout) => stdout.includes(otherAddress));
      runner.child.kill("SIGUSR2");
      // The first line of the runner's own is what it makes of its two servers, whichever line that is.
      const verdict = () => /^\[dev\] (.*)\n/m.exec(runner.stdout())?.[1];
      await written(runner, "line of the runner's own", () => verdict() !== undefined);
      seen = descendants(pidOf(runner));

      expect(verdict()).toBe(`${name} nie wystartował w ciągu 15 s. Sprawdź komunikaty powyżej.`);
      // The session goes on: the server may be slow, or start with the next saved file.
      runner.child.kill("SIGTERM");
      expect(await ended(runner)).toEqual({ code: 0, signal: null });
      expect(runner.stdout()).not.toContain(READY);
      expect(seen.filter(isAlive)).toEqual([]);
    },
  );

  it.each(["HUBBER_PORT", "HUBBER_WEB_PORT"] as const)(
    "refuses to start when %s names a busy port, and names the process that holds it",
    async (variable) => {
      occupied = await occupyPort();
      const [freePort] = await freePorts(1);
      const [apiPort, webPort] = variable === "HUBBER_PORT" ? [occupied.port, freePort] : [freePort, occupied.port];

      const runner = startRunner(apiPort, webPort);

      expect(await ended(runner)).toEqual({ code: 1, signal: null });
      expect(runner.stderr()).toContain(`Port ${occupied.port} na ${HOST} jest zajęty przez proces ${process.pid}`);
      expect(runner.stderr()).toContain(`zmienną ${variable}.`);
      // Found by the runner's own check: neither child was started to find it out.
      expect(runner.stdout()).toBe("");
      expect(listenerOf(freePort)).toBeUndefined();
    },
  );

  // A server that cannot open its workspace says why and ends, while "node --watch" stays beside
  // it and waits for a saved file. In the next two tests the runner has only the server's
  // message to go by.
  it.each([
    [
      "is not where HUBBER_WORKSPACE says",
      () => ({ HUBBER_WORKSPACE: join(workDir, "no-workspace-here") }),
      () =>
        `Nie można otworzyć workspace'u: katalog "${join(workDir, "no-workspace-here")}" ze zmiennej HUBBER_WORKSPACE nie istnieje.`,
    ],
    [
      "is pinned to another endpoint than the environment names",
      () => ({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }),
      () =>
        `Nie można otworzyć workspace'u „${TEST_WORKSPACE.name}”: jest przypięty do endpointu ${TEST_WORKSPACE.endpoint}, a zmienna ANTHROPIC_BASE_URL wskazuje https://api.anthropic.com.`,
    ],
  ])(
    "stops at once, with the server's message and code 1, when the workspace %s",
    async (_why, environment, refusal) => {
      const [apiPort, webPort] = await freePorts(2);
      const startedAt = performance.now();

      const runner = startRunner(apiPort, webPort, {
        nodeArgs: ["--import", pathToFileURL(reportStarts).href],
        env: environment(),
      });

      expect(await endedByItself(runner)).toEqual({ code: 1, signal: null });
      // Far below the 15 s the runner gives its servers: it did not sit out a start that cannot come.
      expect(performance.now() - startedAt).toBeLessThan(7_500);
      // Both servers were started: whether a workspace opens is for the API server to find out.
      expect(runner.stderr().split(STARTED_A_SERVER)).toHaveLength(3);
      expect(runner.stderr().split(STARTED_THE_GUARD)).toHaveLength(2);
      expect(runner.stderr()).toContain(`[api] ${refusal()}`);
      expect(runner.stdout()).toContain("Serwer API nie wystartował. Zatrzymuję pozostałe.");
      expect(runner.stdout()).not.toContain(READY);
      expect(seen.filter(isAlive)).toEqual([]);
      expect(listenerOf(apiPort)).toBeUndefined();
      expect(listenerOf(webPort)).toBeUndefined();
    },
  );

  it.each([
    [
      "is not a full path",
      () => ({ HUBBER_WORKSPACE: "dane/praca" }),
      'Niepoprawna wartość HUBBER_WORKSPACE: "dane/praca". Podaj pełną ścieżkę katalogu workspace\'u (od "/" albo "~/").',
    ],
    [
      // The runner of a test has no HOME, and so no default place to fall back on.
      "names nothing and there is no HOME",
      () => ({ HUBBER_WORKSPACE: "" }),
      "Nie wskazano workspace'u. Ustaw zmienną HUBBER_WORKSPACE na katalog workspace'u; bez zmiennej HOME nie ma katalogu domyślnego.",
    ],
    [
      // What "npm run dev" finds in an agent's shell once an export of the command before is
      // gone: the owner's HOME, whose default place is the owner's own workspace.
      "names nothing in the session of a coding agent, although there is a HOME",
      () => ({ HUBBER_WORKSPACE: "", HOME: emptyHome, CLAUDECODE: "1" }),
      "Nie wskazano workspace'u. Ustaw zmienną HUBBER_WORKSPACE na katalog workspace'u; w sesji agenta (zmienna CLAUDECODE) nie ma katalogu domyślnego.",
    ],
  ])("refuses to start when HUBBER_WORKSPACE %s, with code 2", async (_what, environment, message) => {
    const [apiPort, webPort] = await freePorts(2);

    const runner = startRunner(apiPort, webPort, {
      nodeArgs: ["--import", pathToFileURL(reportStarts).href],
      env: environment(),
    });

    expect(await endedByItself(runner)).toEqual({ code: 2, signal: null });
    // The runner's own line and no other. A start of either server would show here, as it does
    // in the tests above: the runner found this out before it started anything.
    expect(runner.stderr()).toBe(`${message}\n`);
    expect(runner.stdout()).toBe("");
    expect(listenerOf(apiPort)).toBeUndefined();
    expect(listenerOf(webPort)).toBeUndefined();
    // Nothing was looked for, let alone created, under the home directory.
    expect(readdirSync(emptyHome)).toEqual([]);
  });

  it("opens the workspace that the session of a coding agent names", async () => {
    const session = await startSession({
      env: { HOME: emptyHome, CLAUDECODE: "1", AI_AGENT: "claude-code_2-1-295_agent" },
    });

    const openedLine = `[api] Workspace „${TEST_WORKSPACE.name}”: katalog "${workspace.dir}"`;
    await written(session, "line about the workspace", (stdout) => stdout.includes(openedLine));
    expect(readdirSync(emptyHome)).toEqual([]);
  });

  it("hands the SDK's variables to the API server and keeps them from Vite", async () => {
    // Invented, and sent nowhere: nothing in a session calls a model.
    const sdkVariables = {
      ANTHROPIC_API_KEY: "invented-key-for-tests",
      ANTHROPIC_AUTH_TOKEN: "invented-token-for-tests",
      ANTHROPIC_BASE_URL: TEST_WORKSPACE.endpoint,
      ANTHROPIC_CUSTOM_HEADERS: "x-team: alfa",
    };

    const session = await startSession({
      env: { ...sdkVariables, NODE_OPTIONS: `--import=${pathToFileURL(reportSdkVariables).href}` },
    });
    // The server's own word that it read them: the address matched its pin, and the token was found.
    const credential = "[api] Poświadczenia: zmienna ANTHROPIC_AUTH_TOKEN.";
    await written(session, "line about the credential", (stdout) => stdout.includes(credential));

    /** What was reported under a prefix, each line once: a server can be more than one process. */
    const reports = (prefix: string): string[] => {
      const lines = session.stdout().split("\n");
      return [...new Set(lines.filter((line) => line.startsWith(`${prefix}${SDK_VARIABLES}`)))];
    };
    const all = `${SDK_VARIABLES} ${JSON.stringify(Object.keys(sdkVariables).sort())}`;
    // The runner was started with all four, and the API server got them from it.
    expect(reports("")).toEqual([all]);
    expect(reports("[api] ")).toEqual([`[api] ${all}`]);
    // Vite got the rest of the environment, the stand-in included, and none of the four.
    expect(reports("[web] ")).toEqual([`[web] ${SDK_VARIABLES} []`]);
  });

  it("refuses to start when both variables name the same port, with code 2", async () => {
    const [port] = await freePorts(1);

    const runner = startRunner(port, port);

    expect(await ended(runner)).toEqual({ code: 2, signal: null });
    expect(runner.stderr()).toContain(`HUBBER_PORT i HUBBER_WEB_PORT wskazują ten sam port (${port}).`);
    expect(runner.stdout()).toBe("");
    expect(listenerOf(port)).toBeUndefined();
  });

  // One value is enough here: which values are refused is the business of parsePort() and its tests.
  it("reports a port it cannot use in one line, without a stack trace, and exits with code 2", async () => {
    const [apiPort] = await freePorts(1);

    const runner = startRunner(apiPort, "abc");

    expect(await ended(runner)).toEqual({ code: 2, signal: null });
    expect(runner.stderr()).toContain('Niepoprawna wartość HUBBER_WEB_PORT: "abc".');
    expect(runner.stderr()).not.toMatch(/^\s+at /m);
    expect(runner.stdout()).toBe("");
    expect(listenerOf(apiPort)).toBeUndefined();
  });
});

// What vite.config.ts arranges for the cases in which the runner is not there to help: an API
// server that is down, and a port that is taken although the runner found it free.
describe("the Vite dev server on its own", { timeout: TEST_TIMEOUT_MS }, () => {
  it("reports an API outage once, however many requests fail, and drops an event stream meanwhile", async () => {
    let answering = true;
    const api = createServer((req, res) => (answering ? res.end("ok") : req.socket.resetAndDestroy()));
    fakeApi = api;
    const apiPort = await listen(api, 0);
    const [webPort] = await freePorts(1);
    const vite = startVite(apiPort, webPort);
    const health = `http://${HOST}:${webPort}/api/health`;
    // Up when Vite says so, which is the sign the runner goes by.
    await vi.waitFor(() => expect(vite.stdout()).toContain(`http://${HOST}:${webPort}/`), {
      timeout: START_TIMEOUT_MS,
      interval: 20,
    });
    expect((await fetch(health)).status).toBe(200);

    await close(api);
    expect((await fetch(health)).status).toBe(502);
    expect((await fetch(health)).status).toBe(502);
    // EventSource gives up for good on an answer like that. A dropped connection makes it try again.
    const events = fetch(`http://${HOST}:${webPort}/api/events`, { headers: { accept: "text/event-stream" } });
    await expect(events).rejects.toThrow();
    // Still the same outage, but a different failure: the API takes a request and drops the
    // connection. Only refused connections are left out; this is reported as it comes.
    answering = false;
    await listen(api, apiPort);
    expect((await fetch(health)).status).toBe(502);
    await close(api);
    answering = true;

    await listen(api, apiPort);
    expect((await fetch(health)).status).toBe(200);
    await close(api);
    expect((await fetch(health)).status).toBe(502);

    // Once Vite has ended, everything it wrote has been read: one report for each of the two
    // outages, and one for the dropped connection.
    vite.child.kill("SIGTERM");
    await ended(vite);
    expect(vite.stderr().match(/ECONNREFUSED/g) ?? []).toHaveLength(2);
    expect(vite.stderr().match(/ECONNRESET/g) ?? []).toHaveLength(1);
  });

  it("gives up on a taken port instead of moving to the next one", async () => {
    occupied = await occupyPort();
    const [apiPort] = await freePorts(1);

    const vite = startVite(apiPort, occupied.port);

    expect(await ended(vite)).toEqual({ code: 1, signal: null });
    expect(vite.stderr()).toContain(`Port ${occupied.port} is already in use`);
  });
});
