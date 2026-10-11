// The authorizer called by hand, for what a call through the SDK cannot be made to do. Its work
// inside the real client is tested in ../client.test.ts.
import type { APIRequest, MiddlewareContext } from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { parseEndpoint } from "../endpoint.ts";
import { createAuthorizer, EndpointPinError } from "./authorize.ts";
import { redactSecrets, Secret } from "./secret.ts";
import { type AuthScheme, CredentialError, type CredentialProvider } from "./types.ts";

const ENDPOINT = parseEndpoint("https://router.corp.example/llm");
const MESSAGES = `${ENDPOINT.href}/v1/messages`;
// The authorizer does not use it.
const CONTEXT = {} as MiddlewareContext;

function secret(value: string): Secret {
  const parsed = Secret.parse(value);
  if (typeof parsed === "string") throw new Error(`Not accepted as a secret: ${parsed}`);
  return parsed;
}

interface Source {
  scheme?: AuthScheme;
  /** What get() resolves with. */
  current?: string;
  /** What renew() resolves with; null when the source has nothing newer. */
  renewed?: string | null;
  failure?: CredentialError;
}

/** A provider that hands out what it is told to and counts how often it is asked. */
function source({ scheme = "bearer", current = "token-in-use-0001", renewed = null, failure }: Source = {}) {
  const asked = { get: 0, renew: [] as string[] };
  const credentials: CredentialProvider = {
    target: { endpoint: ENDPOINT, scheme },
    status: () => ({ available: true, source: "env", variable: "ANTHROPIC_AUTH_TOKEN" }),
    async get() {
      asked.get++;
      if (failure) throw failure;
      return secret(current);
    },
    async renew(rejected) {
      asked.renew.push(rejected.reveal());
      if (failure) throw failure;
      return renewed === null ? null : secret(renewed);
    },
    // The cleaning itself is the real one: the authorizer is what puts it in the right places.
    redact: (text) => redactSecrets(text, [secret(current), secret(renewed ?? current)]),
    close() {},
  };
  return { credentials, asked };
}

function request(url = MESSAGES, init: Partial<APIRequest> = {}): APIRequest {
  return {
    url,
    method: "POST",
    headers: new Headers({ authorization: "Bearer placeholder", "x-api-key": "found-by-the-sdk" }),
    body: JSON.stringify({ model: "m" }),
    ...init,
  };
}

/** The rest of the chain: answers with the given responses in turn and records what it was sent. */
function chain(...responses: Response[]) {
  const sent: { authorization: string | null; xApiKey: string | null }[] = [];
  const next = async (outgoing: APIRequest) => {
    sent.push({ authorization: outgoing.headers.get("authorization"), xApiKey: outgoing.headers.get("x-api-key") });
    const response = responses[sent.length - 1];
    if (response === undefined) throw new Error("The request was sent more often than the test expects");
    return response;
  };
  return { next, sent };
}

const unauthorized = (text = "expired") =>
  Response.json({ type: "error", error: { type: "authentication_error", message: text } }, { status: 401 });

