import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeEndpoint, type FakeBehavior, type FakeEndpoint } from "../src/server/llm/diagnostics/fake-endpoint.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SPAWN_TIMEOUT_MS = 30_000;

let server: Server | undefined;
let workDir: string | undefined;

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = undefined;
});

// The script builds its own client, so it needs a real socket to talk to.
async function serve(behavior: FakeBehavior = {}): Promise<{ url: string; endpoint: FakeEndpoint }> {
  const endpoint = createFakeEndpoint(behavior);
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const response = await endpoint.fetch(
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
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, endpoint };
}

function tempDir(): string {
  workDir = mkdtempSync(join(tmpdir(), "hubber-diagnose-"));
  return workDir;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// The environment is built from scratch so the developer's own ANTHROPIC_* variables never leak in.
function diagnose(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "scripts/diagnose.ts", ...args],
      { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, timeout: SPAWN_TIMEOUT_MS },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe("scripts/diagnose.ts", () => {
  it("runs every check, prints a summary and writes a report without secrets", async () => {
    const { url, endpoint } = await serve();
    const out = join(tempDir(), "nested", "report.json");

    const result = await diagnose(["--model", "test-model", "--out", out], {
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_API_KEY: "test-key-123",
    });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
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
  }, SPAWN_TIMEOUT_MS);

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

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.meta).toMatchObject({ credentialSource: "ANTHROPIC_AUTH_TOKEN", customHeaderNames: ["X-Team"] });
    expect(report.checks.map((check: { id: string }) => check.id)).toEqual(["message"]);

    expect(endpoint.requests).toHaveLength(1);
    const headers = endpoint.requests[0]?.headers;
    expect(headers?.get("authorization")).toBe("Bearer corp-token");
    expect(headers?.get("x-team")).toBe("platform");
    expect(headers?.get("x-api-key")).toBeNull();
    expect(headers?.get("x-personal")).toBeNull();
  }, SPAWN_TIMEOUT_MS);

  it("sends a credential command's output in both headers", async () => {
    const { url, endpoint } = await serve();

    const result = await diagnose(
      ["--credential-command", "printf 'helper-token\\n'", "--model", "test-model", "--only", "message", "--no-file"],
      { ANTHROPIC_BASE_URL: url },
    );

    expect(result.code).toBe(0);
    expect(endpoint.requests[0]?.headers.get("x-api-key")).toBe("helper-token");
    expect(endpoint.requests[0]?.headers.get("authorization")).toBe("Bearer helper-token");
  }, SPAWN_TIMEOUT_MS);

  it("exits with 1 and lists the endpoint's models when the model is unknown", async () => {
    const { url } = await serve({ model: "router-opus" });

    const result = await diagnose(["--no-file"], { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "test-key" });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("claude-opus-5-5 (źródło: domyślny)");
    expect(result.stdout).toContain("Rdzeń:               NIEGOTOWY");
    expect(result.stdout).toContain("Modele dostępne na endpoincie: router-opus");
    expect(result.stdout).toContain("Wskazówka: Nieznany model");
  }, SPAWN_TIMEOUT_MS);

  it("still exits with 0 when only optional features are missing", async () => {
    const { url } = await serve({ reject: ["output_config", "strict"], cache: "ignored", models: "missing" });

    const result = await diagnose(["--model", "test-model", "--no-file"], { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "k" });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("cache_control nie, effort nie, thinking tak, PDF tak");
    expect(result.stdout).toContain("ODRZUCONE   Poziom wysiłku (effort)");
    expect(result.stdout).toContain("output_config: Extra inputs are not permitted");
  }, SPAWN_TIMEOUT_MS);

  it("omits the endpoint from the report on request", async () => {
    const { url } = await serve();
    const out = join(tempDir(), "report.json");

    const result = await diagnose(["--model", "test-model", "--only", "message", "--redact-endpoint", "--out", out], {
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_API_KEY: "k",
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Endpoint:       (ukryty)");
    expect(readFileSync(out, "utf8")).not.toContain("127.0.0.1");
  }, SPAWN_TIMEOUT_MS);

  it("exits with 2 on a configuration error without sending anything", async () => {
    const { url, endpoint } = await serve();
    const env = { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "k" };

    const unknownCheck = await diagnose(["--only", "message,nope"], env);
    expect(unknownCheck.code).toBe(2);
    expect(unknownCheck.stderr).toContain("Nieznany test w --only: nope");

    const missingSettings = await diagnose(["--claude-settings", "/nonexistent/settings.json"], env);
    expect(missingSettings.code).toBe(2);
    expect(missingSettings.stderr).toContain("Nie można odczytać pliku ustawień");

    const badTimeout = await diagnose(["--timeout", "soon"], env);
    expect(badTimeout.code).toBe(2);

    const unknownFlag = await diagnose(["--frobnicate"], env);
    expect(unknownFlag.code).toBe(2);
    expect(unknownFlag.stderr).toContain("Użycie:");

    expect(endpoint.requests).toHaveLength(0);
  }, SPAWN_TIMEOUT_MS);

  it("prints the usage and sends nothing for --help", async () => {
    const result = await diagnose(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("npm run diagnose -- [opcje]");
    expect(result.stdout).toContain("Testy: message, streaming, tool_use");
  }, SPAWN_TIMEOUT_MS);
});
