// The client factory through the real SDK. Where a test is about the credential or the address,
// the transport is a function that stands in for the endpoint; where it is about the connection
// itself, the endpoint is a server on the loopback address.
import { type ChildProcess, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, setGlobalProxyFromEnv } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { createRequire } from "node:module";
import { type AddressInfo, createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
} from "@anthropic-ai/sdk";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { spawnNode } from "../testing.ts";
import { createLlmClient, createPinnedFetch } from "./client.ts";
import { EndpointPinError } from "./credentials/authorize.ts";
import type { HelperSpec } from "./credentials/file-source.ts";
import { createCredentialProvider } from "./credentials/provider.ts";
import { scrubSdkEnvironment } from "./credentials/scrub-env.ts";
import { Secret } from "./credentials/secret.ts";
import { type AuthScheme, CredentialError, type CredentialProvider } from "./credentials/types.ts";
import { createFakeEndpoint } from "./diagnostics/fake-endpoint.ts";
import { parseEndpoint } from "./endpoint.ts";

// The real module, with the one function that the client calls wrapped, so that a test can take
// it away and see what the client still does by itself.
vi.mock("./credentials/scrub-env.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./credentials/scrub-env.ts")>();
  return { ...original, scrubSdkEnvironment: vi.fn(original.scrubSdkEnvironment) };
});

const PLANT = "hubber-planted-secret-7f3a9c";
const ENDPOINT = "https://router.corp.example/llm";
const PIN_REFUSAL = `Żądanie poza endpoint workspace'u (${ENDPOINT}) zostało zatrzymane.`;
const params = { model: "m", max_tokens: 16, messages: [{ role: "user" as const, content: "WORK-DATA-MARKER" }] };
// In the place of an undici dispatcher, which decides where a connection goes, whatever the address
// says. Not a real one, hence the casts where it is used: the tests are about it never arriving.
const dispatcher = { dispatch: () => true };

const sandbox = mkdtempSync(join(tmpdir(), "hubber-llm-client-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const servers: Array<Server | TcpServer> = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // Back to the real scrub, also where a test that took it away failed before the client called it.
  vi.mocked(scrubSdkEnvironment).mockReset();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(
    servers.splice(0).map((server) => {
      // An answer that a test left unfinished would keep its server from closing.
      if ("closeAllConnections" in server) server.closeAllConnections();
      return new Promise((done) => server.close(done));
    }),
  );
});

const uid = process.getuid?.() ?? -1;

function secret(value: string): Secret {
  const parsed = Secret.parse(value);
  if (typeof parsed === "string") throw new Error(`Not accepted as a secret: ${parsed}`);
  return parsed;
}

const message = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "m",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

const sse = () =>
  new Response(
    [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "stream ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

interface Seen {
  url: string;
  xApiKey: string | null;
  authorization: string | null;
  names: string[];
  redirect: RequestInit["redirect"];
  options: string[];
}

/** A stand-in for an endpoint that accepts exactly one credential value and refuses the rest with 401. */
function endpointAccepting(accepted: () => string, { echo = false } = {}) {
  const seen: Seen[] = [];
  const transport: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const presented = headers.get("x-api-key") ?? headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    seen.push({
      url: String(input),
      xApiKey: headers.get("x-api-key"),
      authorization: headers.get("authorization"),
      names: [...headers.keys()],
      redirect: init?.redirect,
      options: Object.keys(init ?? {}),
    });
    if (presented !== accepted()) {
      return Response.json(
        {
          type: "error",
          error: {
            type: "authentication_error",
            message: echo ? `invalid credential: ${presented}` : "invalid credential",
          },
        },
        { status: 401, headers: { "request-id": "req_1" } },
      );
    }
    const streaming = typeof init?.body === "string" && JSON.parse(init.body).stream === true;
    return streaming ? sse() : Response.json(message, { headers: { "request-id": "req_1" } });
  };
  return { seen, transport };
}

let counter = 0;
function credentialsFile(endpoint: string, entry: unknown): string {
  const path = join(sandbox, `credentials-${++counter}.json`);
  writeFileSync(path, JSON.stringify({ version: 1, endpoints: { [endpoint]: entry } }));
  chmodSync(path, 0o600);
  return path;
}

/** A provider with one value, read from a credentials file. */
function staticProvider(scheme: AuthScheme, value: string, endpoint = ENDPOINT): CredentialProvider {
  const file = credentialsFile(endpoint, { [scheme === "bearer" ? "authToken" : "apiKey"]: value });
  return createCredentialProvider(
    { endpoint: parseEndpoint(endpoint), scheme },
    { env: { HUBBER_CREDENTIALS_FILE: file }, uid, forbiddenRoots: [] },
  );
}

/** A provider whose values come from a helper command, with the given function in the place of the run. */
function helperProvider(run: (spec: HelperSpec) => Promise<Secret>): CredentialProvider {
  const file = credentialsFile(ENDPOINT, { helper: { command: ["/bin/echo"] } });
  return createCredentialProvider(
    { endpoint: parseEndpoint(ENDPOINT), scheme: "bearer" },
    { env: { HUBBER_CREDENTIALS_FILE: file }, uid, forbiddenRoots: [], runHelper: run },
  );
}

/** A helper that hands out helper-token-1, helper-token-2, … */
function countingHelper(delayMs = 0) {
  const state = { runs: 0 };
  const run = async () => {
    const value = `helper-token-${++state.runs}`;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return secret(value);
  };
  return { state, run };
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The address of a port of this machine at which nobody listens: one that was free a moment ago. */
async function unusedAddress(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return `http://127.0.0.1:${port}`;
}

/** The whole body of a request to a server of a test. */
async function bodyOf(request: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** What the caller gets within a second, or the note that it got nothing. */
function withinASecond<Outcome>(pending: Promise<Outcome>): Promise<Outcome | "still waiting"> {
  return Promise.race([
    pending,
    new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), 1_000)),
  ]);
}

