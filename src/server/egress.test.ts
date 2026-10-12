// NFR-1, "no outgoing connections other than to the configured endpoint", checked on real
// processes: each runs with egress-observer.ts loaded ahead of its own code, which records
// whatever the process does that can leave it.
//
// The first test is the canary: it proves that the observer still sees every way out on the
// Node at hand. Without it an empty log would prove nothing, so it stays the first test here.
import type { ChildProcess } from "node:child_process";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import dns from "node:dns";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EgressRecord } from "./egress-observer.ts";
import { createFakeEndpoint } from "./llm/diagnostics/fake-endpoint.ts";
import {
  freePorts,
  type OccupiedPort,
  occupyPort,
  rawGet,
  type SpawnedNode,
  spawnNode,
  TEST_WORKSPACE,
} from "./testing.ts";
import { createTestWorkspace, createUnmigratedTestWorkspace, type TestWorkspace } from "./workspace/testing.ts";

const HOST = "127.0.0.1";
const OBSERVER = join(import.meta.dirname, "egress-observer.ts");
/** A module of the server as an address, for a script that lies outside the repository. */
const moduleAddress = (path: string): string => JSON.stringify(pathToFileURL(join(import.meta.dirname, path)).href);
// Each test starts Node several times, beside the other test files: far above what that takes
// on an idle machine.
const TEST_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 10_000;
// Any allowed value puts the server in development mode, where it needs no built web app.
const DEV_ORIGIN = "http://127.0.0.1:8000";
// Invented. The server only reads it; the client sends it to a stand-in on this machine.
const TOKEN = "invented-token-for-tests";
// The last line of a start that has found its credential in the environment, and of one that
// has found none.
const CREDENTIAL_LINE = "Poświadczenia: zmienna ANTHROPIC_AUTH_TOKEN.";
const WITHOUT_CREDENTIAL =
  "Serwer działa dalej, ale wywołania modelu będą kończyć się błędem, dopóki tego nie poprawisz.";
// What a browser says of itself with every request of a page.
const BROWSER = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "pl-PL,pl;q=0.9",
  "sec-fetch-site": "same-origin",
};

// A local socket that does not exist: the root directory of macOS cannot be written to.
const NO_SUCH_SOCKET = "/hubber-canary/no-such.sock";
// A name that cannot be put into a question to a name server, because one of its parts is longer
// than the 63 letters a part may have. The resolver refuses it by itself, so a question about it
// goes nowhere even through a function that the observer has stopped seeing.
const UNSENDABLE = `${"x".repeat(64)}.invalid`;

/**
 * The functions of an object through which Node asks a name server: every one the observer has
 * to stand in for, whatever the Node at hand calls them. The canary asks through each.
 */
function questionsOf(door: object): string[] {
  return Object.getOwnPropertyNames(door).filter(
    (name) => typeof Reflect.get(door, name) === "function" && (name === "reverse" || name.startsWith("resolve")),
  );
}

// The four doors to the resolver, each with the name the observer logs it under. The first two
// ask the name servers of the system; the other two are objects that are given servers of their own.
const RESOLVER_DOORS: ReadonlyArray<readonly [via: string, door: object]> = [
  ["dns.", dns],
  ["dns.promises.", dns.promises],
  ["Resolver.", dns.Resolver.prototype],
  ["promises.Resolver.", dns.promises.Resolver.prototype],
];
/** What the log holds for a canary that asked every question through every door. */
const EVERY_QUESTION = RESOLVER_DOORS.flatMap(([via, door]) =>
  questionsOf(door).map((name) => `${via}${name}(${UNSENDABLE})`),
);

