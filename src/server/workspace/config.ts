// The configuration file of a workspace: its name and its LLM profile (CFG-1, CFG-2, CFG-6).
// It holds no secret and no path, and it is the only file of a workspace meant to be read by a
// person. Everything about its format is in this module: the types, the reader with its
// messages, and the writer.

import { AUTH_SCHEMES, type AuthScheme } from "../llm/credentials/types.ts";
import type { DiagnosticsReport } from "../llm/diagnostics/types.ts";
import { ANTHROPIC_ENDPOINT, EndpointError, parseEndpoint } from "../llm/endpoint.ts";

/** Version of the file format. A file with a higher number was written by a newer Hubber. */
export const CONFIG_SCHEMA_VERSION = 1;

export const PROFILE_KINDS = ["anthropic", "router"] as const;
/** "anthropic": the direct Anthropic API, with a key. "router": a corporate router that speaks Anthropic Messages. */
export type ProfileKind = (typeof PROFILE_KINDS)[number];

export const MODEL_ROLES = ["processing", "conversation", "synthesis"] as const;
/** CFG-6: przetwarzanie, rozmowa, synteza. */
export type ModelRole = (typeof MODEL_ROLES)[number];

/** One model for every role, and the roles that use another one. */
export type ProfileModels = { default: string } & { [Role in ModelRole]?: string };

/** The optional features, exactly as the diagnostics report names them. */
export type Capabilities = DiagnosticsReport["summary"]["capabilities"];

/** What the profile keeps of a diagnostics report: the verdicts, not the transcript. */
export interface ProfileDiagnostics {
  /** When the diagnostics ran (the report's startedAt). */
  checkedAt: string;
  /** The model it ran against. Optional features are confirmed for this model only. */
  model: string;
  coreReady: boolean;
  capabilities: Capabilities;
}

export interface LlmProfile {
  kind: ProfileKind;
  /** The pinned address, in its canonical spelling. Never changes after creation. */
  endpoint: string;
  /** How the credential travels: "x-api-key" (always, for the direct API) or "bearer" (Authorization header). */
  auth: AuthScheme;
  models: ProfileModels;
  /** null until a diagnostics report has been taken in: every optional feature is then off. */
  diagnostics: ProfileDiagnostics | null;
}

export interface WorkspaceConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  /** Shown in the interface next to the endpoint (CFG-3). */
  name: string;
  createdAt: string;
  profile: LlmProfile;
}

// Frozen: capabilitiesOf() hands this very object to every caller.
const NO_CAPABILITIES: Capabilities = Object.freeze({
  promptCache: false,
  effort: false,
  thinking: false,
  pdfInput: false,
});

/** The model a role uses: its own if it has one, the common one otherwise. */
export function modelFor(profile: LlmProfile, role: ModelRole): string {
  return profile.models[role] ?? profile.models.default;
}

/** The optional features the app may use. Without confirmed diagnostics: none (CFG-5). */
export function capabilitiesOf(profile: LlmProfile): Capabilities {
  return profile.diagnostics?.coreReady === true ? profile.diagnostics.capabilities : NO_CAPABILITIES;
}

export const NAME_MAX_LENGTH = 60;
const MODEL_ID_MAX_LENGTH = 200;
// A name that looks like one of these was most likely pasted in by mistake.
const SECRET_LIKE_KEY = /key|token|secret|password|passwd|authorization|credential/i;

// What leaves nothing on screen: characters that take no room at all (zero-width ones, the soft
// hyphen, fillers, marks of direction), every kind of space, and the Braille pattern without a
// dot, which is neither and is drawn as a blank. The name is what tells the user which workspace
// is open, so a name made of these alone is as good as none.
const NOTHING_TO_SEE = /[\p{Default_Ignorable_Code_Point}\p{White_Space}\u2800]/gu;

/** Why a value is not a workspace name, or undefined when it is one. Expects the cleaned value. */
export function nameProblem(name: string): string | undefined {
  if (name.replace(NOTHING_TO_SEE, "") === "") return "nazwa jest pusta";
  if ([...name].length > NAME_MAX_LENGTH) return `nazwa ma więcej niż ${NAME_MAX_LENGTH} znaków`;
  if (/\p{Cc}|\p{Zl}|\p{Zp}/u.test(name)) return "nazwa zawiera znak sterujący albo znak nowego wiersza";
  return undefined;
}

