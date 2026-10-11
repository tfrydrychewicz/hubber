import { join } from "node:path";
import { EXIT_FAILURE, EXIT_USAGE } from "./exit-codes.ts";
import { DEFAULT_API_PORT, HOST, PortError, parsePort } from "./ports.ts";

// What scripts/dev.ts sets: the Vite dev server always runs on the loopback address.
const DEV_ORIGIN_PATTERN = /^http:\/\/127\.0\.0\.1:\d+$/;

export class ServerConfigError extends Error {
  override name = "ServerConfigError";
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

export interface ServerConfig {
  port: number;
  /** Development only: the origins under which the Vite dev server can be opened. */
  devOrigins?: string[];
  /** Production only: the directory with the built web app. */
  webRoot?: string;
}

export interface ServerConfigDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** Where the production build is expected. */
  webRoot: string;
  fileExists: (path: string) => boolean;
}

/**
 * HUBBER_DEV_ORIGIN, set by scripts/dev.ts, is the development switch: the web app then
 * comes from the Vite dev server, so no static files are served and one more origin is
 * trusted. Without it the process is the whole application and needs the build.
 */
export function readServerConfig({ env, webRoot, fileExists }: ServerConfigDeps): ServerConfig {
  let port: number;
  try {
    port = parsePort(env.HUBBER_PORT, DEFAULT_API_PORT, "HUBBER_PORT");
  } catch (error) {
    if (error instanceof PortError) throw new ServerConfigError(error.message, EXIT_USAGE);
    throw error;
  }

  const devOrigin = env.HUBBER_DEV_ORIGIN;
  if (devOrigin !== undefined && devOrigin !== "") {
    // The pattern alone lets through what no browser sends as an Origin: port 80, a leading zero, a port above 65535.
    if (!DEV_ORIGIN_PATTERN.test(devOrigin) || !URL.canParse(devOrigin) || new URL(devOrigin).origin !== devOrigin) {
      throw new ServerConfigError(
        `Niepoprawna wartość HUBBER_DEV_ORIGIN: "${devOrigin}". Zmienną ustawia "npm run dev"; dozwolony jest tylko adres http://${HOST}:<port> w postaci, w jakiej wysyła go przeglądarka (port najwyżej 65535, bez zer wiodących, inny niż 80).`,
        EXIT_USAGE,
      );
    }
    // The dev server answers under both names, and a browser sends whichever the user typed.
    return { port, devOrigins: [devOrigin, devOrigin.replace(HOST, "localhost")] };
  }

  if (!fileExists(join(webRoot, "index.html"))) {
    throw new ServerConfigError(
      `Brak zbudowanej aplikacji w katalogu "${webRoot}". Uruchom "npm start".`,
      EXIT_FAILURE,
    );
  }
  return { port, webRoot };
}
