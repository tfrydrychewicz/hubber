import { describe, expect, it } from "vitest";
import { ANTHROPIC_ENDPOINT, parseEndpoint } from "../endpoint.ts";
import { type Env, type EnvLookup, readEnvCredential, SCHEME_VARIABLE } from "./env-source.ts";
import { CredentialError, type CredentialTarget } from "./types.ts";

const PLANT = "hubber-planted-secret-7f3a9c";
const ROUTER: CredentialTarget = { endpoint: parseEndpoint("https://router.corp.example/llm"), scheme: "bearer" };
const PUBLIC: CredentialTarget = { endpoint: parseEndpoint(ANTHROPIC_ENDPOINT), scheme: "x-api-key" };

/** What the lookup found, with the value in the open: a Secret does not show it to the assertions. */
function found(lookup: EnvLookup): { variable: string; value: string } {
  if (lookup.kind !== "found") throw new Error(`Nothing was found: ${lookup.note}`);
  return { variable: lookup.variable, value: lookup.secret.reveal() };
}

function note(lookup: EnvLookup): string {
  if (lookup.kind !== "none") throw new Error(`A credential was found in ${lookup.variable}`);
  return lookup.note;
}

describe("readEnvCredential", () => {
  it("names the variable of each way of authenticating", () => {
    expect(SCHEME_VARIABLE).toEqual({ "x-api-key": "ANTHROPIC_API_KEY", bearer: "ANTHROPIC_AUTH_TOKEN" });
  });

  it("takes the key for the public API when no base address is set", () => {
    expect(found(readEnvCredential({ ANTHROPIC_API_KEY: PLANT }, PUBLIC))).toEqual({
      variable: "ANTHROPIC_API_KEY",
      value: PLANT,
    });
  });

  it.each(["", "   "])("counts a base address of %j as not set", (blank) => {
    const env = { ANTHROPIC_BASE_URL: blank, ANTHROPIC_API_KEY: PLANT, ANTHROPIC_AUTH_TOKEN: PLANT };

    expect(found(readEnvCredential(env, PUBLIC)).value).toBe(PLANT);
    expect(note(readEnvCredential(env, ROUTER))).toBe(
      "zmienna ANTHROPIC_AUTH_TOKEN jest ustawiona, ale bez ANTHROPIC_BASE_URL należy do https://api.anthropic.com, a nie do tego endpointu",
    );
  });

  it.each([
    "https://router.corp.example/llm",
    "https://ROUTER.corp.example/llm/",
    "HTTPS://router.corp.example:443/llm",
    "  https://router.corp.example/llm\n",
  ])("takes the token for the router when the base address %j names its endpoint", (baseUrl) => {
    const lookup = readEnvCredential({ ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: PLANT }, ROUTER);

    expect(found(lookup)).toEqual({ variable: "ANTHROPIC_AUTH_TOKEN", value: PLANT });
  });

  it("with both a key and a token set, uses the one the workspace's scheme names and never the other", () => {
    const env = { ANTHROPIC_API_KEY: "personal-key-000000", ANTHROPIC_AUTH_TOKEN: "corporate-token-000000" };

    expect(found(readEnvCredential(env, PUBLIC)).value).toBe("personal-key-000000");
    expect(found(readEnvCredential({ ...env, ANTHROPIC_BASE_URL: ROUTER.endpoint.href }, ROUTER)).value).toBe(
      "corporate-token-000000",
    );
    expect(
      found(
        readEnvCredential({ ...env, ANTHROPIC_BASE_URL: ROUTER.endpoint.href }, { ...ROUTER, scheme: "x-api-key" }),
      ),
    ).toEqual({ variable: "ANTHROPIC_API_KEY", value: "personal-key-000000" });
  });

  it("leaves the variables alone when the environment describes another endpoint", () => {
    // A corporate token exported for another tool, and a workspace on the public API.
    const corporateShell = {
      ANTHROPIC_BASE_URL: ROUTER.endpoint.href,
      ANTHROPIC_AUTH_TOKEN: PLANT,
      ANTHROPIC_API_KEY: PLANT,
    };
    // A personal key in the shell, and the work workspace.
    const personalShell = { ANTHROPIC_API_KEY: PLANT, ANTHROPIC_AUTH_TOKEN: PLANT };

    expect(note(readEnvCredential(corporateShell, PUBLIC))).toBe(
      "zmienna ANTHROPIC_API_KEY jest ustawiona, ale ANTHROPIC_BASE_URL wskazuje inny endpoint (https://router.corp.example/llm), więc należy do niego",
    );
    expect(note(readEnvCredential(personalShell, ROUTER))).toBe(
      "zmienna ANTHROPIC_AUTH_TOKEN jest ustawiona, ale bez ANTHROPIC_BASE_URL należy do https://api.anthropic.com, a nie do tego endpointu",
    );
  });

  it.each([
    ["another base path", "https://router.corp.example/other"],
    ["no base path", "https://router.corp.example"],
    ["a longer base path", "https://router.corp.example/llm/v2"],
    ["another port", "https://router.corp.example:8443/llm"],
    ["a host that only begins the same", "https://router.corp.example.evil.example/llm"],
  ])("takes %s for another endpoint", (_case, baseUrl) => {
    const lookup = readEnvCredential({ ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: PLANT }, ROUTER);

    expect(note(lookup)).toContain("ANTHROPIC_BASE_URL wskazuje inny endpoint");
  });

  it.each([
    ["a password", `https://user:${PLANT}@router.corp.example/llm`],
    ["a query string", `https://router.corp.example/llm?key=${PLANT}`],
    ["no scheme", PLANT],
  ])("does not repeat a base address that cannot be used: %s", (_case, baseUrl) => {
    const lookup = readEnvCredential({ ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: "token-000000000" }, ROUTER);

    expect(note(lookup)).toBe(
      "zmienna ANTHROPIC_AUTH_TOKEN jest ustawiona, ale ANTHROPIC_BASE_URL ma niepoprawną wartość, więc nie wiadomo, do którego endpointu należy",
    );
  });

  it("says which variable is missing and which one is set instead", () => {
    expect(note(readEnvCredential({ ANTHROPIC_API_KEY: PLANT }, ROUTER))).toBe(
      "zmienna ANTHROPIC_AUTH_TOKEN nie jest ustawiona (ustawiona jest ANTHROPIC_API_KEY, ale ten workspace wysyła token w nagłówku Authorization)",
    );
    expect(note(readEnvCredential({ ANTHROPIC_AUTH_TOKEN: PLANT }, PUBLIC))).toBe(
      "zmienna ANTHROPIC_API_KEY nie jest ustawiona (ustawiona jest ANTHROPIC_AUTH_TOKEN, ale ten workspace wysyła klucz w nagłówku x-api-key)",
    );
    expect(note(readEnvCredential({}, ROUTER))).toBe("zmienna ANTHROPIC_AUTH_TOKEN nie jest ustawiona");
  });

  it.each(["", "  \n"])("counts a credential of %j as not set", (blank) => {
    const env: Env = { ANTHROPIC_BASE_URL: ROUTER.endpoint.href, ANTHROPIC_AUTH_TOKEN: blank };

    expect(note(readEnvCredential(env, ROUTER))).toBe("zmienna ANTHROPIC_AUTH_TOKEN nie jest ustawiona");
  });

  it("refuses a value that cannot be sent, without repeating it", () => {
    const read = () => readEnvCredential({ ANTHROPIC_API_KEY: `${PLANT}\nX-Injected: 1` }, PUBLIC);

    expect(read).toThrow(CredentialError);
    expect(read).toThrow(
      "Poświadczenie w zmiennej ANTHROPIC_API_KEY zawiera znak, którego nie da się wysłać w nagłówku: odstęp, znak nowej linii, cudzysłów, ukośnik wsteczny albo znak spoza ASCII.",
    );
    expect(read).not.toThrow(/planted|7f3a9c/);
  });

  it("does not judge a value that belongs to another endpoint", () => {
    const lookup = readEnvCredential({ ANTHROPIC_AUTH_TOKEN: "Bearer not for this endpoint" }, ROUTER);

    expect(lookup.kind).toBe("none");
  });
});