describe("createLlmClient", () => {
  it.each(["bearer", "x-api-key"] as const)(
    "sends the workspace's credential the %s way, and nothing the SDK could find on its own",
    async (scheme) => {
      // Everything the SDK reads by itself, pointing somewhere else: its variables, and a profile
      // in the home directory.
      const home = join(sandbox, `home-${scheme}`);
      const profiles = join(home, ".config", "anthropic");
      mkdirSync(join(profiles, "configs"), { recursive: true });
      mkdirSync(join(profiles, "credentials"), { recursive: true });
      writeFileSync(
        join(profiles, "configs", "default.json"),
        JSON.stringify({ authentication: { type: "user_oauth" }, base_url: "https://profile-host.example" }),
      );
      writeFileSync(
        join(profiles, "credentials", "default.json"),
        JSON.stringify({ type: "oauth_token", access_token: "token-from-profile-file" }),
        { mode: 0o600 },
      );
      const hostile = {
        HOME: home,
        ANTHROPIC_BASE_URL: "https://foreign.example",
        ANTHROPIC_API_KEY: "env-key-000000",
        ANTHROPIC_AUTH_TOKEN: "env-token-000000",
        ANTHROPIC_CUSTOM_HEADERS: "X-Env-Extra: from-environment\nAuthorization: Bearer env-custom-header",
        ANTHROPIC_LOG: "debug",
        ANTHROPIC_FEDERATION_RULE_ID: "fdrl_x",
        ANTHROPIC_ORGANIZATION_ID: "org_x",
        ANTHROPIC_IDENTITY_TOKEN: "identity-jwt",
      };
      for (const [name, value] of Object.entries(hostile)) vi.stubEnv(name, value);
      // Before the client exists: the SDK takes the functions of the console when it is built.
      const logged = (["debug", "info", "log"] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation(() => {}),
      );
      const { seen, transport } = endpointAccepting(() => PLANT);

      const client = createLlmClient({ credentials: staticProvider(scheme, PLANT), fetch: transport });
      const reply = await client.messages.create(params);

      expect(reply.content).toEqual([{ type: "text", text: "ok" }]);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        url: `${ENDPOINT}/v1/messages`,
        authorization: scheme === "bearer" ? `Bearer ${PLANT}` : null,
        xApiKey: scheme === "x-api-key" ? PLANT : null,
        redirect: "manual",
      });
      // From ANTHROPIC_CUSTOM_HEADERS, and from the SDK's own chain of credentials.
      expect(seen[0]?.names).not.toContain("x-env-extra");
      expect(seen[0]?.names).not.toContain("anthropic-beta");
      // ANTHROPIC_LOG=debug would print the request, body included.
      for (const spy of logged) expect(spy).not.toHaveBeenCalled();
      expect(inspect(client, { depth: 8, showHidden: true })).not.toContain(PLANT);
      expect(Object.keys(process.env).filter((name) => name.startsWith("ANTHROPIC_"))).toEqual([]);
    },
  );

  it("is built from the pin and holds a placeholder in the place of a credential", () => {
    const credentials = staticProvider("bearer", PLANT);

    const client = createLlmClient({ credentials });
    const tuned = createLlmClient({ credentials, timeoutMs: 1234, maxRetries: 0 });

    expect(client).toMatchObject({
      baseURL: ENDPOINT,
      apiKey: null,
      authToken: "hubber-placeholder-not-a-credential",
      logLevel: "warn",
      timeout: 600_000,
      maxRetries: 2,
    });
    expect(tuned).toMatchObject({ timeout: 1234, maxRetries: 0 });
  });

  it("gets a new credential after a 401 and sends the request again, for plain and streamed calls", async () => {
    const helper = countingHelper();
    let accepted = "helper-token-1";
    const { seen, transport } = endpointAccepting(() => accepted);
    const client = createLlmClient({ credentials: helperProvider(helper.run), fetch: transport, maxRetries: 0 });

    await client.messages.create(params);
    accepted = "helper-token-2";
    await client.messages.create(params);
    accepted = "helper-token-3";
    const streamed = await client.messages.stream(params).finalMessage();

    expect(seen.map((request) => request.authorization)).toEqual([
      "Bearer helper-token-1",
      "Bearer helper-token-1",
      "Bearer helper-token-2",
      "Bearer helper-token-2",
      "Bearer helper-token-3",
    ]);
    expect(streamed.content).toMatchObject([{ type: "text", text: "stream ok" }]);
    expect(helper.state.runs).toBe(3);
  });

  it("runs the helper once when two requests are refused at the same time", async () => {
    const helper = countingHelper(50);
    let accepted = "helper-token-1";
    const { seen, transport } = endpointAccepting(() => accepted);
    const client = createLlmClient({ credentials: helperProvider(helper.run), fetch: transport, maxRetries: 0 });
    await client.messages.create(params);
    accepted = "helper-token-2";

    const replies = await Promise.all([client.messages.create(params), client.messages.create(params)]);

    expect(replies).toHaveLength(2);
    expect(helper.state.runs).toBe(2);
    expect(seen.filter((request) => request.authorization === "Bearer helper-token-2")).toHaveLength(2);
  });

  it("hands a 401 that survives the refresh to the caller as the SDK's own error type", async () => {
    const helper = countingHelper();
    const { seen, transport } = endpointAccepting(() => "something-else-entirely");
    const client = createLlmClient({ credentials: helperProvider(helper.run), fetch: transport });

    await expect(client.messages.create(params)).rejects.toThrow(AuthenticationError);

    // One request and one repeat, although the client would retry other failures twice.
    expect(seen).toHaveLength(2);
    expect(helper.state.runs).toBe(2);
  });

  it("reports a failing helper once, as what it is, without touching the network", async () => {
    let runs = 0;
    const failure = new CredentialError('Polecenie pomocnicze "/bin/echo" zakończyło się kodem 1.');
    const credentials = helperProvider(async () => {
      runs++;
      throw failure;
    });
    const { seen, transport } = endpointAccepting(() => PLANT);
    const client = createLlmClient({ credentials, fetch: transport });

    await expect(client.messages.create(params)).rejects.toBe(failure);

    expect(runs).toBe(1);
    expect(seen).toEqual([]);
  });

  it("takes the credential out of an error that repeats it", async () => {
    const { transport } = endpointAccepting(() => "the-right-one-000000", { echo: true });
    const client = createLlmClient({ credentials: staticProvider("x-api-key", PLANT), fetch: transport });

    const error = await client.messages.create(params).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).message).toContain("invalid credential: [ukryte]");
    expect((error as AuthenticationError).requestID).toBe("req_1");
    expect(inspect(error, { depth: 8, showHidden: true })).not.toContain(PLANT);
  });

  // Shaped like a base64 token: writers of JSON disagree about "/", "+" and "=".
  const TOKEN = "hubberPlanted/Zm9v+YmFy/c2VjcmV0+w==";

  it.each([
    ["with its slashes escaped, as PHP writes JSON", (value: string) => value.replaceAll("/", "\\/")],
    [
      "with \\u escapes, as HTML-safe writers of JSON do",
      (value: string) => value.replaceAll("=", "\\u003d").replaceAll("+", "\\u002b"),
    ],
  ])("takes the credential out of an error that repeats it %s, in a value and in a key", async (_case, spell) => {
    let presented = "";
    const transport: typeof fetch = async (_input, init) => {
      presented = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
      // Written by hand: JSON.stringify() escapes none of these characters.
      const body = `{"type":"error","error":{"type":"authentication_error","message":"bad token ${spell(presented)}"},"seen":{"${spell(presented)}":true}}`;
      // With a content type that does not say JSON: the SDK parses the body of an error whatever it is called.
      return new Response(body, { status: 401, headers: { "content-type": "text/plain" } });
    };
    const client = createLlmClient({ credentials: staticProvider("bearer", TOKEN), fetch: transport });

    const error = await client.messages.create(params).catch((caught: unknown) => caught);

    // The endpoint did get the token and did repeat it, in a spelling that is not the token itself.
    expect(presented).toBe(TOKEN);
    expect(spell(presented)).not.toContain(TOKEN);
    expect(error).toBeInstanceOf(AuthenticationError);
    const refused = error as AuthenticationError;
    // What the SDK keeps is what a parser made of the escapes.
    expect(refused.error).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "bad token [ukryte]" },
      seen: { "[ukryte]": true },
    });
    expect(refused.message).toContain("bad token [ukryte]");
    expect(inspect(error, { depth: 8, showHidden: true })).not.toContain(TOKEN);
  });

  it("takes the credential out of the headers of an error", async () => {
    const transport: typeof fetch = async (_input, init) => {
      const presented = new Headers(init?.headers).get("x-api-key") ?? "";
      return Response.json(
        { type: "error", error: { type: "authentication_error", message: "invalid credential" } },
        {
          status: 401,
          headers: [
            ["request-id", `req-for-${presented}`],
            ["x-auth-debug", `token=${encodeURIComponent(presented)}`],
            ["set-cookie", `seen=${presented}; Path=/`],
            ["set-cookie", "other=1"],
          ],
        },
      );
    };
    const client = createLlmClient({ credentials: staticProvider("x-api-key", TOKEN), fetch: transport });

    const error = await client.messages.create(params).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthenticationError);
    const refused = error as AuthenticationError;
    expect(refused.requestID).toBe("req-for-[ukryte]");
    expect(refused.headers?.get("x-auth-debug")).toBe("token=[ukryte]");
    expect(refused.headers?.getSetCookie()).toEqual(["seen=[ukryte]; Path=/", "other=1"]);
    expect(inspect(error, { depth: 8, showHidden: true })).not.toContain(TOKEN);
  });

  it("lets a call that was cancelled go at once, while the helper command it waited for runs on for the others", async () => {
    let finish = () => {};
    const run = vi.fn(
      () =>
        new Promise<Secret>((resolve) => {
          finish = () => resolve(secret("helper-token-1"));
        }),
    );
    const { seen, transport } = endpointAccepting(() => "helper-token-1");
    const client = createLlmClient({ credentials: helperProvider(run), fetch: transport, maxRetries: 0 });
    const controller = new AbortController();

    const cancelled = client.messages.create(params, { signal: controller.signal }).catch((caught: unknown) => caught);
    const other = client.messages.create(params);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    controller.abort();

    // While the command is still running: the SDK's own time limit does not run during the wait.
    expect(await withinASecond(cancelled)).toBeInstanceOf(APIUserAbortError);
    expect(seen).toEqual([]);
    finish();
    expect((await other).content).toEqual([{ type: "text", text: "ok" }]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
  });

  it("lets a call that was cancelled go at once while a refused credential is being renewed", async () => {
    let runs = 0;
    const run = vi.fn(() => {
      // The first value at once, the second never: the renewal is still under way when the caller gives up.
      return ++runs === 1 ? Promise.resolve(secret("helper-token-1")) : new Promise<Secret>(() => {});
    });
    const { seen, transport } = endpointAccepting(() => "helper-token-2");
    const client = createLlmClient({ credentials: helperProvider(run), fetch: transport, maxRetries: 0 });
    const controller = new AbortController();

    const cancelled = client.messages.create(params, { signal: controller.signal }).catch((caught: unknown) => caught);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    controller.abort();

    expect(await withinASecond(cancelled)).toBeInstanceOf(APIUserAbortError);
    expect(seen).toHaveLength(1);
  });

  it("takes neither its log level nor a credential from the environment, also where nothing had scrubbed it", async () => {
    // The client scrubs the environment before it builds the SDK client. Here that is taken away:
    // what the client is told explicitly has to hold without it.
    vi.mocked(scrubSdkEnvironment).mockImplementationOnce(() => []);
    vi.stubEnv("ANTHROPIC_LOG", "debug");
    vi.stubEnv("ANTHROPIC_API_KEY", "env-key-000000");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "env-token-000000");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://foreign.example");
    const logged = (["debug", "info", "log"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const { seen, transport } = endpointAccepting(() => PLANT);

    const client = createLlmClient({ credentials: staticProvider("bearer", PLANT), fetch: transport });
    await client.messages.create(params);

    // The variables were there for the SDK to read when the client was built.
    expect(process.env.ANTHROPIC_LOG).toBe("debug");
    expect(client.logLevel).toBe("warn");
    // At "debug" the SDK prints every request, body included.
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
    expect(seen).toMatchObject([{ url: `${ENDPOINT}/v1/messages`, authorization: `Bearer ${PLANT}`, xApiKey: null }]);
  });

  it("keeps its log level in a copy that is made when ANTHROPIC_LOG is back in the environment", async () => {
    const { seen, transport } = endpointAccepting(() => PLANT);
    const client = createLlmClient({ credentials: staticProvider("bearer", PLANT), fetch: transport });
    // Whatever put it back after the client was built: a copy has the level of the client it is
    // made of, not the one that the environment names by then.
    vi.stubEnv("ANTHROPIC_LOG", "debug");
    const logged = (["debug", "info", "log"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );

    const copy = client.withOptions({ maxRetries: 0 });
    await copy.messages.create(params);

    expect(seen).toHaveLength(1);
    expect(copy.logLevel).toBe("warn");
    // At "debug" the SDK prints every request, body included.
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  });

  it("stops a request addressed outside the endpoint before it reaches the transport or the credentials", async () => {
    const helper = countingHelper();
    const { seen, transport } = endpointAccepting(() => "helper-token-1");
    const client = createLlmClient({ credentials: helperProvider(helper.run), fetch: transport });

    const outside = [
      client.post("https://evil.example/v1/messages", { body: params }),
      client.post("https://router.corp.example/other/v1/messages", { body: params }),
      // A copy of the client keeps the guard, whatever address it is given.
      client.withOptions({ baseURL: "https://evil.example" }).messages.create(params),
    ];

    for (const call of outside) {
      await expect(call).rejects.toThrow(EndpointPinError);
      await expect(call).rejects.toThrow(PIN_REFUSAL);
    }
    expect(seen).toEqual([]);
    expect(helper.state.runs).toBe(0);
  });

  it("does not let a request choose how its bytes travel", async () => {
    const { seen, transport } = endpointAccepting(() => PLANT);
    const client = createLlmClient({ credentials: staticProvider("bearer", PLANT), fetch: transport });

    await client.messages.create(params, { fetchOptions: { dispatcher, redirect: "follow" } as never });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.options).not.toContain("dispatcher");
    expect(seen[0]?.redirect).toBe("manual");
  });

  it.each(["plain", "streamed"] as const)(
    "does not follow a redirect to another origin on real sockets: a %s call",
    async (kind) => {
      const received: string[] = [];
      const other = await listen((request, response) => {
        received.push(`${request.method} ${request.url} x-api-key=${request.headers["x-api-key"] ?? "-"}`);
        request.resume();
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
      });
      let hits = 0;
      const pinned = await listen((request, response) => {
        hits++;
        request.resume();
        response.writeHead(307, { location: `${other}${request.url}` }).end();
      });
      // No transport is given: this is the fetch the server will use.
      const client = createLlmClient({ credentials: staticProvider("x-api-key", PLANT, pinned) });

      const error = await (kind === "plain"
        ? client.messages.create(params)
        : client.messages.stream(params).finalMessage()
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(APIError);
      expect((error as APIError).status).toBe(307);
      expect(received).toEqual([]);
      // A redirect is not retried either.
      expect(hits).toBe(1);
    },
  );
});

describe("createPinnedFetch", () => {
  const endpoint = parseEndpoint(ENDPOINT);
  const recording = () => {
    const calls: { input: unknown; init: RequestInit | undefined }[] = [];
    const transport: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return Response.json({});
    };
    return { calls, transport };
  };

  it("hands on the address it checked, as the parsed address, with redirects switched off", async () => {
    const { calls, transport } = recording();
    const headers = new Headers({ "x-api-key": PLANT });

    await createPinnedFetch(endpoint, transport)(`${ENDPOINT}/v1/messages?beta=true`, {
      method: "POST",
      headers,
      body: "{}",
      redirect: "follow",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBeInstanceOf(URL);
    expect(String(calls[0]?.input)).toBe(`${ENDPOINT}/v1/messages?beta=true`);
    expect(calls[0]?.init).toEqual({ method: "POST", headers, body: "{}", redirect: "manual" });
  });

  it("takes a Request apart and sends its parts to the address that was checked", async () => {
    const { calls, transport } = recording();
    const request = new Request(`${ENDPOINT}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": PLANT },
      body: "{}",
      redirect: "follow",
    });

    await createPinnedFetch(endpoint, transport)(request);

    expect(calls).toHaveLength(1);
    // Not the Request itself: it would be sent to the address inside it, by the dispatcher it carries.
    expect(calls[0]?.input).toBeInstanceOf(URL);
    expect(String(calls[0]?.input)).toBe(`${ENDPOINT}/v1/messages`);
    const init = calls[0]?.init;
    expect(Object.keys(init ?? {}).sort()).toEqual(["body", "duplex", "headers", "method", "redirect", "signal"]);
    expect(init).toMatchObject({ method: "POST", duplex: "half", redirect: "manual" });
    expect(new Headers(init?.headers).get("x-api-key")).toBe(PLANT);
    expect(init?.signal).toBe(request.signal);
    expect(await new Response(init?.body).text()).toBe("{}");
  });

  it("sends a Request without a body as one, and lets the options beside it win", async () => {
    const { calls, transport } = recording();
    const headers = new Headers({ "x-api-key": "from-the-options-0000" });

    await createPinnedFetch(endpoint, transport)(new Request(`${ENDPOINT}/v1/models`, { method: "DELETE" }), {
      method: "GET",
      headers,
      dispatcher,
    } as never);

    expect(Object.keys(calls[0]?.init ?? {}).sort()).toEqual(["headers", "method", "redirect", "signal"]);
    expect(calls[0]?.init).toMatchObject({ method: "GET", headers, redirect: "manual" });
  });

  it("does not let a Request choose where its bytes go: not by a dispatcher of its own, not by an address other than the one it shows", async () => {
    const got = { pinned: [] as string[], other: [] as string[] };
    const other = await listen((request, response) => {
      got.other.push(`${request.method} ${request.url} x-api-key=${request.headers["x-api-key"] ?? "-"}`);
      request.resume();
      response.end("{}");
    });
    const pinned = await listen((request, response) => {
      got.pinned.push(`${request.method} ${request.url} x-api-key=${request.headers["x-api-key"] ?? "-"}`);
      request.resume();
      response.end("{}");
    });
    const pin = parseEndpoint(`${pinned}/llm`);
    // With the platform's own fetch for a transport: it is the one that goes by what a Request carries.
    const pinnedFetch = createPinnedFetch(pin, fetch);
    const handedOver: string[] = [];
    // In the place of an undici dispatcher: it notes what it is handed and sends nothing.
    const probe = {
      dispatch(options: { origin: unknown; path: unknown }, handler: Record<string, unknown>) {
        handedOver.push(`${String(options.origin)}${String(options.path)}`);
        const stopped = new Error("stopped by the probe");
        queueMicrotask(() => {
          if (typeof handler.onResponseError === "function") handler.onResponseError({ abort() {} }, stopped);
          else if (typeof handler.onError === "function") handler.onError(stopped);
        });
        return true;
      },
    };
    const withDispatcher = new Request(`${pin.href}/v1/models`, {
      headers: { "x-api-key": PLANT },
      dispatcher: probe,
    } as never);
    // Shows the pinned address to whoever asks, and is a request to another origin.
    const lying = Object.defineProperty(new Request(`${other}/elsewhere`, { headers: { "x-api-key": PLANT } }), "url", {
      get: () => `${pin.href}/v1/models`,
    });

    const outcomes = [];
    for (const request of [withDispatcher, lying]) {
      outcomes.push(
        await pinnedFetch(request).then(
          (answer) => answer.status,
          (error: unknown) => String(error),
        ),
      );
    }

    expect(outcomes).toEqual([200, 200]);
    expect(handedOver).toEqual([]);
    expect(got).toEqual({
      pinned: [`GET /llm/v1/models x-api-key=${PLANT}`, `GET /llm/v1/models x-api-key=${PLANT}`],
      other: [],
    });
  });

  it("drops a dispatcher among the options", async () => {
    const { calls, transport } = recording();

    await createPinnedFetch(endpoint, transport)(`${ENDPOINT}/v1/models`, { method: "GET", dispatcher } as never);

    expect(calls[0]?.init).toEqual({ method: "GET", redirect: "manual" });
  });

  it.each([
    ["another host", "https://evil.example/llm/v1/messages"],
    ["another path of the host", "https://router.corp.example/other/v1/messages"],
    ["a path that walks out of the base path", `${ENDPOINT}/../admin`],
    ["an address that does not parse", "/llm/v1/messages"],
  ])("refuses %s without calling the transport", async (_case, address) => {
    const { calls, transport } = recording();
    const pinnedFetch = createPinnedFetch(endpoint, transport);

    for (const input of [address, ...(URL.canParse(address) ? [new URL(address), new Request(address)] : [])]) {
      const outcome = pinnedFetch(input);

      await expect(outcome).rejects.toThrow(EndpointPinError);
      await expect(outcome).rejects.toThrow(PIN_REFUSAL);
    }
    expect(calls).toEqual([]);
  });
});

// Without a transport of the caller's, a request travels on connections that the client opens
// itself. Each of these tests has a server on the loopback address for its endpoint.
describe("the client's own connections", () => {
  // A process of its own for each case: whether Node sends through a proxy is settled when it starts.
  // In each, the same address is asked for twice: by the fetch of the platform, as the control,
  // and by the pinned fetch.
  const PROBE = join(sandbox, "through-a-proxy.mjs");
  writeFileSync(
    PROBE,
    `import { createPinnedFetch } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "client.ts")).href)};
import { parseEndpoint } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "endpoint.ts")).href)};

