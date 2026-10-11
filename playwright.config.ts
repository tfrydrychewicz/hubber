import { defineConfig } from "@playwright/test";
import { egressLogBeside, observerOptions } from "./e2e/egress.ts";
import { DEFAULT_E2E_PORT, HOST, parsePort } from "./src/server/ports.ts";
import { TEST_WORKSPACE } from "./src/server/testing.ts";
import { e2eWorkspaceDir } from "./src/server/workspace/location.ts";
import { HEALTH_PATH } from "./src/shared/health.ts";

const port = parsePort(process.env.HUBBER_E2E_PORT, DEFAULT_E2E_PORT, "HUBBER_E2E_PORT");
const baseURL = `http://${HOST}:${port}`;
// One workspace per port, like the output directory below, and for the same reason.
const workspace = e2eWorkspaceDir(port);

export default defineConfig({
  testDir: "e2e",
  // One directory per port: each run empties its output directory when it starts, and two runs
  // in the same checkout would otherwise delete each other's trace recordings.
  outputDir: `test-results/${port}`,
  retries: 0,
  reporter: "list",
  // After the last test, while the server is still up: fails the run unless the observer that the
  // server was started under has logged its one port and nothing that leaves the process.
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL,
    trace: "retain-on-failure",
    // Playwright defaults to en-US and the system time zone; the app is Polish.
    locale: "pl-PL",
    timezoneId: "Europe/Warsaw",
  },
  // No device descriptors: "Desktop Chrome" reports a Windows user agent, and
  // the app targets macOS only.
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
    // Opt-in, because Google Chrome has to be installed on the machine: the default run
    // needs nothing beyond the browsers Playwright downloads itself.
    ...(process.env.HUBBER_E2E_CHROME === "1"
      ? [{ name: "chrome", use: { browserName: "chromium" as const, channel: "chrome" } }]
      : []),
  ],
  webServer: {
    // The step in the middle gives the run a workspace of its own, new every time. It has to be
    // part of this command: Playwright starts the web server before any global setup, and loads
    // this file again in every worker. The check of the Node version comes first because that
    // step is TypeScript, which an old Node cannot run at all, let alone report in Polish.
    // "npm start" builds the web app first, so the tests always run against the current sources
    // and the production Content-Security-Policy. It runs under the egress observer, which the
    // command hands it only here: an old Node cannot load the observer either, and has to get as
    // far as the first step to be told so in Polish.
    command:
      'node scripts/preflight.cjs && node scripts/e2e-workspace.ts && NODE_OPTIONS="$HUBBER_E2E_NODE_OPTIONS" npm start',
    url: `${baseURL}${HEALTH_PATH}`,
    env: {
      HUBBER_PORT: String(port),
      // Always set, always a throwaway directory: Playwright hands the server the developer's
      // whole environment and lays these values over it. Without this line the server would open
      // the workspace named there, or the default one, and the tests would run on real data.
      HUBBER_WORKSPACE: workspace,
      // The address the throwaway workspace is pinned to, an invented token, and nothing else of
      // the developer's: an inherited base address would be a pin refusal, an inherited key a
      // real credential. Playwright can add variables but not take them away, so the key is set
      // to nothing, and the credentials file is one that does not exist.
      ANTHROPIC_BASE_URL: TEST_WORKSPACE.endpoint,
      ANTHROPIC_AUTH_TOKEN: "e2e-placeholder-not-a-credential",
      ANTHROPIC_API_KEY: "",
      HUBBER_CREDENTIALS_FILE: `${workspace}-no-credentials.json`,
      // The Node options of the server and of what starts it: the observer, with a log beside the
      // workspace, and nothing of the developer's. e2e/global-teardown.ts reads the log.
      HUBBER_E2E_NODE_OPTIONS: observerOptions(egressLogBeside(workspace)),
    },
    // A server left over from a killed run would be reused without a rebuild and the
    // tests would pass against old code. Refusing to reuse turns that into an error.
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    timeout: 60_000,
  },
});
