// How long the server gets to answer. On loopback an answer takes milliseconds.
const TIMEOUT_MS = 3_000;

/**
 * Reads one address of the API and checks the answer against its contract in src/shared.
 *
 * The query's abort signal is left unread on purpose. Once a query function reads it, TanStack
 * Query aborts the request when the last component using the query unmounts, and in development
 * React's StrictMode unmounts every component right after its first mount: each page load would
 * begin with a cancelled request. Unread, the remount joins the request already under way, and
 * the deadline below is what bounds it.
 */
export async function getJson<Body>(path: string, isBody: (body: unknown) => body is Body): Promise<Body> {
  // A server that is suspended or stuck still accepts the connection. Without a deadline the
  // request stays pending for good, what the page shows never changes and no further request is started.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error(`GET ${path} timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
  try {
    const response = await fetch(path, { signal: deadline.signal });
    if (!response.ok) throw new Error(`GET ${path} returned ${response.status}`);
    const body: unknown = await response.json();
    if (!isBody(body)) throw new Error(`GET ${path} returned an unexpected body`);
    return body;
  } catch (error) {
    // WebKit rejects an aborted fetch with an AbortError of its own, not with the reason given to abort().
    throw deadline.signal.aborted ? deadline.signal.reason : error;
  } finally {
    clearTimeout(timer);
  }
}
