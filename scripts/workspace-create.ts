// Creates a workspace (docs/PLAN.md, M1a-3): a directory with a configuration file, an empty
// database and a directory for files, pinned to one LLM endpoint. Never touches an existing
// directory, never reads a credential, and never connects anywhere.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { EXIT_USAGE } from "../src/server/exit-codes.ts";
import { AUTH_SCHEMES, type AuthScheme } from "../src/server/llm/credentials/types.ts";
import { DEFAULT_MODEL } from "../src/server/llm/diagnostics/config.ts";
import { ANTHROPIC_ENDPOINT, EndpointError, parseEndpoint } from "../src/server/llm/endpoint.ts";
import {
  authProblem,
  type Capabilities,
  cleanName,
  kindProblem,
  type LlmProfile,
  MODEL_ROLES,
  type ModelRole,
  modelIdProblem,
  NAME_MAX_LENGTH,
  nameProblem,
  PROFILE_KINDS,
  type ProfileKind,
  type ProfileModels,
  type WorkspaceConfig,
} from "../src/server/workspace/config.ts";
import { createWorkspace } from "../src/server/workspace/create.ts";
import {
  DiagnosticsReportError,
  type ReportSummary,
  summarizeReport,
} from "../src/server/workspace/diagnostics-summary.ts";
import { WorkspaceError } from "../src/server/workspace/errors.ts";
import { REPOSITORY_ROOT } from "../src/server/workspace/layout.ts";
import {
  expandHome,
  locateWorkspace,
  resolveWorkspaceDir,
  WORKSPACE_VARIABLE,
  WorkspaceLocationError,
} from "../src/server/workspace/location.ts";

const USAGE = `Tworzy workspace: katalog danych przypięty do jednego endpointu LLM.

Użycie:
  npm run workspace:create -- --name <nazwa> --kind <anthropic|router> [opcje]

Wymagane:
  --name <nazwa>               nazwa widoczna w interfejsie (do ${NAME_MAX_LENGTH} znaków)
  --kind <anthropic|router>    rodzaj profilu: bezpośrednie API Anthropic albo firmowy router
                               w formacie Anthropic Messages

Endpoint i modele:
  --endpoint <adres>           adres routera (https://…); przy raporcie diagnostyki można go
                               pominąć, a profil anthropic ma adres stały
  --auth <bearer|x-api-key>    jak router przyjmuje poświadczenie: token w nagłówku Authorization
                               (domyślnie) albo klucz w nagłówku x-api-key
  --model <id>                 model dla wszystkich ról (anthropic: domyślnie ${DEFAULT_MODEL};
                               router: domyślnie model z raportu diagnostyki)
  --model-processing <id>      inny model dla przetwarzania
  --model-conversation <id>    inny model dla rozmowy
  --model-synthesis <id>       inny model dla syntezy
  --diagnostics <plik>         raport z "npm run diagnose"; jego wynik trafia do profilu

Miejsce:
  --dir <katalog>              katalog workspace'u; domyślnie ten, który otworzy "npm start":
                               zmienna ${WORKSPACE_VARIABLE}, a bez niej
                               ~/Library/Application Support/Hubber/workspaces/default
  --help                       pokaż tę pomoc

Polecenie tworzy wyłącznie nowy katalog, nie zapisuje poświadczeń i z niczym się nie łączy.
Kod wyjścia: 0 po utworzeniu, 1 gdy się nie udało (nic nie zostaje na dysku), 2 przy błędnych opcjach.`;

const OPTIONS = {
  name: { type: "string" },
  kind: { type: "string" },
  endpoint: { type: "string" },
  auth: { type: "string" },
  model: { type: "string" },
  "model-processing": { type: "string" },
  "model-conversation": { type: "string" },
  "model-synthesis": { type: "string" },
  diagnostics: { type: "string" },
  dir: { type: "string" },
  help: { type: "boolean" },
} as const;

type ValueOption = Exclude<keyof typeof OPTIONS, "help">;
type Values = { help: boolean } & { [Option in ValueOption]?: string };

/** A bad option: says what is wrong, points at the help, changes nothing. */
function usageError(message: string): never {
  console.error(`${message}\nPomoc: npm run workspace:create -- --help`);
  process.exit(EXIT_USAGE);
}

