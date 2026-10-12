import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPOSITORY_ROOT, workspacePaths } from "./layout.ts";

describe("workspacePaths", () => {
  it("names the three things a workspace directory holds, and the place of the copies made before a migration", () => {
    expect(workspacePaths("/data/praca")).toEqual({
      dir: "/data/praca",
      config: "/data/praca/workspace.json",
      database: "/data/praca/hubber.sqlite",
      files: "/data/praca/files",
      backups: "/data/praca/backups",
    });
  });
});

describe("REPOSITORY_ROOT", () => {
  // Workspaces and credential files are refused inside this directory, so it has to be the checkout itself.
  it("is the directory of this checkout", () => {
    const manifest = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8")) as { name: string };

    expect(manifest.name).toBe("hubber");
    expect(join(REPOSITORY_ROOT, "src/server/workspace")).toBe(import.meta.dirname);
  });
});
