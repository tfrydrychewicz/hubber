import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { type GuardErrorCode, type LocalGuardOptions, localGuard } from "./local-guard.ts";

const PORT = 4477;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;
const DEV_HOST = "127.0.0.1:5173";
const DEV_ORIGIN = `http://${DEV_HOST}`;

interface Shape {
  method?: string;
  /** null leaves the header out; app.request() sends no Host of its own. */
  host?: string | null;
  origin?: string;
  site?: string;
  headers?: Record<string, string>;
}

function setup(options: Partial<LocalGuardOptions> = {}) {
  const handled: string[] = [];
  const app = new Hono();
  app.use(localGuard({ port: PORT, ...options }));
  app.all("/api/cors", (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Credentials", "true");
    return c.json({ ok: true });
  });
  app.all("/api/*", (c) => {
    handled.push(`${c.req.method} ${c.req.path}`);
    return c.json({ ok: true });
  });
  app.get("*", (c) => c.html("<!doctype html><title>Hubber</title>"));

  const send = (path: string, shape: Shape = {}) => {
    const headers: Record<string, string> = { ...shape.headers };
    const host = shape.host === undefined ? HOST : shape.host;
    if (host !== null) headers.host = host;
    if (shape.origin !== undefined) headers.origin = shape.origin;
    if (shape.site !== undefined) headers["sec-fetch-site"] = shape.site;
    return app.request(path, { method: shape.method ?? "GET", headers });
  };
  return { send, handled };
}

async function expectRejected(response: Response | Promise<Response>, error: GuardErrorCode) {
  const res = await response;
  expect(res.status).toBe(403);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(await res.json()).toMatchObject({ error, message: expect.any(String) });
}

describe("localGuard: Host header", () => {
  it.each([HOST, `localhost:${PORT}`, `LOCALHOST:${PORT}`])("accepts %s", async (host) => {
    const { send } = setup();

    expect((await send("/api/health", { host })).status).toBe(200);
    expect((await send("/", { host })).status).toBe(200);
  });

  it.each([
    "example.com",
    `attacker.example:${PORT}`,
    "127.0.0.1",
    "127.0.0.1:9999",
    `0.0.0.0:${PORT}`,
    `localhost.:${PORT}`,
    `${HOST}.attacker.example`,
    `${HOST}, attacker.example`,
    "",
  ])("rejects the foreign host %j on every path and method", async (host) => {
    const { send, handled } = setup();

    await expectRejected(send("/api/health", { host }), "forbidden_host");
    await expectRejected(send("/", { host }), "forbidden_host");
    await expectRejected(send("/api/items", { method: "POST", host }), "forbidden_host");
    expect(handled).toEqual([]);
  });

  it("rejects a missing Host header", async () => {
    const { send, handled } = setup();

    await expectRejected(send("/api/health", { host: null }), "forbidden_host");
    expect(handled).toEqual([]);
  });

  it("rejects DNS rebinding even though the browser reports the request as same-origin", async () => {
    const { send, handled } = setup();
    const rebound = {
      host: `attacker.example:${PORT}`,
      origin: `http://attacker.example:${PORT}`,
      site: "same-origin",
    };

    await expectRejected(send("/api/notes", rebound), "forbidden_host");
    await expectRejected(send("/api/notes", { ...rebound, method: "POST" }), "forbidden_host");
    await expectRejected(send("/api/notes", { host: rebound.host }), "forbidden_host");
    expect(handled).toEqual([]);
  });

  it("names the address to use, taken from configuration and not from the request", async () => {
    const { send } = setup();

    const body = (await (await send("/", { host: "attacker.example" })).json()) as { message: string };

    expect(body.message).toContain(ORIGIN);
    expect(body.message).not.toContain("attacker");
  });

  it("drops the port from the expected host when the server listens on 80", async () => {
    const app = new Hono().use(localGuard({ port: 80 })).post("/api/x", (c) => c.text("ok"));
    const post = (host: string, origin: string) => app.request("/api/x", { method: "POST", headers: { host, origin } });

    expect((await post("127.0.0.1", "http://127.0.0.1")).status).toBe(200);
    expect((await post("127.0.0.1:80", "http://127.0.0.1:80")).status).toBe(403);
  });

  it.each([0, -1, 65536, 4477.5, Number.NaN])("refuses to be built for the invalid port %s", (port) => {
    expect(() => localGuard({ port })).toThrow(RangeError);
  });
});

