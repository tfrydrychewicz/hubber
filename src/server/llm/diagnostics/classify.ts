import Anthropic from "@anthropic-ai/sdk";
import type { CheckError, Redact } from "./types.ts";

const MAX_MESSAGE_LENGTH = 600;

const TLS_ERROR_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
]);

// fetch() wraps the socket error a few levels deep; the code is what tells
// DNS, refused connections and TLS trust problems apart.
function causeCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const asItIs: Redact = (text) => text;

// Cleaned first and cut afterwards. An endpoint may repeat the credential it was sent, and a
// cut through it would leave a part that no later cleaning can recognise.
function shorten(text: string, redact: Redact): string {
  const cleaned = redact(text);
  return cleaned.length > MAX_MESSAGE_LENGTH ? `${cleaned.slice(0, MAX_MESSAGE_LENGTH)}…` : cleaned;
}

/**
 * The endpoint's own error text. The SDK's `message` prefixes the status and
 * embeds the whole JSON body, which buries the one sentence that matters.
 * Gateways that wrap errors in their own envelope fall back to that form.
 */
export function apiErrorMessage(err: InstanceType<typeof Anthropic.APIError>, redact: Redact = asItIs): string {
  const body = err.error as { error?: { message?: unknown }; message?: unknown } | undefined;
  const text = body?.error?.message ?? body?.message;
  return shorten(typeof text === "string" && text ? text : err.message, redact);
}

function connectionHint(code: string | undefined): string {
  if (code && TLS_ERROR_CODES.has(code)) {
    return "Certyfikat endpointu nie jest zaufany. Ustaw NODE_EXTRA_CA_CERTS na plik z certyfikatem firmowego CA i uruchom ponownie.";
  }
  if (code === "ENOTFOUND")
    return "Nie znaleziono hosta. Sprawdź ANTHROPIC_BASE_URL oraz połączenie z siecią firmową lub VPN.";
  if (code === "ECONNREFUSED") return "Host odrzucił połączenie. Sprawdź adres i port w ANTHROPIC_BASE_URL.";
  return "Nie udało się połączyć z endpointem. Sprawdź adres, sieć i ewentualne proxy.";
}

function httpHint(status: number): string | undefined {
  if (status >= 300 && status < 400) {
    return "Endpoint odpowiedział przekierowaniem. Diagnostyka, tak jak aplikacja, nie podąża za przekierowaniami, bo wysłałaby dane i poświadczenia pod inny adres. Sprawdź adres w ANTHROPIC_BASE_URL.";
  }
  switch (status) {
    case 401:
      return "Endpoint nie przyjął poświadczeń. Sprawdź token lub klucz i sposób jego przekazania.";
    case 403:
      return "Poświadczenia nie mają dostępu do tego modelu lub endpointu.";
    case 404:
      return "Nieznany model albo błędna ścieżka endpointu. Podaj identyfikator modelu opcją --model.";
    case 413:
      return "Żądanie przekroczyło limit rozmiaru ustawiony na endpoincie.";
    case 429:
      return "Przekroczony limit zapytań. Spróbuj ponownie za chwilę.";
    default:
      return undefined;
  }
}

export interface ClassifiedError {
  status: "rejected" | "error";
  error: CheckError;
}

/**
 * Maps a thrown error to a check status. A 400/413/422 means the endpoint
 * refused this particular request shape; everything else says nothing about
 * the feature under test.
 */
export function classifyError(err: unknown, redact: Redact = asItIs): ClassifiedError {
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return {
      status: "error",
      error: {
        kind: "timeout",
        message: "Przekroczono limit czasu żądania.",
        hint: "Zwiększ limit opcją --timeout albo sprawdź obciążenie endpointu.",
      },
    };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    const code = causeCode(err);
    return {
      status: "error",
      error: {
        kind: "connection",
        message: shorten(code ? `${err.message} (${code})` : err.message, redact),
        hint: connectionHint(code),
      },
    };
  }
  if (err instanceof Anthropic.APIError && typeof err.status === "number") {
    const rejected = err.status === 400 || err.status === 413 || err.status === 422;
    const error: CheckError = {
      kind: "http",
      httpStatus: err.status,
      message: apiErrorMessage(err, redact),
    };
    if (err.type) error.type = err.type;
    if (err.requestID) error.requestId = err.requestID;
    const hint = httpHint(err.status);
    if (hint) error.hint = hint;
    return { status: rejected ? "rejected" : "error", error };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: "error", error: { kind: "other", message: shorten(message, redact) } };
}
