// Measures how long the database takes for what the application does with it, on synthetic
// history at the scale of three years: saving a capture, staging and committing a run, the reads
// of the views, a copy of the database, a start that migrates. It works on a workspace of its
// own in the temporary directory, which it creates and removes, never reads HUBBER_WORKSPACE,
// and connects nowhere. Outside "npm run check": times depend on the machine.
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, statfsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/server/db/handle.ts";
import { READS } from "../src/server/db/perf/reads.ts";
import {
  BUDGETS,
  type Budgeted,
  judge,
  type Measured,
  measureMigrations,
  measureReads,
  measureReferenceCommits,
  measureSnapshot,
  measureWrites,
  outcomeOf,
  type Target,
  type Timing,
  timed,
} from "../src/server/db/perf/scenarios.ts";
import {
  megabytes,
  type Options,
  readOptions,
  seconds,
  THROWAWAY_PROFILE,
  UsageError,
} from "../src/server/db/synthetic/command-line.ts";
import {
  checkInvariants,
  DATA_TABLES,
  DEFAULT_SEED,
  generateSynthetic,
  SCALES,
  type ScaleName,
} from "../src/server/db/synthetic/index.ts";
import { EXIT_FAILURE, EXIT_USAGE } from "../src/server/exit-codes.ts";
import { createWorkspace } from "../src/server/workspace/create.ts";
import { WorkspaceError } from "../src/server/workspace/errors.ts";
import { type OpenWorkspace, openWorkspace } from "../src/server/workspace/open.ts";

const SCALE_NAMES = Object.keys(SCALES) as ScaleName[];
const OPTIONS = { scale: "value", seed: "value", "no-budgets": "switch", help: "switch" } as const;
/** How often each write scenario and each read is repeated. */
const ROUNDS: Record<ScaleName, { writes: number; reads: number }> = {
  tiny: { writes: 10, reads: 5 },
  small: { writes: 40, reads: 15 },
  full: { writes: 200, reads: 30 },
};

const USAGE = `Mierzy czasy zapisu, zapytań, kopii i migracji bazy na danych syntetycznych.

Użycie:
  npm run perf [-- opcje]

Opcje:
  --scale <${SCALE_NAMES.join("|")}>   wielkość danych (domyślnie full: ${SCALES.full.days} dni historii)
  --seed <liczba>             ziarno losowości (domyślnie ${DEFAULT_SEED})
  --no-budgets                tylko pomiar: bez porównania z budżetami i bez oceny obciążenia maszyny
  --help                      pokaż tę pomoc

Polecenie tworzy jednorazowy workspace w katalogu tymczasowym (dla skali full potrzeba około 4 GB
wolnego miejsca) i usuwa go po pomiarze. Nie czyta zmiennej HUBBER_WORKSPACE i z niczym się nie łączy.
Budżety są ustalone dla skali full. W skali tiny zapis wrzutki i zatwierdzenie przebiegu mają po
${ROUNDS.tiny.writes} prób, więc ich 95. percentyl jest najwolniejszą z nich i jedna wolna próba przekracza budżet.
Kod wyjścia: 0, gdy budżety są dotrzymane; 1, gdy któryś został przekroczony, a także gdy pomiaru
nie dało się wykonać albo dokończyć (za mało wolnego miejsca, przerwanie, wygenerowane dane łamią
reguły schematu, błąd w trakcie pomiaru); 4, gdy maszyna była zbyt zajęta, żeby wynik coś znaczył;
2 przy błędnych opcjach.`;

/** What the run needs on the disk at its largest: the database, a copy of it, and what a rebuild writes beside both. */
const SPACE_NEEDED: Record<ScaleName, number> = { tiny: 100e6, small: 300e6, full: 4e9 };
/** The names of the workspaces of this command, and how long one may lie before it counts as left behind by a run that was killed. */
const WORK_PREFIX = "hubber-perf-";
const WORKSPACE_NAME = "workspace";
const LEFT_BEHIND_AFTER_MS = 3_600_000;
/** The scenarios that have a budget, as the owner reads them. */
const SCENARIOS: Record<Budgeted, string> = {
  generation: "Generowanie danych",
  saveCapture: "Zapis wrzutki (jedna transakcja)",
  stageOperation: "Odłożenie jednej operacji",
  commitRun: "Zatwierdzenie przebiegu (7 operacji)",
  read: `Odczyty (${READS.length}), najwolniejszy`,
  snapshot: "Kopia bazy (VACUUM INTO)",
  addColumn: "Start z migracją: nowa kolumna operacji",
  rebuild: "Start z migracją: przebudowa operacji",
};

const milliseconds = (value: number): string =>
  `${value.toFixed(value < 10 ? 2 : value < 100 ? 1 : 0).replace(".", ",")} ms`;

