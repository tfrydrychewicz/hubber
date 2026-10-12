import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import {
  MIGRATIONS_DIR,
  MIGRATIONS_TABLE,
  MigrationError,
  MigrationFilesError,
  readMigrations,
  schemaFingerprint,
} from "../db/migrate.ts";
import { TEST_WORKSPACE } from "../testing.ts";
import type { LlmProfile } from "./config.ts";
import { APPLICATION_ID, readWorkspacePin } from "./database.ts";
import { isMigrationDone, isMigrationNotice, isWorkspaceRefusal, WorkspaceError } from "./errors.ts";
import { type OpenWorkspace, openWorkspace } from "./open.ts";
import { createTestWorkspace, createUnmigratedTestWorkspace, TEST_PROFILE, type TestWorkspace } from "./testing.ts";
import { DIRECT_TRANSPORT, type TransportState } from "./transport.ts";

// What reading the process gives, for the one test that lets openWorkspace() read it: the test
// says what is found, so that it does not depend on how the tests themselves were started. That
// the real reading is right is shown in transport.test.ts, on real processes.
const processState = vi.hoisted(() => ({ found: undefined as unknown }));
vi.mock("./transport.ts", async (importOriginal) => {
  const real = await importOriginal<{ readTransportState: () => unknown }>();
  return { ...real, readTransportState: () => processState.found ?? real.readTransportState() };
});

// The runner is the real one, unless a test sets what it is to throw: most of what can go wrong in
// a migration cannot be brought about with the migrations of this code. With "afterNotice" it
// throws as a runner does that had something to apply: once it has told its caller so.
const runner = vi.hoisted(() => ({ failure: undefined as Error | undefined, afterNotice: false }));
vi.mock("../db/migrate.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../db/migrate.ts")>();
  return {
    ...real,
    migrateDatabase: (...args: Parameters<typeof real.migrateDatabase>) => {
      if (runner.failure === undefined) return real.migrateDatabase(...args);
      if (runner.afterNotice) args[1].onPending?.({ pending: ["0002_next"] });
      throw runner.failure;
    },
  };
});

// A connection of the application waits five seconds for a file that another connection holds.
// With a number set here, every connection waits that many milliseconds instead. With a code set
// here, the checkpoint that a connection asks for fails with it: what a disk gives that has room
// for a commit and none for folding the log back into the file.
const sqlite = vi.hoisted(() => ({
  timeout: undefined as number | undefined,
  checkpointFails: undefined as string | undefined,
}));
vi.mock("better-sqlite3", async (importOriginal) => {
  const { default: Real } = await importOriginal<{ default: typeof Database }>();
  return {
    default: class extends Real {
      constructor(file: string, options: Database.Options = {}) {
        super(file, sqlite.timeout === undefined ? options : { ...options, timeout: sqlite.timeout });
      }

      override pragma(source: string, options?: Database.PragmaOptions): unknown {
        if (sqlite.checkpointFails !== undefined && source.startsWith("wal_checkpoint")) {
          throw Object.assign(new Error("reported by SQLite"), { code: sqlite.checkpointFails });
        }
        return super.pragma(source, options);
      }
    },
  };
});

const ROUTER = "https://router.corp.example/llm";
const OTHER = "https://other.corp.example";
const LAYOUT = ["files", "hubber.sqlite", "workspace.json"];
const RESTORE_HINT = "Odtwórz cały katalog z kopii zapasowej.";

const workspaces: TestWorkspace[] = [];
const opened: OpenWorkspace[] = [];
const connections: Database.Database[] = [];

afterEach(() => {
  processState.found = undefined;
  runner.failure = undefined;
  runner.afterNotice = false;
  sqlite.timeout = undefined;
  sqlite.checkpointFails = undefined;
  for (const workspace of opened.splice(0)) workspace.close();
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const workspace of workspaces.splice(0)) workspace.remove();
});

function workspace(profile: Partial<LlmProfile> = { endpoint: ROUTER }): TestWorkspace {
  const created = createTestWorkspace(profile);
  workspaces.push(created);
  return created;
}

// A process that connects directly, whatever the one that runs the tests was started with. A test
// about another kind of process hands in the changes.
function open(dir: string, env: Record<string, string> = {}, transport: Partial<TransportState> = {}): OpenWorkspace {
  const workspace = openWorkspace({ dir, source: "variable" }, env, { ...DIRECT_TRANSPORT, ...transport });
  opened.push(workspace);
  return workspace;
}

function refusal(
  dir: string,
  env: Record<string, string> = {},
  transport: Partial<TransportState> = {},
): WorkspaceError {
  try {
    open(dir, env, transport);
  } catch (error) {
    if (error instanceof WorkspaceError) {
      expect(isWorkspaceRefusal(error.message)).toBe(true);
      return error;
    }
    throw error;
  }
  throw new Error("The workspace opened.");
}

const entries = (dir: string) => readdirSync(dir).sort();
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Puts another address into the configuration file, as an edit by hand would. */
function editEndpoint(dir: string, endpoint: string): void {
  const path = join(dir, "workspace.json");
  writeFileSync(path, readFileSync(path, "utf8").replace(ROUTER, endpoint));
}

/** Replaces the database by a file of Hubber's own kind that is built by hand. */
function rebuildDatabase(dir: string, build: (db: Database.Database) => void): string {
  const path = join(dir, "hubber.sqlite");
  writeFileSync(path, "");
  const db = new Database(path);
  try {
    db.pragma(`application_id = ${APPLICATION_ID}`);
    db.pragma("user_version = 1");
    build(db);
  } finally {
    db.close();
  }
  return path;
}

