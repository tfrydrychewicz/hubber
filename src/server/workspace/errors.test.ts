import { describe, expect, it } from "vitest";
import { EXIT_FAILURE, EXIT_INCONCLUSIVE, EXIT_PIN, EXIT_USAGE } from "../exit-codes.ts";
import {
  isMigrationDone,
  isMigrationNotice,
  isWorkspaceRefusal,
  MIGRATION_DONE,
  MIGRATION_NOTICE,
  refusal,
  unusableMigrations,
  WorkspaceError,
} from "./errors.ts";

describe("refusal", () => {
  it("starts with the same words whatever the reason, and exits with 1 unless told otherwise", () => {
    const error = refusal('"/data/praca" nie jest katalogiem.');

    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error.name).toBe("WorkspaceError");
    expect(error.message).toBe('Nie można otworzyć workspace\'u: "/data/praca" nie jest katalogiem.');
    expect(error.exitCode).toBe(EXIT_FAILURE);
  });

  it("carries the exit code of its kind", () => {
    expect(refusal("zmienna X nie nadaje się na adres.", EXIT_USAGE).exitCode).toBe(2);
    expect(refusal("jest przypięty do innego endpointu.", EXIT_PIN, "Praca").exitCode).toBe(3);
  });

  it("names the workspace once its configuration has told the name", () => {
    expect(refusal("jest przypięty do innego endpointu.", EXIT_PIN, "Praca").message).toBe(
      "Nie można otworzyć workspace'u „Praca”: jest przypięty do innego endpointu.",
    );
  });
});

describe("isWorkspaceRefusal", () => {
  it.each([
    ["a refusal without a name", refusal("katalog nie istnieje.").message],
    ["a refusal that names the workspace", refusal("jest przypięty.", EXIT_PIN, "Praca").message],
    ["the first line of a refusal that lists several problems", refusal("błędy w pliku:\n  a\n  b").message],
  ])("recognises %s", (_what, line) => {
    expect(isWorkspaceRefusal(line)).toBe(true);
  });

  it.each([
    [
      "the line of a start that worked",
      'Workspace „Praca”: katalog "/data/praca", endpoint https://router.corp.example.',
    ],
    ["the message about a taken port", "Port 4601 na 127.0.0.1 jest zajęty przez proces 123."],
    ["the refusal of the create command", 'Katalog "/data/praca" już istnieje.'],
    ["a line that only quotes the words", 'Uwaga: "Nie można otworzyć workspace\'u" to komunikat serwera.'],
    ["an empty line", ""],
  ])("does not take %s for a refusal", (_what, line) => {
    expect(isWorkspaceRefusal(line)).toBe(false);
  });
});

// The two lines of a start that migrates its database, as the server prints them.
describe("the lines about a migration", () => {
  const NOTICE =
    "Baza workspace'u wymaga aktualizacji (0001_init, 0002_next). Robię kopię i aktualizuję; Ctrl-C zadziała po zakończeniu.";
  const DONE =
    'Baza zaktualizowana. Kopia sprzed aktualizacji: "/data/praca/backups/before-0001_init-20261011T120000123Z.sqlite".';

  it("begin with words that say what they are about", () => {
    expect(NOTICE.startsWith(MIGRATION_NOTICE)).toBe(true);
    expect(DONE.startsWith(MIGRATION_DONE)).toBe(true);
    expect([MIGRATION_NOTICE, MIGRATION_DONE]).toEqual([
      "Baza workspace'u wymaga aktualizacji",
      "Baza zaktualizowana.",
    ]);
  });

  it("are told apart by those words", () => {
    expect([isMigrationNotice(NOTICE), isMigrationDone(NOTICE)]).toEqual([true, false]);
    expect([isMigrationNotice(DONE), isMigrationDone(DONE)]).toEqual([false, true]);
    expect([isWorkspaceRefusal(NOTICE), isWorkspaceRefusal(DONE)]).toEqual([false, false]);
  });

  it.each([
    [
      "a refusal about a migration",
      refusal("baza wymaga aktualizacji, a workspace jest otwarty w innym procesie Hubbera.").message,
    ],
    [
      "the line of a start that worked",
      'Workspace „Praca”: katalog "/data/praca", endpoint https://router.corp.example.',
    ],
    ["the address of the server", "API nasłuchuje pod adresem http://127.0.0.1:4601."],
    ["a line that only quotes the words", 'Uwaga: "Baza zaktualizowana." to komunikat serwera.'],
    ["an empty line", ""],
  ])("are not seen in %s", (_what, line) => {
    expect([isMigrationNotice(line), isMigrationDone(line)]).toEqual([false, false]);
  });
});

