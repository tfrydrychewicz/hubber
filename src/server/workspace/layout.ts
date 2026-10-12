// What a workspace is on disk. The whole state of a workspace is inside its directory (NFR-8),
// and nothing in it names a path outside or an absolute path inside, so the directory can be
// copied or moved as a whole. Credentials are never in it (CFG-4).
//
//   <workspace>/            0700
//     workspace.json        0600   name and LLM profile; no secrets
//     hubber.sqlite         0600   SQLite database; while the server runs also -wal and -shm beside it
//     files/                0700   originals of dropped files (M1a-7); empty at creation
//     backups/              0700   copies of the database from before a migration; made with the first copy
import { join } from "node:path";

export const CONFIG_FILE = "workspace.json";
export const DATABASE_FILE = "hubber.sqlite";
export const FILES_DIR = "files";
export const BACKUPS_DIR = "backups";

/** Only the owner: the data is notes about people. Other accounts on the machine get nothing. */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** The checkout this code runs from. Workspaces and credential files must lie outside it. */
export const REPOSITORY_ROOT = join(import.meta.dirname, "../../..");

export interface WorkspacePaths {
  dir: string;
  config: string;
  database: string;
  files: string;
  /** Not there in a workspace whose database has never been migrated. */
  backups: string;
}

export function workspacePaths(dir: string): WorkspacePaths {
  return {
    dir,
    config: join(dir, CONFIG_FILE),
    database: join(dir, DATABASE_FILE),
    files: join(dir, FILES_DIR),
    backups: join(dir, BACKUPS_DIR),
  };
}