function usageError(message: string): never {
  console.error(`${message}\nPomoc: npm run perf -- --help`);
  process.exit(EXIT_USAGE);
}

/**
 * Removes the workspaces that earlier runs of this command left in the temporary directory when
 * they were killed. Only what a run makes is taken for one: a directory of that beginning of a
 * name, itself and no link to one, that holds a workspace. Whatever else is called so stays, a
 * result that was saved beside the measurement for one.
 */
function removeLeftBehind(): void {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(WORK_PREFIX)) continue;
    const path = join(tmpdir(), name);
    try {
      const entry = lstatSync(path);
      if (!entry.isDirectory() || !existsSync(join(path, WORKSPACE_NAME))) continue;
      if (Date.now() - entry.mtimeMs < LEFT_BEHIND_AFTER_MS) continue;
      rmSync(path, { recursive: true, force: true });
      console.log(`Usunięto katalog po przerwanym pomiarze: "${path}".`);
    } catch {
      // Gone already, or not to be removed: neither stands in the way of this run.
    }
  }
}

async function main(): Promise<number> {
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
    return 0;
  }
  const scale = options.scale ?? "full";
  if (!(SCALE_NAMES as string[]).includes(scale)) {
    usageError(`Niepoprawna wartość --scale: "${scale}". Dozwolone: ${SCALE_NAMES.join(", ")}.`);
  }
  const scaleName = scale as ScaleName;
  if (options.seed !== undefined && !/^\d{1,9}$/.test(options.seed)) {
    usageError(`Niepoprawna wartość --seed: "${options.seed}". Podaj liczbę całkowitą od 0 do 999999999.`);
  }
  const seed = options.seed === undefined ? DEFAULT_SEED : Number(options.seed);
  const withBudgets = options["no-budgets"] !== true;
  const rounds = ROUNDS[scaleName];

  removeLeftBehind();
  const { bavail, bsize } = statfsSync(tmpdir());
  if (bavail * bsize < SPACE_NEEDED[scaleName]) {
    console.error(
      `Pomiar w skali ${scaleName} potrzebuje około ${megabytes(SPACE_NEEDED[scaleName])} wolnego miejsca w katalogu tymczasowym "${tmpdir()}", a wolne jest ${megabytes(bavail * bsize)}.`,
    );
    return EXIT_FAILURE;
  }

  // The scenarios are synchronous, so a signal is noticed between two of them: the run then ends
  // there, and its workspace is removed like after any other end.
  let stopped = false;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      stopped = true;
    });
  }
  class Stopped extends Error {}
  const breathe = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (stopped) throw new Stopped();
  };

  /** What was measured so far, and how a scenario of it stands against its budget. */
  const measured: Partial<Measured> = {};
  const judged = (scenario: Budgeted) => judge(measured).find((judgement) => judgement.scenario === scenario);
  /** The line of a scenario: what it took, what it may take, and whether it kept to that. */
  const line = (scenario: Budgeted, took: string, limit: string): void => {
    const within = judged(scenario)?.within;
    const verdict = !withBudgets || within === undefined ? "" : within ? "w budżecie" : "BUDŻET PRZEKROCZONY";
    console.log(`${SCENARIOS[scenario].padEnd(42)} ${took.padEnd(40)} ${limit.padEnd(24)} ${verdict}`.trimEnd());
  };
  const timingLine = (scenario: Budgeted, timing: Timing, limit: number): void =>
    line(
      scenario,
      `mediana ${milliseconds(timing.median)}, p95 ${milliseconds(timing.p95)}`,
      `p95 do ${milliseconds(limit)}`,
    );

  const base = mkdtempSync(join(tmpdir(), WORK_PREFIX));
  const dir = join(base, WORKSPACE_NAME);
  let opened: OpenWorkspace | undefined;
  try {
    console.log(
      `Pomiar wydajności bazy: skala ${scaleName} (${SCALES[scaleName].days} dni historii), ziarno ${seed}${withBudgets ? "" : ", bez budżetów"}.`,
    );
    console.log(`Workspace roboczy: "${dir}" (usuwany po pomiarze).`);
    // The scenarios are synchronous, and the generation is the longest of them by far.
    console.log(
      `Generuję dane w skali ${scaleName}; w skali full trwa to około dwóch minut, a Ctrl-C zadziała dopiero po zakończeniu generowania.\n`,
    );
    createWorkspace({ dir, name: "Pomiar wydajności", profile: THROWAWAY_PROFILE });
    // No environment is handed in: the workspace of the measurement is opened whatever endpoint the shell declares.
    opened = openWorkspace({ dir, source: "variable" }, {});
    const connection = opened.database;
    const db = createDb(connection);

    const [world, generation] = timed(() => generateSynthetic(db, { scale: scaleName, seed }));
    measured.generation = generation;
    line("generation", seconds(generation), `do ${seconds(BUDGETS.generation)}`);
    // The log is folded into the file, so that the first write measured does not pay for it.
    connection.pragma("wal_checkpoint(TRUNCATE)");
    const written = DATA_TABLES.reduce((sum, table) => sum + (world.rows[table] ?? 0), 0);
    console.log(
      `  ${written} wierszy w ${DATA_TABLES.length} tabelach; plik bazy ${megabytes(statSync(opened.paths.database).size)}.`,
    );
    await breathe();
    const broken = checkInvariants(db);
    const dangling = (connection.pragma("foreign_key_check") as unknown[]).length;
    console.log(
      `  Reguły danych: ${broken.length === 0 ? "bez naruszeń" : `NARUSZONE (${broken.join(", ")})`}; klucze obce: ${dangling === 0 ? "bez naruszeń" : `${dangling} naruszeń`}.`,
    );
    if (broken.length > 0 || dangling > 0) {
      console.error(
        "\nWygenerowane dane łamią reguły schematu: to błąd generatora, a pomiar na takich danych nic nie znaczy.",
      );
      return EXIT_FAILURE;
    }
    await breathe();

    const target: Target = { db, connection, file: opened.paths.database, backups: opened.paths.backups, world };
    const commitsBefore = measureReferenceCommits(target);
    await breathe();

    const writes = measureWrites(target, rounds.writes);
    measured.writes = writes;
    timingLine("saveCapture", writes.saveCapture, BUDGETS.saveCapture);
    timingLine("stageOperation", writes.stageOperation, BUDGETS.stageOperation);
    timingLine("commitRun", writes.commitRun, BUDGETS.commitRun);
    await breathe();

    const reads = measureReads(target, rounds.reads);
    measured.reads = reads;
    const slowest = judged("read")?.took;
    line(
      "read",
      slowest === undefined ? "" : `mediana ${milliseconds(slowest)}`,
      `mediana do ${milliseconds(BUDGETS.read)}`,
    );
    for (const read of reads) {
      const label = read.unbounded
        ? "  (bez budżetu: czytany stronami)"
        : read.wholeHistory
          ? "  (czyta całą tabelę: czas rośnie z historią)"
          : "";
      console.log(
        `  ${milliseconds(read.timing.median).padStart(10)}  p95 ${milliseconds(read.timing.p95).padStart(10)}  ${String(read.rows).padStart(6)} wierszy  ${read.name}${label}`,
      );
    }
    await breathe();

    const snapshot = measureSnapshot(target);
    measured.snapshot = snapshot.milliseconds;
    line(
      "snapshot",
      `${seconds(snapshot.milliseconds)}, ${megabytes(snapshot.bytes)}`,
      `do ${seconds(BUDGETS.snapshot)}`,
    );
    await breathe();

    const migrations = measureMigrations(target);
    measured.migrations = migrations;
    line("addColumn", `${seconds(migrations.addColumn)} (z kopią bazy)`, `do ${seconds(BUDGETS.migration)}`);
    line("rebuild", `${seconds(migrations.rebuild)} (z kopią bazy)`, `do ${seconds(BUDGETS.migration)}`);
    // After the last scenario, so that the two measurements of the machine have every scenario between them.
    const commitsAfter = measureReferenceCommits(target);

    console.log(
      `\nZatwierdzenie odniesienia: mediana ${milliseconds(commitsBefore.median)} przed pomiarem i ${milliseconds(commitsAfter.median)} po nim (maszyna zbyt zajęta powyżej ${milliseconds(BUDGETS.referenceCommit)}).`,
    );
    if (!withBudgets) {
      console.log("Wynik: pomiar bez budżetów.");
      return 0;
    }
    const { verdict, exceeded, exitCode } = outcomeOf([commitsBefore, commitsAfter], judge(measured));
    console.log(
      verdict === "busy"
        ? "Wynik: maszyna była zbyt zajęta, żeby ten pomiar coś znaczył. Powtórz go na spokojnej maszynie."
        : verdict === "exceeded"
          ? `Wynik: przekroczone budżety (${exceeded.length}): ${exceeded.map((scenario) => SCENARIOS[scenario]).join("; ")}.`
          : "Wynik: wszystkie budżety dotrzymane.",
    );
    return exitCode;
  } catch (error) {
    if (error instanceof Stopped) {
      console.error("Pomiar przerwany.");
      return EXIT_FAILURE;
    }
    if (error instanceof WorkspaceError) {
      console.error(error.message);
      return error.exitCode;
    }
    throw error;
  } finally {
    opened?.close();
    rmSync(base, { recursive: true, force: true });
    if (existsSync(base)) console.error(`Nie udało się usunąć katalogu roboczego "${base}".`);
  }
}

process.exitCode = await main();
