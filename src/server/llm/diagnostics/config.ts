import type { CredentialSource, ReportMeta } from "./types.ts";

export const DEFAULT_ENDPOINT = "https://api.anthropic.com";
export const DEFAULT_MODEL = "claude-opus-5-5";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface ConfigOptions {
  model?: string;
  claudeSettingsPath?: string;
  credentialCommand?: string;
  label?: string;
  redactEndpoint?: boolean;
}

export interface ConfigDeps {
  env: Readonly<Record<string, string | undefined>>;
  readFile: (path: string) => string;
  runCommand: (command: string) => string;
}

export interface ClientSettings {
  baseURL: string;
  // null switches the header off; undefined lets the SDK resolve credentials itself
  apiKey: string | null | undefined;
  authToken: string | null | undefined;
  defaultHeaders: Record<string, string>;
}

export interface ResolvedConfig {
  client: ClientSettings;
  meta: ReportMeta;
  warnings: string[];
}

// Claude Code switches to another wire format when one of these is on.
const PROVIDER_FLAGS: Record<string, string> = {
  CLAUDE_CODE_USE_BEDROCK: "Amazon Bedrock",
  CLAUDE_CODE_USE_MANTLE: "Amazon Bedrock (Mantle)",
  CLAUDE_CODE_USE_VERTEX: "Google Vertex AI",
  CLAUDE_CODE_USE_FOUNDRY: "Microsoft Foundry",
};

const MODEL_VARIABLES = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];

const PROXY_VARIABLES = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isOn(value: string | undefined): boolean {
  return value !== undefined && !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

// Claude Code accepts aliases ("opus") and a "[1m]" context suffix; neither is an API model id.
function asModelId(value: string | undefined): string | undefined {
  const id = nonEmpty(value)?.replace(/\[[^\]]*\]$/, "");
  return id && !/^[a-z]+$/i.test(id) ? id : undefined;
}

