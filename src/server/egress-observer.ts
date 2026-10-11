// Records everything a process does that can leave it. For tests only: the application never
// imports this file.
//
// Loaded into a process ahead of its own code, like the stand-ins in scripts/dev.test.ts:
// "node --import <address of this file>", or the same option in NODE_OPTIONS, which every Node
// process started from there inherits. It writes one line of JSON for everything the process
// does that can leave it: a connection it opens, a datagram it sends, a name it resolves, a
// program or a worker thread it starts. A port it listens on is noted as well. A worker thread
// that is started from a file loads the module too, as long as it takes over the options and
// the environment of the process.
//
// The settings come in the address the module is loaded from:
//   ?log=<file>        where the lines go; every process of a tree appends to the same file
//   &deny=remote       refuse whatever is not addressed to this machine, so that a test sends
//                      nothing out even when the code under test tries to
//   &deny=all          refuse everything, this machine included: with the next setting, the
//                      process can reach the configured endpoint and nothing else
//   &allow=<host:port> an address exempt from the refusal, spelled the way the process names
//                      it; may be repeated
//
// What it cannot see: a program that is not Node (only its start is recorded), a worker thread
// that does not load this module (one started from a string of code, or given options or an
// environment of its own in the place of those that name this module; only its start is
// recorded), a program the process turns itself into (process.execve), a native addon that
// opens sockets itself, the port that the debugger opens (node:inspector), and code that reaches
// below the public modules on purpose (process.binding). The test that uses this module starts
// with a canary that proves the hooks still fire on the Node at hand; an empty log from a Node
// whose internals moved would otherwise read as "no connections".
import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { promisify } from "node:util";
import workerThreads, { threadId } from "node:worker_threads";

export type EgressEvent =
  | { kind: "loaded"; script: string | undefined; execArgv: string[] }
  | { kind: "connect"; transport: "tcp" | "pipe"; host: string; port: number; tls: boolean; refused: boolean }
  | { kind: "udp"; host: string; port: number; refused: boolean }
  | { kind: "dns"; via: string; name: string; refused: boolean }
  | { kind: "spawn"; file: string; args: string[] }
  | { kind: "worker"; script: string }
  | { kind: "listen"; host: string; port: number };

/** One line of the log: the event, and who caused it. */
export type EgressRecord = EgressEvent & { pid: number; ppid: number; thread: number; stack: string[] };

type Loose = (...args: unknown[]) => unknown;

const settings = new URL(import.meta.url).searchParams;
const logFile = settings.get("log");
if (logFile === null) throw new Error("egress-observer: the address it is loaded from names no log file (?log=).");
const deny = settings.get("deny");
// Stops the process: a misspelt setting must not pass for "refuse nothing".
if (deny !== null && deny !== "remote" && deny !== "all")
  throw new Error(`egress-observer: unknown setting deny=${deny}.`);
const allowed = new Set(settings.getAll("allow"));
const allowedHosts = new Set([...allowed].map((address) => address.slice(0, address.lastIndexOf(":"))));

const OWN_FILE = import.meta.filename;

function callers(): string[] {
  // Deeper than the ten frames Node keeps by default: between a call of the application and the
  // socket it ends in lie the frames of this module and several of Node's own, and the line of
  // the application is the one that whoever reads the log is looking for.
  let stack: string | undefined;
  try {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 32;
    stack = new Error().stack;
    Error.stackTraceLimit = limit;
  } catch {
    // A process that does not let its limit be changed is observed with the one it has.
    stack = new Error().stack;
  }
  const lines = stack?.split("\n").slice(1) ?? [];
  return lines
    .map((line) => line.trim().replace(/^at /, ""))
    .filter((line) => !line.includes(OWN_FILE))
    .slice(0, 16);
}

function note(event: EgressEvent): void {
  const record: EgressRecord = { ...event, pid: process.pid, ppid: process.ppid, thread: threadId, stack: callers() };
  // Synchronous and in one write: nothing is lost when the process dies in the next instruction,
  // and the lines of several processes do not run into each other.
  appendFileSync(logFile as string, `${JSON.stringify(record)}\n`);
}

