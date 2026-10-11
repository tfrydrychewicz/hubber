import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { getRequestListener } from "@hono/node-server";
import { HOST } from "./ports.ts";
import { securityHeaderValues } from "./security-headers.ts";

const DEFAULT_CLOSE_GRACE_MS = 1_000;
const IDLE_SWEEP_INTERVAL_MS = 50;

// The status Node itself gives a request it gives up on, by the code of the error. Any other
// code is a 400.
const CLIENT_ERROR_STATUS = new Map([
  ["HPE_HEADER_OVERFLOW", "431 Request Header Fields Too Large"],
  ["HPE_CHUNK_EXTENSIONS_OVERFLOW", "413 Payload Too Large"],
  ["ERR_HTTP_REQUEST_TIMEOUT", "408 Request Timeout"],
]);
const SECURITY_HEADER_LINES = Object.entries(securityHeaderValues())
  .map(([name, value]) => `${name}: ${value}\r\n`)
  .join("");

export interface FetchApp {
  fetch: Parameters<typeof getRequestListener>[0];
}

export interface ServerAddress {
  hostname: string;
  port: number;
}

export interface StartServerOptions {
  /** The app, or a function that builds it once the address is known. With port 0 it is not known earlier. */
  app: FetchApp | ((address: ServerAddress) => FetchApp);
  /** 0 lets the system pick a free port; the result reports the real one. */
  port: number;
  /** How long close() waits for requests in flight before cutting them off. */
  closeGraceMs?: number;
}

export interface RunningServer extends ServerAddress {
  close: () => Promise<void>;
}

/**
 * Marks a start that failed because the port is taken. The words for the user are in
 * busy-port.ts, which can also name the process that holds the port.
 */
export class PortInUseError extends Error {
  override name = "PortInUseError";
}

/**
 * Answers a connection on which Node gives up: a request that it cannot parse, or one that
 * does not arrive in time. Such an answer goes past the app, so Node's own carries none of
 * the headers that are on every other response, and an address above 16 KiB is enough to get
 * one. Without Cross-Origin-Resource-Policy it would tell a page on another site that the
 * server is running.
 *
 * A "clientError" listener takes the place of what Node does, and this one keeps to it: the
 * same status, and the connection ends at once, whether or not the client closes its side.
 */
export function answerClientError(error: NodeJS.ErrnoException, socket: Duplex): void {
  if (socket.writable) {
    const status = CLIENT_ERROR_STATUS.get(error.code ?? "") ?? "400 Bad Request";
    socket.write(`HTTP/1.1 ${status}\r\n${SECURITY_HEADER_LINES}Connection: close\r\n\r\n`);
  }
  socket.destroy();
}

// The adapter's own serve() is not used: without a host it listens on every
// interface, it has no handler for a taken port, and it returns before listening.
export function startServer({
  app,
  port,
  closeGraceMs = DEFAULT_CLOSE_GRACE_MS,
}: StartServerOptions): Promise<RunningServer> {
  const server = createServer().on("clientError", answerClientError);

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((done) => {
      // Node drops only the sockets that are idle when close() is called. One that is
      // still answering goes idle later and would hold the process for the keep-alive
      // timeout, so idle sockets are swept until the server is down.
      const sweep = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_INTERVAL_MS);
      // Streams such as SSE never end on their own.
      const cutOff = setTimeout(() => server.closeAllConnections(), closeGraceMs);
      server.close(() => {
        clearInterval(sweep);
        clearTimeout(cutOff);
        done();
      });
    });
    return closing;
  };

  return new Promise((resolve, reject) => {
    const onStartError = (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE" ? new PortInUseError(error.message, { cause: error }) : error);
    };
    server.once("error", onStartError);

    server.listen(port, HOST, () => {
      server.off("error", onStartError);
      const bound = server.address() as AddressInfo;
      const address = { hostname: bound.address, port: bound.port };
      try {
        // Node accepts no connection before this callback returns, so the app can still be built here.
        const { fetch } = typeof app === "function" ? app(address) : app;
        // By default the adapter replaces the global Request and Response for the whole
        // process; afterwards a fetch() result is no longer `instanceof Response`.
        server.on("request", getRequestListener(fetch, { hostname: HOST, overrideGlobalObjects: false }));
      } catch (error) {
        void close();
        reject(error);
        return;
      }
      resolve({ ...address, close });
    });
  });
}
