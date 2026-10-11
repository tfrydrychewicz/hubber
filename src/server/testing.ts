// Helpers shared by the tests that start processes and open sockets. For tests only, and for
// Node only: the application never imports this file.
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { once } from "node:events";
import { type AddressInfo, connect, createServer } from "node:net";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { HOST } from "./ports.ts";

const REPO_ROOT = join(import.meta.dirname, "../..");

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface SpawnNodeOptions {
  /** Options for Node itself; they go before the script. */
  nodeArgs?: readonly string[];
  /** Arguments of the script. */
  args?: readonly string[];
  /** Everything the process finds in its environment, apart from PATH. */
  env?: Readonly<Record<string, string>>;
}

export interface SpawnedNode {
  child: ChildProcessByStdio<null, Readable, Readable>;
  /** What the process has written so far. */
  stdout: () => string;
  stderr: () => string;
  /** Resolves once the process has ended and all of its output has been read. */
  exited: Promise<Exit>;
}

/**
 * Starts a script the way the npm scripts do: with the Node that runs the tests and no loader.
 *
 * - The script is named relative to the repository root, and the process starts in that
 *   directory, so the outcome does not depend on where Vitest was started.
 * - The environment is built from scratch, so that the developer's own variables never leak in.
 * - Stopping the process is left to the caller.
 */
export function spawnNode(script: string, { nodeArgs = [], args = [], env = {} }: SpawnNodeOptions = {}): SpawnedNode {
  const child = spawn(process.execPath, [...nodeArgs, resolve(REPO_ROOT, script), ...args], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  // setEncoding() decodes across chunks, so a character that arrives in two pieces stays whole.
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  // "close" rather than "exit": it fires only after stdout and stderr have been read to the end.
  const exited = new Promise<Exit>((done) => child.once("close", (code, signal) => done({ code, signal })));
  return { child, stdout: () => stdout, stderr: () => stderr, exited };
}

export interface OccupiedPort {
  port: number;
  /** Frees the port. Safe to call more than once. */
  release: () => Promise<void>;
}

/**
 * Listens on a port picked by the system and keeps it until release() is called: for a test
 * that needs a taken port. Nobody else can be given the number while it is held.
 */
export async function occupyPort(): Promise<OccupiedPort> {
  const server = createServer().listen(0, HOST);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { port, release: () => new Promise((done) => server.close(() => done())) };
}

/** As many port numbers as `Count` says, so that destructuring the result needs no checks. */
type Ports<Count extends number, Found extends number[] = []> = number extends Count
  ? number[]
  : Found["length"] extends Count
    ? Found
    : Ports<Count, [...Found, number]>;

/**
 * Numbers of ports that were free a moment ago, all different. Only for a process that takes
 * its port as a number and cannot be asked for any free one: HUBBER_PORT does not accept 0.
 *
 * The ports are released before they are returned, so until the process binds its port the
 * system could hand the same number to someone else. macOS gives numbers out in sequence,
 * which leaves that to the moment the sequence wraps around, but nothing rules it out; the
 * process then fails to start with a message about a taken port. Whatever can bind port 0
 * and report the port it got should do that instead, and a port that has to be taken comes
 * from occupyPort().
 */
export async function freePorts<Count extends number>(count: Count): Promise<Ports<Count>> {
  // All are held until the last one is known, which is what makes them different.
  const held = await Promise.all(Array.from({ length: count }, occupyPort));
  await Promise.all(held.map(({ release }) => release()));
  return held.map(({ port }) => port) as Ports<Count>;
}

export interface RawGetOptions {
  port: number;
  /** The request target, sent exactly as given. */
  target: string;
  /** The Host header. By default the address the request goes to. */
  host?: string;
}

/**
 * A GET request written by hand, for what fetch() does not allow: it normalises dot segments
 * in the path and does not let a caller choose the Host header. Resolves with the whole
 * response, status line and headers included, once the server has closed the connection.
 */
export function rawGet({ port, target, host = `${HOST}:${port}` }: RawGetOptions): Promise<string> {
  return new Promise((done, reject) => {
    const socket = connect({ host: HOST, port });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.on("close", () => done(response));
    socket.on("error", reject);
    socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  });
}
