import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  freePorts,
  type OccupiedPort,
  occupyPort,
  rawGet,
  type SpawnedNode,
  type SpawnNodeOptions,
  spawnNode,
} from "./testing.ts";

const HOST = "127.0.0.1";
const REPO_ROOT = join(import.meta.dirname, "../..");
const START_TIMEOUT_MS = 10_000;
// Where Vitest was started: the repository root for "npm test", but any directory will do.
const START_DIR = process.cwd();

// Reports what it was started with and ends with a code of its own.
const REPORT_SCRIPT = `const report = { cwd: process.cwd(), args: process.argv.slice(2), env: process.env };
process.stdout.write(JSON.stringify(report));
process.stderr.write("koniec");
process.exitCode = 3;
`;

// The two bytes of the letter "ż", written far enough apart to arrive in two chunks.
const SPLIT_CHARACTER_SCRIPT = `process.stdout.write(Buffer.from([0xc5]));
setTimeout(() => process.stdout.write(Buffer.from([0xbc])), 100);
`;

// Says that it runs and then stays, until something ends it.
const WAITING_SCRIPT = `console.log("gotowy");
setTimeout(() => {}, 30_000);
`;

const children: ChildProcess[] = [];
const servers: Server[] = [];
let occupied: OccupiedPort | undefined;

let workDir: string;
let reportScript: string;
let splitCharacterScript: string;
let waitingScript: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "hubber-testing-"));
  reportScript = join(workDir, "report.mjs");
  splitCharacterScript = join(workDir, "split-character.mjs");
  waitingScript = join(workDir, "waiting.mjs");
  writeFileSync(reportScript, REPORT_SCRIPT);
  writeFileSync(splitCharacterScript, SPLIT_CHARACTER_SCRIPT);
  writeFileSync(waitingScript, WAITING_SCRIPT);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.chdir(START_DIR);
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const server of servers.splice(0)) server.close();
  await occupied?.release();
  occupied = undefined;
});

function run(script: string, options?: SpawnNodeOptions): SpawnedNode {
  const started = spawnNode(script, options);
  children.push(started.child);
  return started;
}

/** Resolves with the error code of an attempt to listen on the port, or with nothing when it worked. */
function listenError(port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => resolve(error.code));
    server.listen(port, HOST, () => server.close(() => resolve(undefined)));
  });
}

// Above the start timeout, so that a slow start reports what was expected and not a bare test timeout.
describe("spawnNode", { timeout: START_TIMEOUT_MS + 5_000 }, () => {
  it("starts a script in the repository root with a scratch environment and reports how it ended", async () => {
    // Stands for whatever the developer has set in the shell that runs the tests.
    vi.stubEnv("HUBBER_FROM_THE_SHELL", "1");
    // "npm test" starts Vitest in the repository root, where a helper that left the script's path
    // and the working directory to its caller would do just as well, so the test moves elsewhere.
    // That takes Vitest's default pool of processes: a worker thread cannot change its directory.
    process.chdir(workDir);

    // Named relative to the repository root, like "scripts/dev.ts".
    const script = run(relative(REPO_ROOT, reportScript), {
      args: ["--flaga", "wartość"],
      env: { HUBBER_PORT: "5000" },
    });

    expect(await script.exited).toEqual({ code: 3, signal: null });
    const report = JSON.parse(script.stdout()) as { cwd: string; args: string[]; env: Record<string, string> };
    expect(report.cwd).toBe(realpathSync(REPO_ROOT));
    expect(report.args).toEqual(["--flaga", "wartość"]);
    expect(report.env).toMatchObject({ PATH: process.env.PATH, HUBBER_PORT: "5000" });
    expect(report.env).not.toHaveProperty("HUBBER_FROM_THE_SHELL");
    expect(script.stderr()).toBe("koniec");
  });

  it("keeps a character whole when its bytes arrive in separate chunks", async () => {
    const script = run(splitCharacterScript);

    expect(await script.exited).toEqual({ code: 0, signal: null });
    expect(script.stdout()).toBe("ż");
  });

  it("reports the signal that ended the process", async () => {
    const script = run(waitingScript);
    await vi.waitFor(() => expect(script.stdout()).toBe("gotowy\n"), { timeout: START_TIMEOUT_MS });

    script.child.kill("SIGTERM");

    expect(await script.exited).toEqual({ code: null, signal: "SIGTERM" });
  });
});

describe("occupyPort", () => {
  it("keeps its port taken until it is released", async () => {
    occupied = await occupyPort();

    expect(await listenError(occupied.port)).toBe("EADDRINUSE");

    await occupied.release();
    await occupied.release();
    expect(await listenError(occupied.port)).toBeUndefined();
  });
});

describe("freePorts", () => {
  it("finds as many different ports as asked for, all of them free", async () => {
    const ports = await freePorts(3);

    expect(new Set(ports).size).toBe(3);
    for (const port of ports) expect(await listenError(port)).toBeUndefined();
  });
});

describe("rawGet", () => {
  it("sends the target and the Host header as given and returns the whole response", async () => {
    const requests: string[] = [];
    const server = createServer((socket) => {
      socket.setEncoding("utf8").once("data", (request: string) => {
        requests.push(request);
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
      });
    }).listen(0, HOST);
    servers.push(server);
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    const response = await rawGet({ port, target: "/a/../b%2f?x=1", host: "example.test:1" });
    await rawGet({ port, target: "/" });

    expect(response).toBe("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    expect(requests).toEqual([
      "GET /a/../b%2f?x=1 HTTP/1.1\r\nHost: example.test:1\r\nConnection: close\r\n\r\n",
      `GET / HTTP/1.1\r\nHost: ${HOST}:${port}\r\nConnection: close\r\n\r\n`,
    ]);
  });
});