// Same format the SDK and Claude Code use: one "Name: value" pair per line.
function parseHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of (raw ?? "").split("\n")) {
    const colon = line.indexOf(":");
    const name = colon > 0 ? line.slice(0, colon).trim() : "";
    if (name) headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

function normalizeEndpoint(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError(`ANTHROPIC_BASE_URL nie jest poprawnym adresem: ${baseUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`ANTHROPIC_BASE_URL musi zaczynać się od http:// lub https://: ${baseUrl}`);
  }
  // Drops query strings and any credentials embedded in the URL.
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

interface ClaudeSettings {
  env: Record<string, string>;
  apiKeyHelper?: string;
}

function loadClaudeSettings(path: string, deps: ConfigDeps): ClaudeSettings {
  let raw: string;
  try {
    raw = deps.readFile(path);
  } catch {
    throw new ConfigError(`Nie można odczytać pliku ustawień: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`Plik ustawień nie jest poprawnym JSON-em: ${path}`);
  }
  if (!isRecord(parsed)) throw new ConfigError(`Plik ustawień nie zawiera obiektu JSON: ${path}`);

  const env: Record<string, string> = {};
  if (isRecord(parsed.env)) {
    for (const [name, value] of Object.entries(parsed.env)) {
      if (typeof value === "string") env[name] = value;
      else if (typeof value === "number" || typeof value === "boolean") env[name] = String(value);
    }
  }
  const settings: ClaudeSettings = { env };
  const helper = typeof parsed.apiKeyHelper === "string" ? nonEmpty(parsed.apiKeyHelper) : undefined;
  if (helper) settings.apiKeyHelper = helper;
  return settings;
}

function credentialFrom(command: string, origin: string, deps: ConfigDeps): string {
  let output: string;
  try {
    output = deps.runCommand(command);
  } catch {
    throw new ConfigError(`Polecenie poświadczeń (${origin}) zakończyło się błędem.`);
  }
  const token = output.trim();
  if (!token) throw new ConfigError(`Polecenie poświadczeń (${origin}) nie zwróciło tokenu.`);
  return token;
}

export function resolveConfig(options: ConfigOptions, deps: ConfigDeps): ResolvedConfig {
  const warnings: string[] = [];
  const settings = options.claudeSettingsPath ? loadClaudeSettings(options.claudeSettingsPath, deps) : undefined;

  // With a settings file, connection variables come from that file alone. Mixing
  // it with the shell could send a personal key to the corporate router, or a
  // corporate token to the public API.
  const connection = settings ? settings.env : deps.env;
  const origin = settings ? "plik ustawień" : "środowisko";

  for (const [flag, provider] of Object.entries(PROVIDER_FLAGS)) {
    if (!isOn(connection[flag])) continue;
    const message = `${flag} jest włączone (${origin}): Claude Code łączy się w formacie ${provider}, a ta diagnostyka sprawdza tylko format Anthropic Messages.`;
    if (settings) throw new ConfigError(message);
    warnings.push(message);
  }

  const baseUrl = nonEmpty(connection.ANTHROPIC_BASE_URL);
  const endpoint = baseUrl ? normalizeEndpoint(baseUrl) : DEFAULT_ENDPOINT;
  const defaultHeaders = parseHeaders(connection.ANTHROPIC_CUSTOM_HEADERS);

  const envToken = nonEmpty(connection.ANTHROPIC_AUTH_TOKEN);
  const envKey = nonEmpty(connection.ANTHROPIC_API_KEY);
  let apiKey: string | null | undefined;
  let authToken: string | null | undefined;
  let credentialSource: CredentialSource;
  if (options.credentialCommand) {
    // Claude Code sends a helper's value in both headers; gateways rely on either.
    apiKey = authToken = credentialFrom(options.credentialCommand, "--credential-command", deps);
    credentialSource = "credential-command";
  } else if (envToken || envKey) {
    authToken = envToken ?? null;
    apiKey = envKey ?? null;
    credentialSource = envToken ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY";
  } else if (settings?.apiKeyHelper) {
    apiKey = authToken = credentialFrom(settings.apiKeyHelper, "apiKeyHelper", deps);
    credentialSource = "apiKeyHelper";
  } else if (settings) {
    const headerNames = Object.keys(defaultHeaders).map((name) => name.toLowerCase());
    if (!headerNames.includes("authorization") && !headerNames.includes("x-api-key")) {
      throw new ConfigError(
        "Plik ustawień nie zawiera poświadczeń (ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY ani apiKeyHelper). " +
          "Jeśli Claude Code loguje się do routera kontem claude.ai, podaj token opcją --credential-command.",
      );
    }
    apiKey = authToken = null;
    credentialSource = "custom-headers";
  } else {
    credentialSource = "sdk-default";
  }

  let model = nonEmpty(options.model);
  let modelSource = "--model";
  if (!model) {
    const candidates: Array<[string | undefined, string]> = [
      [deps.env.HUBBER_MODEL, "HUBBER_MODEL"],
      ...MODEL_VARIABLES.map((name): [string | undefined, string] => [
        connection[name],
        settings ? `${name} z pliku ustawień` : name,
      ]),
    ];
    const found = candidates.find(([value]) => asModelId(value));
    model = asModelId(found?.[0]) ?? DEFAULT_MODEL;
    modelSource = found?.[1] ?? "domyślny";
  }

  if (settings) {
    if (settings.env.NODE_EXTRA_CA_CERTS && deps.env.NODE_EXTRA_CA_CERTS !== settings.env.NODE_EXTRA_CA_CERTS) {
      warnings.push(
        "Plik ustawień definiuje NODE_EXTRA_CA_CERTS. Node czyta tę zmienną tylko przy starcie, więc ustaw ją w powłoce przed uruchomieniem diagnostyki.",
      );
    }
    if (PROXY_VARIABLES.some((name) => settings.env[name])) {
      warnings.push(
        "Plik ustawień definiuje proxy. Diagnostyka łączy się bezpośrednio; jeśli endpoint jest osiągalny tylko przez proxy, testy zakończą się błędem połączenia.",
      );
    }
  }

  const redact = options.redactEndpoint ?? false;
  const label = (nonEmpty(options.label) ?? (redact ? "endpoint" : new URL(endpoint).host)).replace(
    /[^A-Za-z0-9._-]+/g,
    "-",
  );

  return {
    client: { baseURL: baseUrl ?? DEFAULT_ENDPOINT, apiKey, authToken, defaultHeaders },
    meta: {
      endpoint: redact ? null : endpoint,
      endpointIsDefault: !baseUrl,
      credentialSource,
      customHeaderNames: Object.keys(defaultHeaders),
      model,
      modelSource,
      label,
    },
    warnings,
  };
}
