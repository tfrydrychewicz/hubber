// The server process from start to finish: reads the environment, listens on the loopback
// address only, and shuts down on the usual signals.
import { existsSync } from "node:fs";
import { createApp } from "./app.ts";
import { busyPortMessage } from "./busy-port.ts";
import { readServerConfig, type ServerConfig, type ServerConfigDeps, ServerConfigError } from "./config.ts";
import { EXIT_FAILURE } from "./exit-codes.ts";
import { PortInUseError, startServer } from "./listen.ts";
import { createShutdown } from "./shutdown.ts";

const SHUTDOWN_DEADLINE_MS = 3_000;

/** The environment to read, and the directory where the built web app is expected. */
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
  const config = readConfig(options);

  const server = await startServer({
    port: config.port,
    // Built once the port is bound, so that a taken port is reported without reading the build
    // first. The port handed in always equals config.port: only tests ask for port 0.
    app: ({ port }) => createApp({ ...config, port }),
  }).catch((error: unknown) => {
    if (error instanceof PortInUseError) fail(busyPortMessage(config.port, "HUBBER_PORT"), EXIT_FAILURE);
    throw error;
  });

  const shutdown = createShutdown({
    close: server.close,
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
}
