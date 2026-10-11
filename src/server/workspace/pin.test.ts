import { describe, expect, it } from "vitest";
import { parseEndpoint } from "../llm/endpoint.ts";
import { isWorkspaceRefusal, WorkspaceError } from "./errors.ts";
import { ACTIVE_ENDPOINT_VARIABLE, assertActiveEndpoint, assertDirectTransport, declaredEndpoint } from "./pin.ts";
import { DIRECT_TRANSPORT, type TransportState } from "./transport.ts";

const ROUTER = "https://router.corp.example/llm";
const ANTHROPIC = "https://api.anthropic.com";
const PINNED = { name: "Praca", endpoint: parseEndpoint(ROUTER) };

type Env = Record<string, string>;

function refusal(run: () => unknown): WorkspaceError {
  try {
    run();
  } catch (error) {
    if (error instanceof WorkspaceError) {
      expect(isWorkspaceRefusal(error.message)).toBe(true);
      return error;
    }
    throw error;
  }
  throw new Error("Nothing was refused.");
}

function mismatch(pin: string, active: string): string {
  return `Nie można otworzyć workspace'u „Praca”: jest przypięty do endpointu ${pin}, a zmienna ANTHROPIC_BASE_URL wskazuje ${active}. Dane workspace'u nie mogą trafić do innego endpointu. Uruchom aplikację ze środowiskiem endpointu ${pin} albo wskaż zmienną HUBBER_WORKSPACE workspace utworzony dla ${active}.`;
}

describe("declaredEndpoint", () => {
  it.each<[string, Env]>([
    ["no variable", {}],
    ["an empty variable", { ANTHROPIC_BASE_URL: "" }],
    ["a blank variable", { ANTHROPIC_BASE_URL: "  \t" }],
    ["only a key and a token", { ANTHROPIC_API_KEY: "invented-key", ANTHROPIC_AUTH_TOKEN: "invented-token" }],
  ])("finds no declaration in an environment with %s", (_what, env) => {
    expect(declaredEndpoint(env)).toBeUndefined();
  });

  it("reads the address in ANTHROPIC_BASE_URL the way the pin spells it", () => {
    expect(declaredEndpoint({ ANTHROPIC_BASE_URL: "HTTPS://Router.Corp.Example:443/llm/" })).toEqual({
      href: ROUTER,
      origin: "https://router.corp.example",
      basePath: "/llm",
    });
    expect(ACTIVE_ENDPOINT_VARIABLE).toBe("ANTHROPIC_BASE_URL");
  });

  it("does not mind spaces around the address", () => {
    expect(declaredEndpoint({ ANTHROPIC_BASE_URL: `  ${ROUTER}\n` })?.href).toBe(ROUTER);
  });

  it.each([
    ["a password", "https://ola:hunter2@router.corp.example/llm", "adres zawiera nazwę użytkownika lub hasło"],
    ["a query string", "https://router.corp.example/llm?key=hunter2", 'adres zawiera znak "?" lub "#"'],
    ["no scheme", "router.corp.example", "to nie jest pełny adres w postaci https://host/ścieżka"],
    ["a space inside", "https://router.corp .example", "adres zawiera odstęp lub znak sterujący"],
    [
      "http to another machine",
      "http://router.corp.example",
      "adres używa nieszyfrowanego http://, dozwolonego tylko dla tego komputera (127.0.0.1, localhost)",
    ],
    // What ends up in the variable by mistake.
    [
      "a credential in the place of the address",
      "hunter2-router.corp.example-token",
      "to nie jest pełny adres w postaci https://host/ścieżka",
    ],
  ])("refuses a declaration with %s as a setting that cannot be used, without repeating it", (_what, value, reason) => {
    const error = refusal(() => declaredEndpoint({ ANTHROPIC_BASE_URL: value }));

    expect(error.message).toBe(
      `Nie można otworzyć workspace'u: zmienna ANTHROPIC_BASE_URL nie nadaje się na adres endpointu: ${reason}.`,
    );
    expect(error.exitCode).toBe(2);
    // Neither the secret nor the host: the whole value may be something pasted by mistake.
    expect(error.message).not.toContain("hunter2");
    expect(error.message).not.toContain("router.corp");
  });
});

