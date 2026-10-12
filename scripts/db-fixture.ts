// Writes the database that the tests of later migrations start from: a small synthetic world at
// the newest version of the schema, as a copy of a workspace's database, compressed. The
// generator only ever writes the newest schema, so this file has to be written while its
// version is the newest one: once the next migration exists, nothing can make it again.
//
// The same command gives the same file, byte for byte: the world has a fixed seed and "now", and
// so have the workspace it is generated in and the record of its migrations.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { createDb } from "../src/server/db/handle.ts";
import {
  MIGRATIONS_DIR,
  type Migration,
  MigrationFilesError,
  migrateDatabase,
  readMigrations,
} from "../src/server/db/migrate.ts";
import { type Options, readOptions, THROWAWAY_PROFILE, UsageError } from "../src/server/db/synthetic/command-line.ts";
import {
  checkInvariants,
  DATA_TABLES,
  DEFAULT_NOW,
  DEFAULT_SEED,
  generateSynthetic,
} from "../src/server/db/synthetic/index.ts";
import { EXIT_FAILURE, EXIT_USAGE } from "../src/server/exit-codes.ts";
import { createWorkspace } from "../src/server/workspace/create.ts";
import {
  createWorkspaceDatabase,
  openWorkspaceDatabase,
  snapshotWorkspaceDatabase,
} from "../src/server/workspace/database.ts";
import { unusableMigrations, WorkspaceError } from "../src/server/workspace/errors.ts";
import { openWorkspace } from "../src/server/workspace/open.ts";

const OPTIONS = { dir: "value", help: "switch" } as const;
const HELP_LINE = "Pomoc: npm run db:fixture -- --help";
/** Where the databases of earlier versions are kept: beside the migrations, where their test looks for them. */
const FIXTURES_DIR = join(MIGRATIONS_DIR, "..", "fixtures");

const USAGE = `Zapisuje małą wypełnioną bazę bieżącej wersji schematu do testów kolejnych migracji.

Użycie:
  npm run db:fixture [-- opcje]

Opcje:
  --dir <katalog>   gdzie zapisać plik (domyślnie src/server/db/fixtures)
  --help            pokaż tę pomoc

Plik nazywa się after-<ostatnia migracja>.sqlite.gz i powstaje raz, gdy jego wersja schematu jest
najnowsza: polecenie nie nadpisuje pliku, który już istnieje. Te same dane dają ten sam plik.
Kod wyjścia: 0 po zapisaniu, 1 gdy plik istnieje albo zapis się nie udał, 2 przy błędnych opcjach.`;

function main(): number {
  process.umask(0o077);
  let options: Options<typeof OPTIONS>;
  try {
    options = readOptions(OPTIONS, process.argv.slice(2), process.env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n${HELP_LINE}`);
    return EXIT_USAGE;
  }
  if (options.help === true) {
    console.log(USAGE);
    return 0;
  }

  let head: Migration | undefined;
  try {
    head = readMigrations().at(-1);
  } catch (error) {
    // The state of whoever writes a migration and runs this command before the manifest follows the file.
    if (!(error instanceof MigrationFilesError)) throw error;
    console.error(`Nie udało się zapisać bazy do testów migracji: ${unusableMigrations(error)}`);
    return EXIT_FAILURE;
  }
  if (head === undefined) throw new Error("There is no migration to write a database for.");
  const directory = options.dir === undefined ? FIXTURES_DIR : resolve(options.dir);
  // Looked at before anything is made: a directory that is not there yet is made at the end.
  if (statSync(directory, { throwIfNoEntry: false })?.isDirectory() === false) {
    console.error(`Niepoprawna wartość --dir: "${directory}" nie jest katalogiem.\n${HELP_LINE}`);
    return EXIT_USAGE;
  }
  const target = join(directory, `after-${head.tag}.sqlite.gz`);
  // Looked at first, and asked again by the write itself: a database of a version is written once.
  if (existsSync(target)) {
    console.error(
      `Plik "${target}" już istnieje. Baza wersji ${head.tag} jest zapisywana raz i polecenie jej nie nadpisuje; jeśli migracja ${head.tag} nie trafiła jeszcze do gałęzi main i ma powstać od nowa, najpierw usuń ten plik.`,
    );
    return EXIT_FAILURE;
  }

  const now = new Date(DEFAULT_NOW);
  const base = mkdtempSync(join(tmpdir(), "hubber-fixture-"));
  const dir = join(base, "workspace");
  try {
    createWorkspace(
      { dir, name: "Baza do testów migracji", profile: THROWAWAY_PROFILE },
      {
        // Everything that the file records of its making has the instant of the world, not of
        // the clock: the pin of the workspace, and the record of the migrations.
        now: () => now,
        createDatabase: (file, pin) => {
          createWorkspaceDatabase(file, pin);
          const database = openWorkspaceDatabase(file, pin.endpoint);
          try {
            migrateDatabase(database, { snapshotDir: null, now: () => now });
          } finally {
            database.close();
          }
        },
      },
    );
    const opened = openWorkspace({ dir, source: "variable" }, {});
    let rows: number;
    const copy = join(base, "copy.sqlite");
    try {
      const db = createDb(opened.database);
      const world = generateSynthetic(db, { scale: "tiny", seed: DEFAULT_SEED, now });
      const broken = checkInvariants(db);
      if (broken.length > 0) throw new Error(`The generated world breaks its own rules: ${broken.join(", ")}.`);
      rows = DATA_TABLES.reduce((sum, table) => sum + (world.rows[table] ?? 0), 0);
      // One file without a log beside it, which a test opens from its bytes.
      snapshotWorkspaceDatabase(opened.database, copy);
    } finally {
      opened.close();
    }
    const bytes = gzipSync(readFileSync(copy), { level: 9 });
    // The header of the compressed file names the system it was written on: the one byte that
    // would differ between two machines says "unknown" instead.
    bytes[9] = 255;
    // A file of the repository, readable like the sources beside it: everything else this command
    // makes is for the owner alone.
    process.umask(0o022);
    try {
      mkdirSync(directory, { recursive: true });
      // "wx": never over a file that appeared in the meantime.
      writeFileSync(target, bytes, { flag: "wx", mode: 0o644 });
    } catch (error) {
      // What the system says of the place: no access, a name that is taken, a disk that is full.
      const { code, syscall } = error as NodeJS.ErrnoException;
      if (typeof code !== "string" || typeof syscall !== "string") throw error;
      console.error(`Nie udało się zapisać pliku "${target}" (${code}).`);
      return EXIT_FAILURE;
    }
    console.log(
      `Zapisano bazę wersji ${head.tag} do testów migracji: "${target}" (${rows} wierszy, ${Math.ceil(bytes.length / 1_000)} kB).`,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
    console.error(error.message);
    return error.exitCode;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

process.exitCode = main();
