// Core checks cover the stable API subset the hub depends on. Optional checks
// gate features the app turns on only when confirmed. Info checks are recorded
// for reference and never influence the design (see docs/PLAN.md, M1a-1).
export const CHECKS = [
  { id: "message", group: "core", title: "Zwykła wiadomość" },
  { id: "streaming", group: "core", title: "Strumieniowanie" },
  { id: "tool_use", group: "core", title: "Wywołanie narzędzia" },
  { id: "tool_error", group: "core", title: "Wynik narzędzia z błędem" },
  { id: "image_input", group: "core", title: "Wejście obrazowe" },
  { id: "prompt_cache", group: "optional", title: "Cache promptów (cache_control)" },
  { id: "effort", group: "optional", title: "Poziom wysiłku (effort)" },
  { id: "thinking", group: "optional", title: "Rozumowanie (thinking)" },
  { id: "pdf_input", group: "optional", title: "Wejście PDF" },
  { id: "strict_tools", group: "info", title: "Narzędzia strict" },
  { id: "structured_output", group: "info", title: "Structured outputs" },
  { id: "models_list", group: "info", title: "Lista modeli" },
] as const;

export type CheckId = (typeof CHECKS)[number]["id"];
export type CheckGroup = (typeof CHECKS)[number]["group"];

export const CHECK_IDS: readonly CheckId[] = CHECKS.map((check) => check.id);

// confirmed   - the feature works end to end
// rejected    - the endpoint refused the request shape (HTTP 400/413/422)
// ineffective - the request was accepted but the feature had no observable effect
// error       - a failure unrelated to the feature: network, auth, rate limit, 5xx
// skipped     - not run because a check it depends on did not pass
export type CheckStatus = "confirmed" | "rejected" | "ineffective" | "error" | "skipped";

export type Observations = Record<string, string | number | boolean | null>;

export interface CheckError {
  kind: "http" | "connection" | "timeout" | "other";
  message: string;
  httpStatus?: number;
  type?: string;
  requestId?: string;
  hint?: string;
}

export interface CheckOutcome {
  status: Exclude<CheckStatus, "skipped" | "error">;
  detail: string;
  observations?: Observations;
}

export interface CheckResult {
  id: CheckId;
  group: CheckGroup;
  title: string;
  status: CheckStatus;
  durationMs: number;
  detail: string;
  observations?: Observations;
  error?: CheckError;
}

export type CredentialSource =
  | "ANTHROPIC_API_KEY"
  | "ANTHROPIC_AUTH_TOKEN"
  | "credential-command"
  | "apiKeyHelper"
  | "custom-headers"
  | "sdk-default";

export interface ReportMeta {
  // null when the endpoint was redacted on request
  endpoint: string | null;
  endpointIsDefault: boolean;
  credentialSource: CredentialSource;
  customHeaderNames: string[];
  model: string;
  modelSource: string;
  label: string;
}

export interface DiagnosticsReport {
  schemaVersion: 1;
  startedAt: string;
  durationMs: number;
  meta: ReportMeta;
  runtime: { node: string; platform: string; sdk: string };
  summary: {
    coreReady: boolean;
    capabilities: {
      promptCache: boolean;
      effort: boolean;
      thinking: boolean;
      pdfInput: boolean;
    };
    informational: {
      strictTools: boolean;
      structuredOutput: boolean;
      modelsList: boolean;
    };
  };
  // Model ids reported by the endpoint, when it exposes /v1/models
  availableModels: string[];
  checks: CheckResult[];
}
