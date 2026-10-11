import Anthropic from "@anthropic-ai/sdk";
import { apiErrorMessage } from "./classify.ts";
import { cacheFiller, codePdf, solidPng } from "./fixtures.ts";
import type { CheckId, CheckOutcome, Redact } from "./types.ts";

export interface CheckContext {
  client: Anthropic;
  model: string;
  maxTokens: number;
  // Unique per run, so cache entries and expected answers never collide across runs
  nonce: string;
  // Filled in by the models_list check for the report
  availableModels: string[];
  sleep: (ms: number) => Promise<void>;
  // For every text of the endpoint that a check quotes in part
  redact: Redact;
}

export type CheckFn = (ctx: CheckContext) => Promise<CheckOutcome>;

// Below this, all text deltas arrived in one burst: the endpoint buffered the response.
const BUFFERED_SPREAD_MS = 50;
// A cache entry can take a moment to become readable after the first response.
const CACHE_RETRY_DELAY_MS = 2_000;
const MAX_TOOL_TURNS = 4;
const MAX_LISTED_MODELS = 200;

const STATUS_TOOL: Anthropic.Tool = {
  name: "get_project_status",
  description: "Zwraca bieżący status projektu o podanej nazwie.",
  input_schema: {
    type: "object",
    properties: { project: { type: "string", description: "Nazwa projektu" } },
    required: ["project"],
  },
};

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function thinkingBlockCount(message: Anthropic.Message): number {
  return message.content.filter((block) => block.type === "thinking" || block.type === "redacted_thinking").length;
}

// Cleaned before anything else is done to it: the answer may repeat the credential, and what is
// left of one after the cut could not be recognised any more.
function preview(text: string, redact: Redact): string {
  const flat = redact(text).replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

// Classifier refusals and truncated replies arrive as HTTP 200, so they have
// to be ruled out before the content is trusted.
function unusable(message: Anthropic.Message): CheckOutcome | undefined {
  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category;
    return {
      status: "ineffective",
      detail: `Model odmówił odpowiedzi${category ? ` (kategoria: ${category})` : ""}.`,
    };
  }
  if (message.stop_reason === "max_tokens") {
    return { status: "ineffective", detail: "Odpowiedź została ucięta limitem max_tokens." };
  }
  return undefined;
}

interface ToolReply {
  content: string;
  isError?: boolean;
}

interface ToolConversation {
  final: Anthropic.Message;
  calls: Anthropic.ToolUseBlock[];
}

// Tool definitions here carry only name, description and input_schema, and the
// history is append-only with assistant content passed back untouched. That is
// the exact request shape the hub's agent loop will use.
async function runToolConversation(
  ctx: CheckContext,
  prompt: string,
  tools: Anthropic.Tool[],
  reply: (call: Anthropic.ToolUseBlock) => ToolReply,
): Promise<ToolConversation> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  const calls: Anthropic.ToolUseBlock[] = [];
  for (let turn = 1; ; turn++) {
    const message = await ctx.client.messages.create({
      model: ctx.model,
      max_tokens: ctx.maxTokens,
      tools,
      messages,
    });
    const uses = message.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
    if (message.stop_reason !== "tool_use" || uses.length === 0 || turn === MAX_TOOL_TURNS) {
      return { final: message, calls };
    }
    calls.push(...uses);
    messages.push({ role: "assistant", content: message.content });
    messages.push({
      role: "user",
      content: uses.map((use): Anthropic.ToolResultBlockParam => {
        const { content, isError } = reply(use);
        return { type: "tool_result", tool_use_id: use.id, content, ...(isError ? { is_error: true } : {}) };
      }),
    });
  }
}

function requestedProject(call: Anthropic.ToolUseBlock): string {
  const project = (call.input as { project?: unknown } | null)?.project;
  return typeof project === "string" ? project : "";
}

const message: CheckFn = async (ctx) => {
  const response = await ctx.client.messages.create({
    model: ctx.model,
    max_tokens: ctx.maxTokens,
    messages: [{ role: "user", content: "Odpowiedz dokładnie jednym słowem: gotowe" }],
  });
  const blocked = unusable(response);
  if (blocked) return blocked;
  const text = textOf(response);
  if (!text) return { status: "ineffective", detail: "Odpowiedź nie zawiera tekstu." };
  return {
    status: "confirmed",
    detail: `Model odpowiedział: „${preview(text, ctx.redact)}”.`,
    observations: {
      reportedModel: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      thinkingBlocks: thinkingBlockCount(response),
    },
  };
};

