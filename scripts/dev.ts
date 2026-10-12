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
import { withoutSdkVariables } from "../src/server/llm/credentials/scrub-env.ts";
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT, HOST, PortError, parsePort } from "../src/server/ports.ts";
import { isMigrationDone, isMigrationNotice, isWorkspaceRefusal } from "../src/server/workspace/errors.ts";
import { locateWorkspace, WorkspaceLocationError } from "../src/server/workspace/location.ts";

const GRACE_MS = 5000;
// One Ctrl-C arrives more than once: from the terminal and, a moment later, from npm, and again
// and again for as long as the key is held down. A signal that follows another one, or the
// beginning of a stop, within this time is taken for a part of the same request; only one that
// comes after this much silence is somebody asking again. It is a guess by the clock: a second
// Ctrl-C pressed sooner than this is not heard and has to be pressed once more, and a signal
// that npm passes on later than this, or a key that repeats more slowly, counts as a new request.
const ECHO_MS = 500;
const READY_TIMEOUT_MS = 15_000;
const ROOT = join(import.meta.dirname, "..");

// Process groups that still have members, by group id (the pid of the child that leads the group).
const groups = new Set<number>();
const closed: Promise<void>[] = [];
let stopping = false;
// A start that has to bring the database of the workspace up to date says so before the work and
// after it. In between the server answers nobody and acts on no signal, for as long as the
// migration takes; at the scale of three years of data that can be more than the time a start, or
// a stop, is given. For the runner it ends with the second line, with a refusal, which ends the
// session, or with the watcher's line about a server that ended by itself: see onApiLine().
let apiMigrating = false;
// While a stop is under way: when it began, and how to give the servers the grace period anew
// and how to end it at once.
let stopUnderWay: { since: number; graceAnew: () => void; force: (why: string) => void } | undefined;
// When the last of the signals that end the session arrived; 0 before the first.
let lastStopSignal = 0;

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

/**
 * Gives a server the time to come up. While it is "on hold" the time does not count, and the
 * whole of it is there again once the hold is over: a server on hold is at work, not hanging.
 */
