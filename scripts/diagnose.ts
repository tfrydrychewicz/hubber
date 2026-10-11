// Endpoint diagnostics (docs/PLAN.md, M1a-1): checks which parts of the
// Anthropic Messages API a given endpoint actually supports.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { createRedactor } from "../src/server/llm/credentials/secret.ts";
import { ConfigError, type ResolvedConfig, resolveConfig } from "../src/server/llm/diagnostics/config.ts";
import { renderGroupTitle, renderHeader, renderResult, renderSummary } from "../src/server/llm/diagnostics/report.ts";
import { runDiagnostics } from "../src/server/llm/diagnostics/run.ts";
import { CHECK_IDS, type CheckGroup, type CheckId } from "../src/server/llm/diagnostics/types.ts";

const EXIT_CORE_NOT_READY = 1;
const EXIT_USAGE = 2;
const DEFAULT_TIMEOUT_SECONDS = 180;
// A shorter value is a stand-in for a gateway that checks nothing ("x", "dummy"), not a secret,
// and replacing every occurrence of one would garble the report.
const MIN_CREDENTIAL_LENGTH = 8;

const USAGE = `Diagnostyka endpointu LLM: sprawdza, które funkcje Anthropic Messages API działają.

Użycie:
  npm run diagnose -- [opcje]

Połączenie:
  Domyślnie ze zmiennych środowiskowych ANTHROPIC_BASE_URL oraz
  ANTHROPIC_API_KEY lub ANTHROPIC_AUTH_TOKEN (i opcjonalnie ANTHROPIC_CUSTOM_HEADERS).

  --claude-settings <plik>     wczytaj połączenie z pliku ustawień Claude Code (blok "env"
                               i "apiKeyHelper"); zmienne połączenia z powłoki są wtedy pomijane
  --credential-command <cmd>   polecenie wypisujące token; uruchamiane przez /bin/sh
  --model <id>                 identyfikator modelu na endpoincie

Zakres:
  --only <id,id>               uruchom tylko wskazane testy
  --skip <id,id>               pomiń wskazane testy
  --timeout <sekundy>          limit czasu jednego żądania (domyślnie ${DEFAULT_TIMEOUT_SECONDS})

Wynik:
  --out <plik>                 ścieżka pliku JSON (domyślnie diagnostics/<etykieta>-<data>.json)
  --label <nazwa>              etykieta w nazwie pliku i w raporcie (domyślnie host endpointu)
  --redact-endpoint            nie zapisuj adresu endpointu w raporcie
  --no-file                    nie zapisuj pliku
  --json                       wypisz raport JSON zamiast tabeli
  --help                       pokaż tę pomoc

Testy: ${CHECK_IDS.join(", ")}

Kod wyjścia: 0 gdy rdzeń działa, 1 gdy nie, 2 przy błędzie konfiguracji.
Testy wysyłają wyłącznie wbudowane dane syntetyczne.`;

function fail(message: string): never {
  console.error(message);
  process.exit(EXIT_USAGE);
}

