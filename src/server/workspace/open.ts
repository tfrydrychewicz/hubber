// The one way the server gets a workspace. The order is the point of this file:
//   1. the directory and the configuration file are read and validated (store.ts);
//   2. the environment is checked against the pin, and the process for settings that move the
//      connection (pin.ts): a workspace that belongs to another endpoint is not even opened;
//   3. the database is opened with the address of the configuration file as the expected pin
//      (database.ts): the pin holds even if one of the two files was edited or swapped;
//   4. the database is brought to the schema of this code (../db/migrate.ts), with a copy of it
//      made first: no part of the application sees a database of an older version.
// Every failure is a refusal from errors.ts: one message that begins with the same words, and
// the exit code that says which kind of failure it was. How much a refusal about the database
// says depends on the step. One of step 4 says what became of the update and in what state the
// database is (of a database that a newer version migrated, only that it is that version's), and
// it names what the owner can do where it knows of something: not for a copy that could not be
// made or has no room, where the code or the two sizes are all it has. What SQLite itself reports
// of the file outside an update, at step 3 or on the way into step 4, is given by its code and the
// path alone, without the name of the workspace, the state or a remedy. Only a database that
// another process holds has words of its own there.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { type MigrateResult, MigrationError, MigrationFilesError, migrateDatabase } from "../db/migrate.ts";
import { EXIT_FAILURE, EXIT_PIN } from "../exit-codes.ts";
import { type Endpoint, parseEndpoint } from "../llm/endpoint.ts";
import { openWorkspaceDatabase, WORKSPACE_FORMAT, type WorkspaceDatabase, WorkspaceDatabaseError } from "./database.ts";
import { MIGRATION_DONE, MIGRATION_NOTICE, refusal, unusableMigrations, type WorkspaceError } from "./errors.ts";
import type { WorkspaceLocation } from "./location.ts";
import { assertActiveEndpoint, assertDirectTransport } from "./pin.ts";
import { readWorkspace, type Workspace } from "./store.ts";
import { readTransportState, type TransportState } from "./transport.ts";

export interface OpenWorkspace extends Workspace {
  /** The pinned endpoint: the address of the configuration file, which the database has confirmed. */
  endpoint: Endpoint;
  database: WorkspaceDatabase;
  /** What this open did to the database: the migrations it applied, and the copy it made before them. */
  migration: MigrateResult;
  /** Closes the database, which leaves a single file behind. Safe to call more than once. */
  close: () => void;
}

export interface OpenWorkspaceHooks {
  /**
   * Gets the lines of an open that migrates the database: one before the work, one after it, and
   * one more when the update is committed and could not be moved from the log into the file of the
   * database. An open that finds the database current says nothing.
   */
  log?: (line: string) => void;
}

const RESTORE_HINT = "Odtwórz cały katalog z kopii zapasowej.";
const UNCHANGED = "Baza nie została zmieniona.";
// What every migration that was begun and failed has in common: SQLite took it back as a whole.
const TAKEN_BACK = "Zmiany zostały wycofane i baza jest w stanie sprzed uruchomienia.";
// And what most of them have in common: the migration is wrong, which only another version of the code mends.
const ROLLED_BACK = `${TAKEN_BACK} To błąd tej wersji aplikacji: wróć do poprzedniej wersji kodu albo popraw migrację.`;
// The codes with which SQLite speaks of the disk, the memory or the file, whatever statement met
// them. No version of the code mends those, so the advice above would send the owner the wrong way.
const NOT_THE_MIGRATION = /^SQLITE_(FULL|IOERR|NOMEM|CORRUPT|NOTADB|READONLY|CANTOPEN)/;

