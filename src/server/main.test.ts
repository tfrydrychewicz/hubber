import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Exit, freePorts, type OccupiedPort, occupyPort, rawGet, type SpawnedNode, spawnNode } from "./testing.ts";

const MAIN = join(import.meta.dirname, "main.ts");
const RUN_SERVER = join(import.meta.dirname, "run-server.ts");
const HOST = "127.0.0.1";
// Any allowed value puts the server in development mode, where it needs no built web app.
const DEV_ORIGIN = "http://127.0.0.1:5173";
const START_TIMEOUT_MS = 10_000;
const INDEX_HTML = '<!doctype html><html lang="pl"><head><title>Hubber</title></head><body></body></html>';

// Loaded before the entry point. It sends the process a signal from inside the call that
// prints the first line: no one who waits for that line can react any earlier.
const SIGNAL_AT_FIRST_LINE = `const { log } = console;
console.log = (...args) => {
  console.log = log;
  log(...args);
  process.kill(process.pid, "SIGTERM");
};
`;

interface Launched extends SpawnedNode {
  /** Resolves with the address the server printed. Rejects if the process ends first. */
  url: Promise<string>;
}

interface LaunchOptions {
  /** What to start in place of main.ts. */
  script?: string;
  nodeArgs?: string[];
}

const children: ChildProcess[] = [];
const sockets: Socket[] = [];
let taken: OccupiedPort | undefined;

let workDir: string;
let webRoot: string;
let productionEntry: string;
let signalAtFirstLine: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "hubber-main-"));
  webRoot = join(workDir, "web");
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, "index.html"), INDEX_HTML);

  // Stands in for main.ts, which does nothing but name the directory of the built web app.
  // With a directory of its own, this one starts the production mode without the real build.
  productionEntry = join(workDir, "production.mjs");
  writeFileSync(
    productionEntry,
    `import { runServer } from ${JSON.stringify(pathToFileURL(RUN_SERVER).href)};
await runServer({ env: process.env, webRoot: ${JSON.stringify(webRoot)} });
`,
  );

  signalAtFirstLine = join(workDir, "signal-at-first-line.mjs");
  writeFileSync(signalAtFirstLine, SIGNAL_AT_FIRST_LINE);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await taken?.release();
  taken = undefined;
});

function launch(env: Record<string, string>, { script = MAIN, nodeArgs = [] }: LaunchOptions = {}): Launched {
  const server = spawnNode(script, { nodeArgs, env });
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
async function launchDev(): Promise<Launched & { port: number }> {
  const [port] = await freePorts(1);
  const server = launch({ HUBBER_PORT: String(port), HUBBER_DEV_ORIGIN: DEV_ORIGIN });
  await server.url;
  return { ...server, port };
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

  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("closes and exits with code 0 on %s", async (signal) => {
    const server = await launchDev();
    // Leaves an idle keep-alive connection behind, as a browser tab would.
    await (await fetch(`http://${HOST}:${server.port}/api/health`)).text();

    const startedAt = performance.now();
    server.child.kill(signal);

    expect(await server.exited).toEqual({ code: 0, signal: null });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(server.stdout()).toContain("Zamykanie serwera…");
  });

  it("shuts down cleanly on a signal that arrives the moment its address is printed", async () => {
    const [port] = await freePorts(1);

    const server = launch(
      { HUBBER_PORT: String(port), HUBBER_DEV_ORIGIN: DEV_ORIGIN },
      { nodeArgs: ["--import", pathToFileURL(signalAtFirstLine).href] },
    );
    // Awaited for what it reports when there is no address: a start that hangs shows the server output.
    await server.url;

    expect(await server.exited).toEqual({ code: 0, signal: null });
    expect(server.stdout()).toContain(`API nasłuchuje pod adresem http://${HOST}:${port}.`);
    expect(server.stdout()).toContain("Zamykanie serwera…");
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
});