describe("localGuard: requests that change state", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("%s with the app's own Origin passes", async (method) => {
    const { send, handled } = setup();

    expect((await send("/api/items", { method, origin: ORIGIN, site: "same-origin" })).status).toBe(200);
    expect((await send("/api/items", { method, origin: ORIGIN })).status).toBe(200);
    expect(handled).toHaveLength(2);
  });

  it.each([
    "https://evil.example",
    "null",
    "http://127.0.0.1:9999",
    `http://localhost:${PORT}`,
    `https://${HOST}`,
    `${ORIGIN}/`,
    `${ORIGIN}.evil.example`,
    "",
  ])("POST with the foreign Origin %j is rejected", async (origin) => {
    const { send, handled } = setup();

    await expectRejected(send("/api/items", { method: "POST", origin }), "forbidden_origin");
    await expectRejected(send("/api/items", { method: "POST", origin, site: "cross-site" }), "forbidden_origin");
    expect(handled).toEqual([]);
  });

  it.each(["cross-site", "same-site", "none", "unexpected", ""])(
    "POST without Origin but with Sec-Fetch-Site %j is rejected",
    async (site) => {
      const { send, handled } = setup();

      await expectRejected(send("/api/items", { method: "POST", site }), "forbidden_origin");
      expect(handled).toEqual([]);
    },
  );

  it("POST without Origin but with Sec-Fetch-Site: same-origin passes", async () => {
    const { send } = setup();

    expect((await send("/api/items", { method: "POST", site: "same-origin" })).status).toBe(200);
  });

  it("POST with neither Origin nor Sec-Fetch-Site passes, because no current browser sends that", async () => {
    const { send, handled } = setup();

    expect((await send("/api/items", { method: "POST" })).status).toBe(200);
    expect((await send("/api/items", { method: "DELETE" })).status).toBe(200);
    expect(handled).toEqual(["POST /api/items", "DELETE /api/items"]);
  });

  it("accepts Origin: null only when the browser itself vouches for same-origin", async () => {
    const { send } = setup();

    // What Safari sends for sendBeacon and Chrome for a form post under Referrer-Policy: no-referrer.
    expect((await send("/api/items", { method: "POST", origin: "null", site: "same-origin" })).status).toBe(200);
    await expectRejected(send("/api/items", { method: "POST", origin: "null", site: "same-site" }), "forbidden_origin");
  });

  it("rejects a real Origin that contradicts Sec-Fetch-Site: same-origin", async () => {
    const { send } = setup();

    await expectRejected(
      send("/api/items", { method: "POST", origin: "https://evil.example", site: "same-origin" }),
      "forbidden_origin",
    );
  });

  it("rejects the app's own Origin when Sec-Fetch-Site says the request crossed sites", async () => {
    const { send } = setup();

    await expectRejected(
      send("/api/items", { method: "POST", origin: ORIGIN, site: "cross-site" }),
      "forbidden_origin",
    );
  });

  it("guards state-changing requests outside /api as well", async () => {
    const { send } = setup();

    await expectRejected(send("/upload", { method: "POST", origin: "https://evil.example" }), "forbidden_origin");
  });

  // Both requests pass when the method counts as a read. PURGE stands for a method the guard does not list.
  it.each(["PUT", "PATCH", "DELETE", "PURGE"])("treats %s as state-changing", async (method) => {
    const { send, handled } = setup();

    await expectRejected(send("/upload", { method, origin: "https://evil.example" }), "forbidden_origin");
    await expectRejected(send("/api/items", { method, site: "none" }), "forbidden_origin");
    expect(handled).toEqual([]);
  });
});

