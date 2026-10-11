import { describe, expect, it, vi } from "vitest";
import { type ConfigDeps, ConfigError, type ConfigOptions, resolveConfig } from "./config.ts";

const SETTINGS_PATH = "/work/.claude/settings.json";

function resolve(
  options: ConfigOptions = {},
  setup: { env?: Record<string, string>; settings?: unknown; token?: string } = {},
) {
  const deps: ConfigDeps = {
    env: setup.env ?? {},
    readFile: vi.fn((path: string) => {
      if (path !== SETTINGS_PATH || setup.settings === undefined) throw new Error("ENOENT");
      return typeof setup.settings === "string" ? setup.settings : JSON.stringify(setup.settings);
    }),
    runCommand: vi.fn(() => setup.token ?? "helper-token\n"),
  };
  return { config: resolveConfig(options, deps), deps };
}

const withSettings = (settings: unknown, env: Record<string, string> = {}, options: ConfigOptions = {}) =>
  resolve({ claudeSettingsPath: SETTINGS_PATH, ...options }, { settings, env });

describe("resolveConfig", () => {
  it("falls back to the public API, the default model and SDK-resolved credentials", () => {
    const { config } = resolve();

    expect(config.client).toEqual({
      baseURL: "https://api.anthropic.com",
      apiKey: undefined,
      authToken: undefined,
      defaultHeaders: {},
    });
    expect(config.meta).toEqual({
      endpoint: "https://api.anthropic.com",
      endpointIsDefault: true,
      credentialSource: "sdk-default",
      customHeaderNames: [],
      model: "claude-opus-5-5",
      modelSource: "domyślny",
      label: "api.anthropic.com",
    });
    expect(config.warnings).toEqual([]);
  });

  it("reads the endpoint and credentials from the environment", () => {
    const { config } = resolve(
      {},
      {
        env: { ANTHROPIC_BASE_URL: " https://router.corp.example/llm/?tenant=7 ", ANTHROPIC_AUTH_TOKEN: "corp-token" },
      },
    );

    expect(config.client.baseURL).toBe("https://router.corp.example/llm/?tenant=7");
    expect(config.client).toMatchObject({ authToken: "corp-token", apiKey: null });
    expect(config.meta).toMatchObject({
      endpoint: "https://router.corp.example/llm",
      endpointIsDefault: false,
      credentialSource: "ANTHROPIC_AUTH_TOKEN",
      label: "router.corp.example",
    });
  });

  it("keeps credentials embedded in the URL out of the report", () => {
    const { config } = resolve({}, { env: { ANTHROPIC_BASE_URL: "https://user:secret@router.corp.example" } });

    expect(config.meta.endpoint).toBe("https://router.corp.example");
    expect(JSON.stringify(config.meta)).not.toContain("secret");
  });

  it("rejects a base URL that is not http(s)", () => {
    expect(() => resolve({}, { env: { ANTHROPIC_BASE_URL: "router.corp.example" } })).toThrow(ConfigError);
    expect(() => resolve({}, { env: { ANTHROPIC_BASE_URL: "ftp://router.corp.example" } })).toThrow(ConfigError);
  });

  it("takes the connection from the settings file alone, ignoring the shell", () => {
    const { config } = withSettings(
      { env: { ANTHROPIC_BASE_URL: "https://router.corp.example", ANTHROPIC_AUTH_TOKEN: "corp-token" } },
      {
        ANTHROPIC_API_KEY: "personal-key",
        ANTHROPIC_BASE_URL: "https://elsewhere.example",
        ANTHROPIC_CUSTOM_HEADERS: "X-Personal: 1",
        ANTHROPIC_MODEL: "claude-personal-1",
      },
    );

    expect(config.client).toEqual({
      baseURL: "https://router.corp.example",
      apiKey: null,
      authToken: "corp-token",
      defaultHeaders: {},
    });
    expect(config.meta.model).toBe("claude-opus-5-5");
    expect(JSON.stringify(config)).not.toContain("personal");
  });

  it("does not let a settings file without a base URL inherit the shell's", () => {
    const { config } = withSettings(
      { env: { ANTHROPIC_API_KEY: "file-key" } },
      { ANTHROPIC_BASE_URL: "https://router.corp.example" },
    );

    expect(config.client.baseURL).toBe("https://api.anthropic.com");
    expect(config.meta.endpointIsDefault).toBe(true);
  });

  it("runs apiKeyHelper and sends its value in both headers", () => {
    const { config, deps } = withSettings({
      env: { ANTHROPIC_BASE_URL: "https://router.corp.example" },
      apiKeyHelper: "/opt/corp/token.sh",
    });

    expect(deps.runCommand).toHaveBeenCalledWith("/opt/corp/token.sh");
    expect(config.client).toMatchObject({ apiKey: "helper-token", authToken: "helper-token" });
    expect(config.meta.credentialSource).toBe("apiKeyHelper");
  });

  it("prefers a token in the settings file over apiKeyHelper", () => {
    const { config, deps } = withSettings({
      env: { ANTHROPIC_AUTH_TOKEN: "corp-token" },
      apiKeyHelper: "/opt/corp/token.sh",
    });

    expect(deps.runCommand).not.toHaveBeenCalled();
    expect(config.meta.credentialSource).toBe("ANTHROPIC_AUTH_TOKEN");
  });

  it("lets --credential-command override every other credential", () => {
    const { config, deps } = resolve(
      { credentialCommand: "vault read token" },
      { env: { ANTHROPIC_API_KEY: "shell-key" }, token: "  vault-token  \n" },
    );

    expect(deps.runCommand).toHaveBeenCalledWith("vault read token");
    expect(config.client).toMatchObject({ apiKey: "vault-token", authToken: "vault-token" });
    expect(config.meta.credentialSource).toBe("credential-command");
  });

  it("fails when the credential command prints nothing or exits with an error", () => {
    expect(() => resolve({ credentialCommand: "true" }, { token: "  \n" })).toThrow(/nie zwróciło tokenu/);

    const deps: ConfigDeps = {
      env: {},
      readFile: () => "",
      runCommand: () => {
        throw new Error("Command failed: secret-command --password hunter2");
      },
    };
    expect(() => resolveConfig({ credentialCommand: "secret-command --password hunter2" }, deps)).toThrow(
      "Polecenie poświadczeń (--credential-command) zakończyło się błędem.",
    );
  });

  it("refuses a settings file that carries no credentials", () => {
    expect(() => withSettings({ env: { ANTHROPIC_BASE_URL: "https://router.corp.example" } })).toThrow(
      /nie zawiera poświadczeń/,
    );
  });

  it("accepts a settings file that authenticates through custom headers", () => {
    const { config } = withSettings({
      env: {
        ANTHROPIC_BASE_URL: "https://router.corp.example",
        ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer corp-token\nX-Team: platform\nmalformed line",
      },
    });

    expect(config.client).toMatchObject({
      apiKey: null,
      authToken: null,
      defaultHeaders: { Authorization: "Bearer corp-token", "X-Team": "platform" },
    });
    expect(config.meta.credentialSource).toBe("custom-headers");
    expect(config.meta.customHeaderNames).toEqual(["Authorization", "X-Team"]);
    expect(JSON.stringify(config.meta)).not.toContain("corp-token");
  });

  it("refuses a settings file that points Claude Code at another wire format", () => {
    const settings = (value: string) => ({ env: { ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_USE_BEDROCK: value } });

    expect(() => withSettings(settings("1"))).toThrow(/Amazon Bedrock/);
    expect(() => withSettings(settings("true"))).toThrow(ConfigError);
    expect(withSettings(settings("")).config.warnings).toEqual([]);
    expect(withSettings(settings("0")).config.warnings).toEqual([]);
  });

  it("only warns when the shell has a provider flag set", () => {
    const { config } = resolve({}, { env: { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_API_KEY: "k" } });

    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toContain("Google Vertex AI");
  });

  it("reports unreadable or malformed settings files", () => {
    expect(() => resolve({ claudeSettingsPath: "/missing.json" })).toThrow(/Nie można odczytać/);
    expect(() => withSettings("{ not json")).toThrow(/poprawnym JSON-em/);
    expect(() => withSettings("[]")).toThrow(/obiektu JSON/);
  });

  it("warns about settings Node only reads at startup", () => {
    const settings = {
      env: { ANTHROPIC_AUTH_TOKEN: "t", NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem", HTTPS_PROXY: "http://proxy:3128" },
    };

    const { config } = withSettings(settings);
    expect(config.warnings).toHaveLength(2);
    expect(config.warnings[0]).toContain("NODE_EXTRA_CA_CERTS");
    expect(config.warnings[1]).toContain("proxy");

    const alreadySet = withSettings(settings, { NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem" });
    expect(alreadySet.config.warnings).toHaveLength(1);
  });

  describe("model", () => {
    const model = (options: ConfigOptions, env: Record<string, string>) => {
      const { meta } = resolve(options, { env }).config;
      return [meta.model, meta.modelSource];
    };

    it("prefers --model, then HUBBER_MODEL, then the Claude Code variables in order", () => {
      const env = {
        HUBBER_MODEL: "hub-model-1",
        ANTHROPIC_MODEL: "router-opus-5",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "router-opus-default",
      };

      expect(model({ model: "explicit-model" }, env)).toEqual(["explicit-model", "--model"]);
      expect(model({}, env)).toEqual(["hub-model-1", "HUBBER_MODEL"]);
      expect(model({}, { ...env, HUBBER_MODEL: "" })).toEqual(["router-opus-5", "ANTHROPIC_MODEL"]);
      expect(model({}, { ANTHROPIC_DEFAULT_SONNET_MODEL: "router-sonnet-5" })).toEqual([
        "router-sonnet-5",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
      ]);
    });

    it("skips Claude Code aliases and strips the context-window suffix", () => {
      expect(model({}, { ANTHROPIC_MODEL: "opus", ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8[1m]" })).toEqual([
        "claude-opus-4-8",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
      ]);
      expect(model({}, { ANTHROPIC_MODEL: "sonnet[1m]" })).toEqual(["claude-opus-5-5", "domyślny"]);
    });

    it("passes an explicit --model through unchanged", () => {
      expect(model({ model: "opus" }, {})).toEqual(["opus", "--model"]);
    });

    it("names the settings file as the source", () => {
      const { config } = withSettings({
        env: { ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_MODEL: "bedrock/anthropic.claude-opus-5-5" },
      });

      expect(config.meta.model).toBe("bedrock/anthropic.claude-opus-5-5");
      expect(config.meta.modelSource).toBe("ANTHROPIC_MODEL z pliku ustawień");
    });
  });

  it("redacts the endpoint and derives a neutral label", () => {
    const { config } = resolve(
      { redactEndpoint: true },
      { env: { ANTHROPIC_BASE_URL: "https://router.corp.example" } },
    );

    expect(config.meta.endpoint).toBeNull();
    expect(config.meta.label).toBe("endpoint");
    expect(config.client.baseURL).toBe("https://router.corp.example");
  });

  it("makes any label safe to use in a file name", () => {
    const { config } = resolve({ label: "praca / router #1" });

    expect(config.meta.label).toBe("praca-router-1");
  });
});
