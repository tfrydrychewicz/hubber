import { describe, expect, it } from "vitest";
import { API_ROOT, isApiPath } from "./api.ts";

describe("isApiPath", () => {
  it.each([API_ROOT, "/api/", "/api/health", "/api/items/42"])("takes %s as part of the API", (path) => {
    expect(isApiPath(path)).toBe(true);
  });

  // A path that merely starts with the same letters belongs to the web app.
  it.each(["/", "/apix", "/apiary/list", "/api-docs", "/api.json", "/app/api", "/API/health"])(
    "leaves %s to the web app",
    (path) => {
      expect(isApiPath(path)).toBe(false);
    },
  );
});
