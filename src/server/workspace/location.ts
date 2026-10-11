// Which directory is the workspace. Decided from the environment alone, without touching the
// disk: the server, the development runner and the create command all ask here, and a test
// hands in whatever environment it likes.
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

export const WORKSPACE_VARIABLE = "HUBBER_WORKSPACE";

export interface WorkspaceLocation {
  /** Absolute and normalised. */
  dir: string;
  /** What named it: the variable, or the default place under the home directory. */
  source: "variable" | "default";
}

/** A setting that cannot be used as given. Reported as a usage error (exit code 2). */
export class WorkspaceLocationError extends Error {
  override name = "WorkspaceLocationError";
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * What a coding agent puts into the environment of every command it runs. Read off the shell of
 * Claude Code, which sets all three; AI_AGENT is the one among them that is not a name of its own.
 */
const AGENT_SESSION_VARIABLES = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "AI_AGENT"] as const;

/** The variable by which the environment shows the session of a coding agent. Any value counts but an empty one. */
function agentSessionVariable(env: Env): string | undefined {
  return AGENT_SESSION_VARIABLES.find((name) => env[name] !== undefined && env[name] !== "");
}

/**
 * The home directory as the environment gives it, and only so. os.homedir() would fall back
 * to the account database when HOME is not set, and a process that a test started with an
 * environment of its own would then find the developer's real workspace.
 */
function homeOf(env: Env): string | undefined {
  const home = env.HOME;
  return home !== undefined && isAbsolute(home) ? home : undefined;
}

/** A path that starts with "~" as a path under the home directory, any other as it is. Undefined without a home. */
export function expandHome(path: string, env: Env): string | undefined {
  if (path !== "~" && !path.startsWith("~/")) return path;
  const home = homeOf(env);
  return home === undefined ? undefined : join(home, path.slice(1));
}

/** Where the one workspace of this machine lives unless the variable says otherwise. */
export function defaultWorkspaceDir(home: string): string {
  return join(home, "Library", "Application Support", "Hubber", "workspaces", "default");
}

/**
 * A directory given by the user, as an absolute path. "~/" is expanded here because a value
 * in quotes reaches the process unexpanded. A relative path is refused: npm runs every script
 * in the root of the repository, so "data/praca" would land inside the repository, wherever
 * the user was standing.
 */
export function resolveWorkspaceDir(raw: string, setting: string, env: Env): string {
  const path = expandHome(raw, env);
  if (path === undefined) {
    throw new WorkspaceLocationError(
      `Niepoprawna wartość ${setting}: "${raw}". Znak "~" wymaga zmiennej HOME; podaj pełną ścieżkę.`,
    );
  }
  if (!isAbsolute(path)) {
    throw new WorkspaceLocationError(
      `Niepoprawna wartość ${setting}: "${raw}". Podaj pełną ścieżkę katalogu workspace'u (od "/" albo "~/").`,
    );
  }
  // Drops a trailing slash and ".." segments, so that the same directory is always spelled the same.
  return resolve(path);
}

export function locateWorkspace(env: Env): WorkspaceLocation {
  const raw = env[WORKSPACE_VARIABLE];
  // Empty counts as not set, as it does for HUBBER_PORT and HUBBER_DEV_ORIGIN.
  if (raw !== undefined && raw !== "") {
    return { dir: resolveWorkspaceDir(raw, WORKSPACE_VARIABLE, env), source: "variable" };
  }
  // An agent works in the owner's account, with the owner's HOME, and its shell keeps no variable
  // from one command to the next: a start that was meant for a throwaway workspace arrives here
  // without one, and the default place is the owner's own data. Such a session gets no default.
  // A workspace that it names is opened like anyone's.
  const agent = agentSessionVariable(env);
  if (agent !== undefined) {
    throw new WorkspaceLocationError(
      `Nie wskazano workspace'u. Ustaw zmienną ${WORKSPACE_VARIABLE} na katalog workspace'u; w sesji agenta (zmienna ${agent}) nie ma katalogu domyślnego.`,
    );
  }
  const home = homeOf(env);
  if (home === undefined) {
    throw new WorkspaceLocationError(
      `Nie wskazano workspace'u. Ustaw zmienną ${WORKSPACE_VARIABLE} na katalog workspace'u; bez zmiennej HOME nie ma katalogu domyślnego.`,
    );
  }
  return { dir: defaultWorkspaceDir(home), source: "default" };
}

/**
 * The workspace of the end-to-end run that uses this port: one per port, like the run's output
 * directory, and always directly in the temporary directory. Here, and not with the other test
 * helpers, because playwright.config.ts reads it in every worker and must not load the database
 * library on the way.
 */
export function e2eWorkspaceDir(port: number): string {
  return join(tmpdir(), `hubber-e2e-${port}`);
}

/**
 * True for a directory the end-to-end run may delete: a "hubber-e2e-<port>" directly in the
 * temporary directory, in the one spelling that e2eWorkspaceDir() gives. Any other spelling of
 * the same place is refused. With a slash at its end, a path that is a link names the directory
 * behind the link, and deleting it would empty that directory instead of removing the link.
 */
export function isE2eWorkspaceDir(dir: string): boolean {
  const name = basename(dir);
  return /^hubber-e2e-\d+$/.test(name) && dir === join(tmpdir(), name);
}
