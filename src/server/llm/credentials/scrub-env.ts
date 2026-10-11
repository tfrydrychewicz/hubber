import type { Env } from "./env-source.ts";

// Every variable the SDK reads to configure itself starts with this: credentials, the base
// address, extra headers, the log level, profile and federation settings. Removing by prefix
// also covers the ones a later version adds.
const SDK_PREFIX = "ANTHROPIC_";

/**
 * Called first thing by the entry point of the server: returns a copy of the environment for
 * the application to read, and removes the SDK's variables from the live one.
 *
 * After this the SDK finds nothing to pick up on its own (a token for another endpoint, extra
 * headers from ANTHROPIC_CUSTOM_HEADERS, a debug log level that prints request bodies), child
 * processes do not inherit the credentials, and a diagnostic report of the process does not
 * list them.
 */
export function takeEnvironment(live: NodeJS.ProcessEnv = process.env): Env {
  const copy: Record<string, string | undefined> = { ...live };
  scrubSdkEnvironment(live);
  return Object.freeze(copy);
}

/** Idempotent. Returns the names that were removed. */
export function scrubSdkEnvironment(live: NodeJS.ProcessEnv = process.env): string[] {
  const removed = Object.keys(live).filter((name) => name.startsWith(SDK_PREFIX));
  for (const name of removed) delete live[name];
  return removed;
}

/** The environment without the SDK's variables: what a process gets that has no use for the credentials. */
export function withoutSdkVariables(env: Env): Env {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith(SDK_PREFIX)));
}
