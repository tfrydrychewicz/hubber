import { type QueryStatus, useQuery } from "@tanstack/react-query";
import { HEALTH_PATH, type HealthResponse, isHealthResponse } from "../shared/health.ts";
import { messages } from "./messages.ts";

// How often the server is asked, and how long it gets to answer.
const HEALTH_POLL_MS = 5_000;
const HEALTH_TIMEOUT_MS = 3_000;

const DOT_CLASS: Record<QueryStatus, string> = {
  pending: "motion-safe:animate-pulse bg-zinc-400",
  success: "bg-emerald-500",
  error: "bg-red-500",
};

// The query's abort signal is left unread on purpose. Once a query function reads it, TanStack
// Query aborts the request when the last component using the query unmounts, and in development
// React's StrictMode unmounts every component right after its first mount: each page load would
// begin with a cancelled request. Unread, the remount joins the request already under way, and
// the deadline below is what bounds it.
async function fetchHealth(): Promise<HealthResponse> {
  // A server that is suspended or stuck still accepts the connection. Without a deadline the
  // request stays pending for good, the label never changes and no further check is started.
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error(`GET ${HEALTH_PATH} timed out after ${HEALTH_TIMEOUT_MS} ms`)),
    HEALTH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(HEALTH_PATH, { signal: deadline.signal });
    if (!response.ok) throw new Error(`GET ${HEALTH_PATH} returned ${response.status}`);
    const body: unknown = await response.json();
    if (!isHealthResponse(body)) throw new Error(`GET ${HEALTH_PATH} returned an unexpected body`);
    return body;
  } catch (error) {
    // WebKit rejects an aborted fetch with an AbortError of its own, not with the reason given to abort().
    throw deadline.signal.aborted ? deadline.signal.reason : error;
  } finally {
    clearTimeout(timer);
  }
}

export function App() {
  // Polled because the label reads as a statement about now; without it the answer is as old
  // as the last time the tab was shown. No retries: the next poll is the retry.
  const { status, errorUpdatedAt } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: HEALTH_POLL_MS,
    retry: false,
  });
  // Until one check has succeeded there is no answer to keep, so every re-check reports
  // "pending" again. The last finished check did fail, and the label goes on saying so.
  const shown: QueryStatus = status === "pending" && errorUpdatedAt > 0 ? "error" : status;

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-100 p-6 text-zinc-900">
      <section className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight">{messages.appName}</h1>
        <p role="status" className="mt-4 flex items-center gap-2 text-sm text-zinc-600">
          <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${DOT_CLASS[shown]}`} />
          {messages.health[shown]}
        </p>
      </section>
    </main>
  );
}
