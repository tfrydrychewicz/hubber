import { focusManager, QueryClientProvider } from "@tanstack/react-query";
import { act, type RenderOptions, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { App } from "./App.tsx";
import { createQueryClient } from "./query-client.ts";

// What the page promises: how often it asks the server, and how long it waits for an answer.
const POLL_MS = 5_000;
const TIMEOUT_MS = 3_000;
// On the fake clock nothing reaches the page at the instant it happens, because TanStack Query
// hands results to React through a zero-delay timer. The tests look this much later.
const SETTLE_MS = 100;

function renderApp(options?: RenderOptions) {
  // A client per test keeps the cache from leaking between tests. It is the app's own client,
  // so that retries and error logging are the ones users get.
  const client = createQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
    options,
  );
}

// Takes a factory because a Response body can be read only once.
function stubFetch(respond: typeof fetch) {
  const fetchMock = vi.fn<typeof fetch>(respond);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Stands in for a server that accepts the connection and then says nothing: the request ends
// only when the caller's signal aborts it. It then fails the way WebKit's fetch does, with an
// AbortError of the engine's own; Chromium passes on the reason that the caller gave.
const neverAnswers: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) throw new Error("The request has no signal, so nothing could ever end it.");
    signal.addEventListener("abort", () => reject(new DOMException("Fetch is aborted", "AbortError")));
  });

function status() {
  return screen.getByRole("status");
}

// The dot is hidden from the accessibility tree, so no role or text query reaches it.
function dot() {
  return status().firstElementChild;
}

function fakeClock() {
  // Only what the page and TanStack Query schedule with. setImmediate stays real, because
  // React's act() waits on it.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
}

// Every failed check is logged. The spy keeps that out of the test output and lets a test read it.
function spyOnConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

