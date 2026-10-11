import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_E2E_PORT } from "./src/server/ports.ts";

interface RunVariables {
  HUBBER_E2E_PORT?: string | undefined;
  HUBBER_E2E_CHROME?: string | undefined;
}

/** Loads the configuration as a run started with exactly these variables would. */
async function loadConfig(variables: RunVariables) {
  vi.stubEnv("HUBBER_E2E_PORT", variables.HUBBER_E2E_PORT);
  vi.stubEnv("HUBBER_E2E_CHROME", variables.HUBBER_E2E_CHROME);
  // The configuration reads the environment while it is imported.
  vi.resetModules();
  return (await import("./playwright.config.ts")).default;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("playwright.config", () => {
  it.each([
    { state: "not set", value: undefined, port: DEFAULT_E2E_PORT },
    { state: "empty", value: "", port: DEFAULT_E2E_PORT },
    { state: "4999", value: "4999", port: 4999 },
  ])(
    "starts the app on port $port and sends the tests there when HUBBER_E2E_PORT is $state",
    async ({ value, port }) => {
      const config = await loadConfig({ HUBBER_E2E_PORT: value });

      expect(config).toMatchObject({
        use: { baseURL: `http://127.0.0.1:${port}` },
        webServer: { url: `http://127.0.0.1:${port}/api/health`, env: { HUBBER_PORT: String(port) } },
      });
    },
  );

  it.each(["abc", "0", "80", "4735.5", "65536"])("rejects HUBBER_E2E_PORT=%s under its own name", async (value) => {
    await expect(loadConfig({ HUBBER_E2E_PORT: value })).rejects.toThrow(
      `Niepoprawna wartość HUBBER_E2E_PORT: "${value}". Podaj numer portu od 1024 do 65535.`,
    );
  });

  it("adds Google Chrome to the browsers only when HUBBER_E2E_CHROME is 1", async () => {
    const browsers = async (variables: RunVariables) =>
      (await loadConfig(variables)).projects?.map((project) => project.use?.channel ?? project.use?.browserName);

    expect(await browsers({})).toEqual(["chromium", "webkit"]);
    expect(await browsers({ HUBBER_E2E_CHROME: "0" })).toEqual(["chromium", "webkit"]);
    expect(await browsers({ HUBBER_E2E_CHROME: "1" })).toEqual(["chromium", "webkit", "chrome"]);
  });
});