describe("localGuard: reads under /api", () => {
  it.each([
    ["fetch from the app", { site: "same-origin" }],
    ["address bar or bookmark", { site: "none" }],
    ["curl", {}],
    ["older browser sending only Origin", { origin: ORIGIN }],
  ] as Array<[string, Shape]>)("GET passes for: %s", async (_label, shape) => {
    const { send } = setup();

    expect((await send("/api/health", shape)).status).toBe(200);
  });

  it.each([
    ["no-cors fetch, <img> or <script> on another site", { site: "cross-site" }],
    ["another port on 127.0.0.1", { site: "same-site" }],
    ["cross-origin fetch or EventSource", { origin: "https://evil.example", site: "cross-site" }],
    ["cross-origin WebSocket handshake or old browser", { origin: "https://evil.example" }],
    ["sandboxed frame", { origin: "null" }],
    [
      "CORS preflight",
      {
        method: "OPTIONS",
        origin: "https://evil.example",
        site: "cross-site",
        headers: { "access-control-request-method": "DELETE" },
      },
    ],
  ] as Array<[string, Shape]>)("is rejected for: %s", async (_label, shape) => {
    const { send, handled } = setup();

    await expectRejected(send("/api/events", shape), "forbidden_origin");
    expect(handled).toEqual([]);
  });

  it("rejects HEAD from another site", async () => {
    const { send, handled } = setup();

    expect((await send("/api/events", { method: "HEAD", site: "cross-site" })).status).toBe(403);
    expect((await send("/api/events", { method: "HEAD", site: "same-origin" })).status).toBe(200);
    expect(handled).toEqual(["HEAD /api/events"]);
  });

  it.each(["/api", "/api/", "/%61pi/notes", "/api/./notes", "/x/../api/notes"])(
    "covers the path spelling %s",
    async (path) => {
      const { send, handled } = setup();

      await expectRejected(send(path, { site: "cross-site" }), "forbidden_origin");
      expect(handled).toEqual([]);
    },
  );
});

describe("localGuard: reads outside /api", () => {
  it.each(["/", "/items/123", "/assets/index.js", "/apiary"])("lets a link on another site open %s", async (path) => {
    const { send } = setup();

    const res = await send(path, {
      site: "cross-site",
      headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    });

    expect(res.status).toBe(200);
  });
});

describe("localGuard: development origin", () => {
  const viaProxy = { host: DEV_HOST, origin: DEV_ORIGIN, site: "same-origin" };

  it("is unknown unless configured", async () => {
    const { send } = setup();

    await expectRejected(send("/api/health", { host: DEV_HOST, site: "same-origin" }), "forbidden_host");
    await expectRejected(send("/api/items", { ...viaProxy, method: "POST" }), "forbidden_host");
  });

  it("is accepted when configured and the proxy kept the Host header", async () => {
    const { send, handled } = setup({ devOrigins: [DEV_ORIGIN] });

    expect((await send("/api/health", { host: DEV_HOST, site: "same-origin" })).status).toBe(200);
    expect((await send("/api/items", { ...viaProxy, method: "POST" })).status).toBe(200);
    expect((await send("/api/health")).status).toBe(200);
    expect(handled).toHaveLength(3);
  });

  it("does not let a page on the development port call the API port directly", async () => {
    const { send } = setup({ devOrigins: [DEV_ORIGIN] });

    await expectRejected(
      send("/api/items", { method: "POST", origin: DEV_ORIGIN, site: "same-site" }),
      "forbidden_origin",
    );
    await expectRejected(send("/api/items", { origin: DEV_ORIGIN, site: "same-site" }), "forbidden_origin");
  });

  it("refuses writes when the proxy rewrites Host (changeOrigin), so the misconfiguration is noticed", async () => {
    const { send } = setup({ devOrigins: [DEV_ORIGIN] });

    await expectRejected(
      send("/api/items", { method: "POST", host: HOST, origin: DEV_ORIGIN, site: "same-origin" }),
      "forbidden_origin",
    );
  });

  it("still requires the Origin to belong to the host that was addressed", async () => {
    const { send } = setup({ devOrigins: [DEV_ORIGIN] });

    await expectRejected(send("/api/items", { method: "POST", host: DEV_HOST, origin: ORIGIN }), "forbidden_origin");
    await expectRejected(
      send("/api/items", { method: "POST", host: DEV_HOST, origin: "http://localhost:5173" }),
      "forbidden_origin",
    );
  });

  it.each([
    "https://127.0.0.1:5173",
    "http://192.168.1.10:5173",
    "http://hubber.example:5173",
    "http://[::1]:5173",
    "http://127.0.0.1:5173/",
    "http://127.0.0.1:5173/app",
    "http://LOCALHOST:5173",
    "http://user@127.0.0.1:5173",
    "127.0.0.1:5173",
    "*",
  ])("refuses to be built with the development origin %j", (origin) => {
    expect(() => localGuard({ port: PORT, devOrigins: [origin] })).toThrow(/Niedozwolony adres deweloperski/);
  });

  it("accepts both loopback names", () => {
    expect(() => localGuard({ port: PORT, devOrigins: [DEV_ORIGIN, "http://localhost:5173"] })).not.toThrow();
  });
});

