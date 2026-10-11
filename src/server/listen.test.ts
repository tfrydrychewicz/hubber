import { once } from "node:events";
import { Agent, createServer, get, type Server, type ServerOptions } from "node:http";
import { type AddressInfo, connect, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import {
  answerClientError,
  PortInUseError,
  type RunningServer,
  type ServerAddress,
  type StartServerOptions,
  startServer,
} from "./listen.ts";
import { securityHeaderValues } from "./security-headers.ts";

const CONNECT_TIMEOUT_MS = 1_000;
// Node reads this much of a request line with its headers, and of the extensions of a chunk.
const NODE_LIMIT = 16 * 1024;
// Captured before any server starts, so a replacement made by the adapter cannot go unnoticed.
const { Request: NativeRequest, Response: NativeResponse } = globalThis;

const externalIPv4 = Object.values(networkInterfaces())
  .flatMap((addresses) => addresses ?? [])
  .filter((address) => address.family === "IPv4" && !address.internal)
  .map((address) => address.address);

const servers: RunningServer[] = [];
const agents: Agent[] = [];
const nodeServers: Server[] = [];
const sockets: Socket[] = [];

async function start(options: Partial<StartServerOptions> = {}): Promise<RunningServer> {
  const server = await startServer({ app: ({ port }) => createApp({ port }), port: 0, ...options });
  servers.push(server);
  return server;
}

function keepAliveAgent(): Agent {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  agents.push(agent);
  return agent;
}

afterEach(async () => {
  for (const agent of agents.splice(0)) agent.destroy();
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of nodeServers.splice(0)) server.close().closeAllConnections();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves to "connected", "timeout" or the error code. Never rejects and never waits longer than the timeout. */
function tryConnect(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: CONNECT_TIMEOUT_MS });
    const finish = (outcome: string) => {
      socket.destroy();
      resolve(outcome);
    };
    socket.once("connect", () => finish("connected"));
    socket.once("timeout", () => finish("timeout"));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code ?? error.message));
  });
}

function httpGet(url: string, agent: Agent): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    get(url, { agent }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode, body }));
      response.on("error", reject);
    }).on("error", reject);
  });
}

describe("startServer", () => {
  it("picks a free port when asked for port 0 and reports it", async () => {
    const server = await start();

    expect(server.port).toBeGreaterThan(0);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("builds the app from the bound address when given a function", async () => {
    const seen: ServerAddress[] = [];

    const server = await start({
      app: (address) => {
        seen.push(address);
        return new Hono().get("/whoami", (c) => c.json(address));
      },
    });

    expect(seen).toEqual([{ hostname: "127.0.0.1", port: server.port }]);
    const response = await fetch(`http://127.0.0.1:${server.port}/whoami`);
    expect(await response.json()).toEqual({ hostname: "127.0.0.1", port: server.port });
  });

  it("rejects and frees the port when building the app fails", async () => {
    let port = 0;
    const failure = new Error("konfiguracja");

    const starting = startServer({
      app: (address) => {
        port = address.port;
        throw failure;
      },
      port: 0,
    });

    await expect(starting).rejects.toBe(failure);
    expect(port).toBeGreaterThan(0);
    expect(await tryConnect("127.0.0.1", port)).toBe("ECONNREFUSED");
  });

  it("rejects with PortInUseError when the port is taken", async () => {
    const first = await start();

    const second = startServer({ app: createApp({ port: first.port }), port: first.port });

    await expect(second).rejects.toBeInstanceOf(PortInUseError);
    await expect(second).rejects.toMatchObject({ cause: { code: "EADDRINUSE" } });
    // The first server is unaffected.
    expect((await fetch(`http://127.0.0.1:${first.port}/api/health`)).status).toBe(200);
  });

  it("leaves the global Request and Response alone", async () => {
    const server = await start();
    const response = await fetch(`http://127.0.0.1:${server.port}/api/health`);

    expect(globalThis.Request).toBe(NativeRequest);
    expect(globalThis.Response).toBe(NativeResponse);
    expect(response).toBeInstanceOf(Response);
  });
});

// NFR-3: the server listens on 127.0.0.1 only.
describe("network exposure", () => {
  it("binds to 127.0.0.1", async () => {
    const server = await start();

    expect(server.hostname).toBe("127.0.0.1");
    expect(await tryConnect("127.0.0.1", server.port)).toBe("connected");
  });

  it("is not reachable over IPv6 loopback", async () => {
    const server = await start();

    expect(await tryConnect("::1", server.port)).not.toBe("connected");
  });

  it.skipIf(externalIPv4.length === 0)(
    "is not reachable on the non-loopback IPv4 addresses of this machine",
    async () => {
      const server = await start();

      const outcomes = await Promise.all(externalIPv4.map((address) => tryConnect(address, server.port)));

      expect(outcomes).not.toContain("connected");
    },
  );
});

// Node answers these itself, past the middleware that puts the headers on everything the app answers.
describe("a connection that Node gives up on", () => {
  const headerLines = Object.entries(securityHeaderValues())
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  const answer = (status: string) => `HTTP/1.1 ${status}\r\n${headerLines}Connection: close\r\n\r\n`;

  /**
   * A Node server that answers such connections the way startServer() does, for what takes
   * other limits than Node's own, which give a request a minute to arrive. No request is ever
   * answered, so whatever a client receives comes from answerClientError().
   */
  async function startNodeServer(options: ServerOptions = {}): Promise<{ server: Server; port: number }> {
    const server = createServer(options, () => {}).on("clientError", answerClientError);
    nodeServers.push(server);
    await once(server.listen(0, "127.0.0.1"), "listening");
    return { server, port: (server.address() as AddressInfo).port };
  }

  /**
   * Resolves with what the server sends before it ends the connection. The client keeps its
   * own side open, and each request stops where Node gives up: bytes that the server has not
   * read when it ends the connection would turn the end into a reset.
   */
  function answerTo(port: number, request: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
      sockets.push(socket);
      let received = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        received += chunk;
      });
      socket.on("end", () => resolve(received));
      socket.on("error", reject);
      socket.write(request);
    });
  }

  it.each([
    ["an address longer than Node reads", `GET /${"a".repeat(NODE_LIMIT)}`, "431 Request Header Fields Too Large"],
    ["a request line that Node cannot parse", "GET /a b", "400 Bad Request"],
  ])("answers %s with the security headers", async (_label, request, status) => {
    const server = await start();

    expect(await answerTo(server.port, request)).toBe(answer(status));
  });

  it("answers a chunk whose extensions are longer than Node reads with 413", async () => {
    const { port } = await startNodeServer();
    const head = "POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n";

    expect(await answerTo(port, `${head}1;${"x".repeat(NODE_LIMIT + 1)}`)).toBe(answer("413 Payload Too Large"));
  });

  it("answers a connection on which no request arrives in time with 408, and ends it", async () => {
    const { server, port } = await startNodeServer({ headersTimeout: 100, connectionsCheckingInterval: 20 });

    expect(await answerTo(port, "")).toBe(answer("408 Request Timeout"));
    // The client has not closed its side. Had the server only ended its own, the connection would remain.
    const connections = await new Promise((resolve) => server.getConnections((_error, count) => resolve(count)));
    expect(connections).toBe(0);
  });
});

