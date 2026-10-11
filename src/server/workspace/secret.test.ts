// The secret is in no file of the workspace directory and not in the database (CFG-4). Shown
// twice: on the real processes, from the command that creates a workspace to the server that
// is stopped again, and on a call of the model through the client that the server builds.
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { AuthenticationError } from "@anthropic-ai/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createLlmClient } from "../llm/client.ts";
import { createCredentialProvider } from "../llm/credentials/provider.ts";
import { HIDDEN } from "../llm/credentials/secret.ts";
import type { CredentialProvider } from "../llm/credentials/types.ts";
import { createFakeEndpoint } from "../llm/diagnostics/fake-endpoint.ts";
import type { Endpoint } from "../llm/endpoint.ts";
import { type Exit, freePorts, type SpawnedNode, spawnNode, TEST_WORKSPACE } from "../testing.ts";
import { type LlmProfile, modelFor } from "./config.ts";
import { REPOSITORY_ROOT } from "./layout.ts";
import { type OpenWorkspace, openWorkspace } from "./open.ts";
import { createTestWorkspace, scanWorkspaceForSecret, type TestWorkspace } from "./testing.ts";
import { DIRECT_TRANSPORT } from "./transport.ts";

const HOST = "127.0.0.1";
// Any allowed value puts the server in development mode, where it needs no built web app.
const DEV_ORIGIN = "http://127.0.0.1:8000";
const START_TIMEOUT_MS = 10_000;
const LAYOUT = ["files", "hubber.sqlite", "workspace.json"];
const ROUTER = "https://router.corp.example/llm";
// Unique per run, so that a finding can only come from this run.
const SECRET = `hubber-planted-${randomUUID()}`;
const WITHOUT_CREDENTIAL =
  "Serwer działa dalej, ale wywołania modelu będą kończyć się błędem, dopóki tego nie poprawisz.";

const children: ChildProcess[] = [];
const workspaces: TestWorkspace[] = [];
const opened: OpenWorkspace[] = [];
const providers: CredentialProvider[] = [];
let work: string;
let counter = 0;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "hubber-secret-"));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const provider of providers.splice(0)) provider.close();
  for (const workspace of opened.splice(0)) workspace.close();
  for (const workspace of workspaces.splice(0)) workspace.remove();
});

/** A place of its own for whatever a test keeps outside the workspace. */
function outside(name: string): string {
  const dir = join(work, `outside-${++counter}`);
  mkdirSync(dir);
  return join(dir, name);
}

/** A credentials file with one entry, readable by the owner alone as the server demands. */
function credentialsFile(path: string, endpoint: string, entry: unknown): string {
  writeFileSync(path, JSON.stringify({ version: 1, endpoints: { [endpoint]: entry } }), { mode: 0o600 });
  return path;
}

function throwaway(profile: Partial<LlmProfile> = {}): TestWorkspace {
  const created = createTestWorkspace(profile);
  workspaces.push(created);
  return created;
}

