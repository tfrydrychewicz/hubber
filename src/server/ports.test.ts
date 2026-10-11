import { describe, expect, it } from "vitest";
import { DEFAULT_API_PORT, DEFAULT_E2E_PORT, DEFAULT_WEB_PORT, PortError, parsePort } from "./ports.ts";

describe("default ports", () => {
  // The development runner refuses two equal ports, and an end-to-end run on the API port
  // would collide with the instance the developer keeps running there.
  it("are all different", () => {
    expect(new Set([DEFAULT_API_PORT, DEFAULT_WEB_PORT, DEFAULT_E2E_PORT]).size).toBe(3);
  });
});

describe("parsePort", () => {
  it("falls back when the variable is unset or empty", () => {
    expect(parsePort(undefined, 4477, "HUBBER_PORT")).toBe(4477);
    expect(parsePort("", 4477, "HUBBER_PORT")).toBe(4477);
  });

  it("accepts a port in the unprivileged range", () => {
    expect(parsePort("1024", 4477, "HUBBER_PORT")).toBe(1024);
    expect(parsePort("5000", 4477, "HUBBER_PORT")).toBe(5000);
    expect(parsePort("65535", 4477, "HUBBER_PORT")).toBe(65_535);
  });

  it.each(["abc", "0", "80", "1023", "65536", "4477.5", "-1", "44 77", " 5000", "1e4", "0x1000"])(
    "rejects %j with a message naming the variable",
    (raw) => {
      expect(() => parsePort(raw, 4477, "HUBBER_PORT")).toThrow(PortError);
      expect(() => parsePort(raw, 4477, "HUBBER_PORT")).toThrow(`Niepoprawna wartość HUBBER_PORT: "${raw}"`);
    },
  );
});