// Tries every way out that Node offers, and every way of asking for each that the observer has to
// read: where a connection or a datagram goes can be said in several forms. Those that lead to the
// network are aimed at the sinks of the test: a TCP port and a UDP port on this machine, named in
// the arguments the script is started with.
const CANARY = `import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { isMainThread, Worker } from "node:worker_threads";

const [tcp, udp, role = "main"] = process.argv.slice(2);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quiet = (emitter) => emitter.on("error", () => {});
const over = (emitter) => new Promise((resolve) => emitter.on("exit", resolve));
// For a call that may throw or reject: the canary goes on, and the log shows what was seen of it.
const attempt = (call) => {
  try {
    call()?.catch?.(() => {});
  } catch {}
};

await fetch(\`http://127.0.0.1:\${tcp}/\`).catch(() => {});
if (role === "main" && isMainThread) {
  await fetch(\`http://localhost:\${tcp}/\`).catch(() => {});
  quiet(net.connect(Number(tcp), "127.0.0.1"));
  quiet(tls.connect(Number(tcp), "127.0.0.1"));
  quiet(http.get(\`http://127.0.0.1:\${tcp}/\`));
  new WebSocket(\`ws://127.0.0.1:\${tcp}/\`).addEventListener("error", () => {});
  // A socket that is told where to go itself: by port and host, by an object, and by the port
  // alone, which means this machine by its name.
  quiet(new net.Socket()).connect(Number(tcp), "127.0.0.1");
  quiet(new net.Socket()).connect({ port: Number(tcp), host: "127.0.0.1" });
  quiet(new net.Socket()).connect(Number(tcp));
  // A local socket leads out of the process as well, to another program on this machine. It is
  // named through net.connect() and to the socket itself.
  quiet(net.connect("${NO_SUCH_SOCKET}"));
  quiet(new net.Socket()).connect("${NO_SUCH_SOCKET}");

  // A datagram: with and without the place of the message in its buffer, with and without an
  // address (without one it goes to this machine), with and without a callback.
  const socket = quiet(dgram.createSocket("udp4"));
  const to = Number(udp);
  socket.send("canary", to, "127.0.0.1", () => {});
  socket.send("canary", to, "127.0.0.1");
  socket.send("canary", to, () => {});
  socket.send("canary", to);
  socket.send("canary", 0, 6, to, "127.0.0.1", () => {});
  socket.send("canary", 0, 6, to, "127.0.0.1");
  socket.send("canary", 0, 6, to, () => {});
  socket.send("canary", 0, 6, to);
  // A connected socket is told its destination beforehand, and send() then names none.
  const connected = quiet(dgram.createSocket("udp4"));
  connected.connect(to, "127.0.0.1", () => {
    connected.send("canary", 0, 6, () => {});
    connected.send("canary");
  });

  // The resolver asks the server it is given, here the UDP sink, from native code: past net and
  // dgram. These three questions could be sent, so the sink shows whether one was.
  const resolver = new dns.Resolver({ timeout: 200, tries: 1 });
  resolver.setServers([\`127.0.0.1:\${udp}\`]);
  resolver.resolve4("canary.invalid", () => {});
  resolver.reverse("192.0.2.1", () => {});
  const promised = new dns.promises.Resolver({ timeout: 200, tries: 1 });
  promised.setServers([\`127.0.0.1:\${udp}\`]);
  attempt(() => promised.resolveTxt("canary.invalid"));
  // What the system is asked, in both forms. This machine answers these by itself.
  attempt(() => dns.promises.lookup("localhost"));
  attempt(() => dns.lookupService("127.0.0.1", 80, () => {}));
  attempt(() => dns.promises.lookupService("127.0.0.1", 80));
  // Every other question there is, through each of the four doors to the resolver. Two of the
  // doors ask the name servers of the system, so the question is one that cannot be sent.
  const questions = (door) =>
    Object.getOwnPropertyNames(door).filter(
      (name) => typeof door[name] === "function" && (name === "reverse" || name.startsWith("resolve")),
    );
  for (const name of questions(dns)) attempt(() => dns[name]("${UNSENDABLE}", () => {}));
  for (const name of questions(dns.promises)) attempt(() => dns.promises[name]("${UNSENDABLE}"));
  for (const name of questions(dns.Resolver.prototype)) attempt(() => resolver[name]("${UNSENDABLE}", () => {}));
  for (const name of questions(dns.promises.Resolver.prototype)) attempt(() => promised[name]("${UNSENDABLE}"));

  // A port of its own is no way out, but it is noted too, in both forms of asking for one. To
  // open it Node looks the address up, which it answers itself.
  const server = net.createServer().listen(0, "127.0.0.1", () => server.close());
  const second = net.createServer().listen({ port: 0, host: "127.0.0.1" }, () => second.close());
  await over(new Worker(new URL(import.meta.url), { argv: [tcp, udp, "worker"] }));
  // A thread that is started from a string of code runs without the observer. It tries nothing here.
  await over(new Worker("", { eval: true }));
  await over(spawn(process.execPath, [import.meta.filename, tcp, udp, "child"], { stdio: "ignore" }));
  // The three calls that start a program and wait for it.
  execFileSync("/usr/bin/true");
  spawnSync("/usr/bin/false");
  execSync("/bin/echo canary", { stdio: "ignore" });
}
await pause(300);
process.exit(0);
`;

// Asks about each name it is given, through a resolver whose only server is the UDP sink.
const NAMES = `import dns from "node:dns";

const [udp, ...names] = process.argv.slice(2);
const resolver = new dns.Resolver({ timeout: 200, tries: 1 });
resolver.setServers([\`127.0.0.1:\${udp}\`]);
for (const name of names) {
  try {
    resolver.resolve4(name, () => {});
  } catch {}
}
setTimeout(() => process.exit(0), 300);
`;

// Reaches for the sinks in each way that has a place of its own for a failure, and prints what
// arrived in that place: the code of the error, or that no word came within a second.
const REFUSALS = `import dgram from "node:dgram";
import dns from "node:dns";
import net from "node:net";

const [tcp, udp] = process.argv.slice(2).map(Number);
const told = (what, tell) =>
  Promise.race([new Promise(tell), new Promise((resolve) => setTimeout(resolve, 1000, "no word"))]).then((word) => [what, word]);
const servers = [\`127.0.0.1:\${udp}\`];
const resolver = new dns.Resolver({ timeout: 200, tries: 1 });
resolver.setServers(servers);
const promised = new dns.promises.Resolver({ timeout: 200, tries: 1 });
promised.setServers(servers);
const silent = dgram.createSocket("udp4");

const outcomes = await Promise.all([
  told("a connection", (tell) =>
    net.connect(tcp, "127.0.0.1").once("error", (error) => tell(error.code)).once("connect", () => tell("connected")),
  ),
  told("a datagram with a callback", (tell) =>
    dgram.createSocket("udp4").send("x", udp, "127.0.0.1", (error) => tell(error?.code ?? "sent")),
  ),
  told("a datagram without one", (tell) => silent.once("error", (error) => tell(error.code)).send("x", udp, "127.0.0.1")),
  told("a lookup", (tell) => dns.lookup("localhost", (error) => tell(error?.code ?? "answered"))),
  told("a question with a callback", (tell) => resolver.resolve4("canary.invalid", (error) => tell(error?.code ?? "answered"))),
  told("a question for a promise", (tell) => promised.resolve4("canary.invalid").then(() => tell("answered"), (error) => tell(error.code))),
]);
console.log(JSON.stringify(Object.fromEntries(outcomes)));
process.exit(0);
`;

