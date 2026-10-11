import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { localGuard } from "./local-guard.ts";
import { contentSecurityPolicy, securityHeaders, securityHeaderValues } from "./security-headers.ts";

const HOST = "127.0.0.1:4477";

function setup() {
  const app = new Hono();
  app.use(securityHeaders());
  app.use(localGuard({ port: 4477 }));
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  app.get("/api/file", (c) => c.body("x", 200, { "Cache-Control": "private, max-age=60" }));
  app.get("/api/boom", () => {
    throw new Error("boom");
  });
  app.get("/", (c) => c.html("<!doctype html><title>Hubber</title>"));
  // Keeps the expected failure of /api/boom out of the test output.
  app.onError((_err, c) => c.json({ error: "internal" }, 500));
  return (path: string, headers: Record<string, string> = {}) =>
    app.request(path, { headers: { host: HOST, ...headers } });
}

describe("contentSecurityPolicy", () => {
  it("allows only same-origin scripts and connections in production", () => {
    expect(contentSecurityPolicy()).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
        "font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
  });

  it("differs in development only by allowing the inline React Fast Refresh script", () => {
    expect(contentSecurityPolicy({ dev: true })).toBe(
      contentSecurityPolicy().replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
    );
  });

  it("never upgrades requests to https, which would break an app served over plain http", () => {
    expect(contentSecurityPolicy()).not.toContain("upgrade-insecure-requests");
    expect(securityHeaderValues()).not.toHaveProperty("Strict-Transport-Security");
  });
});

describe("securityHeaders", () => {
  it.each([
    ["a page", "/", 200],
    ["an API response", "/api/health", 200],
    ["an unknown path", "/missing", 404],
    ["a failed handler", "/api/boom", 500],
  ])("decorates %s", async (_label, path, status) => {
    const res = await setup()(path);

    expect(res.status).toBe(status);
    expect(res.headers.get("content-security-policy")).toBe(contentSecurityPolicy());
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.has("strict-transport-security")).toBe(false);
    expect(res.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("decorates the guard's own rejections", async () => {
    const send = setup();

    for (const res of [
      await send("/api/health", { host: "attacker.example:4477" }),
      await send("/api/health", { "sec-fetch-site": "cross-site" }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("keeps API responses out of the browser cache unless the handler decides otherwise", async () => {
    const send = setup();

    expect((await send("/api/health")).headers.get("cache-control")).toBe("no-store");
    expect((await send("/api/boom")).headers.get("cache-control")).toBe("no-store");
    expect((await send("/api/file")).headers.get("cache-control")).toBe("private, max-age=60");
    expect((await send("/")).headers.has("cache-control")).toBe(false);
  });
});
