import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { READS } from "../src/server/db/perf/reads.ts";
import { type Exit, spawnNode } from "../src/server/testing.ts";

const SCRIPT = "scripts/perf.ts";
const SPAWN_TIMEOUT_MS = 60_000;
const HELP_LINE = "Pomoc: npm run perf -- --help";

// Loaded into the command ahead of its own code. The moment the command has made the directory
// of its workspace, it sends the process the signal that a terminal sends on Ctrl-C.
const INTERRUPT_AT_THE_START = `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const { mkdtempSync } = fs;
fs.mkdtempSync = (...args) => {
  const made = mkdtempSync(...args);
  if (String(made).includes("hubber-perf-")) process.kill(process.pid, "SIGINT");
  return made;
};
syncBuiltinESMExports();
`;

// Loaded into the command ahead of its own code, it makes the machine one that is too busy to
// measure on: a row of a file, which is all that a reference commit writes, takes a while longer.
// It also writes down, in their order, two things that the command does to its database: such a
// row is written, and the table of operations is built anew, which is how the last start that
// migrates ends.
const busyMachine = (into: string): string => `import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const Database = createRequire(${JSON.stringify(import.meta.filename)})("better-sqlite3");
const { prepare } = Database.prototype;
const seen = [];
Database.prototype.prepare = function (source) {
  const statement = prepare.call(this, source);
  const what = /^insert into "files"/i.test(source) ? "file" : /RENAME TO operations$/.test(source) ? "rebuild" : undefined;
  if (what !== undefined) {
    const { run } = statement;
    statement.run = function (...values) {
      seen.push(what);
      for (const until = performance.now() + (what === "file" ? 12 : 0); performance.now() < until; );
      return run.apply(this, values);
    };
  }
  return statement;
};
process.on("exit", () => writeFileSync(${JSON.stringify(into)}, seen.join("\\n")));
`;

interface RunResult extends Exit {
  stdout: string;
  stderr: string;
  /** The temporary directory that the command was given: all it may write to. */
  temp: string;
}

const children: ChildProcess[] = [];
let work: string;
let counter = 0;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "hubber-perf-command-"));
});

afterAll(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  rmSync(work, { recursive: true, force: true });
});

/** A temporary directory for one run of the command, empty but for what the test puts there. */
function tempDir(): string {
  const dir = join(work, `tmp-${++counter}`);
  mkdirSync(dir);
  return dir;
}

async function run(
  args: readonly string[],
  {
    temp = tempDir(),
    env = {},
    nodeArgs = [],
  }: { temp?: string; env?: Record<string, string>; nodeArgs?: string[] } = {},
): Promise<RunResult> {
  const script = spawnNode(SCRIPT, { args, env: { TMPDIR: temp, ...env }, nodeArgs });
  children.push(script.child);
  const exit = await script.exited;
  return { ...exit, stdout: script.stdout(), stderr: script.stderr(), temp };
}