// Shows a function to whoever reads it instead of calling it: its name, how many parameters it
// has, and the properties it carries, the ones that only Node knows the names of included. Then
// it lets util.promisify() make what it makes of the two functions whose results it hands out
// under names. Printed as one line of JSON.
const LOOKS = `import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import net from "node:net";
import { promisify } from "node:util";
import workerThreads from "node:worker_threads";

const isQuestion = (name) => name === "lookup" || name === "lookupService" || name === "reverse" || name.startsWith("resolve");
const doors = {
  "dns.": dns,
  "dns.promises.": dns.promises,
  "Resolver.": dns.Resolver.prototype,
  "promises.Resolver.": dns.promises.Resolver.prototype,
};
const replaced = {
  "Socket.connect": net.Socket.prototype.connect,
  "Server.listen": net.Server.prototype.listen,
  "dgram.send": dgram.Socket.prototype.send,
  "ChildProcess.spawn": childProcess.ChildProcess.prototype.spawn,
  spawnSync: childProcess.spawnSync,
  execFileSync: childProcess.execFileSync,
  execSync: childProcess.execSync,
  Worker: workerThreads.Worker,
};
for (const [via, door] of Object.entries(doors)) {
  for (const name of Object.getOwnPropertyNames(door)) {
    if (typeof door[name] === "function" && isQuestion(name)) replaced[via + name] = door[name];
  }
}
const look = (fn) => ({
  type: typeof fn,
  name: fn.name,
  parameters: fn.length,
  properties: Reflect.ownKeys(fn).map(String).sort(),
  prototype: Object.getPrototypeOf(fn) === Function.prototype ? "Function" : Object.getPrototypeOf(fn).name,
});
console.log(
  JSON.stringify({
    looks: Object.fromEntries(Object.entries(replaced).map(([name, fn]) => [name, look(fn)])),
    lookup: Object.keys(await promisify(dns.lookup)("localhost")).sort(),
    lookupService: Object.keys(await promisify(dns.lookupService)("127.0.0.1", 80)).sort(),
    worker: new workerThreads.Worker("", { eval: true }) instanceof workerThreads.Worker,
  }),
);
`;

// Stands in for main.ts, which adds to runServer() the directory of the built web app. With a
// directory of its own, this one starts the production mode without the real build. Like
// main.ts, it takes the environment first.
const productionEntry = (
  webRoot: string,
) => `import { takeEnvironment } from ${moduleAddress("llm/credentials/scrub-env.ts")};
import { runServer } from ${moduleAddress("run-server.ts")};
await runServer({ env: takeEnvironment(), webRoot: ${JSON.stringify(webRoot)} });
`;

// Builds the client the way the server will: the environment is taken first, the credential
// comes from the provider, and the transport is the client's own, on connections that it opens
// itself. It then calls the model twice, one call after the other, and prints how each call ended.
const CLIENT = `import { createLlmClient } from ${moduleAddress("llm/client.ts")};
import { createCredentialProvider } from ${moduleAddress("llm/credentials/provider.ts")};
import { takeEnvironment } from ${moduleAddress("llm/credentials/scrub-env.ts")};
import { parseEndpoint } from ${moduleAddress("llm/endpoint.ts")};

const env = takeEnvironment();
const credentials = createCredentialProvider(
  { endpoint: parseEndpoint(env.ANTHROPIC_BASE_URL), scheme: "bearer" },
  { env, uid: process.getuid(), forbiddenRoots: [] },
);
const client = createLlmClient({ credentials });
const call = () =>
  client.messages.create({ model: "test-model", max_tokens: 16, messages: [{ role: "user", content: "Gotowe?" }] }).then(
    (message) => ({ answer: message.content[0].text }),
    (error) => ({ error: error.constructor.name, status: error.status }),
  );
console.log(JSON.stringify([await call(), await call()]));
credentials.close();
`;

const children: ChildProcess[] = [];
const sinks: Array<Server | UdpSocket> = [];
let taken: OccupiedPort | undefined;

let workDir: string;
let canary: string;
// The canary as it names itself when it starts its worker thread: Node runs a script under the
// path that is left once the links on the way are followed, and the temporary directory of macOS
// is reached through one.
let canaryThread: string;
let looks: string;
let names: string;
let refusals: string;
let production: string;
let client: string;
let logs = 0;
// The throwaway workspace that every server of this file opens, unless its test names another.
let workspace: TestWorkspace;
// The workspaces of single tests, removed after each.
const workspaces: TestWorkspace[] = [];

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "hubber-egress-"));
  canary = join(workDir, "canary.mjs");
  writeFileSync(canary, CANARY);
  canaryThread = `worker ${pathToFileURL(realpathSync(canary)).href}`;
  looks = join(workDir, "looks.mjs");
  writeFileSync(looks, LOOKS);
  names = join(workDir, "names.mjs");
  writeFileSync(names, NAMES);
  refusals = join(workDir, "refusals.mjs");
  writeFileSync(refusals, REFUSALS);
  const webRoot = join(workDir, "web");
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>Hubber</title>");
  production = join(workDir, "production.mjs");
  writeFileSync(production, productionEntry(webRoot));
  client = join(workDir, "client.mjs");
  writeFileSync(client, CLIENT);
  workspace = createTestWorkspace();
});

afterAll(() => {
  workspace.remove();
  rmSync(workDir, { recursive: true, force: true });
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const created of workspaces.splice(0)) created.remove();
  for (const sink of sinks.splice(0)) sink.close();
  await taken?.release();
  taken = undefined;
});

interface ObserverSettings {
  /** "remote" refuses whatever is not addressed to this machine, "all" this machine as well. */
  deny?: "remote" | "all";
  /** Addresses exempt from the refusal, each as "host:port". */
  allow?: readonly string[];
}

interface Observation {
  /** For the process to observe; every Node process it starts inherits it. */
  env: { NODE_OPTIONS: string };
  records: () => EgressRecord[];
}

/**
 * The observer with a log of its own. Unless told otherwise it refuses whatever is not
 * addressed to this machine: a test must send nothing out, least of all when the code under
 * test has just started to.
 */
