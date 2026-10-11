import { defineConfig } from "@playwright/test";
import { DEFAULT_E2E_PORT, HOST, parsePort } from "./src/server/ports.ts";
import { HEALTH_PATH } from "./src/shared/health.ts";

const port = parsePort(process.env.HUBBER_E2E_PORT, DEFAULT_E2E_PORT, "HUBBER_E2E_PORT");
const baseURL = `http://${HOST}:${port}`;

export default defineConfig({
  testDir: "e2e",
  // One directory per port: each run empties its output directory when it starts, and two runs
  // in the same checkout would otherwise delete each other's trace recordings.
  outputDir: `test-results/${port}`,
  retries: 0,
  reporter: "list",
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
    // "npm start" builds the web app first, so the tests always run against the current sources
    // and the production Content-Security-Policy.
    command: "npm start",
    url: `${baseURL}${HEALTH_PATH}`,
    env: { HUBBER_PORT: String(port) },
    // A server left over from a killed run would be reused without a rebuild and the
    // tests would pass against old code. Refusing to reuse turns that into an error.
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    timeout: 60_000,
  },
});