async function waitUntil(ready: () => boolean, onHold: () => boolean = () => false): Promise<boolean> {
  let deadline = Date.now() + READY_TIMEOUT_MS;
  while (!stopping) {
    if (ready()) return true;
    if (onHold()) deadline = Date.now() + READY_TIMEOUT_MS;
    else if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** Starts one of the two servers. Its environment is what the caller hands in, not this script's own. */
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
    env: { ...env, ...(useColor && { FORCE_COLOR: "1" }) },
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

// What the guard runs: it waits for a line that never comes, and when its input closes instead,
// it asks the process groups named in its arguments to stop.
const GUARD = 'read -r _ || kill -s TERM -- "$@"';

/**
 * Leaves someone behind to stop the servers if this script is killed outright (SIGKILL, a crash
 * of Node itself): no handler here sees that, and the servers are in process groups of their
 * own, so they would stay, with both ports and the workspace held open. The guard is a shell
 * that reads from a pipe which only this script holds the other end of. The pipe closes when
 * this script is gone, however it went, and the guard then asks the servers to stop, the way
 * stop() does. On an orderly stop the guard is ended with the servers, before it does anything.
 */
function leaveGuard(): void {
  const servers = [...groups].map((group) => `-${group}`);
  const guard = spawn("/bin/sh", ["-c", GUARD, "hubber-dev-guard", ...servers], {
    // A group of its own, like the servers: what ends this script from a terminal must not end
    // the guard with it.
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  // Without the guard the session works as before; only the cover for an outright kill is missing.
  guard.once("error", () => {});
  guard.stdin.on("error", () => {});
  const group = guard.pid;
  if (group !== undefined) groups.add(group);
  closed.push(
    new Promise((resolve) => {
      guard.once("close", () => {
        if (group !== undefined) groups.delete(group);
        resolve();
      });
    }),
  );
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
  // Asked for by a signal, by a server that gave up and by a child that ended: once is enough.
  if (stopping) return;
  stopping = true;
  signalGroups("SIGTERM");
  // What had to be killed did not shut down, so the stop has failed whatever asked for it.
  // The server treats its own shutdown deadline the same way.
  let forced = false;
  const force = (why: string): void => {
    if (forced) return;
    forced = true;
    say(`${why} Wymuszam zamknięcie.`);
    signalGroups("SIGKILL");
  };
  let timer: NodeJS.Timeout | undefined;
  const graceAnew = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // A server in the middle of a migration is not killed for being slow to stop: it acts on the
      // signal once the migration is done, as its own notice says. The grace period begins anew
      // then (see onApiLine), so what is killed in the end is a server that hangs afterwards.
      if (!apiMigrating) force(`Procesy nie zakończyły się w ciągu ${GRACE_MS / 1000} s.`);
    }, GRACE_MS);
  };
  graceAnew();
  stopUnderWay = { since: Date.now(), graceAnew, force };
  if (apiMigrating) {
    say(
      "Serwer API aktualizuje bazę workspace'u; czekam, aż skończy. Ponowne Ctrl-C zatrzyma go od razu, a przerwana aktualizacja nie zmienia bazy.",
    );
  }
  await Promise.all(closed);
  clearTimeout(timer);
  process.exit(forced ? EXIT_FAILURE : exitCode);
}

/**
 * For the signals that end the session. The first one stops it in order. One that comes while a
 * stop is under way, and is a request of its own (see ECHO_MS), ends the wait: the way out of a
 * stop that waits for a migration, which can take long, or hang. The same holds for a stop that
 * began by itself, when one of the servers was gone: a Ctrl-C during it asks for its end, and
 * where it waits for a migration, the line about the wait has said that Ctrl-C does that.
 */
function onStopSignal(): void {
  const now = Date.now();
  const quietFor = now - lastStopSignal;
  lastStopSignal = now;
  if (stopUnderWay === undefined) void stop(0);
  else if (quietFor >= ECHO_MS && now - stopUnderWay.since >= ECHO_MS) {
    stopUnderWay.force("Ponowne żądanie zatrzymania.");
  }
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
// A place for the workspace that cannot be used as given is a mistake in the settings, like a
// bad port: reported here, in the server's own words, before anything is started. Only the
// environment is read. Whether a workspace is there and can be opened is for the server to find
// out, and onApiLine() acts on its answer.
try {
  locateWorkspace(process.env);
} catch (err) {
  if (err instanceof WorkspaceLocationError) fail(err.message, EXIT_USAGE);
  throw err;
}

// Checked here because neither child reports a busy port well: Vite answers in English, and
// "node --watch" keeps waiting for a file change after the server has given up. Both ports are
// reported together, so leftovers of a killed session can be cleared in one go.
const busy: string[] = [];
if (!(await isPortFree(apiPort))) busy.push(busyPortMessage(apiPort, "HUBBER_PORT"));
if (!(await isPortFree(webPort))) busy.push(busyPortMessage(webPort, "HUBBER_WEB_PORT"));
if (busy.length > 0) fail(busy.join("\n"), EXIT_FAILURE);

// SIGQUIT is what Ctrl-\ sends. Left to Node it ends this script at once, and the servers, which
// are in process groups of their own, would stay behind with the ports and the workspace.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) process.on(signal, onStopSignal);
// Covers exits that bypass stop(), such as an uncaught exception.
process.on("exit", () => signalGroups("SIGKILL"));

const webOrigin = `http://${HOST}:${webPort}`;
const ports = { HUBBER_PORT: String(apiPort), HUBBER_WEB_PORT: String(webPort) };
const viteCli = join(dirname(createRequire(import.meta.url).resolve("vite/package.json")), "bin", "vite.js");

// The API is ready once the server says so itself. An open port proves nothing: it can belong
// to whoever took it after the check above, while "node --watch" stays alive beside a server
// that has given up.
const apiReadyLine = `API nasłuchuje pod adresem http://${HOST}:${apiPort}.`;
// What "node --watch" prints when the script it runs has ended by itself with anything but code 0,
// a kill included. The server is the watcher's child and not this script's, so this line is the
// one sign that a server is gone which said nothing more: its migration went with it. The
// watcher's line for an end with code 0 is not needed: a server that ends so during an update has
// said first that the database is up to date. Only where a line begins with the words: a line of
// the server may hold them behind other text.
const SERVER_ENDED = /^Failed running /;
let apiUp = false;
function onApiLine(line: string): void {
  if (line.includes(apiReadyLine)) apiUp = true;
  if (isMigrationNotice(line)) apiMigrating = true;
  if (apiMigrating && (isMigrationDone(line) || isWorkspaceRefusal(line) || SERVER_ENDED.test(line))) {
    apiMigrating = false;
    // A stop that has been waiting for the migration gives the server its time to stop from now.
    stopUnderWay?.graceAnew();
  }
  // No saved file frees a port or makes a workspace open, so waiting for the next restart would
  // be waiting for nothing.
  if ((isBusyPortMessage(line, apiPort) || isWorkspaceRefusal(line)) && !stopping) {
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
  { ...process.env, ...ports, HUBBER_DEV_ORIGIN: webOrigin },
  onApiLine,
);
// When someone else has taken the web port since the check above, Vite exits (strictPort), and
// the end of a child stops everything.
// Vite gets the environment without the SDK's variables: the address of the endpoint and its
// credential are for the server alone, and Vite runs the plugins of the build and whatever
// those load.
start("web", 35, [viteCli], { ...withoutSdkVariables(process.env), ...ports }, onWebLine);
leaveGuard();

const [apiReady, webReady] = await Promise.all([
  waitUntil(
    () => apiUp,
    () => apiMigrating,
  ),
  waitUntil(() => webUp),
]);
if (!stopping) {
  if (apiReady && webReady) say(`Hubber działa w trybie deweloperskim: ${webOrigin} (Ctrl-C kończy pracę).`);
  else
    say(
      `${apiReady ? "Vite" : "Serwer API"} nie wystartował w ciągu ${READY_TIMEOUT_MS / 1000} s. Sprawdź komunikaty powyżej.`,
    );
}