/**
 * The options as given. parseArgs() only cuts the command line into pieces here; what is wrong
 * with a piece is decided below, because its own complaints are English sentences, and the one
 * thing to take from them, the name of the option, would have to be cut out of their wording.
 */
function parseCliArgs(): Values {
  const { tokens } = parseArgs({ options: OPTIONS, strict: false, tokens: true });
  const values: Values = { help: false };
  for (const token of tokens) {
    if (token.kind === "positional") {
      usageError(
        `Nieoczekiwany argument: "${token.value}". Każdą wartość poprzedza nazwa opcji; wartość ze spacjami ujmij w cudzysłów.`,
      );
    }
    // What is left besides options is the "--" that ends them.
    if (token.kind !== "option") continue;
    if (!Object.hasOwn(OPTIONS, token.name)) usageError(`Nieznana opcja: ${token.rawName}.`);
    const option = token.name as keyof typeof OPTIONS;
    if (option === "help") {
      values.help = true;
      continue;
    }
    // parseArgs() takes whatever follows an option for its value. When that is the name of
    // the next option, the value was left out.
    const value = token.value;
    if (value === undefined || (!token.inlineValue && value.length > 1 && value.startsWith("-"))) {
      usageError(
        `Opcja ${token.rawName} wymaga wartości. Wartość zaczynającą się od "-" podaj w postaci ${token.rawName}=wartość.`,
      );
    }
    // The last of two values would win without a word. For an address that is about to be
    // pinned, the second one may be the mistake.
    if (values[option] !== undefined) usageError(`Opcja --${option} została podana więcej niż raz.`);
    values[option] = value;
  }
  return values;
}

function readReport(path: string | undefined): ReportSummary | undefined {
  if (path === undefined) return undefined;
  let text: string;
  try {
    // A relative path is fine here, unlike for --dir: npm runs the script in the root of the
    // repository, and that is where "npm run diagnose" writes its reports.
    text = readFileSync(resolve(expandHome(path, process.env) ?? path), "utf8");
  } catch {
    usageError(`Nie można odczytać raportu diagnostyki: ${path}`);
  }
  try {
    return summarizeReport(text);
  } catch (error) {
    if (error instanceof DiagnosticsReportError) usageError(`${error.message} (${path})`);
    throw error;
  }
}

function resolveEndpoint(kind: ProfileKind, values: Values, report: ReportSummary | undefined): string {
  let fromReport: string | undefined;
  let endpoint: string | undefined;
  try {
    if (report?.endpoint != null) fromReport = parseEndpoint(report.endpoint).href;
    if (values.endpoint !== undefined) endpoint = parseEndpoint(values.endpoint).href;
  } catch (error) {
    // The message names the address itself, without a password or a query string.
    if (error instanceof EndpointError) usageError(`Tego adresu nie da się przypiąć. ${error.message}`);
    throw error;
  }
  if (endpoint !== undefined && fromReport !== undefined && endpoint !== fromReport) {
    usageError(
      `Raport diagnostyki dotyczy endpointu ${fromReport}, a opcja --endpoint wskazuje ${endpoint}. Workspace przypina się do jednego adresu.`,
    );
  }
  endpoint ??= fromReport ?? (kind === "anthropic" ? ANTHROPIC_ENDPOINT : undefined);
  if (endpoint === undefined) {
    usageError(
      'Profil "router" wymaga adresu: podaj go opcją --endpoint albo dołącz raport diagnostyki opcją --diagnostics.',
    );
  }
  const mismatch = kindProblem(kind, endpoint);
  if (mismatch !== undefined) usageError(`Niepoprawny adres endpointu: ${mismatch}.`);
  return endpoint;
}

function resolveAuth(kind: ProfileKind, values: Values): AuthScheme {
  if (values.auth === undefined) return kind === "anthropic" ? "x-api-key" : "bearer";
  if (!(AUTH_SCHEMES as readonly string[]).includes(values.auth)) {
    // The value is not repeated: this is the option after which a credential gets pasted by mistake.
    usageError(
      `Niepoprawna wartość --auth. Dozwolone: ${AUTH_SCHEMES.join(", ")}. Poświadczeń nie podaje się w poleceniu.`,
    );
  }
  const mismatch = authProblem(kind, values.auth as AuthScheme);
  if (mismatch !== undefined) usageError(`Niepoprawna wartość --auth: ${mismatch}.`);
  return values.auth as AuthScheme;
}

