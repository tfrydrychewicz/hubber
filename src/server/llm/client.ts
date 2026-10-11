// The only place in the application that constructs the SDK client, and the only one that
// opens a connection to the endpoint. Everything that makes the workspace's endpoint and
// credential the only ones in use is decided here, once.
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { pipeline, Readable } from "node:stream";
import Anthropic from "@anthropic-ai/sdk";
import { createAuthorizer, EndpointPinError } from "./credentials/authorize.ts";
import { scrubSdkEnvironment } from "./credentials/scrub-env.ts";
import type { CredentialProvider } from "./credentials/types.ts";
import { type Endpoint, isWithinEndpoint } from "./endpoint.ts";

// Never sent: the authorizer replaces it on every request. It is there because a client without
// any credential of its own goes looking for one (profile files in the home directory,
// federation variables), and would exchange tokens with a host named there.
const PLACEHOLDER = "hubber-placeholder-not-a-credential";

/** What sends one request: the address that was checked, and the options of fetch(). */
export type Transport = (url: URL, init: RequestInit) => Promise<Response>;

export interface LlmClientOptions {
  credentials: CredentialProvider;
  /** The transport. Tests pass the fake endpoint here. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
}

// Agents of the client's own. A connection made through them goes to the address it is asked
// for. The global fetch() does not promise that: where its bytes go is decided by a dispatcher
// that belongs to the whole process, and Node puts a proxy there when it is started with
// --use-env-proxy, in any spelling of that option, or told so by a configuration file or by
// http.setGlobalProxyFromEnv(). None of these reaches an agent that was not given proxy
// settings itself.
//
// A connection for each request: a call takes seconds, so opening one costs little beside it,
// and a connection kept for the next call can have been closed by the other side meanwhile.
//
// The certificate of an endpoint is checked whatever NODE_TLS_REJECT_UNAUTHORIZED says. Node
// reads that variable for every connection that leaves the question open, so it also counts
// when something sets it long after the start.
const AGENTS = {
  http: new HttpAgent({ keepAlive: false }),
  https: new HttpsAgent({ keepAlive: false, rejectUnauthorized: true }),
};

// The statuses that the Response of the platform refuses to give a body.
const WITHOUT_BODY = new Set([204, 205, 304]);

// Headers that are the connection's and not the request's. A request does not get to set them:
// Host is what the server at the pinned address goes by to pick the site that answers, and the
// other four say how the body is framed and what becomes of the connection afterwards.
const OF_THE_CONNECTION = new Set(["host", "connection", "keep-alive", "content-length", "transfer-encoding"]);

/** The body as bytes of a known length, where the options hold it as such. */
function bytesOf(body: RequestInit["body"]): Buffer | undefined {
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return undefined;
}

function responseFrom(incoming: IncomingMessage, method: string): Response {
  const headers = new Headers();
  for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) {
    headers.append(incoming.rawHeaders[index] ?? "", incoming.rawHeaders[index + 1] ?? "");
  }
  const status = incoming.statusCode ?? 0;
  const statusText = incoming.statusMessage ?? "";
  if (method === "HEAD" || WITHOUT_BODY.has(status)) {
    // Read to its end all the same, which lets go of the connection. If it breaks meanwhile,
    // there is nobody to tell.
    incoming.on("error", () => {}).resume();
    return new Response(null, { status, statusText, headers });
  }
  // Nothing here reads a compressed answer, and none was asked for. Handed on as it is, it
  // would reach the SDK as a text that makes no sense.
  const encoding = headers.get("content-encoding")?.trim().toLowerCase() ?? "";
  if (encoding !== "" && encoding !== "identity") {
    throw new Error(`The endpoint answered with the content encoding "${encoding}", although none was accepted.`);
  }
  return new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, statusText, headers });
}

/**
 * What the global fetch() does for one request, on the connections of the agents above.
 *
 * It behaves like fetch() where the SDK can tell: the options are read by the platform's own
 * Request, a failed connection rejects with "fetch failed" and the cause, and a signal that
 * fires rejects with its reason and ends a body that is still being read with the same reason.
 * It differs where that is the point: no dispatcher and no proxy, and a redirect is never
 * followed, because nothing here would know how to.
 */
