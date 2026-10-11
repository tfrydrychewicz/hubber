import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { createFakeEndpoint } from "../llm/diagnostics/fake-endpoint.ts";
import { runDiagnostics } from "../llm/diagnostics/run.ts";
import type { DiagnosticsReport } from "../llm/diagnostics/types.ts";
import { parseWorkspaceConfig, serializeWorkspaceConfig } from "./config.ts";
import { DiagnosticsReportError, summarizeReport } from "./diagnostics-summary.ts";

// An invented value: it stands for a credential that an endpoint repeated in an error text.
const SECRET = "sk-test-0123456789abcdef-not-a-real-key";
const NOT_A_REPORT =
  'Plik nie jest raportem diagnostyki w obsługiwanym formacie. Utwórz go poleceniem "npm run diagnose".';

const REPORT: DiagnosticsReport = {
  schemaVersion: 1,
  startedAt: "2026-10-10T08:56:13.000Z",
  durationMs: 41_234,
  meta: {
    endpoint: "https://router.corp.example/llm",
    endpointIsDefault: false,
    credentialSource: "ANTHROPIC_AUTH_TOKEN",
    customHeaderNames: ["X-Team"],
    model: "router-opus",
    modelSource: "--model",
    label: "router.corp.example",
  },
  runtime: { node: "v26.5.0", platform: "darwin-arm64", sdk: "0.132.1" },
  summary: {
    coreReady: true,
    capabilities: { promptCache: true, effort: false, thinking: true, pdfInput: true },
    informational: { strictTools: false, structuredOutput: true, modelsList: true },
  },
  availableModels: ["router-opus", "router-sonnet"],
  checks: [
    {
      id: "effort",
      group: "optional",
      title: "Poziom wysiłku (effort)",
      status: "rejected",
      durationMs: 301,
      detail: `internal detail of the endpoint, with ${SECRET}`,
    },
  ],
};

/** The report as plain JSON, loose enough for a test to break it in one place. */
type LooseReport = Record<string, unknown> & {
  meta: Record<string, unknown>;
  summary: Record<string, unknown> & { capabilities: Record<string, unknown> };
};

function reportWith(change: (report: LooseReport) => void): string {
  const report = structuredClone(REPORT) as unknown as LooseReport;
  change(report);
  return JSON.stringify(report);
}

function failure(text: string): DiagnosticsReportError {
  try {
    summarizeReport(text);
  } catch (error) {
    if (error instanceof DiagnosticsReportError) return error;
    throw error;
  }
  throw new Error("The report was taken in.");
}