describe("close", () => {
  it("ends idle keep-alive connections at once", async () => {
    const server = await start();
    const agent = keepAliveAgent();
    await httpGet(`http://127.0.0.1:${server.port}/api/health`, agent);
    expect(Object.values(agent.freeSockets).flat()).toHaveLength(1);

    const startedAt = performance.now();
    await server.close();

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(await tryConnect("127.0.0.1", server.port)).toBe("ECONNREFUSED");
  });

  it("lets a request in flight finish and does not wait for the keep-alive timeout afterwards", async () => {
    const app = new Hono().get("/slow", async (c) => {
      await sleep(200);
      return c.text("gotowe");
    });
    // The grace period is far away, so a prompt close can only come from the socket going idle.
    const server = await start({ app, closeGraceMs: 10_000 });
    const agent = keepAliveAgent();
    await httpGet(`http://127.0.0.1:${server.port}/slow`, agent);

    const pending = httpGet(`http://127.0.0.1:${server.port}/slow`, agent);
    await sleep(50);
    const startedAt = performance.now();
    await server.close();

    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(await pending).toEqual({ status: 200, body: "gotowe" });
  });

  it("cuts off a stream that never ends once the grace period is over", async () => {
    const encoder = new TextEncoder();
    const app = new Hono().get("/stream", () => {
      let timer: ReturnType<typeof setInterval>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          timer = setInterval(() => controller.enqueue(encoder.encode("data: tick\n\n")), 20);
        },
        cancel() {
          clearInterval(timer);
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const server = await start({ app, closeGraceMs: 100 });
    const response = await fetch(`http://127.0.0.1:${server.port}/stream`);
    if (!response.body) throw new Error("The stream has no body.");
    const reader = response.body.getReader();
    expect((await reader.read()).done).toBe(false);

    const startedAt = performance.now();
    await server.close();
    const elapsed = performance.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(2_000);
    // The client sees the stream break off instead of ending cleanly.
    const readToEnd = async () => {
      while (!(await reader.read()).done);
    };
    await expect(readToEnd()).rejects.toThrow();
  });

  it("can be called more than once", async () => {
    const server = await start();

    const first = server.close();
    const second = server.close();

    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();
    await expect(server.close()).resolves.toBeUndefined();
  });
});
