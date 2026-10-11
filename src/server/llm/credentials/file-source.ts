// Sources 2 and 3 share one file outside the repository and outside every workspace:
//
//   $HOME/.config/hubber/credentials.json        (HUBBER_CREDENTIALS_FILE names another one)
//
//   {
//     "version": 1,
//     "endpoints": {
//       "https://api.anthropic.com": { "apiKey": "sk-ant-..." },
//       "https://router.corp.example/llm": {
//         "helper": { "command": ["/usr/local/bin/llm-token", "--audience", "llm"], "ttlSeconds": 900 }
//       }
//     }
//   }
//
// The key of an entry is the endpoint it belongs to, so one file serves every workspace on this
// machine and a credential can only ever be released for the endpoint it was filed under.
// The helper command is configured here and nowhere else: this is the one file that only the
// user can write (checked below), whereas the workspace directory is data that gets copied,
// restored and, later, written by the API.
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { EndpointError, parseEndpoint } from "../endpoint.ts";
import type { Env } from "./env-source.ts";
import { SECRET_PROBLEM_TEXT, Secret } from "./secret.ts";
import { CredentialError, type CredentialTarget } from "./types.ts";

export const CREDENTIALS_FILE_VARIABLE = "HUBBER_CREDENTIALS_FILE";

const MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;

export interface HelperSpec {
  /** The executable with its full path, then its arguments. Run as given, without a shell. */
  command: readonly [string, ...string[]];
  /** How long a value is reused before the command runs again. */
  ttlMs: number;
  /** How long one run may take. */
  timeoutMs: number;
}

export type FileLookup =
  | { kind: "static"; secret: Secret }
  | { kind: "helper"; helper: HelperSpec }
  /** Nothing for this endpoint; `note` says why, as one clause of the final message. */
  | { kind: "none"; note: string };

export interface FileDeps {
  /** The user the process runs as. */
  uid: number;
  /** Directories the file must not be in: the repository and the workspace. */
  forbiddenRoots: readonly string[];
}

/**
 * Where the credentials file is, or why there is no place to look in, as one clause of the
 * final message. Decided from the environment alone, and the home directory is taken from the
 * HOME variable only: os.homedir() would fall back to the account database, and a process that
 * a test started with an environment of its own would then read the developer's real file.
 */
