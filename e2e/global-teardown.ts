// Runs once, when the last test of a run is over and the server of the run is still up: the
// moment at which the observer in that server has seen every request the browsers made.
// Playwright calls it whatever was selected to run, and a failure here fails the run.
import type { FullConfig } from "@playwright/test";
import { egressLogBeside, egressProblems, readEgressLog } from "./egress.ts";

export default function checkEgress(config: FullConfig): void {
  // From the settings the server was started with, so that this is the log of that very server.
  const { HUBBER_WORKSPACE: workspace, HUBBER_PORT: port } = config.webServer?.env ?? {};
  if (workspace === undefined || port === undefined) {
    throw new Error("The configuration names no workspace and port for the server, so its egress log cannot be found.");
  }
  const logFile = egressLogBeside(workspace);

  const problems = egressProblems(readEgressLog(logFile), Number(port));

  if (problems.length > 0) throw new Error(`${problems.join("\n")}\nThe whole log: ${logFile}`);
}
