// How this process would reach the endpoint, read from Node itself and not from what Node was
// started with. A proxy can be switched on by an option in several spellings, by NODE_OPTIONS,
// by a variable, by a Node configuration file and by a module loaded before the application; the
// state below is the same in all of them, because it is what the connection itself goes by.
//
// For Node 26 with the undici it ships (major 8). A test starts real processes in every one of
// those ways and compares what is read here with who answers a request: when Node changes any of
// this, that test fails.
import http from "node:http";
import https from "node:https";

export interface TransportState {
  /**
   * Node's own support for proxies is on. Requests of node:http, node:https and fetch() then go
   * through the proxy that the proxy variables named when the process started; with no such
   * variable they go straight, and the support is on all the same.
   */
  proxySupport: boolean;
  /**
   * The class of whatever stands in the place of the default dispatcher of fetch(), when
   * something does (empty when it has no name fit to print); undefined while requests go the
   * default way, straight to the host. The class of the default one is named here too, for an
   * object of that class that was built to connect in a way of its own.
   */
  replacedDispatcher: string | undefined;
  /** A TLS connection of this process is made without checking the certificate of whoever answers. */
  certificatesUnchecked: boolean;
}

/** The state of a process that connects directly and checks certificates: what a test hands in. */
export const DIRECT_TRANSPORT: TransportState = Object.freeze({
  proxySupport: false,
  replacedDispatcher: undefined,
  certificatesUnchecked: false,
});

// Where fetch() looks for the object that carries out every request it is not given a dispatcher
// for. Node puts its proxy dispatcher here at start, http.setGlobalProxyFromEnv() does it later,
// and so does setGlobalDispatcher() of an undici package of the same major version.
const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.2");
/** The class of the default dispatcher, which opens a connection to the host of the address itself. */
const DEFAULT_DISPATCHER = "Agent";
// The settings by which an agent of that class is told how, or where, to open its connections:
// with them it can leave certificates unchecked or connect to another place than the address.
const CONNECTION_SETTINGS = ["connect", "tls", "socketPath"];

/**
 * True for a global agent that takes proxies from an environment. Node builds both global agents
 * with `proxyEnv` when its proxy support is on, whatever switched it on, and without it otherwise.
 */
function readsProxyEnvironment(agent: http.Agent): boolean {
  const proxyEnv = (agent as { options?: { proxyEnv?: unknown } }).options?.proxyEnv;
  return typeof proxyEnv === "object" && proxyEnv !== null;
}

/**
 * True for an agent that was given connection settings or a factory of its own. The default one
 * has neither. An agent keeps both under keys that only their descriptions tell apart; where
 * such a key is not found, there is nothing to judge by, and the agent counts as untouched.
 */
function connectsItsOwnWay(agent: object): boolean {
  for (const key of Object.getOwnPropertySymbols(agent)) {
    const value = (agent as Record<symbol, unknown>)[key];
    if (key.description === "options" && typeof value === "object" && value !== null) {
      if (CONNECTION_SETTINGS.some((setting) => (value as Record<string, unknown>)[setting] != null)) return true;
    }
    if (key.description === "factory" && typeof value === "function" && value.name !== "defaultFactory") return true;
  }
  return false;
}

function replacedDispatcher(): string | undefined {
  const dispatcher = (globalThis as Record<symbol, unknown>)[GLOBAL_DISPATCHER];
  // Not created yet: the first request creates the default one, since nothing else is in its place.
  if (dispatcher === undefined) return undefined;
  let name: unknown;
  try {
    name = (dispatcher as { constructor?: { name?: unknown } } | null)?.constructor?.name;
    if (name === DEFAULT_DISPATCHER && !connectsItsOwnWay(dispatcher as object)) return undefined;
  } catch {
    // An object that does not even say what it is.
    name = undefined;
  }
  // The name ends up in a message for the terminal, so only what a class is usually called.
  return typeof name === "string" && /^[\w$]{1,60}$/.test(name) ? name : "";
}

/** Reads the state of the process this is called in. Makes no connection and changes nothing. */
export function readTransportState(): TransportState {
  return {
    proxySupport: readsProxyEnvironment(http.globalAgent) || readsProxyEnvironment(https.globalAgent),
    replacedDispatcher: replacedDispatcher(),
    // From the live environment, and not from a copy taken earlier: that is where Node itself
    // looks, anew for every TLS connection.
    certificatesUnchecked: process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0",
  };
}
