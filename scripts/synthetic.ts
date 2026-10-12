// Fills a workspace with synthetic data: the history of a hub that was used for a while, for
// looking at the views and for trying the application out. Only the workspace that the variable
// names, never the default one, and only while its database is empty. It connects nowhere.
import { statfsSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/server/db/handle.ts";
import { megabytes, type Options, readOptions, seconds, UsageError } from "../src/server/db/synthetic/command-line.ts";
import {
  DATA_TABLES,
  DEFAULT_NOW,
  DEFAULT_SEED,
  EARLIEST_NOW,
  generateSynthetic,
  LATEST_NOW,
  SCALES,
  type ScaleName,
  usedTable,
} from "../src/server/db/synthetic/index.ts";
import { EXIT_FAILURE, EXIT_USAGE } from "../src/server/exit-codes.ts";
import type { WorkspaceDatabase } from "../src/server/workspace/database.ts";
import { WorkspaceError } from "../src/server/workspace/errors.ts";
import { DATABASE_FILE } from "../src/server/workspace/layout.ts";
import {
  defaultWorkspaceDir,
  expandHome,
  resolveWorkspaceDir,
  WORKSPACE_VARIABLE,
  WorkspaceLocationError,
} from "../src/server/workspace/location.ts";
import { type OpenWorkspace, openWorkspace } from "../src/server/workspace/open.ts";
import { parseInstant } from "../src/shared/time.ts";

const SCALE_NAMES = Object.keys(SCALES) as ScaleName[];
const OPTIONS = { scale: "value", seed: "value", now: "value", help: "switch" } as const;
/**
 * What a fill needs on the disk at its largest, with room to spare: the database, and the log
 * beside it, which grows to what the transaction of one month writes. A fill of tiny takes
 * 1.2 MB and one of small 12.6 MB. The database of full is 743 MB; its log stood at 54 MB after
 * eight months of the three years, and grew with every month.
 */
const SPACE_NEEDED: Record<ScaleName, number> = { tiny: 10e6, small: 50e6, full: 1.2e9 };
// The codes with which SQLite speaks of the disk, the memory or the file. Any other code that a
// fill ends with is a row that a guard of the schema refused: a mistake of the generator, which
// ends the command with its trace.
const OF_THE_DISK_OR_THE_FILE = /^SQLITE_(FULL|IOERR|NOMEM|CORRUPT|NOTADB|READONLY|CANTOPEN)/;

const USAGE = `Wypełnia pusty workspace danymi syntetycznymi: historią huba używanego przez pewien czas.

Użycie:
  ${WORKSPACE_VARIABLE}=<katalog> npm run synthetic -- --scale <${SCALE_NAMES.join("|")}> [opcje]

Skale:
  tiny     ${SCALES.tiny.days} dni małego huba
  small    ${SCALES.small.days} dni spokojnego zespołu
  full     ${SCALES.full.days} dni przy ${SCALES.full.capturesPerDay} wrzutkach i ${SCALES.full.notesPerDay} notatkach dziennie; trwa około dwóch minut

Opcje:
  --seed <liczba>     ziarno losowości (domyślnie ${DEFAULT_SEED}); to samo ziarno daje te same dane
  --now <chwila>      chwila, w której kończy się historia (domyślnie ${DEFAULT_NOW})
  --help              pokaż tę pomoc

Polecenie wypełnia wyłącznie workspace wskazany zmienną ${WORKSPACE_VARIABLE}, nigdy domyślny, i tylko wtedy,
gdy jego baza jest pusta i nie ma go otwartego inny proces Hubbera. Dane są zmyślone. Z niczym się nie łączy.
Kod wyjścia: 0 po wypełnieniu, 1 gdy się nie udało, 2 przy błędnych ustawieniach.`;

function usageError(message: string): never {
  console.error(`${message}\nPomoc: npm run synthetic -- --help`);
  process.exit(EXIT_USAGE);
}

/**
 * Whether two paths lead to one directory or file. Asked of the file system, which sees through
 * a link anywhere on the way, through another letter case where it folds case, and through a
 * second name of the same volume; the spellings decide only when one of the two is not there.
 */
function sameEntry(first: string, second: string): boolean {
  try {
    const [one, other] = [statSync(first, { bigint: true }), statSync(second, { bigint: true })];
    return one.dev === other.dev && one.ino === other.ino;
  } catch {
    return first === second;
  }
}

/**
 * The default place of the workspace when the directory is that place under whatever spelling,
 * or when its database is the file of the database there, reached through a link; undefined for
 * every other directory.
 *
 * Two homes are asked. The one of this environment is where the application finds its default
 * workspace. The one of the account that runs the command stays the owner's when the process was
 * started with another HOME or with none, as a coding agent starts it: without it such a process
 * would not know the owner's default place and would fill it when the variable names it.
 */
function defaultPlaceAt(dir: string): string | undefined {
  for (const home of new Set([expandHome("~", process.env), accountHome()])) {
    if (home === undefined) continue;
    const defaultDir = defaultWorkspaceDir(home);
    const same = sameEntry(dir, defaultDir) || sameEntry(join(dir, DATABASE_FILE), join(defaultDir, DATABASE_FILE));
    if (same) return defaultDir;
  }
  return undefined;
}

/** The home directory of the account, whatever the environment says; undefined where the system knows none. */
function accountHome(): string | undefined {
  try {
    const { homedir } = userInfo();
    return homedir === "" ? undefined : homedir;
  } catch {
    return undefined;
  }
}

/**
 * Takes the database for this process alone until the connection is closed, as a start that
 * brings a database up to date does: a server that has the workspace open is not handed a
 * history it did not write. False when another process has the workspace open; SQLite waits for
 * it as long as the busy timeout of the connection says before it gives up.
 */
function takeForThisProcess(database: WorkspaceDatabase): boolean {
  database.pragma("locking_mode = EXCLUSIVE");
  try {
    // The mode alone takes nothing: the lock comes with the first write transaction.
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    const { code } = error as { code?: unknown };
    if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) return false;
    throw error;
  }
  database.exec("COMMIT");
  return true;
}