function isThisMachine(host: string): boolean {
  const name = host.toLowerCase();
  if (name === "localhost" || name === "::1" || name === "[::1]") return true;
  // An address of the loopback network, and nothing that only looks like one: "127.0.0.999" is
  // no address, so it is a name, which someone else's name server answers for.
  return net.isIPv4(name) && name.startsWith("127.");
}

function isRefused(host: string, port: number): boolean {
  if (deny === null || allowed.has(`${host}:${port}`)) return false;
  return deny === "all" || !isThisMachine(host);
}

function isRefusedName(name: string): boolean {
  if (deny === null || allowedHosts.has(name)) return false;
  return deny === "all" || !isThisMachine(name);
}

function refusal(what: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`egress-observer: refused ${what}`), { code: "ERR_EGRESS_REFUSED" });
}

/**
 * Puts a stand-in in the place of target[name]; the replacement is handed the original. A name
 * that is gone is the canary's to report.
 *
 * The stand-in is a proxy of the original. Whoever reads a property of it (its name, the number
 * of its parameters, whatever Node has hung on it for others to find) reads the original's, and
 * only a call goes another way. An observed process must behave like any other: util.promisify()
 * reads from dns.lookup() the names under which to hand out the address and its family, and from
 * a plain replacement it would read nothing and hand out the address alone.
 */
