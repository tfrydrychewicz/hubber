import { useQuery } from "@tanstack/react-query";
import { isWorkspaceInfo, WORKSPACE_PATH, type WorkspaceInfo } from "../shared/workspace.ts";
import { getJson } from "./get-json.ts";

// A server restarted with another workspace keeps its address, and a tab that was open before
// goes on working with it. Asked once, the page would then name a workspace that is no longer
// the open one, which is the mistake the indicator is there to prevent (CFG-3, NFR-2).
const WORKSPACE_POLL_MS = 5_000;

/**
 * What the page knows about the open workspace at this moment. There is a workspace to read
 * only while the last check that finished confirmed it: the page must not vouch for a
 * workspace it could not confirm, so an answer that is older than a failed check is gone, also
 * while the next check is under way.
 */
export type WorkspaceCheck =
  | { status: "pending" }
  | { status: "error" }
  | { status: "confirmed"; workspace: WorkspaceInfo };

/**
 * Asks the server which workspace is open, and keeps asking. Every screen that names the
 * workspace or depends on which one is open reads it here and not from the query: the query
 * keeps its last answer through every failure that follows, and this is where it is withheld.
 */
export function useWorkspace(): WorkspaceCheck {
  // No retries: the next poll is the retry. The library's defaults do the rest: a hidden tab
  // does not ask, and a tab that is shown again asks at once.
  const query = useQuery({
    queryKey: ["workspace"],
    queryFn: () => getJson(WORKSPACE_PATH, isWorkspaceInfo),
    refetchInterval: WORKSPACE_POLL_MS,
    retry: false,
  });

  if (query.status === "success") return { status: "confirmed", workspace: query.data };
  // Until one check has succeeded every re-check reports "pending" again, and the last
  // finished check did fail.
  return { status: query.status === "pending" && query.errorUpdatedAt === 0 ? "pending" : "error" };
}
