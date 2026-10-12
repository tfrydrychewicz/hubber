import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/server/db/handle.ts";
import {
  checkInvariants,
  contentHash,
  DATA_TABLES,
  generateSynthetic,
  usedTable,
} from "../src/server/db/synthetic/index.ts";
import { createSyntheticTestDatabase } from "../src/server/db/synthetic/testing.ts";
import { createTestDatabase } from "../src/server/db/testing.ts";
import { type Exit, spawnNode, TEST_WORKSPACE } from "../src/server/testing.ts";
import { createWorkspace } from "../src/server/workspace/create.ts";
import { createWorkspaceDatabase } from "../src/server/workspace/database.ts";
import { openWorkspace } from "../src/server/workspace/open.ts";
import {
  createTestWorkspace,
  createTestWorkspaceAt,
  createUnmigratedTestWorkspace,
  TEST_PROFILE,
  type TestWorkspace,
} from "../src/server/workspace/testing.ts";
import { DIRECT_TRANSPORT } from "../src/server/workspace/transport.ts";

const SCRIPT = "scripts/synthetic.ts";
const SPAWN_TIMEOUT_MS = 30_000;
const HELP_LINE = "Pomoc: npm run synthetic -- --help";
const NO_VARIABLE =
  "Polecenie wypełnia workspace danymi syntetycznymi, więc wymaga zmiennej HUBBER_WORKSPACE z katalogiem workspace'u przeznaczonego na próby. Domyślnego workspace'u nie wypełnia nigdy.\n";
const DEFAULT_NAMED = (dir: string): string =>
  `Zmienna HUBBER_WORKSPACE wskazuje domyślny workspace ("${dir}"), a tego polecenie nie wypełnia nigdy: wskaż nią katalog workspace'u przeznaczonego na próby.\n`;

const BUSY =
  "Workspace „Testowy” jest otwarty w innym procesie Hubbera. Zatrzymaj go i uruchom polecenie ponownie. Baza nie została zmieniona.\n";
const DATABASE_ERROR = (code: string, why = ""): string =>
  `Wypełnianie workspace'u „Testowy” przerwał błąd bazy (${code})${why}. To, co zapisano wcześniej, zostało w bazie, więc workspace może nie być już pusty: usuń jego katalog i utwórz nowy poleceniem "npm run workspace:create".\n`;

// Modules that are loaded into the command ahead of its own code, for what a test cannot bring
// about from outside. Each changes one thing that the command finds, and nothing of the command.
//
// Every connection to a database gets the statement, once, before its first PRAGMA.
const onEveryConnection = (statement: string): string => `import { createRequire } from "node:module";
const Database = createRequire(${JSON.stringify(import.meta.filename)})("better-sqlite3");
const { pragma } = Database.prototype;
const seen = new WeakSet();
Database.prototype.pragma = function (source, options) {
  if (!seen.has(this)) {
    seen.add(this);
    pragma.call(this, ${statement});
  }
  return pragma.call(this, source, options);
};
`;
const PRELOADS = {
  /** A connection gives up waiting for a database that another process holds after a moment, not after five seconds. */
  "short-wait": onEveryConnection('"busy_timeout = 100"'),
  /** The database may grow by a few pages and no further: what SQLite then reports is what a full disk gives. */
  "full-disk": onEveryConnection('"max_page_count = " + (pragma.call(this, "page_count", { simple: true }) + 8)'),
  /** The account that runs the command has its home where the variable TEST_ACCOUNT_HOME says. */
  "another-account": `import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
const { userInfo } = os;
os.userInfo = (...args) => ({ ...userInfo(...args), homedir: process.env.TEST_ACCOUNT_HOME });
syncBuiltinESMExports();
`,
  /** Every volume has one block free. */
  "no-room": `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const { statfsSync } = fs;
fs.statfsSync = (...args) => ({ ...statfsSync(...args), bavail: 1 });
syncBuiltinESMExports();
`,
} as const;

interface RunResult extends Exit {
  stdout: string;
  stderr: string;
}