// Above the start timeout, so that a slow start reports the server output and not a bare test timeout.
describe("the processes that create and serve a workspace", { timeout: START_TIMEOUT_MS + 5_000 }, () => {
  // spawnNode() builds each environment from scratch: what a process knows of the secret is
  // what the test put there.
  async function create(dir: string, env: Record<string, string>): Promise<SpawnedNode> {
    const command = spawnNode("scripts/workspace-create.ts", {
      args: ["--name", "Praca", "--kind", "router", "--endpoint", ROUTER, "--model", "router-opus", "--dir", dir],
      env,
    });
    children.push(command.child);
    expect(await command.exited).toEqual({ code: 0, signal: null });
    return command;
  }

  interface ServeOptions {
    /** What to start in place of the server's own entry point. */
    script?: string;
    nodeArgs?: string[];
  }

  async function serve(
    env: Record<string, string>,
    { script = "src/server/main.ts", nodeArgs = [] }: ServeOptions = {},
  ): Promise<SpawnedNode & { port: number }> {
    const [port] = await freePorts(1);
    const server = spawnNode(script, {
      nodeArgs,
      env: { ...env, HUBBER_PORT: String(port), HUBBER_DEV_ORIGIN: DEV_ORIGIN },
    });
    children.push(server.child);
    await vi.waitFor(
      () => {
        if (server.stdout().includes(`http://${HOST}:${port}`)) return;
        throw new Error(`The server has not printed its address.\n${server.stdout()}${server.stderr()}`);
      },
      { timeout: START_TIMEOUT_MS, interval: 20 },
    );
    return { ...server, port };
  }

  function stop(server: SpawnedNode): Promise<Exit> {
    server.child.kill("SIGTERM");
    return server.exited;
  }

  it.each<[string, (file: string) => Record<string, string>, (file: string) => string]>([
    [
      "the environment",
      () => ({ ANTHROPIC_BASE_URL: ROUTER, ANTHROPIC_AUTH_TOKEN: SECRET }),
      () => "Poświadczenia: zmienna ANTHROPIC_AUTH_TOKEN.\n",
    ],
    [
      "a file outside the workspace",
      (file) => ({ HUBBER_CREDENTIALS_FILE: credentialsFile(file, ROUTER, { authToken: SECRET }) }),
      (file) => `Poświadczenia: plik "${file}".\n`,
    ],
  ])(
    "keep a credential from %s out of the workspace, out of what they print and out of what the page is told",
    async (_source, environment, found) => {
      const dir = outside("workspace");
      const file = outside("credentials.json");
      const env = environment(file);

      const command = await create(dir, env);
      const server = await serve({ ...env, HUBBER_WORKSPACE: dir });
      const answer = await (await fetch(`http://${HOST}:${server.port}/api/workspace`)).text();
      const whileOpen = scanWorkspaceForSecret(dir, SECRET);
      expect(await stop(server)).toEqual({ code: 0, signal: null });

      // The server had the secret in its hands. Without this line nothing below proves anything.
      expect(server.stdout()).toContain(found(file));
      // Every file in seven spellings, the write-ahead log of the open database among them, and
      // every value of every table through SQL.
      expect(whileOpen).toEqual([]);
      expect(scanWorkspaceForSecret(dir, SECRET)).toEqual([]);
      expect(readdirSync(dir).sort()).toEqual(LAYOUT);
      expect(command.stdout() + command.stderr() + server.stdout() + server.stderr()).not.toContain(SECRET);
      expect(answer).toBe('{"name":"Praca","endpointOrigin":"https://router.corp.example"}');
    },
  );

  it("read no credentials file that lies inside the workspace directory", async () => {
    const workspace = throwaway();
    const file = credentialsFile(join(workspace.dir, "credentials.json"), TEST_WORKSPACE.endpoint, {
      authToken: SECRET,
    });

    const server = await serve({ ...workspace.env, HUBBER_CREDENTIALS_FILE: file });

    expect(await stop(server)).toEqual({ code: 0, signal: null });
    // Refused for where it lies, and not opened: a directory that is copied and restored as a
    // whole must never be a place where a credential works.
    expect(server.stderr()).toBe(
      `Plik poświadczeń "${file}" leży w katalogu "${workspace.dir}". Poświadczenia muszą leżeć poza repozytorium i poza katalogiem workspace'u; przenieś plik, na przykład do "~/.config/hubber/credentials.json".\n${WITHOUT_CREDENTIAL}\n`,
    );
    expect(server.stdout()).not.toContain("Poświadczenia:");
  });

  it("read no credentials file that lies in the checkout the server runs from", async () => {
    // A stand-in for the checkout, made of links to the real one, so that the file can lie in
    // "the repository" without anything being written into the real one. Started through the
    // links, with Node told to keep them, the server takes the stand-in for its checkout.
    const checkout = join(work, "checkout");
    mkdirSync(checkout);
    for (const name of ["src", "node_modules"]) symlinkSync(join(REPOSITORY_ROOT, name), join(checkout, name));
    const workspace = throwaway();
    const file = credentialsFile(join(checkout, "credentials.json"), TEST_WORKSPACE.endpoint, { authToken: SECRET });

    const server = await serve(
      { ...workspace.env, HUBBER_CREDENTIALS_FILE: file },
      {
        script: join(checkout, "src/server/main.ts"),
        nodeArgs: ["--preserve-symlinks", "--preserve-symlinks-main"],
      },
    );

    expect(await stop(server)).toEqual({ code: 0, signal: null });
    expect(server.stderr()).toBe(
      `Plik poświadczeń "${file}" leży w katalogu "${checkout}". Poświadczenia muszą leżeć poza repozytorium i poza katalogiem workspace'u; przenieś plik, na przykład do "~/.config/hubber/credentials.json".\n${WITHOUT_CREDENTIAL}\n`,
    );
    expect(server.stdout()).not.toContain("Poświadczenia:");
  });
});

