import type { Locator, Page, Route } from "@playwright/test";
import { TEST_WORKSPACE } from "../src/server/testing.ts";
import { expect, forgetProblems, test } from "./fixtures.ts";

// What the page may show of the workspace the run was started with: its name and, of the address
// it is pinned to, the origin.
const STARTED_WITH = { name: TEST_WORKSPACE.name, endpointOrigin: new URL(TEST_WORKSPACE.endpoint).origin };
const DEV = { name: "Dev", endpointOrigin: "https://api.anthropic.com" };
// Neither has a space or a hyphen, where a browser would break the line by itself.
const LONG = {
  name: "Workspace".repeat(6),
  endpointOrigin: `https://${"bardzodluganazwahosta".repeat(3)}.corp.example`,
};
const CANNOT_READ = "Nie udało się odczytać workspace'u";
// One width in each range that the style sheet can tell apart: its breakpoints are at 640, 768,
// 1024, 1280 and 1536 px. A rule that hides or squeezes the indicator in one of the ranges only
// shows at no other width.
const WINDOW_WIDTHS = [320, 700, 900, 1100, 1400, 1700];

function indicatorOf(page: Page): Locator {
  return page.getByRole("status", { name: "Aktywny workspace" });
}

// What a tab does when its owner comes back to it. TanStack Query takes this for the moment to
// ask the server again.
async function returnToTheTab(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
}

/**
 * Looks at each text the way its reader would, and says what keeps it from being read: nothing,
 * when every line of it stands inside the window and inside its own box, with nothing in front
 * of it, in letters of a readable size and in a colour that stands out from what is behind it.
 *
 * jsdom lays nothing out and applies no style sheet, so only a browser can tell. Being in the
 * accessibility tree with the right text is not enough: a text can be all that and still be
 * clipped to a pixel, cut off with an ellipsis, transparent, blurred or covered.
 */
