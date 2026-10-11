import type { Response } from "@playwright/test";
import { expect, forgetProblems, test } from "./fixtures.ts";

// The unit tests pin the header values. Only a browser shows that the built app
// really goes out with them and that the engine acts on them.
const EXPECTED_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
};

test("every response of a page load carries the security headers", async ({ page, pageProblems }) => {
  const responses: Response[] = [];
  page.on("response", (response) => responses.push(response));

  await page.goto("/");
  await expect(page.getByText("Serwer działa")).toBeVisible();
  // One answer that is not a success: a missing hashed asset is a plain 404.
  await page.evaluate(async () => {
    await fetch("/assets/nie-ma.js");
  });

  expect(responses.map((response) => response.request().resourceType())).toEqual(
    expect.arrayContaining(["document", "stylesheet", "script", "fetch"]),
  );
  expect(responses.map((response) => response.status())).toContain(404);
  for (const response of responses) {
    const headers = await response.allHeaders();
    // A missing header counts as an empty one, so that the failure names the response.
    const policy = headers["content-security-policy"] ?? "";
    expect(policy, response.url()).toContain("script-src 'self';");
    // X-Frame-Options alone keeps the app out of a frame, so only the header shows that this directive is sent.
    expect(policy, response.url()).toContain("frame-ancestors 'none'");
    expect(headers, response.url()).toMatchObject(EXPECTED_HEADERS);
  }
  forgetProblems(pageProblems, (problem) => problem.includes("/assets/nie-ma.js"));
});

test("the browser refuses an inline script on the built app", async ({ page, pageProblems }) => {
  await page.goto("/");

  const outcome = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        document.addEventListener("securitypolicyviolation", (event) =>
          resolve(`blocked: ${event.effectiveDirective}`),
        );
        document.addEventListener("inline-script-ran", () => resolve("ran"));
        const script = document.createElement("script");
        script.textContent = "document.dispatchEvent(new Event('inline-script-ran'))";
        document.head.append(script);
      }),
  );

  expect(outcome).toBe("blocked: script-src-elem");
  // The browser reports the script it refused. Whatever else the page reports still fails the
  // test, other violations of the policy included.
  forgetProblems(pageProblems, (problem) => problem.includes("script-src") && problem.includes("unsafe-inline"));
});
