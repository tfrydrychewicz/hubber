// What the commands that work with synthetic data share ("npm run synthetic", "npm run perf",
// "npm run db:fixture"): their options, read from the command line, and the profile of the
// workspace that two of them make for themselves. What is wrong with an option is said here in
// the owner's language: the complaints of the platform's own parser are English sentences.
import { parseArgs } from "node:util";
import type { LlmProfile } from "../../workspace/config.ts";

/**
 * The profile of a workspace that a command makes for itself and removes again. The address is
 * this machine's, and nothing listens on port 9 of the loopback address: a call that slipped
 * through would be refused at once, and nothing can leave the machine. The workspaces of the
 * tests are pinned to the same address.
 */
export const THROWAWAY_PROFILE: LlmProfile = {
  kind: "router",
  endpoint: "http://127.0.0.1:9/llm",
  auth: "bearer",
  models: { default: "model-large" },
  diagnostics: null,
};

/** An option takes a value, or is a switch that is on when it is named. */
export type OptionKinds = Record<string, "value" | "switch">;

export type Options<Kinds extends OptionKinds> = {
  [Name in keyof Kinds]?: Kinds[Name] extends "switch" ? true : string;
};

/** An option that cannot be used as given. The message says what is wrong; nothing was started. */
export class UsageError extends Error {
  override name = "UsageError";
}

/**
 * The options as given, each at most once. Throws a UsageError for an argument that is no option,
 * an option that the command does not have, a value that is missing, and for options that npm
 * kept for itself because the "--" before them was left out.
 */
export function readOptions<Kinds extends OptionKinds>(
  kinds: Kinds,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Options<Kinds> {
  // Without the "--" npm takes the options for settings of its own and says so in the environment:
  // the command would run with none of them, at whatever its defaults are. A switch that begins
  // with "no-" is to npm the setting behind those letters, switched off.
  const settingsOf = (name: string): string[] => {
    const setting = name.replaceAll("-", "_");
    return kinds[name] === "switch" && setting.startsWith("no_") ? [setting, setting.slice(3)] : [setting];
  };
  const kept = Object.keys(kinds).filter((name) =>
    settingsOf(name).some((setting) => env[`npm_config_${setting}`] !== undefined),
  );
  if (kept.length > 0) {
    throw new UsageError(
      `npm zabrał dla siebie: ${kept.map((name) => `--${name}`).join(", ")}. Opcje polecenia podaje się po "--".`,
    );
  }
  const { tokens } = parseArgs({
    args: [...args],
    options: Object.fromEntries(
      Object.entries(kinds).map(([name, kind]) => [name, { type: kind === "switch" ? "boolean" : "string" }]),
    ),
    strict: false,
    tokens: true,
  });
  const options: Record<string, string | true> = {};
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw new UsageError(`Nieoczekiwany argument: "${token.value}". Każdą wartość poprzedza nazwa opcji.`);
    }
    if (token.kind !== "option") continue;
    const kind = Object.hasOwn(kinds, token.name) ? kinds[token.name] : undefined;
    if (kind === undefined) throw new UsageError(`Nieznana opcja: ${token.rawName}.`);
    if (options[token.name] !== undefined) throw new UsageError(`Opcja --${token.name} została podana więcej niż raz.`);
    if (kind === "switch") {
      if (token.value !== undefined) throw new UsageError(`Opcja --${token.name} nie przyjmuje wartości.`);
      options[token.name] = true;
      continue;
    }
    // The parser takes whatever follows an option for its value: the name of the next option, when the value was left out.
    if (token.value === undefined || (!token.inlineValue && token.value.startsWith("-"))) {
      throw new UsageError(`Opcja ${token.rawName} wymaga wartości.`);
    }
    options[token.name] = token.value;
  }
  return options as Options<Kinds>;
}

/** A number of seconds as the owner reads it: with a comma, and with as many digits as say something. */
export function seconds(milliseconds: number): string {
  const value = milliseconds / 1_000;
  return `${value.toFixed(value < 1 ? 2 : value < 10 ? 1 : 0).replace(".", ",")} s`;
}

/** A number of bytes as megabytes, with a comma and one digit after it. */
export function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1).replace(".", ",")} MB`;
}
