// Aliased because the DOM has a MutationObserver of its own.
import { onlineManager, QueryObserver, MutationObserver as TanStackMutationObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "./query-client.ts";

afterEach(() => {
  onlineManager.setOnline(true);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createQueryClient", () => {
  it("runs queries and mutations while the browser reports that it is offline", async () => {
    onlineManager.setOnline(false);
    const client = createQueryClient();
    const queryFn = vi.fn(async () => "answer");
    const mutationFn = vi.fn(async () => "saved");

    new QueryObserver(client, { queryKey: ["probe"], queryFn }).subscribe(() => {});
    const saved = new TanStackMutationObserver(client, { mutationFn }).mutate();

    // Paused work would wait here for an "online" event that never comes.
    await vi.waitFor(() => {
      expect(queryFn).toHaveBeenCalledTimes(1);
      expect(mutationFn).toHaveBeenCalledTimes(1);
    });
    await expect(saved).resolves.toBe("saved");
  });

  it("gives a failing query one more try half a second later and then reports the error", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = createQueryClient();
    const queryFn = vi.fn(async (): Promise<string> => {
      throw new Error("boom");
    });
    const observer = new QueryObserver(client, { queryKey: ["probe"], queryFn });
    observer.subscribe(() => {});

    await vi.advanceTimersByTimeAsync(499);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().status).toBe("pending");

    await vi.advanceTimersByTimeAsync(1);
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(observer.getCurrentResult().status).toBe("error");

    // Nothing is left that would try a third time.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it("names the query and the cause in the console when a query fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = createQueryClient();
    const cause = new Error("boom");

    await expect(
      client.fetchQuery({ queryKey: ["probe", 7], queryFn: () => Promise.reject(cause), retry: false }),
    ).rejects.toBe(cause);

    expect(logged).toHaveBeenCalledExactlyOnceWith('Query ["probe",7] failed:', cause);
  });
});
