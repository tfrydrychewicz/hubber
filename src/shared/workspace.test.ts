import { afterEach, describe, expect, it, vi } from "vitest";
import { isApiPath } from "./api.ts";
import { isWorkspaceInfo, WORKSPACE_PATH } from "./workspace.ts";

const WORKSPACE = { name: "Praca", endpointOrigin: "https://router.corp.example" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WORKSPACE_PATH", () => {
  it("is an address under the API root", () => {
    expect(WORKSPACE_PATH).toBe("/api/workspace");
    expect(isApiPath(WORKSPACE_PATH)).toBe(true);
  });
});

describe("isWorkspaceInfo", () => {
  it.each([
    WORKSPACE,
    { name: "Dev", endpointOrigin: "https://api.anthropic.com" },
    { name: "Atrapa", endpointOrigin: "http://127.0.0.1:8080" },
    // A newer server may say more; the page reads what it knows.
    { ...WORKSPACE, profile: "router" },
  ])("accepts the payload of GET /api/workspace: %j", (payload) => {
    expect(isWorkspaceInfo(payload)).toBe(true);
  });

  it.each([
    null,
    "Praca",
    {},
    { name: "Praca" },
    { endpointOrigin: WORKSPACE.endpointOrigin },
    { name: 7, endpointOrigin: WORKSPACE.endpointOrigin },
    { name: "", endpointOrigin: WORKSPACE.endpointOrigin },
    { name: "   ", endpointOrigin: WORKSPACE.endpointOrigin },
    { name: "Praca", endpointOrigin: 7 },
    { name: "Praca", endpointOrigin: "" },
    { name: "Praca", endpointOrigin: "router.corp.example" },
    { name: "Praca", endpointOrigin: "ftp://router.corp.example" },
    // What "new URL(address).origin" gives for an address that has no origin.
    { name: "Praca", endpointOrigin: "null" },
    // The health payload, which an address mix-up on either side would deliver.
    { status: "ok" },
  ])("rejects %j", (payload) => {
    expect(isWorkspaceInfo(payload)).toBe(false);
  });

  // Every form in which the server's URL parser writes the origin of an address that can be pinned.
  it.each([
    ["a port of its own", "https://router.corp.example:8443"],
    ["the lowest and the highest port", "https://router.corp.example:0"],
    ["the lowest and the highest port", "http://localhost:65535"],
    ["the port that the other scheme implies", "https://router.corp.example:80"],
    ["the port that the other scheme implies", "http://localhost:443"],
    ["a host without a dot", "http://localhost"],
    ["an IPv6 address", "http://[::1]:8080"],
    ["an IPv6 address", "https://[2001:db8::1]"],
    ["a name from another alphabet, in punycode", "https://xn--ruter-jye.corp.example"],
    ["an underscore in the host", "https://llm_router.corp.example"],
    // No real host has one, but an address with one can be pinned, and then it has to be shown.
    ["an asterisk in the host", "https://ex*ample.example"],
    ["all the punctuation that the URL standard leaves in a host", "https://a!\"$&'()*+,-.;=_`{}~z"],
  ])("accepts an endpoint origin with %s: %s", (_part, endpointOrigin) => {
    expect(isWorkspaceInfo({ name: "Praca", endpointOrigin })).toBe(true);
  });

  // Everything in an address apart from its origin can hold a credential or an account number.
  it.each([
    ["user info", "https://user:haslo-123@router.corp.example"],
    ["a user name alone", "https://token-123@router.corp.example"],
    ["a path", "https://router.corp.example/konto-123/anthropic"],
    ["a closing slash", "https://router.corp.example/"],
    ["a query", "https://router.corp.example?api-key=token-123"],
    ["a fragment", "https://router.corp.example#token-123"],
    ["a backslash, which a browser reads as a slash", "https://router.corp.example\\konto-123"],
    ["a port that the scheme implies", "https://router.corp.example:443"],
    ["a port that the scheme implies", "http://localhost:80"],
    ["capital letters in the host", "https://Router.Corp.Example"],
    ["capital letters in the scheme", "HTTPS://router.corp.example"],
    ["a colon and no port", "https://router.corp.example:"],
    ["a port written with a zero in front", "https://router.corp.example:08443"],
    ["a port above the highest", "https://router.corp.example:65536"],
    ["a port that is no number", "https://router.corp.example:haslo-123"],
    ["no host", "https://"],
    ["no host and a port", "https://:8443"],
    ["a percent sign in the host", "https://ex%2Aample.example"],
    ["a host outside ASCII, which the server sends in punycode", "https://rоuter.corp.example"],
    ["a space in the host", "https://router corp.example"],
    ["a space in front", " https://router.corp.example"],
    ["a line break at the end", "https://router.corp.example\n"],
    ["a second line", "https://router.corp.example\nhttps://evil.example"],
    ["a bracket that is not closed", "http://[::1"],
    ["something after the brackets", "http://[::1]evil.example"],
    ["a character that no parser leaves in a host", "https://router<corp>.example"],
  ])("rejects an endpoint origin with %s: %j", (_part, endpointOrigin) => {
    expect(isWorkspaceInfo({ name: "Praca", endpointOrigin })).toBe(false);
  });

  // What is checked is the shape: a scheme, a host, a port, and nothing that could carry a secret.
  // Whether a parser would write the host this way is not, because parsers differ in exactly
  // that. The server sends what its own parser wrote.
  it.each([
    ["an IPv4 address in three parts, which a parser writes in four", "https://1.2.3"],
    ["a label that Node's parser refuses and Chromium's accepts", "https://xn--a.example"],
    ["an IPv6 address that is not in its shortest form", "http://[0:0:0:0:0:0:0:1]:8080"],
  ])("does not judge the spelling of a host: %s", (_part, endpointOrigin) => {
    expect(isWorkspaceInfo({ name: "Praca", endpointOrigin })).toBe(true);
  });

  // The server checks its answer with this function before it starts, and the page checks what
  // arrives with the same function. The two must agree, and the browsers' URL parsers do not.
  describe("under a URL parser that is not the server's", () => {
    /** Puts a parser in place of the engine's own that differs from it in one way. */
    function stubParser(quirk: { spells?: (origin: string) => string; refuses?: (address: string) => boolean }) {
      const NativeURL = URL;
      const refuses = (address: unknown) => quirk.refuses?.(String(address)) ?? false;
      class QuirkyURL extends NativeURL {
        constructor(address: string | URL, base?: string | URL) {
          if (refuses(address)) throw new TypeError("Invalid URL");
          super(address, base);
          // An own property, which is found before the getter that every URL inherits.
          if (quirk.spells) Object.defineProperty(this, "origin", { value: quirk.spells(this.origin) });
        }

        static override canParse(address: string | URL, base?: string | URL): boolean {
          return !refuses(address) && NativeURL.canParse(address, base);
        }
      }
      vi.stubGlobal("URL", QuirkyURL);
    }

    it.each([
      [
        "accepts a host with an asterisk where the parser writes it as %2A, as Chromium's does",
        { spells: (origin: string) => origin.replaceAll("*", "%2A") },
        "https://ex*ample.example",
        true,
      ],
      [
        "accepts a name in punycode that the parser does not know",
        { refuses: (address: string) => address.includes("xn--") },
        "https://xn--ruter-jye.corp.example",
        true,
      ],
      [
        "rejects capital letters where the parser leaves them alone",
        { spells: (origin: string) => origin.replace("router", "Router") },
        "https://Router.corp.example",
        false,
      ],
    ])("%s", (_label, quirk, endpointOrigin, accepted) => {
      // The control: the stand-in does differ from the engine's own parser for this address.
      const native = URL.canParse(endpointOrigin) ? new URL(endpointOrigin).origin : undefined;
      stubParser(quirk);
      const quirky = URL.canParse(endpointOrigin) ? new URL(endpointOrigin).origin : undefined;
      expect(quirky).not.toBe(native);

      expect(isWorkspaceInfo({ name: "Praca", endpointOrigin })).toBe(accepted);
    });
  });
});