/**
 * The name as it is stored: trimmed, in one Unicode spelling, and with one space wherever several
 * stand in a row. A page shows such a run as one space, so the name is kept the way it is seen.
 */
export function cleanName(raw: string): string {
  return raw.trim().replace(/ {2,}/g, " ").normalize("NFC");
}

/** Why a value is not a model identifier, or undefined when it is one. */
export function modelIdProblem(id: string): string | undefined {
  if (id === "") return "identyfikator modelu jest pusty";
  if (id.length > MODEL_ID_MAX_LENGTH) return `identyfikator modelu ma więcej niż ${MODEL_ID_MAX_LENGTH} znaków`;
  if (/[\s\p{Cc}]/u.test(id)) return "identyfikator modelu zawiera odstęp albo znak sterujący";
  return undefined;
}

/** Why the address does not fit the kind of profile, or undefined when it does. */
export function kindProblem(kind: ProfileKind, endpoint: string): string | undefined {
  if (kind === "anthropic" && endpoint !== ANTHROPIC_ENDPOINT) {
    return `profil "anthropic" ma stały adres ${ANTHROPIC_ENDPOINT}; dla innego adresu wybierz profil "router"`;
  }
  if (kind === "router" && endpoint === ANTHROPIC_ENDPOINT) {
    return `adres ${ANTHROPIC_ENDPOINT} należy do profilu "anthropic", nie "router"`;
  }
  return undefined;
}

/** Why the way of authenticating does not fit the kind of profile, or undefined when it does. */
export function authProblem(kind: ProfileKind, auth: AuthScheme): string | undefined {
  return kind === "anthropic" && auth !== "x-api-key"
    ? 'profil "anthropic" uwierzytelnia się wyłącznie kluczem w nagłówku x-api-key'
    : undefined;
}

/** Whether a value is a point in time the way the file writes one: an ISO 8601 text. */
export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * A configuration file that cannot be used. `problems` lists everything that is wrong with
 * it, one sentence each, so that one round of editing can fix the file.
 */
export class WorkspaceConfigError extends Error {
  override name = "WorkspaceConfigError";
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The roles that use the common model are not written down, so their keys may be missing.
const OPTIONAL_KEYS: ReadonlySet<string> = new Set(MODEL_ROLES);

// Collects the problems of one file. Every check names the field by its path in the file.
class Reader {
  readonly problems: string[] = [];

  problem(path: string, what: string): void {
    this.problems.push(`${path}: ${what}`);
  }

