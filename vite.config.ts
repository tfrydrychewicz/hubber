import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ProxyOptions, type ServerOptions } from "vite";
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT, HOST, parsePort } from "./src/server/ports.ts";
import { securityHeaderValues } from "./src/server/security-headers.ts";
import { API_ROOT } from "./src/shared/api.ts";

// Absolute paths: Vite resolves a relative root against the working directory, not this file.
const SOURCES = join(import.meta.dirname, "src");

// True from the first request that found the API server gone until the server answers again.
let apiDown = false;

// The dev proxy hides API restarts from the browser in two ways: it keeps the browser's side of
// an event stream open after the API has gone away, and it answers 502 while the API is down,
// which makes EventSource give up for good. Dropping the connection instead looks like the
// network error the browser sees in production, so EventSource reconnects on its own.
const relayApiOutages: NonNullable<ProxyOptions["configure"]> = (proxy) => {
  proxy.on("proxyRes", (proxyRes, _req, res) => {
    apiDown = false;
    proxyRes.on("close", () => {
      if (!proxyRes.complete) res.destroy();
    });
  });
  proxy.on("error", (_err, req, res) => {
    if ("req" in res && req.headers.accept?.includes("text/event-stream")) res.destroy();
  });
};

// Vite reports every proxied request that fails, stack trace included. While the API server is
// down they all fail for the same reason, and the page alone asks for its health every few
// seconds: the reports would push the server's own account of what went wrong off the screen.
// The first report of an outage says it all. Every other error is passed on as it comes.
const reportApiOutageOnce: Plugin = {
  name: "hubber:report-api-outage-once",
  configureServer({ config: { logger } }) {
    const { error } = logger;
    logger.error = (message, options) => {
      const refused = (options?.error as NodeJS.ErrnoException | null | undefined)?.code === "ECONNREFUSED";
      if (refused && apiDown) return;
      if (refused) apiDown = true;
      error(message, options);
    };
  },
};

// Vite starts the developer's editor for any request to this address, whichever website sent
// it. Only the error overlay on the dev page needs it, and that request is same-origin.
const guardOpenInEditor: Plugin = {
  name: "hubber:guard-open-in-editor",
  configureServer(server) {
    // In the body of the hook: a function returned from it would run after Vite's own handler.
    server.middlewares.use("/__open-in-editor", (req, res, next) => {
      if (req.headers["sec-fetch-site"] === "same-origin") next();
      else res.writeHead(403).end();
    });
  },
};

function devServer(): ServerOptions {
  const apiPort = parsePort(process.env.HUBBER_PORT, DEFAULT_API_PORT, "HUBBER_PORT");
  const webPort = parsePort(process.env.HUBBER_WEB_PORT, DEFAULT_WEB_PORT, "HUBBER_WEB_PORT");
  return {
    // Vite's default is the name "localhost", which can bind ::1 only.
    host: HOST,
    port: webPort,
    // A silent move to the next free port would put the page on an origin the API does not trust.
    strictPort: true,
    // The page and the API share this origin, so nothing here needs CORS. Vite's default would
    // let pages served from any other local port read this server's own responses (module
    // sources, the HMR token). The proxied API is refused to them by the server's guard either way.
    cors: false,
    // The production policy plus what React Fast Refresh needs, so that a violation
    // shows up during development and not only after a build.
    headers: securityHeaderValues({ dev: true }),
    // Without this any file under the package root can be fetched through /@fs/,
    // including the git-ignored diagnostics reports.
    fs: { allow: [SOURCES] },
    proxy: {
      // Anchored: a plain "/api" key matches as a prefix and would also send /apix or /api-docs
      // to the API server, although they are routes of the web app.
      // Object form on purpose: the string shorthand turns on changeOrigin, which replaces
      // the browser's Host header before the API server can check it.
      [`^${API_ROOT}(?:[/?]|$)`]: { target: `http://${HOST}:${apiPort}`, configure: relayApiOutages },
    },
  };
}

export default defineConfig(({ command }) => ({
  root: join(SOURCES, "web"),
  plugins: [react(), tailwindcss(), guardOpenInEditor, reportApiOutageOnce],
  // Vite would otherwise wipe the API server's lines, which share the terminal.
  clearScreen: false,
  // Ports matter to the dev server only. Reading them during "vite build" would turn a bad
  // HUBBER_PORT into a stack trace before the server gets to report it properly.
  ...(command === "serve" && { server: devServer() }),
  build: {
    outDir: join(import.meta.dirname, "dist/web"),
    // Vite refuses to empty an output directory outside its root unless told to.
    emptyOutDir: true,
  },
}));