/** The end of a sentence about an update that failed with a code of SQLite and was taken back: why, if the code says, and what to do. */
function afterFailedUpdate(code: string): string {
  if (code.startsWith("SQLITE_FULL")) {
    return `, bo na dysku zabrakło miejsca. ${TAKEN_BACK} Zwolnij miejsce na dysku i uruchom aplikację ponownie.`;
  }
  return NOT_THE_MIGRATION.test(code)
    ? `. Ten kod oznacza kłopot z dyskiem, pamięcią albo plikiem bazy, a nie błąd w migracji. ${TAKEN_BACK} Sprawdź dysk i dostęp do katalogu workspace'u, a potem uruchom aplikację ponownie; gdy błąd się powtarza, odtwórz cały katalog z kopii zapasowej.`
    : `. ${ROLLED_BACK}`;
}

/**
 * The line of a start whose update is committed and still in the log beside the database: the
 * checkpoint after it failed with this code of SQLite. The start goes on, because nothing is lost.
 * The owner has to hear of it all the same: until the log is folded back, which a clean close does
 * once it can, the file of the database alone is not the database.
 */
function afterFailedCheckpoint(code: string, { paths }: Workspace): string {
  const stillInTheLog = `są na razie w pliku ${basename(paths.database)}-wal obok bazy`;
  return code.startsWith("SQLITE_FULL")
    ? `Na dysku brakuje miejsca: zmiany ${stillInTheLog}. Zwolnij miejsce.`
    : `Nie udało się przenieść zmian do pliku bazy (${code}): ${stillInTheLog}. Sprawdź dysk i dostęp do katalogu workspace'u.`;
}

/** What SQLite says of a database that nothing else explains; a file that another process holds has words of its own. */
function sqliteRefusal(code: string, { paths, config }: Workspace): WorkspaceError {
  const file = `"${paths.database}"`;
  // While another start migrates the database, the file is that process's alone.
  if (code.startsWith("SQLITE_BUSY")) {
    return refusal(
      `baza ${file} jest zajęta przez inny proces Hubbera (trwa jej aktualizacja albo zamykanie). Spróbuj ponownie za chwilę.`,
      EXIT_FAILURE,
      config.name,
    );
  }
  return refusal(`nie udało się otworzyć bazy ${file} (${code}).`, EXIT_FAILURE);
}

function databaseRefusal(error: WorkspaceDatabaseError, workspace: Workspace): WorkspaceError {
  const { paths, config } = workspace;
  const file = `"${error.path}"`;
  switch (error.problem) {
    case "pinned-elsewhere":
      return refusal(
        `plik konfiguracji "${paths.config}" podaje endpoint ${config.profile.endpoint}, a baza ${file} jest przypięta do ${error.storedEndpoint}. Wiążący jest adres zapisany w bazie przy utworzeniu workspace'u: przywróć go w pliku konfiguracji albo przywróć plik bazy, który do tego workspace'u należy.`,
        EXIT_PIN,
        config.name,
      );
    case "missing":
      return refusal(`brak pliku bazy ${file}. ${RESTORE_HINT}`);
    case "foreign":
      return refusal(`plik ${file} nie jest bazą workspace'u Hubbera. ${RESTORE_HINT}`);
    case "newer":
      return refusal(
        `bazę ${file} zapisała nowsza wersja Hubbera (format ${error.format}, ta wersja zna ${WORKSPACE_FORMAT}). Zaktualizuj aplikację.`,
      );
    case "no-pin":
      return refusal(
        `w bazie ${file} brakuje zapisu o przypięciu do endpointu, więc nie da się sprawdzić, dla którego endpointu powstała. ${RESTORE_HINT}`,
      );
    default:
      return sqliteRefusal(error.sqliteCode ?? error.problem, workspace);
  }
}

/** Megabytes for a sentence: what is needed rounded up and what is free rounded down, so the two never read alike. */
const megabytes = (bytes: number, round: (value: number) => number) => round(bytes / 1_000_000);

