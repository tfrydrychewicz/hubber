// Reads a workspace from disk. No database is opened here and no endpoint is compared:
// readWorkspace() answers "is this a workspace, and what does its configuration say".
// open.ts goes on from there (environment, database, pin).
import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { parseWorkspaceConfig, type WorkspaceConfig, WorkspaceConfigError } from "./config.ts";
import { refusal } from "./errors.ts";
import { CONFIG_FILE, DATABASE_FILE, FILES_DIR, type WorkspacePaths, workspacePaths } from "./layout.ts";
import { WORKSPACE_VARIABLE, type WorkspaceLocation } from "./location.ts";

export interface Workspace {
  paths: WorkspacePaths;
  config: WorkspaceConfig;
  /** Lines worth showing to the user at start; none of them stops the workspace from opening. */
  warnings: string[];
}

// The same words as in the message about a taken port: what the user will do, as a command to copy.
const CREATE_HINT = 'Utworzysz go poleceniem "npm run workspace:create -- --name <nazwa> --kind <anthropic|router>".';
const RESTORE_HINT = "Odtwórz cały katalog z kopii zapasowej.";

function kindOf(path: string): "directory" | "file" | "missing" {
  try {
    // stat, not lstat: a workspace may be reached through a link, for instance to another volume.
    return statSync(path).isDirectory() ? "directory" : "file";
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    // ENOTDIR: something on the way to the path is a file, so nothing can be at the path either.
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    throw error;
  }
}

/**
 * The text of the file at a path, or undefined when no file is there: nothing at all, or something
 * that is not a file. Opened without waiting, because a named pipe in that place would keep an
 * ordinary read, and with it the start of the server, waiting for someone to write into it.
 */
function readFileIfThere(path: string): string | undefined {
  let file: number;
  try {
    file = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return fstatSync(file).isFile() ? readFileSync(file, "utf8") : undefined;
  } finally {
    closeSync(file);
  }
}

/** Reads the workspace at the given place. Throws a refusal (errors.ts) that says what is wrong and what to do. */
export function readWorkspace({ dir, source }: WorkspaceLocation): Workspace {
  const paths = workspacePaths(dir);
  try {
    const found = kindOf(dir);
    if (found === "missing") {
      throw refusal(
        source === "default"
          ? `w domyślnym katalogu "${dir}" jeszcze go nie ma. ${CREATE_HINT} Inny katalog wskażesz zmienną ${WORKSPACE_VARIABLE}.`
          : `katalog "${dir}" ze zmiennej ${WORKSPACE_VARIABLE} nie istnieje. ${CREATE_HINT}`,
      );
    }
    if (found === "file") throw refusal(`"${dir}" nie jest katalogiem.`);

    // A directory, a named pipe or a device of that name is no configuration file either.
    const text = readFileIfThere(paths.config);
    if (text === undefined) {
      throw refusal(`katalog "${dir}" nie jest workspace'em Hubbera (brak pliku ${CONFIG_FILE}).`);
    }

    let config: WorkspaceConfig;
    try {
      config = parseWorkspaceConfig(text);
    } catch (error) {
      if (!(error instanceof WorkspaceConfigError)) throw error;
      const [first = "", ...rest] = error.problems;
      throw refusal(
        rest.length === 0
          ? `błąd w pliku konfiguracji "${paths.config}": ${first}.`
          : `błędy w pliku konfiguracji "${paths.config}":\n${error.problems.map((problem) => `  ${problem}`).join("\n")}`,
      );
    }

    // A directory restored only in part. Without these the server would fail at the first
    // dropped file, or report a database problem that hides the real cause.
    if (kindOf(paths.database) !== "file") {
      throw refusal(`w katalogu "${dir}" brakuje pliku bazy ${DATABASE_FILE}. ${RESTORE_HINT}`);
    }
    if (kindOf(paths.files) !== "directory") {
      throw refusal(`w katalogu "${dir}" brakuje katalogu ${FILES_DIR}. ${RESTORE_HINT}`);
    }

    const warnings: string[] = [];
    const mode = statSync(dir).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      warnings.push(
        `Uwaga: katalog workspace'u "${dir}" jest dostępny dla innych kont tego komputera (uprawnienia ${mode.toString(8)}). Zamkniesz go poleceniem "chmod -R go-rwx" na tym katalogu.`,
      );
    }
    return { paths, config, warnings };
  } catch (error) {
    const { code, syscall } = error as NodeJS.ErrnoException;
    // macOS answers EPERM for a folder the terminal has not been allowed into (Documents, Desktop).
    if (code === "EACCES" || code === "EPERM") {
      throw refusal(`brak dostępu do katalogu "${dir}" (${code}). Sprawdź uprawnienia katalogu i terminala.`);
    }
    // Whatever else the system says about the place (a link that leads to itself, a name that is
    // too long, a disk that fails) is one more reason the workspace cannot be opened, and is said
    // as one. Only what is no answer of the system at all is left to end the start as it is.
    if (typeof code === "string" && typeof syscall === "string") {
      throw refusal(`nie udało się odczytać katalogu "${dir}" (${code}).`);
    }
    throw error;
  }
}
