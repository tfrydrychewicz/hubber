import {
  CHECKS,
  type CheckGroup,
  type CheckResult,
  type CheckStatus,
  type DiagnosticsReport,
  type ReportMeta,
} from "./types.ts";

const STATUS_LABEL: Record<CheckStatus, string> = {
  confirmed: "OK",
  rejected: "ODRZUCONE",
  ineffective: "BEZ EFEKTU",
  error: "BŁĄD",
  skipped: "POMINIĘTE",
};

const GROUP_TITLE: Record<CheckGroup, string> = {
  core: "Rdzeń",
  optional: "Funkcje opcjonalne",
  info: "Informacyjne (bez wpływu na projekt)",
};

const LABEL_WIDTH = Math.max(...Object.values(STATUS_LABEL).map((label) => label.length)) + 2;
const INDENT = " ".repeat(2 + LABEL_WIDTH);

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

export function renderHeader(meta: ReportMeta): string {
  const endpoint = meta.endpoint ?? "(ukryty)";
  return [
    "Diagnostyka endpointu LLM",
    `  Endpoint:       ${endpoint}${meta.endpointIsDefault ? " (domyślny)" : ""}`,
    `  Model:          ${meta.model} (źródło: ${meta.modelSource})`,
    `  Poświadczenia:  ${meta.credentialSource}`,
    ...(meta.customHeaderNames.length > 0 ? [`  Nagłówki:       ${meta.customHeaderNames.join(", ")}`] : []),
  ].join("\n");
}

export function renderGroupTitle(group: CheckGroup): string {
  return `\n${GROUP_TITLE[group]}`;
}

export function renderResult(result: CheckResult): string {
  const timing = result.status === "skipped" ? "" : ` (${seconds(result.durationMs)})`;
  const lines = [
    `  ${STATUS_LABEL[result.status].padEnd(LABEL_WIDTH)}${result.title}${timing}`,
    `${INDENT}${result.detail}`,
  ];
  if (result.error?.hint) lines.push(`${INDENT}Wskazówka: ${result.error.hint}`);
  return lines.join("\n");
}

function yesNo(value: boolean): string {
  return value ? "tak" : "nie";
}

export function renderSummary(report: DiagnosticsReport): string {
  const ran = new Set(report.checks.map((check) => check.id));
  const partial = CHECKS.some((check) => !ran.has(check.id));
  const { capabilities, informational } = report.summary;
  const lines = [
    "\nPodsumowanie",
    `  Rdzeń:               ${report.summary.coreReady ? "gotowy" : "NIEGOTOWY"}`,
    `  Funkcje opcjonalne:  cache_control ${yesNo(capabilities.promptCache)}, effort ${yesNo(capabilities.effort)}, thinking ${yesNo(capabilities.thinking)}, PDF ${yesNo(capabilities.pdfInput)}`,
    `  Informacyjnie:       strict ${yesNo(informational.strictTools)}, structured outputs ${yesNo(informational.structuredOutput)}, lista modeli ${yesNo(informational.modelsList)}`,
  ];
  if (partial) lines.push("  Uruchomiono tylko część testów, więc podsumowanie jest niepełne.");
  const baseCall = report.checks.find((check) => check.id === "message");
  if (baseCall && baseCall.status !== "confirmed" && report.availableModels.length > 0) {
    lines.push(`  Modele dostępne na endpoincie: ${report.availableModels.join(", ")}`);
  }
  return lines.join("\n");
}
