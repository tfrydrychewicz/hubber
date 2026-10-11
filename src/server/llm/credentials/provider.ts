// The one object the rest of the server asks for a credential. It knows the order of the
// sources, keeps what a helper command returned for its lifetime, and makes sure that requests
// which need a new credential at the same moment cause one run of the command, not several.
import { ANTHROPIC_ENDPOINT } from "../endpoint.ts";
import { type Env, readEnvCredential, SCHEME_VARIABLE } from "./env-source.ts";
import { credentialsFilePath, type FileDeps, type HelperSpec, readFileCredential } from "./file-source.ts";
import { runHelper } from "./helper-source.ts";
import { withoutSdkVariables } from "./scrub-env.ts";
import { redactSecrets, type Secret } from "./secret.ts";
import { CredentialError, type CredentialProvider, type CredentialStatus, type CredentialTarget } from "./types.ts";

// After a failed run the command is left alone for this long, and callers get the same error.
// Without it every queued job would start the command again, each waiting for its full limit.
const HELPER_FAILURE_PAUSE_MS = 10_000;
// How many handed-out values redact() remembers. Older ones have long expired.
const REMEMBERED_SECRETS = 16;

export interface ProviderDeps extends FileDeps {
  /** A copy of the environment, taken before the SDK's variables are removed from the live one. */
  env: Env;
  /** Replaced in tests. */
  runHelper?: typeof runHelper;
  now?: () => number;
}

type Resolved =
  | { source: "env"; variable: string; secret: Secret }
  | { source: "file"; file: string; secret: Secret }
  | { source: "helper"; file: string; helper: HelperSpec };

interface Current {
  secret: Secret;
  /** Milliseconds on the provider's clock; null for a value that does not expire by itself. */
  expiresAt: number | null;
  /** The endpoint has answered 401 to this value. */
  refused: boolean;
}

function missingMessage(target: CredentialTarget, envNote: string, fileNote: string): string {
  const address = target.endpoint.href;
  const variable = SCHEME_VARIABLE[target.scheme];
  const field = target.scheme === "bearer" ? "authToken" : "apiKey";
  const withEnvironment =
    address === ANTHROPIC_ENDPOINT
      ? `Ustaw zmienną ${variable} (bez ANTHROPIC_BASE_URL)`
      : `Ustaw zmienne ${variable} i ANTHROPIC_BASE_URL=${address}`;
  return [
    `Brak poświadczeń dla endpointu ${address}.`,
    "Sprawdzone po kolei:",
    `  1. środowisko: ${envNote};`,
    `  2. plik poświadczeń: ${fileNote}.`,
    `${withEnvironment} albo dodaj do pliku poświadczeń wpis dla tego endpointu z polem "${field}" lub "helper". Opis: README, rozdział „Poświadczenia”.`,
  ].join("\n");
}

/** The line the server prints at start about the source that serves the workspace's endpoint. */
export function describeCredentialStatus(status: Extract<CredentialStatus, { available: true }>): string {
  switch (status.source) {
    case "env":
      return `Poświadczenia: zmienna ${status.variable}.`;
    case "file":
      return `Poświadczenia: plik "${status.file}".`;
    case "helper":
      return `Poświadczenia: polecenie pomocnicze "${status.program}" (z pliku "${status.file}").`;
  }
}

/** Creating the provider reads nothing: the sources are opened by status(), get() and renew(). */
export function createCredentialProvider(target: CredentialTarget, deps: ProviderDeps): CredentialProvider {
  const now = deps.now ?? Date.now;
  const run = deps.runHelper ?? runHelper;
  const shutdown = new AbortController();
  const handedOut: Secret[] = [];
  const file = credentialsFilePath(deps.env);
  // The command gets no credential it did not produce itself.
  const helperEnv = withoutSdkVariables(deps.env);

  let current: Current | undefined;
  let pending: Promise<Current> | undefined;
  let helperFailure: { error: CredentialError; until: number } | undefined;

  /** The first source that has something for this endpoint. Later sources are not even opened. */
  function resolve(): Resolved {
    const fromEnv = readEnvCredential(deps.env, target);
    if (fromEnv.kind === "found") return { source: "env", variable: fromEnv.variable, secret: fromEnv.secret };
    if ("note" in file) throw new CredentialError(missingMessage(target, fromEnv.note, file.note));
    const fromFile = readFileCredential(file.path, target, deps);
    if (fromFile.kind === "static") return { source: "file", file: file.path, secret: fromFile.secret };
    if (fromFile.kind === "helper") return { source: "helper", file: file.path, helper: fromFile.helper };
    throw new CredentialError(missingMessage(target, fromEnv.note, fromFile.note));
  }

  function remember(secret: Secret): void {
    if (handedOut.some((known) => known.equals(secret))) return;
    handedOut.push(secret);
    if (handedOut.length > REMEMBERED_SECRETS) handedOut.shift();
  }

  /** Reads the sources again. Everyone who calls while this is under way joins it and gets the same result. */
  function load(): Promise<Current> {
    pending ??= (async (): Promise<Current> => {
      const resolved = resolve();
      let secret: Secret;
      let expiresAt: number | null = null;
      if (resolved.source === "helper") {
        if (helperFailure !== undefined && now() < helperFailure.until) throw helperFailure.error;
        try {
          secret = await run(resolved.helper, {
            endpoint: target.endpoint.href,
            env: helperEnv,
            signal: shutdown.signal,
          });
        } catch (error) {
          if (error instanceof CredentialError) helperFailure = { error, until: now() + HELPER_FAILURE_PAUSE_MS };
          throw error;
        }
        helperFailure = undefined;
        expiresAt = now() + resolved.helper.ttlMs;
      } else {
        secret = resolved.secret;
      }
      remember(secret);
      current = { secret, expiresAt, refused: false };
      return current;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  }

  return {
    target,

    status(): CredentialStatus {
      try {
        const resolved = resolve();
        switch (resolved.source) {
          case "env":
            return { available: true, source: "env", variable: resolved.variable };
          case "file":
            return { available: true, source: "file", file: resolved.file };
          case "helper":
            if (helperFailure !== undefined) return { available: false, message: helperFailure.error.message };
            return { available: true, source: "helper", file: resolved.file, program: resolved.helper.command[0] };
        }
      } catch (error) {
        if (error instanceof CredentialError) return { available: false, message: error.message };
        throw error;
      }
    },

    async get(): Promise<Secret> {
      const atHand = current;
      // While the sources are being read, everyone waits for the outcome: after a 401 the value
      // at hand is the one that was refused.
      if (pending === undefined && atHand !== undefined && (atHand.expiresAt === null || now() < atHand.expiresAt)) {
        return atHand.secret;
      }
      try {
        return (await load()).secret;
      } catch (error) {
        // The lifetime is the user's estimate, not the token's own expiry. When the command
        // cannot be run just now, the value at hand may still be good; a 401 will say if it is not.
        if (atHand !== undefined && !atHand.refused && helperFailure?.error === error) return atHand.secret;
        throw error;
      }
    },

    async renew(rejected: Secret): Promise<Secret | null> {
      const atHand = current;
      if (atHand?.secret.equals(rejected)) atHand.refused = true;
      // Another request has already replaced the rejected value, and nothing is being read now.
      else if (atHand !== undefined && pending === undefined) return atHand.secret;
      // Two requests rejected with the same value end up in the same run.
      const loaded = await load();
      return loaded.secret.equals(rejected) ? null : loaded.secret;
    },

    redact(text: string): string {
      return redactSecrets(text, handedOut);
    },

    close(): void {
      shutdown.abort();
    },
  };
}