// Moves the fake clock. Requests settle and the page re-renders on the way, as they would in real time.
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("App", () => {
  it("shows the name and says the server is up when the health check succeeds", async () => {
    const fetchMock = stubFetch(async () => Response.json({ status: "ok" }));

    renderApp();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Hubber");
    expect(status()).toHaveTextContent("Sprawdzam połączenie…");
    expect(dot()).toHaveClass("bg-zinc-400");
    expect(await screen.findByText("Serwer działa")).toBeInTheDocument();
    expect(dot()).toHaveClass("bg-emerald-500");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/health", expect.anything());
  });

  it.each([
    [
      "answers with an error status",
      // A valid health body, so that the status alone makes this a failure.
      async () => Response.json({ status: "ok" }, { status: 500 }),
      "GET /api/health returned 500",
    ],
    [
      "answers with something other than the health payload",
      async () => Response.json({ status: "down" }),
      "GET /api/health returned an unexpected body",
    ],
    [
      "cannot be reached",
      async (): Promise<Response> => {
        throw new TypeError("fetch failed");
      },
      "fetch failed",
    ],
  ])("reports a failure when the server %s", async (_label, respond, cause) => {
    const logged = spyOnConsoleError();
    const fetchMock = stubFetch(respond);

    renderApp();

    expect(await screen.findByText("Brak połączenia z serwerem")).toBeInTheDocument();
    expect(screen.queryByText("Serwer działa")).not.toBeInTheDocument();
    expect(dot()).toHaveClass("bg-red-500");
    // No second attempt: it would only hold the label back, and the next poll asks again anyway.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The label is the same whatever went wrong, so the console has to say what did.
    expect(logged).toHaveBeenCalledExactlyOnceWith(
      'Query ["health"] failed:',
      expect.objectContaining({ message: cause }),
    );
  });

  it("keeps checking, so the label follows the server going away and coming back", async () => {
    fakeClock();
    spyOnConsoleError();
    let up = true;
    stubFetch(async () => {
      if (!up) throw new TypeError("fetch failed");
      return Response.json({ status: "ok" });
    });

    renderApp();
    await advance(SETTLE_MS);
    expect(status()).toHaveTextContent("Serwer działa");

    up = false;
    await advance(POLL_MS);
    expect(status()).toHaveTextContent("Brak połączenia z serwerem");

    up = true;
    await advance(POLL_MS);
    expect(status()).toHaveTextContent("Serwer działa");
  });

  it("leaves the server alone while the tab is hidden and asks at once when it is shown again", async () => {
    fakeClock();
    const fetchMock = stubFetch(async () => Response.json({ status: "ok" }));
    // TanStack Query asks its focus manager whether the tab is shown; in a browser the
    // "visibilitychange" event keeps the manager informed. The manager outlives the test, so it is
    // put back afterwards, and only once the page is gone: a page that is still mounted takes the
    // reset for a return to the tab and sends one more request.
    onTestFinished(() => focusManager.setFocused(undefined));

    renderApp();
    await advance(SETTLE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    focusManager.setFocused(false);
    await advance(3 * POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    focusManager.setFocused(true);
    await advance(SETTLE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the failure on screen while a server that has never answered is checked again", async () => {
    fakeClock();
    const logged = spyOnConsoleError();
    // Every attempt takes a second to fail, which leaves time to look at the page while one is under way.
    const fetchMock = stubFetch(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(new TypeError("fetch failed")), 1_000)),
    );

    renderApp();
    await advance(1_000 + SETTLE_MS);
    expect(status()).toHaveTextContent("Brak połączenia z serwerem");

    await advance(POLL_MS);
    // The second attempt has started and has not failed yet.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(status()).toHaveTextContent("Brak połączenia z serwerem");
    expect(dot()).toHaveClass("bg-red-500");
  });

  it("gives up on a check that the server accepts but never answers, and asks again later", async () => {
    fakeClock();
    const logged = spyOnConsoleError();
    const fetchMock = stubFetch(neverAnswers);

    renderApp();
    await advance(TIMEOUT_MS - SETTLE_MS);
    expect(status()).toHaveTextContent("Sprawdzam połączenie…");

    await advance(2 * SETTLE_MS);
    expect(status()).toHaveTextContent("Brak połączenia z serwerem");
    expect(logged).toHaveBeenCalledExactlyOnceWith(
      'Query ["health"] failed:',
      expect.objectContaining({ message: "GET /api/health timed out after 3000 ms" }),
    );

    // The unanswered request must not stand in the way of the next check.
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up on an answer that begins and never ends", async () => {
    fakeClock();
    const logged = spyOnConsoleError();
    // The status line and headers arrive at once. The body ends only when the caller aborts the
    // request, and then it fails as it does in WebKit: with the engine's AbortError, not with the caller's reason.
    stubFetch((_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () =>
            controller.error(new DOMException("Fetch is aborted", "AbortError")),
          );
        },
      });
      return Promise.resolve(new Response(body));
    });

    renderApp();
    await advance(TIMEOUT_MS - SETTLE_MS);
    expect(status()).toHaveTextContent("Sprawdzam połączenie…");

    await advance(2 * SETTLE_MS);
    expect(status()).toHaveTextContent("Brak połączenia z serwerem");
    // The console has to name the deadline here too, not the engine's "Fetch is aborted".
    expect(logged).toHaveBeenCalledExactlyOnceWith(
      'Query ["health"] failed:',
      expect.objectContaining({ message: "GET /api/health timed out after 3000 ms" }),
    );
  });

  it("stops saying that the server is up when a later check is never answered", async () => {
    fakeClock();
    spyOnConsoleError();
    let answering = true;
    stubFetch((input, init) =>
      answering ? Promise.resolve(Response.json({ status: "ok" })) : neverAnswers(input, init),
    );

    renderApp();
    await advance(SETTLE_MS);
    expect(status()).toHaveTextContent("Serwer działa");

    answering = false;
    await advance(POLL_MS);
    expect(status()).toHaveTextContent("Serwer działa");

    await advance(TIMEOUT_MS);
    expect(status()).toHaveTextContent("Brak połączenia z serwerem");
  });

  it("sends one request and never cancels it when StrictMode mounts the page twice, as in development", async () => {
    const fetchMock = stubFetch(async () => Response.json({ status: "ok" }));

    renderApp({ wrapper: StrictMode });

    expect(await screen.findByText("Serwer działa")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  it("draws a dot that a wrapping label cannot squeeze and that pulses only when motion is welcome", async () => {
    stubFetch(async () => Response.json({ status: "ok" }));

    renderApp();

    // jsdom lays nothing out and evaluates no media query, so the class names are all there is to check.
    expect(dot()).toHaveClass("shrink-0", "motion-safe:animate-pulse");
    expect(dot()).not.toHaveClass("animate-pulse");
    await screen.findByText("Serwer działa");
    expect(dot()).toHaveClass("shrink-0");
  });
});