function parseCheckList(value: string | undefined, flag: string): CheckId[] | undefined {
  if (value === undefined) return undefined;
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const unknown = ids.filter((id) => !(CHECK_IDS as readonly string[]).includes(id));
  if (unknown.length > 0) fail(`Nieznany test w ${flag}: ${unknown.join(", ")}. Dostępne: ${CHECK_IDS.join(", ")}`);
  return ids as CheckId[];
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

function timestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Every value this run sends that may be a credential: the key, the token, and the value of
 * every custom header. Which of the custom headers carries a secret cannot be told from its
 * name (a gateway's own token, a cookie, a proxy password), so all of them count.
 *
 * All but those that the report states itself as its address or its model, in its first lines
 * and for the command that creates a workspace from it: such a value is no secret, and hiding it
 * would leave a report that names neither.
 */
function sentCredentials({ client, meta }: ResolvedConfig): string[] {
  const stated = [meta.endpoint ?? "", meta.model];
  const carried: string[] = [];
  for (const [name, value] of Object.entries(client.defaultHeaders)) {
    const header = name.toLowerCase();
    // Without the scheme: an endpoint may repeat only what follows "Bearer" or "Basic".
    if (header === "authorization" || header === "proxy-authorization") carried.push(value.replace(/^\S+\s+/, ""));
    else carried.push(value);
    // And each cookie by itself: an endpoint may repeat only the one it did not accept.
    if (header === "cookie") carried.push(...value.split(";").map((pair) => pair.slice(pair.indexOf("=") + 1).trim()));
  }
  return [
    client.apiKey,
    client.authToken,
    ...carried.filter((value) => !stated.some((text) => text.includes(value))),
  ].filter((value): value is string => typeof value === "string" && value.length >= MIN_CREDENTIAL_LENGTH);
}

/** An error response with its body passed through `redact`. */
async function withRedactedBody(response: Response, redact: (text: string) => string): Promise<Response> {
  // A status without a body (304) has nothing to clean and cannot be given one.
  if (response.ok || response.body === null) return response;
  const body = redact(await response.text());
  const headers = new Headers(response.headers);
  // They described the original bytes.
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function parseCliArgs() {
  try {
    return parseArgs({
      options: {
        "claude-settings": { type: "string" },
        "credential-command": { type: "string" },
        model: { type: "string" },
        only: { type: "string" },
        skip: { type: "string" },
        timeout: { type: "string" },
        out: { type: "string" },
        label: { type: "string" },
        "redact-endpoint": { type: "boolean", default: false },
        "no-file": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    }).values;
  } catch (err) {
    fail(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  }
}

async function main(): Promise<void> {
  const values = parseCliArgs();
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const only = parseCheckList(values.only, "--only");
  const skip = parseCheckList(values.skip, "--skip");
  const timeoutSeconds = values.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(values.timeout);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) fail(`Niepoprawna wartość --timeout: ${values.timeout}`);

  let config: ResolvedConfig;
  try {
    config = resolveConfig(
      {
        ...(values.model !== undefined && { model: values.model }),
        ...(values["claude-settings"] !== undefined && { claudeSettingsPath: expandHome(values["claude-settings"]) }),
        ...(values["credential-command"] !== undefined && { credentialCommand: values["credential-command"] }),
        ...(values.label !== undefined && { label: values.label }),
        redactEndpoint: values["redact-endpoint"],
      },
      {
        env: process.env,
        readFile: (path) => readFileSync(path, "utf8"),
        // stderr stays attached to the terminal so the helper's own errors are visible.
        runCommand: (command) =>
          execFileSync("/bin/sh", ["-c", command], {
            encoding: "utf8",
            timeout: 30_000,
            stdio: ["ignore", "pipe", "inherit"],
          }),
      },
    );
  } catch (err) {
    if (err instanceof ConfigError) fail(err.message);
    throw err;
  }

  // Replaces every occurrence of the credentials in a text, also where JSON or a URL spells them
  // with escapes. An endpoint may repeat the credential it refused, and its error texts end up in
  // the terminal and in the report.
  const redact = createRedactor(sentCredentials(config));

  // The SDK merges this variable into its headers on its own. Headers are passed
  // explicitly below, so the variable must not leak in from the shell.
  delete process.env.ANTHROPIC_CUSTOM_HEADERS;
  const client = new Anthropic({
    baseURL: config.client.baseURL,
    apiKey: config.client.apiKey,
    authToken: config.client.authToken,
    defaultHeaders: config.client.defaultHeaders,
    timeout: timeoutSeconds * 1000,
    maxRetries: 1,
    // An error body is cleaned before the SDK builds its error from it: parsed first, a
    // credential that the body spells with JSON escapes would be the credential itself again.
    //
    // A redirect is not followed. fetch() would repeat the request at the new address with its
    // body and its headers, of which it takes away Authorization and leaves x-api-key and every
    // custom one; and the report would vouch for an address at which the application, which
    // follows no redirect either, gets no answer.
    fetch: async (input, init) => withRedactedBody(await fetch(input, { ...init, redirect: "manual" }), redact),
  });

  const quiet = values.json;
  // For the lines of the table that quote the endpoint.
  const print = (text: string) => console.log(redact(text));
  if (!quiet) {
    console.log(renderHeader(config.meta));
    for (const warning of config.warnings) console.log(`  Uwaga: ${warning}`);
  }

  let currentGroup: CheckGroup | undefined;
  const report = await runDiagnostics({
    client,
    meta: config.meta,
    // The diagnostics shorten what the endpoint says. They clean it first, because a cut
    // through a credential would leave a part of it that the cleaning below cannot recognise.
    redact,
    ...(only && { only }),
    ...(skip && { skip }),
    onCheckDone: (result) => {
      if (quiet) return;
      if (result.group !== currentGroup) {
        currentGroup = result.group;
        console.log(renderGroupTitle(result.group));
      }
      print(renderResult(result));
    },
  });

  // Every text of the report is cleaned, whatever way a credential took into it. The texts and
  // not the JSON made of them: there a credential with a line break in it is spelled differently,
  // and a stand-in key that is a word of the report's own would take the names of its fields.
  const serialized = JSON.stringify(report, (_name, value) => (typeof value === "string" ? redact(value) : value), 2);
  let outPath: string | undefined;
  if (!values["no-file"]) {
    outPath = resolve(values.out ?? join("diagnostics", `${config.meta.label}-${timestamp(new Date())}.json`));
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${serialized}\n`);
  }

  if (quiet) {
    console.log(serialized);
  } else {
    print(renderSummary(report));
    if (outPath) {
      console.log(`\nRaport: ${outPath}`);
      console.log("Raport nie zawiera poświadczeń. Przejrzyj treść błędów, zanim przekażesz go dalej.");
    }
  }

  // A partial run (--only/--skip) passes when nothing it ran from the core failed.
  const coreFailed = report.checks.some((check) => check.group === "core" && check.status !== "confirmed");
  if (coreFailed) process.exitCode = EXIT_CORE_NOT_READY;
}

await main();
