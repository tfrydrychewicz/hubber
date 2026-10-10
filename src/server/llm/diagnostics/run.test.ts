import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { createFakeEndpoint, type FakeBehavior } from "./fake-endpoint.ts";
import { runDiagnostics, type RunOptions } from "./run.ts";
import type { CheckId, CheckStatus, DiagnosticsReport, ReportMeta } from "./types.ts";

const META: ReportMeta = {
  endpoint: "http://router.test",
  endpointIsDefault: false,
  credentialSource: "ANTHROPIC_API_KEY",
  customHeaderNames: [],
  model: "test-model",
  modelSource: "--model",
  label: "router.test",
};

const CORE: CheckId[] = ["message", "streaming", "tool_use", "tool_error", "image_input"];

async function diagnose(behavior: FakeBehavior = {}, options: Partial<RunOptions> = {}) {
  const endpoint = createFakeEndpoint(behavior);
  const client = new Anthropic({ apiKey: "test-key", baseURL: "http://router.test", fetch: endpoint.fetch, maxRetries: 0 });
  const report = await runDiagnostics({ client, meta: META, nonce: "abc12345", sleep: async () => {}, ...options });
  return { report, endpoint };
}

function statuses(report: DiagnosticsReport): Partial<Record<CheckId, CheckStatus>> {
  return Object.fromEntries(report.checks.map((check) => [check.id, check.status]));
}

function check(report: DiagnosticsReport, id: CheckId) {
  const result = report.checks.find((candidate) => candidate.id === id);
  if (!result) throw new Error(`Check ${id} did not run`);
  return result;
}