describe("createAuthorizer", () => {
  it.each([
    ["another host", "https://evil.example/v1/messages"],
    ["a host that only begins the same", "https://router.corp.example.evil.example/llm/v1/messages"],
    ["another port", "https://router.corp.example:8443/llm/v1/messages"],
    ["another scheme", "http://router.corp.example/llm/v1/messages"],
    ["another path of the host", "https://router.corp.example/other/v1/messages"],
    ["a path that only begins the same", "https://router.corp.example/llmx/v1/messages"],
    ["a path that walks out of the base path", "https://router.corp.example/llm/../admin/v1/messages"],
    ["an address with a user name", "https://user@router.corp.example/llm/v1/messages"],
    ["an address that does not parse", "router.corp.example/llm/v1/messages"],
  ])("stops a request to %s before any credential is asked for", async (_case, url) => {
    const { credentials, asked } = source();
    const { next, sent } = chain(Response.json({}));

    const outcome = createAuthorizer(credentials)(request(url), next, CONTEXT);

    await expect(outcome).rejects.toThrow(EndpointPinError);
    await expect(outcome).rejects.toThrow(
      "Żądanie poza endpoint workspace'u (https://router.corp.example/llm) zostało zatrzymane.",
    );
    expect(sent).toEqual([]);
    expect(asked.get).toBe(0);
  });

  it.each([
    ["bearer", { authorization: "Bearer token-in-use-0001", xApiKey: null }],
    ["x-api-key", { authorization: null, xApiKey: "token-in-use-0001" }],
  ] as const)(
    "sends the credential the %s way and removes whatever else the request carried",
    async (scheme, headers) => {
      const { credentials } = source({ scheme });
      const { next, sent } = chain(Response.json({}));

      await createAuthorizer(credentials)(request(), next, CONTEXT);

      expect(sent).toEqual([headers]);
    },
  );

  it("hands a successful response on as it is, unread", async () => {
    const { credentials } = source();
    const answer = Response.json({ echo: "token-in-use-0001" });
    const { next } = chain(answer);

    const response = await createAuthorizer(credentials)(request(), next, CONTEXT);

    expect(response).toBe(answer);
    expect(response.bodyUsed).toBe(false);
  });

  it("takes the credential out of an error body and drops the headers that described the original bytes", async () => {
    const { credentials, asked } = source();
    const { next } = chain(
      new Response("Invalid credential: Bearer token-in-use-0001", {
        status: 403,
        statusText: "Forbidden",
        headers: { "content-length": "44", "content-encoding": "identity", "request-id": "req_1" },
      }),
    );

    const response = await createAuthorizer(credentials)(request(), next, CONTEXT);

    expect(await response.text()).toBe("Invalid credential: Bearer [ukryte]");
    expect({ status: response.status, statusText: response.statusText }).toEqual({
      status: 403,
      statusText: "Forbidden",
    });
    expect(response.headers.get("request-id")).toBe("req_1");
    expect(response.headers.has("content-length")).toBe(false);
    expect(response.headers.has("content-encoding")).toBe(false);
    // Only a 401 is a reason to ask for another credential.
    expect(asked.renew).toEqual([]);
  });

  it("cleans an error body as text, before a parser could turn its escapes back into the credential", async () => {
    // With slashes and an equals sign, which writers of JSON may escape and JSON.stringify() does not.
    const current = "token/in+use/0001==";
    const { credentials } = source({ current });
    const escaped = current.replaceAll("/", "\\/").replaceAll("=", "\\u003d");
    const { next } = chain(
      new Response(`{"error":{"message":"refused ${escaped}"},"seen":{"${escaped}":1}}`, {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await createAuthorizer(credentials)(request(), next, CONTEXT);
    const body = await response.text();

    expect(body).toBe('{"error":{"message":"refused [ukryte]"},"seen":{"[ukryte]":1}}');
    // Parsed, as the SDK does next, it holds nothing of the credential.
    expect(JSON.parse(body)).toEqual({ error: { message: "refused [ukryte]" }, seen: { "[ukryte]": 1 } });
  });

  it("takes the credential out of the headers of an error, and leaves the others as they are", async () => {
    const { credentials } = source();
    const { next } = chain(
      new Response("refused", {
        status: 403,
        headers: [
          ["request-id", "req-for-token-in-use-0001"],
          ["location", "https://login.example/?token=token-in-use-0001"],
          ["set-cookie", "seen=token-in-use-0001; Path=/"],
          ["set-cookie", "other=1"],
          ["retry-after", "3"],
        ],
      }),
    );

    const response = await createAuthorizer(credentials)(request(), next, CONTEXT);

    expect(response.headers.get("request-id")).toBe("req-for-[ukryte]");
    expect(response.headers.get("location")).toBe("https://login.example/?token=[ukryte]");
    expect(response.headers.getSetCookie()).toEqual(["seen=[ukryte]; Path=/", "other=1"]);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.text()).toBe("refused");
  });

  it("hands on an answer that has no body to clean", async () => {
    const { credentials } = source();
    const answer = new Response(null, { status: 304 });
    const { next } = chain(answer);

    expect(await createAuthorizer(credentials)(request(), next, CONTEXT)).toBe(answer);
  });

  it("cleans the headers of an answer that has no body", async () => {
    const { credentials } = source();
    const { next } = chain(
      new Response(null, { status: 304, headers: { etag: '"token-in-use-0001"', vary: "accept" } }),
    );

    const response = await createAuthorizer(credentials)(request(), next, CONTEXT);

    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    expect(Object.fromEntries(response.headers)).toEqual({ etag: '"[ukryte]"', vary: "accept" });
  });

  it("after a 401 sends the request once more, with the renewed credential", async () => {
    const { credentials, asked } = source({ renewed: "token-renewed-0002" });
    const { next, sent } = chain(unauthorized(), Response.json({ ok: true }));

    const response = await createAuthorizer(credentials)(request(), next, CONTEXT);

    expect(await response.json()).toEqual({ ok: true });
    expect(sent.map((headers) => headers.authorization)).toEqual([
      "Bearer token-in-use-0001",
      "Bearer token-renewed-0002",
    ]);
    expect(asked.renew).toEqual(["token-in-use-0001"]);
  });

  it("hands the second 401 on instead of asking again", async () => {
    const { credentials, asked } = source({ renewed: "token-renewed-0002" });
    const { next, sent } = chain(unauthorized("expired"), unauthorized("still refused: token-renewed-0002"));

    const response = await createAuthorizer(credentials)(request(), next, CONTEXT);

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("still refused: [ukryte]");
    expect(sent).toHaveLength(2);
    expect(asked.renew).toHaveLength(1);
  });

  it("hands the 401 on, cleaned, when the source has nothing newer", async () => {
    const { credentials } = source({ renewed: null });
    const { next, sent } = chain(unauthorized("refused: token-in-use-0001"));

    const response = await createAuthorizer(credentials)(request(), next, CONTEXT);

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("refused: [ukryte]");
    expect(sent).toHaveLength(1);
  });

  it("does not send a body again that can be read only once", async () => {
    const { credentials, asked } = source({ renewed: "token-renewed-0002" });
    const { next, sent } = chain(unauthorized());
    const once = new Blob(["{}"]).stream();

    const response = await createAuthorizer(credentials)(request(MESSAGES, { body: once }), next, CONTEXT);

    expect(response.status).toBe(401);
    expect(sent).toHaveLength(1);
    expect(asked.renew).toEqual([]);
  });

  it("sends a request without a body again as well", async () => {
    const { credentials } = source({ renewed: "token-renewed-0002" });
    const { next, sent } = chain(unauthorized(), Response.json({ data: [] }));
    const listing = { url: `${ENDPOINT.href}/v1/models`, method: "GET", headers: new Headers() };

    const response = await createAuthorizer(credentials)(listing, next, CONTEXT);

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(2);
  });

  describe("for a request that its caller cancels", () => {
    /** A provider whose answers come when the test says so, if ever. */
    function slowSource() {
      const { credentials, asked } = source({ renewed: "token-renewed-0002" });
      const handOut = { get: () => {}, renew: () => {} };
      credentials.get = () => {
        asked.get++;
        return new Promise((resolve) => {
          handOut.get = () => resolve(secret("token-in-use-0001"));
        });
      };
      credentials.renew = (rejected) => {
        asked.renew.push(rejected.reveal());
        return new Promise((resolve) => {
          handOut.renew = () => resolve(secret("token-renewed-0002"));
        });
      };
      return { credentials, asked, handOut };
    }
    /** What the authorizer ended with if it has ended, or "pending". */
    const outcomeSoFar = (pending: Promise<Response>) =>
      Promise.race([
        pending.then(
          () => "resolved",
          (error: unknown) => error,
        ),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
      ]);

    it("stops waiting for the credential at once, with the reason of the signal, and sends nothing", async () => {
      const { credentials, handOut } = slowSource();
      const { next, sent } = chain(Response.json({}));
      const controller = new AbortController();

      const pending = createAuthorizer(credentials)(request(MESSAGES, { signal: controller.signal }), next, CONTEXT);
      expect(await outcomeSoFar(pending)).toBe("pending");
      controller.abort();

      // The reason itself: the SDK makes its own error for a cancelled call out of the signal.
      await expect(pending).rejects.toBe(controller.signal.reason);
      // The credential that arrives afterwards is for whoever else waits for it.
      handOut.get();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(sent).toEqual([]);
    });

    it("stops waiting for a renewed credential at once, and does not send the request again", async () => {
      const { credentials, asked, handOut } = slowSource();
      const { next, sent } = chain(unauthorized(), Response.json({}));
      const controller = new AbortController();

      const pending = createAuthorizer(credentials)(request(MESSAGES, { signal: controller.signal }), next, CONTEXT);
      handOut.get();
      await vi.waitFor(() => expect(asked.renew).toEqual(["token-in-use-0001"]));
      controller.abort();

      await expect(pending).rejects.toBe(controller.signal.reason);
      handOut.renew();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(sent).toHaveLength(1);
    });

    it("does not even ask for a credential when the call is cancelled already", async () => {
      const { credentials, asked } = source();
      const { next, sent } = chain(Response.json({}));
      const cancelled = AbortSignal.abort();

      const outcome = createAuthorizer(credentials)(request(MESSAGES, { signal: cancelled }), next, CONTEXT);

      await expect(outcome).rejects.toBe(cancelled.reason);
      expect(asked.get).toBe(0);
      expect(sent).toEqual([]);
    });

    it("goes on as usual when the signal never fires", async () => {
      const { credentials } = source();
      const { next, sent } = chain(Response.json({}));

      const response = await createAuthorizer(credentials)(
        request(MESSAGES, { signal: new AbortController().signal }),
        next,
        CONTEXT,
      );

      expect(response.status).toBe(200);
      expect(sent).toEqual([{ authorization: "Bearer token-in-use-0001", xApiKey: null }]);
    });
  });

  it("lets a failing source reach the caller as it is, without a request", async () => {
    const failure = new CredentialError('Polecenie pomocnicze "/bin/echo" zakończyło się kodem 1.');
    const { credentials } = source({ failure });
    const { next, sent } = chain(Response.json({}));

    await expect(createAuthorizer(credentials)(request(), next, CONTEXT)).rejects.toBe(failure);
    expect(sent).toEqual([]);
  });

  it("reads the refused answer to its end before a renewal that fails", async () => {
    const failure = new CredentialError('Polecenie pomocnicze "/bin/echo" zakończyło się kodem 1.');
    const { credentials } = source();
    credentials.renew = async () => {
      throw failure;
    };
    const refused = unauthorized();
    const { next } = chain(refused);

    await expect(createAuthorizer(credentials)(request(), next, CONTEXT)).rejects.toBe(failure);
    // A body left unread would keep the connection to the endpoint busy.
    expect(refused.bodyUsed).toBe(true);
  });
});
