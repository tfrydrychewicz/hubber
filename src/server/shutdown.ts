import { EXIT_FAILURE } from "./exit-codes.ts";

export interface ShutdownOptions {
  /** Ends everything that is running. The process exits with code 0 once it resolves. */
  close: () => Promise<void>;
  exit: (code: number) => void;
  log: (line: string) => void;
  /** How long close() may take before the process exits with a failure code anyway. */
  deadlineMs: number;
}

/** Returns the handler for the signals that end the process. */
export function createShutdown({ close, exit, log, deadlineMs }: ShutdownOptions): () => void {
  let stopping = false;
  return () => {
    // One Ctrl-C can arrive several times: from the terminal, from npm and from "node --watch".
    if (stopping) return;
    stopping = true;
    log("Zamykanie serwera…");
    // close() is bounded by its own grace period. The deadline is for whatever later packages
    // add to shutdown (job loop, database): a hang there must not block "node --watch" restarts.
    // The timer stays referenced: a close() that hangs with nothing else left running would
    // otherwise let the process end by itself before the deadline, and with code 0.
    setTimeout(() => exit(EXIT_FAILURE), deadlineMs);
    void close().then(() => exit(0));
  };
}
