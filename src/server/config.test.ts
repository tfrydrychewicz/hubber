import { describe, expect, it } from "vitest";
import { readServerConfig, ServerConfigError } from "./config.ts";

const WEB_ROOT = "/repo/dist/web";

function read(env: Record<string, string> = {}, built = true) {
  return readServerConfig({ env, webRoot: WEB_ROOT, fileExists: (path) => built && path === `${WEB_ROOT}/index.html` });
}

function failure(env: Record<string, string>, built = true): ServerConfigError {
  try {
    read(env, built);
  } catch (error) {
    if (error instanceof ServerConfigError) return error;
    throw error;
  }
  throw new Error("readServerConfig did not throw");
}

describe("readServerConfig", () => {
  it("serves the built web app on the default port in production", () => {
    expect(read()).toEqual({ port: 4477, webRoot: WEB_ROOT });
    expect(read({ HUBBER_PORT: "5000" })).toEqual({ port: 5000, webRoot: WEB_ROOT });
  });

  it("refuses to start in production without a build", () => {
    const error = failure({}, false);

    expect(error.message).toBe(`Brak zbudowanej aplikacji w katalogu "${WEB_ROOT}". Uruchom "npm start".`);
    expect(error.exitCode).toBe(1);
  });

  it("trusts the dev server under both loopback names and serves no files in development", () => {
    expect(read({ HUBBER_DEV_ORIGIN: "http://127.0.0.1:5173" })).toEqual({
      port: 4477,
      devOrigins: ["http://127.0.0.1:5173", "http://localhost:5173"],
    });
  });

  it("needs no build in development", () => {
    expect(read({ HUBBER_DEV_ORIGIN: "http://127.0.0.1:5173" }, false)).not.toHaveProperty("webRoot");
  });

  it("treats an empty HUBBER_DEV_ORIGIN as unset", () => {
    expect(read({ HUBBER_DEV_ORIGIN: "" })).toEqual({ port: 4477, webRoot: WEB_ROOT });
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
});
