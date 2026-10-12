import type { ChildProcess } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/server/db/handle.ts";
import { MIGRATIONS_DIR, readMigrations, schemaFingerprint } from "../src/server/db/migrate.ts";
import { checkInvariants, contentHash, DATA_TABLES, DEFAULT_NOW } from "../src/server/db/synthetic/index.ts";
import { createSyntheticTestDatabase } from "../src/server/db/synthetic/testing.ts";
import { type Exit, spawnNode, TEST_WORKSPACE } from "../src/server/testing.ts";
import { readWorkspacePin, type WorkspaceDatabase } from "../src/server/workspace/database.ts";
import { unusableMigrations } from "../src/server/workspace/errors.ts";

const SCRIPT = "scripts/db-fixture.ts";
const SPAWN_TIMEOUT_MS = 30_000;
const REPO_ROOT = join(import.meta.dirname, "..");
const HELP_LINE = "Pomoc: npm run db:fixture -- --help";
const FIXTURES_DIR = join(MIGRATIONS_DIR, "..", "fixtures");
const HEAD = readMigrations().at(-1)?.tag ?? "";
const NAME = `after-${HEAD}.sqlite.gz`;

interface RunResult extends Exit {
  stdout: string;
  stderr: string;
  /** Where the command was told to write, and the temporary directory it was given. */
  out: string;
  temp: string;
}

const children: ChildProcess[] = [];
const databases: WorkspaceDatabase[] = [];
let work: string;
let counter = 0;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "hubber-fixture-command-"));
});

afterAll(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const database of databases.splice(0)) database.close();
  rmSync(work, { recursive: true, force: true });
});

async function run(
  args: readonly string[],
  out = join(work, `out-${++counter}`),
  command = SCRIPT,
): Promise<RunResult> {
  const temp = join(work, `tmp-${++counter}`);
  mkdirSync(temp);
  const script = spawnNode(command, { args: [...args, "--dir", out], env: { TMPDIR: temp } });
  children.push(script.child);
  const exit = await script.exited;
  return { ...exit, stdout: script.stdout(), stderr: script.stderr(), out, temp };
}

/** The database that a compressed file holds, opened from its bytes as the test of the migrations opens it. */
function open(file: string): WorkspaceDatabase {
  const database = new Database(gunzipSync(readFileSync(file)));
  databases.push(database);
  return database;
}

describe("the databases kept for the tests of later migrations", () => {
  it("include the one of the newest migration", () => {
    // The generator writes the newest schema only. Once the next migration exists, nothing can
    // write the database of this one any more: it is written now, with "npm run db:fixture".
    expect(
      existsSync(join(FIXTURES_DIR, NAME)),
      `src/server/db/fixtures/${NAME} is missing: run "npm run db:fixture"`,
    ).toBe(true);
  });

  it("hold a world that keeps the rules of the schema, in a workspace pinned to the address of the tests", () => {
    const database = open(join(FIXTURES_DIR, NAME));
    const db = createDb(database);

    expect(readWorkspacePin(database).endpoint).toBe(TEST_WORKSPACE.endpoint);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(checkInvariants(db)).toEqual([]);
    for (const table of ["items", "persons", "captures", "operations", "operation_effects", "facts"]) {
      expect(database.prepare(`SELECT count(*) FROM "${table}"`).pluck().get(), table).toBeGreaterThan(5);
    }
  });

  it("hold, for the newest migration, the smallest world as the generator makes it today", () => {
    // The file of the newest migration can still be written again, and after a change of the
    // generator it has to be: a file of an older generator would pass every other test here.
    const database = open(join(FIXTURES_DIR, NAME));
    const world = createSyntheticTestDatabase("tiny");

    expect(
      contentHash(createDb(database)),
      `src/server/db/fixtures/${NAME} is not the world of the generator: remove it and run "npm run db:fixture"`,
    ).toBe(contentHash(world.db));
    world.close();
  });
});

