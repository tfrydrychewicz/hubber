import type { ChildProcess } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnNode } from "../src/server/testing.ts";

// The real path: the compiler may print either spelling of a directory reached through a link.
const REPO_ROOT = realpathSync(join(import.meta.dirname, ".."));
const TYPESCRIPT_FILE = /\.[cm]?tsx?$/;
// Directories at the root that hold no sources: the build output, and what git ignores besides
// it. That is workspace data, which can include dropped source files, and the output of the
// diagnostics and of the end-to-end runs. tsconfig.node.json and vitest.config.ts leave them
// out by the same names.
const NOT_SOURCES = ["dist", "workspaces", "diagnostics", "test-results", "playwright-report"].map((name) =>
  join(REPO_ROOT, name),
);

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

async function tsc(...args: string[]): Promise<string> {
  const compiler = spawnNode("node_modules/typescript/bin/tsc", { args });
  children.push(compiler.child);
  const { code } = await compiler.exited;
  if (code !== 0)
    throw new Error(`tsc ${args.join(" ")} ended with code ${code}.\n${compiler.stdout()}${compiler.stderr()}`);
  return compiler.stdout();
}

/**
 * The TypeScript files of the repository, as paths from its root. Left out is what no project
 * is meant to check: installed packages, the directories that hold no sources, and files and
 * directories whose name starts with a dot.
 */
function filesOnDisk(directory = REPO_ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.name.startsWith(".") || entry.name === "node_modules" || NOT_SOURCES.includes(path)) return [];
    if (entry.isDirectory()) return filesOnDisk(path);
    return TYPESCRIPT_FILE.test(entry.name) ? [relative(REPO_ROOT, path)] : [];
  });
}

// "npm run typecheck" builds the projects that tsconfig.json refers to, and nothing else. A file
// outside all of them passes it unchecked, and so does every file of a project that has dropped
// out of the references.
describe("npm run typecheck", () => {
  it("checks every TypeScript file of the repository", async () => {
    // Read by the compiler, because these files may hold comments, which JSON.parse() refuses.
    const { references = [] } = JSON.parse(await tsc("-p", "tsconfig.json", "--showConfig")) as {
      references?: { path: string }[];
    };
    const listings = await Promise.all(references.map(({ path }) => tsc("-p", path, "--listFilesOnly")));
    const checked = new Set(
      listings
        .flatMap((listing) => listing.split("\n"))
        .filter((file) => file !== "" && !file.includes("/node_modules/"))
        .map((file) => relative(REPO_ROOT, realpathSync(file))),
    );

    const unchecked = filesOnDisk().filter((file) => !checked.has(file));

    expect(unchecked, "files that no project referenced from tsconfig.json type-checks").toEqual([]);
  });
});