describe("summarizeReport", () => {
  it("keeps the verdicts of a report", () => {
    expect(summarizeReport(JSON.stringify(REPORT))).toEqual({
      diagnostics: {
        checkedAt: "2026-10-10T08:56:13.000Z",
        model: "router-opus",
        coreReady: true,
        capabilities: { promptCache: true, effort: false, thinking: true, pdfInput: true },
      },
      endpoint: "https://router.corp.example/llm",
      availableModels: ["router-opus", "router-sonnet"],
    });
  });

  it("leaves the transcript out of what goes into the profile", () => {
    const { diagnostics } = summarizeReport(JSON.stringify(REPORT));
    const kept = JSON.stringify(diagnostics);

    // The error texts of the checks, how the run was authenticated, what the endpoint offers,
    // and the checks that must not influence anything.
    for (const left of [SECRET, "internal detail", "ANTHROPIC_AUTH_TOKEN", "X-Team", "router-sonnet", "strictTools"]) {
      expect(kept).not.toContain(left);
    }
    expect(Object.keys(diagnostics)).toEqual(["checkedAt", "model", "coreReady", "capabilities"]);
    expect(Object.keys(diagnostics.capabilities)).toEqual(["promptCache", "effort", "thinking", "pdfInput"]);
  });

  it("keeps a verdict of a core that is not ready as it is, for the caller to judge", () => {
    const text = reportWith((report) => {
      report.summary.coreReady = false;
    });

    expect(summarizeReport(text).diagnostics.coreReady).toBe(false);
  });

  it("has no address for a report that was written without one", () => {
    const text = reportWith((report) => {
      report.meta.endpoint = null;
    });

    expect(summarizeReport(text).endpoint).toBeNull();
  });

  it("takes the list of models only as far as it is a list of identifiers", () => {
    const withoutList = reportWith((report) => {
      delete report.availableModels;
    });
    const mixed = reportWith((report) => {
      report.availableModels = ["router-opus", 7, null, "router-haiku"];
    });

    expect(summarizeReport(withoutList).availableModels).toEqual([]);
    expect(summarizeReport(mixed).availableModels).toEqual(["router-opus", "router-haiku"]);
  });

  it("takes in a report exactly as the diagnostics write it, and the profile made of it can be read back", async () => {
    const endpoint = createFakeEndpoint({ model: "router-opus", reject: ["output_config"] });
    // The stand-in answers at the root of its origin. The address that the report names is a
    // value of its own, given beside the client.
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: "https://router.corp.example",
      fetch: endpoint.fetch,
      maxRetries: 0,
    });
    const report = await runDiagnostics({ client, meta: REPORT.meta, sleep: async () => {} });

    const summary = summarizeReport(`${JSON.stringify(report, null, 2)}\n`);

    expect(summary).toEqual({
      diagnostics: {
        checkedAt: report.startedAt,
        model: "router-opus",
        coreReady: true,
        capabilities: { promptCache: true, effort: false, thinking: true, pdfInput: true },
      },
      endpoint: "https://router.corp.example/llm",
      availableModels: ["router-opus"],
    });
    // What the create command writes from it is a file that the next start accepts.
    const config = {
      schemaVersion: 1 as const,
      name: "Praca",
      createdAt: "2026-10-10T20:46:44.847Z",
      profile: {
        kind: "router" as const,
        endpoint: "https://router.corp.example/llm",
        auth: "bearer" as const,
        models: { default: summary.diagnostics.model },
        diagnostics: summary.diagnostics,
      },
    };
    expect(parseWorkspaceConfig(serializeWorkspaceConfig(config))).toEqual(config);
  });

  it("says that a file is not JSON, without quoting it", () => {
    const error = failure(`{"apiKey": "${SECRET}" oops`);

    expect(error.message).toBe("Raport diagnostyki nie jest poprawnym JSON-em.");
    expect(failure("").message).toBe("Raport diagnostyki nie jest poprawnym JSON-em.");
  });

  const NOT_REPORTS: [what: string, text: string][] = [
    ["an empty object", "{}"],
    ["a list", "[]"],
    ["a text", '"report"'],
    ["the JSON value null", "null"],
    [
      "a report of another format version",
      reportWith((report) => {
        report.schemaVersion = 2;
      }),
    ],
    [
      "a report without a format version",
      reportWith((report) => {
        delete report.schemaVersion;
      }),
    ],
    [
      "a report without the run's settings",
      reportWith((report) => {
        delete (report as Record<string, unknown>).meta;
      }),
    ],
    [
      "a report without a summary",
      reportWith((report) => {
        delete (report as Record<string, unknown>).summary;
      }),
    ],
    [
      "a summary without capabilities",
      reportWith((report) => {
        delete (report.summary as Record<string, unknown>).capabilities;
      }),
    ],
    [
      "a missing capability",
      reportWith((report) => {
        delete report.summary.capabilities.pdfInput;
      }),
    ],
    [
      "a capability in words",
      reportWith((report) => {
        report.summary.capabilities.thinking = "tak";
      }),
    ],
    [
      "a verdict on the core in words",
      reportWith((report) => {
        report.summary.coreReady = "yes";
      }),
    ],
    [
      "a missing verdict on the core",
      reportWith((report) => {
        delete report.summary.coreReady;
      }),
    ],
    [
      "a missing time",
      reportWith((report) => {
        delete report.startedAt;
      }),
    ],
    [
      "a time in words",
      reportWith((report) => {
        report.startedAt = "rano";
      }),
    ],
    [
      // A date, but not one that the configuration file would accept back.
      "a time that is not an ISO date",
      reportWith((report) => {
        report.startedAt = "10 October 2026 08:56 UTC";
      }),
    ],
    [
      "a missing model",
      reportWith((report) => {
        delete report.meta.model;
      }),
    ],
    [
      "an empty model",
      reportWith((report) => {
        report.meta.model = "";
      }),
    ],
    [
      "a model that is no identifier",
      reportWith((report) => {
        report.meta.model = "router opus";
      }),
    ],
    [
      "a missing address",
      reportWith((report) => {
        delete report.meta.endpoint;
      }),
    ],
    [
      "an address that is not text",
      reportWith((report) => {
        report.meta.endpoint = 443;
      }),
    ],
  ];

  it.each(NOT_REPORTS)("refuses %s as something that is not a report", (_what, text) => {
    expect(failure(text).message).toBe(NOT_A_REPORT);
  });
});