  /** The value as an object with these keys and no others, or undefined after reporting why not. */
  object(value: unknown, path: string, known: readonly string[]): JsonObject | undefined {
    if (!isObject(value)) {
      this.problem(path, "oczekiwano obiektu");
      return undefined;
    }
    for (const key of Object.keys(value)) {
      if (known.includes(key)) continue;
      // The value of such a field is never repeated: it may be the secret itself.
      const hint = SECRET_LIKE_KEY.test(key)
        ? "Konfiguracja nie przechowuje poświadczeń"
        : `dozwolone: ${known.join(", ")}`;
      this.problem(path === "" ? key : `${path}.${key}`, `nieznane pole (${hint})`);
    }
    for (const key of known) {
      if (!(key in value) && !OPTIONAL_KEYS.has(key)) this.problem(path === "" ? key : `${path}.${key}`, "brak pola");
    }
    return value;
  }
}

function readModels(reader: Reader, value: unknown): ProfileModels | undefined {
  const object = reader.object(value, "profile.models", ["default", ...MODEL_ROLES]);
  if (object === undefined) return undefined;
  const models: ProfileModels = { default: "" };
  for (const key of ["default", ...MODEL_ROLES] as const) {
    const id = object[key];
    if (id === undefined) continue;
    const problem = typeof id === "string" ? modelIdProblem(id) : "oczekiwano tekstu z identyfikatorem modelu";
    if (problem !== undefined) reader.problem(`profile.models.${key}`, problem);
    else models[key] = id as string;
  }
  return models;
}

function readDiagnostics(reader: Reader, value: unknown): ProfileDiagnostics | null | undefined {
  if (value === null) return null;
  const path = "profile.diagnostics";
  const object = reader.object(value, path, ["checkedAt", "model", "coreReady", "capabilities"]);
  if (object === undefined) return undefined;
  const before = reader.problems.length;
  // A missing field has been reported as missing already; these are about fields that are there.
  if ("checkedAt" in object && !isIsoDate(object.checkedAt)) {
    reader.problem(`${path}.checkedAt`, "oczekiwano daty w formacie ISO 8601");
  }
  const modelProblem =
    typeof object.model === "string" ? modelIdProblem(object.model) : "oczekiwano tekstu z identyfikatorem modelu";
  if ("model" in object && modelProblem !== undefined) reader.problem(`${path}.model`, modelProblem);
  if ("coreReady" in object && typeof object.coreReady !== "boolean") {
    reader.problem(`${path}.coreReady`, "oczekiwano true albo false");
  }
  const names = Object.keys(NO_CAPABILITIES) as (keyof Capabilities)[];
  const capabilities =
    "capabilities" in object ? reader.object(object.capabilities, `${path}.capabilities`, names) : undefined;
  for (const name of names) {
    if (capabilities !== undefined && name in capabilities && typeof capabilities[name] !== "boolean") {
      reader.problem(`${path}.capabilities.${name}`, "oczekiwano true albo false");
    }
  }
  if (reader.problems.length > before) return undefined;
  return {
    checkedAt: object.checkedAt as string,
    model: object.model as string,
    coreReady: object.coreReady as boolean,
    capabilities: Object.fromEntries(names.map((name) => [name, capabilities?.[name]])) as unknown as Capabilities,
  };
}

function readProfile(reader: Reader, value: unknown): LlmProfile | undefined {
  const object = reader.object(value, "profile", ["kind", "endpoint", "auth", "models", "diagnostics"]);
  if (object === undefined) return undefined;

  let kind: ProfileKind | undefined;
  if ((PROFILE_KINDS as readonly unknown[]).includes(object.kind)) kind = object.kind as ProfileKind;
  else if ("kind" in object) {
    reader.problem(
      "profile.kind",
      `nieznany rodzaj profilu ${JSON.stringify(object.kind)} (dozwolone: ${PROFILE_KINDS.join(", ")})`,
    );
  }

  let endpoint: string | undefined;
  if (typeof object.endpoint === "string") {
    try {
      // The file has to hold the canonical spelling already: the pin is compared letter by letter.
      const canonical = parseEndpoint(object.endpoint).href;
      if (canonical === object.endpoint) endpoint = canonical;
      else reader.problem("profile.endpoint", `adres nie jest w postaci kanonicznej; oczekiwano "${canonical}"`);
    } catch (error) {
      if (!(error instanceof EndpointError)) throw error;
      // The message is a whole sentence. A problem is listed without its full stop: whoever
      // prints the list puts one behind a problem that stands alone.
      reader.problem("profile.endpoint", error.message.replace(/\.$/, ""));
    }
  } else if ("endpoint" in object) reader.problem("profile.endpoint", "oczekiwano tekstu z adresem");

  if (kind !== undefined && endpoint !== undefined) {
    const mismatch = kindProblem(kind, endpoint);
    if (mismatch !== undefined) reader.problem("profile.endpoint", mismatch);
  }

  let auth: AuthScheme | undefined;
  if ((AUTH_SCHEMES as readonly unknown[]).includes(object.auth)) auth = object.auth as AuthScheme;
  else if ("auth" in object) {
    // The value is not repeated: this is the field into which a credential gets pasted by mistake.
    reader.problem(
      "profile.auth",
      `nieznany sposób uwierzytelnienia (dozwolone: ${AUTH_SCHEMES.join(", ")}). Konfiguracja nie przechowuje poświadczeń`,
    );
  }
  if (kind !== undefined && auth !== undefined) {
    const mismatch = authProblem(kind, auth);
    if (mismatch !== undefined) reader.problem("profile.auth", mismatch);
  }

  const models = "models" in object ? readModels(reader, object.models) : undefined;
  const diagnostics = "diagnostics" in object ? readDiagnostics(reader, object.diagnostics) : undefined;
  if (
    kind === undefined ||
    endpoint === undefined ||
    auth === undefined ||
    models === undefined ||
    diagnostics === undefined
  ) {
    return undefined;
  }
  return { kind, endpoint, auth, models, diagnostics };
}

/**
 * Reads the text of a configuration file. Throws WorkspaceConfigError with every problem
 * found. Nothing is filled in for a file that passes: what is missing is a problem, not a default.
 */
export function parseWorkspaceConfig(text: string): WorkspaceConfig {
  let json: unknown;
  try {
    // Some editors put a byte order mark in front, and JSON.parse() refuses it.
    json = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    // V8 says where: "... in JSON at position 43 (line 4 column 1)". The rest of its message
    // quotes the file, which is not for the terminal.
    const place = /\(line (\d+) column (\d+)\)/.exec(error instanceof Error ? error.message : "");
    throw new WorkspaceConfigError([
      place
        ? `plik nie jest poprawnym JSON-em (wiersz ${place[1]}, kolumna ${place[2]})`
        : "plik nie jest poprawnym JSON-em",
    ]);
  }
  if (!isObject(json)) throw new WorkspaceConfigError(["plik nie zawiera obiektu JSON"]);

  // Checked before anything else: the fields of a newer format cannot be judged by this version.
  const version = json.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new WorkspaceConfigError([`schemaVersion: oczekiwano liczby ${CONFIG_SCHEMA_VERSION}`]);
  }
  if (version > CONFIG_SCHEMA_VERSION) {
    throw new WorkspaceConfigError([
      `plik ma format w wersji ${version}, a ta wersja Hubbera zna format ${CONFIG_SCHEMA_VERSION}. Zaktualizuj aplikację`,
    ]);
  }

