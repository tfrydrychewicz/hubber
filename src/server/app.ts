import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getMimeType } from "hono/utils/mime";
import { getPath } from "hono/utils/url";
import { isApiPath } from "../shared/api.ts";
import { HEALTH_PATH, type HealthResponse } from "../shared/health.ts";
import { isWorkspaceInfo, WORKSPACE_PATH, type WorkspaceInfo } from "../shared/workspace.ts";
import { localGuard } from "./local-guard.ts";
import { securityHeaders } from "./security-headers.ts";

export interface AppOptions {
  /** Port the server listens on. The guard accepts only requests addressed to it. */
  port: number;
  /** Origins of the Vite dev server, whose proxy forwards requests with the browser's Host and Origin. */
  devOrigins?: readonly string[];
  /**
   * Directory with the built web app, read once while the app is created. Without it only the
   * API is served, as in development.
   */
  webRoot?: string;
  /**
   * The workspace this process has opened: its name and the address it is pinned to, as the
   * workspace stores it. The server never runs without one.
   */
  workspace: { name: string; endpoint: string };
}

// Vite writes every content-hashed file into this directory (build.assetsDir).
const HASHED_ASSETS_PREFIX = "/assets/";
const CACHE_FOREVER = "public, max-age=31536000, immutable";
const CACHE_REVALIDATE = "no-cache";

// Hono's default router compiles "*" to ".*", which stops at a line terminator: a path that
// holds one would match no middleware and reach notFound unguarded. Encoded again, it
// routes like any other path.
const LINE_TERMINATORS = /[\n\r\u2028\u2029]/g;

interface WebFile {
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
}

// The build is read once, when the server starts. "npm start", "npm run build" and the
// end-to-end run all rewrite the build directory in place; a server that read it on every
// request would answer 404 while that happens and afterwards serve a web app newer than its
// own code.
function readWebApp(root: string): Map<string, WebFile> {
  const files = new Map<string, WebFile>();
  const readDirectory = (directory: string, urlPath: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      // A symbolic link is neither a directory nor a file here, so nothing outside the root is
      // ever read. readdirSync's own "recursive" option would walk into a linked directory.
      if (entry.isDirectory()) readDirectory(path, `${urlPath}${entry.name}/`);
      else if (entry.isFile()) {
        files.set(`${urlPath}${entry.name}`, {
          body: readFileSync(path),
          contentType: getMimeType(entry.name) ?? "application/octet-stream",
        });
      }
    }
  };
  readDirectory(root, "/");
  return files;
}

// The one place where what the server knows about the workspace becomes what the browser may see.
// Field by field, and of the endpoint the origin alone: an address can carry a credential or an
// account number in its user info, its path and its query, and the page shows this all the time.
function workspaceInfo({ name, endpoint }: AppOptions["workspace"]): WorkspaceInfo {
  const info = { name, endpointOrigin: URL.canParse(endpoint) ? new URL(endpoint).origin : "" };
  // Checked with the validator that the page applies, so the server cannot start with an answer
  // that the page would refuse. That holds in every browser, because the validator reads the text
  // as it is and asks no URL parser, and the parsers do not spell every host as this one does.
  // The message leaves the address out: it is not known to be harmless.
  if (!isWorkspaceInfo(info)) {
    throw new Error(
      "Nie można pokazać workspace'u w interfejsie: jego nazwa jest pusta albo adres endpointu nie zaczyna się od http:// lub https://.",
    );
  }
  return info;
}

export function createApp(options: AppOptions) {
  const base = new Hono({
    getPath: (request) => getPath(request).replace(LINE_TERMINATORS, encodeURIComponent),
  });

  base.onError((error, c) => {
    // Middleware reports client errors this way; the message, if any, is written for the client.
    if (error instanceof HTTPException) {
      return c.json({ error: "http_error", message: error.message || "Żądanie odrzucone." }, error.status);
    }
    // Details stay in the server log. The client gets a fixed message.
    console.error(error);
    return c.json({ error: "internal_error", message: "Wewnętrzny błąd serwera." }, 500);
  });

  // Order matters. The headers come first so that the guard's own refusals carry them, and
  // the guard covers every path: its origin check is safe only behind its Host check.
  base.use(securityHeaders());
  base.use(localGuard(options));

  // Hono hands only Error instances to onError. Any other thrown value would reach
  // the client as an empty 500 and leave no trace in the log. Registered last, so
  // that the two middlewares above still see the error response.
  base.use(async (_c, next) => {
    try {
      await next();
    } catch (error) {
      throw error instanceof Error
        ? error
        : new Error("A handler threw a value that is not an Error.", { cause: error });
    }
  });

  base.notFound((c) => {
    if (isApiPath(c.req.path)) return c.json({ error: "not_found", message: "Nie znaleziono zasobu." }, 404);
    return c.text("Nie znaleziono strony.", 404);
  });

  const health: HealthResponse = { status: "ok" };
  // The workspace cannot change while the process runs, so this answer, too, is built once.
  const workspace = workspaceInfo(options.workspace);
  const app = base.get(HEALTH_PATH, (c) => c.json(health)).get(WORKSPACE_PATH, (c) => c.json(workspace));

  if (options.webRoot !== undefined) {
    const files = readWebApp(options.webRoot);
    const indexHtml = files.get("/index.html");

    app.get("*", (c, next) => {
      const path = c.req.path;
      if (isApiPath(path)) return next();
      const hashed = path.startsWith(HASHED_ASSETS_PREFIX);
      // Routes of the single-page app have no file behind them. A missing hashed asset
      // stays a 404: answering it with HTML would hide a stale build behind a MIME type error.
      const file = files.get(path) ?? (hashed ? undefined : indexHtml);
      if (file === undefined) return next();
      return c.body(file.body, 200, {
        "Content-Type": file.contentType,
        "Content-Length": String(file.body.byteLength),
        "Cache-Control": hashed ? CACHE_FOREVER : CACHE_REVALIDATE,
      });
    });
  }

  return app;
}