// The migrations are part of the code: when they cannot be used, the checkout is at fault and no workspace.
describe("unusableMigrations", () => {
  const FOLDER = "/code/hubber/src/server/db/migrations";
  const UNCHANGED = "Baza nie została zmieniona.";
  const NOT_THE_WORKSPACE = "To błąd kopii kodu aplikacji, a nie workspace'u";

  it("names the file that holds other bytes than its manifest entry says, and how to get it back", () => {
    const reason = unusableMigrations(
      {
        folder: FOLDER,
        changedFile: `${FOLDER}/0001_init.sql`,
        message: "Migration 0001_init differs from its entry.",
      },
      UNCHANGED,
    );

    // The last sentence is for whoever is writing the migration: that file is in no repository yet.
    expect(reason).toBe(
      `plik migracji "${FOLDER}/0001_init.sql" ma inną treść niż ta, którą zapisano dla niego w pliku manifest.json. ${UNCHANGED} ${NOT_THE_WORKSPACE}: przywróć ten plik z repozytorium. Jego treść zmienia także narzędzie, które przepisuje końce wierszy. Gdy to nowa migracja, nad którą pracujesz, wklej do manifest.json wpis, który wypisuje test src/server/db/migrations.test.ts.`,
    );
  });

  // The other faults that need no mistake in a migration: each has a sentence of its own, in Polish to its end.
  it.each<[string, Parameters<typeof unusableMigrations>[0], string]>([
    [
      "a file that the folder has to hold is not there, as after half of an update of the code",
      { folder: FOLDER, missingFile: `${FOLDER}/0002_next.sql`, message: "ENOENT: no such file or directory, open" },
      `w katalogu migracji tej wersji aplikacji brakuje pliku "${FOLDER}/0002_next.sql". ${UNCHANGED} ${NOT_THE_WORKSPACE}: przywróć ten plik z repozytorium albo dokończ przerwaną aktualizację kodu.`,
    ],
    [
      "a file of the folder cannot be read",
      {
        folder: FOLDER,
        unreadablePath: `${FOLDER}/0001_init.sql`,
        code: "EACCES",
        message: "EACCES: permission denied, open",
      },
      `nie udało się odczytać pliku "${FOLDER}/0001_init.sql" z katalogu migracji tej wersji aplikacji (EACCES). ${UNCHANGED} ${NOT_THE_WORKSPACE}: sprawdź prawa dostępu do katalogu migracji albo przywróć go z repozytorium.`,
    ],
    [
      "the folder itself cannot be listed",
      { folder: FOLDER, unreadablePath: FOLDER, code: "EACCES", message: "EACCES: permission denied, scandir" },
      `nie udało się odczytać katalogu migracji tej wersji aplikacji "${FOLDER}" (EACCES). ${UNCHANGED} ${NOT_THE_WORKSPACE}: sprawdź prawa dostępu do katalogu migracji albo przywróć go z repozytorium.`,
    ],
    [
      // Three ways to such a file, and a way out for each: a copy, half of an update, a migration in the making.
      "the folder holds a migration file that the manifest does not list, as a copy left by an editor or half of an update of the code",
      {
        folder: FOLDER,
        unlistedFile: `${FOLDER}/0001_init copy.sql`,
        message: "The migration file 0001_init copy.sql is not listed in manifest.json.",
      },
      `w katalogu migracji tej wersji aplikacji jest plik "${FOLDER}/0001_init copy.sql", którego nie wymienia manifest.json. ${UNCHANGED} ${NOT_THE_WORKSPACE}: usuń ten plik, jeśli jest kopią zostawioną przez edytor albo menedżer plików, albo dokończ przerwaną aktualizację kodu. Gdy to nowa migracja, nad którą pracujesz, dopisz ją do manifest.json.`,
    ],
    [
      "the manifest cannot be read as a list, as after half of a write or of an update of the code",
      {
        folder: FOLDER,
        damagedManifest: `${FOLDER}/manifest.json`,
        message: "manifest.json cannot be read as JSON: Unexpected end of JSON input",
      },
      `plik "${FOLDER}/manifest.json" w katalogu migracji tej wersji aplikacji jest niepełny albo uszkodzony. ${UNCHANGED} ${NOT_THE_WORKSPACE}: przywróć ten plik z repozytorium albo dokończ przerwaną aktualizację kodu.`,
    ],
  ])("says in a sentence of its own that %s", (_what, found, sentence) => {
    const reason = unusableMigrations(found, UNCHANGED);

    expect(reason).toBe(sentence);
    // Nothing of what the reader or the system said in English.
    expect(reason).not.toContain(found.message);
    expect(reason).not.toContain("Szczegóły");
  });

  it("names the folder for everything else that is wrong with it, with what the reader of the migrations said", () => {
    // The rules of a migration, for whoever is writing one: quoted as the reader states them.
    const reason = unusableMigrations(
      { folder: FOLDER, message: "Migration 0002_next, statement 3: a foreign key with an action is not allowed." },
      UNCHANGED,
    );

    expect(reason).toBe(
      `migracji tej wersji aplikacji nie da się odczytać z katalogu "${FOLDER}". ${UNCHANGED} ${NOT_THE_WORKSPACE}: przywróć ten katalog z repozytorium albo popraw migrację, nad którą pracujesz. Szczegóły: Migration 0002_next, statement 3: a foreign key with an action is not allowed.`,
    );
  });

  it("says nothing of a state when its caller has none to tell", () => {
    expect(unusableMigrations({ folder: FOLDER, changedFile: `${FOLDER}/0001_init.sql`, message: "x" })).toBe(
      `plik migracji "${FOLDER}/0001_init.sql" ma inną treść niż ta, którą zapisano dla niego w pliku manifest.json. ${NOT_THE_WORKSPACE}: przywróć ten plik z repozytorium. Jego treść zmienia także narzędzie, które przepisuje końce wierszy. Gdy to nowa migracja, nad którą pracujesz, wklej do manifest.json wpis, który wypisuje test src/server/db/migrations.test.ts.`,
    );
    expect(unusableMigrations({ folder: FOLDER, missingFile: `${FOLDER}/manifest.json`, message: "x" })).toBe(
      `w katalogu migracji tej wersji aplikacji brakuje pliku "${FOLDER}/manifest.json". ${NOT_THE_WORKSPACE}: przywróć ten plik z repozytorium albo dokończ przerwaną aktualizację kodu.`,
    );
  });

  it("is a refusal like any other once it completes the sentence", () => {
    const message = refusal(
      unusableMigrations({ folder: FOLDER, message: "x" }, "Baza nie została zmieniona."),
      EXIT_FAILURE,
      "Praca",
    ).message;

    expect(isWorkspaceRefusal(message)).toBe(true);
    expect(message.startsWith("Nie można otworzyć workspace'u „Praca”: migracji tej wersji aplikacji nie da się")).toBe(
      true,
    );
  });
});

describe("WorkspaceError", () => {
  it("means a failed run unless it is given another exit code", () => {
    expect(new WorkspaceError("Nie udało się utworzyć workspace'u.").exitCode).toBe(EXIT_FAILURE);
    expect(new WorkspaceError("x", EXIT_USAGE).exitCode).toBe(EXIT_USAGE);
  });
});

describe("the exit codes", () => {
  it("each mean one thing, under a number of its own", () => {
    // What a wrapper or a test tells apart: a failed run, a bad setting, a pin that kept the
    // workspace closed, and a measurement that could not be taken.
    expect([EXIT_FAILURE, EXIT_USAGE, EXIT_PIN, EXIT_INCONCLUSIVE]).toEqual([1, 2, 3, 4]);
  });
});