function resolveModels(kind: ProfileKind, values: Values, report: ReportSummary | undefined): ProfileModels {
  const common = values.model ?? report?.diagnostics.model ?? (kind === "anthropic" ? DEFAULT_MODEL : undefined);
  if (common === undefined) {
    usageError('Profil "router" wymaga identyfikatora modelu: podaj go opcją --model albo dołącz raport diagnostyki.');
  }
  const models: ProfileModels = { default: common };
  for (const role of MODEL_ROLES) {
    const id = values[`model-${role}`];
    // A role that names the common model is not an exception to it.
    if (id !== undefined && id !== common) models[role] = id;
  }
  for (const [option, id] of [
    ["--model", common],
    ...MODEL_ROLES.map((role) => [`--model-${role}`, models[role]]),
  ] as const) {
    const problem = id === undefined ? undefined : modelIdProblem(id);
    if (problem !== undefined) usageError(`Niepoprawna wartość ${option}: ${problem}.`);
  }
  if (report !== undefined && report.diagnostics.model !== common) {
    usageError(
      `Raport diagnostyki dotyczy modelu ${report.diagnostics.model}, a workspace ma używać ${common}. Uruchom diagnostykę dla tego modelu albo pomiń --diagnostics.`,
    );
  }
  return models;
}

const ROLE_NAMES: Record<ModelRole, string> = {
  processing: "przetwarzanie",
  conversation: "rozmowa",
  synthesis: "synteza",
};

function describeModels(models: ProfileModels): string {
  const others = MODEL_ROLES.filter((role) => models[role] !== undefined).map(
    (role) => `${ROLE_NAMES[role]}: ${models[role]}`,
  );
  return others.length === 0 ? `${models.default} (wszystkie role)` : `${models.default}; ${others.join(", ")}`;
}

function describeDiagnostics({ diagnostics }: LlmProfile): string {
  if (diagnostics === null) return "brak; funkcje opcjonalne pozostają wyłączone";
  const yesNo = (value: boolean) => (value ? "tak" : "nie");
  const { promptCache, effort, thinking, pdfInput }: Capabilities = diagnostics.capabilities;
  return `z ${diagnostics.checkedAt.slice(0, 10)}: cache_control ${yesNo(promptCache)}, effort ${yesNo(effort)}, thinking ${yesNo(thinking)}, PDF ${yesNo(pdfInput)}`;
}

/**
 * A text as one word of a shell command that stands for exactly that text. The line it goes into
 * is printed to be copied into a terminal, and a directory may be named anything: inside double
 * quotes a shell still replaces "$" and backticks, ends the word at a double quote and, when it
 * is interactive, expands "!". Inside single quotes it acts on nothing.
 */
