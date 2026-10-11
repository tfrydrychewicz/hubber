// Development runner: starts the API server (restarted by Node whenever its sources change)
// and the Vite dev server, and makes sure neither outlives the other or this script.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { busyPortMessage, isBusyPortMessage } from "../src/server/busy-port.ts";
import { EXIT_FAILURE, EXIT_USAGE } from "../src/server/exit-codes.ts";
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT, HOST, PortError, parsePort } from "../src/server/ports.ts";

const GRACE_MS = 5000;
const READY_TIMEOUT_MS = 15_000;
const ROOT = join(import.meta.dirname, "..");

// Process groups that still have members, by group id (the pid of the child that leads the group).
const groups = new Set<number>();
const closed: Promise<void>[] = [];
let stopping = false;

const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (code: number, text: string) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const say = (line: string) => console.log(`${paint(33, "[dev]")} ${line}`);

function fail(message: string, exitCode: number): never {
  console.error(message);
  process.exit(exitCode);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" ? resolve(false) : reject(err)));
    probe.listen({ port, host: HOST, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

async function waitUntil(ready: () => boolean): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline && !stopping) {
    if (ready()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function start(
  name: string,
  color: number,
  args: string[],
  env: NodeJS.ProcessEnv,
  onLine: (line: string) => void,
): void {
  // process.execPath keeps the children on the Node that passed the preflight, whatever PATH says.
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    // Own process group: one kill() reaches the child together with whatever it spawned, and
    // the terminal's Ctrl-C arrives only here, so this script alone decides how shutdown goes.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env, ...(useColor && { FORCE_COLOR: "1" }) },
  });
  const prefix = paint(color, `[${name}]`);
  const forward = (source: Readable, target: NodeJS.WriteStream) =>
    createInterface({ input: source }).on("line", (line) => {
      if (line.trim() !== "") target.write(`${prefix} ${line}\n`);
      // As plain text: in a terminal the children write in colour, and Vite sets the port of
      // its address in bold, which cuts the address in two.
      onLine(stripVTControlCharacters(line));
    });
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  const group = child.pid;
  if (group !== undefined) groups.add(group);
  closed.push(
    new Promise((resolve) => {
      // "close" rather than "exit": it waits until everything that held the output pipes is
      // gone, which includes a server left behind by a killed "node --watch".
      child.once("close", () => {
        if (group !== undefined) groups.delete(group);
        resolve();
      });
    }),
  );
  child.once("error", (err) => {
    if (stopping) return;
    say(`Nie udało się uruchomić procesu ${name}: ${err.message}`);
    void stop(EXIT_FAILURE);
  });
  child.once("exit", (code, signal) => {
    if (stopping) return;
    say(`Proces ${name} zakończył się nieoczekiwanie (${signal ?? `kod ${code}`}). Zatrzymuję pozostałe.`);
    void stop(EXIT_FAILURE);
  });
}

function signalGroups(signal: NodeJS.Signals): void {
  for (const group of groups) {
    try {
      // A negative pid addresses the whole process group.
      process.kill(-group, signal);
    } catch {
      // The group emptied in the meantime.
    }
  }
}

async function stop(exitCode: number): Promise<void> {
  // One Ctrl-C arrives twice, from the terminal and from npm, so a repeat must be harmless.
  if (stopping) return;
  stopping = true;
  signalGroups("SIGTERM");
  // What had to be killed did not shut down, so the stop has failed whatever asked for it.
  // The server treats its own shutdown deadline the same way.
  let forced = false;
  const timer = setTimeout(() => {
    forced = true;
    say(`Procesy nie zakończyły się w ciągu ${GRACE_MS / 1000} s. Wymuszam zamknięcie.`);
    signalGroups("SIGKILL");
  }, GRACE_MS);
  await Promise.all(closed);
  clearTimeout(timer);
  process.exit(forced ? EXIT_FAILURE : exitCode);
}

// Once the terminal is closed every write to it fails. Without these handlers the first
// forwarded log line after a hang-up would crash this script before the children are stopped.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});

let apiPort: number;
let webPort: number;
try {
  apiPort = parsePort(process.env.HUBBER_PORT, DEFAULT_API_PORT, "HUBBER_PORT");
  webPort = parsePort(process.env.HUBBER_WEB_PORT, DEFAULT_WEB_PORT, "HUBBER_WEB_PORT");
} catch (err) {
  if (err instanceof PortError) fail(err.message, EXIT_USAGE);
  throw err;
}
if (apiPort === webPort) {
  fail(`HUBBER_PORT i HUBBER_WEB_PORT wskazują ten sam port (${apiPort}). Ustaw dwa różne.`, EXIT_USAGE);
}

// Checked here because neither child reports a busy port well: Vite answers in English, and
// "node --watch" keeps waiting for a file change after the server has given up. Both ports are
// reported together, so leftovers of a killed session can be cleared in one go.
const busy: string[] = [];
if (!(await isPortFree(apiPort))) busy.push(busyPortMessage(apiPort, "HUBBER_PORT"));
if (!(await isPortFree(webPort))) busy.push(busyPortMessage(webPort, "HUBBER_WEB_PORT"));
if (busy.length > 0) fail(busy.join("\n"), EXIT_FAILURE);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void stop(0));
// Covers exits that bypass stop(), such as an uncaught exception.
process.on("exit", () => signalGroups("SIGKILL"));

const webOrigin = `http://${HOST}:${webPort}`;
const ports = { HUBBER_PORT: String(apiPort), HUBBER_WEB_PORT: String(webPort) };
const viteCli = join(dirname(createRequire(import.meta.url).resolve("vite/package.json")), "bin", "vite.js");

// The API is ready once the server says so itself. An open port proves nothing: it can belong
// to whoever took it after the check above, while "node --watch" stays alive beside a server
// that has given up.
const apiReadyLine = `API nasłuchuje pod adresem http://${HOST}:${apiPort}.`;
let apiUp = false;
function onApiLine(line: string): void {
  if (line.includes(apiReadyLine)) apiUp = true;
  // No saved file frees a port, so waiting for the next restart would be waiting for nothing.
  if (isBusyPortMessage(line, apiPort) && !stopping) {
    say("Serwer API nie wystartował. Zatrzymuję pozostałe.");
    void stop(EXIT_FAILURE);
  }
}

// Vite, too, is ready once it says so itself: it prints its address when its server listens,
// unless a quieter logLevel hides the line. An open port proves even less here. To see whether
// the port is free, Vite listens on it for a moment before it binds it for good, and a
// connection made in that moment would announce a server that then refuses the first request.
const webReadyLine = `${webOrigin}/`;
let webUp = false;
function onWebLine(line: string): void {
  if (line.includes(webReadyLine)) webUp = true;
}

// --watch-preserve-output: otherwise every restart clears the terminal, Vite's lines included.
// No further watch option: the busy-port message recognises the watcher by its command line,
// which has to be the server's own with "--watch" added.
// HUBBER_DEV_ORIGIN tells the server which extra origin to trust; requests proxied by Vite
// keep the browser's Host and Origin headers, which name the Vite address.
start(
  "api",
  36,
  ["--watch", "--watch-preserve-output", "src/server/main.ts"],
  { ...ports, HUBBER_DEV_ORIGIN: webOrigin },
  onApiLine,
);
// When someone else has taken the web port since the check above, Vite exits (strictPort), and
// the end of a child stops everything.
start("web", 35, [viteCli], ports, onWebLine);

const [apiReady, webReady] = await Promise.all([waitUntil(() => apiUp), waitUntil(() => webUp)]);
if (!stopping) {
  if (apiReady && webReady) say(`Hubber działa w trybie deweloperskim: ${webOrigin} (Ctrl-C kończy pracę).`);
  else
    say(
      `${apiReady ? "Vite" : "Serwer API"} nie wystartował w ciągu ${READY_TIMEOUT_MS / 1000} s. Sprawdź komunikaty powyżej.`,
    );
}
