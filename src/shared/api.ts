// The one place that spells the API prefix. The server, the web app and the tooling around them
// have to agree on where the API ends and the routes of the web app begin.
export const API_ROOT = "/api";

/** The API is its root and everything below it. "/apix" is not: that is a route of the web app. */
export function isApiPath(path: string): boolean {
  return path === API_ROOT || path.startsWith(`${API_ROOT}/`);
}