const children: ChildProcess[] = [];
const workspaces: TestWorkspace[] = [];
let work: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "hubber-synthetic-command-"));
  for (const [name, source] of Object.entries(PRELOADS)) writeFileSync(join(work, `${name}.mjs`), source);
});

afterAll(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const workspace of workspaces.splice(0)) workspace.remove();
  rmSync(work, { recursive: true, force: true });
});

// spawnNode() builds the environment from scratch: no HOME, no HUBBER_WORKSPACE, nothing that
// marks the session of an agent. What the command asks of this process, it asks of everyone.
//
// Every run is a process that loads the whole server side, so the runs of a group are started
// together, each on a workspace of its own, before the tests of the group look at them.
async function run(
  args: readonly string[],
  env: Record<string, string> = {},
  preload?: keyof typeof PRELOADS,
): Promise<RunResult> {
  const nodeArgs = preload === undefined ? [] : ["--import", pathToFileURL(join(work, `${preload}.mjs`)).href];
  const script = spawnNode(SCRIPT, { args, env, nodeArgs });
  children.push(script.child);
  const exit = await script.exited;
  return { ...exit, stdout: script.stdout(), stderr: script.stderr() };
}

function workspace(create: () => TestWorkspace = createTestWorkspace): TestWorkspace {
  const created = create();
  workspaces.push(created);
  return created;
}

/** What the database of a workspace holds, read the way the application opens it. */
function inspect<Result>(dir: string, look: (db: Db) => Result): Result {
  const opened = openWorkspace({ dir, source: "variable" }, {}, DIRECT_TRANSPORT);
  try {
    return look(createDb(opened.database));
  } finally {
    opened.close();
  }
}

