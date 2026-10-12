import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_WORKSPACE } from "../testing.ts";
import { isWorkspaceRefusal, WorkspaceError } from "./errors.ts";
import { readWorkspace } from "./store.ts";
import { createTestWorkspace, TEST_PROFILE, type TestWorkspace } from "./testing.ts";

const PREFIX = "Nie można otworzyć workspace'u: ";
const CREATE_HINT = 'Utworzysz go poleceniem "npm run workspace:create -- --name <nazwa> --kind <anthropic|router>".';
const RESTORE_HINT = "Odtwórz cały katalog z kopii zapasowej.";
// An invented value: it stands for a credential that someone pasted into the file.
const SECRET = "sk-test-0123456789abcdef-not-a-real-key";

const workspaces: TestWorkspace[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    // A test may have closed the directory to its owner.
    chmodSync(workspace.dir, 0o700);
    workspace.remove();
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): TestWorkspace {
  const created = createTestWorkspace();
  workspaces.push(created);
  return created;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hubber-store-"));
  tempDirs.push(dir);
  return dir;
}

function read(dir: string, source: "variable" | "default" = "variable") {
  return readWorkspace({ dir, source });
}

/** The refusal, checked for what every refusal of this module has in common. */
function refusal(dir: string, source: "variable" | "default" = "variable"): string {
  try {
    read(dir, source);
  } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
    expect(error.exitCode).toBe(1);
    expect(isWorkspaceRefusal(error.message)).toBe(true);
    expect(error.message.startsWith(PREFIX)).toBe(true);
    return error.message.slice(PREFIX.length);
  }
  throw new Error("The workspace was read.");
}

/** Rewrites the configuration file of a workspace through a change to its JSON. */
function editConfig(dir: string, change: (file: Record<string, unknown>) => void): string {
  const path = join(dir, "workspace.json");
  const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  change(file);
  writeFileSync(path, JSON.stringify(file, null, 2));
  return path;
}

