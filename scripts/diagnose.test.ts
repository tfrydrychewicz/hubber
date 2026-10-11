import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakeEndpoint,
  type FakeBehavior,
  type FakeEndpoint,
} from "../src/server/llm/diagnostics/fake-endpoint.ts";
import { spawnNode } from "../src/server/testing.ts";

const SPAWN_TIMEOUT_MS = 30_000;

const children: ChildProcess[] = [];
const servers: Server[] = [];
let workDir: string | undefined;

afterEach(async () => {
  // A run that outlived its test: the test timeout ended the wait for it, not the process.
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = undefined;
});

// The script builds its own client, so it needs a real socket to talk to.
async function listen(answer: (request: Request) => Promise<Response>): Promise<string> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const response = await answer(
      new Request(`http://fake${req.url}`, {
        method: req.method ?? "GET",
        headers,
        ...(chunks.length > 0 && { body: Buffer.concat(chunks) }),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function serve(behavior: FakeBehavior = {}): Promise<{ url: string; endpoint: FakeEndpoint }> {
  const endpoint = createFakeEndpoint(behavior);
  return { url: await listen(endpoint.fetch), endpoint };
}

/**
 * A gateway that repeats the credential it was sent, the way some do. By default it refuses the
 * credential and repeats it in the error, as it was sent and as a URL would hold it, after
 * `lead` characters of other text. With `accept` it answers like a model that repeats it.
 */
function serveEchoing({ lead = 0, accept = false } = {}): Promise<string> {
  return listen(async (request) => {
    const presented = request.headers.get("authorization") ?? request.headers.get("x-api-key") ?? "";
    if (accept) {
      return Response.json({
        id: "msg_echo",
        type: "message",
        role: "assistant",
        model: "test-model",
        content: [{ type: "text", text: `gotowe ${presented}` }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    const message = `${"y".repeat(lead)}Invalid credential: ${presented} (${encodeURIComponent(presented)})`;
    return Response.json(
      { type: "error", error: { type: "authentication_error", message } },
      { status: 401, headers: { "request-id": "req_echo" } },
    );
  });
}

// Made up for each run, so that a finding can only come from this run. No fixed beginning: one
// of the tests looks for the first characters alone.
const plantedSecret = () => randomBytes(24).toString("hex");

function tempDir(): string {
  workDir = mkdtempSync(join(tmpdir(), "hubber-diagnose-"));
  return workDir;
}

interface RunResult {
  /** Null when a signal ended the run. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Everything the script wrote. Handed to the assertions on the exit code, which by itself explains nothing. */
  output: string;
}

// spawnNode() builds the environment from scratch, so the developer's own ANTHROPIC_* variables never leak in.
// Nor does HOME: the SDK looks for credential profiles under the home directory.
async function diagnose(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  const script = spawnNode("scripts/diagnose.ts", { args, env });
  children.push(script.child);
  const { code } = await script.exited;
  return { code, stdout: script.stdout(), stderr: script.stderr(), output: `${script.stdout()}${script.stderr()}` };
}

describe("scripts/diagnose.ts", { timeout: SPAWN_TIMEOUT_MS }, () => {
  it("runs every check, prints a summary and writes a report without secrets", async () => {
    const { url, endpoint } = await serve();
    const out = join(tempDir(), "nested", "report.json");

    const result = await diagnose(["--model", "test-model", "--out", out], {
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_API_KEY: "test-key-123",
    });

    expect(result.stderr).toBe("");
    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain(`Endpoint:       ${url}`);
    expect(result.stdout).toContain("Rdzeń:               gotowy");
    expect(result.stdout).toContain(`Raport: ${out}`);
    // Group titles appear once each, in order.
    expect(result.stdout.indexOf("\nRdzeń\n")).toBeLessThan(result.stdout.indexOf("\nFunkcje opcjonalne\n"));

    const raw = readFileSync(out, "utf8");
    const report = JSON.parse(raw);
    expect(report.summary.coreReady).toBe(true);
    expect(report.meta).toMatchObject({ endpoint: url, model: "test-model", credentialSource: "ANTHROPIC_API_KEY" });
    expect(report.checks).toHaveLength(12);
    expect(raw).not.toContain("test-key-123");
    expect(endpoint.requests.every((request) => request.headers.get("x-api-key") === "test-key-123")).toBe(true);
  });

  it("takes the connection from a Claude Code settings file and ignores the shell's", async () => {
    const { url, endpoint } = await serve();
    const settingsPath = join(tempDir(), "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: url,
          ANTHROPIC_AUTH_TOKEN: "corp-token",
          ANTHROPIC_CUSTOM_HEADERS: "X-Team: platform",
          ANTHROPIC_MODEL: "test-model",
          CLAUDE_CODE_USE_BEDROCK: "",
          CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
        },
      }),
    );

    const result = await diagnose(["--claude-settings", settingsPath, "--only", "message", "--no-file", "--json"], {
      ANTHROPIC_API_KEY: "personal-key",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
      ANTHROPIC_CUSTOM_HEADERS: "X-Personal: 1",
    });

    expect(result.code, result.output).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.meta).toMatchObject({ credentialSource: "ANTHROPIC_AUTH_TOKEN", customHeaderNames: ["X-Team"] });
    expect(report.checks.map((check: { id: string }) => check.id)).toEqual(["message"]);

    expect(endpoint.requests).toHaveLength(1);
    const headers = endpoint.requests[0]?.headers;
    expect(headers?.get("authorization")).toBe("Bearer corp-token");
    expect(headers?.get("x-team")).toBe("platform");
    expect(headers?.get("x-api-key")).toBeNull();
    expect(headers?.get("x-personal")).toBeNull();
  });

  it("sends a credential command's output in both headers", async () => {
    const { url, endpoint } = await serve();

    const result = await diagnose(
      ["--credential-command", "printf 'helper-token\\n'", "--model", "test-model", "--only", "message", "--no-file"],
      { ANTHROPIC_BASE_URL: url },
    );

    expect(result.code, result.output).toBe(0);
    expect(endpoint.requests[0]?.headers.get("x-api-key")).toBe("helper-token");
    expect(endpoint.requests[0]?.headers.get("authorization")).toBe("Bearer helper-token");
  });

  it("exits with 1 and lists the endpoint's models when the model is unknown", async () => {
    const { url } = await serve({ model: "router-opus" });

    const result = await diagnose(["--no-file"], { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "test-key" });

    expect(result.code, result.output).toBe(1);
    expect(result.stdout).toContain("claude-opus-5-5 (źródło: domyślny)");
    expect(result.stdout).toContain("Rdzeń:               NIEGOTOWY");
    expect(result.stdout).toContain("Modele dostępne na endpoincie: router-opus");
    expect(result.stdout).toContain("Wskazówka: Nieznany model");
  });

  it("still exits with 0 when only optional features are missing", async () => {
    const { url } = await serve({ reject: ["output_config", "strict"], cache: "ignored", models: "missing" });

    const result = await diagnose(["--model", "test-model", "--no-file"], {
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_API_KEY: "k",
    });

    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain("cache_control nie, effort nie, thinking tak, PDF tak");
    expect(result.stdout).toContain("ODRZUCONE   Poziom wysiłku (effort)");
    expect(result.stdout).toContain("output_config: Extra inputs are not permitted");
  });

  it("omits the endpoint from the report on request", async () => {
    const { url } = await serve();
    const out = join(tempDir(), "report.json");

    const result = await diagnose(["--model", "test-model", "--only", "message", "--redact-endpoint", "--out", out], {
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_API_KEY: "k",
    });

    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain("Endpoint:       (ukryty)");
    expect(readFileSync(out, "utf8")).not.toContain("127.0.0.1");
  });

  it("exits with 2 on a configuration error without sending anything", async () => {
    const { url, endpoint } = await serve();
    const env = { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "k" };

    const unknownCheck = await diagnose(["--only", "message,nope"], env);
    expect(unknownCheck.code, unknownCheck.output).toBe(2);
    expect(unknownCheck.stderr).toContain("Nieznany test w --only: nope");

    const missingSettings = await diagnose(["--claude-settings", "/nonexistent/settings.json"], env);
    expect(missingSettings.code, missingSettings.output).toBe(2);
    expect(missingSettings.stderr).toContain("Nie można odczytać pliku ustawień");

    const badTimeout = await diagnose(["--timeout", "soon"], env);
    expect(badTimeout.code, badTimeout.output).toBe(2);

    const unknownFlag = await diagnose(["--frobnicate"], env);
    expect(unknownFlag.code, unknownFlag.output).toBe(2);
    expect(unknownFlag.stderr).toContain("Użycie:");

    expect(endpoint.requests).toHaveLength(0);
  });

  it("keeps a credential that the endpoint repeats out of what it prints and out of the report it writes", async () => {
    const secret = plantedSecret();
    const url = await serveEchoing();
    const out = join(tempDir(), "report.json");

    const result = await diagnose(["--model", "test-model", "--out", out], {
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_AUTH_TOKEN: secret,
    });

    const written = readFileSync(out, "utf8");
    expect(result.code, result.output.replaceAll(secret, "<THE SECRET>")).toBe(1);
    expect(result.output.includes(secret)).toBe(false);
    expect(written.includes(secret)).toBe(false);
    // The endpoint did repeat it: the rest of its sentence is in both places.
    expect(result.stdout).toContain("Invalid credential: Bearer [ukryte] (Bearer%20[ukryte])");
    expect(JSON.parse(written).checks[0].error).toMatchObject({
      httpStatus: 401,
      message: "Invalid credential: Bearer [ukryte] (Bearer%20[ukryte])",
      requestId: "req_echo",
    });
    expect(result.stdout).toContain("Raport nie zawiera poświadczeń.");
  });

  it("keeps it out of the report it prints as JSON, also in the form a URL gives it", async () => {
    // Every character of the first part is written differently in a URL.
    const secret = `+/=:${plantedSecret()}`;
    const url = await serveEchoing();

    const result = await diagnose(["--model", "test-model", "--only", "message", "--json", "--no-file"], {
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_API_KEY: secret,
    });

    expect(result.code, result.output.replaceAll(secret, "<THE SECRET>")).toBe(1);
    expect(result.output.includes(secret)).toBe(false);
    expect(result.output.includes(encodeURIComponent(secret))).toBe(false);
    expect(JSON.parse(result.stdout).checks[0].detail).toBe("Invalid credential: [ukryte] ([ukryte])");
  });

  it("leaves no part of it where the diagnostics cut a long error text short", async () => {
    const secret = plantedSecret();
    // With this much text in front, the limit of an error text falls inside the credential.
    const url = await serveEchoing({ lead: 560 });
    const out = join(tempDir(), "report.json");

    const result = await diagnose(["--model", "test-model", "--only", "message", "--out", out], {
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_AUTH_TOKEN: secret,
    });

    const beginning = secret.slice(0, 8);
    expect(result.code, result.output.replaceAll(beginning, "<THE SECRET>")).toBe(1);
    expect(result.output.includes(beginning)).toBe(false);
    expect(readFileSync(out, "utf8").includes(beginning)).toBe(false);
    expect(result.stdout).toContain("Invalid credential: Bearer [ukryte]");
  });

  it("keeps it out of what a check says about an answer that was accepted", async () => {
    const secret = plantedSecret();
    const url = await serveEchoing({ accept: true });
    const out = join(tempDir(), "report.json");
    const env = { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: secret };

    const table = await diagnose(["--model", "test-model", "--only", "message", "--out", out], env);
    const json = await diagnose(["--model", "test-model", "--only", "message", "--json", "--no-file"], env);

    expect(table.code, table.output.replaceAll(secret, "<THE SECRET>")).toBe(0);
    expect(json.code, json.output.replaceAll(secret, "<THE SECRET>")).toBe(0);
    for (const text of [table.output, json.output, readFileSync(out, "utf8")]) {
      expect(text.includes(secret)).toBe(false);
      expect(text).toContain("Model odpowiedział: „gotowe Bearer [ukryte]”.");
    }
  });

  it("keeps out a credential that could not be sent because of a line break inside it", async () => {
    const [first, second] = [plantedSecret(), plantedSecret()];
    const out = join(tempDir(), "report.json");

    // Nothing listens on this port, and nothing is sent: the SDK refuses the header value,
    // and its message repeats the value.
    const result = await diagnose(["--model", "test-model", "--only", "message", "--out", out], {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      ANTHROPIC_AUTH_TOKEN: `${first}\n${second}`,
    });

    const hidden = (text: string) => text.replaceAll(first, "<THE SECRET>").replaceAll(second, "<THE SECRET>");
    expect(result.code, hidden(result.output)).toBe(1);
    for (const text of [result.output, readFileSync(out, "utf8")]) {
      expect(text.includes(first)).toBe(false);
      expect(text.includes(second)).toBe(false);
      expect(text).toContain("Bearer [ukryte]");
    }
  });

  it.each([
    ["Authorization", "Bearer ", "Invalid credential: Bearer [ukryte] (Bearer%20[ukryte])"],
    ["X-Api-Key", "", "Invalid credential: [ukryte] ([ukryte])"],
  ])("keeps out a credential that a settings file put into the header %s itself", async (header, scheme, detail) => {
    const secret = plantedSecret();
    const url = await serveEchoing();
    const settingsPath = join(tempDir(), "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: url,
          ANTHROPIC_CUSTOM_HEADERS: `${header}: ${scheme}${secret}`,
          ANTHROPIC_MODEL: "test-model",
        },
      }),
    );

    const result = await diagnose(["--claude-settings", settingsPath, "--only", "message", "--json", "--no-file"]);

    expect(result.code, result.output.replaceAll(secret, "<THE SECRET>")).toBe(1);
    expect(result.output.includes(secret)).toBe(false);
    const report = JSON.parse(result.stdout);
    expect(report.meta.credentialSource).toBe("custom-headers");
    expect(report.checks[0].detail).toBe(detail);
  });

  // The limits at which the diagnostics cut a text short are far below the length of a real
  // credential. Each of these has the cut fall inside the credential: whatever is cleaned only
  // afterwards leaves the part before the cut.
  it("leaves no part of a long credential where a check quotes the beginning of an answer that repeats it", async () => {
    const secret = `${plantedSecret()}${plantedSecret()}${plantedSecret()}`;
    const url = await serveEchoing({ accept: true });
    const out = join(tempDir(), "report.json");

    const result = await diagnose(["--model", "test-model", "--only", "message", "--out", out], {
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_API_KEY: secret,
    });

    const beginning = secret.slice(0, 8);
    expect(result.code, result.output.replaceAll(beginning, "<THE SECRET>")).toBe(0);
    for (const text of [result.output, readFileSync(out, "utf8")]) {
      expect(text.includes(beginning)).toBe(false);
      expect(text).toContain("Model odpowiedział: „gotowe [ukryte]”.");
    }
  });

  it("leaves no part of a credential that the SDK quotes because it cannot be sent: two long lines from a credential command", async () => {
    // What a command prints that wraps a long token, as base64 does.
    const [first, second] = [plantedSecret().repeat(8), plantedSecret().repeat(8)];
    const dir = tempDir();
    const command = join(dir, "wrapped-token.sh");
    writeFileSync(command, `#!/bin/sh\nprintf '%s\\n%s\\n' ${first} ${second}\n`, { mode: 0o700 });
    const out = join(dir, "report.json");

    // Nothing listens on this port, and nothing is sent: the SDK refuses the header value, in a
    // message that repeats all of it and is longer than what the diagnostics keep of an error.
    const result = await diagnose(
      ["--credential-command", `"${command}"`, "--model", "test-model", "--only", "message", "--out", out],
      { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" },
    );

    const hidden = (text: string) => text.replaceAll(first.slice(0, 8), "<THE SECRET>");
    expect(result.code, hidden(result.output)).toBe(1);
    for (const text of [result.output, readFileSync(out, "utf8")]) {
      expect(text.includes(first.slice(0, 8))).toBe(false);
      expect(text.includes(second.slice(0, 8))).toBe(false);
      // The file holds the quotation marks of the message escaped.
      expect(text).toMatch(/Headers\.append: \\?"\[ukryte\]\\?" is an invalid header value\./);
    }
  });

  it("leaves no part of a credential that a long error spells with JSON escapes", async () => {
    // Slashes all through it: the gateway escapes each of them, as PHP does when it writes JSON.
    const secret = plantedSecret().replace(/(..)(?=.)/g, "$1/");
    const url = await listen(async (request) => {
      const presented = request.headers.get("x-api-key") ?? "";
      // Written by hand: JSON.stringify() leaves a slash as it is.
      const message = `${"y".repeat(560)} token ${presented.replaceAll("/", "\\/")} is not valid`;
      return new Response(`{"type":"error","error":{"type":"authentication_error","message":"${message}"}}`, {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    const out = join(tempDir(), "report.json");

    const result = await diagnose(["--model", "test-model", "--only", "message", "--out", out], {
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_API_KEY: secret,
    });

    const beginning = secret.slice(0, 8);
    expect(result.code, result.output.replaceAll(beginning, "<THE SECRET>")).toBe(1);
    for (const text of [result.output, readFileSync(out, "utf8")]) {
      expect(text.includes(beginning)).toBe(false);
      expect(text).toContain("token [ukryte] is not valid");
    }
  });

  it("keeps out what a custom header carries, whatever the header is called", async () => {
    const [gateway, proxy, session] = [plantedSecret(), plantedSecret(), plantedSecret()];
    // A gateway that shows what it was sent, the cookie it did not know by itself as well.
    const url = await listen(async (request) => {
      const header = (name: string) => request.headers.get(name) ?? "";
      const cookie = /session=([^;]*)/.exec(header("cookie"))?.[1];
      const message = `Rejected: gateway ${header("x-gateway-token")}, proxy ${header("proxy-authorization")}, cookies ${header("cookie")}, session ${cookie}`;
      return Response.json({ type: "error", error: { type: "authentication_error", message } }, { status: 401 });
    });
    const dir = tempDir();
    const settingsPath = join(dir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: url,
          ANTHROPIC_API_KEY: "stand-in-key",
          ANTHROPIC_CUSTOM_HEADERS: [
            `X-Gateway-Token: ${gateway}`,
            `Proxy-Authorization: Basic ${proxy}`,
            `Cookie: session=${session}; theme=dark`,
          ].join("\n"),
          ANTHROPIC_MODEL: "test-model",
        },
      }),
    );
    const out = join(dir, "report.json");
    const args = ["--claude-settings", settingsPath, "--only", "message"];

    const table = await diagnose([...args, "--out", out]);
    const json = await diagnose([...args, "--json", "--no-file"]);

    const hidden = (text: string) =>
      [gateway, proxy, session].reduce((all, one) => all.replaceAll(one, "<SECRET>"), text);
    expect(table.code, hidden(table.output)).toBe(1);
    expect(json.code, hidden(json.output)).toBe(1);
    for (const text of [table.output, json.output, readFileSync(out, "utf8")]) {
      for (const secret of [gateway, proxy, session]) expect(text.includes(secret)).toBe(false);
      // The gateway did repeat all four: the rest of its sentence is there.
      expect(text).toContain("Rejected: gateway [ukryte], proxy Basic [ukryte], cookies [ukryte], session [ukryte]");
    }
    expect(table.stdout).toContain("Raport nie zawiera poświadczeń.");
  });

  it("leaves the address and the model readable when a custom header carries either", async () => {
    const secret = plantedSecret();
    // A gateway that shows what it was sent.
    const url = await listen(async (request) => {
      const header = (name: string) => request.headers.get(name) ?? "";
      const message = `No model ${header("x-model")} at ${header("x-upstream")} for ${header("x-gateway-token")}`;
      return Response.json({ type: "error", error: { type: "not_found_error", message } }, { status: 404 });
    });
    const host = new URL(url).host;
    const out = join(tempDir(), "report.json");

    const result = await diagnose(["--model", "router-opus-5", "--only", "message", "--out", out], {
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_API_KEY: "stand-in-key",
      // Two headers that repeat what the report says anyway, and one that is a secret.
      ANTHROPIC_CUSTOM_HEADERS: `X-Model: router-opus-5\nX-Upstream: ${host}\nX-Gateway-Token: ${secret}`,
    });

    const written = readFileSync(out, "utf8");
    expect(result.code, result.output.replaceAll(secret, "<THE SECRET>")).toBe(1);
    // What the command that creates a workspace reads from the report.
    expect(JSON.parse(written).meta).toMatchObject({ endpoint: url, model: "router-opus-5" });
    for (const text of [result.output, written]) {
      expect(text.includes(secret)).toBe(false);
      expect(text).toContain(`No model router-opus-5 at ${host} for [ukryte]`);
    }
  });

  it.each([307, 302])(
    "does not follow a redirect with status %i: nothing reaches the other address, and the check fails",
    async (status) => {
      const arrived: string[] = [];
      const elsewhere = await listen(async (request) => {
        arrived.push(`${request.method} ${new URL(request.url).pathname}`);
        return Response.json({
          id: "msg_elsewhere",
          type: "message",
          role: "assistant",
          model: "test-model",
          content: [{ type: "text", text: "gotowe" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      });
      const url = await listen(
        async (request) =>
          new Response(null, { status, headers: { location: `${elsewhere}${new URL(request.url).pathname}` } }),
      );

      // The key goes out as x-api-key, which fetch() would repeat at the new address, and so
      // would the custom header.
      const result = await diagnose(["--model", "test-model", "--only", "message", "--no-file"], {
        ANTHROPIC_BASE_URL: url,
        ANTHROPIC_API_KEY: plantedSecret(),
        ANTHROPIC_CUSTOM_HEADERS: `X-Gateway-Token: ${plantedSecret()}`,
      });

      expect(arrived).toEqual([]);
      // Not a pass either: the report would vouch for an address that only redirects.
      expect(result.code, result.output).toBe(1);
      expect(result.stdout).toContain("BŁĄD        Zwykła wiadomość");
      expect(result.stdout).toContain(`${status} status code (no body)`);
      expect(result.stdout).toContain(
        "Wskazówka: Endpoint odpowiedział przekierowaniem. Diagnostyka, tak jak aplikacja, nie podąża za przekierowaniami, bo wysłałaby dane i poświadczenia pod inny adres. Sprawdź adres w ANTHROPIC_BASE_URL.",
      );
    },
  );

  it("does not repeat a base address that it cannot use", async () => {
    const secret = plantedSecret();
    const unusable = [
      // With a password, and a port that no address can have.
      `https://svc:${secret}@router.corp.example:99999/llm`,
      `ftp://svc:${secret}@router.corp.example/llm`,
      // A key that was put into the wrong variable.
      `sk-${secret}`,
    ];

    for (const value of unusable) {
      const result = await diagnose(["--only", "message", "--no-file"], {
        ANTHROPIC_BASE_URL: value,
        ANTHROPIC_API_KEY: "stand-in-key",
      });

      expect(result.code, result.output.replaceAll(secret, "<THE SECRET>")).toBe(2);
      expect(result.output.includes(secret)).toBe(false);
      expect(result.stderr).toMatch(/^ANTHROPIC_BASE_URL (nie jest poprawnym adresem|musi zaczynać się od http)/);
      expect(result.stdout).toBe("");
    }
  });

  it("leaves the report readable when a stand-in key is a word of the report's own", async () => {
    const url = await serveEchoing();

    const result = await diagnose(["--model", "test-model", "--only", "message", "--json", "--no-file"], {
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_API_KEY: "endpoint",
    });

    expect(result.code, result.output).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.meta.endpoint).toBe(url);
    expect(report.checks[0].detail).toBe("Invalid credential: [ukryte] ([ukryte])");
  });

  it("does not take a stand-in key of a few characters for a secret to remove", async () => {
    const url = await serveEchoing();

    // Replacing every "e" would leave neither the report nor its JSON readable.
    const result = await diagnose(["--model", "test-model", "--only", "message", "--json", "--no-file"], {
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_API_KEY: "e",
    });

    expect(result.code, result.output).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.meta.model).toBe("test-model");
    expect(report.checks[0].detail).toBe("Invalid credential: e (e)");
  });

  it("prints the usage and sends nothing for --help", async () => {
    const result = await diagnose(["--help"]);

    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain("npm run diagnose -- [opcje]");
    expect(result.stdout).toContain("Testy: message, streaming, tool_use");
  });
});