/** The owner's words for a database that could not be brought to the schema of this code. */
function migrationRefusal({ problem, facts }: MigrationError, { paths, config }: Workspace): WorkspaceError {
  const file = `"${paths.database}"`;
  const reason = (): string => {
    switch (problem) {
      case "statement-failed": {
        // The migration ended the one transaction itself: nothing was taken back, and the copy from
        // before is the only way to the state that the other sentences promise.
        if (facts.code === "TRANSACTION_ENDED") {
          const wayBack =
            facts.snapshot === undefined ? "odtwórz cały katalog z kopii zapasowej" : "odtwórz bazę z tej kopii";
          const copy =
            facts.snapshot === undefined
              ? ""
              : ` Stan sprzed uruchomienia jest w kopii "${join(paths.backups, basename(facts.snapshot))}".`;
          return `migracja ${facts.tag} sama zakończyła transakcję aktualizacji (polecenie ${facts.statement}), więc część jej zmian mogła zostać w bazie.${copy} To błąd tej wersji aplikacji: zanim uruchomisz ją ponownie, ${wayBack}, a potem wróć do poprzedniej wersji kodu albo popraw migrację.`;
        }
        return `aktualizacja bazy nie powiodła się w migracji ${facts.tag} (polecenie ${facts.statement}: ${facts.code})${afterFailedUpdate(facts.code ?? "")}`;
      }
      case "foreign-keys":
        return `aktualizacja bazy zostawiłaby rekordy wskazujące na nieistniejące obiekty (migracja ${facts.tag}, tabela ${facts.table}, odwołanie do ${facts.parent}). ${ROLLED_BACK}`;
      case "schema-drift":
        if (facts.whileMigrating) {
          return `po migracji ${facts.tag} schemat bazy różni się od zapisanego w kodzie. ${ROLLED_BACK}`;
        }
        // Found before anything was begun. With nothing to apply, the last migration the database
        // has had is the last one of this code; with a migration waiting, it is an earlier one or none.
        if (facts.pendingTag === undefined) {
          return `schemat bazy ${file} różni się od tego, który zostawiają migracje tej wersji (ostatnia: ${facts.tag}): czegoś w nim brakuje albo coś zmieniono poza aplikacją. ${UNCHANGED} ${RESTORE_HINT}`;
        }
        return facts.tag === undefined
          ? `baza ${file} nie przeszła jeszcze żadnej migracji, a są w niej tabele albo inne obiekty, których nie utworzyła aplikacja. Takiej bazy nie da się zaktualizować. ${UNCHANGED} ${RESTORE_HINT}`
          : `schemat bazy ${file} różni się od tego, który zostawiła ostatnia wykonana na niej migracja (${facts.tag}): czegoś w nim brakuje albo coś zmieniono poza aplikacją. Takiej bazy nie da się zaktualizować. ${UNCHANGED} ${RESTORE_HINT}`;
      case "in-use":
        return `baza wymaga aktualizacji, a workspace jest otwarty w innym procesie Hubbera. Zatrzymaj go i uruchom aplikację ponownie. ${UNCHANGED}`;
      case "no-space":
        // Only the copy was counted: what the migrations write on top of it is not known beforehand.
        return `przed aktualizacją bazy trzeba zrobić jej kopię, a na dysku brakuje miejsca: sama kopia potrzebuje około ${megabytes(facts.neededBytes ?? 0, Math.ceil)} MB, a wolne jest ${megabytes(facts.freeBytes ?? 0, Math.floor)} MB. Aktualizacja potrzebuje potem jeszcze dodatkowego miejsca. ${UNCHANGED}`;
      case "snapshot-failed":
        return `nie udało się zrobić kopii bazy przed aktualizacją (${facts.code}). Bez kopii aktualizacja się nie zaczyna. ${UNCHANGED}`;
      case "newer": {
        // The record of the database names a file; whether it is still there is for the disk to say.
        const snapshot = facts.snapshot === undefined ? undefined : join(paths.backups, basename(facts.snapshot));
        const wayBack =
          snapshot !== undefined && existsSync(snapshot)
            ? ` Stan sprzed tamtej aktualizacji jest w kopii "${snapshot}"; odtworzenie go usuwa wszystko, co zapisano później.`
            : "";
        return `bazę ${file} zaktualizowała nowsza wersja Hubbera (ostatnia migracja w bazie: ${facts.databaseTag}, ta wersja zna ${facts.codeTag}). Uruchom wersję, która ją zaktualizowała, albo nowszą.${wayBack}`;
      }
      case "diverged":
        return `historia migracji w bazie ${file} różni się od tej wersji kodu (migracja ${facts.tag}). ${UNCHANGED} Uruchom wersję aplikacji, która tę bazę aktualizowała.`;
    }
  };
  return refusal(reason(), EXIT_FAILURE, config.name);
}

