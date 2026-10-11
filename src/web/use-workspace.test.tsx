import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advance,
  fakeClock,
  neverAnswers,
  renderWithClient,
  SETTLE_MS,
  spyOnConsoleError,
  stubFetch,
} from "./test/harness.tsx";
import { useWorkspace, type WorkspaceCheck } from "./use-workspace.ts";

const WORK = { name: "Praca", endpointOrigin: "https://router.corp.example" };
const DEV = { name: "Dev", endpointOrigin: "https://api.anthropic.com" };
// What the hook promises: how often it asks the server, and how long it waits for an answer.
const POLL_MS = 5_000;
const TIMEOUT_MS = 3_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// The indicator has its own tests, which look at the page. These look at what the hook hands a
// screen, because the indicator will not stay the only one that asks which workspace is open.
describe("useWorkspace", () => {
  /** Renders a screen that does nothing but ask, and collects every answer it was given, in order. */
  function renderScreen(): WorkspaceCheck[] {
    const given: WorkspaceCheck[] = [];
    function Screen() {
      given.push(useWorkspace());
      return null;
    }
    renderWithClient(<Screen />);
    return given;
  }

  it("hands out a workspace only while the last check that finished confirmed it", async () => {
    fakeClock();
    spyOnConsoleError();
    let server: "work" | "down" | "silent" | "dev" = "work";
    stubFetch((input, init) => {
      if (server === "work") return Promise.resolve(Response.json(WORK));
      if (server === "dev") return Promise.resolve(Response.json(DEV));
      if (server === "down") return Promise.reject(new TypeError("fetch failed"));
      return neverAnswers(input, init);
    });

    const given = renderScreen();
    expect(given).toEqual([{ status: "pending" }]);

    await advance(SETTLE_MS);
    expect(given.at(-1)).toEqual({ status: "confirmed", workspace: WORK });

    server = "down";
    await advance(POLL_MS);
    expect(given.at(-1)).toEqual({ status: "error" });

    // From the failed check on, through the check that is never answered and gives up after its
    // deadline, a screen is given no workspace at all: not the old one either. (Whether it is
    // given anything anew in that time is up to the library, which tells a screen only of changes.)
    const sinceTheFailure = given.length - 1;
    server = "silent";
    await advance(POLL_MS + TIMEOUT_MS + SETTLE_MS);
    expect(given.slice(sinceTheFailure)).toEqual(given.slice(sinceTheFailure).map(() => ({ status: "error" })));

    // The server is back, and with another workspace.
    server = "dev";
    await advance(POLL_MS);
    expect(given.at(-1)).toEqual({ status: "confirmed", workspace: DEV });
    expect(given.slice(sinceTheFailure)).not.toContainEqual({ status: "confirmed", workspace: WORK });
  });

  it("asks the server once per check, however many screens read the workspace", async () => {
    fakeClock();
    const fetchMock = stubFetch(async () => Response.json(WORK));
    const given: WorkspaceCheck[][] = [[], []];
    function Screen({ index }: { index: number }) {
      given[index]?.push(useWorkspace());
      return null;
    }

    renderWithClient(
      <>
        <Screen index={0} />
        <Screen index={1} />
      </>,
    );
    await advance(SETTLE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(2 * POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(given.map((answers) => answers.at(-1))).toEqual([
      { status: "confirmed", workspace: WORK },
      { status: "confirmed", workspace: WORK },
    ]);
  });

  it("says that the check failed, and not that it is pending, while a server that has never answered is asked again", async () => {
    fakeClock();
    spyOnConsoleError();
    // Every attempt takes a second to fail, so that the screen is told of each one while it is under way.
    stubFetch(() => new Promise((_resolve, reject) => setTimeout(() => reject(new TypeError("fetch failed")), 1_000)));

    const given = renderScreen();
    expect(given).toEqual([{ status: "pending" }]);

    await advance(1_000 + SETTLE_MS);
    expect(given.at(-1)).toEqual({ status: "error" });

    // The second attempt has started and has not failed yet.
    const sinceTheFailure = given.length - 1;
    await advance(POLL_MS);
    expect(given.length).toBeGreaterThan(sinceTheFailure + 1);
    expect(given.slice(sinceTheFailure)).toEqual(given.slice(sinceTheFailure).map(() => ({ status: "error" })));
  });
});
