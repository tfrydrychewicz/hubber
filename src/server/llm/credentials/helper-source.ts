// Source 3: a command that prints the credential, for tokens that rotate. Configured in the
// credentials file (file-source.ts); this module only runs it.
import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { Env } from "./env-source.ts";
import type { HelperSpec } from "./file-source.ts";
import { SECRET_PROBLEM_TEXT, Secret } from "./secret.ts";
import { CredentialError } from "./types.ts";

// A bearer token is a few kilobytes at most; anything longer is not a credential.
const MAX_OUTPUT_BYTES = 64 * 1024;
// Between the polite signal and the one that cannot be ignored.
const KILL_GRACE_MS = 1000;
// For how long the output is still read once the command itself has ended. What it printed is
// in the pipe by then; this is only for the pipe to be emptied.
const DRAIN_MS = 250;

export interface HelperRunOptions {
  /** Handed to the command as HUBBER_ENDPOINT, so that one script can serve several endpoints. */
  endpoint: string;
  /** The environment of the command. */
  env: Env;
  /** Ends the run early, on shutdown. */
  signal?: AbortSignal;
  /** Where the command's own messages go. The server's terminal by default; they are never read here. */
  stderr?: "inherit" | "ignore";
}

// Process groups of the commands that are running, so that none outlives the server.
const running = new Set<number>();
let exitHookInstalled = false;

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is gone already.
  }
}

/**
 * Runs the command once and resolves with what it printed.
 *
 * - No shell: the first element is the program, the rest are its arguments, passed as they are.
 * - Asynchronous: a synchronous run would stop the whole server for as long as the command takes.
 * - Its own process group: the limit ends the command together with whatever it started.
 * - The run is over when the command itself has ended, not when its output closes: a process
 *   that the command left behind can hold the output open for as long as it lives, also from
 *   outside the group, where no signal sent here reaches it. After a run that ended by itself
 *   such a process gets no signal: a program that keeps a login for the next run is the usual
 *   reason for one. It only loses the output that it shared with the command.
 * - Nothing the command prints or was given ends up in an error message.
 */
export function runHelper(spec: HelperSpec, options: HelperRunOptions): Promise<Secret> {
  const [file, ...args] = spec.command;
  return new Promise<Secret>((resolve, reject) => {
    const fail = (message: string) => reject(new CredentialError(message));
    if (options.signal?.aborted) {
      fail(`Polecenie pomocnicze "${file}" nie zostało uruchomione, bo serwer kończy pracę.`);
      return;
    }

    let child: ChildProcessByStdio<null, Readable, null>;
    try {
      child = spawn(file, args, {
        shell: false,
        detached: true,
        cwd: "/",
        env: { ...options.env, HUBBER_ENDPOINT: options.endpoint },
        stdio: ["ignore", "pipe", options.stderr ?? "inherit"],
      });
    } catch (error) {
      // What cannot be handed to a program at all (a NUL character in an argument). Only the
      // code: the message of such an error quotes the argument.
      fail(
        `Nie udało się uruchomić polecenia pomocniczego "${file}" (${(error as NodeJS.ErrnoException).code ?? "nieznany błąd"}).`,
      );
      return;
    }
    const pid = child.pid;
    if (pid !== undefined) {
      running.add(pid);
      if (!exitHookInstalled) {
        exitHookInstalled = true;
        process.once("exit", () => {
          for (const group of running) signalGroup(group, "SIGKILL");
        });
      }
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let stopped: "timeout" | "too-long" | "aborted" | undefined;
    const stop = (reason: NonNullable<typeof stopped>, signal: NodeJS.Signals) => {
      if (stopped !== undefined || pid === undefined) return;
      stopped = reason;
      signalGroup(pid, signal);
      if (signal !== "SIGKILL") setTimeout(() => signalGroup(pid, "SIGKILL"), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => stop("timeout", "SIGTERM"), spec.timeoutMs);
    const onAbort = () => stop("aborted", "SIGTERM");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) stop("too-long", "SIGKILL");
      else chunks.push(chunk);
    });

    // Whoever still holds the other end of the pipe is not waited for. The pipe is emptied in
    // the part of the event loop that comes before setImmediate(), so by then everything the
    // command had printed has been read, however late the timer was served.
    let drain: NodeJS.Timeout | undefined;
    child.once("exit", () => {
      drain = setTimeout(() => setImmediate(() => child.stdout.destroy()), DRAIN_MS);
    });

    const settle = () => {
      clearTimeout(timer);
      clearTimeout(drain);
      options.signal?.removeEventListener("abort", onAbort);
      if (pid !== undefined) running.delete(pid);
    };

    child.once("error", (error: NodeJS.ErrnoException) => {
      settle();
      if (error.code === "ENOENT") fail(`Polecenie pomocnicze "${file}" nie istnieje.`);
      else if (error.code === "EACCES") {
        fail(`Polecenie pomocnicze "${file}" nie ma prawa wykonywania. Nadasz je poleceniem "chmod u+x ${file}".`);
      } else fail(`Nie udało się uruchomić polecenia pomocniczego "${file}" (${error.code ?? "nieznany błąd"}).`);
    });

    // "close" rather than "exit": it fires once the output has been read to its end, or to
    // where the reading was stopped above.
    child.once("close", (code, signal) => {
      settle();
      if (stopped === "timeout") {
        fail(
          `Polecenie pomocnicze "${file}" nie zakończyło się w ${String(spec.timeoutMs / 1000).replace(".", ",")} s i zostało przerwane. Limit zmienisz polem "timeoutSeconds" w pliku poświadczeń.`,
        );
      } else if (stopped === "too-long") {
        fail(`Polecenie pomocnicze "${file}" wypisało więcej niż 64 KiB. Ma wypisać samo poświadczenie.`);
      } else if (stopped === "aborted") {
        fail(`Polecenie pomocnicze "${file}" zostało przerwane, bo serwer kończy pracę.`);
      } else if (signal !== null) {
        fail(`Polecenie pomocnicze "${file}" zostało przerwane sygnałem ${signal}.`);
      } else if (code !== 0) {
        fail(
          `Polecenie pomocnicze "${file}" zakończyło się kodem ${code}. Jego własne komunikaty są w terminalu serwera.`,
        );
      } else {
        const output = Buffer.concat(chunks).toString("utf8").trim();
        if (/[\r\n]/.test(output)) {
          fail(`Polecenie pomocnicze "${file}" wypisało więcej niż jedną linię. Ma wypisać samo poświadczenie.`);
          return;
        }
        const secret = Secret.parse(output);
        if (typeof secret === "string") {
          fail(
            secret === "empty"
              ? `Polecenie pomocnicze "${file}" nie wypisało poświadczenia.`
              : `Poświadczenie wypisane przez polecenie pomocnicze "${file}" ${SECRET_PROBLEM_TEXT[secret]}.`,
          );
        } else resolve(secret);
      }
    });
  });
}