const outcome = (sending) =>
  sending.then(
    (answer) => answer.text(),
    () => "no answer",
  );
const report = {};
for (const pin of process.argv.slice(2)) {
  const address = \`\${pin}/v1/models\`;
  report[pin] = {
    platform: await outcome(fetch(address)),
    client: await outcome(createPinnedFetch(parseEndpoint(pin))(address)),
  };
}
console.log(JSON.stringify(report));
`,
  );
  const PROXY_CONFIGURATION = join(sandbox, "node.config.json");
  writeFileSync(PROXY_CONFIGURATION, JSON.stringify({ nodeOptions: { "use-env-proxy": true } }));

  it.each<[string, { env?: Record<string, string>; nodeArgs?: string[] }]>([
    ["the variable NODE_USE_ENV_PROXY", { env: { NODE_USE_ENV_PROXY: "1" } }],
    ["the option --use-env-proxy", { nodeArgs: ["--use-env-proxy"] }],
    ["the option in NODE_OPTIONS, spelled with underscores", { env: { NODE_OPTIONS: "--use_env_proxy" } }],
    ["a configuration file of Node", { nodeArgs: [`--experimental-config-file=${PROXY_CONFIGURATION}`] }],
  ])(
    "go straight to the endpoint in a process that %s tells to send through a proxy",
    { timeout: 15_000 },
    async (_case, { env = {}, nodeArgs = [] }) => {
      const proxied: string[] = [];
      const proxy = await listen((request, response) => {
        proxied.push(`${request.method} ${request.url}`);
        request.resume();
        response.end("the proxy");
      });
      servers.at(-1)?.on("connect", (request: { url?: string }, socket: { end: (answer: string) => void }) => {
        proxied.push(`CONNECT ${request.url}`);
        socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      });
      const direct: string[] = [];
      const pinned = await listen((request, response) => {
        direct.push(`${request.method} ${request.url}`);
        request.resume();
        response.end("the endpoint");
      });
      // In the place of an endpoint behind TLS: it speaks none, and counts who connects.
      let connections = 0;
      const behindTls = createTcpServer((socket) => {
        connections++;
        socket.on("error", () => {}).destroy();
      });
      servers.push(behindTls);
      await new Promise<void>((resolve) => behindTls.listen(0, "127.0.0.1", resolve));
      const tlsAddress = `127.0.0.1:${(behindTls.address() as AddressInfo).port}`;
      const pins = [`${pinned}/llm`, `https://${tlsAddress}/llm`] as const;

      const run = spawnNode(PROBE, { nodeArgs, args: pins, env: { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ...env } });
      children.push(run.child);
      expect(await run.exited, run.stderr()).toEqual({ code: 0, signal: null });

      expect(JSON.parse(run.stdout())).toEqual({
        // The control: in this process the fetch of the platform is answered by the proxy.
        [pins[0]]: { platform: "the proxy", client: "the endpoint" },
        [pins[1]]: { platform: "no answer", client: "no answer" },
      });
      // What the proxy saw is the control alone, for either scheme.
      expect(proxied).toEqual([`GET ${pinned}/llm/v1/models`, `CONNECT ${tlsAddress}`]);
      expect(direct).toEqual(["GET /llm/v1/models"]);
      // The one connection to the address behind TLS is the client's own.
      expect(connections).toBe(1);
    },
  );

  it("go straight to the endpoint after the process was told, while it runs, to send through a proxy", async () => {
    const proxied: string[] = [];
    const proxy = await listen((request, response) => {
      proxied.push(`${request.method} ${request.url}`);
      request.resume();
      response.end("the proxy");
    });
    const pinned = await listen((request, response) => {
      request.resume();
      response.end("the endpoint");
    });
    const address = `${pinned}/v1/models`;

    // What --use-env-proxy does at start, done by the program itself. It changes the fetch of
    // the platform and the agents that Node keeps for everyone.
    const restore = setGlobalProxyFromEnv({ HTTP_PROXY: proxy });
    try {
      const control = await (await fetch(address)).text();
      const answer = await (await createPinnedFetch(parseEndpoint(pinned))(address)).text();

      expect({ control, answer }).toEqual({ control: "the proxy", answer: "the endpoint" });
      expect(proxied).toEqual([`GET ${address}`]);
    } finally {
      restore();
    }
  });

  // Node cannot make a certificate, so the tests have the system's own tool make one for the run.
  const OPENSSL = "/usr/bin/openssl";
  let selfSigned: { key: string; certificate: string } | undefined;

  /**
   * An endpoint behind TLS on this machine, with a certificate for "localhost" that is signed by
   * itself: one that nobody vouches for. Answers with its address for the outside and the name
   * that the client asked for when it connected.
   */
  async function listenBehindTls(): Promise<{ origin: string; certificate: string; asked: () => number }> {
    if (selfSigned === undefined) {
      selfSigned = { key: join(sandbox, "key.pem"), certificate: join(sandbox, "certificate.pem") };
      const names = "subjectAltName=DNS:localhost,IP:127.0.0.1";
      execFileSync(
        OPENSSL,
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-subj",
          "/CN=localhost",
          "-addext",
          names,
          "-days",
          "2",
        ].concat(["-keyout", selfSigned.key, "-out", selfSigned.certificate]),
        { stdio: "ignore" },
      );
    }
    const { key, certificate } = selfSigned;
    let asked = 0;
    const server = createTlsServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
      asked++;
      request.resume();
      const serverName = "servername" in request.socket ? request.socket.servername : undefined;
      response.end(`the endpoint, asked as ${request.headers.host} and connected to as ${String(serverName)}`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { origin: `https://localhost:${port}`, certificate, asked: () => asked };
  }

  it.skipIf(!existsSync(OPENSSL))(
    "check the certificate of the endpoint although the process is told to check none",
    async () => {
      const endpoint = await listenBehindTls();
      const address = `${endpoint.origin}/v1/models`;
      // Node warns when it first acts on the variable; the warning is not what this is about.
      vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      // Set while the process runs, where no check made at its start can see it.
      vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");

      // The control: with the variable set, the fetch of the platform takes the certificate.
      const control = await (await fetch(address)).text();
      const failure = await createPinnedFetch(parseEndpoint(endpoint.origin))(address).catch(
        (caught: unknown) => caught,
      );

      expect(control).toContain("the endpoint");
      expect(failure).toMatchObject({ message: "fetch failed", cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } });
      expect(endpoint.asked()).toBe(1);
    },
  );

  // How an endpoint with a certificate of the company's own authority is reached: the variable
  // is read when Node starts, so the client runs in a process of its own.
  it.skipIf(!existsSync(OPENSSL))(
    "reach an endpoint behind TLS whose certificate Node was told to trust with NODE_EXTRA_CA_CERTS",
    { timeout: 15_000 },
    async () => {
      const endpoint = await listenBehindTls();
      const pin = `${endpoint.origin}/llm`;
      const host = new URL(pin).host;

      const run = spawnNode(PROBE, { args: [pin], env: { NODE_EXTRA_CA_CERTS: endpoint.certificate } });
      children.push(run.child);
      expect(await run.exited, run.stderr()).toEqual({ code: 0, signal: null });

      // By the name in the address, for the Host header and for the certificate alike.
      const answer = `the endpoint, asked as ${host} and connected to as localhost`;
      expect(JSON.parse(run.stdout())).toEqual({ [pin]: { platform: answer, client: answer } });
      expect(endpoint.asked()).toBe(2);
    },
  );

  it("send a request as fetch would, a body of known length with its length, and hand the answer back", async () => {
    const asked: Array<{ line: string; headers: Record<string, unknown>; body: string }> = [];
    const origin = await listen(async (request, response) => {
      const body = (await bodyOf(request)).toString();
      asked.push({ line: `${request.method} ${request.url}`, headers: request.headers, body });
      response
        .writeHead(201, "Made", {
          "content-type": "application/json",
          "request-id": "req_9",
          "set-cookie": ["first=1", "second=2"],
        })
        .end('{"ok":true}');
    });
    const note = '{"note":"zażółć gęślą jaźń"}';

    const answer = await createPinnedFetch(parseEndpoint(`${origin}/llm`))(`${origin}/llm/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": PLANT },
      body: note,
    });

    expect({ status: answer.status, statusText: answer.statusText, ok: answer.ok }).toEqual({
      status: 201,
      statusText: "Made",
      ok: true,
    });
    expect(answer.headers.get("request-id")).toBe("req_9");
    expect(answer.headers.getSetCookie()).toEqual(["first=1", "second=2"]);
    expect(await answer.json()).toEqual({ ok: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ line: "POST /llm/v1/messages?beta=true", body: note });
    expect(asked[0]?.headers).toMatchObject({
      host: new URL(origin).host,
      "content-type": "application/json",
      "x-api-key": PLANT,
      "content-length": String(Buffer.byteLength(note)),
      // Nothing here reads a compressed answer.
      "accept-encoding": "identity",
    });
    expect(asked[0]?.headers["transfer-encoding"]).toBeUndefined();
  });

  it("do not let a request name another host, or say how its body is framed", async () => {
    const asked: Array<Record<string, unknown>> = [];
    const origin = await listen(async (request, response) => {
      asked.push({ ...request.headers, body: (await bodyOf(request)).toString() });
      response.end(JSON.stringify(message));
    });
    const own = new URL(origin).host;
    const pinnedFetch = createPinnedFetch(parseEndpoint(origin));
    const client = createLlmClient({ credentials: staticProvider("bearer", PLANT, origin), maxRetries: 0 });

    const answer = await pinnedFetch(`${origin}/v1/messages`, {
      method: "POST",
      // A server that hosts several sites picks the one that answers by the Host header.
      headers: { host: "other.example", "content-length": "1", "transfer-encoding": "chunked", connection: "upgrade" },
      body: "{}",
    });
    await answer.text();
    await client.messages.create(params, { headers: { Host: "other.example" } });
    await client.withOptions({ defaultHeaders: { host: "other.example" } }).messages.create(params);

    expect(asked.map((headers) => headers.host)).toEqual([own, own, own]);
    expect(asked[0]).toMatchObject({ "content-length": "2", connection: "close", body: "{}" });
    expect(asked[0]?.["transfer-encoding"]).toBeUndefined();
  });

  it("send a body that is a stream, and a request without a body without one", async () => {
    const asked: Array<{ line: string; length: unknown; body: string }> = [];
    const origin = await listen(async (request, response) => {
      const body = (await bodyOf(request)).toString();
      asked.push({ line: `${request.method} ${request.url}`, length: request.headers["content-length"], body });
      response.end("{}");
    });
    const pinnedFetch = createPinnedFetch(parseEndpoint(origin));

    const streamed = await pinnedFetch(`${origin}/v1/files`, {
      method: "POST",
      body: new Blob(["part one, ", "part two"]).stream(),
      duplex: "half",
    } as RequestInit);
    await streamed.text();
    await (await pinnedFetch(`${origin}/v1/models`)).text();

    expect(asked).toEqual([
      { line: "POST /v1/files", length: undefined, body: "part one, part two" },
      { line: "GET /v1/models", length: undefined, body: "" },
    ]);
  });

  it("hand an answer back while it is still arriving", async () => {
    let finish = () => {};
    const origin = await listen((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("first;");
      finish = () => response.end("second");
    });

    const answer = await createPinnedFetch(parseEndpoint(origin))(`${origin}/v1/messages`);
    const reader = answer.body?.getReader();
    const first = await reader?.read();
    // The server is still holding the rest back.
    finish();
    const second = await reader?.read();
    const end = await reader?.read();

    const text = (piece: typeof first) => new TextDecoder().decode(piece?.value);
    expect([text(first), text(second), end?.done]).toEqual(["first;", "second", true]);
  });

  it.each([204, 304])("hand back an answer without a body for the status %i, which has none", async (status) => {
    const origin = await listen((request, response) => {
      request.resume();
      response.writeHead(status, { "request-id": "req_1" }).end();
    });

    const answer = await createPinnedFetch(parseEndpoint(origin))(`${origin}/v1/models`);

    expect(answer.status).toBe(status);
    expect(answer.body).toBeNull();
    expect(answer.headers.get("request-id")).toBe("req_1");
  });

  it("fail as fetch does when nobody listens at the address", async () => {
    const origin = await unusedAddress();

    const failure = await createPinnedFetch(parseEndpoint(origin))(`${origin}/v1/models`).catch(
      (caught: unknown) => caught,
    );

    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({ message: "fetch failed", cause: { code: "ECONNREFUSED" } });
  });

  it("fail with the reason of a signal that fires before the answer, and end an answer that is being read with it", async () => {
    let asked = 0;
    const origin = await listen((request, response) => {
      request.resume();
      // The first request is never answered; the second gets the beginning of an answer and no end.
      if (++asked === 2) response.writeHead(200).write("the beginning");
    });
    const pinnedFetch = createPinnedFetch(parseEndpoint(origin));
    const early = new AbortController();
    const late = new AbortController();

    const unanswered = pinnedFetch(`${origin}/v1/messages`, { signal: early.signal }).catch(
      (caught: unknown) => caught,
    );
    await vi.waitFor(() => expect(asked).toBe(1), { timeout: 3_000, interval: 10 });
    early.abort();
    const refusedAtOnce = await pinnedFetch(`${origin}/v1/messages`, { signal: early.signal }).catch(
      (caught: unknown) => caught,
    );
    const answer = await pinnedFetch(`${origin}/v1/messages`, { signal: late.signal });
    const reading = answer.text().catch((caught: unknown) => caught);
    late.abort();

    // The reason itself, as from fetch: the SDK goes by its name to tell a time limit from a broken connection.
    expect(await unanswered).toBe(early.signal.reason);
    expect(early.signal.reason).toMatchObject({ name: "AbortError" });
    expect(await reading).toBe(late.signal.reason);
    // A signal that has fired already: no request is made for it.
    expect(refusedAtOnce).toBe(early.signal.reason);
    expect(asked).toBe(2);
  });

  it("fail at once when the endpoint switches to another protocol, where no answer can follow", async () => {
    const origin = await listen((request) => {
      request.resume();
      // Written by hand: the server of Node does not give this answer to a plain request.
      request.socket.end("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: upgrade\r\n\r\n");
    });

    const outcome = await withinASecond(
      createPinnedFetch(parseEndpoint(origin))(`${origin}/v1/messages`).catch((caught: unknown) => caught),
    );

    // Not the wait for an answer that only the time limit of the SDK would end, ten minutes later.
    expect(outcome).toMatchObject({
      message: "fetch failed",
      cause: { message: "The connection was closed before an answer came." },
    });
  });

  it("refuse an answer that is compressed although none was asked for", async () => {
    const origin = await listen((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" }).end("not really");
    });

    const failure = await createPinnedFetch(parseEndpoint(origin))(`${origin}/v1/models`).catch(
      (caught: unknown) => caught,
    );

    expect(failure).toMatchObject({
      message: "fetch failed",
      cause: { message: 'The endpoint answered with the content encoding "gzip", although none was accepted.' },
    });
  });

  it("carry a streamed call of the SDK piece by piece", async () => {
    const model = createFakeEndpoint({ model: params.model });
    const origin = await listen(async (request, response) => {
      const answer = await model.fetch(`http://stand-in${request.url}`, {
        method: request.method ?? "GET",
        headers: { "content-type": "application/json" },
        body: await bodyOf(request),
      });
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      if (answer.body) for await (const chunk of answer.body) response.write(chunk);
      response.end();
    });
    const client = createLlmClient({ credentials: staticProvider("bearer", PLANT, origin), maxRetries: 0 });
    const arrived: number[] = [];

    const final = await client.messages
      .stream(params)
      .on("text", () => arrived.push(performance.now()))
      .finalMessage();

    expect(final.content).toMatchObject([{ type: "text", text: expect.stringMatching(/^1 2 3 .* 60$/) }]);
    expect(model.requests[0]?.headers.get("content-type")).toBe("application/json");
    // The stand-in sends eight pieces, a tenth of a second apart. They came as they were sent,
    // not all at the end: the first is well ahead of the last, also in a test run that got no
    // processor time for a while.
    expect(arrived).toHaveLength(8);
    expect((arrived.at(-1) ?? 0) - (arrived[0] ?? 0)).toBeGreaterThan(50);
  });

  it("end a call of the SDK at its time limit, and one that its caller cancels, with the SDK's own errors", async () => {
    let asked = 0;
    const origin = await listen((request) => {
      asked++;
      request.resume();
    });
    const client = createLlmClient({
      credentials: staticProvider("bearer", PLANT, origin),
      maxRetries: 0,
      timeoutMs: 200,
    });
    const controller = new AbortController();

    const timedOut = await client.messages.create(params).catch((caught: unknown) => caught);
    const cancelled = client.messages
      .create(params, { signal: controller.signal, timeout: 10_000 })
      .catch((caught: unknown) => caught);
    await vi.waitFor(() => expect(asked).toBe(2), { timeout: 3_000, interval: 10 });
    controller.abort();

    expect(timedOut).toBeInstanceOf(APIConnectionTimeoutError);
    expect(await cancelled).toBeInstanceOf(APIUserAbortError);
  });

  it("report an endpoint that cannot be reached as the SDK's connection error, with the code of the system", async () => {
    const origin = await unusedAddress();
    const client = createLlmClient({ credentials: staticProvider("bearer", PLANT, origin), maxRetries: 0 });

    const error = await client.messages.create(params).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(APIConnectionError);
    expect(error).toMatchObject({ cause: { message: "fetch failed", cause: { code: "ECONNREFUSED" } } });
  });
});