const directFetch: Transport = (url, init) =>
  new Promise<Response>((resolve, reject) => {
    // Reads the options as fetch() would: the method, the headers, and a body of any kind as a
    // stream, together with the content type that the body needs.
    const outgoing = new Request(url, { ...init, duplex: "half" });
    const { signal } = outgoing;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const secure = url.protocol === "https:";
    const headers = Object.fromEntries([...outgoing.headers].filter(([name]) => !OF_THE_CONNECTION.has(name)));
    const request = (secure ? httpsRequest : httpRequest)(url, {
      agent: secure ? AGENTS.https : AGENTS.http,
      method: outgoing.method,
      headers: { ...headers, "accept-encoding": "identity" },
    });
    let incoming: IncomingMessage | undefined;
    const onAbort = () => {
      // The body first: ended by the request, it would fail with a reset connection for a reason.
      incoming?.destroy(signal.reason);
      request.destroy(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // After the answer has begun, an error is told by its body; this then changes nothing.
    request.on("error", (error) => {
      reject(signal.aborted ? signal.reason : new TypeError("fetch failed", { cause: error }));
    });
    // What ends the request ends the wait, with an answer or without. Node closes a connection
    // on which the other side switches to another protocol, and says nothing more about it.
    request.once("close", () => {
      signal.removeEventListener("abort", onAbort);
      if (incoming !== undefined) return;
      reject(new TypeError("fetch failed", { cause: new Error("The connection was closed before an answer came.") }));
    });
    request.once("response", (response) => {
      incoming = response;
      try {
        resolve(responseFrom(response, outgoing.method));
      } catch (error) {
        request.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });

    // Bytes of a known length go out with their length; a gateway may refuse a body in chunks.
    const bytes = bytesOf(init.body);
    if (bytes !== undefined) request.end(bytes);
    else if (outgoing.body === null) request.end();
    else {
      pipeline(Readable.fromWeb(outgoing.body), request, (error) => {
        if (error) request.destroy(error);
      });
    }
  });

/**
 * The last step before the network: a fetch bound to one endpoint.
 *
 * - The address is parsed here and the parsed URL itself is what goes on, so what was checked is
 *   what is sent. An address outside the endpoint, or one that does not parse, is refused.
 * - A Request is taken apart, and its method, headers, body and signal go on with the address
 *   that was checked. Handed on whole, it would be sent to the address inside it, whatever its
 *   `url` answered here, and through the dispatcher it may carry.
 * - A `dispatcher` among the options is dropped: it decides where the bytes really go, whatever
 *   the address says.
 * - A redirect is never followed: fetch would repeat the request body, and an x-api-key header,
 *   at the new address. With "manual" the 3xx answer comes back as it is, and the SDK turns it
 *   into an APIError with that status, once and without retries. ("error" would surface as a
 *   connection error that the SDK retries and that says nothing about a redirect.)
 *
 * Without a transport of the caller's, the request travels on connections of this module's own,
 * which no setting of the process can lead through a proxy.
 */
export function createPinnedFetch(endpoint: Endpoint, transport: Transport = directFetch): typeof fetch {
  return (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const address = request === undefined ? String(input) : request.url;
    const url = URL.canParse(address) ? new URL(address) : undefined;
    if (url === undefined || !isWithinEndpoint(endpoint, url)) return Promise.reject(new EndpointPinError(endpoint));
    const parts: RequestInit =
      request === undefined
        ? {}
        : {
            method: request.method,
            headers: request.headers,
            signal: request.signal,
            ...(request.body !== null && { body: request.body, duplex: "half" }),
          };
    const { dispatcher: _dropped, ...options } = (init ?? {}) as RequestInit & { dispatcher?: unknown };
    return transport(url, { ...parts, ...options, redirect: "manual" });
  };
}

/** The client that the LLM layer calls `messages.stream()` on. */
export function createLlmClient({ credentials, fetch: transport, timeoutMs, maxRetries }: LlmClientOptions): Anthropic {
  // The entry point of the server does this at start (takeEnvironment); repeated here so that
  // no path to a client skips it. ANTHROPIC_CUSTOM_HEADERS is merged into every request even
  // when everything else is passed explicitly.
  scrubSdkEnvironment();
  const { endpoint } = credentials.target;
  return new Anthropic({
    // All three are always passed. Left out, each is read from the environment; an empty base
    // address silently becomes the public API.
    baseURL: endpoint.href,
    apiKey: null,
    authToken: PLACEHOLDER,
    middleware: [createAuthorizer(credentials)],
    fetch: createPinnedFetch(endpoint, transport),
    // Explicit, so that the level never comes from ANTHROPIC_LOG: "debug" prints request bodies.
    // The scrub above takes the variable away as well; this holds without it.
    logLevel: "warn",
    ...(timeoutMs !== undefined && { timeout: timeoutMs }),
    ...(maxRetries !== undefined && { maxRetries }),
  });
}
