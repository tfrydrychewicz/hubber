import { type QueryStatus, useQuery } from "@tanstack/react-query";
import { HEALTH_PATH, isHealthResponse } from "../shared/health.ts";
import { getJson } from "./get-json.ts";
import { messages } from "./messages.ts";
import { WorkspaceIndicator } from "./WorkspaceIndicator.tsx";

// How often the server is asked.
const HEALTH_POLL_MS = 5_000;

const DOT_CLASS: Record<QueryStatus, string> = {
  pending: "motion-safe:animate-pulse bg-zinc-400",
  success: "bg-emerald-500",
  error: "bg-red-500",
};

export function App() {
  // Polled because the label reads as a statement about now; without it the answer is as old
  // as the last time the tab was shown. No retries: the next poll is the retry.
  const { status, errorUpdatedAt } = useQuery({
    queryKey: ["health"],
    queryFn: () => getJson(HEALTH_PATH, isHealthResponse),
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
        <WorkspaceIndicator />
      </section>
    </main>
  );
}