function whatHides(texts: Locator): Promise<string[]> {
  // The function below runs in the page, so it can use nothing that is declared outside it.
  return texts.evaluateAll((elements) => {
    if (elements.length === 0) return ["There is no text to look at."];
    const found: string[] = [];

    // One pixel on which colours are laid over each other the way the page lays them. It is read
    // back as red, green and blue, whatever notation the style sheet uses, and weighed as the Web
    // Content Accessibility Guidelines weigh a colour.
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return ["This browser has no canvas to compare colours on."];
    const luminance = (colors: string[]): number => {
      for (const color of ["white", ...colors]) {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
      }
      const [red = 0, green = 0, blue = 0] = [...context.getImageData(0, 0, 1, 1).data].map((channel) => {
        const share = channel / 255;
        return share <= 0.04045 ? share / 12.92 : ((share + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };

    // Asking what is at a point finds what a click there would reach, and a layer that lets
    // clicks through covers a text all the same. For the time of the look nothing lets them through.
    const nothingLetsClicksThrough = new CSSStyleSheet();
    nothingLetsClicksThrough.replaceSync("*, *::before, *::after { pointer-events: auto !important; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, nothingLetsClicksThrough];

    for (const element of elements) {
      const text = `"${(element.textContent ?? "").slice(0, 30)}"`;
      const range = document.createRange();
      range.selectNodeContents(element);
      const lines = [...range.getClientRects()].filter((line) => line.width > 0 && line.height > 0);
      if (lines.length === 0) found.push(`${text} takes no room on the page`);
      const box = element.getBoundingClientRect();
      for (const line of lines) {
        if (line.left < 0 || line.top < 0 || line.right > window.innerWidth || line.bottom > window.innerHeight) {
          found.push(`${text} has a line outside the window`);
        }
        // A text that is cut off with an ellipsis keeps its full length, which its box does not have.
        if (line.left < box.left - 1 || line.right > box.right + 1) found.push(`${text} is wider than its box`);
        // Measured on the page, so that letters which are scaled down count as small too.
        if (line.height < 12) found.push(`${text} is set in letters ${line.height.toFixed(1)} px high`);
        // The middle of the line and both of its ends: what is cut off or covered is not found there.
        const middle = (line.top + line.bottom) / 2;
        for (const x of [line.left + 1, (line.left + line.right) / 2, line.right - 1]) {
          const hit = document.elementFromPoint(x, middle);
          if (!hit || !element.contains(hit)) {
            found.push(`${text} is cut off or covered at ${Math.round(x)},${Math.round(middle)}`);
          }
        }
      }

      // What the element and everything around it do to the way it is drawn.
      let opacity = 1;
      const behind: string[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        opacity *= Number(style.opacity);
        behind.unshift(style.backgroundColor);
        const effects = [style.filter, style.maskImage, style.mixBlendMode].filter(
          (effect) => effect !== "" && effect !== "none" && effect !== "normal",
        );
        if (effects.length > 0) found.push(`${text} is drawn through ${effects.join(", ")}`);
      }
      if (opacity < 0.99) found.push(`${text} is seen through: its opacity is ${opacity}`);
      // The colour the letters are filled with, which a style can set apart from "color". The
      // least contrast that the guidelines accept for text of this size is 4.5.
      const style = getComputedStyle(element);
      const background = luminance(behind);
      const letters = luminance([...behind, style.webkitTextFillColor || style.color]);
      const contrast = (Math.max(background, letters) + 0.05) / (Math.min(background, letters) + 0.05);
      if (contrast < 4.5) found.push(`${text} blends into what is behind it: the contrast is ${contrast.toFixed(1)}`);
    }

    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== nothingLetsClicksThrough);
    return found;
  });
}

test("the page names the workspace and the endpoint the app was started with", async ({ page }) => {
  const answered = page.waitForResponse("**/api/workspace");
  await page.goto("/");

  const indicator = indicatorOf(page);
  await expect(indicator.getByRole("term")).toHaveText(["Workspace", "Endpoint"]);
  await expect(indicator.getByRole("definition")).toHaveText([STARTED_WITH.name, STARTED_WITH.endpointOrigin]);
  expect(await whatHides(indicator.locator("dt, dd"))).toEqual([]);

  // The unit tests build the app around a literal. Only here does the answer come from a
  // workspace that the app has opened from disk, and that workspace's address has a path:
  // without one, the origin would be all there is to pass on.
  expect(TEST_WORKSPACE.endpoint).not.toBe(STARTED_WITH.endpointOrigin);
  const response = await answered;
  expect(await response.json()).toEqual(STARTED_WITH);
  expect(response.headers()["cache-control"]).toBe("no-store");
});

// What the tab sees when the server is stopped and started again with another workspace on the
// same port: the address answers as before, with another name. The next two tests tell the two
// ways apart in which the page learns of it.
test("a tab that its owner returns to asks the server at once", async ({ page }) => {
  await page.goto("/");
  const indicator = indicatorOf(page);
  await expect(indicator.getByRole("definition")).toHaveText([STARTED_WITH.name, STARTED_WITH.endpointOrigin]);

  await page.route("**/api/workspace", (route) => route.fulfill({ json: DEV }));
  await returnToTheTab(page);

  // Less time than lies between two checks: only the return to the tab can have asked.
  await expect(indicator.getByRole("definition")).toHaveText([DEV.name, DEV.endpointOrigin], { timeout: 3_000 });
  await expect(indicator).not.toContainText(STARTED_WITH.name);
});

test("a tab that stays in view asks the server again every few seconds", async ({ page }) => {
  // The page's clock runs as usual until the test moves it.
  await page.clock.install();
  await page.goto("/");
  const indicator = indicatorOf(page);
  await expect(indicator.getByRole("definition")).toHaveText([STARTED_WITH.name, STARTED_WITH.endpointOrigin]);

  let asked = 0;
  await page.route("**/api/workspace", (route) => {
    asked += 1;
    return route.fulfill({ json: DEV });
  });
  // Nobody returns to the tab here. Time passes, as much as lies between two checks and no more.
  expect(asked).toBe(0);
  await page.clock.fastForward(5_000);

  await expect(indicator.getByRole("definition")).toHaveText([DEV.name, DEV.endpointOrigin], { timeout: 2_000 });
  expect(asked).toBe(1);
});

test("the page stops naming a workspace that it can no longer confirm", async ({ page, pageProblems }) => {
  await page.goto("/");
  const indicator = indicatorOf(page);
  await expect(indicator.getByRole("definition")).toHaveText([STARTED_WITH.name, STARTED_WITH.endpointOrigin]);

  // What happens to the page's requests from here on. "stopped": nothing answers on the port.
  // "silent": something accepts the connection and says nothing. "back": the server answers.
  let server: "stopped" | "silent" | "back" = "stopped";
  const unanswered: Route[] = [];
  await page.route("**/api/*", async (route) => {
    if (server === "back") await route.continue();
    else if (server === "silent" && route.request().url().endsWith("/api/workspace")) unanswered.push(route);
    else await route.abort("connectionrefused");
  });
  await returnToTheTab(page);
  // Given longer than the time between two checks, like every change below that follows a return to the tab.
  await expect(indicator).toHaveText(CANNOT_READ, { timeout: 10_000 });
  // The indicator does not leave with the server. It is still on screen, and so is what it says.
  await expect(page.getByText("Brak połączenia z serwerem")).toBeVisible();
  expect(await whatHides(indicator.getByText(CANNOT_READ))).toEqual([]);

  // The next check starts and does not end. Until it does, the failed one is the last word: the
  // page still has the answer of the first check, and must not show it again.
  server = "silent";
  const said = await indicator.evaluate(
    (element) =>
      // Everything the indicator says in the second after its owner returns to the tab, change by change.
      new Promise<string[]>((done) => {
        const texts = [element.textContent ?? ""];
        const observer = new MutationObserver(() => texts.push(element.textContent ?? ""));
        observer.observe(element, { childList: true, subtree: true, characterData: true });
        window.dispatchEvent(new Event("visibilitychange"));
        setTimeout(() => {
          observer.disconnect();
          done(texts);
        }, 1_000);
      }),
  );
  expect(said).toEqual([CANNOT_READ]);
  // The check did start, and the page gives one three seconds: it was under way all that second.
  expect(unanswered).toHaveLength(1);
  await unanswered[0]?.abort("connectionrefused");

  server = "back";
  await returnToTheTab(page);
  await expect(indicator.getByRole("definition")).toHaveText([STARTED_WITH.name, STARTED_WITH.endpointOrigin], {
    timeout: 10_000,
  });
  await expect(page.getByText("Serwer działa")).toBeVisible({ timeout: 10_000 });

  // What the browser and the page report of the connections that failed on purpose: the request
  // and the resource by their address, the failed query by its name, because the error of a
  // connection that failed names no address. An answer with an error status was not asked for.
  forgetProblems(
    pageProblems,
    (problem) =>
      !problem.startsWith("HTTP ") &&
      (problem.includes("/api/") || /Query \["(workspace|health)"\] failed: TypeError/.test(problem)),
  );
});

test("a long name and a long address are on screen, whole, in a window of any width", async ({ page }) => {
  await page.route("**/api/workspace", (route) => route.fulfill({ json: LONG }));
  await page.goto("/");
  const indicator = indicatorOf(page);

  for (const width of WINDOW_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });

    await expect(indicator.getByRole("term"), `${width} px`).toHaveText(["Workspace", "Endpoint"]);
    await expect(indicator.getByRole("definition"), `${width} px`).toHaveText([LONG.name, LONG.endpointOrigin]);
    expect(await whatHides(indicator.locator("dt, dd")), `${width} px`).toEqual([]);
    // They wrap inside the card instead of widening it, and the page does not scroll sideways.
    const card = page.locator("section");
    expect(await card.evaluate((element) => element.scrollWidth - element.clientWidth), `${width} px`).toBe(0);
    expect((await card.boundingBox())?.width, `${width} px`).toBeLessThanOrEqual(384);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      `${width} px`,
    ).toBe(0);
  }
});

test("a host that browsers do not spell alike is shown as the server wrote it", async ({ page }) => {
  // No real host has an asterisk, but an address with one can be pinned, and this is what the
  // server then answers. Chromium's URL parser writes the asterisk as "%2A"; a page that checked
  // the answer against its own parser would refuse it there and show an error for good.
  const starred = { name: "Gwiazdka", endpointOrigin: "https://ex*ample.example" };
  await page.route("**/api/workspace", (route) => route.fulfill({ json: starred }));
  await page.goto("/");

  await expect(indicatorOf(page).getByRole("definition")).toHaveText([starred.name, starred.endpointOrigin]);
});
