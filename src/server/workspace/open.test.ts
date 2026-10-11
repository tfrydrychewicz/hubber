import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { TEST_WORKSPACE } from "../testing.ts";
import type { LlmProfile } from "./config.ts";
import { APPLICATION_ID, readWorkspacePin } from "./database.ts";
import { isWorkspaceRefusal, WorkspaceError } from "./errors.ts";
import { type OpenWorkspace, openWorkspace } from "./open.ts";
import { createTestWorkspace, TEST_PROFILE, type TestWorkspace } from "./testing.ts";
import { DIRECT_TRANSPORT, type TransportState } from "./transport.ts";

// What reading the process gives, for the one test that lets openWorkspace() read it: the test
// says what is found, so that it does not depend on how the tests themselves were started. That
// the real reading is right is shown in transport.test.ts, on real processes.
const processState = vi.hoisted(() => ({ found: undefined as unknown }));
vi.mock("./transport.ts", async (importOriginal) => {
  const real = await importOriginal<{ readTransportState: () => unknown }>();
  return { ...real, readTransportState: () => processState.found ?? real.readTransportState() };
});

const ROUTER = "https://router.corp.example/llm";
const OTHER = "https://other.corp.example";
const LAYOUT = ["files", "hubber.sqlite", "workspace.json"];
const RESTORE_HINT = "Odtwórz cały katalog z kopii zapasowej.";

const workspaces: TestWorkspace[] = [];
const opened: OpenWorkspace[] = [];

afterEach(() => {
  processState.found = undefined;
  for (const workspace of opened.splice(0)) workspace.close();
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
