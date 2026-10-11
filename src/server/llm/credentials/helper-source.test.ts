import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { spawnNode } from "../../testing.ts";
import type { HelperSpec } from "./file-source.ts";
import { type HelperRunOptions, runHelper } from "./helper-source.ts";
import { CredentialError } from "./types.ts";

const PLANT = "hubber-planted-secret-7f3a9c";
const ENDPOINT = "https://router.corp.example/llm";

const sandbox = mkdtempSync(join(tmpdir(), "hubber-credentials-helper-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const children: ChildProcess[] = [];
const groups: number[] = [];
// Files in which a command noted the process that it left behind.
const leftBehind: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  // A command that a failed test left running.
  for (const group of groups.splice(0)) if (groupIsAlive(group)) process.kill(-group, "SIGKILL");
  for (const pidFile of leftBehind.splice(0)) {
    try {
      process.kill(pidFrom(pidFile), "SIGKILL");
    } catch {
      // Not started, or gone already.
    }
  }
});

function groupIsAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

/** The process id that a command wrote into a file. */
function pidFrom(pidFile: string): number {
  const pid = Number(readFileSync(pidFile, "utf8"));
  // Never 0 or 1: a signal to those would reach the test run itself, or everything the user runs.
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`Not the process id of a command: ${pid}`);
  return pid;
}

/** The process group that a command wrote into a file as the process id of its shell. */
const groupFrom = pidFrom;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A helper command that leaves a process behind, the way a command-line tool starts an agent that
// keeps a login: the process inherits the output of the command and so holds the pipe open.
// "inside" leaves it in the process group of the command, "outside" in a session of its own, as
// a daemon does, where a signal to the group does not reach it. The command then prints the
// token and ends, or stays ("hangs").
const LEAVES_A_PROCESS = join(sandbox, "leaves-a-process.mjs");
writeFileSync(
  LEAVES_A_PROCESS,
  `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [pidFile, where, then, token] = process.argv.slice(2);
const left = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
  detached: where === "outside",
  stdio: ["ignore", "inherit", "ignore"],
});
left.unref();
writeFileSync(pidFile, String(left.pid));
console.log(token);
if (then === "hangs") setTimeout(() => {}, 60_000);
`,
);

let leavers = 0;
/** The command above, and the file in which it notes the process it leaves behind. */
function leavingAProcess(where: "inside" | "outside", then: "ends" | "hangs", token = PLANT) {
  const pidFile = join(sandbox, `left-behind-${++leavers}.pid`);
  leftBehind.push(pidFile);
  const command: [string, ...string[]] = [process.execPath, LEAVES_A_PROCESS, pidFile, where, then, token];
  return { command, pidFile };
}

// Stands in for the server process: runs one helper command the way the provider does, with
// the server's own defaults, and prints how the run ended. Given a file to wait for, it leaves
// as soon as the file is there, while the command is still running.
const SERVER_STAND_IN = join(sandbox, "run-helper.mjs");
writeFileSync(
  SERVER_STAND_IN,
  `import { existsSync } from "node:fs";
import { runHelper } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "helper-source.ts")).href)};

const { command, leaveWhenThereIs } = JSON.parse(process.argv[2]);
if (leaveWhenThereIs !== undefined) {
  setInterval(() => {
    if (existsSync(leaveWhenThereIs)) process.exit(0);
  }, 10);
}
const spec = { command, ttlMs: 300_000, timeoutMs: 60_000 };
runHelper(spec, { endpoint: ${JSON.stringify(ENDPOINT)}, env: { PATH: "/usr/bin:/bin" } }).then(
  (secret) => console.log(\`resolved: \${secret.reveal()}\`),
  (error) => console.log(\`rejected: \${error.message}\`),
);
`,
);

function standInServer(setup: { command: string[]; leaveWhenThereIs?: string }) {
  const server = spawnNode(SERVER_STAND_IN, { args: [JSON.stringify(setup)] });
  children.push(server.child);
  return server;
}

const spec = (command: [string, ...string[]], timeoutMs = 10_000): HelperSpec => ({
  command,
  ttlMs: 300_000,
  timeoutMs,
});
// The command's own messages are left out of the test run's output.
const options: HelperRunOptions = { endpoint: ENDPOINT, env: { PATH: "/usr/bin:/bin" }, stderr: "ignore" };

const sh = (script: string, timeoutMs?: number) => spec(["/bin/sh", "-c", script], timeoutMs);

/** The message of the CredentialError that the run ends with. No message may repeat what the command printed. */
async function failure(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (!(error instanceof CredentialError)) throw error;
    expect(error.message).not.toMatch(/planted|7f3a9c/);
    return error.message;
  }
  throw new Error("runHelper did not reject");
}

