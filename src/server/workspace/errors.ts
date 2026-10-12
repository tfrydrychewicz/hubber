import type { MigrationFilesFault } from "../db/migrate.ts";
import { EXIT_FAILURE } from "../exit-codes.ts";

/**
 * A workspace that cannot be created or opened. The message is written for the user and is
 * printed as it stands; the exit code follows exit-codes.ts.
 */
export class WorkspaceError extends Error {
  override name = "WorkspaceError";
  readonly exitCode: number;

  constructor(message: string, exitCode: number = EXIT_FAILURE) {
    super(message);
    this.exitCode = exitCode;
  }
}

// Every refusal to open a workspace starts with these words, whatever the reason and whatever
// the exit code: a missing directory, a broken configuration, a pin that does not match, a
// setting of the environment that the workspace cannot be opened under. The development runner
// goes by them, the way it goes by the first words of the message about a taken port.
const REFUSAL = "Nie można otworzyć workspace'u";

/**
 * The error for a workspace that is named by the settings but cannot be opened. The reason
 * completes the sentence; the name is given once the configuration file has told it.
 */
export function refusal(reason: string, exitCode: number = EXIT_FAILURE, name?: string): WorkspaceError {
  return new WorkspaceError(`${REFUSAL}${name === undefined ? "" : ` „${name}”`}: ${reason}`, exitCode);
}

/** Recognises a refusal in the output of another process. No saved file makes it go away. */
export function isWorkspaceRefusal(line: string): boolean {
  return line.startsWith(REFUSAL);
}

/**
 * The reason, in the owner's words, why the migrations of this code cannot be used: what the
 * reader of the migrations found wrong with their folder (its MigrationFilesError, by its fields).
 * The folder is part of the code, so the checkout the application runs from is at fault, whatever
 * workspace it was about to create or open. `state` is the sentence of the caller about what it
 * was working on, for a caller that has one.
 *
 * A fault that anybody can meet has a sentence of its own, Polish to its end. Every other fault is
 * a rule of the folder that a migration in the making breaks: the reader states it in English, for
 * whoever is writing that migration, and it is quoted as it is.
 */
export function unusableMigrations(
  found: MigrationFilesFault & { folder: string; message: string },
  state?: string,
): string {
  const then = `${state === undefined ? "" : `${state} `}To błąd kopii kodu aplikacji, a nie workspace'u`;
  // The bytes of a file are other than they were written: by a tool, or by whoever is writing the
  // migration, whose file is in no repository yet.
  if (found.changedFile !== undefined) {
    return `plik migracji "${found.changedFile}" ma inną treść niż ta, którą zapisano dla niego w pliku manifest.json. ${then}: przywróć ten plik z repozytorium. Jego treść zmienia także narzędzie, które przepisuje końce wierszy. Gdy to nowa migracja, nad którą pracujesz, wklej do manifest.json wpis, który wypisuje test src/server/db/migrations.test.ts.`;
  }
  if (found.missingFile !== undefined) {
    return `w katalogu migracji tej wersji aplikacji brakuje pliku "${found.missingFile}". ${then}: przywróć ten plik z repozytorium albo dokończ przerwaną aktualizację kodu.`;
  }
  if (found.unreadablePath !== undefined) {
    const what =
      found.unreadablePath === found.folder
        ? `katalogu migracji tej wersji aplikacji "${found.folder}"`
        : `pliku "${found.unreadablePath}" z katalogu migracji tej wersji aplikacji`;
    return `nie udało się odczytać ${what} (${found.code}). ${then}: sprawdź prawa dostępu do katalogu migracji albo przywróć go z repozytorium.`;
  }
  // Three ways to such a file: a copy, half of an update of the code, which brought the file and
  // not yet its entry, and a migration that is being written.
  if (found.unlistedFile !== undefined) {
    return `w katalogu migracji tej wersji aplikacji jest plik "${found.unlistedFile}", którego nie wymienia manifest.json. ${then}: usuń ten plik, jeśli jest kopią zostawioną przez edytor albo menedżer plików, albo dokończ przerwaną aktualizację kodu. Gdy to nowa migracja, nad którą pracujesz, dopisz ją do manifest.json.`;
  }
  // What the manifest holds is no list: without what the parser said of it, which is English and
  // about a place in a file that nobody is meant to mend by hand.
  if (found.damagedManifest !== undefined) {
    return `plik "${found.damagedManifest}" w katalogu migracji tej wersji aplikacji jest niepełny albo uszkodzony. ${then}: przywróć ten plik z repozytorium albo dokończ przerwaną aktualizację kodu.`;
  }
  return `migracji tej wersji aplikacji nie da się odczytać z katalogu "${found.folder}". ${then}: przywróć ten katalog z repozytorium albo popraw migrację, nad którą pracujesz. Szczegóły: ${found.message}`;
}

// A start that has to bring the database of the workspace up to date says so in two lines, one
// before the work and one after it. These are their first words. The development runner goes by
// them as well: between the two it does not count the time it gives a server to come up, because
// a migration takes as long as it takes, and a refusal is the other way such a start can end.
export const MIGRATION_NOTICE = "Baza workspace'u wymaga aktualizacji";
export const MIGRATION_DONE = "Baza zaktualizowana.";

/** Recognises, in the output of another process, the line of a start that is about to migrate its database. */
export function isMigrationNotice(line: string): boolean {
  return line.startsWith(MIGRATION_NOTICE);
}

/** Recognises the line of a start that has migrated its database. */
export function isMigrationDone(line: string): boolean {
  return line.startsWith(MIGRATION_DONE);
}
