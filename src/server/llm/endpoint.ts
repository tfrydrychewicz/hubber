// One canonical spelling of an endpoint address. It is what the workspace configuration and the
// database store, what the pin compares, what the interface shows and what the guarded fetch
// checks every request against. Two addresses name the same endpoint when, and only when, their
// canonical spellings are the same string.
//
// Pure: no I/O, no environment, no clock.

export const ANTHROPIC_ENDPOINT = "https://api.anthropic.com";

/** Why an address was refused. Tests and callers go by the code; the message is for the user. */
export type EndpointErrorCode =
  | "empty"
  | "whitespace"
  | "unparsable"
  | "scheme"
  | "credentials"
  | "query"
  | "cleartext"
  | "trailing-dot";

/** What is wrong, as the end of a sentence and without the address. */
const REASONS: Record<EndpointErrorCode, string> = {
  empty: "adres jest pusty",
  whitespace: "adres zawiera odstęp lub znak sterujący",
  unparsable: "to nie jest pełny adres w postaci https://host/ścieżka",
  scheme: "adres musi zaczynać się od https://",
  credentials: "adres zawiera nazwę użytkownika lub hasło",
  query: 'adres zawiera znak "?" lub "#"',
  cleartext: "adres używa nieszyfrowanego http://, dozwolonego tylko dla tego komputera (127.0.0.1, localhost)",
  "trailing-dot": "nazwa hosta kończy się kropką",
};

/**
 * An address that cannot be pinned. `message` is a whole sentence that shows the address with
 * its password and query string taken out: for an address the user has just typed or keeps in
 * workspace.json. `reason` says the same without the address, for the places where the value
 * may be a secret pasted by mistake (ANTHROPIC_BASE_URL, a key of the credentials file).
 */
export class EndpointError extends Error {
  override name = "EndpointError";
  readonly code: EndpointErrorCode;
  readonly reason: string;

  constructor(code: EndpointErrorCode, message: string) {
    super(message);
    this.code = code;
    this.reason = REASONS[code];
  }
}

export interface Endpoint {
  /** The canonical address: origin plus base path, never a trailing slash. Stored and compared. */
  readonly href: string;
  /** Scheme, host and port as the URL standard serialises them: lower case, punycode, no default port. */
  readonly origin: string;
  /** "" or "/prefix". A request belongs to the endpoint only at this path or below it. */
  readonly basePath: string;
}

// http:// is for an endpoint on this machine only: the test stand-in and a local gateway.
// Anywhere else the notes would cross the network unencrypted.
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The address without anything a secret could hide in, for messages and logs: an address that
 * is refused may be refused because it carries a password. Shown are the scheme and what stands
 * between the last "@" and the first "?" or "#".
 *
 * Deliberately not what the URL parser takes for the user's part and the query. A person who
 * pastes "user:password@host" sees the password end at the "@", while the parser ends it at the
 * first "/", "?" or "#", and a base64 value holds slashes. So everything in front of the last
 * "@" is hidden, wherever that "@" stands, and so is everything from the first "?" or "#" on.
 * An address that is cut too short is only less helpful.
 */
export function redactAddress(raw: string): string {
  const end = raw.search(/[?#]/);
  const address = end === -1 ? raw : raw.slice(0, end);
  const rest = end === -1 ? "" : "?…";
  const at = raw.lastIndexOf("@");
  if (at === -1) return `${address}${rest}`;
  const scheme = /^[^/?#@]*:\/\//.exec(raw)?.[0] ?? "";
  return `${scheme}***@${address.slice(at + 1)}${rest}`;
}

/**
 * Reads an address the way the pin understands it. Refuses instead of repairing: what the URL
 * parser would drop silently (a password, a query string, a line break in the middle) is an
 * error here, because the result is written down and compared for the life of the workspace.
 */
export function parseEndpoint(raw: string): Endpoint {
  const shown = redactAddress(raw);
  if (raw === "") throw new EndpointError("empty", "Adres endpointu jest pusty.");
  // The parser removes tabs and line breaks anywhere in the input and trims spaces at both ends.
  if (/[\s\p{Cc}]/u.test(raw)) {
    // Shown as JSON: a tab or a line break printed as it is would hide in the message.
    throw new EndpointError(
      "whitespace",
      `Adres endpointu zawiera odstęp lub znak sterujący: ${JSON.stringify(shown)}.`,
    );
  }
  if (!URL.canParse(raw)) {
    throw new EndpointError(
      "unparsable",
      `"${shown}" nie jest poprawnym adresem. Podaj pełny adres, na przykład https://router.corp.example.`,
    );
  }
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new EndpointError("scheme", `Adres endpointu musi zaczynać się od https://: "${shown}".`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new EndpointError(
      "credentials",
      `Adres endpointu zawiera nazwę użytkownika lub hasło: "${shown}". Poświadczeń nie podaje się w adresie: trafiłyby do konfiguracji i do bazy.`,
    );
  }
  // url.search is "" for a bare "?", so the raw text is what gets checked.
  if (raw.includes("?") || raw.includes("#")) {
    throw new EndpointError("query", `Adres endpointu nie może zawierać znaku "?" ani "#": "${shown}".`);
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new EndpointError(
      "cleartext",
      `Adres "${shown}" używa nieszyfrowanego http://. Poza tym komputerem (127.0.0.1, localhost) dozwolone jest tylko https://.`,
    );
  }
  // "host." and "host" reach the same machine, yet differ in the Host header and in the TLS
  // check. One spelling only, so that the two can never be told apart by accident.
  if (url.hostname.endsWith(".")) {
    throw new EndpointError("trailing-dot", `Nazwa hosta w adresie kończy się kropką: "${shown}". Usuń ją.`);
  }
  const basePath = url.pathname.replace(/\/+$/, "");
  return Object.freeze({ href: `${url.origin}${basePath}`, origin: url.origin, basePath });
}

/**
 * Whether a request to `url` stays inside the endpoint: the same origin, and the base path or
 * something below it. `url` has to come from the URL parser, which has resolved "..", "%2e%2e"
 * and backslashes by then; the caller hands the very same object on to fetch.
 */
export function isWithinEndpoint(endpoint: Endpoint, url: URL): boolean {
  if (url.origin !== endpoint.origin) return false;
  if (url.username !== "" || url.password !== "") return false;
  const { basePath } = endpoint;
  return basePath === "" || url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
}
