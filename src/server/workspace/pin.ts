// What stands between the workspace and everything outside it that could send its data
// somewhere else. Both checks run when the workspace is opened, before the database is opened
// and before any credential is read:
//   1. the endpoint that the environment names is the pinned one (CFG-1, NFR-2);
//   2. nothing in the process moves the connection to another machine or switches off the
//      check of who answers (NFR-1).
// The third check of the pin, configuration file against database, is made by
// openWorkspaceDatabase() and worded in open.ts.
//
// Pure: the caller hands in the environment and the state of the process (transport.ts reads it).
import { EXIT_PIN, EXIT_USAGE } from "../exit-codes.ts";
import { type Endpoint, EndpointError, parseEndpoint } from "../llm/endpoint.ts";
import { refusal } from "./errors.ts";
import type { TransportState } from "./transport.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** The variable by which the SDK, Claude Code and "npm run diagnose" are told the endpoint. */
export const ACTIVE_ENDPOINT_VARIABLE = "ANTHROPIC_BASE_URL";

/**
 * The endpoint the environment declares for this start, or undefined when it declares none.
 * Empty counts as not set, as for the other variables: that is also how the end-to-end run
 * switches off a value inherited from the developer's shell.
 */
export function declaredEndpoint(env: Env): Endpoint | undefined {
  const raw = env[ACTIVE_ENDPOINT_VARIABLE];
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    return parseEndpoint(raw.trim());
  } catch (error) {
    if (!(error instanceof EndpointError)) throw error;
    // The value is not repeated: a variable of this family can hold a secret pasted by mistake.
    throw refusal(
      `zmienna ${ACTIVE_ENDPOINT_VARIABLE} nie nadaje się na adres endpointu: ${error.reason}.`,
      EXIT_USAGE,
    );
  }
}

/**
 * Refuses unless the endpoint named by the environment is the pinned one. Without a declaration
 * the workspace opens: nothing outside it names another endpoint, and a credential in the
 * environment then belongs to the public API alone.
 */
export function assertActiveEndpoint(workspace: { name: string; endpoint: Endpoint }, env: Env): void {
  const active = declaredEndpoint(env);
  if (active === undefined || active.href === workspace.endpoint.href) return;
  const pin = workspace.endpoint.href;
  throw refusal(
    `jest przypięty do endpointu ${pin}, a zmienna ${ACTIVE_ENDPOINT_VARIABLE} wskazuje ${active.href}. Dane workspace'u nie mogą trafić do innego endpointu. Uruchom aplikację ze środowiskiem endpointu ${pin} albo wskaż zmienną HUBBER_WORKSPACE workspace utworzony dla ${active.href}.`,
    EXIT_PIN,
    workspace.name,
  );
}

const DIRECT_ONLY = "a Hubber łączy się z endpointem wyłącznie bezpośrednio";

/**
 * Refuses a start in which Node would send the connection through a proxy, or would not check
 * the certificate of whoever answers. The pinned fetch checks addresses, not sockets: with either
 * setting the bytes can end up with someone who is not the endpoint.
 *
 * It goes by what the process says of itself, never by the options and variables it was started
 * with: the same setting has more spellings and sources than a comparison of texts can follow,
 * and one that is given and then taken back is not in force.
 */
export function assertDirectTransport(endpoint: Endpoint, transport: TransportState): void {
  if (transport.proxySupport) {
    throw refusal(
      `w tym procesie Node ma włączoną obsługę serwera proxy, ${DIRECT_ONLY}. Obsługę proxy włącza zmienna NODE_USE_ENV_PROXY=1 albo opcja --use-env-proxy (w wierszu poleceń, w zmiennej NODE_OPTIONS lub w pliku konfiguracyjnym Node). Uruchom aplikację bez tego ustawienia.`,
      EXIT_USAGE,
    );
  }
  if (transport.replacedDispatcher !== undefined) {
    const stranger =
      transport.replacedDispatcher === "" ? "obiekt nieznanej klasy" : `obiekt klasy "${transport.replacedDispatcher}"`;
    throw refusal(
      `domyślny mechanizm połączeń Node został w tym procesie podmieniony (${stranger}), więc połączenia mogą iść przez serwer proxy albo bez sprawdzania certyfikatu, ${DIRECT_ONLY}. Podmienia go moduł wczytany przed aplikacją (opcje --require i --import, także w zmiennej NODE_OPTIONS). Uruchom aplikację bez niego.`,
      EXIT_USAGE,
    );
  }
  if (transport.certificatesUnchecked && endpoint.origin.startsWith("https:")) {
    throw refusal(
      `zmienna NODE_TLS_REJECT_UNAUTHORIZED=0 wyłącza sprawdzanie certyfikatu endpointu ${endpoint.href}. Usuń ją; własny urząd certyfikacji wskażesz zmienną NODE_EXTRA_CA_CERTS.`,
      EXIT_USAGE,
    );
  }
}
