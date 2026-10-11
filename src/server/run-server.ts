// The server process from start to finish: reads the environment, listens on the loopback
// address only, opens the workspace, and shuts down on the usual signals.
import { existsSync } from "node:fs";
import { createApp } from "./app.ts";
import { busyPortMessage } from "./busy-port.ts";
import { readServerConfig, type ServerConfig, type ServerConfigDeps, ServerConfigError } from "./config.ts";
import { EXIT_FAILURE } from "./exit-codes.ts";
import { PortInUseError, startServer } from "./listen.ts";
import { createCredentialProvider, describeCredentialStatus } from "./llm/credentials/provider.ts";
import { createShutdown } from "./shutdown.ts";
import { WorkspaceError } from "./workspace/errors.ts";
import { REPOSITORY_ROOT } from "./workspace/layout.ts";
import { type OpenWorkspace, openWorkspace } from "./workspace/open.ts";

const SHUTDOWN_DEADLINE_MS = 3_000;

/**
 * The environment to read, and the directory where the built web app is expected. The environment
 * is the copy that the entry point took before it removed the SDK's variables from the live one:
 * the address and the credential that the environment names are read from here and nowhere else.
 */
export type RunServerOptions = Pick<ServerConfigDeps, "env" | "webRoot">;

function fail(message: string, exitCode: number): never {
  console.error(message);
  process.exit(exitCode);
}

function readConfig({ env, webRoot }: RunServerOptions): ServerConfig {
  try {
    return readServerConfig({ env, webRoot, fileExists: existsSync });
  } catch (error) {
    if (error instanceof ServerConfigError) fail(error.message, error.exitCode);
    throw error;
  }
}

/**
 * Starts the server and leaves it running until one of the usual signals shuts it down.
 * A start that cannot succeed ends the process with a message for the user and the matching
 * exit code.
 */
export async function runServer(options: RunServerOptions): Promise<void> {
  // Whatever this process creates (the side files of the database, later dropped files and the
  // copies made before a migration) is for the owner alone, also where a library creates the file.
  process.umask(0o077);

  // The place of the workspace is one of the settings. The app gets the open workspace instead.
  const { workspace: location, ...config } = readConfig(options);

  let workspace: OpenWorkspace | undefined;
  const server = await startServer({
    port: config.port,
    // Built once the port is bound, so that a taken port is reported without reading the build
    // or opening the workspace first, and so that a second instance started by mistake on the
    // same port never touches the database. The port handed in always equals config.port: only
    // tests ask for port 0.
    app: ({ port }) => {
      // Node accepts no connection before the app exists, so nothing answers on the port until
      // the workspace has turned out to be the right one. A refusal ends the start.
      workspace = openWorkspace(location, options.env);
      return createApp({
        ...config,
        port,
        workspace: { name: workspace.config.name, endpoint: workspace.endpoint.href },
      });
    },
  }).catch((error: unknown) => {
    // The app could not be built although the workspace was open: closed here, the database is
    // left as one file.
    workspace?.close();
    if (error instanceof PortInUseError) fail(busyPortMessage(config.port, "HUBBER_PORT"), EXIT_FAILURE);
    if (error instanceof WorkspaceError) fail(error.message, error.exitCode);
    throw error;
  });
  // Set by the app function, which has run by now: startServer() resolves only after it returned.
  const opened = workspace as unknown as OpenWorkspace;

  // Created only now, after every check of the pin. Creating it reads nothing; status() below
  // reads the environment and the credentials file, and never runs the helper command.
  const credentials = createCredentialProvider(
    { endpoint: opened.endpoint, scheme: opened.config.profile.auth },
    { env: options.env, uid: process.getuid?.() ?? -1, forbiddenRoots: [REPOSITORY_ROOT, opened.paths.dir] },
  );

  const shutdown = createShutdown({
    // In this order: once the last request has been answered, a helper command that is still
    // running is ended and the database is closed. A clean close folds hubber.sqlite-wal back
    // into hubber.sqlite, which is what makes a copy of the directory a backup.
    close: async () => {
      await server.close();
      credentials.close();
      opened.close();
    },
    exit: (code) => process.exit(code),
    log: (line) => console.log(line),
    deadlineMs: SHUTDOWN_DEADLINE_MS,
  });
  // Registered before the address is printed: whoever waits for that line may signal at once.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, shutdown);

  const address = `http://${server.hostname}:${server.port}`;
  console.log(
    config.devOrigins === undefined
      ? `Hubber działa pod adresem ${address} (Ctrl-C kończy pracę).`
      : `API nasłuchuje pod adresem ${address}.`,
  );
  // After the address, which stays the first line: the tests and the development runner take the
  // first address they read for the server's own, and an endpoint is an address too.
  console.log(`Workspace „${opened.config.name}”: katalog "${opened.paths.dir}", endpoint ${opened.endpoint.href}.`);
  for (const warning of opened.warnings) console.error(warning);

  // A server without a credential starts all the same: the owner learns of the missing piece
  // now, and not at the first call of the model.
  const status = credentials.status();
  if (status.available) console.log(describeCredentialStatus(status));
  else {
    console.error(status.message);
    console.error("Serwer działa dalej, ale wywołania modelu będą kończyć się błędem, dopóki tego nie poprawisz.");
  }
}
