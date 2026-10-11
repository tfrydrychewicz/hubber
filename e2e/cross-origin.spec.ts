import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page, Response } from "@playwright/test";
import { createApp } from "../src/server/app.ts";
import { startServer } from "../src/server/listen.ts";
import { TEST_WORKSPACE } from "../src/server/testing.ts";
import { expect, forgetProblems, test } from "./fixtures.ts";

// Stands in for any other website open in the same browser. Another port on
// 127.0.0.1 is already a different origin, and nothing has to leave the machine.
let otherSite: Server;
let otherOrigin: string;

test.beforeAll(async () => {
  otherSite = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Inna strona</title>");
  });
  await new Promise<void>((resolve) => otherSite.listen(0, "127.0.0.1", resolve));
  otherOrigin = `http://127.0.0.1:${(otherSite.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => otherSite.close(resolve));
});

// A blocked cross-origin response never reaches Playwright's network events, so
// the status is only observable for navigations: put a link or form on the other
// site, activate it and look at the document that comes back.
async function navigateFromOtherSite(page: Page, html: string): Promise<Response> {
  await page.goto(otherOrigin);
  await page.setContent(html);
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.request().isNavigationRequest()),
    page.click("#go"),
  ]);
  return response;
}

test("the app's own page reads and writes the API", async ({ page, pageProblems }) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const read = await fetch("/api/health");
    const write = await fetch("/api/health", { method: "POST", body: "{}" });
    return { read: read.status, body: await read.json(), write: write.status };
  });

  expect(result.read).toBe(200);
  expect(result.body).toEqual({ status: "ok" });
  // No POST route exists yet; anything but 403 shows that the guard let the request through.
  expect(result.write).not.toBe(403);
  // The page reports the 404 it got instead. Whatever else it reports still fails the test.
  forgetProblems(pageProblems, (problem) => /\b404\b.*\/api\/health/.test(problem));
});

test("a page on another origin cannot read an API response", async ({ page, baseURL, pageProblems }) => {
  await page.goto(otherOrigin);

  const read = await page.evaluate(
    (url) =>
      fetch(url).then(
        () => "readable",
        () => "blocked",
      ),
    `${baseURL}/api/health`,
  );

  // Shows only that no CORS header is sent: the fetch is blocked whether the server refuses or answers.
  expect(read).toBe("blocked");
  forgetProblems(pageProblems);
});

test("requests started by a page on another origin are refused before an API handler runs", async ({
  page,
  pageProblems,
}) => {
  // The browser keeps a blocked cross-origin response from the page and from Playwright
  // alike, so a second instance of the app runs in this process and notes what it answered.
  const answers = new Map<string, number>();
  const server = await startServer({
    port: 0,
    app: ({ port }) => {
      const app = createApp({ port, workspace: TEST_WORKSPACE });
      return {
        fetch: async (request, env) => {
          const response = await app.fetch(request, env);
          answers.set(new URL(request.url).searchParams.get("via") ?? "", response.status);
          return response;
        },
      };
    },
  });

  try {
    await page.goto(otherOrigin);
    await page.evaluate(async (url) => {
      await fetch(`${url}?via=fetch`).catch(() => {});
      for (const open of [
        () => new EventSource(`${url}?via=eventsource`),
        () => new WebSocket(`${url.replace("http:", "ws:")}?via=websocket`),
        () => Object.assign(new Image(), { src: `${url}?via=image` }),
      ]) {
        await new Promise((resolve) => open().addEventListener("error", resolve));
      }
    }, `http://${server.hostname}:${server.port}/api/health`);
  } finally {
    await server.close();
  }

  expect(Object.fromEntries(answers)).toEqual({ fetch: 403, eventsource: 403, websocket: 403, image: 403 });
  forgetProblems(pageProblems);
});

test("a form on another site cannot post to the app", async ({ page, baseURL, pageProblems }) => {
  const response = await navigateFromOtherSite(
    page,
    `<form method="post" action="${baseURL}/api/health"><button id="go">Wyślij</button></form>`,
  );

  expect(response.status()).toBe(403);
  expect(await response.json()).toMatchObject({ error: "forbidden_origin" });
  expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
  forgetProblems(pageProblems);
});

