import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DIRECT_TRANSPORT, readTransportState, type TransportState } from "./transport.ts";

const HOST = "127.0.0.1";
const DISPATCHER_KEY = Symbol.for("undici.globalDispatcher.2");
// Each case starts a process. On a busy machine that takes longer than a test usually may.
const SPAWN_TIMEOUT_MS = 30_000;

// What a started process reports: the state as transport.ts reads it, and beside it what Node
// really does, which is what the state has to foretell.
interface Report {
  state: TransportState;
  /** Who answered a plain fetch() to the stand-in endpoint: "endpoint", "proxy", or "error: …". */
  answeredBy: string;
  /** Node itself said that it makes TLS connections without the certificate check. */
  nodeSaysUnchecked: boolean;
}

// The state is read first, as the server reads it at start: before this process has made a request.
const PROBE = (transportModule: string) => `import { connect } from "node:tls";
import { readTransportState } from ${JSON.stringify(transportModule)};

const state = readTransportState();
const warnings = [];
process.on("warning", (warning) => warnings.push(warning.message));

let answeredBy;
try {
  answeredBy = await (await fetch(process.argv[2])).text();
} catch (error) {
  answeredBy = \`error: \${error.cause?.message ?? error.message}\`;
}

// Node warns once, at the first TLS client it makes without the certificate check.
const socket = connect({ host: "127.0.0.1", port: Number(new URL(process.argv[2]).port) });
socket.on("error", () => {});
socket.destroy();
await new Promise((done) => setImmediate(done));

console.log(
  JSON.stringify({
    state,
    answeredBy,
    nodeSaysUnchecked: warnings.some((message) => message.includes("NODE_TLS_REJECT_UNAUTHORIZED")),
  }),
);
`;

// Loaded before the script, in the place of the default dispatcher: it says so when it is asked.
const STAND_IN_DISPATCHER = `class StandInDispatcher {
  dispatch(options) {
    throw new Error(\`the stand-in dispatcher was asked for \${options.origin}\`);
  }
  close() {}
  destroy() {}
}
globalThis[Symbol.for("undici.globalDispatcher.2")] = new StandInDispatcher();
`;

// Loaded before the script. It builds a dispatcher of the default class, from that class itself,
// with a way of connecting of its own: every connection goes to the port named in STAND_IN_PORT.
const DEFAULT_CLASS_ELSEWHERE = `const net = require("node:net");
new Headers();
const key = Symbol.for("undici.globalDispatcher.2");
const Agent = globalThis[key].constructor;
globalThis[key] = new Agent({
  connect(_options, callback) {
    const socket = net.connect(Number(process.env.STAND_IN_PORT), "127.0.0.1", () => callback(null, socket));
    socket.once("error", callback);
  },
});
`;

let workDir: string;
let probe: string;
let proxy: Server;
let endpoint: Server;
let proxyUrl: string;
let endpointUrl: string;

function listen(answer: string): Promise<Server> {
  return new Promise((done) => {
    const server = createServer((_request, response) => response.end(answer));
    server.listen(0, HOST, () => done(server));
  });
}

const addressOf = (server: Server) => `http://${HOST}:${(server.address() as AddressInfo).port}`;

function file(name: string, content: string): string {
  const path = join(workDir, name);
  writeFileSync(path, content);
  return path;
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "hubber-transport-"));
  probe = file("probe.mjs", PROBE(pathToFileURL(join(import.meta.dirname, "transport.ts")).href));
  proxy = await listen("proxy");
  endpoint = await listen("endpoint");
  proxyUrl = addressOf(proxy);
  endpointUrl = addressOf(endpoint);

  file("node-options.json", JSON.stringify({ nodeOptions: { "use-env-proxy": true } }));
  mkdirSync(join(workDir, "configured"));
  file("configured/node.config.json", JSON.stringify({ nodeOptions: { "use-env-proxy": true } }));
  file("option.env", "NODE_OPTIONS=--use_env_proxy\n");
  file("variable.env", "NODE_USE_ENV_PROXY=1\n");
  file("unchecked.env", "NODE_TLS_REJECT_UNAUTHORIZED=0\n");
  file("proxy-from-env.mjs", 'import http from "node:http";\nhttp.setGlobalProxyFromEnv();\n');
  file(
    "proxy-for-https.cjs",
    `require("node:http").setGlobalProxyFromEnv({ HTTPS_PROXY: ${JSON.stringify(proxyUrl)} });\n`,
  );
  file("stand-in-dispatcher.cjs", STAND_IN_DISPATCHER);
  file("default-class-elsewhere.cjs", DEFAULT_CLASS_ELSEWHERE);
  file("unchecked.cjs", 'process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";\n');
});

