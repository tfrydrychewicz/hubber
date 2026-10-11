import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

// Deliberately not derived from vite.config.ts: that file sets root to src/web,
// and merging it in here would hide the tests in scripts/ and src/server.
export default defineConfig({
  test: {
    // Root options are inherited by both projects. Playwright owns e2e/, dist/ is build output, and
    // dot-directories hold tool state, which can be a whole second checkout of this repository.
    // The last four hold what git ignores: workspace data, which can include dropped source files,
    // and the output of the diagnostics and of the end-to-end runs.
    exclude: [
      ...configDefaults.exclude,
      "e2e/**",
      "dist/**",
      "**/.*/**",
      "workspaces/**",
      "diagnostics/**",
      "test-results/**",
      "playwright-report/**",
    ],
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          // Every test outside the web app, so that a new directory is covered without being listed.
          // tsconfig.node.json selects the files it type-checks the same way.
          include: ["**/*.test.ts"],
          // Added to the root list, not a replacement for it.
          exclude: ["src/web/**"],
        },
      },
      {
        plugins: [react()],
        test: {
          name: "web",
          environment: "jsdom",
          include: ["src/web/**/*.test.{ts,tsx}"],
          setupFiles: ["src/web/test/setup.ts"],
          // Component tests stub fetch; this removes the stub before the next test.
          unstubGlobals: true,
        },
      },
    ],
  },
});
