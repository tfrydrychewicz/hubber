import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_ENDPOINT,
  EndpointError,
  type EndpointErrorCode,
  isWithinEndpoint,
  parseEndpoint,
  redactAddress,
} from "./endpoint.ts";

const ROUTER = "https://router.corp.example";

function refusal(raw: string): EndpointError {
  try {
    parseEndpoint(raw);
  } catch (error) {
    if (error instanceof EndpointError) return error;
    throw error;
  }
  throw new Error(`parseEndpoint accepted ${JSON.stringify(raw)}`);
}

// The spellings one endpoint can take, each with the one spelling that is stored and compared.
// A canonical form that changes here stops every workspace pinned to it from opening.
const ACCEPTED: [what: string, raw: string, canonical: string][] = [
  ["a plain address", "https://router.corp.example", ROUTER],
  ["a trailing slash", "https://router.corp.example/", ROUTER],
  ["scheme and host in capitals", "HTTPS://Router.Corp.EXAMPLE", ROUTER],
  ["the default port spelled out", "https://router.corp.example:443", ROUTER],
  ["the default port with leading zeros", "https://router.corp.example:0443/", ROUTER],
  ["another port", "https://router.corp.example:8443", "https://router.corp.example:8443"],
  ["the default port of http", "http://127.0.0.1:80/", "http://127.0.0.1"],
  ["a base path", "https://router.corp.example/v1", "https://router.corp.example/v1"],
  ["a base path with slashes at the end", "https://router.corp.example/v1///", "https://router.corp.example/v1"],
  ["a base path in capitals", "https://router.corp.example/V1", "https://router.corp.example/V1"],
  ["dot segments", "https://router.corp.example/a/../team/./x/..", "https://router.corp.example/team"],
  ["encoded dot segments", "https://router.corp.example/a/%2e%2e/team", "https://router.corp.example/team"],
  ["an encoded unreserved character", "https://router.corp.example/%7Eteam", "https://router.corp.example/%7Eteam"],
  ["the same character written out", "https://router.corp.example/~team", "https://router.corp.example/~team"],
  ["an encoding in lower-case hex", "https://router.corp.example/%7eteam", "https://router.corp.example/%7eteam"],
  ["a double slash inside the path", "https://router.corp.example/a//b", "https://router.corp.example/a//b"],
  ["backslashes", "https:\\\\router.corp.example\\v1", "https://router.corp.example/v1"],
  ["three slashes after the scheme", "https:///router.corp.example/v1", "https://router.corp.example/v1"],
  ["a host name in Unicode", "https://bücher.example", "https://xn--bcher-kva.example"],
  ["the same host name in punycode", "https://xn--bcher-kva.example", "https://xn--bcher-kva.example"],
  ["ideographic full stops in the host name", "https://router。corp。example", ROUTER],
  ["a percent-encoded host name", "https://%72outer.corp.example", ROUTER],
  ["an IPv4 address as one number", "http://2130706433:8080", "http://127.0.0.1:8080"],
  ["an IPv4 address shortened and in hex", "http://0x7f.1:8080", "http://127.0.0.1:8080"],
  ["the IPv6 loopback address", "http://[::1]:8080", "http://[::1]:8080"],
  ["the IPv6 loopback address in its long form", "http://[0:0:0:0:0:0:0:1]:8080", "http://[::1]:8080"],
  ["localhost", "http://localhost:8080", "http://localhost:8080"],
  ["localhost in capitals", "http://LOCALHOST:8080", "http://localhost:8080"],
];

const REFUSED: [what: string, raw: string, code: EndpointErrorCode][] = [
  ["a user name and a password", "https://user:hunter2@router.corp.example", "credentials"],
  ["a user name alone", "https://user@router.corp.example", "credentials"],
  ["a query string", "https://router.corp.example/?key=hunter2", "query"],
  ["a bare question mark", "https://router.corp.example/?", "query"],
  ["a fragment", "https://router.corp.example/#x", "query"],
  ["a host name that ends in a dot", "https://router.corp.example.", "trailing-dot"],
  ["http to another machine", "http://router.corp.example", "cleartext"],
  ["an address without a scheme", "router.corp.example", "unparsable"],
  ["an address without a scheme but with a port", "router.corp.example:8443", "scheme"],
  ["another scheme", "ftp://router.corp.example", "scheme"],
  ["a tab inside the host name", "https://router.corp\t.example", "whitespace"],
  ["a line break at the end", "https://router.corp.example\n", "whitespace"],
  ["a space in front", " https://router.corp.example", "whitespace"],
  ["a port out of range", "https://router.corp.example:65536", "unparsable"],
  ["an empty address", "", "empty"],
];

// What is wrong, without the address: for the places where the value may be a secret.
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

