import { expect, forgetProblems, test } from "./fixtures.ts";

test("the empty app starts and reaches the server", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Hubber");
  await expect(page.getByRole("heading", { level: 1, name: "Hubber" })).toBeVisible();
  await expect(page.getByText("Serwer działa")).toBeVisible();
});

test("the page keeps asking the server after the browser has gone offline", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Serwer działa")).toBeVisible();

  // Losing the network leaves 127.0.0.1 reachable, so the "offline" event is all the page
  // notices. Returning to the tab then makes TanStack Query refetch, unless it has paused.
  const refetch = page.waitForResponse("**/api/health", { timeout: 3_000 });
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("visibilitychange"));
  });

  expect((await refetch).status()).toBe(200);
});

test("a failed check says why in the console", async ({ page, pageProblems }) => {
  // Only the status is wrong with this answer, and the label is the same for every failure.
  await page.route("**/api/health", (route) => route.fulfill({ status: 500, json: { status: "ok" } }));
  await page.goto("/");

  await expect(page.getByText("Brak połączenia z serwerem")).toBeVisible();
  await expect
    .poll(() => pageProblems.join("\n"))
    .toContain('Query ["health"] failed: Error: GET /api/health returned 500');
  // The browser reports the failed check as well. Whatever else the page reports still fails the test.
  forgetProblems(pageProblems, (problem) => problem.includes("/api/health"));
});
