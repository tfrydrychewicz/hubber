// Test double for an Anthropic Messages endpoint. It answers the diagnostic
// prompts the way a model would and can be told to misbehave like a gateway:
// reject fields, drop caching, buffer streams, strip tools.

export type RejectableField = "output_config" | "strict" | "thinking" | "cache_control" | "document";

export interface FakeBehavior {
  /** The only model id the endpoint serves. */
  model?: string;
  auth?: "ok" | "invalid";
  /** Request features answered with HTTP 400, as a gateway with a strict schema would. */
  reject?: RejectableField[];
  cache?: "works" | "ignored" | "write_only";
  streaming?: "incremental" | "buffered";
  models?: "listed" | "missing";
  /** Drop the tools array before the "model" sees it. */
  stripTools?: boolean;
  /** How the "model" reacts to an is_error tool result. */
  toolErrors?: "retry" | "no_retry" | "lost";
  /** Start every reply with a thinking block, as always-on thinking models do. */
  thinkingBlocks?: boolean;
  /** Fail any request that passes a thinking block back, as a body-rewriting gateway causes. */
  rejectThinkingReplay?: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Headers;
  body: any;
}

export interface FakeEndpoint {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  requests: RecordedRequest[];
}

type Json = Record<string, any>;

const THINKING_SIGNATURE = "sig-fake-0001";
const CACHED_TOKENS = 5_000;
const STREAM_DELTA_DELAY_MS = 20;

function errorResponse(status: number, type: string, message: string): Response {
  return Response.json({ type: "error", error: { type, message } }, { status, headers: { "request-id": "req_fake" } });
}

function blocksOf(message: Json | undefined): Json[] {
  if (!message) return [];
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content ?? []);
}

function resultText(result: Json): string {
  return typeof result.content === "string" ? result.content : blocksOf(result).map((block) => block.text ?? "").join(" ");
}

function hasCacheControl(body: Json): boolean {
  const system = Array.isArray(body.system) ? body.system : [];
  const tools: Json[] = body.tools ?? [];
  const messageBlocks = (body.messages as Json[]).flatMap((message) => blocksOf(message));
  return [...system, ...tools, ...messageBlocks].some((item: Json) => item.cache_control != null) || body.cache_control != null;
}

function rejectedField(body: Json, reject: RejectableField[]): string | undefined {
  const userBlocks = (body.messages as Json[]).flatMap((message) => blocksOf(message));
  const present: Record<RejectableField, boolean> = {
    output_config: body.output_config != null,
    strict: ((body.tools ?? []) as Json[]).some((tool) => "strict" in tool),
    thinking: body.thinking != null,
    cache_control: hasCacheControl(body),
    document: userBlocks.some((block) => block.type === "document"),
  };
  return reject.find((field) => present[field]);
}

function sse(event: Json): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function chunkText(text: string, parts: number): string[] {
  const size = Math.ceil(text.length / parts);
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

function streamResponse(message: Json, buffered: boolean): Response {
  const events: Array<{ payload: string; delayed: boolean }> = [];
  const push = (event: Json, delayed = false) => events.push({ payload: sse(event), delayed });

  push({ type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } });
  (message.content as Json[]).forEach((block, index) => {
    if (block.type === "text") {
      push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const text of chunkText(block.text, 8)) {
        push({ type: "content_block_delta", index, delta: { type: "text_delta", text } }, true);
      }
    } else if (block.type === "thinking") {
      push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
    } else {
      push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
      push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    push({ type: "content_block_stop", index });
  });
  push({ type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } });
  push({ type: "message_stop" });

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (buffered) {
        controller.enqueue(encoder.encode(events.map((event) => event.payload).join("")));
      } else {
        for (const event of events) {
          if (event.delayed) await new Promise((resolve) => setTimeout(resolve, STREAM_DELTA_DELAY_MS));
          controller.enqueue(encoder.encode(event.payload));
        }
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_fake" } });
}