function observation({ deny = "remote", allow = [] }: ObserverSettings = {}): Observation {
  logs += 1;
  const logFile = join(workDir, `egress-${logs}.jsonl`);
  writeFileSync(logFile, "");
  const observer = pathToFileURL(OBSERVER);
  observer.searchParams.set("log", logFile);
  observer.searchParams.set("deny", deny);
  for (const address of allow) observer.searchParams.append("allow", address);
  return {
    env: { NODE_OPTIONS: `--import=${observer.href}` },
    records: () =>
      readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as EgressRecord),
  };
}

/**
 * What left the processes, or tried to, and what was started that could: everything but the
 * notes that the observer was loaded and that a port was opened.
 */
function outgoing(records: EgressRecord[]): string[] {
  return records.flatMap((record) => {
    if (record.kind === "connect") return [`connect ${record.host}:${record.port}`];
    if (record.kind === "udp") return [`udp ${record.host}:${record.port}`];
    if (record.kind === "dns") return [`${record.via}(${record.name})`];
    if (record.kind === "spawn") return [`spawn ${record.file}`];
    if (record.kind === "worker") return [`worker ${record.script}`];
    return [];
  });
}

/** What the observer stopped. The start of a program or of a thread is never among it: that it can only record. */
function refused(records: EgressRecord[]): EgressRecord[] {
  return records.filter((record) => "refused" in record && record.refused);
}

/** How many times each name occurs. */
function tally(names: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of names) counts[name] = (counts[name] ?? 0) + 1;
  return counts;
}

/** A TCP port of this machine that answers no one and counts who came. */
async function tcpSink(): Promise<{ port: number; connections: () => Promise<number> }> {
  let connections = 0;
  let ownConnections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.on("error", () => {}).destroy();
  }).listen(0, HOST);
  sinks.push(server);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    port,
    connections: async () => {
      // Connections are taken in the order they were made. Once the sink has closed this one,
      // it has counted every earlier one, so the number is final and not a matter of timing.
      ownConnections += 1;
      const own = connect({ host: HOST, port }).on("error", () => {});
      await once(own, "close");
      return connections - ownConnections;
    },
  };
}

/** A UDP port of this machine that counts the datagrams it gets. */
async function udpSink(): Promise<{ port: number; datagrams: () => Promise<number> }> {
  const END_OF_COUNT = "end of count";
  let datagrams = 0;
  let counted: (() => void) | undefined;
  const socket = createSocket("udp4").on("message", (message) => {
    if (message.toString() === END_OF_COUNT) counted?.();
    else datagrams += 1;
  });
  sinks.push(socket);
  socket.bind(0, HOST);
  await once(socket, "listening");
  const { port } = socket.address();
  return {
    port,
    datagrams: async () => {
      // Datagrams arrive in the order they were sent. Once the sink has got this one of its
      // own, it has counted every earlier one: also when that means none.
      await new Promise<void>((resolve) => {
        counted = resolve;
        socket.send(END_OF_COUNT, port, HOST);
      });
      return datagrams;
    },
  };
}

interface Asked {
  method: string | undefined;
  path: string | undefined;
  authorization: string | undefined;
}

/**
 * The repository's stand-in for an endpoint behind a real port of this machine, under a base
 * path as a router has one. It answers the first request the way a model would, and every
 * later one with a redirect to the given address.
 */
async function standInEndpoint(redirectTo: string): Promise<{ address: string; port: number; asked: Asked[] }> {
  const basePath = "/llm";
  const model = createFakeEndpoint();
  const asked: Asked[] = [];
  const server = createHttpServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    asked.push({ method: request.method, path: request.url, authorization: request.headers.authorization });
    if (asked.length > 1) {
      response.writeHead(307, { location: `${redirectTo}${request.url}` }).end();
      return;
    }
    // The stand-in answers at the root of its origin, so the base path is taken off for it.
    const answer = await model.fetch(`http://${HOST}${request.url?.slice(basePath.length)}`, {
      method: request.method ?? "GET",
      headers: { "content-type": "application/json" },
      body: Buffer.concat(chunks),
    });
    response.writeHead(answer.status, Object.fromEntries(answer.headers)).end(Buffer.from(await answer.arrayBuffer()));
  }).listen(0, HOST);
  sinks.push(server);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { address: `http://${HOST}:${port}${basePath}`, port, asked };
}

/**
 * Waits until the server has printed the last line of its start, which says where its credential
 * comes from or that it has none. Fails with what it did print.
 */