describe("runHelper", () => {
  it("returns what the command printed, without the line break", async () => {
    expect((await runHelper(sh(`echo "${PLANT}"`), options)).reveal()).toBe(PLANT);
  });

  it("hands the command the endpoint and the given environment, not the one of this process", async () => {
    vi.stubEnv("HUBBER_TEST_INHERITED", "inherited");
    const env = { PATH: "/usr/bin:/bin", MARKER: "given" };

    const seen = await runHelper(sh('echo "$MARKER-for-$HUBBER_ENDPOINT-[$HUBBER_TEST_INHERITED]"'), {
      ...options,
      env,
    });

    expect(seen.reveal()).toBe(`given-for-${ENDPOINT}-[]`);
  });

  it("starts the command in the root directory with nothing to read from", async () => {
    // "cat" ends at once only because there is no input; otherwise it would wait until the limit.
    const seen = await runHelper(sh('cat; echo "started-in-$(pwd)"'), options);

    expect(seen.reveal()).toBe("started-in-/");
  });

  it("passes arguments as they are, with no shell in between", async () => {
    // A shell would run both substitutions; the first one would create the file.
    const marker = join(sandbox, "created-by-a-shell");
    const argument = `token-$(:>${marker})-\`id\`;x`;

    const seen = await runHelper(spec(["/usr/bin/printf", "%s", argument]), options);

    expect(seen.reveal()).toBe(argument);
    expect(existsSync(marker)).toBe(false);
  });

  it("reports each failure in its own words and never repeats the output", async () => {
    const missing = join(sandbox, "missing-helper");
    const notExecutable = join(sandbox, "not-executable.sh");
    writeFileSync(notExecutable, `#!/bin/sh\necho ${PLANT}\n`);
    chmodSync(notExecutable, 0o600);

    expect(await failure(runHelper(sh(`echo ${PLANT}; echo ${PLANT} >&2; exit 3`), options))).toBe(
      'Polecenie pomocnicze "/bin/sh" zakończyło się kodem 3. Jego własne komunikaty są w terminalu serwera.',
    );
    expect(await failure(runHelper(spec(["/usr/bin/true"]), options))).toBe(
      'Polecenie pomocnicze "/usr/bin/true" nie wypisało poświadczenia.',
    );
    expect(await failure(runHelper(sh(`echo banner; echo ${PLANT}`), options))).toBe(
      'Polecenie pomocnicze "/bin/sh" wypisało więcej niż jedną linię. Ma wypisać samo poświadczenie.',
    );
    expect(await failure(runHelper(sh(`echo "${PLANT} with space"`), options))).toBe(
      'Poświadczenie wypisane przez polecenie pomocnicze "/bin/sh" zawiera znak, którego nie da się wysłać w nagłówku: odstęp, znak nowej linii, cudzysłów, ukośnik wsteczny albo znak spoza ASCII.',
    );
    expect(await failure(runHelper(sh("echo short"), options))).toBe(
      'Poświadczenie wypisane przez polecenie pomocnicze "/bin/sh" jest krótsze niż 8 znaków.',
    );
    expect(await failure(runHelper(spec([missing]), options))).toBe(`Polecenie pomocnicze "${missing}" nie istnieje.`);
    expect(await failure(runHelper(spec([notExecutable]), options))).toBe(
      `Polecenie pomocnicze "${notExecutable}" nie ma prawa wykonywania. Nadasz je poleceniem "chmod u+x ${notExecutable}".`,
    );
    expect(await failure(runHelper(sh(`echo ${PLANT}; kill -9 $$`), options))).toBe(
      'Polecenie pomocnicze "/bin/sh" zostało przerwane sygnałem SIGKILL.',
    );
  });

  it("ends a command that prints more than a credential can take", async () => {
    const started = performance.now();

    const message = await failure(runHelper(sh(`while :; do echo ${PLANT}; done`), options));

    expect(message).toBe('Polecenie pomocnicze "/bin/sh" wypisało więcej niż 64 KiB. Ma wypisać samo poświadczenie.');
    // Far from the limit of ten seconds: the endless output was cut off, not waited for.
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("ends a command that takes too long, together with what it started", async () => {
    const started = performance.now();

    // The grandchildren hold the output open: ending the shell alone would leave the run waiting for them.
    const message = await failure(runHelper(sh(`echo ${PLANT}; sleep 30 | cat`, 300), options));

    expect(message).toBe(
      'Polecenie pomocnicze "/bin/sh" nie zakończyło się w 0,3 s i zostało przerwane. Limit zmienisz polem "timeoutSeconds" w pliku poświadczeń.',
    );
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("ends a command that ignores the polite signal a second later", async () => {
    const started = performance.now();

    const message = await failure(runHelper(sh(`trap "" TERM; echo ${PLANT}; sleep 30`, 300), options));

    const elapsed = performance.now() - started;
    expect(message).toContain("nie zakończyło się w 0,3 s i zostało przerwane");
    expect(elapsed).toBeGreaterThan(1_200);
    expect(elapsed).toBeLessThan(10_000);
  });

  it("can be stopped from outside", async () => {
    const controller = new AbortController();
    const run = failure(runHelper(spec(["/bin/sleep", "30"]), { ...options, signal: controller.signal }));
    setTimeout(() => controller.abort(), 100);

    expect(await run).toBe('Polecenie pomocnicze "/bin/sleep" zostało przerwane, bo serwer kończy pracę.');
  });

  // Without a limit of its own: the default of a test is five seconds, and each of these would
  // take ten (the limit of the command) or sixty (the life of the process left behind) if the
  // run waited for the output to close.
  it.each(["inside", "outside"] as const)(
    "returns what a command printed as soon as it has ended, although a process it left %s its group holds the output open",
    async (where) => {
      const { command, pidFile } = leavingAProcess(where, "ends");
      const started = performance.now();

      const seen = await runHelper(spec(command), options);

      expect(seen.reveal()).toBe(PLANT);
      expect(performance.now() - started).toBeLessThan(4_000);
      // It got no signal: it may be the agent that spares the user the next login.
      expect(isAlive(pidFrom(pidFile))).toBe(true);
    },
  );

  it("loses nothing of a long credential when it stops waiting for the output to close", async () => {
    const longest = "x".repeat(8192);
    const { command } = leavingAProcess("outside", "ends", longest);

    expect((await runHelper(spec(command), options)).reveal()).toBe(longest);
  });

  it("ends a command at its limit, although a process outside its group holds the output open", async () => {
    const { command } = leavingAProcess("outside", "hangs");
    const started = performance.now();

    const message = await failure(runHelper(spec(command, 500), options));

    expect(message).toBe(
      `Polecenie pomocnicze "${process.execPath}" nie zakończyło się w 0,5 s i zostało przerwane. Limit zmienisz polem "timeoutSeconds" w pliku poświadczeń.`,
    );
    expect(performance.now() - started).toBeLessThan(4_000);
  });

  it("can be stopped from outside, although a process outside its group holds the output open", async () => {
    const { command, pidFile } = leavingAProcess("outside", "hangs");
    const controller = new AbortController();
    const run = failure(runHelper(spec(command), { ...options, signal: controller.signal }));
    // Once the command has got as far as it gets.
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 3_000, interval: 20 });
    const stopped = performance.now();
    controller.abort();

    expect(await run).toBe(`Polecenie pomocnicze "${process.execPath}" zostało przerwane, bo serwer kończy pracę.`);
    expect(performance.now() - stopped).toBeLessThan(3_000);
  });

  it("reports an argument that no program can be handed, without repeating it", async () => {
    // spawn() itself refuses a NUL character, with an error that quotes the argument.
    const message = await failure(runHelper(spec(["/bin/echo", `token\u0000${PLANT}`]), options));

    expect(message).toBe('Nie udało się uruchomić polecenia pomocniczego "/bin/echo" (ERR_INVALID_ARG_VALUE).');
  });

  it("lets the command's own messages through to the server's terminal, and keeps them out of its own", async () => {
    const server = standInServer({ command: ["/bin/sh", "-c", "echo said-by-the-command >&2; exit 3"] });

    const { code } = await server.exited;

    expect(code, server.stderr()).toBe(0);
    expect(server.stderr()).toBe("said-by-the-command\n");
    expect(server.stdout()).toBe(
      'rejected: Polecenie pomocnicze "/bin/sh" zakończyło się kodem 3. Jego własne komunikaty są w terminalu serwera.\n',
    );
  });

  it("does not let a command outlive the server process", async () => {
    const pidFile = join(sandbox, "helper.pid");
    const server = standInServer({
      // The shell leads the process group of the command; "sleep" is what it started.
      command: ["/bin/sh", "-c", `echo $$ > "${pidFile}"; sleep 30`],
      leaveWhenThereIs: pidFile,
    });

    // Its exit, not the end of its output: a command that outlived it would keep the output open.
    const [code] = await once(server.child, "exit");
    const group = groupFrom(pidFile);
    groups.push(group);

    expect(code, server.stderr()).toBe(0);
    // The signal was sent as the server left; the system may need a moment to act on it.
    await vi.waitFor(() => expect(groupIsAlive(group)).toBe(false), { timeout: 3_000, interval: 20 });
  });

  it("does not start once the server is shutting down", async () => {
    const marker = join(sandbox, "started-after-shutdown");
    const controller = new AbortController();
    controller.abort();

    const message = await failure(
      runHelper(spec(["/usr/bin/touch", marker]), { ...options, signal: controller.signal }),
    );

    expect(message).toBe('Polecenie pomocnicze "/usr/bin/touch" nie zostało uruchomione, bo serwer kończy pracę.');
    expect(existsSync(marker)).toBe(false);
  });
});