// Addresses that carry a secret, in the places a person and the URL parser take for the
// password and for the query string. The two do not agree: to the parser the user's part ends
// at the first "/", "?" or "#", so a password with one of those in it is no password to it.
const WITH_A_SECRET: [what: string, raw: string][] = [
  ["a password", "https://alice:s3cr3t@router.corp.example"],
  ["a password with a slash in it", "https://alice:s3cr3t/p4ss@router.corp.example/llm"],
  ["a password with a question mark in it", "https://alice:s3cr3t?p4ss@router.corp.example"],
  ["a password with a hash sign in it", "https://alice:s3cr3t#p4ss@router.corp.example"],
  ["a password with an at sign in it", "https://alice:s3cr3t@p4ss@router.corp.example"],
  ["a password and no scheme", "alice:s3cr3t@router.corp.example"],
  ["a password and a query string", "https://alice:s3cr3t@router.corp.example/llm?key=p4ss"],
  ["a password in an address with a space", " https://alice:s3cr3t@router.corp.example"],
  ["a password in an address of another scheme", "ftp://alice:s3cr3t@router.corp.example"],
  ["a password in an address with a bad port", "https://alice:s3cr3t@router.corp.example:65536"],
  ["a password in an http address", "http://alice:s3cr3t@router.corp.example"],
  ["a password in front of a host name that ends in a dot", "https://alice:s3cr3t@router.corp.example."],
  ["a query string", "https://router.corp.example/llm?key=s3cr3t"],
  ["a query string right after the host name, with an at sign in it", "https://router.corp.example?key=s3cr3t@p4ss"],
  ["a query string after a path, with an at sign in it", "https://router.corp.example/llm?alice=s3cr3t@p4ss"],
  ["a fragment", "https://router.corp.example/llm#s3cr3t"],
];
const SECRET_PARTS = ["alice", "s3cr3t", "p4ss"];

describe("parseEndpoint", () => {
  it.each(ACCEPTED)("gives %s its one canonical spelling", (_what, raw, canonical) => {
    expect(parseEndpoint(raw).href).toBe(canonical);
  });

  it.each(ACCEPTED)("leaves the canonical spelling of %s as it is", (_what, _raw, canonical) => {
    // The stored address is read back through the same function at every start.
    expect(parseEndpoint(canonical).href).toBe(canonical);
  });

  it("splits the address into the origin and the base path below it", () => {
    expect(parseEndpoint("HTTPS://Router.Corp.Example:443/llm/v1//")).toEqual({
      href: "https://router.corp.example/llm/v1",
      origin: ROUTER,
      basePath: "/llm/v1",
    });
    expect(parseEndpoint("http://127.0.0.1:9/")).toEqual({
      href: "http://127.0.0.1:9",
      origin: "http://127.0.0.1:9",
      basePath: "",
    });
  });

  it("returns a value that nobody can change afterwards", () => {
    expect(Object.isFrozen(parseEndpoint(ROUTER))).toBe(true);
  });

  it("knows the address of the Anthropic API in its canonical spelling", () => {
    expect(parseEndpoint(ANTHROPIC_ENDPOINT).href).toBe(ANTHROPIC_ENDPOINT);
    expect(ANTHROPIC_ENDPOINT).toBe("https://api.anthropic.com");
  });

  it.each(REFUSED)("refuses %s instead of repairing it", (_what, raw, code) => {
    expect(refusal(raw).code).toBe(code);
  });

  it.each<[EndpointErrorCode, string, string]>([
    ["empty", "", "Adres endpointu jest pusty."],
    [
      "whitespace",
      "https://router.corp\t.example",
      // The tab is shown as "\t": printed as it is, it would hide in the message.
      'Adres endpointu zawiera odstęp lub znak sterujący: "https://router.corp\\t.example".',
    ],
    [
      "unparsable",
      "router.corp.example",
      '"router.corp.example" nie jest poprawnym adresem. Podaj pełny adres, na przykład https://router.corp.example.',
    ],
    [
      "scheme",
      "ftp://router.corp.example",
      'Adres endpointu musi zaczynać się od https://: "ftp://router.corp.example".',
    ],
    [
      "credentials",
      "https://user:hunter2@router.corp.example",
      'Adres endpointu zawiera nazwę użytkownika lub hasło: "https://***@router.corp.example". Poświadczeń nie podaje się w adresie: trafiłyby do konfiguracji i do bazy.',
    ],
    [
      "query",
      "https://router.corp.example/?key=hunter2",
      'Adres endpointu nie może zawierać znaku "?" ani "#": "https://router.corp.example/?…".',
    ],
    [
      "cleartext",
      "http://router.corp.example",
      'Adres "http://router.corp.example" używa nieszyfrowanego http://. Poza tym komputerem (127.0.0.1, localhost) dozwolone jest tylko https://.',
    ],
    [
      "trailing-dot",
      "https://router.corp.example.",
      'Nazwa hosta w adresie kończy się kropką: "https://router.corp.example.". Usuń ją.',
    ],
  ])("says in Polish why an address is refused as %s, and shows the address", (code, raw, message) => {
    const error = refusal(raw);

    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
    expect(error.name).toBe("EndpointError");
  });

  it.each(REFUSED)("gives the reason for refusing %s without the address", (_what, raw, code) => {
    const { reason } = refusal(raw);

    expect(reason).toBe(REASONS[code]);
    expect(reason).not.toContain("router.corp");
    expect(reason).not.toContain("hunter2");
  });

  it.each(WITH_A_SECRET)("keeps %s out of the message and out of the reason", (_what, raw) => {
    const error = refusal(raw);

    for (const part of SECRET_PARTS) {
      expect(error.message).not.toContain(part);
      expect(error.reason).not.toContain(part);
    }
  });

  it("allows http for this machine only", () => {
    for (const local of ["http://127.0.0.1:8080", "http://localhost:8080", "http://[::1]:8080"]) {
      expect(parseEndpoint(local).href).toBe(local);
    }
    // Loopback as well, but not one of the names the rule knows: refusing too much is the safe side.
    for (const other of ["http://127.0.0.2:8080", "http://192.168.1.10:8080", "http://localhost.:8080"]) {
      expect(refusal(other).code).toBe("cleartext");
    }
  });
});