describe("scripts/perf.ts", { timeout: SPAWN_TIMEOUT_MS }, () => {
  describe("a measurement of the smallest world without budgets", () => {
    let result: RunResult;
    let elsewhere: string;
    let leftLongAgo: string;
    let leftJustNow: string;
    /** What lies in the temporary directory under a name of the same beginning, and is no workspace of a run. */
    const NOT_OF_A_RUN = ["hubber-perf-dowiazanie", "hubber-perf-notatki-z-pomiarow", "hubber-perf-wynik-full.txt"];

    beforeAll(async () => {
      const temp = tempDir();
      // What two earlier runs left behind when they were killed: one hours ago, one a moment ago,
      // which may still be running.
      leftLongAgo = join(temp, "hubber-perf-dawny");
      leftJustNow = join(temp, "hubber-perf-nowy");
      for (const left of [leftLongAgo, leftJustNow]) {
        mkdirSync(join(left, "workspace"), { recursive: true });
        writeFileSync(join(left, "workspace", "hubber.sqlite"), "x");
      }
      const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
      utimesSync(leftLongAgo, twoHoursAgo, twoHoursAgo);
      // As old as that, and none of them made by a run: a result that was saved beside the
      // measurement, a directory of notes, and a link to a directory that does hold a workspace.
      const elsewhereWithAWorkspace = join(work, "cudzy-katalog");
      mkdirSync(join(elsewhereWithAWorkspace, "workspace"), { recursive: true });
      writeFileSync(join(temp, "hubber-perf-wynik-full.txt"), "Wynik: wszystkie budżety dotrzymane.\n");
      mkdirSync(join(temp, "hubber-perf-notatki-z-pomiarow", "2026"), { recursive: true });
      writeFileSync(join(temp, "hubber-perf-notatki-z-pomiarow", "2026", "pazdziernik.md"), "notatki\n");
      symlinkSync(elsewhereWithAWorkspace, join(temp, "hubber-perf-dowiazanie"));
      for (const name of NOT_OF_A_RUN) lutimesSync(join(temp, name), twoHoursAgo, twoHoursAgo);
      utimesSync(elsewhereWithAWorkspace, twoHoursAgo, twoHoursAgo);
      elsewhere = join(work, "workspace-ze-zmiennej");
      result = await run(["--scale", "tiny", "--no-budgets"], {
        temp,
        // Neither is read: the workspace of the measurement is the command's own, pinned to an
        // address of its own, whatever the shell names.
        env: { HUBBER_WORKSPACE: elsewhere, ANTHROPIC_BASE_URL: "https://router.corp.example/llm" },
      });
    });

    it("runs to the end and says so", () => {
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(
        /\nPomiar wydajności bazy: skala tiny \(5 dni historii\), ziarno 1, bez budżetów\.\nWorkspace roboczy: ".+" \(usuwany po pomiarze\)\.\n/,
      );
      // Said before the one stretch of the run that no signal interrupts.
      expect(result.stdout).toContain(
        "\nGeneruję dane w skali tiny; w skali full trwa to około dwóch minut, a Ctrl-C zadziała dopiero po zakończeniu generowania.\n\nGenerowanie danych ",
      );
      expect(result.stdout).toMatch(/\nWynik: pomiar bez budżetów\.\n$/);
    });

    it("measures every scenario, and every representative read by its name", () => {
      // A scenario has its name at the start of a line, and what was measured in a column after it.
      const scenarios = result.stdout.split("\n").flatMap((line) => /^(\S.*?) {2,}\S/.exec(line)?.[1] ?? []);

      expect(scenarios).toEqual([
        "Generowanie danych",
        "Zapis wrzutki (jedna transakcja)",
        "Odłożenie jednej operacji",
        "Zatwierdzenie przebiegu (7 operacji)",
        `Odczyty (${READS.length}), najwolniejszy`,
        "Kopia bazy (VACUUM INTO)",
        "Start z migracją: nowa kolumna operacji",
        "Start z migracją: przebudowa operacji",
      ]);
      const reads = result.stdout.split("\n").filter((line) => / wierszy {2}/.test(line));
      expect(reads.map((line) => line.replace(/^.* wierszy {2}/, "").replace(/ {2}\(.*\)$/, ""))).toEqual(
        READS.map(({ name }) => name),
      );
      expect(result.stdout).toContain("  Reguły danych: bez naruszeń; klucze obce: bez naruszeń.\n");
    });

    it("says of two reads that they have no budget, and of one that its time grows with the history", () => {
      const labelled = result.stdout
        .split("\n")
        .flatMap((line) => / wierszy {2}(.+?) {2}\((.+)\)$/.exec(line)?.slice(1, 3).join(" | ") ?? []);

      expect(labelled).toEqual([
        "item: all its facts, with their source | bez budżetu: czytany stronami",
        "item: the whole history of the changes of its fields | bez budżetu: czytany stronami",
        "costs: the tokens of the last thirty days, by day and role | czyta całą tabelę: czas rośnie z historią",
      ]);
    });

    it("judges nothing: no scenario is held to its budget", () => {
      expect(result.stdout).not.toMatch(/w budżecie|BUDŻET PRZEKROCZONY|budżety dotrzymane|zbyt zajęta, żeby/);
    });

    it("works in a workspace of its own in the temporary directory, and removes it", () => {
      const dir = /^Workspace roboczy: "(.+)" \(usuwany po pomiarze\)\.$/m.exec(result.stdout)?.[1] ?? "";

      expect(dir.startsWith(join(result.temp, "hubber-perf-"))).toBe(true);
      expect(dir.endsWith("/workspace")).toBe(true);
      expect(existsSync(join(dir, ".."))).toBe(false);
      // The workspace that the variable names was not made, not opened and not asked about.
      expect(existsSync(elsewhere)).toBe(false);
    });

    it("removes what a killed run left behind hours ago, and leaves what may still be running", () => {
      expect(result.stdout).toContain(`Usunięto katalog po przerwanym pomiarze: "${leftLongAgo}".\n`);
      expect(readdirSync(result.temp).sort()).toEqual([...NOT_OF_A_RUN, "hubber-perf-nowy"].sort());
      expect(existsSync(join(leftJustNow, "workspace", "hubber.sqlite"))).toBe(true);
    });

    it("removes nothing else, whatever it is called and however old it is: only a directory that holds a workspace is a run's", () => {
      expect(result.stdout.match(/Usunięto katalog po przerwanym pomiarze/g)).toHaveLength(1);
      expect(existsSync(join(result.temp, "hubber-perf-notatki-z-pomiarow", "2026", "pazdziernik.md"))).toBe(true);
      // The link is there, and so is what it leads to.
      expect(existsSync(join(result.temp, "hubber-perf-dowiazanie", "workspace"))).toBe(true);
    });
  });

  describe("a measurement of the smallest world with budgets", () => {
    const SCENARIOS = 8;
    const VERDICTS: [said: RegExp, code: number][] = [
      [/^Wynik: wszystkie budżety dotrzymane\.$/, 0],
      [/^Wynik: przekroczone budżety \((\d+)\): (.+)\.$/, 1],
      [/^Wynik: maszyna była zbyt zajęta, żeby ten pomiar coś znaczył\. Powtórz go na spokojnej maszynie\.$/, 4],
    ];
    let result: RunResult;
    let busy: RunResult;
    let writes: string[];

    beforeAll(async () => {
      const order = join(work, "kolejnosc.txt");
      const preload = join(work, "busy.mjs");
      writeFileSync(preload, busyMachine(order));
      [result, busy] = await Promise.all([
        run(["--scale", "tiny"]),
        run(["--scale", "tiny"], { nodeArgs: ["--import", pathToFileURL(preload).href] }),
      ]);
      writes = readFileSync(order, "utf8").split("\n");
    }, SPAWN_TIMEOUT_MS);

    // Which of the three verdicts it is depends on the machine, and is not asked: a budget is a
    // matter of time. What is asked is that the command says one thing in all its ways.
    it("ends with a verdict, and with the exit code that says the same", () => {
      const last = result.stdout.trimEnd().split("\n").at(-1) ?? "";
      const verdict = VERDICTS.find(([said]) => said.test(last));

      expect(result.stderr).toBe("");
      expect(verdict, last).toBeDefined();
      expect(result.code).toBe(verdict?.[1]);
    });

    it("says of every scenario whether it kept to its budget, and names in its verdict the ones that did not", () => {
      const lines = result.stdout.trimEnd().split("\n");
      const judged = lines.filter((line) => /^\S.* {2,}(w budżecie|BUDŻET PRZEKROCZONY)$/.test(line));
      const exceeded = judged
        .filter((line) => line.endsWith("BUDŻET PRZEKROCZONY"))
        .map((line) => /^(\S.*?) {2,}\S/.exec(line)?.[1]);
      const named = VERDICTS[1]?.[0].exec(lines.at(-1) ?? "");

      expect(judged).toHaveLength(SCENARIOS);
      if (named !== null && named !== undefined) {
        expect(named[2]?.split("; ")).toEqual(exceeded);
        expect(Number(named[1])).toBe(exceeded.length);
      } else if (result.code === 0) expect(exceeded).toEqual([]);
    });

    it("says that the machine was too busy when its reference commits were slow, with a code of its own", () => {
      const lines = busy.stdout.trimEnd().split("\n");

      expect(lines.at(-1)).toMatch(VERDICTS[2]?.[0] as RegExp);
      const medians = /^Zatwierdzenie odniesienia: mediana ([\d,]+) ms przed pomiarem i ([\d,]+) ms po nim /.exec(
        lines.at(-2) ?? "",
      );
      for (const median of medians?.slice(1) ?? [""]) expect(Number(median.replace(",", "."))).toBeGreaterThan(9);
      expect(busy.stderr).toBe("");
      expect(busy.code).toBe(4);
      expect(readdirSync(busy.temp)).toEqual([]);
    });

    it("takes its reference commits before everything it measures and after everything, the starts that migrate included", () => {
      const rebuilt = writes.lastIndexOf("rebuild");

      expect(rebuilt).toBeGreaterThan(0);
      // Fifty rows of files, each a commit of its own, and nothing else is written behind them.
      expect(writes.slice(rebuilt + 1)).toEqual(Array.from({ length: 50 }, () => "file"));
    });
  });

  describe("a measurement that is interrupted", () => {
    it("ends between two scenarios, says so, and removes its workspace", async () => {
      const preload = join(work, "interrupt.mjs");
      writeFileSync(preload, INTERRUPT_AT_THE_START);

      const result = await run(["--scale", "tiny", "--no-budgets"], {
        nodeArgs: ["--import", pathToFileURL(preload).href],
      });

      expect(result.stderr).toBe("Pomiar przerwany.\n");
      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();
      // The world was generated, which no signal interrupts; nothing after it was begun.
      expect(result.stdout).toContain("Generowanie danych");
      expect(result.stdout).not.toContain("Zapis wrzutki");
      expect(readdirSync(result.temp)).toEqual([]);
    });
  });

  describe("with options that it cannot use", () => {
    const CASES: [args: string[], message: string][] = [
      [["--scale", "huge"], 'Niepoprawna wartość --scale: "huge". Dozwolone: tiny, small, full.'],
      [
        ["--scale", "tiny", "--seed", "1.5"],
        'Niepoprawna wartość --seed: "1.5". Podaj liczbę całkowitą od 0 do 999999999.',
      ],
      [["--scale", "tiny", "--budgets"], "Nieznana opcja: --budgets."],
    ];
    let results: RunResult[];
    let help: RunResult;

    beforeAll(async () => {
      [help, ...results] = (await Promise.all([run(["--help"]), ...CASES.map(([args]) => run(args))])) as [
        RunResult,
        ...RunResult[],
      ];
    });

    it.each(CASES.map(([args, message], at) => [args, message, at] as const))(
      "says what is wrong with %j, and makes no workspace",
      (_args, message, at) => {
        const result = results[at] as RunResult;

        expect(result.stderr).toBe(`${message}\n${HELP_LINE}\n`);
        expect(result.stdout).toBe("");
        expect(result.code).toBe(2);
        expect(readdirSync(result.temp)).toEqual([]);
      },
    );

    it("explains itself with --help, and measures nothing", () => {
      expect(help.stderr).toBe("");
      expect(help.stdout).toMatch(/^Mierzy czasy zapisu, zapytań, kopii i migracji bazy na danych syntetycznych\./);
      expect(help.stdout).toContain("--no-budgets");
      // What the budgets are for, and everything that the exit code of a failed run can mean.
      expect(help.stdout).toContain("\nBudżety są ustalone dla skali full.");
      expect(help.stdout).toContain(
        "1, gdy któryś został przekroczony, a także gdy pomiaru\nnie dało się wykonać albo dokończyć (za mało wolnego miejsca, przerwanie, wygenerowane dane łamią\nreguły schematu, błąd w trakcie pomiaru);",
      );
      expect(help.code).toBe(0);
      expect(readdirSync(help.temp)).toEqual([]);
    });
  });
});
