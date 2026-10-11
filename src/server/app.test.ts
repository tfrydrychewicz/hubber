import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HTTPException } from "hono/http-exception";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type AppOptions, createApp } from "./app.ts";
import { type RunningServer, startServer } from "./listen.ts";
import { rawGet } from "./testing.ts";

const INDEX_HTML =
  '<!doctype html><html lang="pl"><head><title>Hubber</title></head><body><div id="root"></div></body></html>';
const OUTSIDE_MARKER = "PLIK-SPOZA-KATALOGU-WEB";
const NOT_FOUND_BODY = { error: "not_found", message: "Nie znaleziono zasobu." };
const PORT = 4477;
// app.request() sends no Host header of its own, and the guard refuses a request without one.
const HOST_HEADER = `127.0.0.1:${PORT}`;

type App = ReturnType<typeof createApp>;

function buildApp(options: Partial<AppOptions> = {}): App {
  return createApp({ port: PORT, ...options });
}

function request(app: App, path: string, init: RequestInit = {}) {
  return app.request(path, { ...init, headers: { host: HOST_HEADER, ...(init.headers as Record<string, string>) } });
}

let workDir: string;
let webRoot: string;

beforeAll(() => {
  // Mirrors the real layout: the web root sits two levels below files that must stay private.
  workDir = mkdtempSync(join(tmpdir(), "hubber-app-"));
  webRoot = join(workDir, "dist", "web");
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(join(webRoot, "index.html"), INDEX_HTML);
  writeFileSync(join(webRoot, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(webRoot, "assets", "index-abc12345.js"), 'console.log("hubber");');
  writeFileSync(join(webRoot, "assets", "index-def67890.css"), "body{margin:0}");
  writeFileSync(join(workDir, "package.json"), OUTSIDE_MARKER);
  writeFileSync(join(workDir, "dist", "secret.txt"), OUTSIDE_MARKER);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("API", () => {
  it("reports health", async () => {
    const response = await request(buildApp(), "/api/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it.each([
    ["GET", "/api"],
    ["GET", "/api/"],
    ["GET", "/api/nie-ma"],
    ["GET", "/api/health/extra"],
    ["POST", "/api/health"],
    ["DELETE", "/api/nie-ma"],
  ])("answers %s %s with a JSON 404", async (method, path) => {
    const response = await request(buildApp({ webRoot }), path, { method });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
  });

  it("hides the details of an unexpected error and logs them on the server", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = buildApp();
    const failure = new Error("SQLITE_BUSY: /Users/someone/hubber/workspace.db");
    app.get("/api/boom", () => {
      throw failure;
    });

    const response = await request(app, "/api/boom");
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "internal_error", message: "Wewnętrzny błąd serwera." });
    expect(text).not.toContain("SQLITE_BUSY");
    expect(text).not.toContain("workspace.db");
    expect(text).not.toMatch(/\bat\s.+:\d+/);
    expect(logged).toHaveBeenCalledWith(failure);
  });

  it.each([
    ["a string", "SQLITE_BUSY: workspace.db"],
    ["an object", { reason: "SQLITE_BUSY: workspace.db" }],
  ])("treats %s thrown in place of an Error the same way", async (_label, thrown) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = buildApp();
    app.get("/api/boom", () => Promise.reject(thrown));

    const response = await request(app, "/api/boom");
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "internal_error", message: "Wewnętrzny błąd serwera." });
    expect(text).not.toContain("SQLITE_BUSY");
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ cause: thrown }));
  });

  it("keeps the status and the message of an HTTPException", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = buildApp();
    app.get("/api/teapot", () => {
      throw new HTTPException(418, { message: "Niepoprawne żądanie." });
    });

    const response = await request(app, "/api/teapot");

    expect(response.status).toBe(418);
    expect(await response.json()).toEqual({ error: "http_error", message: "Niepoprawne żądanie." });
    expect(logged).not.toHaveBeenCalled();
  });

  it("gives an HTTPException without a message a generic one", async () => {
    const app = buildApp();
    app.get("/api/forbidden", () => {
      throw new HTTPException(403, { res: new Response("Forbidden", { status: 403 }) });
    });

    const response = await request(app, "/api/forbidden");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "http_error", message: "Żądanie odrzucone." });
  });
});