/**
 * Throws a WorkspaceError (a refusal) for every reason the workspace cannot be opened. How the
 * process reaches the network is read from the process itself unless a test hands in a state.
 *
 * Synchronous from the first read to the last statement of a migration: a process that has
 * registered handlers for its signals is not interrupted half-way, because Node delivers a signal
 * only between two turns of its event loop.
 */
export function openWorkspace(
  location: WorkspaceLocation,
  env: Readonly<Record<string, string | undefined>>,
  transport: TransportState = readTransportState(),
  hooks: OpenWorkspaceHooks = {},
): OpenWorkspace {
  const workspace = readWorkspace(location);
  // Cannot throw: parseWorkspaceConfig() has accepted the address in exactly this spelling.
  const endpoint = parseEndpoint(workspace.config.profile.endpoint);

  assertActiveEndpoint({ name: workspace.config.name, endpoint }, env);
  assertDirectTransport(endpoint, transport);

  let database: WorkspaceDatabase;
  try {
    database = openWorkspaceDatabase(workspace.paths.database, endpoint.href);
  } catch (error) {
    if (error instanceof WorkspaceDatabaseError) throw databaseRefusal(error, workspace);
    throw error;
  }

  let migration: MigrateResult;
  // Whether the runner found something to apply: from then on it is at work on an update.
  let updating = false;
  try {
    migration = migrateDatabase(database, {
      snapshotDir: workspace.paths.backups,
      onPending: ({ pending }) => {
        updating = true;
        hooks.log?.(
          `${MIGRATION_NOTICE} (${pending.join(", ")}). Robię kopię i aktualizuję; Ctrl-C zadziała po zakończeniu.`,
        );
      },
    });
  } catch (error) {
    // Refused or failed, the database is left as one file.
    database.close();
    if (error instanceof MigrationError) throw migrationRefusal(error, workspace);
    // The migrations of the code itself cannot be used: found before the database was looked at.
    if (error instanceof MigrationFilesError) {
      throw refusal(unusableMigrations(error, UNCHANGED), EXIT_FAILURE, workspace.config.name);
    }
    // Whatever else SQLite reports on the way. During an update that is a failure of the update,
    // a disk that fills up at the commit for one: the runner has taken back what it had begun.
    const { code } = error as { code?: unknown };
    if (typeof code === "string" && code.startsWith("SQLITE_")) {
      if (updating && !code.startsWith("SQLITE_BUSY")) {
        throw refusal(
          `aktualizacja bazy nie powiodła się (${code})${afterFailedUpdate(code)}`,
          EXIT_FAILURE,
          workspace.config.name,
        );
      }
      throw sqliteRefusal(code, workspace);
    }
    throw error;
  }
  if (migration.applied.length > 0) {
    hooks.log?.(`${MIGRATION_DONE} Kopia sprzed aktualizacji: "${migration.snapshot}".`);
    // After the line that ends the update for whoever reads the output of the server.
    if (migration.checkpointFailed !== undefined) {
      hooks.log?.(afterFailedCheckpoint(migration.checkpointFailed, workspace));
    }
  }

  let closed = false;
  return {
    ...workspace,
    endpoint,
    database,
    migration,
    close: () => {
      if (closed) return;
      closed = true;
      database.close();
    },
  };
}