function shellWord(text: string): string {
  return /["$`\\!]/.test(text) ? `'${text.replaceAll("'", "'\\''")}'` : `"${text}"`;
}

/**
 * True for a directory in this checkout. Compared by real paths, so that a link into the
 * repository counts too; the directory itself does not exist yet, so its nearest existing
 * parent stands in for it. The real path is the one the system gives (realpathSync.native):
 * on a volume that ignores letter case, the other one keeps the spelling it was handed, and
 * the repository typed in other letters would pass for another directory.
 */
function isInsideRepository(dir: string): boolean {
  let existing = dir;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const real = join(realpathSync.native(existing), relative(existing, dir));
  const fromRoot = relative(realpathSync.native(REPOSITORY_ROOT), real);
  // Outside is what leads up and out. A name that merely starts with two dots is inside.
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function main(): void {
  // Everything this process creates is for the owner alone, whatever the shell's umask.
  process.umask(0o077);

  // Without the "--" npm keeps the options for itself. Those written as "--name=value" vanish
  // whole and the script gets nothing; of those written as "--name value" it gets the values,
  // which would be reported as stray arguments. npm says what it kept: each option is in the
  // environment as npm_config_<name>, and none of these names is a setting of npm's own.
  const kept = Object.keys(OPTIONS).filter(
    (option) => process.env[`npm_config_${option.replaceAll("-", "_")}`] !== undefined,
  );
  if (kept.length > 0) {
    usageError(
      `npm zabrał dla siebie: ${kept.map((option) => `--${option}`).join(", ")}. Opcje polecenia podaje się po "--".`,
    );
  }
  if (process.argv.length === 2) usageError('Nie podano opcji. Opcje polecenia podaje się po "--".');
  const values = parseCliArgs();
  if (values.help) {
    console.log(USAGE);
    return;
  }

  if (values.name === undefined) usageError("Podaj nazwę workspace'u opcją --name.");
  const name = cleanName(values.name);
  const badName = nameProblem(name);
  if (badName !== undefined) usageError(`Niepoprawna wartość --name: ${badName}.`);

  if (values.kind === undefined) usageError(`Podaj rodzaj profilu opcją --kind: ${PROFILE_KINDS.join(" albo ")}.`);
  if (!(PROFILE_KINDS as readonly string[]).includes(values.kind)) {
    usageError(`Niepoprawna wartość --kind: "${values.kind}". Dozwolone: ${PROFILE_KINDS.join(", ")}.`);
  }
  const kind = values.kind as ProfileKind;

  const report = readReport(values.diagnostics);
  if (report !== undefined && !report.diagnostics.coreReady) {
    usageError(
      "Raport diagnostyki nie potwierdza rdzenia (pełny zestaw testów nie przeszedł albo uruchomiono tylko część). Uruchom pełną diagnostykę albo pomiń --diagnostics.",
    );
  }
  const endpoint = resolveEndpoint(kind, values, report);
  const auth = resolveAuth(kind, values);
  const models = resolveModels(kind, values, report);

  let dir: string;
  let isDefault = false;
  try {
    if (values.dir !== undefined) dir = resolveWorkspaceDir(values.dir, "--dir", process.env);
    else {
      const location = locateWorkspace(process.env);
      dir = location.dir;
      isDefault = location.source === "default";
    }
  } catch (error) {
    if (error instanceof WorkspaceLocationError) usageError(error.message);
    throw error;
  }

  // Workspaces live outside the repository (docs/PLAN.md). The repository is public, and a
  // directory inside it is one "git add" away from being published.
  if (isInsideRepository(dir)) {
    usageError(
      `Katalog "${dir}" leży w repozytorium Hubbera, a dane workspace'u muszą leżeć poza nim. Wskaż inny katalog.`,
    );
  }

  const profile: LlmProfile = { kind, endpoint, auth, models, diagnostics: report?.diagnostics ?? null };

  // The creation is synchronous, so with these handlers in place a Ctrl-C waits until it is
  // over: the workspace is then whole, and the lines below say so.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => {});

  let config: WorkspaceConfig;
  try {
    config = createWorkspace({ dir, name, profile });
  } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
    console.error(error.message);
    process.exit(error.exitCode);
  }

  console.log(`Utworzono workspace „${config.name}” w katalogu "${dir}".`);
  console.log(`  Profil:            ${kind}`);
  console.log(`  Endpoint:          ${endpoint}`);
  console.log(
    `  Uwierzytelnianie:  ${auth === "bearer" ? "token w nagłówku Authorization" : "klucz w nagłówku x-api-key"}`,
  );
  console.log(`  Modele:            ${describeModels(models)}`);
  console.log(`  Diagnostyka:       ${describeDiagnostics(profile)}`);
  const unlisted = [...new Set(Object.values(models))].filter(
    (id) => report !== undefined && report.availableModels.length > 0 && !report.availableModels.includes(id),
  );
  for (const id of unlisted) console.log(`  Uwaga: modelu ${id} nie ma na liście modeli endpointu z raportu.`);
  console.log("Workspace jest przypięty do tego endpointu i z innym się nie otworzy.");
  console.log("Poświadczeń nie zapisano; skąd aplikacja je bierze, opisuje README w rozdziale „Poświadczenia”.");
  console.log(
    isDefault ? "Uruchomienie: npm start" : `Uruchomienie: ${WORKSPACE_VARIABLE}=${shellWord(dir)} npm start`,
  );
}

main();