export function credentialsFilePath(env: Env): { path: string } | { note: string } {
  const home = env.HOME !== undefined && isAbsolute(env.HOME) ? env.HOME : undefined;
  const override = env[CREDENTIALS_FILE_VARIABLE];
  // Blank counts as not set, as it does for the variables of the endpoint and the credential.
  if (override === undefined || override.trim() === "") {
    if (home === undefined) {
      return {
        note: `nie ma domyślnego pliku, bo zmienna HOME nie jest ustawiona; plik wskażesz zmienną ${CREDENTIALS_FILE_VARIABLE}`,
      };
    }
    return { path: join(home, ".config", "hubber", "credentials.json") };
  }
  // A value in quotes reaches the process with its "~" unexpanded.
  if (override.startsWith("~/")) {
    if (home === undefined) {
      return {
        note: `zmienna ${CREDENTIALS_FILE_VARIABLE} zaczyna się od znaku "~", który wymaga zmiennej HOME; podaj pełną ścieżkę pliku`,
      };
    }
    return { path: join(home, override.slice(1)) };
  }
  // A relative path is not guessed at: npm runs every script in the root of the repository,
  // where a credentials file must not be.
  if (!isAbsolute(override)) {
    return { note: `zmienna ${CREDENTIALS_FILE_VARIABLE} nie zawiera pełnej ścieżki pliku (od "/" albo "~/")` };
  }
  return { path: override };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const octal = (mode: number) => (mode & 0o777).toString(8).padStart(3, "0");

/** Whether the two are one file or one directory: the same inode of the same device. */
function isSame(one: BigIntStats, other: BigIntStats): boolean {
  return one.dev === other.dev && one.ino === other.ino;
}

/**
 * The directories that the opened file lies in, from its own up to the root of the file system,
 * or undefined when the path does not lead to that file.
 *
 * Directories are told apart by what they are (device and inode) and never by how a path
 * spells them. One directory has many spellings: in other letter case or another Unicode form
 * on a volume that ignores both, through a link, under /System/Volumes/Data. The path the
 * system gives back for the file settles the links, and only them.
 */
function directoriesOf(path: string, opened: BigIntStats): BigIntStats[] | undefined {
  const real = realpathSync.native(path);
  // Not every path names a place. For the path of an open descriptor (/dev/stdin) macOS answers
  // with a path that does not exist, or with one that leads to something else; and a name can be
  // pointed at another file after it was opened. What is asked about below has to be the file
  // that is read.
  if (!isSame(statSync(real, { bigint: true }), opened)) return undefined;
  const directories: BigIntStats[] = [];
  for (let directory = dirname(real); ; directory = dirname(directory)) {
    directories.push(statSync(directory, { bigint: true }));
    if (directory === dirname(directory)) return directories;
  }
}

/** The first of the roots that is one of the directories, if any. */
function forbiddenAmong(directories: readonly BigIntStats[], roots: readonly string[]): string | undefined {
  return roots.find((root) => {
    let stat: BigIntStats;
    try {
      stat = statSync(root, { bigint: true });
    } catch {
      // A root that is not there, or cannot be reached, has nothing in it.
      return false;
    }
    return directories.some((directory) => isSame(directory, stat));
  });
}

/** The text of the file, or undefined when there is no file. Everything else that is wrong with it throws. */
function readGuarded(path: string, deps: FileDeps): string | undefined {
  let fd: number;
  try {
    // O_NONBLOCK: opening a named pipe for reading would otherwise wait for a writer forever.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    if (code === "EACCES" || code === "EPERM") {
      throw new CredentialError(
        `Nie można odczytać pliku poświadczeń "${path}": brak uprawnień. Plik musi należeć do ciebie; odczyt przywrócisz poleceniem "chmod 600 ${path}".`,
      );
    }
    throw new CredentialError(`Nie można otworzyć pliku poświadczeń "${path}" (${code ?? "nieznany błąd"}).`);
  }
  try {
    // The checks and the read use the same descriptor, so they are about the same file even if
    // the name is pointed elsewhere in between. A symbolic link is followed: what counts is the
    // file it leads to. The numbers are taken exact: a device or an inode above 2^53 would
    // otherwise be compared rounded.
    const stat = fstatSync(fd, { bigint: true });
    const mode = Number(stat.mode);
    if (!stat.isFile()) {
      throw new CredentialError(`"${path}" nie jest zwykłym plikiem, więc nie może być plikiem poświadczeń.`);
    }
    if (Number(stat.uid) !== deps.uid) {
      throw new CredentialError(
        `Plik poświadczeń "${path}" należy do innego użytkownika. Aplikacja czyta tylko plik, którego właścicielem jesteś ty.`,
      );
    }
    // The permission bits are all that Node shows. An access control list (chmod +a) that lets
    // someone else read the file is not seen here.
    if ((mode & 0o077) !== 0) {
      throw new CredentialError(
        `Plik poświadczeń "${path}" jest dostępny dla innych użytkowników (uprawnienia ${octal(mode)}). Ogranicz je poleceniem "chmod 600 ${path}".`,
      );
    }
    if (stat.size > BigInt(MAX_FILE_BYTES)) {
      throw new CredentialError(`Plik poświadczeń "${path}" jest większy niż 1 MB, więc to nie jest plik poświadczeń.`);
    }
    // A file with a second name has its bytes wherever that name is, and no path tells where:
    // a hard link in the workspace directory would put the secret into every copy of it.
    if (stat.nlink > 1n) {
      throw new CredentialError(
        `Plik poświadczeń "${path}" ma więcej niż jedną nazwę (dowiązania twarde: ${stat.nlink}), więc jego treść leży także w miejscu, którego aplikacja nie zna. Utwórz plik na nowo pod jedną nazwą, poza repozytorium i poza katalogiem workspace'u.`,
      );
    }
    let directories: BigIntStats[] | undefined;
    let code: string | undefined;
    try {
      directories = directoriesOf(path, stat);
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code;
    }
    if (directories === undefined) {
      // Never read on the chance that the place is a good one.
      throw new CredentialError(
        `Nie można ustalić, w którym katalogu leży plik poświadczeń "${path}"${code === undefined ? "" : ` (${code})`}, więc nie wiadomo, czy leży poza repozytorium i poza katalogiem workspace'u. Wskaż plik jego zwykłą ścieżką.`,
      );
    }
    const root = forbiddenAmong(directories, deps.forbiddenRoots);
    if (root !== undefined) {
      throw new CredentialError(
        `Plik poświadczeń "${path}" leży w katalogu "${root}". Poświadczenia muszą leżeć poza repozytorium i poza katalogiem workspace'u; przenieś plik, na przykład do "~/.config/hubber/credentials.json".`,
      );
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function integerIn(value: unknown, fallback: number, max: number): number | undefined {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max ? value : undefined;
}

// Where the command is written as one text. The usual mistake, and the usual place of a token:
// "echo <token>".
const ITEM_BY_ITEM =
  "Program i każdy jego argument to osobne elementy listy; polecenie jest uruchamiane bez powłoki, więc jeden tekst z odstępami nie zadziała.";

/**
 * What is run with the user's rights must be something only the user, or root, can change.
 *
 * Until the system has answered that there is such a file, the program is a text from the
 * credentials file like any other, and no message repeats it: it may be a whole command line
 * with a token in it, or a token pasted in the wrong place.
 */
function checkHelperExecutable(file: string, uid: number, where: string): void {
  let stat: Stats;
  try {
    stat = statSync(file);
  } catch {
    throw new CredentialError(
      `Program podany w polu "helper.command" ${where} nie istnieje albo nie da się go odczytać.${/\s/.test(file) ? ` ${ITEM_BY_ITEM}` : ""}`,
    );
  }
  if (!stat.isFile()) throw new CredentialError(`Polecenie pomocnicze "${file}" nie jest plikiem.`);
  if (stat.uid !== uid && stat.uid !== 0) {
    throw new CredentialError(
      `Polecenie pomocnicze "${file}" należy do innego użytkownika. Aplikacja uruchamia tylko program, którego właścicielem jesteś ty albo root.`,
    );
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new CredentialError(
      `Polecenie pomocnicze "${file}" może zmienić inny użytkownik (uprawnienia ${octal(stat.mode)}). Ogranicz je poleceniem "chmod go-w ${file}".`,
    );
  }
}

function parseHelper(value: unknown, where: string, deps: FileDeps): HelperSpec {
  const shape = `Oczekiwane: {"command": ["/pełna/ścieżka/programu", "argument"], "ttlSeconds": ${DEFAULT_TTL_SECONDS}, "timeoutSeconds": ${DEFAULT_TIMEOUT_SECONDS}}; dwa ostatnie pola są opcjonalne.`;
  if (!isRecord(value)) throw new CredentialError(`Pole "helper" ${where} musi być obiektem. ${shape}`);
  const command = value.command;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part): part is string => typeof part === "string") ||
    command[0] === ""
  ) {
    throw new CredentialError(
      `Pole "helper.command" ${where} musi być listą tekstów: program i jego argumenty. Polecenie jest uruchamiane bez powłoki, więc jeden tekst z odstępami nie zadziała. ${shape}`,
    );
  }
  const items = command as [string, ...string[]];
  const [file, ...args] = items;
  // No program can be handed a NUL character, and Node says so in an error that quotes the item.
  if (items.some((item) => item.includes("\0"))) {
    throw new CredentialError(
      `Pole "helper.command" ${where} zawiera znak NUL (\\u0000), którego nie da się przekazać programowi.`,
    );
  }
  if (!isAbsolute(file)) {
    // Without the item itself: see checkHelperExecutable().
    throw new CredentialError(
      `Pole "helper.command" ${where} musi zaczynać się od pełnej ścieżki programu (od "/").${/\s/.test(file) ? ` ${ITEM_BY_ITEM}` : ""} Pełną ścieżkę programu pokaże polecenie "command -v" z jego nazwą.`,
    );
  }
  const ttl = integerIn(value.ttlSeconds, DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS);
  if (ttl === undefined) {
    throw new CredentialError(
      `Pole "helper.ttlSeconds" ${where} musi być liczbą całkowitą od 1 do ${MAX_TTL_SECONDS}.`,
    );
  }
  const timeout = integerIn(value.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
  if (timeout === undefined) {
    throw new CredentialError(
      `Pole "helper.timeoutSeconds" ${where} musi być liczbą całkowitą od 1 do ${MAX_TIMEOUT_SECONDS}.`,
    );
  }
  checkHelperExecutable(file, deps.uid, where);
  return { command: [file, ...args], ttlMs: ttl * 1000, timeoutMs: timeout * 1000 };
}

/**
 * What the credentials file holds for the target's endpoint. A missing file and a file without
 * an entry for the endpoint are answers ("none"); a file that is there but cannot be trusted or
 * understood is an error, because the user evidently meant it to be used.
 */
export function readFileCredential(path: string, target: CredentialTarget, deps: FileDeps): FileLookup {
  const text = readGuarded(path, deps);
  if (text === undefined) return { kind: "none", note: `plik "${path}" nie istnieje` };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    // Never the parser's own message: it quotes the text around the error, and that text can be
    // the secret. Only the position is taken from it, when it has one: digits cannot leak anything.
    const position = /\(line (\d+) column (\d+)\)/.exec(error instanceof Error ? error.message : "");
    const at = position ? ` (wiersz ${position[1]}, kolumna ${position[2]})` : "";
    throw new CredentialError(`Plik poświadczeń "${path}" nie jest poprawnym JSON-em${at}.`);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.endpoints)) {
    throw new CredentialError(
      `Plik poświadczeń "${path}" ma nieznany układ. Oczekiwany: {"version": 1, "endpoints": {"<adres endpointu>": {...}}}.`,
    );
  }

  const address = target.endpoint.href;
  const matches: unknown[] = [];
  Object.entries(parsed.endpoints).forEach(([key, entry], index) => {
    let endpoint: string;
    try {
      endpoint = parseEndpoint(key).href;
    } catch (error) {
      if (!(error instanceof EndpointError)) throw error;
      // The key is not repeated: it may be a credential pasted in the wrong place.
      throw new CredentialError(
        `W pliku poświadczeń "${path}" klucz nr ${index + 1} w "endpoints" nie nadaje się na adres endpointu: ${error.reason}.`,
      );
    }
    if (endpoint === address) matches.push(entry);
  });
  if (matches.length === 0) {
    return { kind: "none", note: `plik "${path}" nie ma wpisu dla endpointu ${address}` };
  }
  if (matches.length > 1) {
    throw new CredentialError(
      `Plik poświadczeń "${path}" zawiera więcej niż jeden wpis dla endpointu ${address} (adresy różnią się tylko zapisem). Zostaw jeden.`,
    );
  }

  const entry = matches[0];
  const fields = (["apiKey", "authToken", "helper"] as const).filter(
    (field) => isRecord(entry) && entry[field] !== undefined,
  );
  const field = fields[0];
  if (!isRecord(entry) || field === undefined || fields.length !== 1) {
    throw new CredentialError(
      `Wpis dla endpointu ${address} w pliku "${path}" musi zawierać dokładnie jedno z pól: "apiKey", "authToken", "helper".`,
    );
  }
  const where = `we wpisie dla endpointu ${address} w pliku "${path}"`;
  if (field === "helper") return { kind: "helper", helper: parseHelper(entry.helper, where, deps) };

  const expected = target.scheme === "bearer" ? "authToken" : "apiKey";
  if (field !== expected) {
    throw new CredentialError(
      `Wpis dla endpointu ${address} w pliku "${path}" zawiera pole "${field}", a ten workspace wysyła ${
        target.scheme === "bearer" ? "token w nagłówku Authorization" : "klucz w nagłówku x-api-key"
      }, więc potrzebuje pola "${expected}".`,
    );
  }
  const raw = entry[field];
  const secret = typeof raw === "string" ? Secret.parse(raw) : "empty";
  if (typeof secret === "string") {
    throw new CredentialError(`Pole "${field}" ${where} ${SECRET_PROBLEM_TEXT[secret]}.`);
  }
  return { kind: "static", secret };
}