const streaming: CheckFn = async (ctx) => {
  const started = performance.now();
  let deltas = 0;
  let first: number | undefined;
  let last = started;
  const stream = ctx.client.messages.stream({
    model: ctx.model,
    max_tokens: ctx.maxTokens,
    messages: [{ role: "user", content: "Wypisz liczby od 1 do 60 oddzielone spacjami. Nic więcej." }],
  });
  stream.on("text", () => {
    last = performance.now();
    first ??= last;
    deltas += 1;
  });
  const response = await stream.finalMessage();
  const blocked = unusable(response);
  if (blocked) return blocked;

  const spread = first === undefined ? 0 : last - first;
  const observations = {
    textDeltas: deltas,
    firstDeltaMs: first === undefined ? null : Math.round(first - started),
    streamSpreadMs: Math.round(spread),
    totalMs: Math.round(performance.now() - started),
  };
  if (deltas < 2 || spread < BUFFERED_SPREAD_MS) {
    return {
      status: "ineffective",
      detail: "Odpowiedź dotarła w jednym kawałku: endpoint prawdopodobnie buforuje strumień.",
      observations,
    };
  }
  return {
    status: "confirmed",
    detail: `Odebrano ${deltas} fragmentów tekstu w ciągu ${Math.round(spread)} ms.`,
    observations,
  };
};

const toolUse: CheckFn = async (ctx) => {
  const token = `ZIELONY-${ctx.nonce}`;
  const { final, calls } = await runToolConversation(
    ctx,
    "Sprawdź status projektu Atlas narzędziem get_project_status, a potem podaj ten status dosłownie.",
    [STATUS_TOOL],
    () => ({ content: `Status projektu: ${token}` }),
  );
  const blocked = unusable(final);
  if (blocked) return blocked;
  const observations = { toolCalls: calls.length, thinkingBlocks: thinkingBlockCount(final) };
  if (calls.length === 0) {
    return {
      status: "ineffective",
      detail: "Model nie wywołał narzędzia; endpoint mógł pominąć pole tools.",
      observations,
    };
  }
  if (!textOf(final).includes(token)) {
    return {
      status: "ineffective",
      detail: "Model wywołał narzędzie, ale jego wynik nie pojawił się w odpowiedzi.",
      observations,
    };
  }
  return { status: "confirmed", detail: "Wywołanie narzędzia i odesłanie wyniku działają.", observations };
};

const toolError: CheckFn = async (ctx) => {
  const token = `ZOLTY-${ctx.nonce}`;
  let errorsSent = 0;
  const { final, calls } = await runToolConversation(
    ctx,
    "Sprawdź status projektu Atlas narzędziem get_project_status. Jeśli narzędzie zwróci błąd, popraw wywołanie zgodnie z komunikatem i podaj status dosłownie.",
    [STATUS_TOOL],
    (call) => {
      if (/atlas\s*2/i.test(requestedProject(call))) return { content: `Status projektu: ${token}` };
      errorsSent += 1;
      return { content: "Nie znaleziono projektu „Atlas”. Istnieje projekt „Atlas 2”.", isError: true };
    },
  );
  const blocked = unusable(final);
  if (blocked) return blocked;
  const observations = { toolCalls: calls.length, errorsSent };
  if (errorsSent === 0) {
    return {
      status: "ineffective",
      detail: "Nie doszło do wysłania wyniku z błędem: model nie wywołał narzędzia zgodnie z poleceniem.",
      observations,
    };
  }
  const text = textOf(final);
  if (text.includes(token)) {
    return { status: "confirmed", detail: "Model poprawił wywołanie po błędzie narzędzia.", observations };
  }
  if (/atlas\s*2/i.test(text)) {
    return {
      status: "confirmed",
      detail: "Błąd narzędzia dotarł do modelu; model nie ponowił wywołania.",
      observations,
    };
  }
  return {
    status: "ineffective",
    detail: "Endpoint przyjął wynik z błędem, ale jego treść nie dotarła do modelu.",
    observations,
  };
};

