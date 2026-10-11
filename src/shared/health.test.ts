import { describe, expect, it } from "vitest";
import { isApiPath } from "./api.ts";
import { HEALTH_PATH, isHealthResponse } from "./health.ts";

describe("HEALTH_PATH", () => {
  it("is an address under the API root", () => {
    expect(HEALTH_PATH).toBe("/api/health");
    expect(isApiPath(HEALTH_PATH)).toBe(true);
  });
});

describe("isHealthResponse", () => {
  it("accepts the payload of GET /api/health", () => {
    expect(isHealthResponse({ status: "ok" })).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isHealthResponse({ status: "down" })).toBe(false);
    expect(isHealthResponse({})).toBe(false);
    expect(isHealthResponse(null)).toBe(false);
    expect(isHealthResponse("ok")).toBe(false);
  });
});