describe("readWorkspace", () => {
  it("reads the configuration of a workspace and says where its parts are", () => {
    const { dir } = workspace();

    const found = read(dir);

    expect(found.paths).toEqual({
      dir,
      config: join(dir, "workspace.json"),
      database: join(dir, "hubber.sqlite"),
      files: join(dir, "files"),
      backups: join(dir, "backups"),
    });
    expect(found.config).toMatchObject({ schemaVersion: 1, name: TEST_WORKSPACE.name, profile: TEST_PROFILE });
    expect(found.warnings).toEqual([]);
  });

  it("reads a workspace that is reached through a link, for instance to another volume", () => {
    const { dir } = workspace();
    const link = join(tempDir(), "link");
    symlinkSync(dir, link);

    expect(read(link).config.name).toBe(TEST_WORKSPACE.name);
  });

  it("does not mind other entries in the directory", () => {
    const { dir } = workspace();
    writeFileSync(join(dir, "hubber.sqlite-wal"), "");
    writeFileSync(join(dir, "kopia-przed-migracja.sqlite"), "");
    // What a workspace has once its database was migrated: the directory with the copies.
    mkdirSync(join(dir, "backups"));

    expect(read(dir).warnings).toEqual([]);
  });

  it("leaves the database alone: what is in that file is not its business", () => {
    const { dir } = workspace();
    writeFileSync(join(dir, "hubber.sqlite"), "not a database");

    expect(read(dir).config.name).toBe(TEST_WORKSPACE.name);
    expect(readFileSync(join(dir, "hubber.sqlite"), "utf8")).toBe("not a database");
  });

  it("says how to create the default workspace when there is none yet", () => {
    const dir = join(tempDir(), "Library", "Application Support", "Hubber", "workspaces", "default");

    expect(refusal(dir, "default")).toBe(
      `w domyślnym katalogu "${dir}" jeszcze go nie ma. ${CREATE_HINT} Inny katalog wskażesz zmienną HUBBER_WORKSPACE.`,
    );
  });

  it("says that the directory named by the variable does not exist", () => {
    const dir = join(tempDir(), "nowhere");

    expect(refusal(dir)).toBe(`katalog "${dir}" ze zmiennej HUBBER_WORKSPACE nie istnieje. ${CREATE_HINT}`);
  });

  it("takes a place below a file for a directory that does not exist", () => {
    const file = join(tempDir(), "a-file");
    writeFileSync(file, "data");
    const dir = join(file, "ws");

    expect(refusal(dir)).toBe(`katalog "${dir}" ze zmiennej HUBBER_WORKSPACE nie istnieje. ${CREATE_HINT}`);
  });

  it("refuses a file in the place of the directory", () => {
    const file = join(tempDir(), "a-file");
    writeFileSync(file, "data");

    expect(refusal(file)).toBe(`"${file}" nie jest katalogiem.`);
  });

  it.each([
    ["a directory without a configuration file", () => {}],
    ["a directory in which the configuration is a directory", (dir: string) => mkdirSync(join(dir, "workspace.json"))],
    // Reading a named pipe the ordinary way waits until someone writes into it: the start would hang.
    [
      "a directory in which the configuration is a named pipe",
      (dir: string) => execFileSync("/usr/bin/mkfifo", [join(dir, "workspace.json")]),
    ],
    [
      "a directory in which the configuration is a link to a device",
      (dir: string) => symlinkSync("/dev/zero", join(dir, "workspace.json")),
    ],
  ])("refuses %s as something that is not a workspace", (_what, prepare) => {
    const dir = tempDir();
    prepare(dir);

    expect(refusal(dir)).toBe(`katalog "${dir}" nie jest workspace'em Hubbera (brak pliku workspace.json).`);
  });

  it("reports the one problem of a configuration file in one sentence, with the path of the file", () => {
    const { dir } = workspace();
    const file = editConfig(dir, (config) => {
      config.name = "";
    });

    expect(refusal(dir)).toBe(`błąd w pliku konfiguracji "${file}": name: nazwa jest pusta.`);
  });

  it("ends the sentence about an address that cannot be used with one full stop", () => {
    const { dir } = workspace();
    const file = editConfig(dir, (config) => {
      (config.profile as Record<string, unknown>).endpoint = "http://router.corp.example";
    });

    expect(refusal(dir)).toBe(
      `błąd w pliku konfiguracji "${file}": profile.endpoint: Adres "http://router.corp.example" używa nieszyfrowanego http://. Poza tym komputerem (127.0.0.1, localhost) dozwolone jest tylko https://.`,
    );
  });

  it("lists several problems of a configuration file one per line", () => {
    const { dir } = workspace();
    const file = editConfig(dir, (config) => {
      config.name = "";
      config.extra = 1;
      (config.profile as Record<string, unknown>).apiKey = SECRET;
    });

    const message = refusal(dir);

    expect(message).toBe(
      `błędy w pliku konfiguracji "${file}":\n` +
        "  extra: nieznane pole (dozwolone: schemaVersion, name, createdAt, profile)\n" +
        "  name: nazwa jest pusta\n" +
        "  profile.apiKey: nieznane pole (Konfiguracja nie przechowuje poświadczeń)",
    );
    expect(message).not.toContain(SECRET);
  });

  it("reports a configuration file that is not JSON", () => {
    const { dir } = workspace();
    writeFileSync(join(dir, "workspace.json"), "{ not json");

    expect(refusal(dir)).toBe(
      `błąd w pliku konfiguracji "${join(dir, "workspace.json")}": plik nie jest poprawnym JSON-em (wiersz 1, kolumna 3).`,
    );
  });

  it.each([
    ["is missing", (path: string) => rmSync(path)],
    [
      "is a directory",
      (path: string) => {
        rmSync(path);
        mkdirSync(path);
      },
    ],
  ])("refuses a directory restored only in part: the database file %s", (_what, damage) => {
    const { dir } = workspace();
    damage(join(dir, "hubber.sqlite"));

    expect(refusal(dir)).toBe(`w katalogu "${dir}" brakuje pliku bazy hubber.sqlite. ${RESTORE_HINT}`);
  });

  it.each([
    ["is missing", (path: string) => rmSync(path, { recursive: true })],
    [
      "is a file",
      (path: string) => {
        rmSync(path, { recursive: true });
        writeFileSync(path, "");
      },
    ],
  ])("refuses a directory restored only in part: the directory for files %s", (_what, damage) => {
    const { dir } = workspace();
    damage(join(dir, "files"));

    expect(refusal(dir)).toBe(`w katalogu "${dir}" brakuje katalogu files. ${RESTORE_HINT}`);
  });

  it("reports the broken configuration first when the directory is damaged in more than one way", () => {
    const { dir } = workspace();
    rmSync(join(dir, "hubber.sqlite"));
    writeFileSync(join(dir, "workspace.json"), "[]");

    expect(refusal(dir)).toContain("plik nie zawiera obiektu JSON");
  });

  it("says that it was not let into the directory", () => {
    const { dir } = workspace();
    chmodSync(dir, 0o000);

    expect(refusal(dir)).toBe(`brak dostępu do katalogu "${dir}" (EACCES). Sprawdź uprawnienia katalogu i terminala.`);
  });

  // What the system answers when it cannot follow a path at all. Each is a refusal like the
  // others: the server ends with it, and the development runner goes by its first words.
  it.each<[string, string, (dir: string) => string]>([
    [
      "a directory that is a link to itself",
      "ELOOP",
      (dir) => {
        const loop = join(dir, "loop");
        symlinkSync("loop", loop);
        return loop;
      },
    ],
    ["a path with a name longer than the system takes", "ENAMETOOLONG", (dir) => join(dir, "n".repeat(300), "ws")],
  ])("refuses %s in its own words, with the code the system gave", (_what, code, place) => {
    const dir = place(tempDir());

    expect(refusal(dir)).toBe(`nie udało się odczytać katalogu "${dir}" (${code}).`);
  });

  it.each(["workspace.json", "hubber.sqlite", "files"])(
    "refuses a workspace whose %s is a link to itself, with the code the system gave",
    (name) => {
      const { dir } = workspace();
      rmSync(join(dir, name), { recursive: true });
      symlinkSync(name, join(dir, name));

      expect(refusal(dir)).toBe(`nie udało się odczytać katalogu "${dir}" (ELOOP).`);
    },
  );

  it("leaves an error that is no answer of the system as it is", () => {
    // A mistake in the code is to be seen as one, not to be worded as a problem of the directory.
    expect(() => readWorkspace({ dir: 7 as unknown as string, source: "variable" })).toThrow(TypeError);
  });

  it.each([
    ["755", 0o755],
    ["750", 0o750],
    ["701", 0o701],
  ])("warns about a directory that other accounts can get into (mode %s), and reads it all the same", (shown, mode) => {
    const { dir } = workspace();
    chmodSync(dir, mode);

    const found = read(dir);

    expect(found.warnings).toEqual([
      `Uwaga: katalog workspace'u "${dir}" jest dostępny dla innych kont tego komputera (uprawnienia ${shown}). Zamkniesz go poleceniem "chmod -R go-rwx" na tym katalogu.`,
    ]);
    expect(found.config.name).toBe(TEST_WORKSPACE.name);
  });
});