describe("runDiagnostics", () => {
  it("confirms every check on a fully capable endpoint", async () => {
    const { report } = await diagnose({ thinkingBlocks: true });

    expect(new Set(Object.values(statuses(report)))).toEqual(new Set(["confirmed"]));
    expect(report.checks).toHaveLength(12);
    expect(report.summary).toEqual({
      coreReady: true,
      capabilities: { promptCache: true, effort: true, thinking: true, pdfInput: true },
      informational: { strictTools: true, structuredOutput: true, modelsList: true },
    });
    expect(report.availableModels).toEqual(["test-model"]);
    expect(check(report, "prompt_cache").observations).toMatchObject({ cacheReadTokens: 5000, requests: 2 });
    expect(check(report, "thinking").observations).toEqual({ thinkingBlocks: 1, replayChecked: true });
  });

  it("separates rejected and ineffective features on a restrictive gateway", async () => {
    const { report } = await diagnose({ reject: ["output_config", "strict"], cache: "ignored", models: "missing" });

    expect(statuses(report)).toMatchObject({
      message: "confirmed",
      streaming: "confirmed",
      tool_use: "confirmed",
      tool_error: "confirmed",
      image_input: "confirmed",
      prompt_cache: "ineffective",
      effort: "rejected",
      thinking: "confirmed",
      pdf_input: "confirmed",
      strict_tools: "rejected",
      structured_output: "rejected",
      models_list: "rejected",
    });
    expect(report.summary.coreReady).toBe(true);
    expect(report.summary.capabilities).toEqual({ promptCache: false, effort: false, thinking: true, pdfInput: true });
    expect(check(report, "effort").error).toMatchObject({
      kind: "http",
      httpStatus: 400,
      type: "invalid_request_error",
      requestId: "req_fake",
    });
    expect(check(report, "effort").detail).toContain("Extra inputs are not permitted");
  });

  it("keeps core requests within the stable API subset", async () => {
    const { endpoint } = await diagnose({}, { only: CORE });

    const bodies = endpoint.requests.map((request) => request.body);
    expect(bodies.length).toBeGreaterThanOrEqual(7);
    for (const body of bodies) {
      expect(Object.keys(body).sort()).toEqual(
        expect.arrayContaining(["max_tokens", "messages", "model"]),
      );
      expect(body).not.toHaveProperty("output_config");
      expect(body).not.toHaveProperty("thinking");
      expect(body).not.toHaveProperty("tool_choice");
      expect(JSON.stringify(body)).not.toContain("cache_control");
      for (const tool of body.tools ?? []) {
        expect(Object.keys(tool).sort()).toEqual(["description", "input_schema", "name"]);
      }
    }
  });

  it("passes assistant turns back untouched, thinking blocks included", async () => {
    const { endpoint } = await diagnose({ thinkingBlocks: true }, { only: ["tool_use"] });

    const followUp = endpoint.requests[1]?.body;
    expect(followUp.messages).toHaveLength(3);
    expect(followUp.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig-fake-0001" },
        { type: "tool_use", id: expect.any(String), name: "get_project_status", input: { project: "Atlas" } },
      ],
    });
    expect(followUp.messages[2].content[0]).toMatchObject({ type: "tool_result", content: "Status projektu: ZIELONY-abc12345" });
    // The tool definitions must not change between the turns of one conversation.
    expect(followUp.tools).toEqual(endpoint.requests[0]?.body.tools);
  });

  it("marks tool results as errors and lets the model correct the call", async () => {
    const { report, endpoint } = await diagnose({}, { only: ["tool_error"] });

    expect(check(report, "tool_error")).toMatchObject({
      status: "confirmed",
      detail: "Model poprawił wywołanie po błędzie narzędzia.",
      observations: { toolCalls: 2, errorsSent: 1 },
    });
    expect(endpoint.requests[1]?.body.messages[2].content[0]).toMatchObject({ type: "tool_result", is_error: true });
    expect(endpoint.requests[2]?.body.messages[4].content[0]).not.toHaveProperty("is_error");
  });

  it("distinguishes a model that ignores a tool error from an error that never arrived", async () => {
    const noRetry = await diagnose({ toolErrors: "no_retry" }, { only: ["tool_error"] });
    expect(check(noRetry.report, "tool_error")).toMatchObject({
      status: "confirmed",
      detail: "Błąd narzędzia dotarł do modelu; model nie ponowił wywołania.",
    });

    const lost = await diagnose({ toolErrors: "lost" }, { only: ["tool_error"] });
    expect(check(lost.report, "tool_error").status).toBe("ineffective");
  });

  it("skips everything except the model listing when the model is unknown", async () => {
    const { report } = await diagnose({ model: "router-opus" });

    expect(check(report, "message")).toMatchObject({ status: "error", error: { httpStatus: 404 } });
    expect(check(report, "message").error?.hint).toContain("--model");
    expect(check(report, "models_list").status).toBe("confirmed");
    const others = report.checks.filter((result) => result.id !== "message" && result.id !== "models_list");
    expect(others.every((result) => result.status === "skipped")).toBe(true);
    expect(others[0]?.detail).toBe("Pominięto, bo test „Zwykła wiadomość” nie przeszedł.");
    expect(report.summary.coreReady).toBe(false);
    expect(report.availableModels).toEqual(["router-opus"]);
  });

  it("reports invalid credentials as an error rather than a rejected feature", async () => {
    const { report } = await diagnose({ auth: "invalid" });

    expect(check(report, "message")).toMatchObject({ status: "error", error: { kind: "http", httpStatus: 401 } });
    expect(check(report, "models_list").status).toBe("error");
    expect(report.summary.coreReady).toBe(false);
  });

  it("detects an endpoint that buffers the stream", async () => {
    const { report } = await diagnose({ streaming: "buffered" }, { only: ["streaming"] });

    expect(check(report, "streaming")).toMatchObject({ status: "ineffective", observations: { textDeltas: 8 } });
  });

  it("detects tools dropped by the endpoint and skips the checks that need them", async () => {
    const { report } = await diagnose({ stripTools: true });

    expect(statuses(report)).toMatchObject({ tool_use: "ineffective", tool_error: "skipped", strict_tools: "skipped" });
    expect(report.summary.coreReady).toBe(false);
  });

  it("retries the cache read once before calling the cache ineffective", async () => {
    const sleep = vi.fn(async () => {});
    const { report } = await diagnose({ cache: "write_only" }, { only: ["prompt_cache"], sleep });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(check(report, "prompt_cache")).toMatchObject({
      status: "ineffective",
      detail: "Zapis do cache nastąpił, ale kolejne żądania go nie odczytały.",
      observations: { cacheWriteTokens: 5000, cacheReadTokens: 0, requests: 3 },
    });
  });

  it("sends a cache prefix long enough for every model's minimum", async () => {
    const { endpoint } = await diagnose({}, { only: ["prompt_cache"] });

    const system = endpoint.requests[0]?.body.system;
    expect(system).toHaveLength(1);
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(system[0].text.length).toBeGreaterThanOrEqual(24_000);
    expect(system[0].text.startsWith("[abc12345]")).toBe(true);
    expect(endpoint.requests[1]?.body.system).toEqual(system);
  });

  it("flags a gateway that invalidates replayed thinking blocks", async () => {
    const { report } = await diagnose({ thinkingBlocks: true, rejectThinkingReplay: true }, { only: ["thinking"] });

    expect(check(report, "thinking").status).toBe("ineffective");
    expect(check(report, "thinking").detail).toContain("bound to a different conversation");
    expect(report.summary.capabilities.thinking).toBe(false);
  });

  it("says so when no thinking block came back to replay", async () => {
    const { report } = await diagnose({}, { only: ["thinking"] });

    expect(check(report, "thinking")).toMatchObject({
      status: "confirmed",
      observations: { thinkingBlocks: 0, replayChecked: false },
    });
  });

  it("reports a rejected PDF block as an unavailable capability", async () => {
    const { report } = await diagnose({ reject: ["document"] }, { only: ["message", "pdf_input"] });

    expect(check(report, "pdf_input").status).toBe("rejected");
    expect(report.summary.capabilities.pdfInput).toBe(false);
  });

  it("runs a filtered check without its prerequisites and never calls a partial run ready", async () => {
    const { report, endpoint } = await diagnose({}, { only: ["effort"] });

    expect(statuses(report)).toEqual({ effort: "confirmed" });
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0]?.body.output_config).toEqual({ effort: "low" });
    expect(report.summary.coreReady).toBe(false);
  });

  it("honours skip and reports progress through the callbacks", async () => {
    const started: string[] = [];
    const done: string[] = [];
    const { report } = await diagnose(
      { stripTools: true },
      {
        skip: ["models_list", "pdf_input"],
        onCheckStart: (definition) => started.push(definition.id),
        onCheckDone: (result) => done.push(result.id),
      },
    );

    expect(done).toEqual(report.checks.map((result) => result.id));
    expect(done).not.toContain("models_list");
    expect(done).not.toContain("pdf_input");
    // Skipped checks are reported as done but never started.
    expect(started).not.toContain("tool_error");
    expect(done).toContain("tool_error");
  });
});
