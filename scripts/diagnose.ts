// Endpoint diagnostics (docs/PLAN.md, M1a-1): checks which parts of the
// Anthropic Messages API a given endpoint actually supports.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { ConfigError, resolveConfig } from "../src/server/llm/diagnostics/config.ts";
import { renderGroupTitle, renderHeader, renderResult, renderSummary } from "../src/server/llm/diagnostics/report.ts";
import { runDiagnostics } from "../src/server/llm/diagnostics/run.ts";
import { CHECK_IDS, type CheckGroup, type CheckId } from "../src/server/llm/diagnostics/types.ts";

const EXIT_CORE_NOT_READY = 1;
const EXIT_USAGE = 2;
const DEFAULT_TIMEOUT_SECONDS = 180;

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
  const ids = value.split(",").map((id) => id.trim()).filter(Boolean);
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

async function main(): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({
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
    }));
  } catch (err) {
    fail(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  }
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const only = parseCheckList(values.only, "--only");
  const skip = parseCheckList(values.skip, "--skip");
  const timeoutSeconds = values.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(values.timeout);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) fail(`Niepoprawna wartość --timeout: ${values.timeout}`);

  let config;
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
          execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "inherit"] }),
      },
    );
  } catch (err) {
    if (err instanceof ConfigError) fail(err.message);
    throw err;
  }

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
  });

  const quiet = values.json;
  if (!quiet) {
    console.log(renderHeader(config.meta));
    for (const warning of config.warnings) console.log(`  Uwaga: ${warning}`);
  }

  let currentGroup: CheckGroup | undefined;
  const report = await runDiagnostics({
    client,
    meta: config.meta,
    ...(only && { only }),
    ...(skip && { skip }),
    onCheckDone: (result) => {
      if (quiet) return;
      if (result.group !== currentGroup) {
        currentGroup = result.group;
        console.log(renderGroupTitle(result.group));
      }
      console.log(renderResult(result));
    },
  });

  let outPath: string | undefined;
  if (!values["no-file"]) {
    outPath = resolve(values.out ?? join("diagnostics", `${config.meta.label}-${timestamp(new Date())}.json`));
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (quiet) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderSummary(report));
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