describe("assertActiveEndpoint", () => {
  it.each<[string, Env]>([
    ["names no endpoint", {}],
    ["has an empty variable", { ANTHROPIC_BASE_URL: "" }],
    ["names the pinned endpoint", { ANTHROPIC_BASE_URL: ROUTER }],
    ["names it with a slash at the end", { ANTHROPIC_BASE_URL: `${ROUTER}/` }],
    ["names it in capitals", { ANTHROPIC_BASE_URL: "HTTPS://ROUTER.CORP.EXAMPLE/llm" }],
    ["names it with the default port spelled out", { ANTHROPIC_BASE_URL: "https://router.corp.example:443/llm" }],
    // No declaration: the token then belongs to the public API, which is the business of the credentials.
    ["holds only a token", { ANTHROPIC_AUTH_TOKEN: "invented-token" }],
  ])("lets a workspace open in an environment that %s", (_what, env) => {
    expect(() => assertActiveEndpoint(PINNED, env)).not.toThrow();
  });

  it("refuses an environment that names another endpoint, with the code of the pin", () => {
    const error = refusal(() => assertActiveEndpoint(PINNED, { ANTHROPIC_BASE_URL: ANTHROPIC }));

    expect(error.message).toBe(mismatch(ROUTER, ANTHROPIC));
    expect(error.exitCode).toBe(3);
  });

  it.each([
    ["another scheme", "http://127.0.0.1/llm", "http://127.0.0.1/llm"],
    ["another port", "https://router.corp.example:8443/llm", "https://router.corp.example:8443/llm"],
    ["another base path", "https://router.corp.example/llm-b", "https://router.corp.example/llm-b"],
    ["no base path", "https://router.corp.example/", "https://router.corp.example"],
    ["a longer base path", "https://router.corp.example/llm/v1", "https://router.corp.example/llm/v1"],
    ["the base path in other letter case", "https://router.corp.example/LLM", "https://router.corp.example/LLM"],
    [
      "a host that only begins the same",
      "https://router.corp.example.evil.example/llm",
      "https://router.corp.example.evil.example/llm",
    ],
  ])("refuses %s as another endpoint, and shows both addresses in their canonical spelling", (_what, value, shown) => {
    const error = refusal(() => assertActiveEndpoint(PINNED, { ANTHROPIC_BASE_URL: value }));

    expect(error.message).toBe(mismatch(ROUTER, shown));
    expect(error.exitCode).toBe(3);
  });

  it("refuses the router's shell for a workspace of the public API", () => {
    const development = { name: "Dev", endpoint: parseEndpoint(ANTHROPIC) };

    const error = refusal(() => assertActiveEndpoint(development, { ANTHROPIC_BASE_URL: ROUTER }));

    expect(error.exitCode).toBe(3);
    expect(error.message).toContain(
      `„Dev”: jest przypięty do endpointu ${ANTHROPIC}, a zmienna ANTHROPIC_BASE_URL wskazuje ${ROUTER}.`,
    );
  });

  it("reports a declaration that cannot be used as that, not as a mismatch", () => {
    const error = refusal(() =>
      assertActiveEndpoint(PINNED, { ANTHROPIC_BASE_URL: "https://ola:hunter2@evil.example" }),
    );

    expect(error.exitCode).toBe(2);
    expect(error.message).not.toContain("hunter2");
    expect(error.message).not.toContain("evil.example");
  });
});

