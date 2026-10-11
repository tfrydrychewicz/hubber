import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { busyPortMessage, isBusyPortMessage, listenerOf } from "./busy-port.ts";
import {
  freePorts,
  type OccupiedPort,
  occupyPort,
  type SpawnedNode,
  type SpawnNodeOptions,
  spawnNode,
} from "./testing.ts";

const START_TIMEOUT_MS = 10_000;

// Listens on a port picked by the system and prints it together with its own pid. The timer
// is a safety net: the process goes away by itself if a failed test did not get to stop it.
const SERVER_SCRIPT = `import { createServer } from "node:net";
const server = createServer().listen(0, "127.0.0.1", () => console.log(\`\${server.address().port} \${process.pid}\`));
setTimeout(() => process.exit(), 30_000);
`;

// Starts the script named by its last argument, whatever else it was given.
const WRAPPER_SCRIPT = `import { spawn } from "node:child_process";
spawn(process.execPath, [process.argv.at(-1)], { stdio: "inherit" });
`;

interface Listening {
  port: number;
  pid: number;
}

const children: ChildProcess[] = [];
const servers: number[] = [];
let occupied: OccupiedPort | undefined;

let workDir: string;
let serverScript: string;
let wrapperScript: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "hubber-busy-port-"));
  serverScript = join(workDir, "server.mjs");
  wrapperScript = join(workDir, "wrapper.mjs");
  writeFileSync(serverScript, SERVER_SCRIPT);
  writeFileSync(wrapperScript, WRAPPER_SCRIPT);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

afterEach(async () => {
  // The servers are grandchildren of this process: killing what started them would leave them behind.
  for (const pid of servers.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await occupied?.release();
  occupied = undefined;
});

function start(script: string, options: SpawnNodeOptions): SpawnedNode {
  const started = spawnNode(script, options);
  children.push(started.child);
  return started;
}

/** Resolves with what the server script printed, wherever in the process tree it runs. */
function listening(started: SpawnedNode): Promise<Listening> {
  return vi.waitFor(
    () => {
      const match = /^(\d+) (\d+)$/m.exec(started.stdout());
      if (!match) throw new Error(`The server has not reported its port.\n${started.stdout()}${started.stderr()}`);
      const server = { port: Number(match[1]), pid: Number(match[2]) };
      servers.push(server.pid);
      return server;
    },
    { timeout: START_TIMEOUT_MS, interval: 20 },
  );
}

// Above the start timeout, so that a slow start reports the output of the process and not a bare test timeout.
describe("busy port", { timeout: START_TIMEOUT_MS + 5_000 }, () => {
  describe("listenerOf", () => {
    it("finds the process that listens on a port, and nobody once the port is free", async () => {
      occupied = await occupyPort();

      expect(listenerOf(occupied.port)).toEqual({ pid: process.pid, command: "node" });

      await occupied.release();
      expect(listenerOf(occupied.port)).toBeUndefined();
    });
  });

  describe("busyPortMessage", () => {
    it("names the process that holds the port and the command that stops it", async () => {
      occupied = await occupyPort();

      expect(busyPortMessage(occupied.port, "HUBBER_PORT")).toBe(
        [
          `Port ${occupied.port} na 127.0.0.1 jest zajęty przez proces ${process.pid} (node);`,
          `zatrzymasz go poleceniem "kill ${process.pid}". Inny port ustawisz zmienną HUBBER_PORT.`,
        ].join(" "),
      );
    });

    it("stands without a holder when none can be found", async () => {
      const [port] = await freePorts(1);

      expect(busyPortMessage(port, "HUBBER_WEB_PORT")).toBe(
        `Port ${port} na 127.0.0.1 jest zajęty. Inny port ustawisz zmienną HUBBER_WEB_PORT.`,
      );
    });

    it('advises stopping the watcher of a server under "node --watch", which frees the port for good', async () => {
      const watcher = start(serverScript, { nodeArgs: ["--watch"] });
      const server = await listening(watcher);

      expect(busyPortMessage(server.port, "HUBBER_PORT")).toBe(
        [
          `Port ${server.port} na 127.0.0.1 jest zajęty przez serwer uruchomiony przez "npm run dev"`,
          `(proces ${server.pid}); zatrzymasz go poleceniem "kill ${watcher.child.pid}".`,
          "Inny port ustawisz zmienną HUBBER_PORT.",
        ].join(" "),
      );

      // What the quoted command sends.
      watcher.child.kill("SIGTERM");
      await watcher.exited;
      expect(listenerOf(server.port)).toBeUndefined();
    });

    it("does not take a --watch among a script's own arguments for the watch mode of Node", async () => {
      const wrapper = start(wrapperScript, { args: ["--watch", serverScript] });
      const server = await listening(wrapper);

      expect(busyPortMessage(server.port, "HUBBER_PORT")).toBe(
        [
          `Port ${server.port} na 127.0.0.1 jest zajęty przez proces ${server.pid} (node);`,
          `zatrzymasz go poleceniem "kill ${server.pid}". Inny port ustawisz zmienną HUBBER_PORT.`,
        ].join(" "),
      );
    });
  });

  describe("isBusyPortMessage", () => {
    it("recognises the message about its port, with or without a holder, and not the one about another port", async () => {
      occupied = await occupyPort();
      const [free] = await freePorts(1);
      const held = busyPortMessage(occupied.port, "HUBBER_PORT");

      expect(isBusyPortMessage(held, occupied.port)).toBe(true);
      expect(isBusyPortMessage(busyPortMessage(free, "HUBBER_WEB_PORT"), free)).toBe(true);
      expect(isBusyPortMessage(held, free)).toBe(false);
      // A longer number that begins with the port's own digits is another port too.
      expect(isBusyPortMessage(held, Math.floor(occupied.port / 10))).toBe(false);
    });
  });
});