describe("openWorkspace", () => {
  it("opens a workspace: its configuration, its pinned endpoint and its database", () => {
    const { dir } = workspace();

    const found = open(dir);

    expect(found.paths.dir).toBe(dir);
    expect(found.config).toMatchObject({ name: TEST_WORKSPACE.name, profile: { ...TEST_PROFILE, endpoint: ROUTER } });
    expect(found.endpoint).toEqual({ href: ROUTER, origin: "https://router.corp.example", basePath: "/llm" });
    expect(found.warnings).toEqual([]);
    expect(found.database.open).toBe(true);
    expect(readWorkspacePin(found.database)).toEqual({ endpoint: ROUTER, createdAt: found.config.createdAt });
  });

  it.each<[string, Record<string, string>]>([
    ["names no endpoint", {}],
    ["has an empty ANTHROPIC_BASE_URL", { ANTHROPIC_BASE_URL: "" }],
    ["names the pinned endpoint", { ANTHROPIC_BASE_URL: ROUTER }],
    ["names the pinned endpoint in another spelling", { ANTHROPIC_BASE_URL: "https://ROUTER.corp.example:443/llm/" }],
    // Whether Node uses a proxy is asked of the process, and this one does not.
    ["names a proxy that Node does not use", { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://127.0.0.1:1" }],
  ])("opens in an environment that %s", (_what, env) => {
    const { dir } = workspace();

    expect(open(dir, env).endpoint.href).toBe(ROUTER);
  });

  it("opens the throwaway workspace of the tests, which is pinned to nothing that listens", () => {
    const { dir, env } = workspace({});

    expect(open(dir, env).endpoint.href).toBe(TEST_WORKSPACE.endpoint);
    expect(env).toEqual({ HUBBER_WORKSPACE: dir });
  });

  it("hands the warnings of the directory on, and opens it all the same", () => {
    const { dir } = workspace();
    chmodSync(dir, 0o755);

    expect(open(dir).warnings).toHaveLength(1);
  });

  it("leaves one database file behind when it is closed, also when it is closed twice", () => {
    const { dir } = workspace();
    const found = open(dir);
    found.database.exec("CREATE TABLE drops (body TEXT NOT NULL) STRICT; INSERT INTO drops VALUES ('wrzutka')");
    expect(entries(dir)).toEqual([
      "files",
      "hubber.sqlite",
      "hubber.sqlite-shm",
      "hubber.sqlite-wal",
      "workspace.json",
    ]);

    const closing = vi.spyOn(found.database, "close");

    found.close();
    found.close();

    // Once only: that a second close does no harm is not left to the database library.
    expect(closing).toHaveBeenCalledTimes(1);
    expect(found.database.open).toBe(false);
    expect(entries(dir)).toEqual(LAYOUT);
  });

  describe("the order of the checks", () => {
    it("reports a broken configuration before anything else", () => {
      const { dir } = workspace();
      writeFileSync(join(dir, "workspace.json"), "[]");

      const error = refusal(dir, { ANTHROPIC_BASE_URL: OTHER }, { proxySupport: true });

      expect(error.exitCode).toBe(1);
      expect(error.message).toContain("plik nie zawiera obiektu JSON");
    });

    it("reports another endpoint in the environment although the database is wrong as well, and never opens it", () => {
      const { dir } = workspace();
      const database = join(dir, "hubber.sqlite");
      writeFileSync(database, "not a database, only text ".repeat(100));
      const before = digest(database);

      const error = refusal(dir, { ANTHROPIC_BASE_URL: OTHER }, { proxySupport: true });

      expect(error.exitCode).toBe(3);
      expect(error.message).toBe(
        `Nie można otworzyć workspace'u „${TEST_WORKSPACE.name}”: jest przypięty do endpointu ${ROUTER}, a zmienna ANTHROPIC_BASE_URL wskazuje ${OTHER}. Dane workspace'u nie mogą trafić do innego endpointu. Uruchom aplikację ze środowiskiem endpointu ${ROUTER} albo wskaż zmienną HUBBER_WORKSPACE workspace utworzony dla ${OTHER}.`,
      );
      expect(digest(database)).toBe(before);
    });

    it("leaves no side file of the database behind when the environment names another endpoint", () => {
      const { dir } = workspace();

      expect(refusal(dir, { ANTHROPIC_BASE_URL: OTHER }).exitCode).toBe(3);

      // The database was not opened at all: an open one has its -wal file beside it.
      expect(entries(dir)).toEqual(LAYOUT);
    });

    it("reports an address in the environment that it cannot use before it looks at the database", () => {
      const { dir } = workspace();
      writeFileSync(join(dir, "hubber.sqlite"), "");

      const error = refusal(dir, { ANTHROPIC_BASE_URL: "https://ola:hunter2@router.corp.example/llm" });

      expect(error.exitCode).toBe(2);
      expect(error.message).toBe(
        "Nie można otworzyć workspace'u: zmienna ANTHROPIC_BASE_URL nie nadaje się na adres endpointu: adres zawiera nazwę użytkownika lub hasło.",
      );
    });

    it.each<[string, Partial<TransportState>, string]>([
      ["the proxy support of Node switched on", { proxySupport: true }, "obsługę serwera proxy"],
      [
        "a proxy in the place of the default dispatcher",
        { replacedDispatcher: "ProxyAgent" },
        'obiekt klasy "ProxyAgent"',
      ],
      ["the certificate check switched off", { certificatesUnchecked: true }, "NODE_TLS_REJECT_UNAUTHORIZED=0"],
    ])("refuses a start in a process with %s before it looks at the database", (_what, transport, words) => {
      const { dir } = workspace();
      writeFileSync(join(dir, "hubber.sqlite"), "");

      const error = refusal(dir, {}, transport);

      expect(error.exitCode).toBe(2);
      expect(error.message).toContain(words);
      expect(entries(dir)).toEqual(LAYOUT);
    });

    it("does not go by what the environment says of a proxy or of certificates", () => {
      // Node may have been told otherwise since, and may never have taken the variable up. What
      // the process does is what counts; transport.test.ts shows that it is read rightly.
      const { dir } = workspace();

      expect(open(dir, { NODE_USE_ENV_PROXY: "1", NODE_OPTIONS: "--use-env-proxy" }).endpoint.href).toBe(ROUTER);
      expect(open(dir, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }).endpoint.href).toBe(ROUTER);
    });

    it("asks the process it runs in how it connects, unless it is handed a state", () => {
      const { dir } = workspace();
      processState.found = { ...DIRECT_TRANSPORT, replacedDispatcher: "EnvHttpProxyAgent" };

      // As the server calls it.
      expect(() => openWorkspace({ dir, source: "variable" }, {})).toThrow(/obiekt klasy "EnvHttpProxyAgent"/);
      expect(open(dir).endpoint.href).toBe(ROUTER);
    });
  });

  describe("the second record of the pin", () => {
    it("refuses a configuration file edited to another endpoint, although the environment agrees with the edit", () => {
      const { dir } = workspace();
      editEndpoint(dir, OTHER);

      const error = refusal(dir, { ANTHROPIC_BASE_URL: OTHER });

      expect(error.exitCode).toBe(3);
      expect(error.message).toBe(
        `Nie można otworzyć workspace'u „${TEST_WORKSPACE.name}”: plik konfiguracji "${join(dir, "workspace.json")}" podaje endpoint ${OTHER}, a baza "${join(dir, "hubber.sqlite")}" jest przypięta do ${ROUTER}. Wiążący jest adres zapisany w bazie przy utworzeniu workspace'u: przywróć go w pliku konfiguracji albo przywróć plik bazy, który do tego workspace'u należy.`,
      );
      // Refused and closed again: nothing lies beside the database.
      expect(entries(dir)).toEqual(LAYOUT);
    });

    it("refuses it without any declaration in the environment too", () => {
      const { dir } = workspace();
      editEndpoint(dir, OTHER);

      expect(refusal(dir).exitCode).toBe(3);
    });

    it("refuses a database brought in from a workspace of another endpoint", () => {
      const { dir } = workspace();
      const development = workspace({ kind: "anthropic", endpoint: "https://api.anthropic.com", auth: "x-api-key" });
      copyFileSync(join(dir, "hubber.sqlite"), join(development.dir, "hubber.sqlite"));

      const error = refusal(development.dir);

      expect(error.exitCode).toBe(3);
      expect(error.message).toContain(
        `podaje endpoint https://api.anthropic.com, a baza "${join(development.dir, "hubber.sqlite")}" jest przypięta do ${ROUTER}.`,
      );
    });

    it("opens with a database brought in from another workspace of the same endpoint", () => {
      // The pin names an endpoint, not a workspace: no data can reach another endpoint this way.
      const { dir } = workspace();
      const twin = workspace();
      copyFileSync(join(dir, "hubber.sqlite"), join(twin.dir, "hubber.sqlite"));

      expect(open(twin.dir).endpoint.href).toBe(ROUTER);
    });
  });

  describe("a database that cannot be used", () => {
    function failure(dir: string): string {
      const error = refusal(dir);
      expect(error.exitCode).toBe(1);
      const prefix = "Nie można otworzyć workspace'u: ";
      expect(error.message.startsWith(prefix)).toBe(true);
      return error.message.slice(prefix.length);
    }

    it("is reported as missing when it cannot be opened as a file", () => {
      const { dir } = workspace();
      const database = join(dir, "hubber.sqlite");
      // There for the check of the directory, yet nothing that SQLite gets to open.
      chmodSync(database, 0o000);

      expect(failure(dir)).toBe(`brak pliku bazy "${database}". ${RESTORE_HINT}`);
    });

    it.each([
      ["an empty file", ""],
      ["a text file", "not a database, only text ".repeat(100)],
    ])("is reported as not Hubber's when it is %s", (_what, content) => {
      const { dir } = workspace();
      const database = join(dir, "hubber.sqlite");
      writeFileSync(database, content);

      expect(failure(dir)).toBe(`plik "${database}" nie jest bazą workspace'u Hubbera. ${RESTORE_HINT}`);
      expect(readFileSync(database, "utf8")).toBe(content);
    });

    it("is reported as written by a newer Hubber, with both format numbers", () => {
      const { dir } = workspace();
      const database = join(dir, "hubber.sqlite");
      const raw = new Database(database);
      raw.pragma("user_version = 7");
      raw.close();

      expect(failure(dir)).toBe(
        `bazę "${database}" zapisała nowsza wersja Hubbera (format 7, ta wersja zna 1). Zaktualizuj aplikację.`,
      );
    });

    it("is reported as a database without its pin", () => {
      const { dir } = workspace();
      const database = rebuildDatabase(dir, () => {});

      expect(failure(dir)).toBe(
        `w bazie "${database}" brakuje zapisu o przypięciu do endpointu, więc nie da się sprawdzić, dla którego endpointu powstała. ${RESTORE_HINT}`,
      );
    });

    it("is reported with what SQLite says when nothing else explains it", () => {
      const { dir } = workspace();
      const database = rebuildDatabase(dir, (db) => db.exec("CREATE TABLE workspace_pin (id INTEGER PRIMARY KEY)"));

      expect(failure(dir)).toBe(`nie udało się otworzyć bazy "${database}" (SQLITE_ERROR).`);
    });

    it("is left with nothing beside it after the refusal", () => {
      const { dir } = workspace();
      const raw = new Database(join(dir, "hubber.sqlite"));
      raw.pragma("user_version = 7");
      raw.close();

      failure(dir);

      expect(entries(dir)).toEqual(LAYOUT);
    });
  });

  // The fourth step: the database is brought to the schema of this code, after every check of the pin.
  describe("the schema of the database", () => {
    const MIGRATIONS = readMigrations();
    const TAGS = MIGRATIONS.map(({ tag }) => tag);
    const HEAD = MIGRATIONS.at(-1);
    const NAMED = `Nie można otworzyć workspace'u „${TEST_WORKSPACE.name}”: `;
    const UNCHANGED = "Baza nie została zmieniona.";
    const TAKEN_BACK = "Zmiany zostały wycofane i baza jest w stanie sprzed uruchomienia.";
    const ROLLED_BACK = `${TAKEN_BACK} To błąd tej wersji aplikacji: wróć do poprzedniej wersji kodu albo popraw migrację.`;
    // For what SQLite says of the disk, the memory or the file: no fault of a migration.
    const FREE_SPACE = "Zwolnij miejsce na dysku i uruchom aplikację ponownie.";
    const NOT_THE_MIGRATION = "Ten kod oznacza kłopot z dyskiem, pamięcią albo plikiem bazy, a nie błąd w migracji.";
    const CHECK_THE_DISK =
      "Sprawdź dysk i dostęp do katalogu workspace'u, a potem uruchom aplikację ponownie; gdy błąd się powtarza, odtwórz cały katalog z kopii zapasowej.";
    const MIGRATED_LAYOUT = ["backups", ...LAYOUT];
    /** All that the database of a workspace held before the application had a schema: the pin with its triggers. */
    const PIN_ALONE = [
      "workspace_pin",
      "workspace_pin_insert_once",
      "workspace_pin_no_delete",
      "workspace_pin_no_update",
    ];

    /** A workspace as it was created before the application had a schema: its database holds the pin and nothing else. */
    function unmigrated(profile: Partial<LlmProfile> = { endpoint: ROUTER }): TestWorkspace {
      const created = createUnmigratedTestWorkspace(profile);
      workspaces.push(created);
      return created;
    }

    /** Opens as the server does, with somebody to tell about a migration. */
    function openTelling(dir: string): { found: OpenWorkspace; lines: string[] } {
      const lines: string[] = [];
      const found = openWorkspace({ dir, source: "variable" }, {}, DIRECT_TRANSPORT, {
        log: (line) => lines.push(line),
      });
      opened.push(found);
      return { found, lines };
    }

    /** A connection that goes around the checks, for looking at a database and for damaging one. */
    function raw(dir: string): Database.Database {
      const db = new Database(join(dir, "hubber.sqlite"));
      connections.push(db);
      return db;
    }

    const objectsOf = (db: Database.Database) =>
      db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all();
    const copiesIn = (dir: string) =>
      existsSync(join(dir, "backups")) ? readdirSync(join(dir, "backups")).sort() : [];

    it("finds the database of a new workspace current: nothing is migrated, said or written", () => {
      const { dir } = workspace();
      const database = join(dir, "hubber.sqlite");
      const before = { changed: statSync(database).mtimeMs, digest: digest(database) };

      const { found, lines } = openTelling(dir);

      expect(found.migration).toEqual({ applied: [], snapshot: null });
      expect(lines).toEqual([]);
      expect(schemaFingerprint(found.database)).toBe(HEAD?.schema);
      found.close();
      expect(entries(dir)).toEqual(LAYOUT);
      expect({ changed: statSync(database).mtimeMs, digest: digest(database) }).toEqual(before);
    });

    it("migrates a workspace whose database holds the pin alone, with a copy of that database first, and says so", () => {
      const { dir } = unmigrated();
      const before = raw(dir);
      // What such a workspace has: one table with its triggers, and format 1.
      expect(objectsOf(before)).toEqual(PIN_ALONE);
      expect(before.pragma("user_version", { simple: true })).toBe(1);
      before.close();
      expect(entries(dir)).toEqual(LAYOUT);

      const { found, lines } = openTelling(dir);

      const [copy] = copiesIn(dir);
      expect(copiesIn(dir)).toEqual([expect.stringMatching(new RegExp(`^before-${TAGS[0]}-\\d{8}T\\d{9}Z\\.sqlite$`))]);
      expect(found.migration).toEqual({ applied: TAGS, snapshot: join(dir, "backups", copy ?? "") });
      expect(lines).toEqual([
        `Baza workspace'u wymaga aktualizacji (${TAGS.join(", ")}). Robię kopię i aktualizuję; Ctrl-C zadziała po zakończeniu.`,
        `Baza zaktualizowana. Kopia sprzed aktualizacji: "${join(dir, "backups", copy ?? "")}".`,
      ]);
      // The words that whoever reads the output of the server goes by.
      expect(lines.map((line) => [isMigrationNotice(line), isMigrationDone(line)])).toEqual([
        [true, false],
        [false, true],
      ]);
      expect(schemaFingerprint(found.database)).toBe(HEAD?.schema);
      expect(readWorkspacePin(found.database)).toEqual({ endpoint: ROUTER, createdAt: found.config.createdAt });
      expect(found.database.pragma("user_version", { simple: true })).toBe(1);
      expect(found.database.pragma("foreign_keys", { simple: true })).toBe(1);
      // The copy holds what the workspace was: the pin alone.
      const copied = new Database(join(dir, "backups", copy ?? ""), { readonly: true });
      connections.push(copied);
      expect(objectsOf(copied)).toEqual(PIN_ALONE);
      found.close();
      expect(entries(dir)).toEqual(MIGRATED_LAYOUT);
      expect((statSync(join(dir, "backups")).mode & 0o777).toString(8)).toBe("700");
      expect((statSync(join(dir, "backups", copy ?? "")).mode & 0o777).toString(8)).toBe("600");
    });

    // The update is committed and the log beside the file could not be folded back into it. The
    // start goes on, and a third line says where the update is for the time being.
    it.each<[string, string, string]>([
      [
        "the disk has no room for it",
        "SQLITE_FULL",
        "Na dysku brakuje miejsca: zmiany są na razie w pliku hubber.sqlite-wal obok bazy. Zwolnij miejsce.",
      ],
      [
        "of anything else that SQLite reports",
        "SQLITE_IOERR_WRITE",
        "Nie udało się przenieść zmian do pliku bazy (SQLITE_IOERR_WRITE): są na razie w pliku hubber.sqlite-wal obok bazy. Sprawdź dysk i dostęp do katalogu workspace'u.",
      ],
    ])(
      "says after the update that its changes are still in the log beside the database, when they could not be moved into the file because %s",
      (_what, code, line) => {
        const { dir } = unmigrated();
        sqlite.checkpointFails = code;

        const { found, lines } = openTelling(dir);

        const copy = join(dir, "backups", copiesIn(dir)[0] ?? "");
        expect(lines).toEqual([
          `Baza workspace'u wymaga aktualizacji (${TAGS.join(", ")}). Robię kopię i aktualizuję; Ctrl-C zadziała po zakończeniu.`,
          `Baza zaktualizowana. Kopia sprzed aktualizacji: "${copy}".`,
          line,
        ]);
        // None of the lines that whoever reads the output of the server goes by.
        expect([isMigrationNotice(line), isMigrationDone(line), isWorkspaceRefusal(line)]).toEqual([
          false,
          false,
          false,
        ]);
        // What the line says is so: the workspace is open at the schema of this code, and the log holds the update.
        expect(found.migration).toEqual({ applied: TAGS, snapshot: copy, checkpointFailed: code });
        expect(schemaFingerprint(found.database)).toBe(HEAD?.schema);
        expect(statSync(join(dir, "hubber.sqlite-wal")).size).toBeGreaterThan(0);
      },
    );

    it("does it once: the next open finds the database current and makes no second copy", () => {
      const { dir } = unmigrated();
      openTelling(dir).found.close();
      const copies = copiesIn(dir);

      const { found, lines } = openTelling(dir);

      expect(found.migration).toEqual({ applied: [], snapshot: null });
      expect(lines).toEqual([]);
      expect(copiesIn(dir)).toEqual(copies);
    });

    it("migrates without anybody to tell", () => {
      const { dir } = unmigrated();

      // As a caller without a log calls it.
      expect(open(dir).migration.applied).toEqual(TAGS);
    });

    it.each<[string, (dir: string) => WorkspaceError]>([
      [
        "whose configuration file names another endpoint than its pin",
        (dir) => {
          editEndpoint(dir, OTHER);
          return refusal(dir);
        },
      ],
      ["in an environment that names another endpoint", (dir) => refusal(dir, { ANTHROPIC_BASE_URL: OTHER })],
      ["in a process that would not connect directly", (dir) => refusal(dir, {}, { proxySupport: true })],
    ])("migrates nothing in a workspace %s: the checks of the pin come first", (_what, refused) => {
      const { dir } = unmigrated();

      expect([2, 3]).toContain(refused(dir).exitCode);

      expect(entries(dir)).toEqual(LAYOUT);
      expect(objectsOf(raw(dir))).toEqual(PIN_ALONE);
    });

    describe("that cannot be brought up to date", () => {
      /** The refusal of a start that needs a migration, with what all of them have in common. */
      function reasonOf(dir: string): string {
        const error = refusal(dir);
        expect(error.exitCode).toBe(1);
        expect(error.message.startsWith(NAMED)).toBe(true);
        return error.message.slice(NAMED.length);
      }

      it.each<[string, MigrationError, (database: string) => string]>([
        [
          "a statement of a migration fails",
          new MigrationError("statement-failed", { tag: "0002_next", statement: 3, code: "SQLITE_CONSTRAINT_CHECK" }),
          () =>
            `aktualizacja bazy nie powiodła się w migracji 0002_next (polecenie 3: SQLITE_CONSTRAINT_CHECK). ${ROLLED_BACK}`,
        ],
        [
          "a statement of a migration fails because the disk is full",
          new MigrationError("statement-failed", { tag: "0002_next", statement: 12, code: "SQLITE_FULL" }),
          () =>
            `aktualizacja bazy nie powiodła się w migracji 0002_next (polecenie 12: SQLITE_FULL), bo na dysku zabrakło miejsca. ${TAKEN_BACK} ${FREE_SPACE}`,
        ],
        ...[
          "SQLITE_IOERR_WRITE",
          "SQLITE_NOMEM",
          "SQLITE_CORRUPT",
          "SQLITE_NOTADB",
          "SQLITE_READONLY",
          "SQLITE_CANTOPEN",
        ].map((code): [string, MigrationError, () => string] => [
          `a statement of a migration fails with ${code}, which is no fault of the migration`,
          new MigrationError("statement-failed", { tag: "0002_next", statement: 3, code }),
          () =>
            `aktualizacja bazy nie powiodła się w migracji 0002_next (polecenie 3: ${code}). ${NOT_THE_MIGRATION} ${TAKEN_BACK} ${CHECK_THE_DISK}`,
        ]),
        [
          "a migration ended the transaction itself, with the copy that was kept for the way back",
          new MigrationError("statement-failed", {
            tag: "0002_next",
            statement: 3,
            code: "TRANSACTION_ENDED",
            snapshot: "before-0002_next-20261011T120000000Z.sqlite",
          }),
          (database) =>
            `migracja 0002_next sama zakończyła transakcję aktualizacji (polecenie 3), więc część jej zmian mogła zostać w bazie. Stan sprzed uruchomienia jest w kopii "${join(dirname(database), "backups", "before-0002_next-20261011T120000000Z.sqlite")}". To błąd tej wersji aplikacji: zanim uruchomisz ją ponownie, odtwórz bazę z tej kopii, a potem wróć do poprzedniej wersji kodu albo popraw migrację.`,
        ],
        [
          "a migration ended the transaction itself and there is no copy",
          new MigrationError("statement-failed", { tag: "0002_next", statement: 3, code: "TRANSACTION_ENDED" }),
          () =>
            "migracja 0002_next sama zakończyła transakcję aktualizacji (polecenie 3), więc część jej zmian mogła zostać w bazie. To błąd tej wersji aplikacji: zanim uruchomisz ją ponownie, odtwórz cały katalog z kopii zapasowej, a potem wróć do poprzedniej wersji kodu albo popraw migrację.",
        ],
        [
          "rows would be left pointing at rows that do not exist",
          new MigrationError("foreign-keys", { tag: "0002_next", table: "mentions", parent: "sources" }),
          () =>
            `aktualizacja bazy zostawiłaby rekordy wskazujące na nieistniejące obiekty (migracja 0002_next, tabela mentions, odwołanie do sources). ${ROLLED_BACK}`,
        ],
        [
          "a migration leaves another schema than the one recorded for it",
          new MigrationError("schema-drift", { tag: "0002_next", whileMigrating: true }),
          () => `po migracji 0002_next schemat bazy różni się od zapisanego w kodzie. ${ROLLED_BACK}`,
        ],
        [
          "the schema is not the one the migrations leave",
          new MigrationError("schema-drift", { tag: "0001_first", whileMigrating: false }),
          (database) =>
            `schemat bazy "${database}" różni się od tego, który zostawiają migracje tej wersji (ostatnia: 0001_first): czegoś w nim brakuje albo coś zmieniono poza aplikacją. ${UNCHANGED} ${RESTORE_HINT}`,
        ],
        [
          "the schema is not the one that the last migration the database has had leaves, and another one waits",
          new MigrationError("schema-drift", { tag: "0001_first", whileMigrating: false, pendingTag: "0002_next" }),
          (database) =>
            `schemat bazy "${database}" różni się od tego, który zostawiła ostatnia wykonana na niej migracja (0001_first): czegoś w nim brakuje albo coś zmieniono poza aplikacją. Takiej bazy nie da się zaktualizować. ${UNCHANGED} ${RESTORE_HINT}`,
        ],
        [
          "the database has had no migration and holds what the application did not make",
          new MigrationError("schema-drift", { whileMigrating: false, pendingTag: "0001_first" }),
          (database) =>
            `baza "${database}" nie przeszła jeszcze żadnej migracji, a są w niej tabele albo inne obiekty, których nie utworzyła aplikacja. Takiej bazy nie da się zaktualizować. ${UNCHANGED} ${RESTORE_HINT}`,
        ],
        [
          "another process has the workspace open",
          new MigrationError("in-use", { code: "SQLITE_BUSY" }),
          () =>
            `baza wymaga aktualizacji, a workspace jest otwarty w innym procesie Hubbera. Zatrzymaj go i uruchom aplikację ponownie. ${UNCHANGED}`,
        ],
        [
          "the disk has no room for the copy",
          // Rounded apart: what is needed up, what is free down.
          new MigrationError("no-space", { neededBytes: 711_000_001, freeBytes: 12_999_999 }),
          () =>
            `przed aktualizacją bazy trzeba zrobić jej kopię, a na dysku brakuje miejsca: sama kopia potrzebuje około 712 MB, a wolne jest 12 MB. Aktualizacja potrzebuje potem jeszcze dodatkowego miejsca. ${UNCHANGED}`,
        ],
        [
          "the copy cannot be made",
          new MigrationError("snapshot-failed", { code: "EACCES" }),
          () =>
            `nie udało się zrobić kopii bazy przed aktualizacją (EACCES). Bez kopii aktualizacja się nie zaczyna. ${UNCHANGED}`,
        ],
        [
          "a newer version has migrated the database",
          new MigrationError("newer", { databaseTag: "0003_later", codeTag: "0001_first" }),
          (database) =>
            `bazę "${database}" zaktualizowała nowsza wersja Hubbera (ostatnia migracja w bazie: 0003_later, ta wersja zna 0001_first). Uruchom wersję, która ją zaktualizowała, albo nowszą.`,
        ],
        [
          "the database has another history than this code",
          new MigrationError("diverged", { tag: "0001_first" }),
          (database) =>
            `historia migracji w bazie "${database}" różni się od tej wersji kodu (migracja 0001_first). ${UNCHANGED} Uruchom wersję aplikacji, która tę bazę aktualizowała.`,
        ],
      ])("says so in the owner's words when %s, and closes the database again", (_what, failure, words) => {
        const { dir } = workspace();
        runner.failure = failure;

        expect(reasonOf(dir)).toBe(words(join(dir, "hubber.sqlite")));

        // Closed, not abandoned: a database left open keeps its -wal and -shm files.
        expect(entries(dir)).toEqual(LAYOUT);
      });

      it("refuses a database whose schema was changed past the migrations, and leaves it as it is", () => {
        const { dir } = workspace();
        const outside = raw(dir);
        const trigger = outside
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name <> 'workspace_pin' LIMIT 1")
          .pluck()
          .get() as string;
        outside.exec(`DROP TRIGGER ${trigger}`);
        outside.close();
        const database = join(dir, "hubber.sqlite");
        const before = digest(database);

        expect(reasonOf(dir)).toBe(
          `schemat bazy "${database}" różni się od tego, który zostawiają migracje tej wersji (ostatnia: ${HEAD?.tag}): czegoś w nim brakuje albo coś zmieniono poza aplikacją. ${UNCHANGED} ${RESTORE_HINT}`,
        );

        expect(entries(dir)).toEqual(LAYOUT);
        expect(digest(database)).toBe(before);
      });

      it("refuses a database that a newer version migrated, and names the copy from before that update when it is there", () => {
        const { dir } = unmigrated();
        open(dir).close();
        const database = join(dir, "hubber.sqlite");
        const copy = "before-0099_later-20261011T120000000Z.sqlite";
        const outside = raw(dir);
        outside
          .prepare(
            `INSERT INTO ${MIGRATIONS_TABLE} (idx, tag, sha256, applied_at, snapshot) VALUES (?, '0099_later', 'x', '2026-10-11T12:00:00.000Z', ?)`,
          )
          .run(TAGS.length + 1, copy);
        outside.close();
        const newer = `bazę "${database}" zaktualizowała nowsza wersja Hubbera (ostatnia migracja w bazie: 0099_later, ta wersja zna ${HEAD?.tag}). Uruchom wersję, która ją zaktualizowała, albo nowszą.`;

        // The copy is not there any more: only what to run is said.
        expect(reasonOf(dir)).toBe(newer);

        writeFileSync(join(dir, "backups", copy), "the state before that update");
        expect(reasonOf(dir)).toBe(
          `${newer} Stan sprzed tamtej aktualizacji jest w kopii "${join(dir, "backups", copy)}"; odtworzenie go usuwa wszystko, co zapisano później.`,
        );
        expect(entries(dir)).toEqual(MIGRATED_LAYOUT);
      });

      it("names as that copy only a file among the copies, whatever the record of the database says", () => {
        const { dir } = unmigrated();
        open(dir).close();
        const outside = raw(dir);
        // A record that somebody edited: the name leads out of the directory of the copies, to a file that exists.
        outside
          .prepare(
            `INSERT INTO ${MIGRATIONS_TABLE} (idx, tag, sha256, applied_at, snapshot) VALUES (?, '0099_later', 'x', '2026-10-11T12:00:00.000Z', '../workspace.json')`,
          )
          .run(TAGS.length + 1);
        outside.close();

        expect(reasonOf(dir)).not.toContain("workspace.json");
      });

      it("refuses a database whose record of migrations is not the history of this code", () => {
        const { dir } = workspace();
        const outside = raw(dir);
        outside.prepare(`UPDATE ${MIGRATIONS_TABLE} SET sha256 = 'edited' WHERE idx = 1`).run();
        outside.close();
        const database = join(dir, "hubber.sqlite");

        expect(reasonOf(dir)).toBe(
          `historia migracji w bazie "${database}" różni się od tej wersji kodu (migracja ${TAGS[0]}). ${UNCHANGED} Uruchom wersję aplikacji, która tę bazę aktualizowała.`,
        );
        expect(entries(dir)).toEqual(LAYOUT);
      });

      it("takes a migration back whose statement fails, and leaves no copy: the database is what it was", () => {
        const { dir } = unmigrated();
        // Something is in the way of the first statement of the first migration: the name of the
        // table it creates is taken. By an index on the table of the pin, which is no part of the
        // schema that a start compares: a table of that name would be found before the migration.
        const table = /CREATE TABLE (\w+)/.exec(MIGRATIONS[0]?.statements[0] ?? "")?.[1];
        const outside = raw(dir);
        outside.exec(`CREATE INDEX ${table} ON workspace_pin (endpoint)`);
        const before = objectsOf(outside);
        outside.close();

        expect(reasonOf(dir)).toBe(
          `aktualizacja bazy nie powiodła się w migracji ${TAGS[0]} (polecenie 1: SQLITE_ERROR). ${ROLLED_BACK}`,
        );

        expect(objectsOf(raw(dir))).toEqual(before);
        // The directory for the copies was made; the copy went with the migration.
        expect(copiesIn(dir)).toEqual([]);
      });

      it("refuses a database that was changed past the application before its first migration, and begins nothing", () => {
        const { dir } = unmigrated();
        const outside = raw(dir);
        outside.exec("CREATE TABLE notatki_wlasne (x TEXT)");
        outside.close();
        const database = join(dir, "hubber.sqlite");
        const before = digest(database);
        const lines: string[] = [];

        let error: unknown;
        try {
          openWorkspace({ dir, source: "variable" }, {}, DIRECT_TRANSPORT, { log: (line) => lines.push(line) });
        } catch (thrown) {
          error = thrown;
        }

        // The reason is the database as it was found, and no migration is blamed for it.
        expect((error as WorkspaceError).message).toBe(
          `${NAMED}baza "${database}" nie przeszła jeszcze żadnej migracji, a są w niej tabele albo inne obiekty, których nie utworzyła aplikacja. Takiej bazy nie da się zaktualizować. ${UNCHANGED} ${RESTORE_HINT}`,
        );
        expect((error as WorkspaceError).exitCode).toBe(1);
        // Nothing was announced, copied or written.
        expect(lines).toEqual([]);
        expect(entries(dir)).toEqual(LAYOUT);
        expect(digest(database)).toBe(before);
      });

      const NOT_THE_WORKSPACE = "To błąd kopii kodu aplikacji, a nie workspace'u";

      it.each<[string, () => MigrationFilesError, (dir: string) => string]>([
        [
          "a migration file holds other bytes than its manifest entry says",
          () =>
            new MigrationFilesError(MIGRATIONS_DIR, "Migration 0001_init differs from its entry in manifest.json.", {
              changedFile: join(MIGRATIONS_DIR, "0001_init.sql"),
            }),
          () =>
            `plik migracji "${join(MIGRATIONS_DIR, "0001_init.sql")}" ma inną treść niż ta, którą zapisano dla niego w pliku manifest.json. ${UNCHANGED} ${NOT_THE_WORKSPACE}: przywróć ten plik z repozytorium. Jego treść zmienia także narzędzie, które przepisuje końce wierszy. Gdy to nowa migracja, nad którą pracujesz, wklej do manifest.json wpis, który wypisuje test src/server/db/migrations.test.ts.`,
        ],
        [
          "a file of the migrations is missing",
          () =>
            new MigrationFilesError(MIGRATIONS_DIR, "ENOENT: no such file or directory, open", {
              missingFile: join(MIGRATIONS_DIR, "0002_next.sql"),
            }),
          () =>
            `w katalogu migracji tej wersji aplikacji brakuje pliku "${join(MIGRATIONS_DIR, "0002_next.sql")}". ${UNCHANGED} ${NOT_THE_WORKSPACE}: przywróć ten plik z repozytorium albo dokończ przerwaną aktualizację kodu.`,
        ],
        [
          "a file of the migrations cannot be read",
          () =>
            new MigrationFilesError(MIGRATIONS_DIR, "EACCES: permission denied, open", {
              unreadablePath: join(MIGRATIONS_DIR, "manifest.json"),
              code: "EACCES",
            }),
          () =>
            `nie udało się odczytać pliku "${join(MIGRATIONS_DIR, "manifest.json")}" z katalogu migracji tej wersji aplikacji (EACCES). ${UNCHANGED} ${NOT_THE_WORKSPACE}: sprawdź prawa dostępu do katalogu migracji albo przywróć go z repozytorium.`,
        ],
        [
          "the folder holds a migration file that the manifest does not list",
          () =>
            new MigrationFilesError(MIGRATIONS_DIR, "The migration file 0001_init copy.sql is not listed.", {
              unlistedFile: join(MIGRATIONS_DIR, "0001_init copy.sql"),
            }),
          () =>
            `w katalogu migracji tej wersji aplikacji jest plik "${join(MIGRATIONS_DIR, "0001_init copy.sql")}", którego nie wymienia manifest.json. ${UNCHANGED} ${NOT_THE_WORKSPACE}: usuń ten plik, jeśli jest kopią zostawioną przez edytor albo menedżer plików, albo dokończ przerwaną aktualizację kodu. Gdy to nowa migracja, nad którą pracujesz, dopisz ją do manifest.json.`,
        ],
        [
          "the manifest of the migrations is empty or cut short",
          () =>
            new MigrationFilesError(
              MIGRATIONS_DIR,
              "manifest.json cannot be read as JSON: Unexpected end of JSON input",
              { damagedManifest: join(MIGRATIONS_DIR, "manifest.json") },
            ),
          () =>
            `plik "${join(MIGRATIONS_DIR, "manifest.json")}" w katalogu migracji tej wersji aplikacji jest niepełny albo uszkodzony. ${UNCHANGED} ${NOT_THE_WORKSPACE}: przywróć ten plik z repozytorium albo dokończ przerwaną aktualizację kodu.`,
        ],
        [
          "the folder of the migrations breaks a rule that only a migration in the making can break",
          () =>
            new MigrationFilesError(
              MIGRATIONS_DIR,
              "Migration 0002_next, statement 3: a foreign key with an action is not allowed.",
            ),
          () =>
            `migracji tej wersji aplikacji nie da się odczytać z katalogu "${MIGRATIONS_DIR}". ${UNCHANGED} ${NOT_THE_WORKSPACE}: przywróć ten katalog z repozytorium albo popraw migrację, nad którą pracujesz. Szczegóły: Migration 0002_next, statement 3: a foreign key with an action is not allowed.`,
        ],
      ])("says in the owner's words that the code is at fault when %s, with exit code 1", (_what, failure, words) => {
        const { dir } = workspace();
        runner.failure = failure();

        expect(reasonOf(dir)).toBe(words(dir));

        expect(entries(dir)).toEqual(LAYOUT);
      });

      it("refuses to migrate while another connection has the database open, and changes nothing", () => {
        const { dir } = unmigrated();
        const holder = raw(dir);
        // Idle, as a server between two requests is; its first read is what keeps the file shared.
        holder.prepare("SELECT count(*) FROM sqlite_schema").get();
        sqlite.timeout = 100;

        expect(reasonOf(dir)).toBe(
          `baza wymaga aktualizacji, a workspace jest otwarty w innym procesie Hubbera. Zatrzymaj go i uruchom aplikację ponownie. ${UNCHANGED}`,
        );

        expect(objectsOf(holder)).toEqual(PIN_ALONE);
        expect(existsSync(join(dir, "backups"))).toBe(false);
        // Once the other one is gone, the same start goes through.
        holder.close();
        expect(open(dir).migration.applied).toEqual(TAGS);
      });

      it("says that the database is busy when another process holds it for itself, as a start that migrates does", () => {
        const { dir } = workspace();
        const holder = raw(dir);
        holder.pragma("locking_mode = EXCLUSIVE");
        holder.exec("BEGIN IMMEDIATE; COMMIT");
        sqlite.timeout = 100;

        expect(reasonOf(dir)).toBe(
          `baza "${join(dir, "hubber.sqlite")}" jest zajęta przez inny proces Hubbera (trwa jej aktualizacja albo zamykanie). Spróbuj ponownie za chwilę.`,
        );
      });

      it("says the same when the database turns out to be busy only while it is being brought up to date", () => {
        const { dir } = workspace();
        runner.failure = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY_SNAPSHOT" });

        expect(reasonOf(dir)).toBe(
          `baza "${join(dir, "hubber.sqlite")}" jest zajęta przez inny proces Hubbera (trwa jej aktualizacja albo zamykanie). Spróbuj ponownie za chwilę.`,
        );
        expect(entries(dir)).toEqual(LAYOUT);
      });

      it("words whatever else SQLite reports before a migration was begun as a database that cannot be opened", () => {
        const { dir } = workspace();
        // What a file that cannot be read gives while the start looks at what the database has had.
        runner.failure = Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR_READ" });

        const error = refusal(dir);

        expect(error.exitCode).toBe(1);
        expect(error.message).toBe(
          `Nie można otworzyć workspace'u: nie udało się otworzyć bazy "${join(dir, "hubber.sqlite")}" (SQLITE_IOERR_READ).`,
        );
        expect(entries(dir)).toEqual(LAYOUT);
      });

      it.each<[string, string, string]>([
        [
          "the disk fills up at the commit",
          "SQLITE_FULL",
          `aktualizacja bazy nie powiodła się (SQLITE_FULL), bo na dysku zabrakło miejsca. ${TAKEN_BACK} ${FREE_SPACE}`,
        ],
        [
          "the drive fails at the commit",
          "SQLITE_IOERR_FSYNC",
          `aktualizacja bazy nie powiodła się (SQLITE_IOERR_FSYNC). ${NOT_THE_MIGRATION} ${TAKEN_BACK} ${CHECK_THE_DISK}`,
        ],
        [
          "the runner's own record cannot be written",
          "SQLITE_CONSTRAINT_PRIMARYKEY",
          `aktualizacja bazy nie powiodła się (SQLITE_CONSTRAINT_PRIMARYKEY). ${ROLLED_BACK}`,
        ],
      ])(
        "says that the update failed, and that it was taken back, when %s: an error of SQLite that is no failed statement",
        (_what, code, words) => {
          const { dir } = workspace();
          runner.failure = Object.assign(new Error("reported by SQLite"), { code });
          runner.afterNotice = true;

          expect(reasonOf(dir)).toBe(words);
          expect(entries(dir)).toEqual(LAYOUT);
        },
      );

      it("still says that the database is busy when SQLite reports that after the notice", () => {
        const { dir } = workspace();
        runner.failure = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        runner.afterNotice = true;

        expect(reasonOf(dir)).toContain("jest zajęta przez inny proces Hubbera");
      });

      it("leaves an error that is a mistake in the code as it is, and closes the database all the same", () => {
        const { dir } = workspace();
        runner.failure = new TypeError("not a refusal");

        expect(() => open(dir)).toThrow(TypeError);
        expect(entries(dir)).toEqual(LAYOUT);
      });
    });
  });

  // The server builds the answer of /api/workspace from the name and the address of the open
  // workspace, and gives up, with an error that is no refusal, on an answer that the page would
  // not accept. So no workspace that opens may bring such a name or address: the rules for the
  // configuration file and the rules of the page have to agree where each of them ends.
  describe("what the interface is to show", () => {
    const PORT = 4605;

    /** Puts another name into the configuration file, as an edit by hand would. */
    function rename(dir: string, name: string): void {
      const path = join(dir, "workspace.json");
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), name }));
    }

    it.each<[string, string]>([
      ["one letter", "A"],
      ["as long as a name may be", "Ż".repeat(60)],
      ["an accent with no letter under it", String.fromCodePoint(0x301)],
      ["a letter beside a character that takes no room", `${String.fromCodePoint(0x200b)}Ł`],
      ["a letter between spaces that are cut off", ` ${String.fromCodePoint(0xa0)}Ł${String.fromCodePoint(0x3000)} `],
    ])("can be shown under a name that is %s", async (_what, name) => {
      const { dir } = workspace();
      rename(dir, name);

      const found = open(dir);
      const app = createApp({ port: PORT, workspace: { name: found.config.name, endpoint: found.endpoint.href } });

      const response = await app.request("/api/workspace", { headers: { host: `127.0.0.1:${PORT}` } });
      expect(await response.json()).toEqual({ name: name.trim(), endpointOrigin: "https://router.corp.example" });
    });

    it("is shown under the name as a page would draw it: a run of spaces is one space", () => {
      const { dir } = workspace();
      rename(dir, "Praca     B");

      const found = open(dir);

      expect(found.config.name).toBe("Praca B");
    });

    it.each<[string, Partial<LlmProfile>, string]>([
      [
        "the public API",
        { kind: "anthropic", endpoint: "https://api.anthropic.com", auth: "x-api-key" },
        "https://api.anthropic.com",
      ],
      [
        "a path of several segments",
        { endpoint: "https://router.corp.example/a%20b/v1" },
        "https://router.corp.example",
      ],
      ["a port of its own", { endpoint: "https://router.corp.example:8443" }, "https://router.corp.example:8443"],
      ["a name outside ASCII", { endpoint: "https://xn--bcher-kva.example/llm" }, "https://xn--bcher-kva.example"],
      ["an IPv4 address", { endpoint: "https://192.0.2.7/llm" }, "https://192.0.2.7"],
      ["an IPv6 address", { endpoint: "https://[2001:db8::1]:8443/llm" }, "https://[2001:db8::1]:8443"],
      ["this machine by name", { endpoint: "http://localhost:8080" }, "http://localhost:8080"],
      ["this machine by its IPv6 address", { endpoint: "http://[::1]:8080/v1" }, "http://[::1]:8080"],
    ])("can be shown when it is pinned to %s", async (_what, profile, origin) => {
      const found = open(workspace(profile).dir);

      const app = createApp({ port: PORT, workspace: { name: found.config.name, endpoint: found.endpoint.href } });

      const response = await app.request("/api/workspace", { headers: { host: `127.0.0.1:${PORT}` } });
      expect(await response.json()).toEqual({ name: TEST_WORKSPACE.name, endpointOrigin: origin });
    });

    // The other side of the same edge: what the page would not show does not open, and the
    // reason is a refusal in the user's words.
    it.each<[string, string]>([
      ["nothing but spaces", ` ${String.fromCodePoint(0xa0, 0x3000, 0xfeff)}\t`],
      // The page would show the label and nothing beside it.
      ["a character that takes no room", String.fromCodePoint(0x200b)],
      ["a blank that is no space", String.fromCodePoint(0x2800)],
      ["a soft hyphen between fillers", String.fromCodePoint(0x3164, 0xad, 0x3164)],
    ])("does not open under a name that is %s", (_what, name) => {
      const { dir } = workspace();
      rename(dir, name);

      const error = refusal(dir);

      expect(error.exitCode).toBe(1);
      expect(error.message).toBe(
        `Nie można otworzyć workspace'u: błąd w pliku konfiguracji "${join(dir, "workspace.json")}": name: nazwa jest pusta.`,
      );
    });

    it("does not open with an address that is not for the web", () => {
      const { dir } = workspace();
      editEndpoint(dir, "ftp://router.corp.example/llm");

      const error = refusal(dir);

      expect(error.exitCode).toBe(1);
      expect(error.message).toBe(
        `Nie można otworzyć workspace'u: błąd w pliku konfiguracji "${join(dir, "workspace.json")}": profile.endpoint: Adres endpointu musi zaczynać się od https://: "ftp://router.corp.example/llm".`,
      );
    });
  });
});