describe("the installed SDK", () => {
  /** The files of the package that Node can load, as paths from the root of the package. */
  function runtimeFiles(root: string, directory = root): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : runtimeFiles(root, path);
      return /\.(js|mjs|cjs)$/.test(entry.name) ? [relative(root, path)] : [];
    });
  }

  // The client is safe from the environment because takeEnvironment() removes every variable
  // that starts with ANTHROPIC_, and because the placeholder credential keeps the SDK from
  // looking for profiles under the directories that the other four variables name. A variable
  // outside this list, read by a later version, would be one that nothing takes away.
  it("reads no variable that the environment scrub does not cover", () => {
    const root = dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sdk"));
    const outsideThePrefix = ["HOME", "XDG_CONFIG_HOME", "APPDATA", "USERPROFILE"];
    const names = new Set<string>();
    const unreadable: string[] = [];

    for (const file of runtimeFiles(root)) {
      // The compiled CommonJS files call it as "(0, env_1.readEnv)('NAME')".
      for (const [, argument = ""] of readFileSync(join(root, file), "utf8").matchAll(/\breadEnv\)?\(([^)]*)\)/g)) {
        const name = /^\s*(['"])([A-Za-z0-9_]+)\1\s*$/.exec(argument)?.[2];
        if (name !== undefined) names.add(name);
        // A mention without an argument is prose in a comment.
        else if (argument.trim() !== "") unreadable.push(`${file}: readEnv(${argument})`);
      }
    }

    // Unless the scan finds the calls that are known to be there, it proves nothing.
    expect([...names]).toEqual(
      expect.arrayContaining([
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_CUSTOM_HEADERS",
        "ANTHROPIC_LOG",
        "HOME",
      ]),
    );
    expect(unreadable, "calls of readEnv() whose variable cannot be read from the source").toEqual([]);
    expect(
      [...names].filter((name) => !name.startsWith("ANTHROPIC_") && !outsideThePrefix.includes(name)),
      "variables that the SDK reads and takeEnvironment() leaves in place",
    ).toEqual([]);
  });
});
