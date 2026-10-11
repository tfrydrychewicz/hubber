import { randomBytes } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { VERSION as SDK_VERSION } from "@anthropic-ai/sdk/version";
import { CHECK_FUNCTIONS, type CheckContext } from "./checks.ts";
import { classifyError } from "./classify.ts";
import {
  CHECKS,
  type CheckId,
  type CheckResult,
  type DiagnosticsReport,
  type Redact,
  type ReportMeta,
} from "./types.ts";

// Thinking counts toward max_tokens, so even one-word answers need headroom.
const DEFAULT_MAX_TOKENS = 16_000;

type CheckDefinition = (typeof CHECKS)[number];

export interface RunOptions {
  client: Anthropic;
  meta: ReportMeta;
  only?: readonly CheckId[];
  skip?: readonly CheckId[];
  maxTokens?: number;
  nonce?: string;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Takes the credentials of the run out of a text. Applied to whatever the endpoint said before
   * a check or an error shortens it; without it the texts are taken as they are.
   */
  redact?: Redact;
  onCheckStart?: (check: CheckDefinition) => void;
  onCheckDone?: (result: CheckResult) => void;
}

// A failed prerequisite makes the dependent result meaningless, so it is skipped.
// The model listing is the one check that does not need a working message call.
const EXTRA_PREREQUISITES: Partial<Record<CheckId, readonly CheckId[]>> = {
  tool_error: ["tool_use"],
  strict_tools: ["tool_use"],
};

function prerequisites(id: CheckId): readonly CheckId[] {
  if (id === "message" || id === "models_list") return [];
  return ["message", ...(EXTRA_PREREQUISITES[id] ?? [])];
}

function titleOf(id: CheckId): string {
  return CHECKS.find((check) => check.id === id)?.title ?? id;
}

export async function runDiagnostics(options: RunOptions): Promise<DiagnosticsReport> {
  const startedAt = new Date();
  const started = performance.now();
  const ctx: CheckContext = {
    client: options.client,
    model: options.meta.model,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    nonce: options.nonce ?? randomBytes(4).toString("hex"),
    availableModels: [],
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    redact: options.redact ?? ((text) => text),
  };

  const selected = CHECKS.filter(
    (check) => (!options.only || options.only.includes(check.id)) && !options.skip?.includes(check.id),
  );
  const results = new Map<CheckId, CheckResult>();

  for (const check of selected) {
    // Only a prerequisite that actually ran and failed blocks; one filtered out by --only does not.
    const blocker = prerequisites(check.id).find((id) => {
      const status = results.get(id)?.status;
      return status !== undefined && status !== "confirmed";
    });

    let result: CheckResult;
    if (blocker) {
      result = {
        ...check,
        status: "skipped",
        durationMs: 0,
        detail: `Pominięto, bo test „${titleOf(blocker)}” nie przeszedł.`,
      };
    } else {
      options.onCheckStart?.(check);
      const checkStarted = performance.now();
      try {
        const outcome = await CHECK_FUNCTIONS[check.id](ctx);
        result = { ...check, ...outcome, durationMs: Math.round(performance.now() - checkStarted) };
      } catch (err) {
        const { status, error } = classifyError(err, ctx.redact);
        result = {
          ...check,
          status,
          durationMs: Math.round(performance.now() - checkStarted),
          detail: error.message,
          error,
        };
      }
    }
    results.set(check.id, result);
    options.onCheckDone?.(result);
  }

  const confirmed = (id: CheckId) => results.get(id)?.status === "confirmed";
  return {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    durationMs: Math.round(performance.now() - started),
    meta: options.meta,
    runtime: { node: process.version, platform: `${process.platform}-${process.arch}`, sdk: SDK_VERSION },
    summary: {
      // Requires every core check to have run; a partial run never reports the core as ready.
      coreReady: CHECKS.filter((check) => check.group === "core").every((check) => confirmed(check.id)),
      capabilities: {
        promptCache: confirmed("prompt_cache"),
        effort: confirmed("effort"),
        thinking: confirmed("thinking"),
        pdfInput: confirmed("pdf_input"),
      },
      informational: {
        strictTools: confirmed("strict_tools"),
        structuredOutput: confirmed("structured_output"),
        modelsList: confirmed("models_list"),
      },
    },
    availableModels: ctx.availableModels,
    checks: [...results.values()],
  };
}