const imageInput: CheckFn = async (ctx) => {
  const png = solidPng(96, [220, 20, 20]);
  const response = await ctx.client.messages.create({
    model: ctx.model,
    max_tokens: ctx.maxTokens,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
          { type: "text", text: "Jaki kolor ma ten obraz? Odpowiedz jednym słowem po angielsku." },
        ],
      },
    ],
  });
  const blocked = unusable(response);
  if (blocked) return blocked;
  const text = textOf(response);
  if (!/\bred\b|crimson|scarlet|czerwon/i.test(text)) {
    return {
      status: "ineffective",
      detail: `Obraz nie został odczytany poprawnie. Odpowiedź: „${preview(text, ctx.redact)}”.`,
    };
  }
  return { status: "confirmed", detail: "Model poprawnie rozpoznał kolor obrazu testowego." };
};

const promptCache: CheckFn = async (ctx) => {
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: cacheFiller(ctx.nonce), cache_control: { type: "ephemeral" } },
  ];
  const send = () =>
    ctx.client.messages.create({
      model: ctx.model,
      max_tokens: ctx.maxTokens,
      system,
      messages: [{ role: "user", content: "Odpowiedz jednym słowem: ok" }],
    });

  const first = await send();
  let second = await send();
  let requests = 2;
  if (!second.usage.cache_read_input_tokens) {
    await ctx.sleep(CACHE_RETRY_DELAY_MS);
    second = await send();
    requests = 3;
  }
  const written = first.usage.cache_creation_input_tokens ?? 0;
  const read = Math.max(first.usage.cache_read_input_tokens ?? 0, second.usage.cache_read_input_tokens ?? 0);
  const observations = { cacheWriteTokens: written, cacheReadTokens: read, requests };
  if (read > 0) {
    return { status: "confirmed", detail: `Kolejne żądanie odczytało z cache ${read} tokenów.`, observations };
  }
  if (written > 0) {
    return {
      status: "ineffective",
      detail: "Zapis do cache nastąpił, ale kolejne żądania go nie odczytały.",
      observations,
    };
  }
  return {
    status: "ineffective",
    detail: "Żądanie przyjęte, ale bez aktywności cache: endpoint pomija cache_control.",
    observations,
  };
};

const effort: CheckFn = async (ctx) => {
  const response = await ctx.client.messages.create({
    model: ctx.model,
    max_tokens: ctx.maxTokens,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: "Odpowiedz jednym słowem: ok" }],
  });
  const blocked = unusable(response);
  if (blocked) return blocked;
  return { status: "confirmed", detail: "Endpoint przyjął output_config.effort." };
};

const thinking: CheckFn = async (ctx) => {
  const question: Anthropic.MessageParam = {
    role: "user",
    content:
      "Mam trzy terminy w tym samym roku: 14 marca, 2 lutego i 27 stycznia. Który jest najwcześniejszy? Odpowiedz jednym zdaniem.",
  };
  const first = await ctx.client.messages.create({
    model: ctx.model,
    max_tokens: ctx.maxTokens,
    thinking: { type: "adaptive" },
    messages: [question],
  });
  const blocked = unusable(first);
  if (blocked) return blocked;

  // The second request passes the assistant turn back untouched. An endpoint
  // that rewrites request bodies invalidates the thinking signatures here.
  const blocks = thinkingBlockCount(first);
  const observations = { thinkingBlocks: blocks, replayChecked: blocks > 0 };
  try {
    await ctx.client.messages.create({
      model: ctx.model,
      max_tokens: ctx.maxTokens,
      thinking: { type: "adaptive" },
      messages: [
        question,
        { role: "assistant", content: first.content },
        { role: "user", content: "A który jest najpóźniejszy?" },
      ],
    });
  } catch (err) {
    if (!(err instanceof Anthropic.BadRequestError)) throw err;
    return {
      status: "ineffective",
      detail: `Pole thinking przyjęte, ale odesłanie historii z blokami rozumowania zostało odrzucone: ${apiErrorMessage(err, ctx.redact)}`,
      observations,
    };
  }
  return {
    status: "confirmed",
    detail:
      blocks > 0
        ? `Pole thinking przyjęte; historia z blokami rozumowania (${blocks}) odesłana bez błędu.`
        : "Pole thinking przyjęte; model nie zwrócił bloków rozumowania, więc ich odsyłanie nie zostało sprawdzone.",
    observations,
  };
};