async function started(server: SpawnedNode, lastLine = CREDENTIAL_LINE): Promise<void> {
  children.push(server.child);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!`${server.stdout()}${server.stderr()}`.includes(lastLine)) {
    if (Date.now() > deadline || server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(`The server did not finish its start.\n${server.stdout()}${server.stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * What a browser tab, a script and a page of another website do to the server in a minute of
 * use, and how the server answered each request. A server that called out for one kind of
 * request only (those of a browser, those that write, every tenth) would do it here.
 */
async function use(port: number): Promise<number[]> {
  const origin = `http://${HOST}:${port}`;
  const statuses: number[] = [];
  const ask = async (path: string, init?: RequestInit): Promise<void> => {
    const response = await fetch(`${origin}${path}`, init);
    await response.arrayBuffer();
    statuses.push(response.status);
  };
  const paths = ["/api/health", "/api/workspace", "/api/no-such-route", "/", "/some/route/of/the/app"];
  // A script, which says nothing of itself, and then the tab of a browser, twice over.
  for (const path of paths) await ask(path);
  for (const path of [...paths, ...paths]) await ask(path, { headers: BROWSER });
  // What the page itself would write, and what it would ask in its own name.
  const own = { ...BROWSER, origin, "content-type": "application/json" };
  await ask("/api/health", { method: "POST", headers: own, body: "{}" });
  await ask("/api/workspace", { method: "PUT", headers: own, body: "{}" });
  await ask("/api/workspace", { method: "DELETE", headers: own });
  await ask("/api/health", { method: "HEAD", headers: own });
  // A page of another website, and a request addressed to another host name.
  await ask("/api/health", { method: "POST", headers: { ...BROWSER, origin: "https://evil.example" } });
  await rawGet({ port, target: "/api/health", host: `attacker.example:${port}` });
  return statuses;
}

/** Runs the canary against the two sinks, to its end. */
async function runCanary(tcpPort: number, udpPort: number, env: Observation["env"]): Promise<SpawnedNode> {
  const run = spawnNode(canary, { args: [String(tcpPort), String(udpPort)], env });
  children.push(run.child);
  expect(await run.exited, run.stderr()).toEqual({ code: 0, signal: null });
  return run;
}

describe("the egress observer", { timeout: TEST_TIMEOUT_MS }, () => {
  it("sees every way out of a process, of its worker thread and of its child process", async () => {
    // The questions the canary asks the resolver are read off the Node at hand, here and in the
    // canary alike. If a Node moved those functions elsewhere, the list would be short or empty,
    // and both would agree on a canary that asks nothing.
    for (const [via, door] of RESOLVER_DOORS) expect(questionsOf(door).length, via).toBeGreaterThanOrEqual(15);
    expect(EVERY_QUESTION).toEqual(
      expect.arrayContaining([
        `dns.resolve4(${UNSENDABLE})`,
        `dns.reverse(${UNSENDABLE})`,
        `dns.promises.resolveTxt(${UNSENDABLE})`,
        `Resolver.resolveAny(${UNSENDABLE})`,
        `promises.Resolver.resolveMx(${UNSENDABLE})`,
      ]),
    );
    const tcp = await tcpSink();
    const udp = await udpSink();
    const { env, records } = observation();

    const run = await runCanary(tcp.port, udp.port, env);

    const seen = records();
    const where = (record: EgressRecord): string => {
      if (record.pid !== run.child.pid) return "child process";
      return record.thread === 0 ? "main thread" : "worker thread";
    };
    // The observer was in all three. A second worker thread, started from a string of code, ran
    // without it: of that one the log has the start and nothing else.
    expect(tally(seen.filter((record) => record.kind === "loaded").map(where))).toEqual({
      "main thread": 1,
      "worker thread": 1,
      "child process": 1,
    });
    // fetch by address and by name, net.connect, tls.connect, http.get, WebSocket and a socket
    // that is told where to go in each of three ways, in the main thread; fetch in the worker
    // thread and in the child process.
    const connects = seen.filter((record) => record.kind === "connect" && record.port === tcp.port);
    expect(tally(connects.map(where))).toEqual({ "main thread": 9, "worker thread": 1, "child process": 1 });
    expect(connects.filter((record) => record.kind === "connect" && record.tls)).toHaveLength(1);
    // The sink says the same, so nothing got out unseen and nothing seen was made up.
    expect(await tcp.connections()).toBe(11);
    const stopped = [
      // The three questions that could have been sent, each to the sink.
      "Resolver.resolve4(canary.invalid)",
      "Resolver.reverse(192.0.2.1)",
      "promises.Resolver.resolveTxt(canary.invalid)",
      ...EVERY_QUESTION,
    ];
    expect(new Set(outgoing(seen))).toEqual(
      new Set([
        `connect ${HOST}:${tcp.port}`,
        `connect localhost:${tcp.port}`,
        `connect ${NO_SUCH_SOCKET}:0`,
        "dns.lookup(localhost)",
        "dns.promises.lookup(localhost)",
        `dns.lookupService(${HOST})`,
        `dns.promises.lookupService(${HOST})`,
        `udp ${HOST}:${udp.port}`,
        // A datagram that names no address goes to this machine.
        `udp localhost:${udp.port}`,
        ...stopped,
        `spawn ${process.execPath}`,
        "spawn /usr/bin/true",
        "spawn /usr/bin/false",
        "spawn /bin/echo canary",
        canaryThread,
        "worker (code)",
      ]),
    );
    // Every datagram arrived: eight sent to an address in one form or another, two through a
    // connected socket. No question of the resolver did. Each asks about a name that is not this
    // machine's, so the observer refused it, although the server three of them were meant for is
    // the sink.
    expect(await udp.datagrams()).toBe(10);
    expect(new Set(outgoing(refused(seen)))).toEqual(new Set(stopped));
    expect(refused(seen)).toHaveLength(stopped.length);
    // The two ports the canary opened, where the system picked the number.
    expect(seen.filter((record) => record.kind === "listen")).toMatchObject([
      { host: HOST, port: 0 },
      { host: HOST, port: 0 },
    ]);
    // Each record says where in the code it comes from: in the lines of whoever was observed,
    // never in those of the observer.
    const stacks = seen.map((record) => record.stack.join("\n"));
    expect(stacks.filter((stack) => stack.includes("egress-observer"))).toEqual([]);
    const sockets = seen.filter((record) => record.kind === "connect" && record.host === NO_SUCH_SOCKET);
    expect(sockets.map((record) => record.stack.some((frame) => frame.includes(realpathSync(canary))))).toEqual([
      true,
      true,
    ]);
  });

  it("refuses what is not addressed to this machine, before a name is resolved or a packet is sent", async () => {
    const { env, records } = observation();
    const script = join(workDir, "remote.mjs");
    // A name reserved for documentation: nothing answers there, and nothing may be asked.
    writeFileSync(
      script,
      `const sending = fetch("https://router.corp.example/v1/messages", { method: "POST", body: "note" });
console.log(await sending.then(() => "sent", (error) => error.cause?.code));
`,
    );

    const run = spawnNode(script, { env });
    children.push(run.child);
    await run.exited;

    expect(run.stdout().trim()).toBe("ERR_EGRESS_REFUSED");
    expect(records().filter((record) => record.kind !== "loaded")).toMatchObject([
      { kind: "connect", host: "router.corp.example", port: 443, tls: true, refused: true },
    ]);
  });

  it("refuses this machine too when told to deny everything, and lets through only the allowed address", async () => {
    const tcp = await tcpSink();
    const udp = await udpSink();
    const { env, records } = observation({ deny: "all", allow: [`localhost:${tcp.port}`] });

    await runCanary(tcp.port, udp.port, env);

    const seen = records();
    const stopped = refused(seen);
    expect(tally(outgoing(stopped))).toEqual({
      // The nine connections made by number are among them: the same port under another
      // spelling of the host is not the address that was allowed.
      [`connect ${HOST}:${tcp.port}`]: 9,
      // Six datagrams for an address, four for none. A datagram that is stopped is seen once.
      [`udp ${HOST}:${udp.port}`]: 6,
      [`udp localhost:${udp.port}`]: 4,
      // The address of this machine is no name that was allowed.
      [`dns.lookupService(${HOST})`]: 1,
      [`dns.promises.lookupService(${HOST})`]: 1,
      "Resolver.resolve4(canary.invalid)": 1,
      "Resolver.reverse(192.0.2.1)": 1,
      "promises.Resolver.resolveTxt(canary.invalid)": 1,
      ...Object.fromEntries(EVERY_QUESTION.map((question) => [question, 1])),
    });
    expect(tally(outgoing(seen.filter((record) => !stopped.includes(record))))).toEqual({
      // By fetch and by the socket that was given the port alone.
      [`connect localhost:${tcp.port}`]: 2,
      // The name of an allowed address may be resolved: once for each of those two, and once more
      // where the canary asks for it.
      "dns.lookup(localhost)": 2,
      "dns.promises.lookup(localhost)": 1,
      // A local socket is recorded and never refused: it does not lead to the network.
      [`connect ${NO_SUCH_SOCKET}:0`]: 2,
      // Neither is the start of a program or of a thread.
      [`spawn ${process.execPath}`]: 1,
      "spawn /usr/bin/true": 1,
      "spawn /usr/bin/false": 1,
      "spawn /bin/echo canary": 1,
      [canaryThread]: 1,
      "worker (code)": 1,
    });
    // The sinks agree: the two connections that were allowed, and no datagram.
    expect(await tcp.connections()).toBe(2);
    expect(await udp.datagrams()).toBe(0);
  });

  it("stops a process that hands it a setting it does not know", async () => {
    // Ignored, the setting would leave a test without the refusal it asked for.
    const { env, records } = observation({ deny: "everything" as "all" });
    const script = join(workDir, "started.mjs");
    writeFileSync(script, 'console.log("started");\n');

    const run = spawnNode(script, { env });
    children.push(run.child);

    expect(await run.exited).toEqual({ code: 1, signal: null });
    expect(run.stderr()).toContain("egress-observer: unknown setting deny=everything.");
    expect(run.stdout()).toBe("");
    expect(records()).toEqual([]);

    // Nor does it watch without a place to write to: what it saw would be lost.
    const unlogged = spawnNode(script, { env: { NODE_OPTIONS: `--import=${pathToFileURL(OBSERVER).href}` } });
    children.push(unlogged.child);
    expect(await unlogged.exited).toEqual({ code: 1, signal: null });
    expect(unlogged.stderr()).toContain("egress-observer: the address it is loaded from names no log file (?log=).");
    expect(unlogged.stdout()).toBe("");
  });

  it("takes for this machine what is this machine, and nothing that only looks like it", async () => {
    const udp = await udpSink();
    const { env, records } = observation();
    const own = ["localhost", "LocalHost", "::1", "[::1]", HOST, "127.1.2.3", "127.255.255.254"];
    const foreign = [
      "router.corp.example",
      "192.0.2.1",
      "0.0.0.0",
      "128.0.0.1",
      "::2",
      // Names, not addresses: whoever answers for them decides where they lead.
      "127.evil.example",
      "127.0.0.1.evil.example",
      "localhost.evil.example",
      "127.0.0.999",
      "127.1",
      "1270.0.0.1",
    ];

    const run = spawnNode(names, { args: [String(udp.port), ...own, ...foreign], env });
    children.push(run.child);
    expect(await run.exited, run.stderr()).toEqual({ code: 0, signal: null });

    // Asked through a resolver whose only server is the sink, so that a name taken for this
    // machine by mistake is asked about on this machine and nowhere else.
    const asked = records().flatMap((record) => (record.kind === "dns" ? [record] : []));
    expect(asked.filter((record) => !record.refused).map((record) => record.name)).toEqual(own);
    expect(asked.filter((record) => record.refused).map((record) => record.name)).toEqual(foreign);
  });

  it("fails what it refuses the way the real thing fails, for whoever asked", async () => {
    const tcp = await tcpSink();
    const udp = await udpSink();
    const { env, records } = observation({ deny: "all" });

    const run = spawnNode(refusals, { args: [String(tcp.port), String(udp.port)], env });
    children.push(run.child);
    expect(await run.exited, run.stderr()).toEqual({ code: 0, signal: null });

    // Each caller is told, in the place where it listens for a failure, and none is left waiting.
    expect(JSON.parse(run.stdout())).toEqual({
      "a connection": "ERR_EGRESS_REFUSED",
      "a datagram with a callback": "ERR_EGRESS_REFUSED",
      "a datagram without one": "ERR_EGRESS_REFUSED",
      "a lookup": "ERR_EGRESS_REFUSED",
      "a question with a callback": "ERR_EGRESS_REFUSED",
      "a question for a promise": "ERR_EGRESS_REFUSED",
    });
    expect(refused(records())).toHaveLength(6);
    expect(await tcp.connections()).toBe(0);
    expect(await udp.datagrams()).toBe(0);
  });

  it("leaves every function it stands in for as it was, for whoever reads it instead of calling it", async () => {
    const look = async (env: Record<string, string>): Promise<string> => {
      const run = spawnNode(looks, { env });
      children.push(run.child);
      expect(await run.exited, run.stderr()).toEqual({ code: 0, signal: null });
      return run.stdout();
    };

    const observed = await look(observation().env);
    const untouched = await look({});

    // An observed process has to behave like any other, or what is proven of it is proven of
    // nothing: the same names, numbers of parameters and properties, and so the same results
    // from whatever goes by them, like util.promisify().
    expect(observed).toBe(untouched);
    expect(JSON.parse(observed)).toMatchObject({
      looks: {
        "dns.lookup": { type: "function", name: "lookup", parameters: 3 },
        Worker: { type: "function", name: "Worker" },
      },
      lookup: ["address", "family"],
      lookupService: ["hostname", "service"],
      worker: true,
    });
    // Every question function of every door was looked at, beside the eight other stand-ins.
    expect(Object.keys((JSON.parse(observed) as { looks: object }).looks).length).toBeGreaterThanOrEqual(
      EVERY_QUESTION.length + 8,
    );
  });
});

// The claim itself, for what exists today: the server, which has no reason yet to call its
// endpoint, and the client that later packages will call it with.
describe("what leaves the process (NFR-1)", { timeout: TEST_TIMEOUT_MS }, () => {
  /** One way of starting the server: what runs, with which settings, and how its start ends. */
  interface Start {
    script: string;
    env: Record<string, string>;
    /** The last line of the start. */
    lastLine: string;
    /** What the start has to say on stderr; nothing, unless given. */
    stderr?: string;
    /** The workspace to open in place of this file's own. */
    workspace?: TestWorkspace;
  }
  // Each start is a server that has what it would take to call out: the address its workspace
  // is pinned to and, in all but one, a credential for it.
  const withToken = { ANTHROPIC_BASE_URL: TEST_WORKSPACE.endpoint, ANTHROPIC_AUTH_TOKEN: TOKEN };
  /** A file that holds a helper command for the workspace's endpoint: a credential that takes a program to get. */
  const withHelper = (): Pick<Start, "env" | "lastLine"> => {
    const file = join(workDir, "credentials-with-helper.json");
    const endpoints = { [TEST_WORKSPACE.endpoint]: { helper: { command: ["/usr/bin/true"] } } };
    writeFileSync(file, JSON.stringify({ version: 1, endpoints }), { mode: 0o600 });
    return {
      env: { HUBBER_CREDENTIALS_FILE: file },
      lastLine: `Poświadczenia: polecenie pomocnicze "/usr/bin/true" (z pliku "${file}").`,
    };
  };
  /**
   * A workspace as it was created before the application had a schema: the start has to bring its
   * database up to date first, with a copy of it, and says so on stderr when it is done.
   */
  const withMigration = (): Pick<Start, "workspace" | "stderr"> => {
    const unmigrated = createUnmigratedTestWorkspace();
    workspaces.push(unmigrated);
    return {
      workspace: unmigrated,
      stderr: `Baza zaktualizowana. Kopia sprzed aktualizacji: "${unmigrated.dir}/backups/`,
    };
  };
  /** A home directory with nothing in it: no credentials file, and no workspace at the default place. */
  const withHome = (): Pick<Start, "env" | "lastLine" | "stderr"> => {
    const home = join(workDir, "home");
    mkdirSync(home, { recursive: true });
    return { env: { HOME: home }, lastLine: WITHOUT_CREDENTIAL, stderr: WITHOUT_CREDENTIAL };
  };

  it.each<[which: string, launch: () => Start]>([
    [
      "in development mode",
      () => ({
        script: "src/server/main.ts",
        env: { ...withToken, HUBBER_DEV_ORIGIN: DEV_ORIGIN },
        lastLine: CREDENTIAL_LINE,
      }),
    ],
    ["in production mode", () => ({ script: production, env: withToken, lastLine: CREDENTIAL_LINE })],
    // Without a credential there is one more branch of the start to go through, and with a home
    // directory two more places it could look in: the credentials file and the default workspace.
    ["that has a home directory and no credential", () => ({ script: production, ...withHome() })],
    // The command is for the first call of the model. A start must not run it.
    ["whose credential is a helper command", () => ({ script: production, ...withHelper() })],
    // A start that migrates does more than any other before it answers: it copies the database
    // and rewrites it. None of that is a reason to call out, or to start a program.
    [
      "that has to migrate the database of its workspace first",
      () => ({ script: production, env: withToken, lastLine: CREDENTIAL_LINE, ...withMigration() }),
    ],
  ])("is nothing at all for the server %s, from its start through requests to its shutdown", async (_which, launch) => {
    const [port] = await freePorts(1);
    const { env, records } = observation();
    const { script, env: own, lastLine, stderr = "", workspace: opened = workspace } = launch();

    const server = spawnNode(script, { env: { ...env, ...opened.env, ...own, HUBBER_PORT: String(port) } });
    await started(server, lastLine);
    const statuses = await use(port);
    server.child.kill("SIGTERM");
    expect(await server.exited, server.stderr()).toEqual({ code: 0, signal: null });

    // It ran on the workspace, with nothing to say on stderr about that or about the observer.
    expect(server.stdout()).toContain(`Workspace „${TEST_WORKSPACE.name}”: katalog "${opened.dir}"`);
    // And the start that had to migrate did: the copy from before is there.
    if (opened !== workspace) expect(readdirSync(join(opened.dir, "backups"))).toHaveLength(1);
    expect(server.stderr()).toContain(stderr);
    if (stderr === "") expect(server.stderr()).toBe("");
    // The requests were the server's to answer: those of the page got through its guard (there
    // is nothing to write to yet, so its writes found no route), the one of another website did not.
    expect(statuses.slice(0, 15).filter((status) => status === 403)).toEqual([]);
    expect(statuses.slice(15)).toEqual([404, 404, 404, 200, 403]);
    const seen = records();
    // The observer was in the process, which was the only one, and saw it open its one port.
    expect(seen.filter((record) => record.kind === "loaded")).toHaveLength(1);
    expect(seen.filter((record) => record.kind === "listen")).toMatchObject([{ host: HOST, port }]);
    // No connection, no datagram, no name to resolve, and no program or thread that could have
    // made one unseen. Nothing calls the model yet; once something does, this list holds the
    // connections to the endpoint of the workspace, and nothing else.
    expect(outgoing(seen)).toEqual([]);
    // Nothing was put under the home directory either.
    if (own.HOME !== undefined) expect(readdirSync(own.HOME)).toEqual([]);
  });

  // A start that ends in a refusal is a start all the same: the reason goes to the terminal and
  // to nobody else.
  it.each([
    [
      "its workspace is pinned to another endpoint than the environment names",
      3,
      () => ({ ...workspace.env, ANTHROPIC_BASE_URL: "https://router.corp.example/llm", ANTHROPIC_AUTH_TOKEN: TOKEN }),
      "jest przypięty do endpointu",
    ],
    [
      "there is no workspace where the environment says",
      1,
      () => ({ HUBBER_WORKSPACE: join(workDir, "no-workspace-here") }),
      "ze zmiennej HUBBER_WORKSPACE nie istnieje",
    ],
    [
      "the environment names an address that is none",
      2,
      () => ({ ...workspace.env, ANTHROPIC_BASE_URL: "router.corp.example" }),
      "nie nadaje się na adres endpointu",
    ],
    // The three above end before the database is opened. This one opens it, announces the update
    // and is refused where the update begins: something that is no directory lies where the copies
    // go. It has the address and the credential, as a start that would go on to serve has.
    [
      "the database of its workspace has to be migrated and cannot be copied first",
      1,
      () => {
        const unmigrated = createUnmigratedTestWorkspace();
        workspaces.push(unmigrated);
        writeFileSync(join(unmigrated.dir, "backups"), "");
        return { ...unmigrated.env, ANTHROPIC_BASE_URL: TEST_WORKSPACE.endpoint, ANTHROPIC_AUTH_TOKEN: TOKEN };
      },
      "nie udało się zrobić kopii bazy przed aktualizacją",
    ],
  ])("is nothing at all for a server that refuses to start because %s", async (_why, code, environment, reason) => {
    const [port] = await freePorts(1);
    const { env, records } = observation();

    const server = spawnNode("src/server/main.ts", {
      env: { ...env, ...environment(), HUBBER_PORT: String(port), HUBBER_DEV_ORIGIN: DEV_ORIGIN },
    });
    children.push(server.child);

    expect(await server.exited, server.stderr()).toEqual({ code, signal: null });
    expect(server.stderr()).toContain(reason);
    expect(server.stdout()).toBe("");
    const seen = records();
    expect(seen.filter((record) => record.kind === "loaded")).toHaveLength(1);
    // The port it had bound by then, and nothing that leads anywhere.
    expect(seen.filter((record) => record.kind === "listen")).toMatchObject([{ host: HOST, port }]);
    expect(outgoing(seen)).toEqual([]);
  });

  it("is the start of lsof and ps, and nothing else, for a server that finds its port taken", async () => {
    taken = await occupyPort();
    const { env, records } = observation();

    // With its workspace, like every start: the place of the workspace is read before the port.
    const server = spawnNode("src/server/main.ts", {
      env: { ...env, ...workspace.env, HUBBER_PORT: String(taken.port), HUBBER_DEV_ORIGIN: DEV_ORIGIN },
    });
    children.push(server.child);
    expect(await server.exited).toEqual({ code: 1, signal: null });

    expect(server.stderr()).toContain(`Port ${taken.port} na ${HOST} jest zajęty przez proces ${process.pid}`);
    expect(new Set(outgoing(records()))).toEqual(new Set(["spawn lsof", "spawn ps"]));
  });

  it("is only what the SDK client sends to the endpoint it is pinned to, and nothing to where a redirect points", async () => {
    const elsewhere = await tcpSink();
    const endpoint = await standInEndpoint(`http://${HOST}:${elsewhere.port}`);
    // Everything is refused but the endpoint, this machine included: whatever else the client or
    // the SDK tries is stopped, and shows in the log.
    const { env, records } = observation({ deny: "all", allow: [`${HOST}:${endpoint.port}`] });

    const run = spawnNode(client, {
      env: { ...env, ANTHROPIC_BASE_URL: endpoint.address, ANTHROPIC_AUTH_TOKEN: TOKEN },
    });
    children.push(run.child);
    expect(await run.exited, run.stderr()).toEqual({ code: 0, signal: null });

    // The first call was answered. The second got a redirect for an answer and ended with it.
    expect(JSON.parse(run.stdout())).toEqual([{ answer: "gotowe" }, { error: "APIError", status: 307 }]);
    // Two requests, both under the base path and with the credential: the redirect was not tried again either.
    const request = { method: "POST", path: "/llm/v1/messages", authorization: `Bearer ${TOKEN}` };
    expect(endpoint.asked).toEqual([request, request]);
    const seen = records();
    expect(seen.filter((record) => record.kind === "loaded")).toHaveLength(1);
    // Every connection went to the endpoint, and there was nothing to stop: no other address,
    // no name to resolve, no datagram, no program and no thread.
    expect(new Set(outgoing(seen))).toEqual(new Set([`connect ${HOST}:${endpoint.port}`]));
    expect(refused(seen)).toEqual([]);
    // The address in the redirect saw nobody.
    expect(await elsewhere.connections()).toBe(0);
  });
});
