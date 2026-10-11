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

  it("truncates very long messages", () => {
    const message = apiErrorMessage(apiError(400, anthropicBody("invalid_request_error", "x".repeat(5_000))));

    expect(message).toHaveLength(601);
    expect(message.endsWith("…")).toBe(true);
  });
});