const pdfInput: CheckFn = async (ctx) => {
  const code = `HUBBER-${ctx.nonce.toUpperCase()}`;
  const pdf = codePdf(code);
  const response = await ctx.client.messages.create({
    model: ctx.model,
    max_tokens: ctx.maxTokens,
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } },
          { type: "text", text: "Jaki kod diagnostyczny zawiera ten dokument? Odpowiedz samym kodem." },
        ],
      },
    ],
  });
  const blocked = unusable(response);
  if (blocked) return blocked;
  const text = textOf(response);
  if (!text.toUpperCase().includes(code)) {
    return {
      status: "ineffective",
      detail: `Model nie odczytał treści PDF. Odpowiedź: „${preview(text, ctx.redact)}”.`,
    };
  }
  return { status: "confirmed", detail: "Model odczytał treść dokumentu PDF." };
};

const strictTools: CheckFn = async (ctx) => {
  const response = await ctx.client.messages.create({
    model: ctx.model,
    max_tokens: ctx.maxTokens,
    tools: [
      {
        ...STATUS_TOOL,
        strict: true,
        input_schema: { ...STATUS_TOOL.input_schema, additionalProperties: false },
      },
    ],
    messages: [{ role: "user", content: "Sprawdź status projektu Atlas narzędziem get_project_status." }],
  });
  const blocked = unusable(response);
  if (blocked) return blocked;
  return {
    status: "confirmed",
    detail: "Endpoint przyjął narzędzie z polem strict.",
    observations: { toolCalled: response.content.some((block) => block.type === "tool_use") },
  };
};

const structuredOutput: CheckFn = async (ctx) => {
  const response = await ctx.client.messages.create({
    model: ctx.model,
    max_tokens: ctx.maxTokens,
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { status: { type: "string", enum: ["ok"] }, liczba: { type: "integer" } },
          required: ["status", "liczba"],
          additionalProperties: false,
        },
      },
    },
    messages: [{ role: "user", content: "Zwróć status ok i liczbę 7." }],
  });
  const blocked = unusable(response);
  if (blocked) return blocked;
  const text = textOf(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if ((parsed as { status?: unknown } | undefined)?.status !== "ok") {
    return {
      status: "ineffective",
      detail: `Endpoint przyjął output_config.format, ale odpowiedź nie jest zgodna ze schematem: „${preview(text, ctx.redact)}”.`,
    };
  }
  return { status: "confirmed", detail: "Odpowiedź jest zgodna z zadanym schematem JSON." };
};

const modelsList: CheckFn = async (ctx) => {
  const ids: string[] = [];
  try {
    for await (const model of ctx.client.models.list({ limit: 100 })) {
      ids.push(model.id);
      if (ids.length >= MAX_LISTED_MODELS) break;
    }
  } catch (err) {
    // Many gateways simply do not route /v1/models; that is a missing feature, not a failure.
    if (err instanceof Anthropic.APIError && [404, 405, 501].includes(err.status ?? 0)) {
      return { status: "rejected", detail: "Endpoint nie udostępnia listy modeli (/v1/models)." };
    }
    throw err;
  }
  ctx.availableModels.push(...ids);
  if (ids.length === 0) return { status: "ineffective", detail: "Endpoint zwrócił pustą listę modeli." };
  return {
    status: "confirmed",
    detail: `Liczba modeli na liście: ${ids.length}.`,
    observations: { count: ids.length, includesRequestedModel: ids.includes(ctx.model) },
  };
};

export const CHECK_FUNCTIONS: Record<CheckId, CheckFn> = {
  message,
  streaming,
  tool_use: toolUse,
  tool_error: toolError,
  image_input: imageInput,
  prompt_cache: promptCache,
  effort,
  thinking,
  pdf_input: pdfInput,
  strict_tools: strictTools,
  structured_output: structuredOutput,
  models_list: modelsList,
};
