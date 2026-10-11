// The one way the server gets a workspace. The order is the point of this file:
//   1. the directory and the configuration file are read and validated (store.ts);
//   2. the environment is checked against the pin, and the process for settings that move the
//      connection (pin.ts): a workspace that belongs to another endpoint is not even opened;
//   3. the database is opened with the address of the configuration file as the expected pin
//      (database.ts): the pin holds even if one of the two files was edited or swapped.
// Every failure is a refusal from errors.ts: one message that begins with the same words, and
// the exit code that says which kind of failure it was.
import { EXIT_FAILURE, EXIT_PIN } from "../exit-codes.ts";
import { type Endpoint, parseEndpoint } from "../llm/endpoint.ts";
import { openWorkspaceDatabase, WORKSPACE_FORMAT, type WorkspaceDatabase, WorkspaceDatabaseError } from "./database.ts";
import { refusal, type WorkspaceError } from "./errors.ts";
import type { WorkspaceLocation } from "./location.ts";
import { assertActiveEndpoint, assertDirectTransport } from "./pin.ts";
import { readWorkspace, type Workspace } from "./store.ts";
import { readTransportState, type TransportState } from "./transport.ts";

export interface OpenWorkspace extends Workspace {
  /** The pinned endpoint: the address of the configuration file, which the database has confirmed. */
  endpoint: Endpoint;
  database: WorkspaceDatabase;
  /** Closes the database, which leaves a single file behind. Safe to call more than once. */
  close: () => void;
}

const RESTORE_HINT = "Odtwórz cały katalog z kopii zapasowej.";

function databaseRefusal(error: WorkspaceDatabaseError, { paths, config }: Workspace): WorkspaceError {
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
      return refusal(`nie udało się otworzyć bazy ${file} (${error.sqliteCode ?? error.problem}).`, EXIT_FAILURE);
  }
}

/**
 * Throws a WorkspaceError (a refusal) for every reason the workspace cannot be opened. How the
 * process reaches the network is read from the process itself unless a test hands in a state.
 */
export function openWorkspace(
  location: WorkspaceLocation,
  env: Readonly<Record<string, string | undefined>>,
  transport: TransportState = readTransportState(),
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

  let closed = false;
  return {
    ...workspace,
    endpoint,
    database,
    close: () => {
      if (closed) return;
      closed = true;
      database.close();
    },
  };
}
