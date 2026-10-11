import type { MiddlewareHandler } from "hono";
import { isApiPath } from "../shared/api.ts";

export interface ContentSecurityPolicyOptions {
  /** Policy for the Vite dev server instead of the production build. */
  dev?: boolean;
}

/**
 * One policy for the production server and, relaxed, for the Vite dev server,
 * so that a violation shows up during development and not only after a build.
 */
export function contentSecurityPolicy(options: ContentSecurityPolicyOptions = {}): string {
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    // Vite's dev HTML carries an inline module script for React Fast Refresh.
    ["script-src", options.dev ? ["'self'", "'unsafe-inline'"] : ["'self'"]],
    // A rich-text editor writes style attributes and injects a <style> element,
    // and Vite's dev server delivers all CSS as <style> elements. With every
    // fetch directive limited to 'self', inline CSS has nowhere to send data.
    ["style-src", ["'self'", "'unsafe-inline'"]],
    // Pasted images are previewed from blob: URLs; Vite inlines small assets as data: URLs.
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    // 'self' also covers the dev server's HMR WebSocket on the same host and port.
    ["connect-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(" ")}`).join("; ");
}

/** Headers for every response; the dev server sends the same set with its own policy. */
export function securityHeaderValues(options: ContentSecurityPolicyOptions = {}): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(options),
    "X-Content-Type-Options": "nosniff",
    // Not no-referrer: that makes browsers send "Origin: null" on same-origin
    // form posts and beacons. This value still sends nothing to other origins.
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    // same-site would not do: every other port on 127.0.0.1 is the same site.
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

export function securityHeaders(): MiddlewareHandler {
  const headers = Object.entries(securityHeaderValues());

  return async function securityHeaders(c, next) {
    await next();
    for (const [name, value] of headers) c.res.headers.set(name, value);
    // Notes about people must not end up in the browser's disk cache.
    if (isApiPath(c.req.path) && !c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
  };
}
