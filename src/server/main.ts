// Entry point of the server process. It adds two things to runServer(): the environment, and
// the place of the built web app, which is the directory "vite build" writes to (build.outDir in
// vite.config.ts). A test calls runServer() itself and names a directory of its own.
import { join } from "node:path";
import { takeEnvironment } from "./llm/credentials/scrub-env.ts";
import { runServer } from "./run-server.ts";

// Before anything else runs: the application reads this copy, and the live environment loses the
// SDK's variables. From here on no child process inherits a credential, and an SDK client finds
// no address, credential or extra header that the workspace did not give it.
const env = takeEnvironment();
await runServer({ env, webRoot: join(import.meta.dirname, "../../dist/web") });
