import { messages } from "./messages.ts";
import { useWorkspace } from "./use-workspace.ts";

/** Names the open workspace and the endpoint it is pinned to. Meant to be on every screen (CFG-3). */
export function WorkspaceIndicator() {
  const check = useWorkspace();

  return (
    // A status region, so that a screen reader says which workspace is open once it is known and
    // again when it changes. Polling the same answer changes nothing in the page and stays silent.
    <div
      role="status"
      aria-label={messages.workspace.label}
      className="mt-4 border-t border-zinc-200 pt-4 text-sm text-zinc-600"
    >
      {check.status === "confirmed" ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt>{messages.workspace.name}</dt>
          <dd className="wrap-anywhere font-medium text-zinc-900">{check.workspace.name}</dd>
          <dt>{messages.workspace.endpoint}</dt>
          <dd className="wrap-anywhere text-zinc-900">{check.workspace.endpointOrigin}</dd>
        </dl>
      ) : (
        <p>{messages.workspace[check.status]}</p>
      )}
    </div>
  );
}