describe("scripts/db-fixture.ts", { timeout: SPAWN_TIMEOUT_MS }, () => {
  let first: RunResult;
  let second: RunResult;

  beforeAll(async () => {
    [first, second] = await Promise.all([run([]), run([])]);
  });

  it("writes one file, named after the newest migration, and says what it holds", () => {
    const world = createSyntheticTestDatabase("tiny");
    const rows = DATA_TABLES.reduce((sum, table) => sum + (world.manifest.rows[table] ?? 0), 0);
    world.close();
    const file = join(first.out, NAME);

    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    expect(readdirSync(first.out)).toEqual([NAME]);
    const kilobytes = Math.ceil(statSync(file).size / 1_000);
    expect(first.stdout).toBe(
      `Zapisano bazę wersji ${HEAD} do testów migracji: "${file}" (${rows} wierszy, ${kilobytes} kB).\n`,
    );
    // A file of the repository, readable like the sources beside it, whatever the umask of the shell.
    expect((statSync(file).mode & 0o777).toString(8)).toBe("644");
    // Its workspace was in the temporary directory, and is gone.
    expect(readdirSync(first.temp)).toEqual([]);
  });

  it("writes the database of a small workspace at the newest schema, with the smallest world in it", () => {
    const database = open(join(first.out, NAME));
    const migrations = readMigrations();
    const world = createSyntheticTestDatabase("tiny");

    expect(schemaFingerprint(database)).toBe(migrations.at(-1)?.schema);
    expect(database.prepare("SELECT tag FROM schema_migrations ORDER BY idx").pluck().all()).toEqual(
      migrations.map(({ tag }) => tag),
    );
    expect(contentHash(createDb(database))).toBe(contentHash(world.db));
    expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
    // One file without a log beside it: what a test opens from its bytes.
    expect(database.pragma("journal_mode", { simple: true })).not.toBe("wal");
    world.close();
  });

  it("records nothing of the moment it ran: the same command gives the same bytes", () => {
    const database = open(join(first.out, NAME));

    expect(readFileSync(join(second.out, NAME)).equals(readFileSync(join(first.out, NAME)))).toBe(true);
    // Nor of the system it ran on: the header of the compressed file names none.
    expect(readFileSync(join(first.out, NAME))[9]).toBe(255);
    // The instants that the file holds of its own making are those of the world.
    expect(readWorkspacePin(database)).toEqual({ endpoint: TEST_WORKSPACE.endpoint, createdAt: DEFAULT_NOW });
    expect(database.prepare("SELECT DISTINCT applied_at FROM schema_migrations").pluck().all()).toEqual([DEFAULT_NOW]);
  });

  it("refuses to write over a database that is there, and leaves it as it is", async () => {
    const file = join(first.out, NAME);
    const before = { bytes: readFileSync(file), changed: statSync(file).mtimeMs };

    const again = await run([], first.out);

    expect(again.stderr).toBe(
      `Plik "${file}" już istnieje. Baza wersji ${HEAD} jest zapisywana raz i polecenie jej nie nadpisuje; jeśli migracja ${HEAD} nie trafiła jeszcze do gałęzi main i ma powstać od nowa, najpierw usuń ten plik.\n`,
    );
    expect(again.stdout).toBe("");
    expect(again.code).toBe(1);
    expect(readFileSync(file).equals(before.bytes)).toBe(true);
    expect(statSync(file).mtimeMs).toBe(before.changed);
    expect(readdirSync(again.temp)).toEqual([]);
  });

  it("refuses an option that it does not have, and writes nothing", async () => {
    const result = await run(["--force"]);

    expect(result.stderr).toBe(`Nieznana opcja: --force.\n${HELP_LINE}\n`);
    expect(result.code).toBe(2);
    expect(existsSync(result.out)).toBe(false);
  });

  describe("where it cannot write", () => {
    let overAFile: RunResult;
    let locked: RunResult;
    let overALink: RunResult;

    beforeAll(async () => {
      const file = join(work, "zwykly-plik");
      writeFileSync(file, "x");
      const lockedDir = join(work, "katalog-bez-zapisu");
      mkdirSync(lockedDir, { mode: 0o500 });
      // A link that leads nowhere under the name of the file: there is no file, and the name is taken.
      const withALink = join(work, "katalog-z-dowiazaniem");
      mkdirSync(withALink);
      symlinkSync(join(work, "nie-ma-takiego"), join(withALink, NAME));
      [overAFile, locked, overALink] = await Promise.all([run([], file), run([], lockedDir), run([], withALink)]);
    }, SPAWN_TIMEOUT_MS);

    it("refuses a place that is no directory before it makes anything, as a value that cannot be used", () => {
      expect(overAFile.stderr).toBe(
        `Niepoprawna wartość --dir: "${overAFile.out}" nie jest katalogiem.\n${HELP_LINE}\n`,
      );
      expect(overAFile.stdout).toBe("");
      expect(overAFile.code).toBe(2);
      expect(readFileSync(overAFile.out, "utf8")).toBe("x");
      expect(readdirSync(overAFile.temp)).toEqual([]);
    });

    // Whoever may write anywhere is not stopped by the mode of a directory.
    it.skipIf(process.getuid?.() === 0)(
      "says in one sentence that the file could not be written, with what the system said of it",
      () => {
        expect(locked.stderr).toBe(`Nie udało się zapisać pliku "${join(locked.out, NAME)}" (EACCES).\n`);
        expect(locked.stdout).toBe("");
        expect(locked.code).toBe(1);
        expect(readdirSync(locked.out)).toEqual([]);
        expect(readdirSync(locked.temp)).toEqual([]);
      },
    );

    it("says the same of a name that is taken by a link, and writes nothing through the link", () => {
      expect(overALink.stderr).toBe(`Nie udało się zapisać pliku "${join(overALink.out, NAME)}" (EEXIST).\n`);
      expect(overALink.code).toBe(1);
      expect(existsSync(join(work, "nie-ma-takiego"))).toBe(false);
    });
  });

  describe("in a copy of the code whose migrations cannot be used", () => {
    let result: RunResult;
    let changed: string;
    let folder: string;

    beforeAll(async () => {
      // The sources that the command loads, beside the libraries of this checkout: a place where
      // the folder of the migrations can be damaged.
      // By its real path: the command names its files that way, and the temporary directory of
      // the system is reached through a link.
      const copy = join(realpathSync(work), "kopia-kodu");
      for (const part of ["package.json", "scripts", "src/server", "src/shared"]) {
        cpSync(join(REPO_ROOT, part), join(copy, part), {
          recursive: true,
          filter: (source) => !source.endsWith(".test.ts"),
        });
      }
      symlinkSync(join(REPO_ROOT, "node_modules"), join(copy, "node_modules"));
      folder = join(copy, "src/server/db/migrations");
      changed = join(folder, `${HEAD}.sql`);
      // What whoever writes a migration has before the manifest follows the file.
      appendFileSync(changed, "-- one more line\n");
      result = await run([], undefined, join(copy, SCRIPT));
    }, SPAWN_TIMEOUT_MS);

    it("says in the words of the application what is wrong with them, and writes nothing", () => {
      const reason = unusableMigrations({ folder, message: "", changedFile: changed });

      expect(result.stderr).toBe(`Nie udało się zapisać bazy do testów migracji: ${reason}\n`);
      expect(result.stdout).toBe("");
      expect(result.code).toBe(1);
      expect(existsSync(result.out)).toBe(false);
      expect(readdirSync(result.temp)).toEqual([]);
    });
  });
});
