import { describe, expect, it } from "vitest";
import { EXIT_FAILURE, EXIT_PIN, EXIT_USAGE } from "../exit-codes.ts";
import { isWorkspaceRefusal, refusal, WorkspaceError } from "./errors.ts";

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

describe("WorkspaceError", () => {
  it("means a failed run unless it is given another exit code", () => {
    expect(new WorkspaceError("Nie udało się utworzyć workspace'u.").exitCode).toBe(EXIT_FAILURE);
    expect(new WorkspaceError("x", EXIT_USAGE).exitCode).toBe(EXIT_USAGE);
  });
});
