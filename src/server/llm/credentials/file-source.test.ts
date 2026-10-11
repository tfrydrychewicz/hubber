import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ANTHROPIC_ENDPOINT, parseEndpoint } from "../endpoint.ts";
import { credentialsFilePath, type FileDeps, readFileCredential } from "./file-source.ts";
import { CredentialError, type CredentialTarget } from "./types.ts";

const PLANT = "hubber-planted-secret-7f3a9c";
const ROUTER: CredentialTarget = { endpoint: parseEndpoint("https://router.corp.example/llm"), scheme: "bearer" };
const PUBLIC: CredentialTarget = { endpoint: parseEndpoint(ANTHROPIC_ENDPOINT), scheme: "x-api-key" };
const ROUTER_ADDRESS = ROUTER.endpoint.href;

const sandbox = mkdtempSync(join(tmpdir(), "hubber-credentials-file-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const uid = process.getuid?.() ?? -1;
const deps: FileDeps = { uid, forbiddenRoots: [] };

let counter = 0;
/** A credentials file with this text, private to the user unless a mode says otherwise. */
function file(text: string, mode = 0o600): string {
  const path = join(sandbox, `credentials-${++counter}.json`);
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}

const entries = (endpoints: Record<string, unknown>) => JSON.stringify({ version: 1, endpoints });

/** A credentials file whose entry for the router is the given one. */
const routerEntry = (entry: unknown) => file(entries({ [ROUTER_ADDRESS]: entry }));

/** The message of the CredentialError that the read ends with. No message may repeat the planted secret. */
function refusal(path: string, target = ROUTER, fileDeps = deps): string {
  try {
    readFileCredential(path, target, fileDeps);
  } catch (error) {
    if (!(error instanceof CredentialError)) throw error;
    expect(error.message).not.toMatch(/planted|7f3a9c/);
    return error.message;
  }
  throw new Error("readFileCredential did not throw");
}

function staticValue(path: string, target = ROUTER, fileDeps = deps): string {
  const lookup = readFileCredential(path, target, fileDeps);
  if (lookup.kind !== "static") throw new Error(`Expected a static value, got "${lookup.kind}"`);
  return lookup.secret.reveal();
}

describe("credentialsFilePath", () => {
  it("is under the home directory that the environment names", () => {
    expect(credentialsFilePath({ HOME: "/Users/x" })).toEqual({ path: "/Users/x/.config/hubber/credentials.json" });
  });

  it("is the file that HUBBER_CREDENTIALS_FILE names, with or without a home directory", () => {
    expect(credentialsFilePath({ HOME: "/Users/x", HUBBER_CREDENTIALS_FILE: "/secrets/hubber.json" })).toEqual({
      path: "/secrets/hubber.json",
    });
    expect(credentialsFilePath({ HUBBER_CREDENTIALS_FILE: "/secrets/hubber.json" })).toEqual({
      path: "/secrets/hubber.json",
    });
    expect(credentialsFilePath({ HOME: "/Users/x", HUBBER_CREDENTIALS_FILE: "~/keys/hubber.json" })).toEqual({
      path: "/Users/x/keys/hubber.json",
    });
  });

  it.each(["", "  "])("counts HUBBER_CREDENTIALS_FILE of %j as not set", (blank) => {
    expect(credentialsFilePath({ HOME: "/Users/x", HUBBER_CREDENTIALS_FILE: blank })).toEqual({
      path: "/Users/x/.config/hubber/credentials.json",
    });
  });

  // A process that a test starts gets no HOME: it must not find the developer's own file.
  it.each([
    ["no HOME", {}],
    ["an empty HOME", { HOME: "" }],
    ["a relative HOME", { HOME: "home/x" }],
  ])("has no default file with %s", (_case, env) => {
    expect(credentialsFilePath(env)).toEqual({
      note: "nie ma domyślnego pliku, bo zmienna HOME nie jest ustawiona; plik wskażesz zmienną HUBBER_CREDENTIALS_FILE",
    });
  });

  it.each(["credentials.json", "./credentials.json", "~", "~other/credentials.json"])(
    "does not guess at the relative path %j",
    (relative) => {
      expect(credentialsFilePath({ HOME: "/Users/x", HUBBER_CREDENTIALS_FILE: relative })).toEqual({
        note: 'zmienna HUBBER_CREDENTIALS_FILE nie zawiera pełnej ścieżki pliku (od "/" albo "~/")',
      });
    },
  );

  it("says that a path under the home directory needs HOME", () => {
    expect(credentialsFilePath({ HUBBER_CREDENTIALS_FILE: "~/keys/hubber.json" })).toEqual({
      note: 'zmienna HUBBER_CREDENTIALS_FILE zaczyna się od znaku "~", który wymaga zmiennej HOME; podaj pełną ścieżkę pliku',
    });
  });
});

describe("readFileCredential", () => {
  it("serves several endpoints from one file, each under its own address", () => {
    const path = file(
      entries({
        "https://api.anthropic.com/": { apiKey: "key-for-the-public-api" },
        "https://Router.corp.example:443/llm": { authToken: PLANT },
      }),
    );

    expect(staticValue(path, ROUTER)).toBe(PLANT);
    expect(staticValue(path, PUBLIC)).toBe("key-for-the-public-api");
    expect(
      readFileCredential(path, { endpoint: parseEndpoint("https://other.example"), scheme: "bearer" }, deps),
    ).toEqual({ kind: "none", note: `plik "${path}" nie ma wpisu dla endpointu https://other.example` });
  });

  it("does not take an entry of another base path or host for the endpoint's own", () => {
    const path = file(
      entries({
        "https://router.corp.example": { authToken: "token-of-the-bare-host" },
        "https://router.corp.example/llm/v2": { authToken: "token-of-a-longer-path" },
        "https://router.corp.example.evil.example/llm": { authToken: "token-of-a-look-alike" },
      }),
    );

    expect(readFileCredential(path, ROUTER, deps).kind).toBe("none");
  });

  it("treats a missing file as an answer, not an error", () => {
    const missing = join(sandbox, "no-such-file.json");
    const underMissingDirectory = join(sandbox, "no-such-directory", "credentials.json");
    const underFile = join(file("{}"), "credentials.json");

    for (const path of [missing, underMissingDirectory, underFile]) {
      expect(readFileCredential(path, ROUTER, deps)).toEqual({ kind: "none", note: `plik "${path}" nie istnieje` });
    }
  });

  it.each([
    ["600", 0o600],
    ["400", 0o400],
  ])("accepts a file with mode %s", (_shown, mode) => {
    expect(staticValue(file(entries({ [ROUTER_ADDRESS]: { authToken: PLANT } }), mode))).toBe(PLANT);
  });

  it.each([
    ["640", 0o640],
    ["644", 0o644],
    ["660", 0o660],
    ["604", 0o604],
    ["666", 0o666],
    ["602", 0o602],
    ["610", 0o610],
  ])("refuses a file that others can use: mode %s", (shown, mode) => {
    const path = file(entries({ [ROUTER_ADDRESS]: { authToken: PLANT } }), mode);

    expect(refusal(path)).toBe(
      `Plik poświadczeń "${path}" jest dostępny dla innych użytkowników (uprawnienia ${shown}). Ogranicz je poleceniem "chmod 600 ${path}".`,
    );
  });

  it("says how to restore access to a file that its owner cannot read", () => {
    const path = file(entries({ [ROUTER_ADDRESS]: { authToken: PLANT } }), 0o000);

    expect(refusal(path)).toBe(
      `Nie można odczytać pliku poświadczeń "${path}": brak uprawnień. Plik musi należeć do ciebie; odczyt przywrócisz poleceniem "chmod 600 ${path}".`,
    );
  });

  it("follows a symbolic link and judges the file it leads to", () => {
    const text = entries({ [ROUTER_ADDRESS]: { authToken: PLANT } });
    const linkToPrivate = join(sandbox, "link-to-private.json");
    const linkToOpen = join(sandbox, "link-to-open.json");
    symlinkSync(file(text, 0o600), linkToPrivate);
    symlinkSync(file(text, 0o644), linkToOpen);

    expect(staticValue(linkToPrivate)).toBe(PLANT);
    expect(refusal(linkToOpen)).toContain("jest dostępny dla innych użytkowników (uprawnienia 644)");
  });

  it("refuses a directory", () => {
    const directory = join(sandbox, "a-directory.json");
    mkdirSync(directory, { mode: 0o700 });

    expect(refusal(directory)).toBe(`"${directory}" nie jest zwykłym plikiem, więc nie może być plikiem poświadczeń.`);
  });

  it("refuses a named pipe without waiting for someone to write to it", () => {
    const pipe = join(sandbox, "a-pipe.json");
    execFileSync("/usr/bin/mkfifo", ["-m", "600", pipe]);

    // A plain open would block here until the test run is killed.
    expect(refusal(pipe)).toBe(`"${pipe}" nie jest zwykłym plikiem, więc nie może być plikiem poświadczeń.`);
  });

  it("refuses a file that belongs to another user", () => {
    const path = file(entries({ [ROUTER_ADDRESS]: { authToken: PLANT } }));

    expect(refusal(path, ROUTER, { ...deps, uid: uid + 1 })).toBe(
      `Plik poświadczeń "${path}" należy do innego użytkownika. Aplikacja czyta tylko plik, którego właścicielem jesteś ty.`,
    );
  });

  it("refuses a file inside the repository or the workspace, also when a link leads there", () => {
    const repository = join(sandbox, "repository");
    mkdirSync(join(repository, "nested"), { recursive: true });
    mkdirSync(join(repository, "nest"));
    const inside = join(repository, "nested", "credentials.json");
    writeFileSync(inside, entries({ [ROUTER_ADDRESS]: { authToken: PLANT } }), { mode: 0o600 });
    const link = join(sandbox, "link-into-the-repository.json");
    symlinkSync(inside, link);
    const forbidden = { ...deps, forbiddenRoots: [join(sandbox, "another-directory"), repository] };

    for (const path of [inside, link]) {
      expect(refusal(path, ROUTER, forbidden)).toBe(
        `Plik poświadczeń "${path}" leży w katalogu "${repository}". Poświadczenia muszą leżeć poza repozytorium i poza katalogiem workspace'u; przenieś plik, na przykład do "~/.config/hubber/credentials.json".`,
      );
    }
    // A directory whose name only begins the same is another directory.
    expect(staticValue(inside, ROUTER, { ...deps, forbiddenRoots: [join(repository, "nest")] })).toBe(PLANT);
  });

  describe("inside a directory that is spelled another way", () => {
    // One directory for the whole block, with a name that has capitals and letters outside ASCII
    // to spell differently, and a second name that is a link to it.
    const workspace = join(sandbox, "Workspace-Żółty");
    const inside = join(workspace, "nested", "credentials.json");
    const linked = join(sandbox, "link-to-the-workspace");
    mkdirSync(dirname(inside), { recursive: true });
    writeFileSync(inside, entries({ [ROUTER_ADDRESS]: { authToken: PLANT } }), { mode: 0o600 });
    symlinkSync(workspace, linked);

    /** The same place with one part of the path written differently. */
    const respelled = (path: string, spell: (name: string) => string) =>
      path.replace(basename(workspace), spell(basename(workspace)));
    /** Whether the volume takes the two paths for one directory, as the volumes of macOS do by default. */
    const isOneDirectory = (one: string, other: string) =>
      existsSync(other) && statSync(one).ino === statSync(other).ino && statSync(one).dev === statSync(other).dev;
    const shouted = (name: string) => name.toUpperCase();
    const decomposed = (name: string) => name.normalize("NFD");
    // Where the system volume and the data volume of macOS are joined, every path has this second one.
    // It is built on the real path: /var and /tmp are links at the root, and the data volume has no such links.
    const DATA_VOLUME = "/System/Volumes/Data";
    const onDataVolume = (path: string) => path.replace(workspace, `${DATA_VOLUME}${realpathSync(workspace)}`);

    const refusedFor = (path: string, root: string) =>
      `Plik poświadczeń "${path}" leży w katalogu "${root}". Poświadczenia muszą leżeć poza repozytorium i poza katalogiem workspace'u; przenieś plik, na przykład do "~/.config/hubber/credentials.json".`;

    for (const [spelling, spell] of [
      ["in other letter case", shouted],
      ["in another Unicode form", decomposed],
    ] as const) {
      // On a volume that tells the two spellings apart they are two places, and there is nothing to refuse.
      const applies = isOneDirectory(workspace, respelled(workspace, spell));

      it.skipIf(!applies)(`refuses the file when its path is typed ${spelling}`, () => {
        const typed = respelled(inside, spell);
        expect(typed).not.toBe(inside);

        expect(refusal(typed, ROUTER, { ...deps, forbiddenRoots: [workspace] })).toBe(refusedFor(typed, workspace));
      });

      it.skipIf(!applies)(`refuses the file when the directory is named ${spelling}`, () => {
        const root = respelled(workspace, spell);
        expect(root).not.toBe(workspace);

        expect(refusal(inside, ROUTER, { ...deps, forbiddenRoots: [root] })).toBe(refusedFor(inside, root));
      });
    }

    it("refuses the file when the directory or the file is named through a link to the directory", () => {
      const throughLink = join(linked, "nested", "credentials.json");

      expect(refusal(inside, ROUTER, { ...deps, forbiddenRoots: [linked] })).toBe(refusedFor(inside, linked));
      expect(refusal(throughLink, ROUTER, { ...deps, forbiddenRoots: [workspace] })).toBe(
        refusedFor(throughLink, workspace),
      );
    });

    // The system gives such a path back as it was typed, so comparing paths, however real, is not enough.
    it.skipIf(!isOneDirectory(workspace, onDataVolume(workspace)))(
      "refuses the file when either is named by its second path on the data volume of macOS",
      () => {
        const typed = onDataVolume(inside);
        const root = onDataVolume(workspace);

        expect(refusal(typed, ROUTER, { ...deps, forbiddenRoots: [workspace] })).toBe(refusedFor(typed, workspace));
        expect(refusal(inside, ROUTER, { ...deps, forbiddenRoots: [root] })).toBe(refusedFor(inside, root));
      },
    );

    it("still reads a file beside the directory, however the two are spelled", () => {
      const beside = file(entries({ [ROUTER_ADDRESS]: { authToken: PLANT } }));
      const roots = [workspace, linked, respelled(workspace, shouted), join(sandbox, "no-such-directory")];

      expect(staticValue(beside, ROUTER, { ...deps, forbiddenRoots: roots })).toBe(PLANT);
    });
  });

  it("refuses a file that has a second name, wherever that name is", () => {
    const workspace = join(sandbox, "workspace-with-a-hard-link");
    mkdirSync(workspace);
    const inside = join(workspace, "credentials.json");
    writeFileSync(inside, entries({ [ROUTER_ADDRESS]: { authToken: PLANT } }), { mode: 0o600 });
    // The same bytes under a path outside the workspace: no path of this name leads into it.
    const outside = join(sandbox, "hard-link-to-the-inside.json");
    linkSync(inside, outside);

    expect(refusal(outside, ROUTER, { ...deps, forbiddenRoots: [workspace] })).toBe(
      `Plik poświadczeń "${outside}" ma więcej niż jedną nazwę (dowiązania twarde: 2), więc jego treść leży także w miejscu, którego aplikacja nie zna. Utwórz plik na nowo pod jedną nazwą, poza repozytorium i poza katalogiem workspace'u.`,
    );
    // Without a forbidden directory as well: the other name may be in a place nobody listed.
    expect(refusal(outside)).toContain("ma więcej niż jedną nazwę (dowiązania twarde: 2)");
  });

  // On macOS a descriptor has a path that opens the file and names no place. Asked where it
  // leads, the system answers with "/dev/fd/" and the name of the file. That is a path that does
  // not exist, or the path of another descriptor of the process when the file is called "1", or
  // the descriptor's own path when the file is called by its number: and that one has the inode
  // of the file, on the device of /dev/fd.
  it.skipIf(process.platform !== "darwin").each<[string, (descriptor: number) => string, string]>([
    ["a path that does not exist", () => "credentials.json", " (ENOENT)"],
    ["the path of another file", () => "1", ""],
    ["a path with the inode of the file on another device", (descriptor) => String(descriptor), ""],
  ])(
    "refuses a file that is named by an open descriptor, for which the system answers with %s",
    (_case, named, code) => {
      const workspace = join(sandbox, `workspace-behind-a-descriptor-${++counter}`);
      mkdirSync(workspace);
      // A file that is named after the number its descriptor is about to get. The number is the
      // one that was free a moment ago; should something else have taken it meanwhile, once more.
      const open = (attemptsLeft = 5): number => {
        const next = openSync(workspace, "r");
        closeSync(next);
        const inside = join(workspace, named(next));
        writeFileSync(inside, entries({ [ROUTER_ADDRESS]: { authToken: PLANT } }), { mode: 0o600 });
        const descriptor = openSync(inside, "r");
        if (descriptor === next) return descriptor;
        closeSync(descriptor);
        rmSync(inside);
        if (attemptsLeft === 0)
          throw new Error("No descriptor number stayed free for long enough to name a file after it");
        return open(attemptsLeft - 1);
      };
      const descriptor = open();
      try {
        const typed = `/dev/fd/${descriptor}`;

        // Not read on the chance that the place is a good one: here it is the forbidden directory.
        expect(refusal(typed, ROUTER, { ...deps, forbiddenRoots: [workspace] })).toBe(
          `Nie można ustalić, w którym katalogu leży plik poświadczeń "${typed}"${code}, więc nie wiadomo, czy leży poza repozytorium i poza katalogiem workspace'u. Wskaż plik jego zwykłą ścieżką.`,
        );
      } finally {
        closeSync(descriptor);
      }
    },
  );

  it("refuses a file that is too large to be a credentials file", () => {
    const path = file(" ".repeat(1024 * 1024 + 1));

    expect(refusal(path)).toBe(`Plik poświadczeń "${path}" jest większy niż 1 MB, więc to nie jest plik poświadczeń.`);
  });

  it("never quotes the file in a message about its syntax", () => {
    // The parser's own message for this text repeats the first characters of the unquoted value.
    const unquoted = file(`{ "version": 1, "endpoints": { "${ROUTER_ADDRESS}": { "authToken": ${PLANT} } } }`);
    // Where the parser reports a position instead of a quotation, the position is passed on.
    const lines = [
      "{",
      '  "version": 1,',
      `  "endpoints": { "${ROUTER_ADDRESS}": { "authToken": "${PLANT}" "x": 1 } }`,
      "}",
    ];
    const misplaced = file(lines.join("\n"));
    const column = (lines[2]?.indexOf('"x"') ?? 0) + 1;

    expect(refusal(unquoted)).toBe(`Plik poświadczeń "${unquoted}" nie jest poprawnym JSON-em.`);
    expect(refusal(misplaced)).toBe(
      `Plik poświadczeń "${misplaced}" nie jest poprawnym JSON-em (wiersz 3, kolumna ${column}).`,
    );
  });

  it("reads a file that an editor began with a byte order mark", () => {
    expect(staticValue(file(`\uFEFF${entries({ [ROUTER_ADDRESS]: { authToken: PLANT } })}`))).toBe(PLANT);
  });

  it.each([
    ["no version", JSON.stringify({ endpoints: {} })],
    ["another version", JSON.stringify({ version: 2, endpoints: {} })],
    ["no endpoints", JSON.stringify({ version: 1 })],
    ["a list of endpoints", JSON.stringify({ version: 1, endpoints: [] })],
    ["a list", JSON.stringify([PLANT])],
    ["a text", JSON.stringify(PLANT)],
  ])("refuses a file of another layout: %s", (_case, text) => {
    const path = file(text);

    expect(refusal(path)).toBe(
      `Plik poświadczeń "${path}" ma nieznany układ. Oczekiwany: {"version": 1, "endpoints": {"<adres endpointu>": {...}}}.`,
    );
  });

  it.each([
    ["a credential pasted in the place of an address", PLANT, "to nie jest pełny adres w postaci https://host/ścieżka"],
    [
      "an address with a password",
      `https://user:${PLANT}@router.corp.example`,
      "adres zawiera nazwę użytkownika lub hasło",
    ],
    ["an address with a query string", `https://router.corp.example/?key=${PLANT}`, 'adres zawiera znak "?" lub "#"'],
    [
      "an address in the clear",
      "http://router.corp.example",
      "adres używa nieszyfrowanego http://, dozwolonego tylko dla tego komputera (127.0.0.1, localhost)",
    ],
  ])("says which key is not an endpoint address, without repeating it: %s", (_case, key, reason) => {
    const path = file(
      entries({ [ROUTER_ADDRESS]: { authToken: "token-000000000" }, [key]: { authToken: "token-000000000" } }),
    );

    expect(refusal(path)).toBe(
      `W pliku poświadczeń "${path}" klucz nr 2 w "endpoints" nie nadaje się na adres endpointu: ${reason}.`,
    );
  });

  it("refuses two entries that spell the same endpoint", () => {
    const path = file(
      entries({ [ROUTER_ADDRESS]: { authToken: PLANT }, [`${ROUTER_ADDRESS}/`]: { authToken: PLANT } }),
    );

    expect(refusal(path)).toBe(
      `Plik poświadczeń "${path}" zawiera więcej niż jeden wpis dla endpointu ${ROUTER_ADDRESS} (adresy różnią się tylko zapisem). Zostaw jeden.`,
    );
  });

  it.each([
    ["no known field", { authtoken: PLANT }],
    ["two fields", { authToken: PLANT, helper: { command: ["/bin/echo"] } }],
    ["a value in the place of the entry", PLANT],
    ["nothing", null],
  ])("wants exactly one of the three fields in an entry: %s", (_case, entry) => {
    const path = routerEntry(entry);

    expect(refusal(path)).toBe(
      `Wpis dla endpointu ${ROUTER_ADDRESS} w pliku "${path}" musi zawierać dokładnie jedno z pól: "apiKey", "authToken", "helper".`,
    );
  });

  it("refuses the field of the other way of authenticating", () => {
    const withKey = routerEntry({ apiKey: PLANT });
    const withToken = file(entries({ [ANTHROPIC_ENDPOINT]: { authToken: PLANT } }));

    expect(refusal(withKey)).toBe(
      `Wpis dla endpointu ${ROUTER_ADDRESS} w pliku "${withKey}" zawiera pole "apiKey", a ten workspace wysyła token w nagłówku Authorization, więc potrzebuje pola "authToken".`,
    );
    expect(refusal(withToken, PUBLIC)).toBe(
      `Wpis dla endpointu ${ANTHROPIC_ENDPOINT} w pliku "${withToken}" zawiera pole "authToken", a ten workspace wysyła klucz w nagłówku x-api-key, więc potrzebuje pola "apiKey".`,
    );
  });

  it.each([
    [
      "with a space",
      `${PLANT} x`,
      "zawiera znak, którego nie da się wysłać w nagłówku: odstęp, znak nowej linii, cudzysłów, ukośnik wsteczny albo znak spoza ASCII",
    ],
    [
      "with the word Bearer",
      `Bearer ${PLANT}`,
      "zaczyna się od słowa „Bearer”; podaj sam token, aplikacja dopisuje to słowo sama",
    ],
    ["too short", "short", "jest krótsze niż 8 znaków"],
    ["empty", "", "jest puste"],
    ["not a text", 12345678, "jest puste"],
  ])("refuses a value that cannot be sent, without repeating it: %s", (_case, value, problem) => {
    const path = routerEntry({ authToken: value });

    expect(refusal(path)).toBe(
      `Pole "authToken" we wpisie dla endpointu ${ROUTER_ADDRESS} w pliku "${path}" ${problem}.`,
    );
  });

  it("validates in depth only the entry of the workspace's endpoint, and ignores what else that entry holds", () => {
    const path = file(
      entries({
        "https://other.example": 42,
        "https://another.example": { helper: { command: "not a list" } },
        [ROUTER_ADDRESS]: { authToken: PLANT, comment: "rotated in October" },
      }),
    );

    expect(staticValue(path)).toBe(PLANT);
  });
});

describe("readFileCredential, helper command", () => {
  const where = (path: string) => `we wpisie dla endpointu ${ROUTER_ADDRESS} w pliku "${path}"`;
  const shape =
    'Oczekiwane: {"command": ["/pełna/ścieżka/programu", "argument"], "ttlSeconds": 300, "timeoutSeconds": 30}; dwa ostatnie pola są opcjonalne.';

  it("reads the command as it is written, with the defaults for what is left out", () => {
    expect(
      readFileCredential(routerEntry({ helper: { command: ["/bin/echo", "a b", "$(id)"] } }), ROUTER, deps),
    ).toEqual({
      kind: "helper",
      helper: { command: ["/bin/echo", "a b", "$(id)"], ttlMs: 300_000, timeoutMs: 30_000 },
    });
    expect(
      readFileCredential(
        routerEntry({ helper: { command: ["/bin/echo"], ttlSeconds: 86_400, timeoutSeconds: 300 } }),
        ROUTER,
        deps,
      ),
    ).toEqual({ kind: "helper", helper: { command: ["/bin/echo"], ttlMs: 86_400_000, timeoutMs: 300_000 } });
  });

  it("serves either way of authenticating", () => {
    const path = file(entries({ [ANTHROPIC_ENDPOINT]: { helper: { command: ["/bin/echo"] } } }));

    expect(readFileCredential(path, PUBLIC, deps).kind).toBe("helper");
  });

  it("wants an object", () => {
    const path = routerEntry({ helper: "/bin/echo token" });

    expect(refusal(path)).toBe(`Pole "helper" ${where(path)} musi być obiektem. ${shape}`);
  });

  it.each([
    ["one text", "echo token"],
    ["an empty list", []],
    ["a list with a number", ["/bin/echo", 1]],
    ["a list that starts with an empty text", ["", "token"]],
    ["nothing", undefined],
  ])("wants the command as a list of texts: %s", (_case, command) => {
    const path = routerEntry({ helper: { command } });

    expect(refusal(path)).toBe(
      `Pole "helper.command" ${where(path)} musi być listą tekstów: program i jego argumenty. Polecenie jest uruchamiane bez powłoki, więc jeden tekst z odstępami nie zadziała. ${shape}`,
    );
  });

  const itemByItem =
    "Program i każdy jego argument to osobne elementy listy; polecenie jest uruchamiane bez powłoki, więc jeden tekst z odstępami nie zadziała.";

  it("wants the program with its full path", () => {
    const path = routerEntry({ helper: { command: ["echo", "token"] } });

    expect(refusal(path)).toBe(
      `Pole "helper.command" ${where(path)} musi zaczynać się od pełnej ścieżki programu (od "/"). Pełną ścieżkę programu pokaże polecenie "command -v" z jego nazwą.`,
    );
  });

  // The program is not shown before the system has confirmed that it names a file: until then
  // it is whatever was typed there. refusal() fails on any message that holds the planted secret.
  it.each([
    ["a command line with a token in it, as one text", `echo ${PLANT}`, true],
    ["the same with a tab", `echo\t${PLANT}`, true],
    ["a token pasted in the place of the program", PLANT, false],
    ["a token after an equals sign", `TOKEN=${PLANT}`, false],
  ])("does not repeat what stands in the place of the program: %s", (_case, program, oneText) => {
    const path = routerEntry({ helper: { command: [program] } });

    expect(refusal(path)).toBe(
      `Pole "helper.command" ${where(path)} musi zaczynać się od pełnej ścieżki programu (od "/").${oneText ? ` ${itemByItem}` : ""} Pełną ścieżkę programu pokaże polecenie "command -v" z jego nazwą.`,
    );
  });

  it.each([
    ["a command line with a full path and a token, as one text", `/bin/echo ${PLANT}`, true],
    ["a path that ends with a token", `/usr/local/bin/${PLANT}`, false],
  ])("does not repeat a program that is not there: %s", (_case, program, oneText) => {
    const path = routerEntry({ helper: { command: [program, "argument"] } });

    expect(refusal(path)).toBe(
      `Program podany w polu "helper.command" ${where(path)} nie istnieje albo nie da się go odczytać.${oneText ? ` ${itemByItem}` : ""}`,
    );
  });

  it.each([
    ["in an argument", ["/bin/echo", `token\u0000${PLANT}`]],
    ["in the program", [`/bin/echo\u0000${PLANT}`]],
  ])("refuses a NUL character %s, which no program can be handed", (_case, command) => {
    const path = routerEntry({ helper: { command } });

    expect(refusal(path)).toBe(
      `Pole "helper.command" ${where(path)} zawiera znak NUL (\\u0000), którego nie da się przekazać programowi.`,
    );
  });

  it.each([0, 86_401, 1.5, "300", null])("refuses a lifetime of %j seconds", (ttlSeconds) => {
    const path = routerEntry({ helper: { command: ["/bin/echo"], ttlSeconds } });

    expect(refusal(path)).toBe(`Pole "helper.ttlSeconds" ${where(path)} musi być liczbą całkowitą od 1 do 86400.`);
  });

  it.each([0, 301, 2.5, "30"])("refuses a time limit of %j seconds", (timeoutSeconds) => {
    const path = routerEntry({ helper: { command: ["/bin/echo"], timeoutSeconds } });

    expect(refusal(path)).toBe(`Pole "helper.timeoutSeconds" ${where(path)} musi być liczbą całkowitą od 1 do 300.`);
  });

  it("refuses a program that is not there, or is not a file", () => {
    const missing = routerEntry({ helper: { command: [join(sandbox, "missing-helper")] } });

    expect(refusal(missing)).toBe(
      `Program podany w polu "helper.command" ${where(missing)} nie istnieje albo nie da się go odczytać.`,
    );
    // What is there has a name that the system has confirmed, and is shown by it.
    expect(refusal(routerEntry({ helper: { command: [sandbox] } }))).toBe(
      `Polecenie pomocnicze "${sandbox}" nie jest plikiem.`,
    );
  });

  it.each([
    ["775", 0o775],
    ["757", 0o757],
    ["722", 0o722],
  ])("refuses a program that someone else can change: mode %s", (shown, mode) => {
    const script = join(sandbox, `writable-${shown}.sh`);
    writeFileSync(script, "#!/bin/sh\necho token\n");
    chmodSync(script, mode);

    expect(refusal(routerEntry({ helper: { command: [script] } }))).toBe(
      `Polecenie pomocnicze "${script}" może zmienić inny użytkownik (uprawnienia ${shown}). Ogranicz je poleceniem "chmod go-w ${script}".`,
    );
  });

  it("accepts a program of the user and a program of root that nobody else can change", () => {
    const script = join(sandbox, "own-helper.sh");
    writeFileSync(script, "#!/bin/sh\necho token\n");
    chmodSync(script, 0o755);

    // /bin/sh belongs to root.
    for (const program of [script, "/bin/sh"]) {
      expect(readFileCredential(routerEntry({ helper: { command: [program] } }), ROUTER, deps).kind).toBe("helper");
    }
  });
});
