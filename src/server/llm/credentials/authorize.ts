import type { Middleware } from "@anthropic-ai/sdk";
import { type Endpoint, isWithinEndpoint } from "../endpoint.ts";
import type { Secret } from "./secret.ts";
import type { AuthScheme, CredentialProvider } from "./types.ts";

/** A request that was about to go somewhere else than the workspace's endpoint. Nothing was sent. */
export class EndpointPinError extends Error {
  override name = "EndpointPinError";

  constructor(endpoint: Endpoint) {
    super(`Żądanie poza endpoint workspace'u (${endpoint.href}) zostało zatrzymane.`);
  }
}

function setCredential(headers: Headers, scheme: AuthScheme, secret: Secret): void {
  // Both are removed first: whatever the SDK put there (its placeholder, or something it found
  // by itself) must not travel next to the workspace's credential.
  headers.delete("x-api-key");
  headers.delete("authorization");
  if (scheme === "x-api-key") headers.set("x-api-key", secret.reveal());
  else headers.set("authorization", `Bearer ${secret.reveal()}`);
}

/**
 * What `pending` settles with, unless the signal fires first: then a rejection with the signal's
 * reason, at once. `pending` goes on by itself; it is the provider's, and other requests may be
 * waiting for the same helper run.
 */
function unlessAborted<Result>(pending: Promise<Result>, signal: AbortSignal | null | undefined): Promise<Result> {
  if (signal === null || signal === undefined) return pending;
  return new Promise<Result>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * An error response with the credential taken out of its headers and its body. Some endpoints
 * repeat the credential they refused; the SDK copies the headers and the body into the error,
 * and from there they would reach a log line, a stored error and the interface. Cleaning them
 * here means no later code has to remember to.
 *
 * The body is cleaned as text, before the SDK parses it: redact() also finds the value where
 * JSON spells it with escapes, which the parser would turn back into the value itself.
 */
async function withoutCredential(response: Response, credentials: CredentialProvider): Promise<Response> {
  if (response.ok) return response;
  // Appended one by one: a response may carry several Set-Cookie headers, and they stay several.
  const headers = new Headers();
  let cleaned = false;
  for (const [name, value] of response.headers) {
    const shown = credentials.redact(value);
    cleaned ||= shown !== value;
    headers.append(name, shown);
  }
  const { status, statusText } = response;
  // A status without a body (304) has no more to clean and cannot be given a body.
  if (response.body === null) return cleaned ? new Response(null, { status, statusText, headers }) : response;
  const body = credentials.redact(await response.text());
  // They described the original bytes.
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(body, { status, statusText, headers });
}

/**
 * Puts the workspace's credential on every request of the SDK client, and sends a request once
 * more when the endpoint answers 401 and the source has a newer credential.
 *
 * It is SDK middleware and not a wrapper around fetch because the SDK treats their errors
 * differently: an error thrown from a fetch wrapper is retried and reaches the caller wrapped in
 * a connection error, while an error thrown here reaches the caller once, as it is. A failed
 * helper command must not be run three times and must not look like a network problem.
 */
export function createAuthorizer(credentials: CredentialProvider): Middleware {
  const { endpoint, scheme } = credentials.target;
  return async (request, next) => {
    // Before any credential is asked for. Also covers requests the SDK makes on its own account
    // (token exchanges): they get nothing. An address that does not parse counts as outside.
    if (!URL.canParse(request.url) || !isWithinEndpoint(endpoint, new URL(request.url))) {
      throw new EndpointPinError(endpoint);
    }
    // The signal is the request's own: it fires when the caller cancels the call. The SDK's time
    // limit does not run yet, so without it a cancelled call would be held here for as long as
    // a helper command takes. A call that is cancelled already does not even start one.
    const { signal } = request;
    signal?.throwIfAborted();
    const secret = await unlessAborted(credentials.get(), signal);
    setCredential(request.headers, scheme, secret);
    const response = await next(request);
    // An error body is read to the end here, before the provider is asked for anything: left
    // unread while a helper command runs or fails, it would keep the connection busy.
    const cleaned = await withoutCredential(response, credentials);
    // Only a body that can be sent again: the SDK encodes JSON requests to a string.
    const repeatable = request.body === undefined || request.body === null || typeof request.body === "string";
    if (response.status !== 401 || !repeatable) return cleaned;

    const renewed = await unlessAborted(credentials.renew(secret), signal);
    if (renewed === null) return cleaned;
    setCredential(request.headers, scheme, renewed);
    return withoutCredential(await next(request), credentials);
  };
}
