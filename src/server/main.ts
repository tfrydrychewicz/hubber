// Entry point of the server process. All it adds to runServer() is the place of the built web
// app: the directory "vite build" writes to (build.outDir in vite.config.ts). A test calls
// runServer() itself and names a directory of its own.
import { join } from "node:path";
import { runServer } from "./run-server.ts";

await runServer({ env: process.env, webRoot: join(import.meta.dirname, "../../dist/web") });