  const reader = new Reader();
  const object = reader.object(json, "", ["schemaVersion", "name", "createdAt", "profile"]) as JsonObject;

  let name: string | undefined;
  if (typeof object.name === "string") {
    const problem = nameProblem(cleanName(object.name));
    if (problem !== undefined) reader.problem("name", problem);
    else name = cleanName(object.name);
  } else if ("name" in object) reader.problem("name", "oczekiwano tekstu");

  if ("createdAt" in object && !isIsoDate(object.createdAt)) {
    reader.problem("createdAt", "oczekiwano daty w formacie ISO 8601");
  }
  const profile = "profile" in object ? readProfile(reader, object.profile) : undefined;

  if (reader.problems.length > 0 || name === undefined || profile === undefined) {
    throw new WorkspaceConfigError(reader.problems);
  }
  return { schemaVersion: CONFIG_SCHEMA_VERSION, name, createdAt: object.createdAt as string, profile };
}

/** The text of the file: indented for reading, keys in a fixed order, a newline at the end. */
export function serializeWorkspaceConfig(config: WorkspaceConfig): string {
  const { kind, endpoint, auth, models, diagnostics } = config.profile;
  const ordered = {
    schemaVersion: config.schemaVersion,
    name: config.name,
    createdAt: config.createdAt,
    profile: {
      kind,
      endpoint,
      auth,
      models: {
        default: models.default,
        ...Object.fromEntries(
          MODEL_ROLES.flatMap((role) => (models[role] === undefined ? [] : [[role, models[role]]])),
        ),
      },
      diagnostics:
        diagnostics === null
          ? null
          : {
              checkedAt: diagnostics.checkedAt,
              model: diagnostics.model,
              coreReady: diagnostics.coreReady,
              capabilities: {
                promptCache: diagnostics.capabilities.promptCache,
                effort: diagnostics.capabilities.effort,
                thinking: diagnostics.capabilities.thinking,
                pdfInput: diagnostics.capabilities.pdfInput,
              },
            },
    },
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
