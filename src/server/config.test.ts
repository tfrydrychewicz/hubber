import { describe, expect, it, vi } from "vitest";
import { readServerConfig, ServerConfigError } from "./config.ts";

const WEB_ROOT = "/repo/dist/web";
// Nothing is at this path: where the workspace is gets decided without a look at the disk.
const WORKSPACE_DIR = "/dane/hubber/praca";
const WORKSPACE = { dir: WORKSPACE_DIR, source: "variable" };
const DEV_ORIGIN = "http://127.0.0.1:5173";

/** Reads exactly the environment it is given. */
function readBare(env: Record<string, string>, built = true) {
  return readServerConfig({ env, webRoot: WEB_ROOT, fileExists: (path) => built && path === `${WEB_ROOT}/index.html` });
}

/** Reads an environment that names the workspace, as every start that gets anywhere does. */
function read(env: Record<string, string> = {}, built = true) {
  return readBare({ HUBBER_WORKSPACE: WORKSPACE_DIR, ...env }, built);
}

function failureOf(attempt: () => unknown): ServerConfigError {
  try {
    attempt();
  } catch (error) {
    if (error instanceof ServerConfigError) return error;
    throw error;
  }
  throw new Error("readServerConfig did not throw");
}

const failure = (env: Record<string, string>, built = true) => failureOf(() => read(env, built));
const bareFailure = (env: Record<string, string>, built = true) => failureOf(() => readBare(env, built));

describe("readServerConfig", () => {
  it("serves the built web app on the default port in production", () => {
    expect(read()).toEqual({ port: 4477, workspace: WORKSPACE, webRoot: WEB_ROOT });
    expect(read({ HUBBER_PORT: "5000" })).toEqual({ port: 5000, workspace: WORKSPACE, webRoot: WEB_ROOT });
  });

  it("refuses to start in production without a build", () => {
    const error = failure({}, false);

    expect(error.message).toBe(`Brak zbudowanej aplikacji w katalogu "${WEB_ROOT}". Uruchom "npm start".`);
    expect(error.exitCode).toBe(1);
  });

  it("trusts the dev server under both loopback names and serves no files in development", () => {
    expect(read({ HUBBER_DEV_ORIGIN: DEV_ORIGIN })).toEqual({
      port: 4477,
      workspace: WORKSPACE,
      devOrigins: ["http://127.0.0.1:5173", "http://localhost:5173"],
    });
  });

  it("needs no build in development", () => {
    expect(read({ HUBBER_DEV_ORIGIN: DEV_ORIGIN }, false)).not.toHaveProperty("webRoot");
  });

  it("treats an empty HUBBER_DEV_ORIGIN as unset", () => {
    expect(read({ HUBBER_DEV_ORIGIN: "" })).toEqual({ port: 4477, workspace: WORKSPACE, webRoot: WEB_ROOT });
  });

  it.each([
    "http://localhost:5173",
    "http://192.168.1.10:5173",
    "https://127.0.0.1:5173",
    "http://127.0.0.1:5173/",
    "http://127.0.0.1",
    // Each of these names the loopback address, yet no browser sends it as an Origin.
    "http://127.0.0.1:80",
    "http://127.0.0.1:65536",
    "http://127.0.0.1:04711",
    "http://attacker.example:5173",
    "*",
  ])("rejects the development origin %j as a usage error", (origin) => {
    const error = failure({ HUBBER_DEV_ORIGIN: origin });

    expect(error.message).toContain(`Niepoprawna wartość HUBBER_DEV_ORIGIN: "${origin}"`);
    expect(error.exitCode).toBe(2);
  });

  it("says what else is required of a value that already has the form of the address it asks for", () => {
    expect(failure({ HUBBER_DEV_ORIGIN: "http://127.0.0.1:80" }).message).toBe(
      'Niepoprawna wartość HUBBER_DEV_ORIGIN: "http://127.0.0.1:80". Zmienną ustawia "npm run dev"; ' +
        "dozwolony jest tylko adres http://127.0.0.1:<port> w postaci, w jakiej wysyła go przeglądarka " +
        "(port najwyżej 65535, bez zer wiodących, inny niż 80).",
    );
  });

  it("reports an invalid port as a usage error", () => {
    const error = failure({ HUBBER_PORT: "80" });

    expect(error.message).toContain('Niepoprawna wartość HUBBER_PORT: "80"');
    expect(error.exitCode).toBe(2);
  });

  describe("the place of the workspace", () => {
    it("is the directory that HUBBER_WORKSPACE names, in development as in production", () => {
      expect(read().workspace).toEqual({ dir: WORKSPACE_DIR, source: "variable" });
      expect(read({ HUBBER_DEV_ORIGIN: DEV_ORIGIN }, false).workspace).toEqual(WORKSPACE);
    });

    it("is the default directory under HOME when the variable is not set or is empty", () => {
      const byDefault = {
        dir: "/Users/ola/Library/Application Support/Hubber/workspaces/default",
        source: "default",
      };

      expect(readBare({ HOME: "/Users/ola" }).workspace).toEqual(byDefault);
      expect(readBare({ HOME: "/Users/ola", HUBBER_WORKSPACE: "" }).workspace).toEqual(byDefault);
    });

    it("is only named: nothing is looked up on the disk but the build", () => {
      const fileExists = vi.fn(() => true);

      const config = readServerConfig({ env: { HUBBER_WORKSPACE: WORKSPACE_DIR }, webRoot: WEB_ROOT, fileExists });

      // A directory that does not exist is accepted here. That it is missing is said by whoever opens it.
      expect(config.workspace.dir).toBe(WORKSPACE_DIR);
      expect(fileExists.mock.calls).toEqual([[`${WEB_ROOT}/index.html`]]);
    });

    it.each<[string, Record<string, string>, string]>([
      [
        "a relative path",
        { HUBBER_WORKSPACE: "dane/praca", HOME: "/Users/ola" },
        'Niepoprawna wartość HUBBER_WORKSPACE: "dane/praca". Podaj pełną ścieżkę katalogu workspace\'u (od "/" albo "~/").',
      ],
      [
        "a path under a home directory that the environment does not name",
        { HUBBER_WORKSPACE: "~/praca" },
        'Niepoprawna wartość HUBBER_WORKSPACE: "~/praca". Znak "~" wymaga zmiennej HOME; podaj pełną ścieżkę.',
      ],
      [
        "neither a workspace nor a home directory",
        {},
        "Nie wskazano workspace'u. Ustaw zmienną HUBBER_WORKSPACE na katalog workspace'u; bez zmiennej HOME nie ma katalogu domyślnego.",
      ],
    ])("reports %s as a usage error", (_what, env, message) => {
      const error = bareFailure(env);

      expect(error.message).toBe(message);
      expect(error.exitCode).toBe(2);
    });

    it("is checked after the port", () => {
      const error = bareFailure({ HUBBER_PORT: "80", HUBBER_WORKSPACE: "dane/praca" });

      expect(error.message).toContain("Niepoprawna wartość HUBBER_PORT");
    });

    it("is checked before the development origin and before the build", () => {
      expect(bareFailure({ HUBBER_WORKSPACE: "dane/praca", HUBBER_DEV_ORIGIN: "*" }).message).toContain(
        "Niepoprawna wartość HUBBER_WORKSPACE",
      );

      const withoutBuild = bareFailure({ HUBBER_WORKSPACE: "dane/praca" }, false);
      expect(withoutBuild.message).toContain("Niepoprawna wartość HUBBER_WORKSPACE");
      expect(withoutBuild.exitCode).toBe(2);
    });
  });
});
