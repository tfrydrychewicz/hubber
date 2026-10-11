import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createShutdown } from "./shutdown.ts";
import { freePorts, type SpawnedNode, type SpawnNodeOptions, spawnNode } from "./testing.ts";

const DEADLINE_MS = 3_000;
const START_TIMEOUT_MS = 10_000;
const SHUTDOWN_MODULE = pathToFileURL(join(import.meta.dirname, "shutdown.ts")).href;

// Shuts down at once. close() never settles and leaves nothing behind: once the handler has
// returned, no server, socket or timer of the script's own keeps the process running.
const HUNG_CLOSE_SCRIPT = `import { createShutdown } from ${JSON.stringify(SHUTDOWN_MODULE)};
createShutdown({
  close: () => new Promise(() => {}),
  exit: (code) => process.exit(code),
  log: (line) => console.log(line),
  deadlineMs: 200,
})();
`;

// Loaded before the server's entry point. The server then never finishes closing: asked to, it
// does nothing and never reports back, which stands for whatever may hang in a shutdown one day.
const CLOSE_NEVER_ENDS = `import { Server } from "node:http";
Server.prototype.close = function () {
  return this;
};
`;

function setup() {
  const closing = Promise.withResolvers<void>();
  const close = vi.fn(() => closing.promise);
  const exit = vi.fn();
  const log = vi.fn();
  const shutdown = createShutdown({ close, exit, log, deadlineMs: DEADLINE_MS });
  return { shutdown, close, exit, log, finishClosing: closing.resolve };
}

describe("createShutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exits with code 0 once close() has resolved, and not before", async () => {
    const { shutdown, exit, log, finishClosing } = setup();

    shutdown();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(log).toHaveBeenCalledExactlyOnceWith("Zamykanie serwera…");
    expect(exit).not.toHaveBeenCalled();

    finishClosing();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("ignores a repeated signal", async () => {
    const { shutdown, close, exit, log, finishClosing } = setup();

    shutdown();
    shutdown();
    finishClosing();
    await vi.advanceTimersByTimeAsync(0);

    expect(close).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("exits with code 1 when close() has not resolved by the deadline", async () => {
    const { shutdown, exit } = setup();

    shutdown();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});

// A fake clock shows neither whether the deadline keeps a process running nor what the server
// makes of it, so these tests wait for it in real processes. The one that starts the server
// takes the three seconds of its deadline. It is here, and not with the other tests that start
// the server in main.test.ts, so that it runs beside them instead of after them.
// The timeout is above the start timeout, so that a slow start reports the output of the
// process and not a bare test timeout.
describe("the deadline in a real process", { timeout: START_TIMEOUT_MS + 5_000 }, () => {
  const children: ChildProcess[] = [];
  let workDir: string;
  let hungCloseScript: string;
  let closeNeverEnds: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "hubber-shutdown-"));
    hungCloseScript = join(workDir, "hung-close.mjs");
    writeFileSync(hungCloseScript, HUNG_CLOSE_SCRIPT);
    closeNeverEnds = join(workDir, "close-never-ends.mjs");
    writeFileSync(closeNeverEnds, CLOSE_NEVER_ENDS);
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
  });

  function start(script: string, options?: SpawnNodeOptions): SpawnedNode {
    const started = spawnNode(script, options);
    children.push(started.child);
    return started;
  }

  it("exits with code 1 at the deadline even when a hung close() is all that is left", async () => {
    const script = start(hungCloseScript);

    expect(await script.exited).toEqual({ code: 1, signal: null });
    expect(script.stdout()).toBe("Zamykanie serwera…\n");
    expect(script.stderr()).toBe("");
  });

  it("ends the server with code 1 once closing it has taken longer than its deadline", async () => {
    const [port] = await freePorts(1);
    const server = start("src/server/main.ts", {
      nodeArgs: ["--import", pathToFileURL(closeNeverEnds).href],
      // Any allowed development origin will do: with one, the server needs no built web app.
      env: { HUBBER_PORT: String(port), HUBBER_DEV_ORIGIN: "http://127.0.0.1:5173" },
    });
    await vi.waitFor(
      () => {
        if (server.stdout().includes(`http://127.0.0.1:${port}`)) return;
        throw new Error(`The server has not printed its address.\n${server.stdout()}${server.stderr()}`);
      },
      { timeout: START_TIMEOUT_MS, interval: 20 },
    );

    const startedAt = performance.now();
    server.child.kill("SIGTERM");

    expect(await server.exited).toEqual({ code: 1, signal: null });
    // The deadline is three seconds. The same code any earlier would come from a crash.
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(2_900);
    expect(server.stdout()).toContain("Zamykanie serwera…");
  });
});