describe("assertDirectTransport", () => {
  const HTTPS = parseEndpoint(ROUTER);
  const LOOPBACK = parseEndpoint("http://127.0.0.1:9/llm");
  const PROXY_REFUSAL =
    "Nie można otworzyć workspace'u: w tym procesie Node ma włączoną obsługę serwera proxy, a Hubber łączy się z endpointem wyłącznie bezpośrednio. Obsługę proxy włącza zmienna NODE_USE_ENV_PROXY=1 albo opcja --use-env-proxy (w wierszu poleceń, w zmiennej NODE_OPTIONS lub w pliku konfiguracyjnym Node). Uruchom aplikację bez tego ustawienia.";
  const dispatcherRefusal = (stranger: string) =>
    `Nie można otworzyć workspace'u: domyślny mechanizm połączeń Node został w tym procesie podmieniony (${stranger}), więc połączenia mogą iść przez serwer proxy albo bez sprawdzania certyfikatu, a Hubber łączy się z endpointem wyłącznie bezpośrednio. Podmienia go moduł wczytany przed aplikacją (opcje --require i --import, także w zmiennej NODE_OPTIONS). Uruchom aplikację bez niego.`;

  const state = (changes: Partial<TransportState>): TransportState => ({ ...DIRECT_TRANSPORT, ...changes });

  it("lets a start through in a process that connects directly and checks certificates", () => {
    for (const endpoint of [HTTPS, LOOPBACK]) {
      expect(() => assertDirectTransport(endpoint, DIRECT_TRANSPORT)).not.toThrow();
    }
  });

  it("refuses a start in a process whose Node has its proxy support on, whatever the endpoint", () => {
    for (const endpoint of [HTTPS, LOOPBACK]) {
      const error = refusal(() => assertDirectTransport(endpoint, state({ proxySupport: true })));

      expect(error.message).toBe(PROXY_REFUSAL);
      expect(error.exitCode).toBe(2);
    }
  });

  it.each([
    // What Node itself puts there once a proxy variable is set, and what a module can put there.
    ["Node's own proxy dispatcher", "EnvHttpProxyAgent", 'obiekt klasy "EnvHttpProxyAgent"'],
    ["a proxy dispatcher of the undici package", "ProxyAgent", 'obiekt klasy "ProxyAgent"'],
    ["an agent of the default class with connection settings of its own", "Agent", 'obiekt klasy "Agent"'],
    ["something that does not say what it is", "", "obiekt nieznanej klasy"],
  ])("refuses a start in a process where %s stands in for the default dispatcher", (_what, name, stranger) => {
    for (const endpoint of [HTTPS, LOOPBACK]) {
      const error = refusal(() => assertDirectTransport(endpoint, state({ replacedDispatcher: name })));

      expect(error.message).toBe(dispatcherRefusal(stranger));
      expect(error.exitCode).toBe(2);
    }
  });

  it("refuses a start that would not check the certificate of an https endpoint", () => {
    const error = refusal(() => assertDirectTransport(HTTPS, state({ certificatesUnchecked: true })));

    expect(error.message).toBe(
      `Nie można otworzyć workspace'u: zmienna NODE_TLS_REJECT_UNAUTHORIZED=0 wyłącza sprawdzanie certyfikatu endpointu ${ROUTER}. Usuń ją; własny urząd certyfikacji wskażesz zmienną NODE_EXTRA_CA_CERTS.`,
    );
    expect(error.exitCode).toBe(2);
  });

  it("lets a start through without the certificate check when the endpoint is http on this machine", () => {
    // There is no certificate to check, and the throwaway workspace of the tests is such an endpoint.
    expect(() => assertDirectTransport(LOOPBACK, state({ certificatesUnchecked: true }))).not.toThrow();
  });

  it("names the proxy support first, then the dispatcher, then the certificate check", () => {
    const everything = { proxySupport: true, replacedDispatcher: "EnvHttpProxyAgent", certificatesUnchecked: true };

    expect(refusal(() => assertDirectTransport(HTTPS, everything)).message).toBe(PROXY_REFUSAL);
    expect(refusal(() => assertDirectTransport(HTTPS, { ...everything, proxySupport: false })).message).toBe(
      dispatcherRefusal('obiekt klasy "EnvHttpProxyAgent"'),
    );
  });
});