describe("isWithinEndpoint", () => {
  const pinned = parseEndpoint("https://router.corp.example/team");

  it.each([
    ["a path below the base path", "https://router.corp.example/team/v1/messages"],
    ["the base path itself", "https://router.corp.example/team"],
    ["a path below the base path with a query string", "https://router.corp.example/team/v1/messages?beta=true"],
    ["another spelling of the same origin", "https://ROUTER.corp.example:443/team/v1/messages"],
  ])("takes %s for a request to the endpoint", (_what, target) => {
    expect(isWithinEndpoint(pinned, new URL(target))).toBe(true);
  });

  it.each([
    ["a path that only begins like the base path", "https://router.corp.example/team-b/v1/messages"],
    ["dot segments that lead out of the base path", "https://router.corp.example/team/../other/v1/messages"],
    ["encoded dot segments", "https://router.corp.example/team/%2e%2e/other/v1/messages"],
    ["backslashes with dot segments", "https://router.corp.example/team\\..\\other"],
    ["a path beside the base path", "https://router.corp.example/v1/messages"],
    ["the base path in another letter case", "https://router.corp.example/TEAM/v1/messages"],
    ["another scheme", "http://router.corp.example/team/v1/messages"],
    ["another port", "https://router.corp.example:8443/team/v1/messages"],
    ["a host name that only begins the same", "https://router.corp.example.evil.example/team/v1/messages"],
    ["the host name used as a user name", "https://router.corp.example@evil.example/team/v1/messages"],
    ["a user name in front of the right host", "https://user:hunter2@router.corp.example/team/v1/messages"],
    ["another host", "https://evil.example/team/v1/messages"],
  ])("takes %s for a request to somewhere else", (_what, target) => {
    expect(isWithinEndpoint(pinned, new URL(target))).toBe(false);
  });

  it("takes every path of the origin for an endpoint without a base path", () => {
    const whole = parseEndpoint(ROUTER);

    expect(isWithinEndpoint(whole, new URL("https://router.corp.example/"))).toBe(true);
    expect(isWithinEndpoint(whole, new URL("https://router.corp.example/v1/messages"))).toBe(true);
    expect(isWithinEndpoint(whole, new URL("https://router.corp.example.evil.example/v1/messages"))).toBe(false);
    expect(isWithinEndpoint(whole, new URL("https://user@router.corp.example/v1/messages"))).toBe(false);
  });
});

describe("redactAddress", () => {
  it.each<[string, string, string]>([
    ["an address without a secret", "https://router.corp.example/llm", "https://router.corp.example/llm"],
    [
      "a user name and a password",
      "https://alice:s3cr3t@router.corp.example/llm",
      "https://***@router.corp.example/llm",
    ],
    ["a user name alone", "https://alice@router.corp.example", "https://***@router.corp.example"],
    ["a query string", "https://router.corp.example/llm?key=s3cr3t", "https://router.corp.example/llm?…"],
    ["a fragment", "https://router.corp.example/llm#s3cr3t", "https://router.corp.example/llm?…"],
    [
      "a password and a query string",
      "https://alice:s3cr3t@router.corp.example/llm?key=p4ss",
      "https://***@router.corp.example/llm?…",
    ],
    [
      "a password with a slash in it",
      "https://alice:s3cr3t/p4ss@router.corp.example/llm",
      "https://***@router.corp.example/llm",
    ],
    ["a password with a question mark in it", "https://alice:s3cr3t?p4ss@router.corp.example", "https://***@?…"],
    [
      "a password with an at sign in it",
      "https://alice:s3cr3t@p4ss@router.corp.example",
      "https://***@router.corp.example",
    ],
    ["a password without a scheme in front", "alice:s3cr3t@router.corp.example", "***@router.corp.example"],
    ["an at sign in the query string", "https://router.corp.example?key=s3cr3t@p4ss", "https://***@?…"],
    ["an empty text", "", ""],
  ])("shows %s without what a secret could hide in", (_what, raw, shown) => {
    expect(redactAddress(raw)).toBe(shown);
  });
});
