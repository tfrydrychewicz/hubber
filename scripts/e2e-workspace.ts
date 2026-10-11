// Gives the end-to-end run a workspace of its own, new for every run, and an empty log for the
// egress observer that its server runs under. The web server command in playwright.config.ts
// runs it before "npm start", with the same environment.
//
// It has to be a step of that command: Playwright starts the web server before it runs a global
// setup file, and it loads its configuration again in every worker, so neither of those is a
// place for creating a directory.
import { rmSync } from "node:fs";
import { egressLogBeside } from "../e2e/egress.ts";
import { EXIT_FAILURE, EXIT_USAGE } from "../src/server/exit-codes.ts";
import { WorkspaceError } from "../src/server/workspace/errors.ts";
import { e2eWorkspaceDir, isE2eWorkspaceDir, WORKSPACE_VARIABLE } from "../src/server/workspace/location.ts";
import { createTestWorkspaceAt } from "../src/server/workspace/testing.ts";

const dir = process.env[WORKSPACE_VARIABLE] ?? "";
// This script deletes what it finds at the place, so it takes nothing but a directory of its own
// kind: a HUBBER_WORKSPACE left over from the developer's shell must never get this far.
if (!isE2eWorkspaceDir(dir)) {
  const ownKind = e2eWorkspaceDir(0).replace(/0$/, "<port>");
  console.error(
    `Niepoprawna wartość ${WORKSPACE_VARIABLE}: "${dir}". Testy end-to-end używają katalogu ${ownKind}, który ustawia playwright.config.ts.`,
  );
  process.exit(EXIT_USAGE);
}

// As the server and the create command do: what is created here is for the owner alone.
process.umask(0o077);
try {
  // The workspace of the last run on this port goes first, with whatever a killed server left in
  // it. A new one cannot be created over it: creating never touches a path that exists.
  rmSync(dir, { recursive: true, force: true });
  // So does the log of the last run's observer. The observer adds to the file it is given, and
  // what is read after this run must be this run's alone.
  rmSync(egressLogBeside(dir), { force: true });
  createTestWorkspaceAt(dir);
} catch (error) {
  if (!(error instanceof WorkspaceError)) throw error;
  console.error(error.message);
  process.exit(EXIT_FAILURE);
}