describe("a call of the model from an open workspace", () => {
  const PUBLIC_API: Partial<LlmProfile> = {
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    auth: "x-api-key",
  };
  const params = (profile: LlmProfile) => ({
    model: modelFor(profile, "processing"),
    max_tokens: 16,
    messages: [{ role: "user" as const, content: "Notatka ze spotkania" }],
  });

  /** What the server does once its workspace is open: the provider for the workspace's endpoint and way of authenticating. */
  function providerFor(workspace: OpenWorkspace, env: Record<string, string>): CredentialProvider {
    const provider = createCredentialProvider(
      { endpoint: workspace.endpoint, scheme: workspace.config.profile.auth },
      { env, uid: process.getuid?.() ?? -1, forbiddenRoots: [REPOSITORY_ROOT, workspace.paths.dir] },
    );
    providers.push(provider);
    return provider;
  }

  function open(workspace: TestWorkspace, env: Record<string, string>): OpenWorkspace {
    const found = openWorkspace({ dir: workspace.dir, source: "variable" }, env, DIRECT_TRANSPORT);
    opened.push(found);
    return found;
  }

  // The stand-in for an endpoint answers at the root of its origin, and the throwaway workspace
  // is pinned to an address with a path. The path is taken off on the way, as a router does
  // before it hands a request on.
  function behind(endpoint: Endpoint, handler: typeof fetch): typeof fetch {
    return (input, init) => {
      const url = new URL(String(input));
      url.pathname = url.pathname.slice(endpoint.basePath.length);
      return handler(url, init);
    };
  }

  /** A program that prints the secret, as a helper command of the credentials file does. */
  function helperScript(): string {
    const script = outside("token.sh");
    writeFileSync(script, `#!/bin/sh\necho "${SECRET}"\n`, { mode: 0o700 });
    return script;
  }

  const SOURCES: Array<
    [
      source: string,
      profile: Partial<LlmProfile>,
      env: () => Record<string, string>,
      header: "authorization" | "x-api-key",
      sent: string,
    ]
  > = [
    [
      "a token in the environment",
      {},
      () => ({ ANTHROPIC_BASE_URL: TEST_WORKSPACE.endpoint, ANTHROPIC_AUTH_TOKEN: SECRET }),
      "authorization",
      `Bearer ${SECRET}`,
    ],
    ["a key for the public API", PUBLIC_API, () => ({ ANTHROPIC_API_KEY: SECRET }), "x-api-key", SECRET],
    [
      "the credentials file",
      {},
      () => ({
        HUBBER_CREDENTIALS_FILE: credentialsFile(outside("credentials.json"), TEST_WORKSPACE.endpoint, {
          authToken: SECRET,
        }),
      }),
      "authorization",
      `Bearer ${SECRET}`,
    ],
    [
      "a helper command",
      {},
      () => ({
        HUBBER_CREDENTIALS_FILE: credentialsFile(outside("credentials.json"), TEST_WORKSPACE.endpoint, {
          helper: { command: [helperScript()] },
        }),
      }),
      "authorization",
      `Bearer ${SECRET}`,
    ],
  ];

  it.each(SOURCES)(
    "sends the credential from %s to the endpoint and leaves no trace of it in the workspace",
    async (_source, profile, environment, header, sent) => {
      const workspace = throwaway(profile);
      const env = environment();
      const found = open(workspace, env);
      const credentials = providerFor(found, env);
      const endpoint = createFakeEndpoint();
      const client = createLlmClient({ credentials, fetch: behind(found.endpoint, endpoint.fetch), maxRetries: 0 });

      const reply = await client.messages.create(params(found.config.profile));

      expect(reply.content).toEqual([{ type: "text", text: "gotowe" }]);
      // The endpoint got the secret, the way the profile says. Without this the scan proves nothing.
      expect(endpoint.requests.map((request) => [request.path, request.headers.get(header)])).toEqual([
        ["/v1/messages", sent],
      ]);
      const other = header === "authorization" ? "x-api-key" : "authorization";
      expect(endpoint.requests[0]?.headers.get(other)).toBeNull();

      const whileOpen = scanWorkspaceForSecret(workspace.dir, SECRET);
      credentials.close();
      found.close();

      expect(whileOpen).toEqual([]);
      expect(scanWorkspaceForSecret(workspace.dir, SECRET)).toEqual([]);
      expect(readdirSync(workspace.dir).sort()).toEqual(LAYOUT);
    },
  );

  it.each(SOURCES)(
    "keeps the credential from %s out of the error when the endpoint refuses it and repeats it",
    async (_source, profile, environment, header, sent) => {
      const workspace = throwaway(profile);
      const env = environment();
      const found = open(workspace, env);
      const credentials = providerFor(found, env);
      const presented: Array<string | null> = [];
      const refusing: typeof fetch = async (_input, init) => {
        const value = new Headers(init?.headers).get(header);
        presented.push(value);
        return Response.json(
          { type: "error", error: { type: "authentication_error", message: `invalid credential: ${value}` } },
          { status: 401, headers: { "request-id": "req_1" } },
        );
      };
      const client = createLlmClient({ credentials, fetch: refusing, maxRetries: 0 });

      const error = await client.messages.create(params(found.config.profile)).catch((caught: unknown) => caught);

      // The endpoint did get the secret and did repeat it.
      expect(presented).toContain(sent);
      expect(error).toBeInstanceOf(AuthenticationError);
      // What the endpoint said is kept, with the secret taken out of it.
      expect((error as AuthenticationError).message).toContain(`invalid credential: ${sent.replace(SECRET, HIDDEN)}`);
      expect(inspect(error, { depth: 8, showHidden: true })).not.toContain(SECRET);

      credentials.close();
      found.close();
      expect(scanWorkspaceForSecret(workspace.dir, SECRET)).toEqual([]);
    },
  );
});