describe("localGuard: IPv6 loopback", () => {
  it("rejects [::1] as Host, because the server does not listen there", async () => {
    const { send } = setup();

    await expectRejected(send("/api/health", { host: `[::1]:${PORT}` }), "forbidden_host");
    await expectRejected(send("/", { host: `[::1]:${PORT}` }), "forbidden_host");
  });

  it("rejects [::1] as Origin", async () => {
    const { send } = setup();

    await expectRejected(send("/api/items", { method: "POST", origin: `http://[::1]:${PORT}` }), "forbidden_origin");
  });
});

describe("localGuard: CORS", () => {
  const corsHeaders = (res: Response) => [...res.headers.keys()].filter((name) => name.startsWith("access-control-"));

  it("never answers with Access-Control-Allow-Origin, whatever the request", async () => {
    const { send } = setup({ devOrigins: [DEV_ORIGIN] });
    const preflight = { "access-control-request-method": "POST", "access-control-request-headers": "content-type" };
    const shapes: Array<[string, Shape]> = [
      ["/api/health", {}],
      ["/api/health", { site: "same-origin" }],
      ["/api/health", { origin: ORIGIN }],
      ["/api/health", { origin: "https://evil.example", site: "cross-site" }],
      ["/api/items", { method: "POST", origin: ORIGIN, site: "same-origin" }],
      ["/api/items", { method: "POST", origin: "https://evil.example" }],
      ["/api/items", { method: "OPTIONS", origin: ORIGIN, site: "same-origin", headers: preflight }],
      ["/api/items", { method: "OPTIONS", origin: "https://evil.example", site: "cross-site", headers: preflight }],
      ["/", { method: "OPTIONS", origin: "https://evil.example", site: "cross-site", headers: preflight }],
      ["/", { origin: "https://evil.example", site: "cross-site" }],
      ["/api/health", { host: "attacker.example", origin: "http://attacker.example" }],
      ["/api/health", { host: DEV_HOST, origin: DEV_ORIGIN, site: "same-origin" }],
      ["/api/health", { host: null }],
    ];

    for (const [path, shape] of shapes) {
      const res = await send(path, shape);

      expect(res.headers.has("access-control-allow-origin"), `${path} ${JSON.stringify(shape)}`).toBe(false);
      expect(corsHeaders(res)).toEqual([]);
    }
  });

  it("removes CORS headers that a route added", async () => {
    const { send } = setup();

    const res = await send("/api/cors", { origin: ORIGIN, site: "same-origin" });

    expect(res.status).toBe(200);
    expect(corsHeaders(res)).toEqual([]);
  });
});