afterAll(async () => {
  for (const server of [proxy, endpoint]) await new Promise((done) => server.close(done));
  rmSync(workDir, { recursive: true, force: true });
});

interface Start {
  nodeArgs?: string[];
  env?: Record<string, string>;
  /** A directory of the test's files to start in. */
  cwd?: string;
  /** Whether the proxy variables are set. They are, unless the case is about a process without them. */
  proxyVariables?: boolean;
}

/**
 * Starts the probe in a process of its own and resolves with its report. The environment is built
 * from scratch, so that nothing of the developer's own shell decides the outcome.
 */
function report({ nodeArgs = [], env = {}, cwd, proxyVariables = true }: Start): Promise<Report> {
  // A name of a file stands for the file among the test's own.
  const args = nodeArgs.map((arg) => arg.replace("<dir>", workDir));
  const child = spawn(process.execPath, [...args, probe, `${endpointUrl}/llm`], {
    cwd: cwd === undefined ? workDir : join(workDir, cwd),
    env: {
      PATH: process.env.PATH ?? "",
      ...(proxyVariables && { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl }),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((done, fail) => {
    child.once("close", (code) => {
      if (code !== 0) fail(new Error(`The probe exited with code ${code}.\n${stdout}${stderr}`));
      else done(JSON.parse(stdout) as Report);
    });
  });
}

const VIA_PROXY: TransportState = { ...DIRECT_TRANSPORT, proxySupport: true, replacedDispatcher: "EnvHttpProxyAgent" };

describe("readTransportState, in a process of its own", { timeout: SPAWN_TIMEOUT_MS }, () => {
  it("finds a direct transport in a process that nothing was done to, although the proxy variables are set", async () => {
    expect(await report({})).toEqual({ state: DIRECT_TRANSPORT, answeredBy: "endpoint", nodeSaysUnchecked: false });
  });

  // Every way in which Node 26 can be told to use a proxy. In each of them a request for the
  // endpoint is answered by the proxy, and in each of them the state says so beforehand.
  it.each<[string, Start]>([
    ["the variable NODE_USE_ENV_PROXY=1", { env: { NODE_USE_ENV_PROXY: "1" } }],
    ["the option --use-env-proxy", { nodeArgs: ["--use-env-proxy"] }],
    ["the option spelled --use_env_proxy", { nodeArgs: ["--use_env_proxy"] }],
    ["the option spelled --use-env_proxy", { nodeArgs: ["--use-env_proxy"] }],
    // A value does not switch it off: Node takes the option for given.
    ["the option with a value, --use-env-proxy=false", { nodeArgs: ["--use-env-proxy=false"] }],
    ["the option after its own negation", { nodeArgs: ["--no-use-env-proxy", "--use-env-proxy"] }],
    ["the option in NODE_OPTIONS", { env: { NODE_OPTIONS: "--use-env-proxy" } }],
    [
      "the option among others in NODE_OPTIONS",
      { env: { NODE_OPTIONS: "--no-warnings --use-env-proxy --no-deprecation" } },
    ],
    ["the option spelled --use_env_proxy in NODE_OPTIONS", { env: { NODE_OPTIONS: "--use_env_proxy" } }],
    // Node removes quotes and backslashes when it reads NODE_OPTIONS.
    ["the option with quotes inside it in NODE_OPTIONS", { env: { NODE_OPTIONS: '--use-"env"-proxy' } }],
    ["the option with a backslash inside it in NODE_OPTIONS", { env: { NODE_OPTIONS: '"--use-env\\-proxy"' } }],
    ["a Node configuration file", { nodeArgs: ["--experimental-config-file=<dir>/node-options.json"] }],
    [
      "the Node configuration file of the directory it starts in",
      { nodeArgs: ["--experimental-default-config-file"], cwd: "configured" },
    ],
    ["a file of variables that sets NODE_OPTIONS", { nodeArgs: ["--env-file=<dir>/option.env"] }],
    ["a module loaded first that switches the proxy on", { nodeArgs: ["--import=<dir>/proxy-from-env.mjs"] }],
  ])("finds the proxy in a process started with %s", async (_what, start) => {
    expect(await report(start)).toEqual({ state: VIA_PROXY, answeredBy: "proxy", nodeSaysUnchecked: false });
  });

  // Without a proxy variable Node has nowhere to send a request, so this one arrives. The support
  // is on all the same: Node was told to use a proxy, and only not told which.
  it.each<[string, Start]>([
    ["the variable NODE_USE_ENV_PROXY=1", { env: { NODE_USE_ENV_PROXY: "1" } }],
    ["the option spelled --use_env_proxy", { nodeArgs: ["--use_env_proxy"] }],
    ["a Node configuration file", { nodeArgs: ["--experimental-config-file=<dir>/node-options.json"] }],
  ])("finds the proxy support on in a process started with %s and no proxy variable", async (_what, start) => {
    expect(await report({ ...start, proxyVariables: false })).toEqual({
      state: { ...DIRECT_TRANSPORT, proxySupport: true },
      answeredBy: "endpoint",
      nodeSaysUnchecked: false,
    });
  });

  it("finds the proxy that a module loaded first set for https addresses alone", async () => {
    // The request of the probe is an http one and goes straight; one for an https endpoint would not.
    expect(await report({ nodeArgs: ["--require=<dir>/proxy-for-https.cjs"], proxyVariables: false })).toEqual({
      state: VIA_PROXY,
      answeredBy: "endpoint",
      nodeSaysUnchecked: false,
    });
  });

  it("finds a dispatcher that a module loaded first put in the place of the default one", async () => {
    const found = await report({ nodeArgs: ["--require=<dir>/stand-in-dispatcher.cjs"] });

    expect(found.state).toEqual({ ...DIRECT_TRANSPORT, replacedDispatcher: "StandInDispatcher" });
    // The request went to the stand-in: the place this module looks at is the one fetch() uses.
    expect(found.answeredBy).toBe(`error: the stand-in dispatcher was asked for ${endpointUrl}`);
  });

  it("finds a dispatcher of the default class that a module loaded first built to connect elsewhere", async () => {
    const found = await report({
      nodeArgs: ["--require=<dir>/default-class-elsewhere.cjs"],
      env: { STAND_IN_PORT: new URL(proxyUrl).port },
      proxyVariables: false,
    });

    // Its class is the default one, and the request for the endpoint arrived somewhere else.
    expect(found).toEqual({
      state: { ...DIRECT_TRANSPORT, replacedDispatcher: "Agent" },
      answeredBy: "proxy",
      nodeSaysUnchecked: false,
    });
  });

  // What looks like one of the settings above and is none: Node connects directly, and the
  // state says that, where a comparison of the options and variables would say the opposite.
  it.each<[string, Start]>([
    ["NODE_USE_ENV_PROXY set to anything but 1", { env: { NODE_USE_ENV_PROXY: "true" } }],
    [
      "NODE_USE_ENV_PROXY=1 and the option that takes it back",
      { env: { NODE_USE_ENV_PROXY: "1" }, nodeArgs: ["--no-use-env-proxy"] },
    ],
    ["the option and then its negation", { nodeArgs: ["--use-env-proxy", "--no-use-env-proxy"] }],
    [
      "the option in NODE_OPTIONS and its negation on the command line",
      { env: { NODE_OPTIONS: "--use-env-proxy" }, nodeArgs: ["--no-use-env-proxy"] },
    ],
    ["a Node configuration file that is not asked for", { cwd: "configured" }],
  ])("finds a direct transport in a process started with %s", async (_what, start) => {
    expect(await report(start)).toEqual({ state: DIRECT_TRANSPORT, answeredBy: "endpoint", nodeSaysUnchecked: false });
  });

  it("agrees with what Node does about NODE_USE_ENV_PROXY=1 from a file of variables, whichever that is", async () => {
    // Node 26.5 reads this variable before it reads the file, so the proxy stays off. Whether a
    // later Node sees it differently is not for this module to know: it only has to say the same.
    const found = await report({ nodeArgs: ["--env-file=<dir>/variable.env"] });

    expect(found.state.proxySupport).toBe(found.answeredBy === "proxy");
    expect(found.state.replacedDispatcher).toBe(found.answeredBy === "proxy" ? "EnvHttpProxyAgent" : undefined);
  });

  it.each<[string, Start]>([
    ["the variable NODE_TLS_REJECT_UNAUTHORIZED=0", { env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } }],
    ["a file of variables that sets it", { nodeArgs: ["--env-file=<dir>/unchecked.env"] }],
    ["a module loaded first that sets it", { nodeArgs: ["--require=<dir>/unchecked.cjs"] }],
  ])("finds the certificate check off in a process started with %s", async (_what, start) => {
    expect(await report(start)).toEqual({
      state: { ...DIRECT_TRANSPORT, certificatesUnchecked: true },
      answeredBy: "endpoint",
      nodeSaysUnchecked: true,
    });
  });

  // Node switches the check off for exactly "0".
  it.each(["1", "", "00", "false", " 0"])(
    "finds the certificate check on with NODE_TLS_REJECT_UNAUTHORIZED set to %j",
    async (value) => {
      expect(await report({ env: { NODE_TLS_REJECT_UNAUTHORIZED: value } })).toEqual({
        state: DIRECT_TRANSPORT,
        answeredBy: "endpoint",
        nodeSaysUnchecked: false,
      });
    },
  );
});

describe("readTransportState, in the process of the tests", () => {
  const globals = globalThis as Record<symbol, unknown>;
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
    vi.unstubAllEnvs();
  });

  /** Puts something in the place of the default dispatcher until the test is over. */
  function plant(dispatcher: unknown): void {
    const had = Object.hasOwn(globals, DISPATCHER_KEY);
    const original = globals[DISPATCHER_KEY];
    globals[DISPATCHER_KEY] = dispatcher;
    restore = () => {
      if (had) globals[DISPATCHER_KEY] = original;
      else delete globals[DISPATCHER_KEY];
    };
  }

  function instanceOfClassNamed(name: string): object {
    const Renamed = class {};
    Object.defineProperty(Renamed, "name", { value: name });
    return new Renamed();
  }

  it("reads the certificate check from the live environment, at the moment it is asked", () => {
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    expect(readTransportState().certificatesUnchecked).toBe(true);

    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "1");
    expect(readTransportState().certificatesUnchecked).toBe(false);
  });

  /** An object of a class named like the default one, with what an agent keeps of its settings. */
  function agentWith(options: Record<string, unknown>, factory: () => void = function defaultFactory() {}): object {
    return Object.assign(new (class Agent {})(), { [Symbol("options")]: options, [Symbol("factory")]: factory });
  }

  it("takes a dispatcher of the default class with the default settings for the default one", () => {
    plant(agentWith({ maxOrigins: Number.POSITIVE_INFINITY, connect: undefined }));
    expect(readTransportState().replacedDispatcher).toBeUndefined();

    // Settings that do not say where or how to connect are none of its business.
    plant(agentWith({ maxOrigins: 8, connect: null, headersTimeout: 30_000 }));
    expect(readTransportState().replacedDispatcher).toBeUndefined();

    // And where an agent shows nothing of its settings, there is nothing to hold against it.
    plant(new (class Agent {})());
    expect(readTransportState().replacedDispatcher).toBeUndefined();
  });

  it.each<[string, () => object]>([
    [
      "connection options, as for leaving certificates unchecked",
      () => agentWith({ connect: { rejectUnauthorized: false } }),
    ],
    ["a function that makes the connections", () => agentWith({ connect: () => {} })],
    ["the older name of the connection options", () => agentWith({ tls: { rejectUnauthorized: false } })],
    ["a socket of this machine to connect to", () => agentWith({ socketPath: "/var/run/elsewhere.sock" })],
    ["a factory of its own", () => agentWith({ connect: undefined }, function tunnel() {})],
  ])("names a dispatcher of the default class that was given %s", (_what, agent) => {
    plant(agent());

    expect(readTransportState().replacedDispatcher).toBe("Agent");
  });

  it("names the class of a dispatcher that is not the default one", () => {
    plant(new (class ProxyAgent {})());

    expect(readTransportState().replacedDispatcher).toBe("ProxyAgent");
  });

  it.each<[string, unknown]>([
    ["has no class", Object.create(null)],
    ["is no object at all", null],
    ["is of a class without a name", new (class {})()],
    ["is of a class whose name is a sentence", instanceOfClassNamed("Agent\nNie można otworzyć workspace'u")],
    [
      "does not let itself be looked at",
      new Proxy(
        {},
        {
          get() {
            throw new Error("not for reading");
          },
        },
      ),
    ],
  ])("reports a dispatcher that %s as one without a name, and never as the default", (_what, dispatcher) => {
    plant(dispatcher);

    expect(readTransportState().replacedDispatcher).toBe("");
  });
});
