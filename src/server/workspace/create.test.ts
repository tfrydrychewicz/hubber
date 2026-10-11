import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LlmProfile, parseWorkspaceConfig, serializeWorkspaceConfig } from "./config.ts";
import { type CreateWorkspaceDeps, createWorkspace } from "./create.ts";
import {
  createWorkspaceDatabase,
  openWorkspaceDatabase,
  readWorkspacePin,
  WorkspaceDatabaseError,
  type WorkspacePin,
} from "./database.ts";
import { WorkspaceError } from "./errors.ts";

const NOW = "2026-10-10T20:15:00.000Z";
const LAYOUT = ["files", "hubber.sqlite", "workspace.json"];

const ROUTER_PROFILE: LlmProfile = {
  kind: "router",
  endpoint: "https://router.corp.example/llm",
  auth: "bearer",
  models: { default: "router-opus", synthesis: "router-sonnet" },
  diagnostics: {
    checkedAt: "2026-10-10T08:56:13.000Z",
    model: "router-opus",
    coreReady: true,
    capabilities: { promptCache: true, effort: false, thinking: true, pdfInput: true },
  },
};

const deps: Partial<CreateWorkspaceDeps> = { now: () => new Date(NOW), token: () => "t0ken" };
const startUmask = process.umask();
const startDir = process.cwd();
let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "hubber-create-"));
});

afterEach(() => {
  process.umask(startUmask);
  process.chdir(startDir);
  rmSync(work, { recursive: true, force: true });
});

const mode = (path: string) => (lstatSync(path).mode & 0o7777).toString(8);

function create(dir: string, extra: Partial<CreateWorkspaceDeps> = {}, profile: LlmProfile = ROUTER_PROFILE) {
  return createWorkspace({ dir, name: "Praca", profile }, { ...deps, ...extra });
}

function failure(run: () => unknown): WorkspaceError {
  try {
    run();
  } catch (error) {
    if (error instanceof WorkspaceError) return error;
    throw error;
  }
  throw new Error("The workspace was created.");
}

/** Everything below a directory with what it is, so that a test can tell whether anything was touched. */
function tree(root: string, prefix = ""): Record<string, string> {
  const found: Record<string, string> = {};
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) found[prefix + name] = `link to ${readlinkSync(path)}`;
    else if (stats.isDirectory())
      Object.assign(found, { [prefix + name]: "directory" }, tree(path, `${prefix}${name}/`));
    else found[prefix + name] = `file: ${readFileSync(path, "utf8")}`;
  }
  return found;
}

function alreadyExists(dir: string): string {
  return `Katalog "${dir}" już istnieje. Polecenie tworzy wyłącznie nowy katalog i niczego nie nadpisuje; wskaż inny opcją --dir.`;
}

