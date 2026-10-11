import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { apiErrorMessage, classifyError } from "./classify.ts";

function apiError(status: number, body: object, headers: Record<string, string> = {}) {
  return Anthropic.APIError.generate(status, body, undefined, new Headers(headers));
}

const anthropicBody = (type: string, message: string) => ({ type: "error", error: { type, message } });

describe("classifyError", () => {
  it.each([400, 413, 422])("treats HTTP %i as the endpoint rejecting the request shape", (status) => {
    const result = classifyError(
      apiError(status, anthropicBody("invalid_request_error", "strict: Extra inputs are not permitted")),
    );

    expect(result.status).toBe("rejected");
    expect(result.error).toMatchObject({
      kind: "http",
      httpStatus: status,
      message: "strict: Extra inputs are not permitted",
    });
  });

  it.each([401, 403, 404, 429, 500, 529])("treats HTTP %i as unrelated to the feature under test", (status) => {
    expect(classifyError(apiError(status, anthropicBody("api_error", "nope"))).status).toBe("error");
  });

  it("keeps the error type and request id, and adds a hint where one helps", () => {
    const { error } = classifyError(
      apiError(404, anthropicBody("not_found_error", "model: router-opus"), { "request-id": "req_123" }),
    );

    expect(error).toMatchObject({ type: "not_found_error", requestId: "req_123", message: "model: router-opus" });
    expect(error.hint).toContain("--model");
    expect(classifyError(apiError(500, anthropicBody("api_error", "boom"))).error.hint).toBeUndefined();
  });

  it("explains an untrusted certificate", () => {
    const cause = Object.assign(new Error("fetch failed"), {
      cause: Object.assign(new Error("self-signed certificate in certificate chain"), {
        code: "SELF_SIGNED_CERT_IN_CHAIN",
      }),
    });
    const { status, error } = classifyError(new Anthropic.APIConnectionError({ cause }));

    expect(status).toBe("error");
    expect(error.kind).toBe("connection");
    expect(error.message).toContain("SELF_SIGNED_CERT_IN_CHAIN");
    expect(error.hint).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("explains an unknown host and a refused connection", () => {
    const withCode = (code: string) =>
      classifyError(new Anthropic.APIConnectionError({ cause: Object.assign(new Error("fetch failed"), { code }) }))
        .error.hint;

    expect(withCode("ENOTFOUND")).toContain("ANTHROPIC_BASE_URL");
    expect(withCode("ECONNREFUSED")).toContain("port");
    expect(withCode("EPIPE")).toContain("proxy");
  });

  it("reports a timeout as its own kind", () => {
    const { status, error } = classifyError(new Anthropic.APIConnectionTimeoutError());

    expect(status).toBe("error");
    expect(error.kind).toBe("timeout");
    expect(error.hint).toContain("--timeout");
  });

  it.each([301, 302, 303, 307, 308])("explains that a redirect (%i) is not followed", (status) => {
    const { status: outcome, error } = classifyError(apiError(status, {}));

    expect(outcome).toBe("error");
    expect(error).toMatchObject({ kind: "http", httpStatus: status });
    expect(error.hint).toBe(
      "Endpoint odpowiedział przekierowaniem. Diagnostyka, tak jak aplikacja, nie podąża za przekierowaniami, bo wysłałaby dane i poświadczenia pod inny adres. Sprawdź adres w ANTHROPIC_BASE_URL.",
    );
  });

  // The secret is longer than what is left of the limit after the text in front of it, so the
  // cut falls inside it: cleaned only after the cut, its beginning would stay.
  describe("with a function that takes the credentials out", () => {
    const SECRET = "planted-credential-".repeat(12);
    const redact = (text: string) => text.replaceAll(SECRET, "[ukryte]");
    const long = `${"y".repeat(560)} refused: ${SECRET} is not valid`;
    const cleaned = `${"y".repeat(560)} refused: [ukryte] is not valid`;

    it("cleans the text of an HTTP error before it cuts it short", () => {
      const { error } = classifyError(apiError(401, anthropicBody("authentication_error", long)), redact);

      expect(error.message).toBe(cleaned);
      expect(error.message).not.toContain("planted");
    });

    it("cleans the text of a connection error and of any other error before it cuts it short", () => {
      const connection = classifyError(new Anthropic.APIConnectionError({ message: long }), redact);
      // As when the SDK cannot send a header value: its message quotes the value.
      const other = classifyError(new Error(long), redact);

      expect(connection.error).toMatchObject({ kind: "connection", message: cleaned });
      expect(other.error).toEqual({ kind: "other", message: cleaned });
    });

    it("still cuts short what is long after the cleaning", () => {
      const { error } = classifyError(new Error(`${SECRET}${"x".repeat(5_000)}`), redact);

      expect(error.message).toBe(`[ukryte]${"x".repeat(592)}…`);
    });
  });

  it("falls back to the plain message for anything else", () => {
    expect(classifyError(new Error("Could not resolve authentication method"))).toEqual({
      status: "error",
      error: { kind: "other", message: "Could not resolve authentication method" },
    });
    expect(classifyError("boom").error.message).toBe("boom");
  });
});

describe("apiErrorMessage", () => {
  it("reads the message from a gateway's own error envelope", () => {
    expect(apiErrorMessage(apiError(400, { message: "field output_config is not allowed" }))).toBe(
      "field output_config is not allowed",
    );
  });

  it("falls back to the SDK message when the body has no message", () => {
    expect(apiErrorMessage(apiError(400, { detail: [{ loc: ["body", "strict"] }] }))).toContain("strict");
  });

  it("cleans the message with the given function before it cuts it short", () => {
    const secret = "planted-credential-".repeat(12);
    const error = apiError(400, anthropicBody("invalid_request_error", `${"y".repeat(560)} ${secret} was sent`));

    const message = apiErrorMessage(error, (text) => text.replaceAll(secret, "[ukryte]"));

    expect(message).toBe(`${"y".repeat(560)} [ukryte] was sent`);
  });

  it("truncates very long messages", () => {
    const message = apiErrorMessage(apiError(400, anthropicBody("invalid_request_error", "x".repeat(5_000))));

    expect(message).toHaveLength(601);
    expect(message.endsWith("…")).toBe(true);
  });
});