test("a link on another site cannot open an API address", async ({ page, baseURL, pageProblems }) => {
  const response = await navigateFromOtherSite(page, `<a id="go" href="${baseURL}/api/health">API</a>`);

  expect(response.status()).toBe(403);
  expect(await response.json()).toMatchObject({ error: "forbidden_origin" });
  forgetProblems(pageProblems);
});

test("a link on another site still opens the app", async ({ page, baseURL }) => {
  const response = await navigateFromOtherSite(page, `<a id="go" href="${baseURL}/">Hubber</a>`);

  expect(response.status()).toBe(200);
  // The page that arrives this way is the app's own again: the requests it makes itself are let through.
  await expect(page.getByText("Serwer działa")).toBeVisible();
});

test("typing an API address into the address bar works", async ({ page }) => {
  const response = await page.goto("/api/health");

  expect(response?.status()).toBe(200);
});

test("a foreign host name that resolves to 127.0.0.1 is refused (DNS rebinding)", async ({
  playwright,
  browserName,
  baseURL,
}) => {
  test.skip(browserName !== "chromium", "Only Chromium can map a host name to an address from the command line.");
  const browser = await playwright.chromium.launch({ args: ["--host-resolver-rules=MAP rebound.example 127.0.0.1"] });
  try {
    const page = await browser.newPage();
    const port = new URL(baseURL ?? "").port;

    const shell = await page.goto(`http://rebound.example:${port}/`);
    const api = await page.evaluate(async () => {
      const res = await fetch("/api/health");
      return { status: res.status, body: await res.json() };
    });

    expect(shell?.status()).toBe(403);
    expect(api.status).toBe(403);
    expect(api.body).toMatchObject({ error: "forbidden_host" });
  } finally {
    await browser.close();
  }
});

test("another site cannot show the app in a frame", async ({ page, baseURL, pageProblems }) => {
  await page.goto(otherOrigin);
  // setContent returns after the load event, which waits for the frame whether it was refused or not.
  const [response] = await Promise.all([
    page.waitForResponse(`${baseURL}/`),
    page.setContent(`<iframe src="${baseURL}/"></iframe>`),
  ]);

  // The server answers; it is the browser that refuses to show the answer.
  expect(response.status()).toBe(200);
  // #root is part of the served HTML, so this does not depend on the app having rendered.
  await expect(page.frameLocator("iframe").locator("#root")).toHaveCount(0);
  forgetProblems(pageProblems);
});

test("another site cannot load any address of the app, not even one with an encoded line break", async ({
  page,
  baseURL,
  pageProblems,
}) => {
  await page.goto(otherOrigin);

  // A "no-cors" request needs no consent from the server: the page cannot read the answer, but it
  // learns that one came. Cross-Origin-Resource-Policy makes the browser fail such a request, so
  // the header has to be on every answer. A path that holds a line terminator is the one kind
  // the router's catch-all does not match by itself (see createApp), and an address too long
  // for Node never reaches the app: the HTTP layer answers it (see answerClientError).
  const loaded = await page.evaluate(
    async (urls) => {
      const outcomes = await Promise.all(
        urls.map((url) =>
          fetch(url, { mode: "no-cors" }).then(
            () => true,
            () => false,
          ),
        ),
      );
      return urls.filter((_url, index) => outcomes[index]);
    },
    ["/", "/api/health", "/%0A", "/api/x%E2%80%A8", `/${"a".repeat(20_000)}`].map((path) => `${baseURL}${path}`),
  );

  expect(loaded).toEqual([]);
  forgetProblems(pageProblems);
});

test("the app's own page cannot call another site", async ({ page, pageProblems }) => {
  await page.goto("/");

  const sent = await page.evaluate(
    (url) =>
      fetch(url, { mode: "no-cors" }).then(
        () => true,
        () => false,
      ),
    otherOrigin,
  );

  expect(sent).toBe(false);
  // The browser reports the request it refused. Whatever else the page reports still fails the test.
  forgetProblems(pageProblems, (problem) => problem.includes(otherOrigin));
});
