// Takes a report written by "npm run diagnose" (src/server/llm/diagnostics) and keeps what
// belongs in the profile. The report is a transcript: every check with its timing and the
// endpoint's own error texts, the list of models the endpoint offers, how the run was
// authenticated. The profile needs the verdicts only, and the rest stays out of the workspace:
// error texts can quote internals of a private endpoint, and nothing may come to depend on the
// informational checks (docs/PLAN.md, M1a-1).
import type { DiagnosticsReport } from "../llm/diagnostics/types.ts";
import { type Capabilities, isIsoDate, modelIdProblem, type ProfileDiagnostics } from "./config.ts";

/** A report file that cannot be taken in. The message is written for the user. */
export class DiagnosticsReportError extends Error {
  override name = "DiagnosticsReportError";
}

export interface ReportSummary {
  diagnostics: ProfileDiagnostics;
  /** The address the report was made for; null when it was written with --redact-endpoint. */
  endpoint: string | null;
  /** Model identifiers the endpoint listed. Empty when it has no listing. */
  availableModels: string[];
}

const REPORT_SCHEMA_VERSION: DiagnosticsReport["schemaVersion"] = 1;
const CAPABILITY_NAMES = ["promptCache", "effort", "thinking", "pdfInput"] as const satisfies (keyof Capabilities)[];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the text of a report file. Only the fields that are used are looked at. */
export function summarizeReport(text: string): ReportSummary {
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    throw new DiagnosticsReportError("Raport diagnostyki nie jest poprawnym JSON-em.");
  }
  const notAReport = new DiagnosticsReportError(
    'Plik nie jest raportem diagnostyki w obsługiwanym formacie. Utwórz go poleceniem "npm run diagnose".',
  );
  if (!isObject(report) || report.schemaVersion !== REPORT_SCHEMA_VERSION) throw notAReport;
  const { meta, summary, startedAt } = report;
  if (!isObject(meta) || !isObject(summary) || !isObject(summary.capabilities)) throw notAReport;
  // The time and the model go into the configuration file as they are, so they have to be what
  // its reader accepts: a workspace created from the report must open at the next start.
  if (!isIsoDate(startedAt)) throw notAReport;
  if (typeof meta.model !== "string" || modelIdProblem(meta.model) !== undefined) throw notAReport;
  if (meta.endpoint !== null && typeof meta.endpoint !== "string") throw notAReport;
  if (typeof summary.coreReady !== "boolean") throw notAReport;
  const flags = summary.capabilities;
  if (CAPABILITY_NAMES.some((name) => typeof flags[name] !== "boolean")) throw notAReport;

  const listed = Array.isArray(report.availableModels) ? report.availableModels : [];
  return {
    diagnostics: {
      checkedAt: startedAt,
      model: meta.model,
      coreReady: summary.coreReady,
      capabilities: Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, flags[name]])) as unknown as Capabilities,
    },
    endpoint: meta.endpoint,
    availableModels: listed.filter((id): id is string => typeof id === "string"),
  };
}
