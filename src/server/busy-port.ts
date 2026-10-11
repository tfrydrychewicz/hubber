import { execFileSync } from "node:child_process";
import { HOST } from "./ports.ts";

export interface Listener {
  pid: number;
  /** Name of the program, when lsof reports one. */
  command: string | undefined;
}

function run(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** The process that listens on the port, as far as lsof can tell. */
export function listenerOf(port: number): Listener | undefined {
  try {
    // -F prints one field per line: "p<pid>", then "c<command>".
    const out = run("lsof", ["-nP", `-iTCP@${HOST}:${port}`, "-sTCP:LISTEN", "-Fpc"]);
    const pid = /^p(\d+)$/m.exec(out)?.[1];
    return pid === undefined ? undefined : { pid: Number(pid), command: /^c(.+)$/m.exec(out)?.[1] };
  } catch {
    // lsof is missing or found nothing.
    return undefined;
  }
}

// "node --watch" runs its own command line again, without that option, after every saved file.
// Stopping the server it started frees the port only until the next save, so the process to
// stop is the watcher: the server ends with it, and a running "npm run dev" then stops as a whole.
function watcherOf(listener: number): number | undefined {
  const ps = (field: string, pid: number) => run("ps", ["-o", `${field}=`, "-p", String(pid)]).trim();
  try {
    const parent = Number(ps("ppid", listener));
    const command = ps("command", parent);
    // The rest of the command line has to be the listener's own: a tool that merely takes a
    // "--watch" argument itself is no watcher of the process it happens to have started.
    const withoutOption = command.replace(/\s--watch(?=\s)/, "");
    return withoutOption !== command && withoutOption === ps("command", listener) ? parent : undefined;
  } catch {
    // ps is missing, or one of the two processes ended in the meantime.
    return undefined;
  }
}

// Names the process that holds the port when it can be found; the message stands without it too.
function holderOf(port: number): string {
  const listener = listenerOf(port);
  if (listener === undefined) return "";
  const { pid, command } = listener;
  const watcher = watcherOf(pid);
  if (watcher !== undefined) {
    return ` przez serwer uruchomiony przez "npm run dev" (proces ${pid}); zatrzymasz go poleceniem "kill ${watcher}"`;
  }
  return ` przez proces ${pid}${command === undefined ? "" : ` (${command})`}; zatrzymasz go poleceniem "kill ${pid}"`;
}

const busyPrefix = (port: number) => `Port ${port} na ${HOST} jest zajęty`;

export function busyPortMessage(port: number, variable: string): string {
  return `${busyPrefix(port)}${holderOf(port)}. Inny port ustawisz zmienną ${variable}.`;
}

/** Recognises the message above in the output of another process. */
export function isBusyPortMessage(line: string, port: number): boolean {
  return line.startsWith(busyPrefix(port));
}