export function createFakeEndpoint(behavior: FakeBehavior = {}): FakeEndpoint {
  const model = behavior.model ?? "test-model";
  const requests: RecordedRequest[] = [];
  const cachedPrefixes = new Set<string>();
  let messageCounter = 0;

  function reply(body: Json): { content: Json[]; stopReason: string } {
    const tools: Json[] = behavior.stripTools ? [] : (body.tools ?? []);
    const lastBlocks = blocksOf((body.messages as Json[]).at(-1));
    const toolResults = lastBlocks.filter((block) => block.type === "tool_result");
    const toolCall = (project: string) => ({
      content: [{ type: "tool_use", id: `toolu_fake_${++messageCounter}`, name: tools[0]?.name, input: { project } }],
      stopReason: "tool_use",
    });
    const text = (value: string) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });

    if (toolResults.length > 0) {
      const failed = toolResults.find((result) => result.is_error);
      if (failed && (behavior.toolErrors ?? "retry") === "retry" && tools.length > 0) return toolCall("Atlas 2");
      if (failed && behavior.toolErrors === "lost") return text("Nie udało się ustalić statusu.");
      return text(toolResults.map(resultText).join(" "));
    }
    if (tools.length > 0) return toolCall("Atlas");

    const document = lastBlocks.find((block) => block.type === "document");
    if (document) {
      // The fixture PDF is uncompressed, so its text is readable straight from the bytes.
      const pdf = Buffer.from(document.source.data, "base64").toString("latin1");
      return text(/Diagnostic code: ([A-Za-z0-9-]+)/.exec(pdf)?.[1] ?? "brak kodu");
    }
    if (lastBlocks.some((block) => block.type === "image")) return text("Red");
    if (body.output_config?.format) return text(JSON.stringify({ status: "ok", liczba: 7 }));
    if (body.stream) return text(Array.from({ length: 60 }, (_, i) => i + 1).join(" "));
    return text("gotowe");
  }

  function usage(body: Json): Json {
    const base = { input_tokens: 12, output_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const mode = behavior.cache ?? "works";
    if (mode === "ignored" || !hasCacheControl(body)) return base;
    const prefix = JSON.stringify(body.system ?? "");
    if (mode === "works" && cachedPrefixes.has(prefix)) return { ...base, cache_read_input_tokens: CACHED_TOKENS };
    cachedPrefixes.add(prefix);
    return { ...base, cache_creation_input_tokens: CACHED_TOKENS };
  }

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    const rawBody = request.method === "POST" ? await request.text() : "";
    const body: Json | undefined = rawBody ? JSON.parse(rawBody) : undefined;
    requests.push({ method: request.method, path, headers: request.headers, body });

    if (behavior.auth === "invalid") return errorResponse(401, "authentication_error", "invalid x-api-key");

    if (request.method === "GET" && path === "/v1/models") {
      if (behavior.models === "missing") return errorResponse(404, "not_found_error", "Not Found");
      return Response.json({
        data: [{ type: "model", id: model, display_name: "Test model", created_at: "2026-01-01T00:00:00Z" }],
        has_more: false,
        first_id: model,
        last_id: model,
      });
    }

    if (request.method !== "POST" || path !== "/v1/messages" || !body) {
      return errorResponse(404, "not_found_error", `Unknown route: ${request.method} ${path}`);
    }
    if (body.model !== model) return errorResponse(404, "not_found_error", `model: ${body.model}`);

    const rejected = rejectedField(body, behavior.reject ?? []);
    if (rejected) return errorResponse(400, "invalid_request_error", `${rejected}: Extra inputs are not permitted`);

    const replaysThinking = (body.messages as Json[]).some(
      (message) => message.role === "assistant" && blocksOf(message).some((block) => block.type === "thinking"),
    );
    if (behavior.rejectThinkingReplay && replaysThinking) {
      return errorResponse(
        400,
        "invalid_request_error",
        "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.",
      );
    }

    const { content, stopReason } = reply(body);
    const message = {
      id: `msg_fake_${++messageCounter}`,
      type: "message",
      role: "assistant",
      model,
      content: behavior.thinkingBlocks ? [{ type: "thinking", thinking: "", signature: THINKING_SIGNATURE }, ...content] : content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: usage(body),
    };
    if (body.stream) return streamResponse(message, behavior.streaming === "buffered");
    return Response.json(message, { headers: { "request-id": "req_fake" } });
  }

  return { fetch: handle, requests };
}
