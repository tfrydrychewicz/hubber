import { afterEach, describe, expect, it, vi } from "vitest";
import { scrubSdkEnvironment, takeEnvironment, withoutSdkVariables } from "./scrub-env.ts";

const PLANT = "hubber-planted-secret-7f3a9c";

const shell = () => ({
  PATH: "/usr/bin:/bin",
  HOME: "/Users/x",
  ANTHROPIC_API_KEY: PLANT,
  ANTHROPIC_AUTH_TOKEN: PLANT,
  ANTHROPIC_BASE_URL: "https://router.corp.example/llm",
  ANTHROPIC_CUSTOM_HEADERS: `Authorization: Bearer ${PLANT}`,
  ANTHROPIC_LOG: "debug",
  ANTHROPIC_SOMETHING_A_LATER_SDK_READS: "1",
  // Only the prefix counts: these do not configure the SDK.
  MY_ANTHROPIC_API_KEY: "kept",
  anthropic_api_key: "kept",
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("takeEnvironment", () => {
  it("keeps a copy for the application and empties the live environment of the SDK's variables", () => {
    const live = shell();

    const env = takeEnvironment(live);

    expect(env).toEqual(shell());
    expect(live).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/x",
      MY_ANTHROPIC_API_KEY: "kept",
      anthropic_api_key: "kept",
    });
  });

  it("returns a copy that nothing can change afterwards", () => {
    const env = takeEnvironment(shell());

    expect(Object.isFrozen(env)).toBe(true);
  });

  it("works on the environment of the process itself, and takes the variables out of its diagnostic report", () => {
    // Asserted as yes or no: a failed comparison of the report or of the whole environment
    // would print the variables of whoever runs the tests.
    const reportHoldsPlant = () => JSON.stringify(process.report.getReport()).includes(PLANT);
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", PLANT);
    vi.stubEnv("HUBBER_TEST_KEPT", "kept");
    expect(reportHoldsPlant()).toBe(true);

    const env = takeEnvironment();

    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(PLANT);
    expect(env.HUBBER_TEST_KEPT).toBe("kept");
    expect(process.env.HUBBER_TEST_KEPT).toBe("kept");
    expect(Object.keys(process.env).filter((name) => name.startsWith("ANTHROPIC_"))).toEqual([]);
    expect(reportHoldsPlant()).toBe(false);
  });
});

describe("scrubSdkEnvironment", () => {
  it("says what it removed, and removes nothing the second time", () => {
    const live = shell();

    expect(scrubSdkEnvironment(live).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_CUSTOM_HEADERS",
      "ANTHROPIC_LOG",
      "ANTHROPIC_SOMETHING_A_LATER_SDK_READS",
    ]);
    expect(scrubSdkEnvironment(live)).toEqual([]);
    expect(Object.keys(live).sort()).toEqual(["HOME", "MY_ANTHROPIC_API_KEY", "PATH", "anthropic_api_key"]);
  });
});

describe("withoutSdkVariables", () => {
  it("gives the environment without the SDK's variables and leaves the given one alone", () => {
    const env = Object.freeze(shell());

    expect(withoutSdkVariables(env)).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/x",
      MY_ANTHROPIC_API_KEY: "kept",
      anthropic_api_key: "kept",
    });
    expect(env).toEqual(shell());
  });
});
