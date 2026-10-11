import { API_ROOT } from "./api.ts";

// Contract of the workspace indicator (CFG-3), shared by the server that answers it and the web app that shows it.
export const WORKSPACE_PATH = `${API_ROOT}/workspace`;

/**
 * What the interface may know about the open workspace. Credentials, where they come from and
 * where the workspace lies on disk are not part of it.
 */
export interface WorkspaceInfo {
  /** The name the owner gave the workspace. */
  name: string;
  /**
   * Scheme, host and port of the endpoint the workspace is pinned to, for example
   * "https://api.anthropic.com". Not the whole address: user info, a path and a query can each
   * carry a credential or an account number, and what is shown here is on screen all the time.
   */
  endpointOrigin: string;
}

// An origin as the URL standard writes one: the scheme, the host and, after a colon, the port.
// The host is a name or an IPv6 address in brackets. A name holds lower-case letters, digits and
// the punctuation that the standard leaves in a host; a name from another alphabet arrives in
// punycode. Nothing here can begin another part of an address: no "@" that would end user info,
// and no "/", "?" or "#" after the host.
const WEB_ORIGIN = /^(https?):\/\/(?:[a-z0-9!"$&'()*+,\-.;=_`{}~]+|\[[0-9a-f:.]+\])(?::(0|[1-9][0-9]{0,4}))?$/;

// Read letter by letter, without the URL parser of whoever runs this: the server checks its
// answer with this function before it starts, and that is worth something only if every browser
// then decides as the server did. Their parsers do not spell every host alike. Chromium, for
// one, writes "*" as "%2A", so a comparison with what the parser gives back would refuse there
// what Node and WebKit accept.
function isWebOrigin(value: string): boolean {
  const match = WEB_ORIGIN.exec(value);
  if (match === null) return false;
  const [, scheme, port] = match;
  // The port that the scheme implies is never spelled out in an origin.
  return port === undefined || (Number(port) <= 65_535 && port !== (scheme === "https" ? "443" : "80"));
}

// Extra fields are let through: a tab opened before a restart may be talking to a newer server.
export function isWorkspaceInfo(value: unknown): value is WorkspaceInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    value.name.trim() !== "" &&
    "endpointOrigin" in value &&
    typeof value.endpointOrigin === "string" &&
    isWebOrigin(value.endpointOrigin)
  );
}
