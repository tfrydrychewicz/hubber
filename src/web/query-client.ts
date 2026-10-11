import { QueryCache, QueryClient } from "@tanstack/react-query";

// The one place the client is configured, so that the tests run with the options the app runs with.
export function createQueryClient(): QueryClient {
  return new QueryClient({
    // Without this a failed query leaves no trace outside the component that shows it, and
    // nothing says why: a refused connection and an answer with the wrong body look the same there.
    queryCache: new QueryCache({
      onError: (error, query) => console.error(`Query ${JSON.stringify(query.queryKey)} failed:`, error),
    }),
    defaultOptions: {
      queries: {
        // The API runs on this machine, so losing the network must not pause requests,
        // which is what the default "online" mode does.
        networkMode: "always",
        // On loopback an answer or a refusal arrives within milliseconds. One quick retry gets a
        // request past a restart of the API server; the library's three only delay the error by 7 s.
        retry: 1,
        retryDelay: 500,
      },
      mutations: { networkMode: "always" },
    },
  });
}
