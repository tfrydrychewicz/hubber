import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { ANTHROPIC_ENDPOINT, parseEndpoint } from "../endpoint.ts";
import type { HelperSpec } from "./file-source.ts";
import type { HelperRunOptions } from "./helper-source.ts";
import { createCredentialProvider, describeCredentialStatus, type ProviderDeps } from "./provider.ts";
import { Secret } from "./secret.ts";
import { CredentialError, type CredentialProvider, type CredentialTarget } from "./types.ts";

const PLANT = "hubber-planted-secret-7f3a9c";
const ROUTER: CredentialTarget = { endpoint: parseEndpoint("https://router.corp.example/llm"), scheme: "bearer" };
const PUBLIC: CredentialTarget = { endpoint: parseEndpoint(ANTHROPIC_ENDPOINT), scheme: "x-api-key" };
const ROUTER_ADDRESS = ROUTER.endpoint.href;
const ROUTER_SHELL = { ANTHROPIC_BASE_URL: ROUTER_ADDRESS, ANTHROPIC_AUTH_TOKEN: "token-from-environment" };
// Run by a stand-in in most tests; the program only has to pass the check of who can change it.
const HELPER_ENTRY = { [ROUTER_ADDRESS]: { helper: { command: ["/bin/echo"], ttlSeconds: 60 } } };

