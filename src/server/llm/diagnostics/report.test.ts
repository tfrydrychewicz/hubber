import { describe, expect, it } from "vitest";
import { renderHeader, renderResult, renderSummary } from "./report.ts";
import { CHECKS, type CheckResult, type DiagnosticsReport, type ReportMeta } from "./types.ts";

const META: ReportMeta = {
  endpoint: "https://router.corp.example",
  endpointIsDefault: false,
  credentialSource: "ANTHROPIC_AUTH_TOKEN",
  customHeaderNames: ["X-Team"],
  model: "router-opus",
  modelSource: "--model",
  label: "router.corp.example",
};

function report(overrides: Partial<DiagnosticsReport> = {}): DiagnosticsReport {
  return {
    schemaVersion: 1,
    startedAt: "2026-10-09T12:00:00.000Z",
    durationMs: 1,
    meta: META,
    runtime: { node: "v22", platform: "darwin-arm64", sdk: "0" },
    summary: {
      coreReady: true,
      capabilities: { promptCache: true, effort: false, thinking: true, pdfInput: false },
      informational: { strictTools: false, structuredOutput: false, modelsList: true },
    },
    availableModels: [],
    checks: CHECKS.map((check) => ({ ...check, status: "confirmed", durationMs: 1, detail: "" })),
    ...overrides,
  };
}

describe("renderHeader", () => {
  it("shows where requests will go before anything is sent", () => {
    const header = renderHeader(META);

    expect(header).toContain("https://router.corp.example");
    expect(header).toContain("router-opus (źródło: --model)");
    expect(header).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(header).toContain("X-Team");
  });

  it("marks a redacted and a default endpoint", () => {
    expect(renderHeader({ ...META, endpoint: null })).toContain("(ukryty)");
    expect(renderHeader({ ...META, endpoint: "https://api.anthropic.com", endpointIsDefault: true })).toContain("(domyślny)");
  });
});

describe("renderResult", () => {
  const base: CheckResult = { id: "effort", group: "optional", title: "Poziom wysiłku (effort)", status: "confirmed", durationMs: 1234, detail: "Działa." };

  it("shows the status, the title, the duration and the detail", () => {
    expect(renderResult(base)).toBe("  OK          Poziom wysiłku (effort) (1,2 s)\n              Działa.");
  });

  it("adds the hint for errors and omits the duration for skipped checks", () => {
    const failed = renderResult({ ...base, status: "error", error: { kind: "http", message: "x", hint: "Sprawdź token." } });
    expect(failed).toContain("BŁĄD");
    expect(failed).toContain("Wskazówka: Sprawdź token.");

    expect(renderResult({ ...base, status: "skipped", durationMs: 0 })).toContain("POMINIĘTE   Poziom wysiłku (effort)\n");
  });
});

describe("renderSummary", () => {
  it("lists the capabilities", () => {
    const summary = renderSummary(report());

    expect(summary).toContain("Rdzeń:               gotowy");
    expect(summary).toContain("cache_control tak, effort nie, thinking tak, PDF nie");
    expect(summary).toContain("strict nie, structured outputs nie, lista modeli tak");
    expect(summary).not.toContain("część testów");
  });

  it("notes a partial run", () => {
    expect(renderSummary(report({ checks: [] }))).toContain("Uruchomiono tylko część testów");
  });

  it("suggests the endpoint's models when the basic call failed", () => {
    const checks = report().checks.map((check): CheckResult => (check.id === "message" ? { ...check, status: "error" } : check));
    const summary = renderSummary(
      report({ checks, availableModels: ["router-opus", "router-sonnet"], summary: { ...report().summary, coreReady: false } }),
    );

    expect(summary).toContain("NIEGOTOWY");
    expect(summary).toContain("Modele dostępne na endpoincie: router-opus, router-sonnet");
  });
});
