// NFR-1 on the server that the browsers of the end-to-end run talk to: the real entry point, in
// production mode, under hundreds of real requests. playwright.config.ts starts that server
// with src/server/egress-observer.ts loaded ahead of its code, and when the tests are over
// e2e/global-teardown.ts reads what the observer logged and fails the run unless the log shows
// one server that opened its one port and did nothing else that can leave a process.
//
// The unit-level test of the same claim (src/server/egress.test.ts) proves it for the journeys
// it makes itself. This one adds every request a browser makes in a whole run.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// A type only: the module itself must never be loaded here, it acts on whatever loads it.
import type { EgressRecord } from "../src/server/egress-observer.ts";

const REPO_ROOT = join(import.meta.dirname, "..");
const OBSERVER = join(REPO_ROOT, "src/server/egress-observer.ts");
/** What "npm start" runs in the end. The record of this script's start is the server's own. */
export const SERVER_SCRIPT = join(REPO_ROOT, "src/server/main.ts");
const HOST = "127.0.0.1";

/** Where the observer of a run writes: beside the run's workspace, never in it. */
export function egressLogBeside(workspaceDir: string): string {
  return `${workspaceDir}-egress.jsonl`;
}

/**
 * The value of NODE_OPTIONS that puts the observer into a Node process and into every Node
 * process that one starts. Whatever is not addressed to this machine is refused as well as
 * logged, so a run sends nothing out even when the code under test has just started to.
 */
export function observerOptions(logFile: string): string {
  const observer = pathToFileURL(OBSERVER);
  observer.searchParams.set("log", logFile);
  observer.searchParams.set("deny", "remote");
  return `--import=${observer.href}`;
}

/** The records of a log, oldest first. A log that is not there has none. */
export function readEgressLog(logFile: string): EgressRecord[] {
  let text: string;
  try {
    text = readFileSync(logFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EgressRecord);
}

/**
 * Whether a script that a process was started with is the server's entry point. Compared by
 * what the two paths lead to: Node names a script the way it was reached, and a checkout can be
 * reached through a link (the temporary directory of macOS is).
 */
function isServerScript(script: string | undefined): boolean {
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(SERVER_SCRIPT);
  } catch {
    // A script that is not there any more is not the server of this checkout.
    return false;
  }
}

/** What a record says was reached for, in the words of src/server/egress.test.ts. Nothing for a note that is no way out. */
function reachedFor(record: EgressRecord): string | undefined {
  if (record.kind === "connect") return `connect ${record.host}:${record.port}`;
  if (record.kind === "udp") return `udp ${record.host}:${record.port}`;
  if (record.kind === "dns") return `${record.via}(${record.name})`;
  if (record.kind === "spawn") return `spawn ${[record.file, ...record.args].join(" ")}`;
  if (record.kind === "worker") return `worker ${record.script}`;
  return undefined;
}

/**
 * Where in the code a record comes from: the first line of its stack that is not Node's own,
 * which is the application's or a package's. A call that Node makes later by itself has no such
 * line, and then its own first lines are all there is.
 */
function origin(stack: readonly string[]): string {
  return stack.find((frame) => !frame.includes("node:")) ?? stack.slice(0, 2).join(" < ");
}

/** One line for each thing that was reached for: how often, and from where in the code the first time. */
function listed(records: readonly EgressRecord[]): string[] {
  const found = new Map<string, { times: number; from: string }>();
  for (const record of records) {
    const what = reachedFor(record);
    if (what === undefined) continue;
    const entry = found.get(what) ?? { times: 0, from: origin(record.stack) };
    entry.times += 1;
    found.set(what, entry);
  }
  return [...found].map(
    ([what, { times, from }]) => `  ${times} × ${what}${from === "" ? "" : `   (first from ${from})`}`,
  );
}

/**
 * What is wrong with the log of a run, in sentences for whoever reads the failed run; nothing
 * when the log shows what it must. An empty log is wrong too: it would otherwise read as "the
 * server connected nowhere" when in truth nobody was watching.
 */
export function egressProblems(records: readonly EgressRecord[], port: number): string[] {
  const starts = records.filter((record) => record.kind === "loaded" && isServerScript(record.script));
  const [server, ...others] = starts;
  if (server === undefined) {
    return [
      `The observer was not in the server: the log has ${records.length} record(s), and none of them is the start of ${SERVER_SCRIPT}. Without it nothing is known about what the server reached for.`,
    ];
  }
  if (others.length > 0) {
    return [
      `The log holds ${starts.length} starts of the server where a run has one: it was not emptied before this run, or the server was started again.`,
    ];
  }

  const problems: string[] = [];
  const own = records.filter((record) => record.pid === server.pid);
  // The one thing the server must have done. It also shows that the observer's hooks still fire
  // in that process: a log with the start and nothing else would prove nothing.
  const ports = own.flatMap((record) => (record.kind === "listen" ? [`${record.host}:${record.port}`] : []));
  if (ports.length !== 1 || ports[0] !== `${HOST}:${port}`) {
    problems.push(
      `The server must have opened one port, ${HOST}:${port}, and the log has ${ports.length === 0 ? "none" : ports.join(", ")}.`,
    );
  }
  const reached = listed(own);
  if (reached.length > 0) {
    problems.push(
      [
        "The server did what can leave its process (NFR-1 allows nothing but calls to the endpoint, and nothing calls it yet):",
      ]
        .concat(reached)
        .join("\n"),
    );
  }
  // Beside the server there is what starts it: npm and the build. Those start programs and
  // threads of their own, which is their business; reaching for another machine is not.
  const refused = listed(
    records.filter((record) => record.pid !== server.pid && "refused" in record && record.refused),
  );
  if (refused.length > 0) {
    problems.push(["What starts the server reached for another machine, and was refused:"].concat(refused).join("\n"));
  }
  return problems;
}
