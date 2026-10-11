import { test as base, expect } from "@playwright/test";

export const test = base.extend<{ pageProblems: string[] }>({
  // Automatic, so it runs for every test that takes `test` from this file, and the linter refuses
  // a spec file that imports it from Playwright instead. A console error or a failed request
  // fails the test even when all of its own assertions pass. A test that provokes a problem on
  // purpose takes it off the list with forgetProblems().
  pageProblems: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on("console", (message) => {
        // The text of a failed resource load does not name the resource; the location does.
        if (message.type() === "error") problems.push(`console.error: ${message.text()} (${message.location().url})`);
      });
      page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
      page.on("requestfailed", (request) => {
        problems.push(`request failed: ${request.method()} ${request.url()} (${request.failure()?.errorText})`);
      });
      page.on("response", (response) => {
        if (response.status() >= 400) {
          problems.push(`HTTP ${response.status()}: ${response.request().method()} ${response.url()}`);
        }
      });
      await use(problems);
      expect(problems, "problems reported by the page").toEqual([]);
    },
    { auto: true },
  ],
});

/**
 * For a test that provokes problems on purpose: takes them off the list, so that only what the
 * test did not ask for fails it. Without a filter everything counts as provoked, which suits a
 * page that is not the app's own: all it can report is the refusal under test.
 */
export function forgetProblems(problems: string[], provoked: (problem: string) => boolean = () => true): void {
  const kept = problems.filter((problem) => !provoked(problem));
  expect(problems.length - kept.length, "problems the test provoked").toBeGreaterThan(0);
  problems.splice(0, problems.length, ...kept);
}

export { expect };
