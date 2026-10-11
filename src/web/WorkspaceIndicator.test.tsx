import { focusManager } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  advance,
  fakeClock,
  neverAnswers,
  renderWithClient,
  SETTLE_MS,
  spyOnConsoleError,
  stubFetch,
} from "./test/harness.tsx";
import { WorkspaceIndicator } from "./WorkspaceIndicator.tsx";

const WORK = { name: "Praca", endpointOrigin: "https://router.corp.example" };
const DEV = { name: "Dev", endpointOrigin: "https://api.anthropic.com" };
// What the indicator promises: how often it asks the server, and how long it waits for an answer.
const POLL_MS = 5_000;
const TIMEOUT_MS = 3_000;

function indicator() {
  return screen.getByRole("status", { name: "Aktywny workspace" });
}

// The pairs on screen, label first.
function shown() {
  const terms = screen.queryAllByRole("term").map((term) => term.textContent);
  const definitions = screen.queryAllByRole("definition").map((definition) => definition.textContent);
  return terms.map((term, index) => [term, definitions[index]]);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("WorkspaceIndicator", () => {
  it("names the workspace and its endpoint once the server has answered", async () => {
    const fetchMock = stubFetch(async () => Response.json(WORK));

    renderWithClient(<WorkspaceIndicator />);

    expect(indicator()).toHaveTextContent("Sprawdzam workspace…");
    expect(shown()).toEqual([]);
    expect(await screen.findByText("Praca")).toBeInTheDocument();
    expect(shown()).toEqual([
      ["Workspace", "Praca"],
      ["Endpoint", "https://router.corp.example"],
    ]);
    expect(indicator()).not.toHaveTextContent("Sprawdzam workspace…");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/workspace", expect.anything());
  });

  it.each([
    [
      "answers with an error status",
      async () => Response.json(WORK, { status: 500 }),
      "GET /api/workspace returned 500",
    ],
    [
      "answers with something other than a workspace",
      async () => Response.json({ status: "ok" }),
      "GET /api/workspace returned an unexpected body",
    ],
    [
      "says more of the endpoint than its origin",
      async () => Response.json({ name: "Praca", endpointOrigin: "https://router.corp.example/konto/haslo-123" }),
      "GET /api/workspace returned an unexpected body",
    ],
    [
      "cannot be reached",
      async (): Promise<Response> => {
        throw new TypeError("fetch failed");
      },
      "fetch failed",
    ],
  ])("says that the workspace could not be read when the server %s", async (_label, respond, cause) => {
    const logged = spyOnConsoleError();
    const fetchMock = stubFetch(respond);

    renderWithClient(<WorkspaceIndicator />);

    expect(await screen.findByText("Nie udało się odczytać workspace'u")).toBeInTheDocument();
    expect(shown()).toEqual([]);
    expect(indicator()).not.toHaveTextContent("haslo-123");
    // No second attempt: the next poll asks again anyway.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The words on screen are the same whatever went wrong, so the console has to say what did.
    expect(logged).toHaveBeenCalledExactlyOnceWith(
      'Query ["workspace"] failed:',
      expect.objectContaining({ message: cause }),
    );
  });

  it("follows a server that comes back with another workspace under the same address", async () => {
    fakeClock();
    let open = WORK;
    stubFetch(async () => Response.json(open));

    renderWithClient(<WorkspaceIndicator />);
    await advance(SETTLE_MS);
    expect(shown()).toEqual([
      ["Workspace", "Praca"],
      ["Endpoint", "https://router.corp.example"],
    ]);

    open = DEV;
    await advance(POLL_MS);
    expect(shown()).toEqual([
      ["Workspace", "Dev"],
      ["Endpoint", "https://api.anthropic.com"],
    ]);
    expect(indicator()).not.toHaveTextContent("Praca");
  });

  it("stops naming a workspace that it can no longer confirm, and names it again once it can", async () => {
    fakeClock();
    spyOnConsoleError();
    let up = true;
    stubFetch(async () => {
      if (!up) throw new TypeError("fetch failed");
      return Response.json(WORK);
    });

    renderWithClient(<WorkspaceIndicator />);
    await advance(SETTLE_MS);
    expect(indicator()).toHaveTextContent("Praca");

    up = false;
    await advance(POLL_MS);
    expect(indicator()).toHaveTextContent("Nie udało się odczytać workspace'u");
    expect(indicator()).not.toHaveTextContent("Praca");

    up = true;
    await advance(POLL_MS);
    expect(indicator()).toHaveTextContent("Praca");
  });

  it("keeps the failure on screen while a server that has never answered is asked again", async () => {
    fakeClock();
    const logged = spyOnConsoleError();
    // Every attempt takes a second to fail, which leaves time to look at the page while one is under way.
    const fetchMock = stubFetch(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(new TypeError("fetch failed")), 1_000)),
    );

    renderWithClient(<WorkspaceIndicator />);
    await advance(1_000 + SETTLE_MS);
    expect(indicator()).toHaveTextContent("Nie udało się odczytać workspace'u");

    await advance(POLL_MS);
    // The second attempt has started and has not failed yet.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(indicator()).toHaveTextContent("Nie udało się odczytać workspace'u");
  });

  it("keeps the failure on screen while a server that answered once and then failed is asked again", async () => {
    fakeClock();
    const logged = spyOnConsoleError();
    let server: "up" | "down" | "silent" = "up";
    const fetchMock = stubFetch((input, init) => {
      if (server === "up") return Promise.resolve(Response.json(WORK));
      if (server === "down") return Promise.reject(new TypeError("fetch failed"));
      return neverAnswers(input, init);
    });

    renderWithClient(<WorkspaceIndicator />);
    await advance(SETTLE_MS);
    expect(indicator()).toHaveTextContent("Praca");

    server = "down";
    await advance(POLL_MS);
    expect(indicator()).toHaveTextContent("Nie udało się odczytać workspace'u");

    // The page still has the answer of the first check. The third check has started and is not
    // over, and until it is, the second one is the last word: the old answer must not come back.
    server = "silent";
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(indicator()).toHaveTextContent("Nie udało się odczytać workspace'u");
    expect(indicator()).not.toHaveTextContent("Praca");
    expect(shown()).toEqual([]);
  });

  it("stops naming a workspace when a later check is never answered", async () => {
    fakeClock();
    spyOnConsoleError();
    let answering = true;
    stubFetch((input, init) => (answering ? Promise.resolve(Response.json(WORK)) : neverAnswers(input, init)));

    renderWithClient(<WorkspaceIndicator />);
    await advance(SETTLE_MS);
    expect(indicator()).toHaveTextContent("Praca");

    // Nothing has failed yet: the check is under way, and the last one that finished confirmed the workspace.
    answering = false;
    await advance(POLL_MS);
    expect(indicator()).toHaveTextContent("Praca");

    await advance(TIMEOUT_MS);
    expect(indicator()).toHaveTextContent("Nie udało się odczytać workspace'u");
    expect(indicator()).not.toHaveTextContent("Praca");
  });

  it("leaves the server alone while the tab is hidden and asks at once when it is shown again", async () => {
    fakeClock();
    let open = WORK;
    const fetchMock = stubFetch(async () => Response.json(open));
    // TanStack Query asks its focus manager whether the tab is shown; in a browser the
    // "visibilitychange" event keeps the manager informed. The manager outlives the test, so it is
    // put back afterwards, and only once the page is gone: a page that is still mounted takes the
    // reset for a return to the tab and sends one more request.
    onTestFinished(() => focusManager.setFocused(undefined));

    renderWithClient(<WorkspaceIndicator />);
    await advance(SETTLE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The server is restarted with another workspace while nobody looks at the tab.
    focusManager.setFocused(false);
    open = DEV;
    await advance(3 * POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Whoever returns to the tab must not read the old name until the next check is due.
    focusManager.setFocused(true);
    await advance(SETTLE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(shown()).toEqual([
      ["Workspace", "Dev"],
      ["Endpoint", "https://api.anthropic.com"],
    ]);
    expect(indicator()).not.toHaveTextContent("Praca");
  });

  it("gives up on a request that the server accepts but never answers, and asks again later", async () => {
    fakeClock();
    const logged = spyOnConsoleError();
    const fetchMock = stubFetch(neverAnswers);

    renderWithClient(<WorkspaceIndicator />);
    await advance(TIMEOUT_MS - SETTLE_MS);
    expect(indicator()).toHaveTextContent("Sprawdzam workspace…");

    await advance(2 * SETTLE_MS);
    expect(indicator()).toHaveTextContent("Nie udało się odczytać workspace'u");
    expect(logged).toHaveBeenCalledExactlyOnceWith(
      'Query ["workspace"] failed:',
      expect.objectContaining({ message: "GET /api/workspace timed out after 3000 ms" }),
    );

    // The unanswered request must not stand in the way of the next one.
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends one request and never cancels it when StrictMode mounts the indicator twice, as in development", async () => {
    const fetchMock = stubFetch(async () => Response.json(WORK));

    renderWithClient(<WorkspaceIndicator />, { wrapper: StrictMode });

    expect(await screen.findByText("Praca")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  it("shows a name that looks like markup as the text it is", async () => {
    stubFetch(async () => Response.json({ ...WORK, name: '<img src=x onerror="alert(1)">' }));

    renderWithClient(<WorkspaceIndicator />);

    expect(await screen.findByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
    expect(indicator().querySelector("img")).toBeNull();
  });

  it("lets a long name or address wrap inside the card instead of widening it", async () => {
    stubFetch(async () => Response.json(WORK));

    renderWithClient(<WorkspaceIndicator />);
    await screen.findByText("Praca");

    // jsdom lays nothing out, so the class names are all there is to check.
    for (const definition of screen.getAllByRole("definition")) expect(definition).toHaveClass("wrap-anywhere");
  });
});