describe("createWorkspace", () => {
  it("creates the directory with its three entries, all for the owner alone", () => {
    const dir = join(work, "ws");

    create(dir);

    expect(readdirSync(dir).sort()).toEqual(LAYOUT);
    expect(readdirSync(join(dir, "files"))).toEqual([]);
    expect([
      mode(dir),
      mode(join(dir, "files")),
      mode(join(dir, "hubber.sqlite")),
      mode(join(dir, "workspace.json")),
    ]).toEqual(["700", "700", "600", "600"]);
    // Nothing of the staging directory is left beside it.
    expect(readdirSync(work)).toEqual(["ws"]);
  });

  it("keeps everything private even when the shell would let others read new files", () => {
    process.umask(0);
    const dir = join(work, "nested", "deeper", "ws");

    create(dir);

    expect([
      mode(dir),
      mode(join(dir, "files")),
      mode(join(dir, "hubber.sqlite")),
      mode(join(dir, "workspace.json")),
    ]).toEqual(["700", "700", "600", "600"]);
  });

  it("creates the missing directories on the way, private as well", () => {
    const dir = join(work, "nested", "deeper", "ws");

    create(dir);

    expect(mode(join(work, "nested"))).toBe("700");
    expect(mode(join(work, "nested", "deeper"))).toBe("700");
    expect(readdirSync(join(work, "nested", "deeper"))).toEqual(["ws"]);
  });

  it("creates a workspace at a path with spaces and with letters outside ASCII", () => {
    // The default place has a space in it, and a home directory may be named in Polish.
    const dir = join(work, "Application Support", "Zażółć gęślą jaźń", "ws");

    create(dir);

    expect(readdirSync(dir).sort()).toEqual(LAYOUT);
    const db = openWorkspaceDatabase(join(dir, "hubber.sqlite"), ROUTER_PROFILE.endpoint);
    db.close();
    expect(readdirSync(dir).sort()).toEqual(LAYOUT);
  });

  it("writes the configuration it returns, with the name cleaned and the time of creation", () => {
    const dir = join(work, "ws");

    const config = createWorkspace({ dir, name: "  Praca \n", profile: ROUTER_PROFILE }, deps);

    expect(config).toEqual({ schemaVersion: 1, name: "Praca", createdAt: NOW, profile: ROUTER_PROFILE });
    const text = readFileSync(join(dir, "workspace.json"), "utf8");
    expect(text).toBe(serializeWorkspaceConfig(config));
    expect(parseWorkspaceConfig(text)).toEqual(config);
  });

  it("pins the database to the address of the profile, at the very instant the configuration names", () => {
    const dir = join(work, "ws");

    const config = create(dir);

    const db = openWorkspaceDatabase(join(dir, "hubber.sqlite"), ROUTER_PROFILE.endpoint);
    try {
      expect(readWorkspacePin(db)).toEqual({ endpoint: "https://router.corp.example/llm", createdAt: NOW });
      expect(readWorkspacePin(db).createdAt).toBe(config.createdAt);
    } finally {
      db.close();
    }
  });

  it("takes the time from the clock when it is given none", () => {
    const before = Date.now();

    const config = createWorkspace({ dir: join(work, "ws"), name: "Praca", profile: ROUTER_PROFILE });

    const createdAt = Date.parse(config.createdAt);
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(Date.now());
    expect(config.createdAt).toBe(new Date(createdAt).toISOString());
  });

  it("builds everything in a private directory beside the target, under a name of its own", () => {
    const dir = join(work, "ws");
    const seen: { staging: string; mode: string; target: boolean }[] = [];
    const watching = (file: string, pin: WorkspacePin) => {
      seen.push({ staging: dirname(file), mode: mode(dirname(file)), target: existsSync(dir) });
      createWorkspaceDatabase(file, pin);
    };

    // Without a token of the test's own: the name gets its random part.
    createWorkspace({ dir, name: "Praca", profile: ROUTER_PROFILE }, { createDatabase: watching });

    expect(seen).toHaveLength(1);
    expect(dirname(seen[0]?.staging ?? "")).toBe(work);
    expect(basename(seen[0]?.staging ?? "")).toMatch(/^\.ws\.creating-[0-9a-f]{8}$/);
    expect(seen[0]?.mode).toBe("700");
    // The workspace does not exist under its name before it is whole.
    expect(seen[0]?.target).toBe(false);
    expect(readdirSync(work)).toEqual(["ws"]);
  });

  it.each([
    [
      "a directory with content",
      (dir: string) => {
        mkdirSync(dir);
        writeFileSync(join(dir, "precious.txt"), "data");
      },
    ],
    ["an empty directory", (dir: string) => mkdirSync(dir)],
    ["a file", (dir: string) => writeFileSync(dir, "data")],
    ["a link that leads nowhere", (dir: string) => symlinkSync(join(dirname(dir), "nowhere"), dir)],
    [
      "a link to a directory",
      (dir: string) => {
        mkdirSync(join(dirname(dir), "elsewhere"));
        symlinkSync(join(dirname(dir), "elsewhere"), dir);
      },
    ],
  ])("refuses %s that is already there, and leaves it alone", (_what, occupy) => {
    const dir = join(work, "taken");
    occupy(dir);
    const before = tree(work);

    const error = failure(() => create(dir));

    expect(error.message).toBe(alreadyExists(dir));
    expect(error.exitCode).toBe(1);
    // Neither what was in the way, nor what a link leads to, nor a staging directory beside it.
    expect(tree(work)).toEqual(before);
  });

  it("leaves nothing behind when it fails half-way, the directories it made on the way included", () => {
    const dir = join(work, "atomic", "deeper", "ws");
    const failing = (file: string) => {
      writeFileSync(file, "half a database");
      throw new Error("disk full");
    };

    const error = failure(() => create(dir, { createDatabase: failing }));

    expect(error.message).toBe(`Nie udało się utworzyć workspace'u w katalogu "${dir}": disk full`);
    expect(error.exitCode).toBe(1);
    expect(readdirSync(work)).toEqual([]);
  });

  it("takes away only the directories it made itself when it fails", () => {
    const parent = join(work, "mine");
    mkdirSync(parent);
    writeFileSync(join(parent, "notes.txt"), "data");
    const failing = () => {
      throw new Error("disk full");
    };

    failure(() => create(join(parent, "made", "deeper", "ws"), { createDatabase: failing }));
    expect(tree(work)).toEqual({ mine: "directory", "mine/notes.txt": "file: data" });

    // The same for a directory that was there before and is empty: it was not this call's to remove.
    const empty = join(work, "empty");
    mkdirSync(empty);
    failure(() => create(join(empty, "ws"), { createDatabase: failing }));
    expect(readdirSync(empty)).toEqual([]);
  });

  it("leaves a directory it made on the way once somebody else has put something into it", () => {
    const made = join(work, "made");
    const intruding = () => {
      writeFileSync(join(made, "theirs.txt"), "data");
      throw new Error("disk full");
    };

    failure(() => create(join(made, "deeper", "ws"), { createDatabase: intruding }));

    expect(tree(work)).toEqual({ made: "directory", "made/theirs.txt": "file: data" });
  });

  it("reports a name that is too long for its working name beside the target in the user's words, and leaves nothing", () => {
    // The name itself is one the disk takes; the staging directory beside it has a longer one.
    const dir = join(work, "made", "d".repeat(250));

    const error = failure(() => create(dir));

    expect(error.message).toMatch(/^Nie udało się utworzyć workspace'u w katalogu ".*\/d{250}": ENAMETOOLONG/);
    expect(error.exitCode).toBe(1);
    expect(readdirSync(work)).toEqual([]);
  });

  it("says in the user's words that the disk cannot hold the database", () => {
    const dir = join(work, "ws");
    const refusing = (file: string) => {
      throw new WorkspaceDatabaseError("wal-unavailable", file);
    };

    const error = failure(() => create(dir, { createDatabase: refusing }));

    expect(error.message).toBe(
      `Nie udało się utworzyć workspace'u w katalogu "${dir}": dysk nie obsługuje trybu WAL bazy SQLite. Utwórz workspace na dysku lokalnym`,
    );
    expect(readdirSync(work)).toEqual([]);
  });

  it("refuses a database that was left open, instead of moving its side files into place", () => {
    const dir = join(work, "ws");
    const leaky = (file: string) => {
      writeFileSync(file, "db");
      writeFileSync(`${file}-wal`, "wal");
    };

    const error = failure(() => create(dir, { createDatabase: leaky }));

    expect(error.message).toContain("hubber.sqlite-wal");
    expect(error.exitCode).toBe(1);
    expect(readdirSync(work)).toEqual([]);
  });

  it("makes the database private whatever mode it was created with", () => {
    const dir = join(work, "ws");
    const careless = (file: string, pin: WorkspacePin) => {
      createWorkspaceDatabase(file, pin);
      chmodSync(file, 0o644);
    };

    create(dir, { createDatabase: careless });

    expect(mode(join(dir, "hubber.sqlite"))).toBe("600");
  });

  it("writes the configuration as a new file only, never over one that is there", () => {
    const dir = join(work, "ws");
    const meddling = (file: string, pin: WorkspacePin) => {
      createWorkspaceDatabase(file, pin);
      writeFileSync(join(dirname(file), "workspace.json"), "somebody else's");
    };

    const error = failure(() => create(dir, { createDatabase: meddling }));

    expect(error.message).toMatch(/^Nie udało się utworzyć workspace'u w katalogu ".*\/ws": EEXIST/);
    expect(readdirSync(work)).toEqual([]);
  });

  it("refuses a database that was not created at all", () => {
    const error = failure(() => create(join(work, "ws"), { createDatabase: () => {} }));

    expect(error.message).toMatch(/^Nie udało się utworzyć workspace'u w katalogu ".*\/ws": /);
    expect(readdirSync(work)).toEqual([]);
  });

  /** Makes a directory look as if nothing had touched it for that long. */
  function age(path: string, seconds: number): void {
    const then = new Date(Date.now() - seconds * 1_000);
    utimesSync(path, then, then);
  }

  it("clears what a killed creation of the same target left, and nothing else", () => {
    const parent = join(work, "stale");
    mkdirSync(join(parent, ".ws.creating-dead"), { recursive: true });
    writeFileSync(join(parent, ".ws.creating-dead", "hubber.sqlite"), "half");
    mkdirSync(join(parent, ".ws.creating-0ld"));
    mkdirSync(join(parent, ".other.creating-dead"));
    mkdirSync(join(parent, "ws.creating-visible"));
    mkdirSync(join(parent, "neighbour"));
    for (const name of readdirSync(parent)) age(join(parent, name), 3_600);

    create(join(parent, "ws"));

    expect(readdirSync(parent).sort()).toEqual([".other.creating-dead", "neighbour", "ws", "ws.creating-visible"]);
    expect(readdirSync(join(parent, "ws")).sort()).toEqual(LAYOUT);
  });

  it("leaves alone a staging directory of the same target that was touched a moment ago", () => {
    // It may be the work of a creation that is under way beside this one. Only time tells the
    // two apart: what a killed creation left does not change any more.
    const parent = join(work, "busy");
    mkdirSync(join(parent, ".ws.creating-fresh"), { recursive: true });
    writeFileSync(join(parent, ".ws.creating-fresh", "hubber.sqlite"), "half");
    mkdirSync(join(parent, ".ws.creating-recent"));
    age(join(parent, ".ws.creating-recent"), 30);
    mkdirSync(join(parent, ".ws.creating-dead"));
    age(join(parent, ".ws.creating-dead"), 90);

    create(join(parent, "ws"));

    expect(readdirSync(parent).sort()).toEqual([".ws.creating-fresh", ".ws.creating-recent", "ws"]);
    expect(readFileSync(join(parent, ".ws.creating-fresh", "hubber.sqlite"), "utf8")).toBe("half");
  });

  it("clears nothing for a target that it then refuses", () => {
    const parent = join(work, "stale");
    mkdirSync(join(parent, ".ws.creating-dead"), { recursive: true });
    age(join(parent, ".ws.creating-dead"), 3_600);
    mkdirSync(join(parent, "ws"));

    failure(() => create(join(parent, "ws")));

    expect(readdirSync(parent).sort()).toEqual([".ws.creating-dead", "ws"]);
  });

  it("loses cleanly to a creation of the same target that runs beside it, and harms nothing of it", () => {
    const parent = join(work, "twice");
    const dir = join(parent, "ws");
    // While the first creation is half-way, a second one of the same target runs from start to end.
    let second: ReturnType<typeof create> | undefined;
    const interleaved = (file: string, pin: WorkspacePin) => {
      createWorkspaceDatabase(file, pin);
      second = createWorkspace({ dir, name: "Druga", profile: ROUTER_PROFILE }, { token: () => "0ther" });
    };

    const error = failure(() => create(dir, { createDatabase: interleaved }));

    // The second one was not disturbed by the first, and the first one found the place taken.
    expect(second?.name).toBe("Druga");
    expect(error.message).toBe(alreadyExists(dir));
    expect(readdirSync(parent)).toEqual(["ws"]);
    expect(readdirSync(dir).sort()).toEqual(LAYOUT);
    expect(parseWorkspaceConfig(readFileSync(join(dir, "workspace.json"), "utf8")).name).toBe("Druga");
    openWorkspaceDatabase(join(dir, "hubber.sqlite"), ROUTER_PROFILE.endpoint).close();
  });

  it.each([
    [
      "a directory with content",
      (dir: string) => {
        mkdirSync(dir);
        writeFileSync(join(dir, "precious.txt"), "data");
      },
    ],
    ["a file", (dir: string) => writeFileSync(dir, "data")],
  ])("loses to %s that appears before the rename, and reports it as existing", (_what, appear) => {
    const parent = join(work, "race");
    const dir = join(parent, "ws");
    const racing = (file: string, pin: WorkspacePin) => {
      createWorkspaceDatabase(file, pin);
      appear(dir);
    };

    const error = failure(() => create(dir, { createDatabase: racing }));

    expect(error.message).toBe(alreadyExists(dir));
    // What appeared is untouched, and the staging directory is gone.
    expect(readdirSync(parent)).toEqual(["ws"]);
    if (lstatSync(dir).isDirectory()) expect(readdirSync(dir)).toEqual(["precious.txt"]);
    else expect(readFileSync(dir, "utf8")).toBe("data");
  });

  it("reports in its own words what the system says when the place cannot be used", () => {
    const blocker = join(work, "a-file");
    writeFileSync(blocker, "data");
    const dir = join(blocker, "ws");

    const error = failure(() => create(dir));

    expect(error.message).toMatch(new RegExp(`^Nie udało się utworzyć workspace'u w katalogu "${dir}": ENOTDIR`));
    expect(error.exitCode).toBe(1);
    expect(readFileSync(blocker, "utf8")).toBe("data");
  });

  it("refuses a relative directory as a mistake of the caller", () => {
    // Were it accepted, it would land in the working directory: the repository, for "npm test".
    // So the test moves to a directory of its own first.
    process.chdir(work);

    expect(() => create("workspaces/dev")).toThrow(TypeError);
    expect(() => create("workspaces/dev")).toThrow(
      "The workspace directory has to be an absolute path: workspaces/dev",
    );
    expect(readdirSync(work)).toEqual([]);
  });

  it.each<[string, Partial<LlmProfile>, string]>([
    [
      "an address in another spelling",
      { endpoint: "https://Router.Corp.Example/llm/" },
      "adres nie jest w postaci kanonicznej",
    ],
    ["an address that cannot be pinned", { endpoint: "http://router.corp.example" }, "nieszyfrowanego http://"],
    [
      "a kind that does not fit the address",
      { kind: "anthropic", auth: "x-api-key" },
      'profil "anthropic" ma stały adres',
    ],
    [
      "a way of authenticating that does not fit the kind",
      { kind: "anthropic", endpoint: "https://api.anthropic.com" },
      "uwierzytelnia się wyłącznie kluczem",
    ],
    ["a model identifier with a space", { models: { default: "claude opus" } }, "identyfikator modelu zawiera odstęp"],
    [
      "diagnostics that the reader would refuse",
      { diagnostics: { ...(ROUTER_PROFILE.diagnostics as object), checkedAt: "rano" } as LlmProfile["diagnostics"] },
      "profile.diagnostics.checkedAt: oczekiwano daty",
    ],
  ])("refuses %s before it touches the disk: such a workspace would not open", (_what, change, problem) => {
    const dir = join(work, "parent", "ws");

    const attempt = () => create(dir, {}, { ...ROUTER_PROFILE, ...change });

    expect(attempt).toThrow(TypeError);
    expect(attempt).toThrow("Not a workspace that can be created: ");
    expect(attempt).toThrow(problem);
    expect(readdirSync(work)).toEqual([]);
  });

  it("refuses a blank name before it touches the disk", () => {
    expect(() => createWorkspace({ dir: join(work, "ws"), name: "  ", profile: ROUTER_PROFILE }, deps)).toThrow(
      "Not a workspace that can be created: name: nazwa jest pusta",
    );
    expect(readdirSync(work)).toEqual([]);
  });
});