function wrap(target: object, name: string, replacement: (original: Loose) => Loose): void {
  const original: unknown = Reflect.get(target, name);
  if (typeof original !== "function") return;
  // What util.promisify() returns for a function that carries a promise form of its own is that
  // form, which would run past the stand-in. None of the functions replaced here has one; one
  // that grows it in a later Node must not go unobserved without a word.
  if (Reflect.has(original, promisify.custom)) {
    throw new Error(`egress-observer: ${name} has a promise form of its own, which would not be observed.`);
  }
  const called = replacement(original as Loose);
  const standIn = new Proxy(original, {
    apply: (_original, self, args) => Reflect.apply(called, self, args),
    construct: (_original, args, newTarget) => Reflect.construct(called, args, newTarget),
  });
  Reflect.set(target, name, standIn);
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

// --- TCP, TLS and local sockets. Everything that opens a stream connection ends up in
// Socket.prototype.connect: net.connect(), tls.connect(), http, https, http2, and the built-in
// fetch and WebSocket.
wrap(net.Socket.prototype, "connect", (connect) => {
  return function (this: net.Socket, ...args: unknown[]) {
    // net.connect() and tls.connect() hand their arguments over as one array: [options, callback].
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = asRecord(first);
    const path = typeof first === "string" && Number.isNaN(Number(first)) ? first : options.path;
    const tls = Reflect.get(this, "encrypted") === true;
    if (typeof path === "string") {
      note({ kind: "connect", transport: "pipe", host: path, port: 0, tls, refused: false });
      return Reflect.apply(connect, this, args);
    }
    const givenHost = typeof first === "object" ? options.host : args[1];
    const host = typeof givenHost === "string" && givenHost !== "" ? givenHost : "localhost";
    const port = Number(typeof first === "object" ? options.port : first);
    const refused = isRefused(host, port);
    note({ kind: "connect", transport: "tcp", host, port, tls, refused });
    if (!refused) return Reflect.apply(connect, this, args);
    // Fails the way a connection fails: later, and on the socket.
    process.nextTick(() => this.destroy(refusal(`a connection to ${host}:${port}`)));
    return this;
  };
});

wrap(net.Server.prototype, "listen", (listen) => {
  return function (this: net.Server, ...args: unknown[]) {
    const options = asRecord(args[0]);
    const host = typeof args[0] === "object" ? options.host : args[1];
    const port = typeof args[0] === "object" ? options.port : args[0];
    note({ kind: "listen", host: typeof host === "string" ? host : "(every interface)", port: Number(port) });
    return Reflect.apply(listen, this, args);
  };
});

// --- UDP.
wrap(dgram.Socket.prototype, "send", (send) => {
  return function (this: dgram.Socket, ...args: unknown[]) {
    let host: string;
    let port: number;
    try {
      // A connected socket sends to the address that connect() was given. Its send() takes none,
      // so what stands in the places of port and address means something else there.
      ({ address: host, port } = this.remoteAddress());
    } catch {
      // send(message, offset, length, port, address, callback) or send(message, port, address, callback).
      const long = Boolean(args[4]) || (Boolean(args[3]) && typeof args[3] !== "function");
      const [to, address] = long ? [args[3], args[4]] : [args[1], args[2]];
      host = typeof address === "string" && address !== "" ? address : "localhost";
      port = Number(to);
    }
    const refused = isRefused(host, port);
    // An unbound socket binds itself first and then calls send() once more: two lines for one datagram.
    note({ kind: "udp", host, port, refused });
    if (!refused) return Reflect.apply(send, this, args);
    // Fails the way a datagram fails: later, through the callback or on the socket.
    const error = refusal(`a datagram to ${host}:${port}`);
    const callback = args.findLast((arg) => typeof arg === "function");
    if (typeof callback === "function") process.nextTick(callback as Loose, error);
    else process.nextTick(() => this.emit("error", error));
    return undefined;
  };
});

// --- Name resolution. The resolver functions talk to the network from native code, past
// net and dgram, so this is the only place where they show.
function watchResolver(target: object, via: string): void {
  for (const name of Object.getOwnPropertyNames(target)) {
    if (name !== "lookup" && name !== "lookupService" && name !== "reverse" && !name.startsWith("resolve")) continue;
    wrap(target, name, (original) => {
      return function (this: unknown, ...args: unknown[]) {
        const asked = String(args[0]);
        // lookup() of an address is answered inside Node, without a question to anyone:
        // server.listen(port, "127.0.0.1") makes such a call on every start.
        if (name === "lookup" && net.isIP(asked) !== 0) return Reflect.apply(original, this, args);
        const refused = isRefusedName(asked);
        note({ kind: "dns", via: `${via}${name}`, name: asked, refused });
        if (!refused) return Reflect.apply(original, this, args);
        const callback = args.at(-1);
        const error = Object.assign(refusal(`the name ${asked}`), { hostname: asked });
        if (typeof callback !== "function") return Promise.reject(error);
        process.nextTick(callback as Loose, error);
        return {};
      };
    });
  }
}
watchResolver(dns, "dns.");
watchResolver(dns.promises, "dns.promises.");
watchResolver(dns.Resolver.prototype, "Resolver.");
watchResolver(dns.promises.Resolver.prototype, "promises.Resolver.");

// --- Other programs. What they connect to is beyond this module; that they ran is not.
wrap(childProcess.ChildProcess.prototype, "spawn", (spawn) => {
  return function (this: childProcess.ChildProcess, ...args: unknown[]) {
    const { file, args: argv } = asRecord(args[0]);
    note({ kind: "spawn", file: String(file), args: Array.isArray(argv) ? argv.map(String) : [] });
    return Reflect.apply(spawn, this, args);
  };
});
for (const name of ["spawnSync", "execFileSync", "execSync"]) {
  wrap(childProcess, name, (original) => {
    return function (this: unknown, ...args: unknown[]) {
      note({ kind: "spawn", file: String(args[0]), args: Array.isArray(args[1]) ? args[1].map(String) : [] });
      return Reflect.apply(original, this, args);
    };
  });
}

// --- Worker threads. One that is started from a file, with the options and the environment of
// the process, loads this module by itself and is seen like the thread that started it. One that
// is started from a string of code, or given options or an environment of its own, can run
// without it: what such a thread connects to is beyond this module, like another program's, so
// every start is recorded.
wrap(workerThreads, "Worker", (original) => {
  const Original = original as unknown as typeof workerThreads.Worker;
  // Under the name of the class it stands in for, which is what the stack of an error shows.
  const Worker = class Worker extends Original {
    constructor(...args: ConstructorParameters<typeof Original>) {
      const [script, options] = args;
      // The code itself is left out: it can be long, and it is not an address.
      note({ kind: "worker", script: options?.eval === true ? "(code)" : String(script) });
      super(...args);
    }
  };
  return Worker as unknown as Loose;
});

// Code that wrote `import { lookup } from "node:dns"` holds a copy of the export, not the property.
syncBuiltinESMExports();

note({ kind: "loaded", script: process.argv[1], execArgv: process.execArgv });