describe("scripts/synthetic.ts", { timeout: SPAWN_TIMEOUT_MS }, () => {
  describe("without the variable that names a workspace", () => {
    let atHome: RunResult;
    let emptyName: RunResult;
    let defaultDir: string;

    beforeAll(async () => {
      const home = join(work, "home");
      defaultDir = join(home, "Library/Application Support/Hubber/workspaces/default");
      mkdirSync(join(defaultDir, ".."), { recursive: true });
      createTestWorkspaceAt(defaultDir);
      [atHome, emptyName] = await Promise.all([
        run(["--scale", "tiny"], { HOME: home }),
        // The variable is asked for before anything else is looked at: also before a scale that does not exist.
        run(["--scale", "huge"], { HUBBER_WORKSPACE: "" }),
      ]);
    });

    it("refuses, whoever asks and whatever else is given", () => {
      for (const result of [atHome, emptyName]) {
        expect(result.stderr).toBe(NO_VARIABLE);
        expect(result.stdout).toBe("");
        expect(result.code).toBe(2);
      }
    });

    it("leaves the default workspace of the owner alone: it stays empty", () => {
      expect(inspect(defaultDir, usedTable)).toBeUndefined();
    });
  });

  // The default place is where the owner's real notes are. A workspace there that holds no row
  // yet is the one that the refusal of a database with data does not protect.
  describe("with the variable naming the default workspace", () => {
    const SPELLINGS = [
      "its path",
      'its path from "~"',
      'its path with ".." in it',
      "its path in another letter case",
      "a link to it",
      "a path through a link to a directory above it",
      "a link inside it that leads back to it",
      "another directory whose database is a link to the database there",
    ] as const;
    let defaultDir: string;
    let before: { entries: string[]; database: string };
    let refused: RunResult[];
    let elsewhere: { dir: string; result: RunResult };
    /** Whether the file system takes a name in another letter case for the same name. */
    let foldsCase: boolean;

    const state = () => ({
      entries: readdirSync(defaultDir).sort(),
      database: createHash("sha256")
        .update(readFileSync(join(defaultDir, "hubber.sqlite")))
        .digest("hex"),
    });

    beforeAll(async () => {
      const home = join(work, "dom");
      const hubber = join(home, "Library/Application Support/Hubber");
      defaultDir = join(hubber, "workspaces/default");
      // As a version without a schema left it: an open would bring it up to date first, and it holds no row.
      createWorkspace(
        { dir: defaultDir, name: TEST_WORKSPACE.name, profile: TEST_PROFILE },
        { createDatabase: createWorkspaceDatabase },
      );
      const linkToIt = join(work, "dowiazanie-do-domyslnego");
      const linkAbove = join(work, "dowiazanie-do-hubbera");
      symlinkSync(defaultDir, linkToIt);
      symlinkSync(hubber, linkAbove);
      symlinkSync(".", join(defaultDir, "tutaj"));
      const otherCase = join(home, "LIBRARY/APPLICATION SUPPORT/HUBBER/WORKSPACES/DEFAULT");
      foldsCase = existsSync(otherCase);
      // A workspace in a place of its own in everything but its database.
      const withItsDatabase = join(work, "z-baza-domyslnego");
      mkdirSync(join(withItsDatabase, "files"), { recursive: true });
      copyFileSync(join(defaultDir, "workspace.json"), join(withItsDatabase, "workspace.json"));
      symlinkSync(join(defaultDir, "hubber.sqlite"), join(withItsDatabase, "hubber.sqlite"));
      before = state();

      const other = workspace();
      const [filled, named] = await Promise.all([
        run(["--scale", "tiny"], { ...other.env, HOME: home }),
        Promise.all(
          [
            defaultDir,
            "~/Library/Application Support/Hubber/workspaces/default",
            `${home}/Library/../Library/Application Support/Hubber/workspaces/default`,
            otherCase,
            linkToIt,
            join(linkAbove, "workspaces/default"),
            join(defaultDir, "tutaj"),
            withItsDatabase,
          ].map((spelling) => run(["--scale", "tiny"], { HOME: home, HUBBER_WORKSPACE: spelling })),
        ),
      ]);
      elsewhere = { dir: other.dir, result: filled };
      refused = named;
    }, SPAWN_TIMEOUT_MS);

    it.each(SPELLINGS.map((spelling, at) => [spelling, at] as const))("refuses %s", (spelling, at) => {
      const result = refused[at] as RunResult;
      if (spelling === "its path in another letter case" && !foldsCase) {
        // Where letter cases are told apart, that is the name of another directory, which is not there.
        expect(result.code).toBe(1);
        return;
      }

      expect(result.stderr).toBe(DEFAULT_NAMED(defaultDir));
      expect(result.stdout).toBe("");
      expect(result.code).toBe(2);
    });

    it(
      "refuses it also for a process that was given another home, or none: the home of the account counts",
      async () => {
        const account = join(work, "dom");
        const results = await Promise.all([
          run(
            ["--scale", "tiny"],
            { HOME: join(work, "inny-dom"), TEST_ACCOUNT_HOME: account, HUBBER_WORKSPACE: defaultDir },
            "another-account",
          ),
          run(["--scale", "tiny"], { TEST_ACCOUNT_HOME: account, HUBBER_WORKSPACE: defaultDir }, "another-account"),
        ]);

        for (const result of results) {
          expect(result.stderr).toBe(DEFAULT_NAMED(defaultDir));
          expect(result.stdout).toBe("");
          expect(result.code).toBe(2);
        }
        expect(state()).toEqual(before);
      },
      SPAWN_TIMEOUT_MS,
    );

    it("leaves the default workspace as it was: not filled, not brought up to date, not opened", () => {
      expect(refused).toHaveLength(SPELLINGS.length);
      // The same bytes, no copy from before an update, and no log beside the database.
      expect(state()).toEqual(before);
      expect(before.entries).toEqual(["files", "hubber.sqlite", "tutaj", "workspace.json"]);
    });

    it("fills any other workspace as before, whatever the home directory holds", () => {
      expect(elsewhere.result.stderr).toBe("");
      expect(elsewhere.result.stdout).toMatch(/^Wypełniono workspace „Testowy”: \d+ wierszy, 5 dni historii, /);
      expect(elsewhere.result.code).toBe(0);
      expect(inspect(elsewhere.dir, usedTable)).toBeDefined();
    });
  });

  describe("on an empty workspace", () => {
    let plain: { dir: string; result: RunResult };
    let seeded: { dir: string; result: RunResult };
    let unmigrated: { dir: string; result: RunResult };

    beforeAll(async () => {
      const filled = async (args: readonly string[], create?: () => TestWorkspace) => {
        const { dir, env } = workspace(create);
        return { dir, result: await run(args, env) };
      };
      [plain, seeded, unmigrated] = await Promise.all([
        filled(["--scale", "tiny"]),
        filled(["--scale", "tiny", "--seed", "7", "--now", "2026-03-01T12:00:00.000Z"]),
        filled(["--scale", "tiny"], createUnmigratedTestWorkspace),
      ]);
    });

    it("fills it with the world of the scale, and says how much it wrote", () => {
      const world = createSyntheticTestDatabase("tiny");
      const written = DATA_TABLES.reduce((sum, table) => sum + (world.manifest.rows[table] ?? 0), 0);

      expect(plain.result.stderr).toBe("");
      expect(plain.result.stdout).toMatch(
        new RegExp(`^Wypełniono workspace „Testowy”: ${written} wierszy, 5 dni historii, \\d+,\\d+ s\\.\\n$`),
      );
      expect(plain.result.code).toBe(0);
      // The same rows as the generator gives a test: the command is nothing but the generator.
      expect(inspect(plain.dir, contentHash)).toBe(contentHash(world.db));
      expect(inspect(plain.dir, checkInvariants)).toEqual([]);
      world.close();
    });

    it("takes the seed and the instant at which the history ends from its options", () => {
      const expected = createTestDatabase();
      generateSynthetic(expected.db, { scale: "tiny", seed: 7, now: new Date("2026-03-01T12:00:00.000Z") });

      expect(seeded.result.stderr).toBe("");
      expect(seeded.result.code).toBe(0);
      expect(inspect(seeded.dir, contentHash)).toBe(contentHash(expected.db));
      expect(inspect(seeded.dir, contentHash)).not.toBe(inspect(plain.dir, contentHash));
      expected.close();
    });

    it("brings a database of an earlier version up to date first, and says so", () => {
      const [before, after, ...more] = unmigrated.result.stderr.trimEnd().split("\n");

      expect(before).toMatch(/^Baza workspace'u wymaga aktualizacji \(0001_init[^)]*\)\. Robię kopię i aktualizuję/);
      expect(after).toMatch(
        /^Baza zaktualizowana\. Kopia sprzed aktualizacji: ".+\/backups\/before-0001_init-.+\.sqlite"\.$/,
      );
      expect(more).toEqual([]);
      expect(unmigrated.result.stdout).toMatch(/^Wypełniono workspace „Testowy”: \d+ wierszy, 5 dni historii, /);
      expect(unmigrated.result.code).toBe(0);
      expect(inspect(unmigrated.dir, contentHash)).toBe(inspect(plain.dir, contentHash));
    });
  });

  describe("on a workspace that holds data", () => {
    let dir: string;
    let before: string;
    let result: RunResult;

    beforeAll(async () => {
      const used = workspace();
      dir = used.dir;
      before = inspect(dir, (db) => {
        generateSynthetic(db, { scale: "tiny", seed: 3 });
        return contentHash(db);
      });
      result = await run(["--scale", "small"], used.env);
    });

    it("refuses, names a table that has rows, and changes nothing", () => {
      expect(result.stderr).toBe(
        'Workspace „Testowy” zawiera już dane (tabela capture_part_texts). Dane syntetyczne trafiają wyłącznie do pustej bazy: utwórz nowy workspace poleceniem "npm run workspace:create".\n',
      );
      expect(result.stdout).toBe("");
      expect(result.code).toBe(1);
      expect(inspect(dir, contentHash)).toBe(before);
    });
  });

  describe("on a workspace that another process has open", () => {
    let dir: string;
    let whileHeld: RunResult;
    let afterwards: RunResult;

    beforeAll(async () => {
      const held = workspace();
      dir = held.dir;
      // As a server has it between two requests: open, and doing nothing.
      const server = openWorkspace({ dir, source: "variable" }, {}, DIRECT_TRANSPORT);
      try {
        whileHeld = await run(["--scale", "tiny"], held.env, "short-wait");
      } finally {
        server.close();
      }
      afterwards = await run(["--scale", "tiny"], held.env, "short-wait");
    }, SPAWN_TIMEOUT_MS);

    it("refuses in the words of a start that has to bring the database up to date, and writes nothing", () => {
      expect(whileHeld.stderr).toBe(BUSY);
      expect(whileHeld.stdout).toBe("");
      expect(whileHeld.code).toBe(1);
    });

    it("fills it once the other process is gone", () => {
      // What the first run left is an empty workspace: the second one would refuse any row.
      expect(afterwards.stderr).toBe("");
      expect(afterwards.code).toBe(0);
      expect(inspect(dir, checkInvariants)).toEqual([]);
      expect(inspect(dir, usedTable)).toBeDefined();
    });
  });

  describe("on a workspace whose database or disk cannot take the rows", () => {
    let full: { dir: string; result: RunResult };
    let readOnly: { dir: string; result: RunResult };
    let noRoom: { dir: string; result: RunResult };

    beforeAll(async () => {
      const on = async (preload: keyof typeof PRELOADS | undefined, prepare?: (dir: string) => void) => {
        const { dir, env } = workspace();
        prepare?.(dir);
        return { dir, result: await run(["--scale", "tiny"], env, preload) };
      };
      [full, readOnly, noRoom] = await Promise.all([
        on("full-disk"),
        on(undefined, (dir) => chmodSync(join(dir, "hubber.sqlite"), 0o400)),
        on("no-room"),
      ]);
      chmodSync(join(readOnly.dir, "hubber.sqlite"), 0o600);
    }, SPAWN_TIMEOUT_MS);

    it("says in one sentence that the disk filled up while it wrote, and that what was written stays", () => {
      expect(full.result.stderr).toBe(DATABASE_ERROR("SQLITE_FULL", ", bo na dysku zabrakło miejsca"));
      expect(full.result.stdout).toBe("");
      expect(full.result.code).toBe(1);
    });

    // Whoever may write anywhere is not stopped by the mode of a file.
    it.skipIf(process.getuid?.() === 0)("says the same of a database file that may not be written", () => {
      expect(readOnly.result.stderr).toBe(DATABASE_ERROR("SQLITE_READONLY"));
      expect(readOnly.result.stdout).toBe("");
      expect(readOnly.result.code).toBe(1);
      expect(inspect(readOnly.dir, usedTable)).toBeUndefined();
    });

    it("refuses beforehand when the disk has less room than the scale needs, and writes nothing", () => {
      expect(noRoom.result.stderr).toMatch(
        /^Wypełnienie workspace'u „Testowy” w skali tiny potrzebuje około 10,0 MB wolnego miejsca na dysku, a wolne jest 0,0 MB\. Danych nie zapisano\.\n$/,
      );
      expect(noRoom.result.stdout).toBe("");
      expect(noRoom.result.code).toBe(1);
      expect(inspect(noRoom.dir, usedTable)).toBeUndefined();
    });
  });

  describe("on a workspace of another endpoint than the environment names", () => {
    let dir: string;
    let result: RunResult;

    beforeAll(async () => {
      const pinned = workspace();
      dir = pinned.dir;
      result = await run(["--scale", "tiny"], { ...pinned.env, ANTHROPIC_BASE_URL: "https://api.anthropic.com" });
    });

    it("refuses as the application does, with the exit code of the pin, and writes nothing", () => {
      expect(result.stderr).toMatch(
        /^Nie można otworzyć workspace'u „Testowy”: jest przypięty do endpointu http:\/\/127\.0\.0\.1:9\/llm, a zmienna ANTHROPIC_BASE_URL wskazuje https:\/\/api\.anthropic\.com\S*\. /,
      );
      expect(result.stdout).toBe("");
      expect(result.code).toBe(3);
      expect(inspect(dir, usedTable)).toBeUndefined();
    });
  });

  describe("with options that it cannot use", () => {
    const CASES: [args: string[], message: string, env?: Record<string, string>][] = [
      [[], "Podaj skalę opcją --scale: tiny, small, full."],
      [["--scale", "huge"], 'Niepoprawna wartość --scale: "huge". Dozwolone: tiny, small, full.'],
      [
        ["--scale", "tiny", "--seed", "siedem"],
        'Niepoprawna wartość --seed: "siedem". Podaj liczbę całkowitą od 0 do 999999999.',
      ],
      [
        ["--scale", "tiny", "--now", "2026-10-14"],
        'Niepoprawna wartość --now: "2026-10-14". Podaj chwilę w zapisie 2026-10-14T17:30:00.000Z.',
      ],
      // An instant that is spelled as it should be, and at which the generator cannot end a history:
      // its plans would reach past the years that the database takes, or its history before its clock.
      [
        ["--scale", "tiny", "--now", "9999-12-31T23:59:59.999Z"],
        'Niepoprawna wartość --now: "9999-12-31T23:59:59.999Z". Podaj chwilę z zakresu od 1980-01-01T00:00:00.000Z do 9989-12-31T23:59:59.999Z.',
      ],
      [
        ["--scale", "tiny", "--now", "1979-12-31T23:59:59.999Z"],
        'Niepoprawna wartość --now: "1979-12-31T23:59:59.999Z". Podaj chwilę z zakresu od 1980-01-01T00:00:00.000Z do 9989-12-31T23:59:59.999Z.',
      ],
      // What npm does to "npm run synthetic --scale tiny": the option is gone from the arguments.
      [[], 'npm zabrał dla siebie: --scale. Opcje polecenia podaje się po "--".', { npm_config_scale: "tiny" }],
    ];
    let results: { dir: string; result: RunResult }[];

    beforeAll(async () => {
      results = await Promise.all(
        CASES.map(async ([args, , more]) => {
          const { dir, env } = workspace();
          return { dir, result: await run(args, { ...env, ...more }) };
        }),
      );
    });

    it.each(CASES.map(([args, message, env], at) => [[...args, ...Object.keys(env ?? {})], message, at] as const))(
      "says what is wrong with %j, and writes nothing",
      (_args, message, at) => {
        const { dir, result } = results[at] as (typeof results)[number];

        expect(result.stderr).toBe(`${message}\n${HELP_LINE}\n`);
        expect(result.stdout).toBe("");
        expect(result.code).toBe(2);
        expect(inspect(dir, usedTable)).toBeUndefined();
      },
    );
  });

  describe("with a directory that is no workspace, or with none to fill", () => {
    let absent: RunResult;
    let relative: RunResult;
    let help: RunResult;
    let missing: string;

    beforeAll(async () => {
      missing = join(work, "nie-ma-takiego");
      [absent, relative, help] = await Promise.all([
        run(["--scale", "tiny"], { HUBBER_WORKSPACE: missing }),
        run(["--scale", "tiny"], { HUBBER_WORKSPACE: "wzgledny/katalog" }),
        run(["--help"]),
      ]);
    });

    it("refuses in the words of the application", () => {
      expect(absent.stderr).toBe(
        `Nie można otworzyć workspace'u: katalog "${missing}" ze zmiennej HUBBER_WORKSPACE nie istnieje. Utworzysz go poleceniem "npm run workspace:create -- --name <nazwa> --kind <anthropic|router>".\n`,
      );
      expect(absent.code).toBe(1);
      expect(relative.stderr).toBe(
        `Niepoprawna wartość HUBBER_WORKSPACE: "wzgledny/katalog". Podaj pełną ścieżkę katalogu workspace'u (od "/" albo "~/").\n${HELP_LINE}\n`,
      );
      expect(relative.code).toBe(2);
    });

    it("explains itself with --help, without a workspace", () => {
      expect(help.stderr).toBe("");
      expect(help.stdout).toMatch(/^Wypełnia pusty workspace danymi syntetycznymi/);
      expect(help.stdout).toContain("--scale <tiny|small|full>");
      // What it never fills, and what it waits for.
      expect(help.stdout).toContain(
        "\nPolecenie wypełnia wyłącznie workspace wskazany zmienną HUBBER_WORKSPACE, nigdy domyślny, i tylko wtedy,\ngdy jego baza jest pusta i nie ma go otwartego inny proces Hubbera. ",
      );
      expect(help.code).toBe(0);
    });
  });
});
