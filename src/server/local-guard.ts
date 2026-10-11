import type { MiddlewareHandler } from "hono";
import { isApiPath } from "../shared/api.ts";

export interface LocalGuardOptions {
  /** Port the server really listens on. */
  port: number;
  /**
   * Origins of a development front end whose proxy forwards requests here with
   * the Host header untouched (Vite's proxy without `changeOrigin`).
   */
  devOrigins?: readonly string[];
}

export type GuardErrorCode = "forbidden_host" | "forbidden_origin";

const LOOPBACK_NAMES = ["127.0.0.1", "localhost"];
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type Source = "same-origin" | "address-bar" | "cross-origin" | "not-a-browser";

// A development origin widens the guard, so it must be a loopback http origin
// in exactly the form a browser serializes it.
function devOriginUrl(value: string): URL {
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (url?.protocol !== "http:" || !LOOPBACK_NAMES.includes(url.hostname) || url.origin !== value) {
    throw new Error(
      `Niedozwolony adres deweloperski "${value}". Dozwolone są tylko adresy w postaci http://127.0.0.1:<port> lub http://localhost:<port>.`,
    );
  }
  return url;
}

// Maps each accepted Host header to the Origin a page served under that host
// sends. URL drops a default port the same way browsers do.
function allowedHosts(port: number, devOrigins: readonly string[]): Map<string, string> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new RangeError(`Niepoprawny port serwera: ${port}.`);
  const urls = [...LOOPBACK_NAMES.map((name) => new URL(`http://${name}:${port}`)), ...devOrigins.map(devOriginUrl)];
  return new Map(urls.map((url) => [url.host, url.origin]));
}

// Browsers set Sec-Fetch-Site themselves and attach Origin to every request
// that is not GET or HEAD; page scripts can forge neither. A real Origin must
// match even when Sec-Fetch-Site says same-origin, so that a proxy rewriting
// Host is noticed instead of silently trusted.
function requestSource(origin: string | undefined, site: string | undefined, expectedOrigin: string): Source {
  if (site === undefined) {
    if (origin === undefined) return "not-a-browser";
    return origin === expectedOrigin ? "same-origin" : "cross-origin";
  }
  // Under Referrer-Policy: no-referrer browsers send "null" even to their own
  // origin (forms, sendBeacon), so "null" is no evidence either way.
  if (origin !== undefined && origin !== "null" && origin !== expectedOrigin) return "cross-origin";
  if (site === "same-origin") return "same-origin";
  return site === "none" ? "address-bar" : "cross-origin";
}

/**
 * Keeps other websites away from a server that is reachable only on loopback.
 *
 * - Host must name this server. A DNS rebinding page reaches 127.0.0.1 under
 *   its own domain and the browser treats it as same-origin, so Host is the
 *   only header that gives it away.
 * - Requests that change state must not come from another origin (CSRF).
 * - Reads under /api must not either: without CORS the page cannot see the
 *   body, but it can still time the response, tell 200 from 404 and hold event
 *   streams open.
 * - Requests with neither Origin nor Sec-Fetch-Site pass. Current browsers
 *   always send one of them here, so these come from curl and scripts, which
 *   the guard cannot stop anyway.
 * - The server never answers with CORS headers.
 *
 * This is not authentication: any process on this machine can call the API.
 */
export function localGuard(options: LocalGuardOptions): MiddlewareHandler {
  const originByHost = allowedHosts(options.port, options.devOrigins ?? []);
  const [appOrigin] = originByHost.values();
  const hostMessage = `Niedozwolony nagłówek Host. Aplikacja jest dostępna pod adresem ${appOrigin}.`;

  return async function localGuard(c, next) {
    const deny = (error: GuardErrorCode, message: string) => c.json({ error, message }, 403);

    // Exact match on the raw header: c.req.url is unsuitable because the
    // adapter fills in a default host when the header is missing.
    const expectedOrigin = originByHost.get(c.req.header("host")?.toLowerCase() ?? "");
    if (expectedOrigin === undefined) return deny("forbidden_host", hostMessage);

    const read = READ_METHODS.has(c.req.method);
    // c.req.path is the decoded path the router matches on; the pathname of
    // c.req.url is not ("/%61pi/x" routes to "/api/x").
    if (!read || isApiPath(c.req.path)) {
      const source = requestSource(c.req.header("origin"), c.req.header("sec-fetch-site"), expectedOrigin);
      // The address bar and bookmarks can only read, never change state.
      const allowed = source === "same-origin" || source === "not-a-browser" || (read && source === "address-bar");
      if (!allowed) return deny("forbidden_origin", "Żądanie z innej strony zostało odrzucone.");
    }

    await next();

    // A CORS header added by any route would let another site read the response.
    for (const name of [...c.res.headers.keys()]) {
      if (name.startsWith("access-control-")) c.res.headers.delete(name);
    }
    // Explicit, because the refusals above return a response (noImplicitReturns).
    return;
  };
}
