// Source 1: the environment. It is the only source that does not name its endpoint, so the
// environment has to say it: ANTHROPIC_BASE_URL (the public API when it is not set) is the
// endpoint that ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN of the same environment belong to.
// When that is not the workspace's endpoint, both variables are left alone. Without this rule a
// corporate token exported for another tool would be sent to the public API, and a personal key
// to the router.
import { ANTHROPIC_ENDPOINT, EndpointError, parseEndpoint } from "../endpoint.ts";
import { SECRET_PROBLEM_TEXT, Secret } from "./secret.ts";
import { type AuthScheme, CredentialError, type CredentialTarget } from "./types.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export const SCHEME_VARIABLE: Record<AuthScheme, "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN"> = {
  "x-api-key": "ANTHROPIC_API_KEY",
  bearer: "ANTHROPIC_AUTH_TOKEN",
};

export type EnvLookup =
  | { kind: "found"; secret: Secret; variable: string }
  /** Nothing usable; `note` says why, as one clause of the final message. */
  | { kind: "none"; note: string };

// Blank counts as not set: that is how a value inherited from the shell is switched off.
const isSet = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";

export function readEnvCredential(env: Env, target: CredentialTarget): EnvLookup {
  const variable = SCHEME_VARIABLE[target.scheme];
  const other = SCHEME_VARIABLE[target.scheme === "bearer" ? "x-api-key" : "bearer"];
  const value = env[variable];

  if (!isSet(value)) {
    return {
      kind: "none",
      note: isSet(env[other])
        ? `zmienna ${variable} nie jest ustawiona (ustawiona jest ${other}, ale ten workspace wysyła ${target.scheme === "bearer" ? "token w nagłówku Authorization" : "klucz w nagłówku x-api-key"})`
        : `zmienna ${variable} nie jest ustawiona`,
    };
  }

  const baseUrl = env.ANTHROPIC_BASE_URL;
  let active: string;
  try {
    active = isSet(baseUrl) ? parseEndpoint(baseUrl.trim()).href : ANTHROPIC_ENDPOINT;
  } catch (error) {
    if (!(error instanceof EndpointError)) throw error;
    // The value is not repeated: a base address can carry a password.
    return {
      kind: "none",
      note: `zmienna ${variable} jest ustawiona, ale ANTHROPIC_BASE_URL ma niepoprawną wartość, więc nie wiadomo, do którego endpointu należy`,
    };
  }
  if (active !== target.endpoint.href) {
    return {
      kind: "none",
      note: isSet(baseUrl)
        ? `zmienna ${variable} jest ustawiona, ale ANTHROPIC_BASE_URL wskazuje inny endpoint (${active}), więc należy do niego`
        : `zmienna ${variable} jest ustawiona, ale bez ANTHROPIC_BASE_URL należy do ${ANTHROPIC_ENDPOINT}, a nie do tego endpointu`,
    };
  }

  const secret = Secret.parse(value);
  if (typeof secret === "string") {
    throw new CredentialError(`Poświadczenie w zmiennej ${variable} ${SECRET_PROBLEM_TEXT[secret]}.`);
  }
  return { kind: "found", secret, variable };
}
