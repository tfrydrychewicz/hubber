import { describe, expect, it } from "vitest";
import { parseEndpoint } from "../../llm/endpoint.ts";
import { TEST_WORKSPACE } from "../../testing.ts";
import { megabytes, readOptions, seconds, THROWAWAY_PROFILE, UsageError } from "./command-line.ts";

const KINDS = { scale: "value", seed: "value", "no-budgets": "switch", help: "switch" } as const;
const read = (args: readonly string[], env: Record<string, string> = {}) => readOptions(KINDS, args, env);
const refusal = (args: readonly string[], env: Record<string, string> = {}): string => {
  try {
    read(args, env);
  } catch (error) {
    if (error instanceof UsageError) return error.message;
    throw error;
  }
  throw new Error("The options were accepted.");
};

describe("readOptions", () => {
  it("reads values and switches, in any order and in both spellings of a value", () => {
    expect(read([])).toEqual({});
    expect(read(["--scale", "tiny", "--no-budgets"])).toEqual({ scale: "tiny", "no-budgets": true });
    expect(read(["--help", "--seed=7", "--scale", "small"])).toEqual({ help: true, seed: "7", scale: "small" });
    // A value is taken as it is given: what it means is for the command to say.
    expect(read(["--scale", ""])).toEqual({ scale: "" });
    expect(read(["--seed=-3"])).toEqual({ seed: "-3" });
  });

  it("refuses what is no option of the command, in the owner's language", () => {
    expect(refusal(["tiny"])).toBe('Nieoczekiwany argument: "tiny". Każdą wartość poprzedza nazwa opcji.');
    expect(refusal(["--scale", "tiny", "small"])).toBe(
      'Nieoczekiwany argument: "small". Każdą wartość poprzedza nazwa opcji.',
    );
    expect(refusal(["--size", "tiny"])).toBe("Nieznana opcja: --size.");
    expect(refusal(["-s", "tiny"])).toBe("Nieznana opcja: -s.");
    // A name that every object has is no option either.
    expect(refusal(["--constructor"])).toBe("Nieznana opcja: --constructor.");
  });

  it("refuses an option that is given twice, a switch with a value, and a value that is missing", () => {
    expect(refusal(["--scale", "tiny", "--scale", "full"])).toBe("Opcja --scale została podana więcej niż raz.");
    expect(refusal(["--help", "--help"])).toBe("Opcja --help została podana więcej niż raz.");
    expect(refusal(["--no-budgets=tak"])).toBe("Opcja --no-budgets nie przyjmuje wartości.");
    expect(refusal(["--scale"])).toBe("Opcja --scale wymaga wartości.");
    // Without its value an option would swallow the name of the next one.
    expect(refusal(["--scale", "--seed", "7"])).toBe("Opcja --scale wymaga wartości.");
  });

  it("refuses to run when npm kept the options for itself, because the two dashes before them were left out", () => {
    expect(refusal([], { npm_config_scale: "tiny" })).toBe(
      'npm zabrał dla siebie: --scale. Opcje polecenia podaje się po "--".',
    );
    expect(refusal(["tiny"], { npm_config_scale: "true", npm_config_no_budgets: "true" })).toBe(
      'npm zabrał dla siebie: --scale, --no-budgets. Opcje polecenia podaje się po "--".',
    );
    // npm reads "--no-budgets" as a setting of its own called "budgets" that is switched off, and leaves it empty.
    expect(refusal([], { npm_config_budgets: "" })).toBe(
      'npm zabrał dla siebie: --no-budgets. Opcje polecenia podaje się po "--".',
    );
    // Only a switch has that second spelling: a setting that is called like the end of an option with a value is npm's own.
    expect(readOptions({ "no-color": "value" }, [], { npm_config_color: "always" })).toEqual({});
    // What npm says of its own settings is none of the command's business.
    expect(read(["--scale", "tiny"], { npm_config_loglevel: "silent" })).toEqual({ scale: "tiny" });
  });
});

describe("seconds", () => {
  it("writes a duration as the owner reads it: with a comma, and with as many digits as say something", () => {
    expect(seconds(334)).toBe("0,33 s");
    expect(seconds(4_210)).toBe("4,2 s");
    expect(seconds(59_600)).toBe("60 s");
    expect(seconds(180_000)).toBe("180 s");
    expect(seconds(0)).toBe("0,00 s");
  });
});

describe("megabytes", () => {
  it("writes a number of bytes as megabytes, with a comma and one digit after it", () => {
    expect(megabytes(742_800_000)).toBe("742,8 MB");
    expect(megabytes(10e6)).toBe("10,0 MB");
    expect(megabytes(4096)).toBe("0,0 MB");
  });
});

describe("the profile of a workspace that a command makes for itself", () => {
  it("has the address of the test workspaces: this machine's, on a port where nothing listens", () => {
    expect(THROWAWAY_PROFILE.endpoint).toBe(TEST_WORKSPACE.endpoint);
    expect(parseEndpoint(THROWAWAY_PROFILE.endpoint)).toMatchObject({ origin: "http://127.0.0.1:9" });
  });
});
