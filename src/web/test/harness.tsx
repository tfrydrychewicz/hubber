// What the component tests share: the app's own query client, a stand-in for fetch and a clock
// that the test moves by hand. For tests only.
import { QueryClientProvider } from "@tanstack/react-query";
import { act, type RenderOptions, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";
import { createQueryClient } from "../query-client.ts";

// On the fake clock nothing reaches the page at the instant it happens, because TanStack Query
// hands results to React through a zero-delay timer. The tests look this much later.
export const SETTLE_MS = 100;

export function renderWithClient(ui: ReactElement, options?: RenderOptions) {
  // A client per test keeps the cache from leaking between tests. It is the app's own client,
  // so that retries and error logging are the ones users get.
  const client = createQueryClient();
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>, options);
}

// Takes a factory because a Response body can be read only once.
export function stubFetch(respond: typeof fetch) {
  const fetchMock = vi.fn<typeof fetch>(respond);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Stands in for a server that accepts the connection and then says nothing: the request ends
// only when the caller's signal aborts it. It then fails the way WebKit's fetch does, with an
// AbortError of the engine's own; Chromium passes on the reason that the caller gave.
export const neverAnswers: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) throw new Error("The request has no signal, so nothing could ever end it.");
    signal.addEventListener("abort", () => reject(new DOMException("Fetch is aborted", "AbortError")));
  });

export function fakeClock() {
  // Only what the page and TanStack Query schedule with. setImmediate stays real, because
  // React's act() waits on it.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
}

// Every failed query is logged. The spy keeps that out of the test output and lets a test read it.
export function spyOnConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

// Moves the fake clock. Requests settle and the page re-renders on the way, as they would in real time.
export async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