function main(): void {
  // What this process writes is for the owner alone, whatever the shell's umask.
  process.umask(0o077);

  let options: Options<typeof OPTIONS>;
  try {
    options = readOptions(OPTIONS, process.argv.slice(2), process.env);
  } catch (error) {
    if (error instanceof UsageError) usageError(error.message);
    throw error;
  }
  if (options.help === true) {
    console.log(USAGE);
    return;
  }

  // Asked of everyone, and before anything else is looked at: without the variable the workspace
  // would be the default one, which is where the owner's real notes are.
  const named = process.env[WORKSPACE_VARIABLE];
  if (named === undefined || named === "") {
    console.error(
      `Polecenie wypełnia workspace danymi syntetycznymi, więc wymaga zmiennej ${WORKSPACE_VARIABLE} z katalogiem workspace'u przeznaczonego na próby. Domyślnego workspace'u nie wypełnia nigdy.`,
    );
    process.exit(EXIT_USAGE);
  }

  if (options.scale === undefined) usageError(`Podaj skalę opcją --scale: ${SCALE_NAMES.join(", ")}.`);
  if (!(SCALE_NAMES as string[]).includes(options.scale)) {
    usageError(`Niepoprawna wartość --scale: "${options.scale}". Dozwolone: ${SCALE_NAMES.join(", ")}.`);
  }
  const scale = options.scale as ScaleName;
  const seed = options.seed === undefined ? DEFAULT_SEED : Number(options.seed);
  if (options.seed !== undefined && !/^\d{1,9}$/.test(options.seed)) {
    usageError(`Niepoprawna wartość --seed: "${options.seed}". Podaj liczbę całkowitą od 0 do 999999999.`);
  }
  const now = parseInstant(options.now ?? DEFAULT_NOW);
  if (now === undefined) {
    usageError(`Niepoprawna wartość --now: "${options.now}". Podaj chwilę w zapisie ${DEFAULT_NOW}.`);
  }
  // Refused when the option is read, before a row is written: a day outside the years of the
  // database would end the fill wherever the history or a plan first reached it.
  if (now < EARLIEST_NOW || now > LATEST_NOW) {
    usageError(
      `Niepoprawna wartość --now: "${options.now}". Podaj chwilę z zakresu od ${EARLIEST_NOW} do ${LATEST_NOW}.`,
    );
  }

  let opened: OpenWorkspace;
  try {
    const dir = resolveWorkspaceDir(named, WORKSPACE_VARIABLE, process.env);
    // Before the workspace is opened: an open brings the database up to date, and a default
    // workspace that holds no row yet is one that the refusal of a database with data lets through.
    const defaultDir = defaultPlaceAt(dir);
    if (defaultDir !== undefined) {
      console.error(
        `Zmienna ${WORKSPACE_VARIABLE} wskazuje domyślny workspace ("${defaultDir}"), a tego polecenie nie wypełnia nigdy: wskaż nią katalog workspace'u przeznaczonego na próby.`,
      );
      process.exit(EXIT_USAGE);
    }
    opened = openWorkspace({ dir, source: "variable" }, process.env, undefined, {
      log: (line) => console.error(line),
    });
  } catch (error) {
    if (error instanceof WorkspaceLocationError) usageError(error.message);
    if (!(error instanceof WorkspaceError)) throw error;
    console.error(error.message);
    process.exit(error.exitCode);
  }

  const name = opened.config.name;
  const failed = (message: string): void => {
    console.error(message);
    process.exitCode = EXIT_FAILURE;
  };
  try {
    if (!takeForThisProcess(opened.database)) {
      failed(
        `Workspace „${name}” jest otwarty w innym procesie Hubbera. Zatrzymaj go i uruchom polecenie ponownie. Baza nie została zmieniona.`,
      );
      return;
    }
    const db = createDb(opened.database);
    // Asked here, with the database in hand, so that a workspace that was used is told so before
    // anything is said of the room on its disk.
    const used = usedTable(db);
    if (used !== undefined) {
      failed(
        `Workspace „${name}” zawiera już dane (tabela ${used}). Dane syntetyczne trafiają wyłącznie do pustej bazy: utwórz nowy workspace poleceniem "npm run workspace:create".`,
      );
      return;
    }
    const { bavail, bsize } = statfsSync(opened.paths.database);
    if (bavail * bsize < SPACE_NEEDED[scale]) {
      failed(
        `Wypełnienie workspace'u „${name}” w skali ${scale} potrzebuje około ${megabytes(SPACE_NEEDED[scale])} wolnego miejsca na dysku, a wolne jest ${megabytes(bavail * bsize)}. Danych nie zapisano.`,
      );
      return;
    }

    const started = performance.now();
    const { rows, days } = generateSynthetic(db, { scale, seed, now: new Date(now) });
    const written = DATA_TABLES.reduce((sum, table) => sum + (rows[table] ?? 0), 0);
    console.log(
      `Wypełniono workspace „${name}”: ${written} wierszy, ${days} dni historii, ${seconds(performance.now() - started)}.`,
    );
  } catch (error) {
    const { code } = error as { code?: unknown };
    if (typeof code !== "string" || !OF_THE_DISK_OR_THE_FILE.test(code)) throw error;
    // A history is written a month a transaction: the months before the one that failed are in the database.
    const why = code.startsWith("SQLITE_FULL") ? ", bo na dysku zabrakło miejsca" : "";
    failed(
      `Wypełnianie workspace'u „${name}” przerwał błąd bazy (${code})${why}. To, co zapisano wcześniej, zostało w bazie, więc workspace może nie być już pusty: usuń jego katalog i utwórz nowy poleceniem "npm run workspace:create".`,
    );
  } finally {
    opened.close();
  }
}

main();
