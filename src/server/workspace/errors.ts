import { EXIT_FAILURE } from "../exit-codes.ts";

/**
 * A workspace that cannot be created or opened. The message is written for the user and is
 * printed as it stands; the exit code follows exit-codes.ts.
 */
export class WorkspaceError extends Error {
  override name = "WorkspaceError";
  readonly exitCode: number;

  constructor(message: string, exitCode: number = EXIT_FAILURE) {
    super(message);
    this.exitCode = exitCode;
  }
}

// Every refusal to open a workspace starts with these words, whatever the reason and whatever
// the exit code: a missing directory, a broken configuration, a pin that does not match, a
// setting of the environment that the workspace cannot be opened under. The development runner
// goes by them, the way it goes by the first words of the message about a taken port.
const REFUSAL = "Nie można otworzyć workspace'u";

/**
 * The error for a workspace that is named by the settings but cannot be opened. The reason
 * completes the sentence; the name is given once the configuration file has told it.
 */
export function refusal(reason: string, exitCode: number = EXIT_FAILURE, name?: string): WorkspaceError {
  return new WorkspaceError(`${REFUSAL}${name === undefined ? "" : ` „${name}”`}: ${reason}`, exitCode);
}

/** Recognises a refusal in the output of another process. No saved file makes it go away. */
export function isWorkspaceRefusal(line: string): boolean {
  return line.startsWith(REFUSAL);
}