describe("guard and security headers", () => {
  it("refuses a request addressed to another host", async () => {
    const response = await buildApp({ webRoot }).request("/", { headers: { host: "attacker.example:4477" } });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden_host" });
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("refuses a write from another origin before any route runs", async () => {
    const app = buildApp();
    let handled = false;
    app.post("/api/items", (c) => {
      handled = true;
      return c.json({ created: true });
    });

    const response = await request(app, "/api/items", { method: "POST", headers: { origin: "https://evil.example" } });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden_origin" });
    expect(handled).toBe(false);
  });

  it.each([
    ["an Error", new Error("boom")],
    ["a value that is not an Error", "boom"],
  ])("decorates the response to %s thrown by a handler", async (_label, thrown) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = buildApp();
    app.get("/api/boom", () => Promise.reject(thrown));

    const response = await request(app, "/api/boom");

    expect(response.status).toBe(500);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts a development origin only when configured", async () => {
    const viaProxy = { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-origin" };

    const closed = await buildApp().request("/api/health", { headers: viaProxy });
    const open = await buildApp({ devOrigins: ["http://127.0.0.1:5173"] }).request("/api/health", {
      headers: viaProxy,
    });

    expect(closed.status).toBe(403);
    expect(open.status).toBe(200);
  });

  // The default router matches "*" with ".*", which stops at a line terminator. The path with
  // two of them is there because every one has to be encoded again, not just the first.
  it.each(["/x%0a", "/api/x%0d", "/%E2%80%A8", "/api/x%E2%80%A9", "/x%0d%0a"])(
    "covers the path %s, which holds an encoded line terminator",
    async (path) => {
      const app = buildApp({ webRoot });

      const foreignHost = await app.request(path, { headers: { host: "attacker.example:4477" } });
      const foreignWrite = await request(app, path, { method: "POST", headers: { origin: "https://evil.example" } });
      const own = await request(app, path);

      expect(foreignHost.status).toBe(403);
      expect(await foreignHost.json()).toMatchObject({ error: "forbidden_host" });
      expect(foreignWrite.status).toBe(403);
      expect(await foreignWrite.json()).toMatchObject({ error: "forbidden_origin" });
      expect(own.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(own.headers.get("x-frame-options")).toBe("DENY");
      expect(own.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    },
  );

  it("still hands a route the decoded value of a parameter that holds a line terminator", async () => {
    const app = buildApp();
    app.get("/api/items/:id", (c) => c.json({ id: c.req.param("id") }));

    expect(await (await request(app, "/api/items/a%0ab")).json()).toEqual({ id: "a\nb" });
    expect(await (await request(app, "/api/items/a%250Ab")).json()).toEqual({ id: "a%0Ab" });
  });
});

describe("without a web root", () => {
  it("serves the API only", async () => {
    const app = buildApp();

    expect((await request(app, "/api/health")).status).toBe(200);
    const response = await request(app, "/");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Nie znaleziono strony.");
  });
});

describe("with a web root", () => {
  it.each(["/", "/index.html"])("serves index.html at %s and asks the browser to revalidate it", async (path) => {
    const response = await request(buildApp({ webRoot }), path);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toBe(INDEX_HTML);
  });

  it.each([
    ["/assets/index-abc12345.js", "text/javascript; charset=utf-8", 'console.log("hubber");'],
    ["/assets/index-def67890.css", "text/css; charset=utf-8", "body{margin:0}"],
  ])("serves the hashed asset %s as immutable", async (path, contentType, body) => {
    const response = await request(buildApp({ webRoot }), path);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(contentType);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe(body);
  });

  it("does not let the browser keep unhashed files", async () => {
    const response = await request(buildApp({ webRoot }), "/favicon.svg");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  it.each(["/projects/42", "/people/jan.kowalski", "/apix", "/assets"])(
    "falls back to index.html for the app route %s",
    async (path) => {
      const response = await request(buildApp({ webRoot }), path);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(await response.text()).toBe(INDEX_HTML);
    },
  );

  it("answers a missing hashed asset with 404 instead of index.html", async () => {
    const response = await request(buildApp({ webRoot }), "/assets/index-00000000.js");

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBeNull();
    expect(await response.text()).toBe("Nie znaleziono strony.");
  });

  it("answers HEAD like GET, without a body", async () => {
    const response = await request(buildApp({ webRoot }), "/projects/42", { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(INDEX_HTML.length));
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toBe("");
  });

  it.each(["POST", "PUT", "DELETE"])("does not serve files for %s", async (method) => {
    for (const path of ["/", "/assets/index-abc12345.js", "/projects/42"]) {
      const response = await request(buildApp({ webRoot }), path, { method });

      expect(response.status).toBe(404);
    }
  });

  it("does not let files shadow the API", async () => {
    const shadowRoot = join(workDir, "shadow");
    mkdirSync(join(shadowRoot, "api"), { recursive: true });
    writeFileSync(join(shadowRoot, "index.html"), INDEX_HTML);
    writeFileSync(join(shadowRoot, "api", "health"), "plik zamiast API");
    writeFileSync(join(shadowRoot, "api", "other.txt"), "plik zamiast API");
    const app = buildApp({ webRoot: shadowRoot });

    expect(await (await request(app, "/api/health")).json()).toEqual({ status: "ok" });
    const response = await request(app, "/api/other.txt");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
  });

  it("serves a file two directories down, as a byte stream when its extension is unknown", async () => {
    const root = join(workDir, "nested");
    mkdirSync(join(root, "fonts", "inter"), { recursive: true });
    writeFileSync(join(root, "index.html"), INDEX_HTML);
    writeFileSync(join(root, "fonts", "inter", "regular.font2"), "glyphs");

    const response = await request(buildApp({ webRoot: root }), "/fonts/inter/regular.font2");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(await response.text()).toBe("glyphs");
  });

  it("keeps serving the build it started with while the directory is rebuilt", async () => {
    const root = join(workDir, "rebuilt");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "index.html"), INDEX_HTML);
    writeFileSync(join(root, "assets", "index-old00000.js"), "old");
    const app = buildApp({ webRoot: root });

    // What "vite build" does: the directory is emptied, then files with new names appear.
    rmSync(root, { recursive: true });
    expect(await (await request(app, "/")).text()).toBe(INDEX_HTML);
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<!doctype html><title>new</title>");
    writeFileSync(join(root, "assets", "index-new00000.js"), "new");

    expect(await (await request(app, "/")).text()).toBe(INDEX_HTML);
    expect(await (await request(app, "/assets/index-old00000.js")).text()).toBe("old");
    expect((await request(app, "/assets/index-new00000.js")).status).toBe(404);
  });

  it("cannot be built for a web root that does not exist", () => {
    expect(() => buildApp({ webRoot: join(workDir, "missing") })).toThrow(/ENOENT/);
  });
});

describe("path traversal", () => {
  const ATTEMPTS = [
    "/..%2f..%2fpackage.json",
    "/%2e%2e/%2e%2e/package.json",
    "/assets/../../../package.json",
    "/../../package.json",
    "/../secret.txt",
    "/%2e%2e/secret.txt",
    "/..%2fsecret.txt",
    "/assets/..%2f..%2fsecret.txt",
    "/assets/../../secret.txt",
    "/..%5c..%5cpackage.json",
    "/..\\..\\package.json",
    "/.%2e/.%2e/package.json",
    "/%252e%252e/%252e%252e/package.json",
    "/....//....//package.json",
    "/assets//../../../package.json",
  ];

  let server: RunningServer;

  beforeAll(async () => {
    server = await startServer({ port: 0, app: ({ port }) => createApp({ port, webRoot }) });
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns file contents for a path inside the web root (control)", async () => {
    const response = await rawGet({ port: server.port, target: "/assets/index-abc12345.js" });

    expect(response).toMatch(/^HTTP\/1\.1 200 /);
    expect(response).toContain('console.log("hubber");');
  });

  // fetch() and curl normalise dot segments before sending, so the request line is written by hand.
  it.each(ATTEMPTS)("never leaves the web root for %s", async (target) => {
    const response = await rawGet({ port: server.port, target });

    expect(response).toMatch(/^HTTP\/1\.1 (200|404) /);
    expect(response).not.toContain(OUTSIDE_MARKER);
  });

  // The adapter normalises the URL before Hono sees it. This goes around the adapter to
  // check that the static handler holds on its own.
  it.each(ATTEMPTS)("never leaves the web root for %s without URL normalisation", async (target) => {
    const raw = {
      url: `http://${HOST_HEADER}${target}`,
      method: "GET",
      headers: new Headers({ host: HOST_HEADER }),
    } as unknown as Request;

    const response = await buildApp({ webRoot }).fetch(raw);

    expect([200, 404]).toContain(response.status);
    expect(await response.text()).not.toContain(OUTSIDE_MARKER);
  });

  it("serves nothing through a symbolic link that points out of the web root", async () => {
    const root = join(workDir, "linked");
    mkdirSync(root);
    writeFileSync(join(root, "index.html"), INDEX_HTML);
    symlinkSync(join(workDir, "dist", "secret.txt"), join(root, "secret.txt"));
    symlinkSync(join(workDir, "dist"), join(root, "outside"));
    const app = buildApp({ webRoot: root });

    // Both are app routes with no file behind them, as far as the server is concerned.
    expect(await (await request(app, "/secret.txt")).text()).toBe(INDEX_HTML);
    expect(await (await request(app, "/outside/secret.txt")).text()).toBe(INDEX_HTML);
  });
});