const sandbox = mkdtempSync(join(tmpdir(), "hubber-credentials-provider-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const uid = process.getuid?.() ?? -1;

function secret(value: string): Secret {
  const parsed = Secret.parse(value);
  if (typeof parsed === "string") throw new Error(`Not accepted as a secret: ${parsed}`);
  return parsed;
}

function writeCredentials(path: string, endpoints: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify({ version: 1, endpoints }));
  chmodSync(path, 0o600);
}

let counter = 0;
/** The path of a credentials file with these entries; without entries, a path where there is no file. */
function credentialsFile(endpoints?: Record<string, unknown>): string {
  const path = join(sandbox, `credentials-${++counter}.json`);
  if (endpoints !== undefined) writeCredentials(path, endpoints);
  return path;
}

interface Setup extends Partial<ProviderDeps> {
  /** Entries of the credentials file. Left out, there is no file at the path the provider is given. */
  endpoints?: Record<string, unknown>;
}

/** A provider for the router, told where its credentials file is, or would be. */
function provider({ endpoints, env, ...deps }: Setup = {}): CredentialProvider & { file: string } {
  const file = credentialsFile(endpoints);
  const credentials = createCredentialProvider(ROUTER, {
    env: { HUBBER_CREDENTIALS_FILE: file, ...env },
    uid,
    forbiddenRoots: [],
    ...deps,
  });
  return Object.assign(credentials, { file });
}

/** A helper that hands out helper-token-1, helper-token-2, … and takes a while, like one that asks a server. */
function countingHelper(delayMs = 30) {
  const state = { runs: 0, fail: false, repeat: false, seen: [] as HelperRunOptions[] };
  const run = async (_spec: HelperSpec, options: HelperRunOptions) => {
    state.runs++;
    state.seen.push(options);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (state.fail) throw new CredentialError("Polecenie pomocnicze zakończyło się kodem 1.");
    return secret(`helper-token-${state.repeat ? "same" : state.runs}`);
  };
  return { state, run };
}

const reveal = async (value: Promise<Secret | null>) => (await value)?.reveal() ?? null;

/** A home directory with a credentials file for the router in the default place. */
function homeWithCredentials(): { home: string; file: string } {
  const home = join(sandbox, `home-${++counter}`);
  mkdirSync(join(home, ".config", "hubber"), { recursive: true });
  const file = join(home, ".config", "hubber", "credentials.json");
  writeCredentials(file, { [ROUTER_ADDRESS]: { authToken: "token-from-the-default-file" } });
  return { home, file };
}

describe("order of the sources", () => {
  it("uses the environment first and does not open the file then", async () => {
    const credentials = provider({ env: ROUTER_SHELL });
    // Reading this file would be an error: it is not JSON and it is open to everyone.
    writeFileSync(credentials.file, "{ not json");
    chmodSync(credentials.file, 0o644);

    expect(await reveal(credentials.get())).toBe("token-from-environment");
    expect(credentials.status()).toEqual({ available: true, source: "env", variable: "ANTHROPIC_AUTH_TOKEN" });
  });

  it("falls back to the static value of the file", async () => {
    const credentials = provider({ endpoints: { [ROUTER_ADDRESS]: { authToken: "token-from-the-file" } } });

    expect(await reveal(credentials.get())).toBe("token-from-the-file");
    expect(credentials.status()).toEqual({ available: true, source: "file", file: credentials.file });
  });

  it("falls back to the helper command of the file, which status() never runs", async () => {
    const helper = countingHelper();
    const credentials = provider({
      endpoints: { [ROUTER_ADDRESS]: { helper: { command: ["/bin/echo", "--audience", "llm"] } } },
      runHelper: helper.run,
    });

    // The program alone: its arguments are not for the terminal.
    expect(credentials.status()).toEqual({
      available: true,
      source: "helper",
      file: credentials.file,
      program: "/bin/echo",
    });
    expect(helper.state.runs).toBe(0);
    expect(await reveal(credentials.get())).toBe("helper-token-1");
  });

  it("leaves the file alone when the environment's value for this endpoint cannot be sent", async () => {
    const credentials = provider({
      env: { ...ROUTER_SHELL, ANTHROPIC_AUTH_TOKEN: `Bearer ${PLANT}` },
      endpoints: { [ROUTER_ADDRESS]: { authToken: "token-from-the-file" } },
    });
    const message =
      "Poświadczenie w zmiennej ANTHROPIC_AUTH_TOKEN zaczyna się od słowa „Bearer”; podaj sam token, aplikacja dopisuje to słowo sama.";

    expect(credentials.status()).toEqual({ available: false, message });
    await expect(credentials.get()).rejects.toThrow(message);
  });

  it("takes the default file from the home directory that the environment names", async () => {
    const { home, file } = homeWithCredentials();
    const credentials = createCredentialProvider(ROUTER, { env: { HOME: home }, uid, forbiddenRoots: [] });

    expect(await reveal(credentials.get())).toBe("token-from-the-default-file");
    expect(credentials.status()).toEqual({ available: true, source: "file", file });
  });

  it("says what it checked when nothing has a credential", async () => {
    const credentials = provider({ env: { ANTHROPIC_API_KEY: "personal-key-000000" } });
    const message = [
      "Brak poświadczeń dla endpointu https://router.corp.example/llm.",
      "Sprawdzone po kolei:",
      "  1. środowisko: zmienna ANTHROPIC_AUTH_TOKEN nie jest ustawiona (ustawiona jest ANTHROPIC_API_KEY, ale ten workspace wysyła token w nagłówku Authorization);",
      `  2. plik poświadczeń: plik "${credentials.file}" nie istnieje.`,
      'Ustaw zmienne ANTHROPIC_AUTH_TOKEN i ANTHROPIC_BASE_URL=https://router.corp.example/llm albo dodaj do pliku poświadczeń wpis dla tego endpointu z polem "authToken" lub "helper". Opis: README, rozdział „Poświadczenia”.',
    ].join("\n");

    expect(credentials.status()).toEqual({ available: false, message });
    await expect(credentials.get()).rejects.toThrow(CredentialError);
    await expect(credentials.get()).rejects.toThrow(message);
  });

  it("says for the public API that the key needs no base address", () => {
    // No HOME and no HUBBER_CREDENTIALS_FILE: there is no file to look into either.
    const credentials = createCredentialProvider(PUBLIC, { env: {}, uid, forbiddenRoots: [] });

    expect(credentials.status()).toEqual({
      available: false,
      message: [
        "Brak poświadczeń dla endpointu https://api.anthropic.com.",
        "Sprawdzone po kolei:",
        "  1. środowisko: zmienna ANTHROPIC_API_KEY nie jest ustawiona;",
        "  2. plik poświadczeń: nie ma domyślnego pliku, bo zmienna HOME nie jest ustawiona; plik wskażesz zmienną HUBBER_CREDENTIALS_FILE.",
        'Ustaw zmienną ANTHROPIC_API_KEY (bez ANTHROPIC_BASE_URL) albo dodaj do pliku poświadczeń wpis dla tego endpointu z polem "apiKey" lub "helper". Opis: README, rozdział „Poświadczenia”.',
      ].join("\n"),
    });
  });

  it("names the endpoint the environment's token belongs to, and the entry the file lacks", () => {
    const credentials = provider({
      env: { ANTHROPIC_AUTH_TOKEN: PLANT },
      endpoints: { "https://other.example": { authToken: "token-of-another-endpoint" } },
    });

    const status = credentials.status();

    expect(status.available).toBe(false);
    expect(status).toMatchObject({
      message: expect.stringContaining(
        [
          "  1. środowisko: zmienna ANTHROPIC_AUTH_TOKEN jest ustawiona, ale bez ANTHROPIC_BASE_URL należy do https://api.anthropic.com, a nie do tego endpointu;",
          `  2. plik poświadczeń: plik "${credentials.file}" nie ma wpisu dla endpointu https://router.corp.example/llm.`,
        ].join("\n"),
      ),
    });
    expect(JSON.stringify(status)).not.toContain(PLANT);
  });

  it("does not guess at a credentials file that is named by a relative path, nor read the default one instead", () => {
    const credentials = createCredentialProvider(ROUTER, {
      env: { HOME: homeWithCredentials().home, HUBBER_CREDENTIALS_FILE: "credentials.json" },
      uid,
      forbiddenRoots: [],
    });

    expect(credentials.status()).toMatchObject({
      available: false,
      message: expect.stringContaining(
        '  2. plik poświadczeń: zmienna HUBBER_CREDENTIALS_FILE nie zawiera pełnej ścieżki pliku (od "/" albo "~/").',
      ),
    });
  });

  it("reports what is wrong with the file instead of a missing credential", async () => {
    const credentials = provider({ endpoints: { [ROUTER_ADDRESS]: { authToken: PLANT } } });
    chmodSync(credentials.file, 0o644);
    const message = `Plik poświadczeń "${credentials.file}" jest dostępny dla innych użytkowników (uprawnienia 644). Ogranicz je poleceniem "chmod 600 ${credentials.file}".`;

    expect(credentials.status()).toEqual({ available: false, message });
    await expect(credentials.get()).rejects.toThrow(message);
  });

  it("keeps the file out of the directories it is told about", () => {
    const credentials = provider({
      endpoints: { [ROUTER_ADDRESS]: { authToken: PLANT } },
      forbiddenRoots: [sandbox],
    });

    expect(credentials.status()).toMatchObject({
      available: false,
      message: expect.stringContaining("Poświadczenia muszą leżeć poza repozytorium i poza katalogiem workspace'u"),
    });
  });

  it("picks up a file that appears later, without a restart", async () => {
    const credentials = provider();
    await expect(credentials.get()).rejects.toThrow(CredentialError);

    writeCredentials(credentials.file, { [ROUTER_ADDRESS]: { authToken: "token-added-later" } });

    expect(await reveal(credentials.get())).toBe("token-added-later");
    expect(credentials.status().available).toBe(true);
  });
});

describe("cache and refresh", () => {
  it("keeps the helper's value for its lifetime and runs the command again after it", async () => {
    let clock = 1_000_000;
    const helper = countingHelper(0);
    const credentials = provider({ endpoints: HELPER_ENTRY, runHelper: helper.run, now: () => clock });

    expect(await reveal(credentials.get())).toBe("helper-token-1");
    clock += 59_999;
    expect(await reveal(credentials.get())).toBe("helper-token-1");
    expect(helper.state.runs).toBe(1);
    clock += 1;
    expect(await reveal(credentials.get())).toBe("helper-token-2");
    expect(helper.state.runs).toBe(2);
  });

  it("keeps a static value and a value of the environment for as long as nothing refuses them", async () => {
    let clock = 1_000_000;
    const fromFile = provider({
      endpoints: { [ROUTER_ADDRESS]: { authToken: "token-from-the-file" } },
      now: () => clock,
    });
    const fromEnvironment = provider({ env: ROUTER_SHELL, now: () => clock });
    await fromFile.get();
    await fromEnvironment.get();

    clock += 365 * 24 * 60 * 60 * 1000;
    // Not read again: the file may be gone by now.
    rmSync(fromFile.file);

    expect(await reveal(fromFile.get())).toBe("token-from-the-file");
    expect(await reveal(fromEnvironment.get())).toBe("token-from-environment");
  });

  it("runs the command once for requests that arrive together", async () => {
    const helper = countingHelper();
    const credentials = provider({ endpoints: HELPER_ENTRY, runHelper: helper.run });

    const values = await Promise.all(Array.from({ length: 5 }, () => reveal(credentials.get())));

    expect(values).toEqual(Array.from({ length: 5 }, () => "helper-token-1"));
    expect(helper.state.runs).toBe(1);
  });

  it("runs the command once when two requests are rejected with the same value", async () => {
    const helper = countingHelper();
    const credentials = provider({ endpoints: HELPER_ENTRY, runHelper: helper.run });
    const first = await credentials.get();

    const renewed = await Promise.all([credentials.renew(first), credentials.renew(first)]);

    expect(renewed.map((value) => value?.reveal())).toEqual(["helper-token-2", "helper-token-2"]);
    expect(helper.state.runs).toBe(2);
  });

  it("gives a request that comes back late with an old value the new one, without a run", async () => {
    const helper = countingHelper();
    const credentials = provider({ endpoints: HELPER_ENTRY, runHelper: helper.run });
    const first = await credentials.get();
    await credentials.renew(first);

    expect(await reveal(credentials.renew(first))).toBe("helper-token-2");
    expect(helper.state.runs).toBe(2);
  });

  it("makes a request that starts during a renewal wait for it instead of sending the old value", async () => {
    const helper = countingHelper();
    const credentials = provider({ endpoints: HELPER_ENTRY, runHelper: helper.run });
    const first = await credentials.get();

    const renewal = credentials.renew(first);
    const meanwhile = credentials.get();

    expect(await reveal(meanwhile)).toBe("helper-token-2");
    expect(await reveal(renewal)).toBe("helper-token-2");
    expect(helper.state.runs).toBe(2);
  });

  it("returns null when the source has nothing newer", async () => {
    const fromEnvironment = provider({ env: ROUTER_SHELL });
    const helper = countingHelper(0);
    helper.state.repeat = true;
    const fromHelper = provider({ endpoints: HELPER_ENTRY, runHelper: helper.run });

    expect(await fromEnvironment.renew(await fromEnvironment.get())).toBeNull();
    // The command is run again whatever the lifetime, and prints what it printed before.
    expect(await fromHelper.renew(await fromHelper.get())).toBeNull();
    expect(helper.state.runs).toBe(2);
  });

  it("reads the file again after a rejection, so an edited file needs no restart", async () => {
    const credentials = provider({ endpoints: { [ROUTER_ADDRESS]: { authToken: "token-before-edit" } } });
    const before = await credentials.get();
    expect(await credentials.renew(before)).toBeNull();

    writeCredentials(credentials.file, { [ROUTER_ADDRESS]: { authToken: "token-after-edit" } });

    expect(await reveal(credentials.renew(before))).toBe("token-after-edit");
    expect(await reveal(credentials.get())).toBe("token-after-edit");
  });

  it("keeps the value at hand when the command fails at the end of the lifetime, until a 401 says otherwise", async () => {
    let clock = 1_000_000;
    const helper = countingHelper(0);
    const credentials = provider({ endpoints: HELPER_ENTRY, runHelper: helper.run, now: () => clock });
    const first = await credentials.get();
    clock += 61_000;
    helper.state.fail = true;

    // The lifetime is an estimate: the old value may still be good.
    expect(await reveal(credentials.get())).toBe("helper-token-1");
    expect(await reveal(credentials.get())).toBe("helper-token-1");
    // The failing command is not started again within the pause.
    expect(helper.state.runs).toBe(2);

    // The endpoint refuses the old value: now the failure is the caller's to see.
    clock += 11_000;
    await expect(credentials.renew(first)).rejects.toThrow("zakończyło się kodem 1");
    expect(helper.state.runs).toBe(3);
  });

  it("does not keep the value at hand when the file itself has become unusable by then", async () => {
    let clock = 1_000_000;
    const helper = countingHelper(0);
    const credentials = provider({ endpoints: HELPER_ENTRY, runHelper: helper.run, now: () => clock });
    await credentials.get();
    clock += 61_000;

    // Whoever took the entry out of the file meant the credential to be out of use.
    writeCredentials(credentials.file, {});

    await expect(credentials.get()).rejects.toThrow(`plik "${credentials.file}" nie ma wpisu dla endpointu`);
  });

  it("gives every caller that waited for a failed run at the end of the lifetime the value at hand", async () => {
    let clock = 1_000_000;
    const helper = countingHelper();
    const credentials = provider({ endpoints: HELPER_ENTRY, runHelper: helper.run, now: () => clock });
    await credentials.get();
    clock += 61_000;
    helper.state.fail = true;

    const values = await Promise.all(Array.from({ length: 3 }, () => reveal(credentials.get())));

    expect(values).toEqual(["helper-token-1", "helper-token-1", "helper-token-1"]);
    expect(helper.state.runs).toBe(2);
  });

  it("does not hand out a value that the endpoint refused when the command then fails", async () => {
    const helper = countingHelper();
    const credentials = provider({ endpoints: HELPER_ENTRY, runHelper: helper.run });
    const first = await credentials.get();
    helper.state.fail = true;

    const renewal = credentials.renew(first);
    const meanwhile = credentials.get();

    await expect(renewal).rejects.toThrow("zakończyło się kodem 1");
    await expect(meanwhile).rejects.toThrow("zakończyło się kodem 1");
  });

  it("does not hand out a value that is refused while the run at the end of its lifetime is under way", async () => {
    let clock = 1_000_000;
    const helper = countingHelper();
    const credentials = provider({ endpoints: HELPER_ENTRY, runHelper: helper.run, now: () => clock });
    const first = await credentials.get();
    clock += 61_000;
    helper.state.fail = true;

    const atTheEndOfTheLifetime = credentials.get();
    const renewal = credentials.renew(first);

    await expect(renewal).rejects.toThrow("zakończyło się kodem 1");
    await expect(atTheEndOfTheLifetime).rejects.toThrow("zakończyło się kodem 1");
    expect(helper.state.runs).toBe(2);
  });

  it("leaves a failing command alone for a while instead of running it for every request", async () => {
    let clock = 1_000_000;
    const helper = countingHelper(0);
    helper.state.fail = true;
    const credentials = provider({ endpoints: HELPER_ENTRY, runHelper: helper.run, now: () => clock });

    await expect(credentials.get()).rejects.toThrow("zakończyło się kodem 1");
    clock += 9_999;
    await expect(credentials.get()).rejects.toThrow("zakończyło się kodem 1");
    expect(helper.state.runs).toBe(1);
    expect(credentials.status()).toEqual({
      available: false,
      message: "Polecenie pomocnicze zakończyło się kodem 1.",
    });

    clock += 1;
    helper.state.fail = false;
    expect(await reveal(credentials.get())).toBe("helper-token-2");
    expect(credentials.status().available).toBe(true);
  });
});

describe("the helper command", () => {
  it("is handed the endpoint and an environment without the credentials the server was started with", async () => {
    const helper = countingHelper(0);
    const credentials = provider({
      endpoints: HELPER_ENTRY,
      runHelper: helper.run,
      // A personal key for the public API in the shell: not for this endpoint, and not for the command either.
      env: { PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "personal-key-000000", ANTHROPIC_LOG: "debug" },
    });

    await credentials.get();

    expect(helper.state.seen).toHaveLength(1);
    expect(helper.state.seen[0]?.endpoint).toBe(ROUTER_ADDRESS);
    expect(helper.state.seen[0]?.env).toEqual({ PATH: "/usr/bin:/bin", HUBBER_CREDENTIALS_FILE: credentials.file });
  });

  it("sees none of them when it is really run", async () => {
    const credentials = provider({
      endpoints: {
        [ROUTER_ADDRESS]: {
          helper: { command: ["/bin/sh", "-c", `echo "seen-$(env | grep -c '^ANTHROPIC_')-for-$HUBBER_ENDPOINT"`] },
        },
      },
      env: { PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "personal-key-000000", ANTHROPIC_LOG: "debug" },
    });

    expect(await reveal(credentials.get())).toBe(`seen-0-for-${ROUTER_ADDRESS}`);
  });

  it("is started once for two requests at the same time, also after both are rejected", async () => {
    const log = join(sandbox, "runs.log");
    const script = join(sandbox, "token.sh");
    writeFileSync(
      script,
      `#!/bin/sh\necho run >> "${log}"\nsleep 0.2\necho "real-helper-token-$(wc -l < "${log}" | tr -d ' ')"\n`,
    );
    chmodSync(script, 0o700);
    appendFileSync(log, "");
    const credentials = provider({
      endpoints: { [ROUTER_ADDRESS]: { helper: { command: [script] } } },
      env: { PATH: "/usr/bin:/bin" },
    });

    const [a, b] = await Promise.all([credentials.get(), credentials.get()]);
    const renewed = await Promise.all([credentials.renew(a), credentials.renew(b)]);

    expect([a.reveal(), b.reveal()]).toEqual(["real-helper-token-1", "real-helper-token-1"]);
    expect(renewed.map((value) => value?.reveal())).toEqual(["real-helper-token-2", "real-helper-token-2"]);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("is ended by close(), and not started after it", async () => {
    let clock = 1_000_000;
    const marker = join(sandbox, "started-by-the-helper");
    const credentials = provider({
      endpoints: { [ROUTER_ADDRESS]: { helper: { command: ["/bin/sh", "-c", `touch "${marker}"; sleep 30`] } } },
      env: { PATH: "/usr/bin:/bin" },
      now: () => clock,
    });
    const started = performance.now();
    const waiting = credentials.get();
    // Long enough for the command to be under way.
    await new Promise((resolve) => setTimeout(resolve, 300));

    credentials.close();

    await expect(waiting).rejects.toThrow('Polecenie pomocnicze "/bin/sh" zostało przerwane, bo serwer kończy pracę.');
    // Well before the command would have ended by itself.
    expect(performance.now() - started).toBeLessThan(10_000);

    // Past the pause after a failed run, so that the provider would start the command again.
    clock += 11_000;
    rmSync(marker, { force: true });
    await expect(credentials.get()).rejects.toThrow(
      'Polecenie pomocnicze "/bin/sh" nie zostało uruchomione, bo serwer kończy pracę.',
    );
    expect(existsSync(marker)).toBe(false);
  });
});

describe("what the provider shows of itself", () => {
  it("never the value: not in status(), JSON or inspect()", async () => {
    const credentials = provider({ endpoints: { [ROUTER_ADDRESS]: { authToken: PLANT } } });
    await credentials.get();

    const shown = [
      JSON.stringify(credentials),
      JSON.stringify(credentials.status()),
      inspect(credentials, { depth: 8, showHidden: true }),
    ];

    for (const text of shown) expect(text).not.toContain(PLANT);
  });

  it("removes every value it handed out from a text", async () => {
    const helper = countingHelper(0);
    const credentials = provider({ endpoints: HELPER_ENTRY, runHelper: helper.run });
    await credentials.renew(await credentials.get());

    expect(credentials.redact('401 {"error":{"message":"invalid token helper-token-1, also helper-token-2"}}')).toBe(
      '401 {"error":{"message":"invalid token [ukryte], also [ukryte]"}}',
    );
  });

  it("remembers the last sixteen values for that", async () => {
    const helper = countingHelper(0);
    const credentials = provider({ endpoints: HELPER_ENTRY, runHelper: helper.run });
    let value = await credentials.get();
    for (let run = 2; run <= 17; run++) value = (await credentials.renew(value)) ?? value;

    // Padded, so that no token is the beginning of another one.
    const text = Array.from({ length: 17 }, (_, index) => `<helper-token-${index + 1}>`).join(" ");

    expect(credentials.redact(text)).toBe(
      ["<helper-token-1>", ...Array.from({ length: 16 }, () => "<[ukryte]>")].join(" "),
    );
  });
});

describe("describeCredentialStatus", () => {
  it("names the source, never the value", () => {
    expect(describeCredentialStatus({ available: true, source: "env", variable: "ANTHROPIC_AUTH_TOKEN" })).toBe(
      "Poświadczenia: zmienna ANTHROPIC_AUTH_TOKEN.",
    );
    expect(
      describeCredentialStatus({ available: true, source: "file", file: "/Users/x/.config/hubber/credentials.json" }),
    ).toBe('Poświadczenia: plik "/Users/x/.config/hubber/credentials.json".');
    expect(
      describeCredentialStatus({
        available: true,
        source: "helper",
        file: "/Users/x/.config/hubber/credentials.json",
        program: "/usr/local/bin/llm-token",
      }),
    ).toBe(
      'Poświadczenia: polecenie pomocnicze "/usr/local/bin/llm-token" (z pliku "/Users/x/.config/hubber/credentials.json").',
    );
  });
});
