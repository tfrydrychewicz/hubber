import { describe, expect, it } from "vitest";
import {
  authProblem,
  capabilitiesOf,
  cleanName,
  isIsoDate,
  kindProblem,
  type LlmProfile,
  MODEL_ROLES,
  modelFor,
  modelIdProblem,
  NAME_MAX_LENGTH,
  nameProblem,
  PROFILE_KINDS,
  parseWorkspaceConfig,
  serializeWorkspaceConfig,
  type WorkspaceConfig,
  WorkspaceConfigError,
} from "./config.ts";

// An invented value: it stands for a credential that someone pasted into the file.
const SECRET = "sk-test-0123456789abcdef-not-a-real-key";

const ROUTER_PROFILE: LlmProfile = {
  kind: "router",
  endpoint: "https://router.corp.example/llm",
  auth: "bearer",
  models: { default: "router-opus", synthesis: "router-sonnet" },
  diagnostics: {
    checkedAt: "2026-10-10T08:56:13.000Z",
    model: "router-opus",
    coreReady: true,
    capabilities: { promptCache: true, effort: false, thinking: true, pdfInput: true },
  },
};

const CONFIG: WorkspaceConfig = {
  schemaVersion: 1,
  name: "Praca",
  createdAt: "2026-10-10T20:46:44.847Z",
  profile: ROUTER_PROFILE,
};

const ANTHROPIC_CONFIG: WorkspaceConfig = {
  schemaVersion: 1,
  name: "Dev",
  createdAt: "2026-10-10T20:46:44.847Z",
  profile: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    auth: "x-api-key",
    models: { default: "claude-opus-5-5" },
    diagnostics: null,
  },
};

/** The file as plain JSON, loose enough for a test to break it in one place. */
interface LooseFile {
  [key: string]: unknown;
  profile: {
    [key: string]: unknown;
    models: Record<string, unknown>;
    diagnostics: { [key: string]: unknown; capabilities: Record<string, unknown> };
  };
}

function validFile(): LooseFile {
  return structuredClone(CONFIG) as unknown as LooseFile;
}

function failure(text: string): WorkspaceConfigError {
  try {
    parseWorkspaceConfig(text);
  } catch (error) {
    if (error instanceof WorkspaceConfigError) return error;
    throw error;
  }
  throw new Error("The configuration was accepted.");
}

function problemsOf(file: unknown): readonly string[] {
  return failure(JSON.stringify(file)).problems;
}

describe("serializeWorkspaceConfig", () => {
  it("writes the file for reading: indented, keys in a fixed order, a newline at the end", () => {
    expect(serializeWorkspaceConfig(CONFIG)).toBe(`{
  "schemaVersion": 1,
  "name": "Praca",
  "createdAt": "2026-10-10T20:46:44.847Z",
  "profile": {
    "kind": "router",
    "endpoint": "https://router.corp.example/llm",
    "auth": "bearer",
    "models": {
      "default": "router-opus",
      "synthesis": "router-sonnet"
    },
    "diagnostics": {
      "checkedAt": "2026-10-10T08:56:13.000Z",
      "model": "router-opus",
      "coreReady": true,
      "capabilities": {
        "promptCache": true,
        "effort": false,
        "thinking": true,
        "pdfInput": true
      }
    }
  }
}
`);
  });

  it("keeps that order whatever order the values were put together in", () => {
    const shuffled: WorkspaceConfig = {
      profile: {
        diagnostics: {
          capabilities: { pdfInput: true, thinking: true, effort: false, promptCache: true },
          coreReady: true,
          model: "router-opus",
          checkedAt: "2026-10-10T08:56:13.000Z",
        },
        models: { synthesis: "router-sonnet", default: "router-opus" },
        auth: "bearer",
        endpoint: "https://router.corp.example/llm",
        kind: "router",
      },
      createdAt: "2026-10-10T20:46:44.847Z",
      name: "Praca",
      schemaVersion: 1,
    };

    expect(serializeWorkspaceConfig(shuffled)).toBe(serializeWorkspaceConfig(CONFIG));
  });

  it("writes the roles in one order and leaves out what is not part of the format", () => {
    const withExtras = {
      ...CONFIG,
      note: "not part of the format",
      profile: {
        ...ROUTER_PROFILE,
        apiKey: SECRET,
        models: { conversation: "c", default: "d", synthesis: "s", processing: "p" },
        diagnostics: null,
      },
    };

    const text = serializeWorkspaceConfig(withExtras);

    expect(Object.keys(JSON.parse(text).profile.models)).toEqual([
      "default",
      "processing",
      "conversation",
      "synthesis",
    ]);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("note");
    expect(JSON.parse(text).profile.diagnostics).toBeNull();
  });
});

describe("parseWorkspaceConfig", () => {
  it.each([
    ["a router profile with diagnostics", CONFIG],
    ["an Anthropic profile without diagnostics", ANTHROPIC_CONFIG],
  ])("reads back %s exactly as it was written", (_what, config) => {
    expect(parseWorkspaceConfig(serializeWorkspaceConfig(config))).toEqual(config);
  });

  it("accepts a file with a byte order mark in front", () => {
    expect(parseWorkspaceConfig(`\uFEFF${serializeWorkspaceConfig(CONFIG)}`)).toEqual(CONFIG);
  });

  it("stores the name trimmed and in one Unicode spelling", () => {
    // "ó" and "ź" written as a letter and a combining accent.
    const file = { ...validFile(), name: "  Zespo\u0301ł Ło\u0301dz\u0301 \n" };

    expect(parseWorkspaceConfig(JSON.stringify(file)).name).toBe("Zespół Łódź");
  });

  it("accepts values at the very limits of the format", () => {
    const file = validFile();
    // Counted in characters, not in UTF-16 units: each of these takes two.
    file.name = "🙂".repeat(NAME_MAX_LENGTH);
    file.createdAt = "2026-10-10T22:46:44+02:00";
    file.profile.endpoint = "http://127.0.0.1:9/llm";
    file.profile.models = { default: "m".repeat(200), processing: "p", conversation: "c", synthesis: "s" };

    const config = parseWorkspaceConfig(JSON.stringify(file));

    expect([...config.name]).toHaveLength(60);
    expect(config.profile.models).toEqual(file.profile.models);
  });

  const ONE_PROBLEM: [what: string, breakIt: (file: LooseFile) => void, problem: string][] = [
    [
      "a field it does not know",
      (file) => {
        file.extra = 1;
      },
      "extra: nieznane pole (dozwolone: schemaVersion, name, createdAt, profile)",
    ],
    [
      "a missing name",
      (file) => {
        delete file.name;
      },
      "name: brak pola",
    ],
    [
      "a name that is not text",
      (file) => {
        file.name = 7;
      },
      "name: oczekiwano tekstu",
    ],
    [
      "a blank name",
      (file) => {
        file.name = "   ";
      },
      "name: nazwa jest pusta",
    ],
    [
      "a name of characters that leave nothing on screen",
      (file) => {
        file.name = "\u200b\u2800\u00ad";
      },
      "name: nazwa jest pusta",
    ],
    [
      "a name that is too long",
      (file) => {
        file.name = "x".repeat(61);
      },
      "name: nazwa ma więcej niż 60 znaków",
    ],
    [
      "a line break in the name",
      (file) => {
        file.name = "Pra\nca";
      },
      "name: nazwa zawiera znak sterujący albo znak nowego wiersza",
    ],
    [
      "a Unicode line separator in the name",
      (file) => {
        file.name = "Pra\u2028ca";
      },
      "name: nazwa zawiera znak sterujący albo znak nowego wiersza",
    ],
    [
      "a missing creation time",
      (file) => {
        delete file.createdAt;
      },
      "createdAt: brak pola",
    ],
    [
      "a creation time in words",
      (file) => {
        file.createdAt = "wczoraj";
      },
      "createdAt: oczekiwano daty w formacie ISO 8601",
    ],
    [
      "a creation time as a number",
      (file) => {
        file.createdAt = 1_760_000_000;
      },
      "createdAt: oczekiwano daty w formacie ISO 8601",
    ],
    [
      "a creation time that is a date, but not an ISO one",
      (file) => {
        file.createdAt = "10 October 2026 20:46 UTC";
      },
      "createdAt: oczekiwano daty w formacie ISO 8601",
    ],
    [
      "a creation time on a day that does not exist",
      (file) => {
        file.createdAt = "2026-13-45T00:00:00Z";
      },
      "createdAt: oczekiwano daty w formacie ISO 8601",
    ],
    [
      "a missing profile",
      (file) => {
        delete (file as Record<string, unknown>).profile;
      },
      "profile: brak pola",
    ],
    [
      "a profile that is a list",
      (file) => {
        (file as Record<string, unknown>).profile = ["router"];
      },
      "profile: oczekiwano obiektu",
    ],
    [
      "a profile field it does not know",
      (file) => {
        file.profile.region = "eu";
      },
      "profile.region: nieznane pole (dozwolone: kind, endpoint, auth, models, diagnostics)",
    ],
    [
      "a missing kind",
      (file) => {
        delete file.profile.kind;
      },
      "profile.kind: brak pola",
    ],
    [
      "a kind it does not know",
      (file) => {
        file.profile.kind = "bedrock";
      },
      'profile.kind: nieznany rodzaj profilu "bedrock" (dozwolone: anthropic, router)',
    ],
    [
      "a missing address",
      (file) => {
        delete file.profile.endpoint;
      },
      "profile.endpoint: brak pola",
    ],
    [
      "an address that is not text",
      (file) => {
        file.profile.endpoint = 443;
      },
      "profile.endpoint: oczekiwano tekstu z adresem",
    ],
    [
      "an address with a slash at the end",
      (file) => {
        file.profile.endpoint = "https://router.corp.example/llm/";
      },
      'profile.endpoint: adres nie jest w postaci kanonicznej; oczekiwano "https://router.corp.example/llm"',
    ],
    [
      "an address in capitals",
      (file) => {
        file.profile.endpoint = "HTTPS://Router.Corp.Example:443/llm";
      },
      'profile.endpoint: adres nie jest w postaci kanonicznej; oczekiwano "https://router.corp.example/llm"',
    ],
    [
      "an address without a scheme",
      (file) => {
        file.profile.endpoint = "router.corp.example";
      },
      'profile.endpoint: "router.corp.example" nie jest poprawnym adresem. Podaj pełny adres, na przykład https://router.corp.example',
    ],
    [
      "an http address of another machine",
      (file) => {
        file.profile.endpoint = "http://router.corp.example/llm";
      },
      'profile.endpoint: Adres "http://router.corp.example/llm" używa nieszyfrowanego http://. Poza tym komputerem (127.0.0.1, localhost) dozwolone jest tylko https://',
    ],
    [
      "the Anthropic kind with another address",
      (file) => {
        file.profile.kind = "anthropic";
        file.profile.auth = "x-api-key";
      },
      'profile.endpoint: profil "anthropic" ma stały adres https://api.anthropic.com; dla innego adresu wybierz profil "router"',
    ],
    [
      "the router kind with the address of the Anthropic API",
      (file) => {
        file.profile.endpoint = "https://api.anthropic.com";
      },
      'profile.endpoint: adres https://api.anthropic.com należy do profilu "anthropic", nie "router"',
    ],
    [
      "a missing way of authenticating",
      (file) => {
        delete file.profile.auth;
      },
      "profile.auth: brak pola",
    ],
    [
      "a way of authenticating it does not know",
      (file) => {
        file.profile.auth = "basic";
      },
      "profile.auth: nieznany sposób uwierzytelnienia (dozwolone: x-api-key, bearer). Konfiguracja nie przechowuje poświadczeń",
    ],
    [
      "the Anthropic kind with a bearer token",
      (file) => {
        file.profile.kind = "anthropic";
        file.profile.endpoint = "https://api.anthropic.com";
      },
      'profile.auth: profil "anthropic" uwierzytelnia się wyłącznie kluczem w nagłówku x-api-key',
    ],
    [
      "missing models",
      (file) => {
        delete (file.profile as Record<string, unknown>).models;
      },
      "profile.models: brak pola",
    ],
    [
      "models given as one identifier",
      (file) => {
        (file.profile as Record<string, unknown>).models = "router-opus";
      },
      "profile.models: oczekiwano obiektu",
    ],
    [
      "a missing common model",
      (file) => {
        delete file.profile.models.default;
      },
      "profile.models.default: brak pola",
    ],
    [
      "a role it does not know",
      (file) => {
        file.profile.models.synthesys = "router-sonnet";
      },
      "profile.models.synthesys: nieznane pole (dozwolone: default, processing, conversation, synthesis)",
    ],
    [
      "an empty model identifier",
      (file) => {
        file.profile.models.default = "";
      },
      "profile.models.default: identyfikator modelu jest pusty",
    ],
    [
      "a model identifier that is too long",
      (file) => {
        file.profile.models.processing = "m".repeat(201);
      },
      "profile.models.processing: identyfikator modelu ma więcej niż 200 znaków",
    ],
    [
      "a model identifier with a space",
      (file) => {
        file.profile.models.conversation = "claude opus";
      },
      "profile.models.conversation: identyfikator modelu zawiera odstęp albo znak sterujący",
    ],
    [
      "a model identifier that is not text",
      (file) => {
        file.profile.models.synthesis = null;
      },
      "profile.models.synthesis: oczekiwano tekstu z identyfikatorem modelu",
    ],
    [
      "missing diagnostics",
      (file) => {
        delete (file.profile as Record<string, unknown>).diagnostics;
      },
      "profile.diagnostics: brak pola",
    ],
    [
      "diagnostics that are neither an object nor null",
      (file) => {
        (file.profile as Record<string, unknown>).diagnostics = "ok";
      },
      "profile.diagnostics: oczekiwano obiektu",
    ],
    [
      "the transcript of the diagnostics",
      (file) => {
        file.profile.diagnostics.checks = [];
      },
      "profile.diagnostics.checks: nieznane pole (dozwolone: checkedAt, model, coreReady, capabilities)",
    ],
    [
      "a missing time of the diagnostics",
      (file) => {
        delete file.profile.diagnostics.checkedAt;
      },
      "profile.diagnostics.checkedAt: brak pola",
    ],
    [
      "a time of the diagnostics in words",
      (file) => {
        file.profile.diagnostics.checkedAt = "rano";
      },
      "profile.diagnostics.checkedAt: oczekiwano daty w formacie ISO 8601",
    ],
    [
      "a missing model of the diagnostics",
      (file) => {
        delete file.profile.diagnostics.model;
      },
      "profile.diagnostics.model: brak pola",
    ],
    [
      "an empty model of the diagnostics",
      (file) => {
        file.profile.diagnostics.model = "";
      },
      "profile.diagnostics.model: identyfikator modelu jest pusty",
    ],
    [
      "a model of the diagnostics that is not text",
      (file) => {
        file.profile.diagnostics.model = 5;
      },
      "profile.diagnostics.model: oczekiwano tekstu z identyfikatorem modelu",
    ],
    [
      "a missing verdict on the core",
      (file) => {
        delete file.profile.diagnostics.coreReady;
      },
      "profile.diagnostics.coreReady: brak pola",
    ],
    [
      "a verdict on the core in words",
      (file) => {
        file.profile.diagnostics.coreReady = "yes";
      },
      "profile.diagnostics.coreReady: oczekiwano true albo false",
    ],
    [
      "missing capabilities",
      (file) => {
        delete (file.profile.diagnostics as Record<string, unknown>).capabilities;
      },
      "profile.diagnostics.capabilities: brak pola",
    ],
    [
      "capabilities given as a list",
      (file) => {
        (file.profile.diagnostics as Record<string, unknown>).capabilities = ["thinking"];
      },
      "profile.diagnostics.capabilities: oczekiwano obiektu",
    ],
    [
      "a missing capability",
      (file) => {
        delete file.profile.diagnostics.capabilities.effort;
      },
      "profile.diagnostics.capabilities.effort: brak pola",
    ],
    [
      "a capability in words",
      (file) => {
        file.profile.diagnostics.capabilities.thinking = "tak";
      },
      "profile.diagnostics.capabilities.thinking: oczekiwano true albo false",
    ],
    [
      "a capability it does not know",
      (file) => {
        file.profile.diagnostics.capabilities.vision = true;
      },
      "profile.diagnostics.capabilities.vision: nieznane pole (dozwolone: promptCache, effort, thinking, pdfInput)",
    ],
  ];

  it.each(ONE_PROBLEM)("reports %s, and nothing else", (_what, breakIt, problem) => {
    const file = validFile();
    breakIt(file);

    const error = failure(JSON.stringify(file));

    expect(error.problems).toEqual([problem]);
    expect(error.message).toBe(problem);
  });

  it("lists every problem of a broken file at once, so that one round of editing can fix it", () => {
    const broken = {
      schemaVersion: 1,
      name: "  ",
      createdAt: "wczoraj",
      profile: {
        kind: "bedrock",
        endpoint: "https://router.corp.example/llm/",
        apiKey: SECRET,
        auth: SECRET,
        models: { default: "", synthesys: "router-sonnet" },
        diagnostics: {
          checkedAt: "2026-10-10T08:56:13.000Z",
          model: "router-opus",
          coreReady: "yes",
          capabilities: { promptCache: true },
        },
      },
    };

    const error = failure(JSON.stringify(broken));

    expect(error.problems).toEqual([
      "name: nazwa jest pusta",
      "createdAt: oczekiwano daty w formacie ISO 8601",
      "profile.apiKey: nieznane pole (Konfiguracja nie przechowuje poświadczeń)",
      'profile.kind: nieznany rodzaj profilu "bedrock" (dozwolone: anthropic, router)',
      'profile.endpoint: adres nie jest w postaci kanonicznej; oczekiwano "https://router.corp.example/llm"',
      "profile.auth: nieznany sposób uwierzytelnienia (dozwolone: x-api-key, bearer). Konfiguracja nie przechowuje poświadczeń",
      "profile.models.synthesys: nieznane pole (dozwolone: default, processing, conversation, synthesis)",
      "profile.models.default: identyfikator modelu jest pusty",
      "profile.diagnostics.coreReady: oczekiwano true albo false",
      "profile.diagnostics.capabilities.effort: brak pola",
      "profile.diagnostics.capabilities.thinking: brak pola",
      "profile.diagnostics.capabilities.pdfInput: brak pola",
    ]);
    expect(error.message).toBe(error.problems.join("\n"));
    // The credential that was pasted into the file twice is not repeated in the message.
    expect(error.message).not.toContain(SECRET);
  });

  it.each([
    ["at the top", (file: LooseFile) => file, "apiKey"],
    ["in the profile", (file: LooseFile) => file.profile, "profile.authToken"],
    ["among the models", (file: LooseFile) => file.profile.models, "profile.models.api_key"],
    ["in the diagnostics", (file: LooseFile) => file.profile.diagnostics, "profile.diagnostics.Authorization"],
    [
      "among the capabilities",
      (file: LooseFile) => file.profile.diagnostics.capabilities,
      "profile.diagnostics.capabilities.clientSecret",
    ],
    ["in the profile, as a password", (file: LooseFile) => file.profile, "profile.password"],
    ["in the profile, as credentials", (file: LooseFile) => file.profile, "profile.credentials"],
  ])("refuses a field that looks like a credential %s without repeating its value", (_where, objectOf, path) => {
    const file = validFile();
    objectOf(file)[path.split(".").at(-1) as string] = SECRET;

    const error = failure(JSON.stringify(file));

    expect(error.problems).toEqual([`${path}: nieznane pole (Konfiguracja nie przechowuje poświadczeń)`]);
    expect(error.message).not.toContain(SECRET);
  });

  it("does not repeat a credential that was pasted in as the way of authenticating", () => {
    const file = validFile();
    file.profile.auth = SECRET;

    expect(failure(JSON.stringify(file)).message).not.toContain(SECRET);
  });

  it("says where the JSON breaks, without quoting the file", () => {
    expect(failure('{\n  "schemaVersion": 1,\n}').problems).toEqual([
      "plik nie jest poprawnym JSON-em (wiersz 3, kolumna 1)",
    ]);
    // The parser's own message quotes what stands around the error, here a pasted credential.
    const text = `{"schemaVersion": 1, "apiKey": "${SECRET}" oops}`;
    const quoted = failure(text);
    expect(quoted.problems).toEqual([
      `plik nie jest poprawnym JSON-em (wiersz 1, kolumna ${text.indexOf("oops") + 1})`,
    ]);
    expect(quoted.message).not.toContain(SECRET);
  });

  it("reports a file that ends too early without a place", () => {
    expect(failure("").problems).toEqual(["plik nie jest poprawnym JSON-em"]);
  });

  it.each(["[]", '"workspace"', "7", "null"])("refuses the JSON value %s, which is not an object", (text) => {
    expect(failure(text).problems).toEqual(["plik nie zawiera obiektu JSON"]);
  });

  it.each([
    ["no version", {}],
    ["a version in words", { schemaVersion: "1" }],
    ["version 0", { schemaVersion: 0 }],
    ["a version that is not whole", { schemaVersion: 1.5 }],
  ])("asks for the version first in a file with %s", (_what, file) => {
    // Nothing else is judged: without the version there is no telling which fields to expect.
    expect(problemsOf({ ...file, name: 7, future: true })).toEqual(["schemaVersion: oczekiwano liczby 1"]);
  });

  it("tells a file written by a newer Hubber from a broken one", () => {
    expect(problemsOf({ schemaVersion: 2, name: 7, future: true })).toEqual([
      "plik ma format w wersji 2, a ta wersja Hubbera zna format 1. Zaktualizuj aplikację",
    ]);
  });
});

describe("modelFor", () => {
  it("gives a role its own model, and the common one to a role without", () => {
    expect(modelFor(ROUTER_PROFILE, "synthesis")).toBe("router-sonnet");
    expect(modelFor(ROUTER_PROFILE, "processing")).toBe("router-opus");
    expect(modelFor(ROUTER_PROFILE, "conversation")).toBe("router-opus");
  });

  it("knows the three roles", () => {
    expect(MODEL_ROLES).toEqual(["processing", "conversation", "synthesis"]);
  });
});

describe("capabilitiesOf", () => {
  const nothing = { promptCache: false, effort: false, thinking: false, pdfInput: false };

  it("gives what the diagnostics confirmed", () => {
    expect(capabilitiesOf(ROUTER_PROFILE)).toEqual({
      promptCache: true,
      effort: false,
      thinking: true,
      pdfInput: true,
    });
  });

  it("switches every optional feature off without diagnostics", () => {
    expect(capabilitiesOf({ ...ROUTER_PROFILE, diagnostics: null })).toEqual(nothing);
  });

  it("switches every optional feature off when the core was not confirmed", () => {
    const diagnostics = { ...(ROUTER_PROFILE.diagnostics as NonNullable<LlmProfile["diagnostics"]>), coreReady: false };

    expect(capabilitiesOf({ ...ROUTER_PROFILE, diagnostics })).toEqual(nothing);
  });

  it("hands out an answer that a caller cannot turn into another one for everybody", () => {
    expect(Object.isFrozen(capabilitiesOf({ ...ROUTER_PROFILE, diagnostics: null }))).toBe(true);
  });
});

describe("the rules shared with the create command", () => {
  it("accepts a name of up to 60 characters and says what is wrong with any other", () => {
    expect(nameProblem("Praca")).toBeUndefined();
    expect(nameProblem("x".repeat(60))).toBeUndefined();
    expect(nameProblem("x".repeat(61))).toBe("nazwa ma więcej niż 60 znaków");
    expect(nameProblem("")).toBe("nazwa jest pusta");
    expect(nameProblem("Pra\tca")).toBe("nazwa zawiera znak sterujący albo znak nowego wiersza");
    expect(nameProblem("Pra\u2029ca")).toBe("nazwa zawiera znak sterujący albo znak nowego wiersza");
    expect(NAME_MAX_LENGTH).toBe(60);
  });

  // The name is on screen all the time, to tell the user which workspace is open.
  it.each<[string, string]>([
    ["a zero-width space", "\u200b"],
    ["a zero-width joiner, a word joiner and a zero-width non-joiner", "\u200d\u2060\u200c"],
    ["a soft hyphen", "\u00ad"],
    ["a Hangul filler", "\u3164"],
    ["a halfwidth Hangul filler", "\uffa0"],
    ["a Braille pattern without a dot", "\u2800"],
    ["marks of direction", "\u200e\u202e\u2069"],
    ["a variation selector", "\ufe0f"],
    ["a tag character", "\u{e0041}"],
    ["spaces of several kinds", " \u00a0\u2003\u3000"],
    ["a mix of all of them", "\u200b \u2800\u00ad\u3164"],
  ])("takes a name that is nothing but %s for an empty one", (_what, name) => {
    expect(nameProblem(name)).toBe("nazwa jest pusta");
  });

  it.each<[string, string]>([
    ["a letter beside a zero-width space", "\u200bŁ"],
    ["an emoji with its variation selector", "\u2764\ufe0f"],
    ["an accent with no letter under it", "\u0301"],
    ["a Braille pattern with a dot", "\u2801"],
    ["a single dash", "-"],
  ])("accepts a name that is %s, which shows something", (_what, name) => {
    expect(nameProblem(name)).toBeUndefined();
  });

  it("cleans a name the way it is stored", () => {
    expect(cleanName("  Praca \n")).toBe("Praca");
    expect(cleanName("Ło\u0301dz\u0301")).toBe("Łódź");
    // As a page shows it: several spaces in a row are one.
    expect(cleanName("Praca     B  i C")).toBe("Praca B i C");
    // Other kinds of space are characters of the name, and a page leaves them as they are.
    expect(cleanName("Praca\u00a0\u00a0B")).toBe("Praca\u00a0\u00a0B");
  });

  it("accepts a model identifier without spaces and says what is wrong with any other", () => {
    expect(modelIdProblem("claude-opus-5-5")).toBeUndefined();
    expect(modelIdProblem("m".repeat(200))).toBeUndefined();
    expect(modelIdProblem("m".repeat(201))).toBe("identyfikator modelu ma więcej niż 200 znaków");
    expect(modelIdProblem("")).toBe("identyfikator modelu jest pusty");
    expect(modelIdProblem("claude opus")).toBe("identyfikator modelu zawiera odstęp albo znak sterujący");
    expect(modelIdProblem("claude\u0000opus")).toBe("identyfikator modelu zawiera odstęp albo znak sterujący");
  });

  it("holds the kind of profile to its address", () => {
    expect(kindProblem("anthropic", "https://api.anthropic.com")).toBeUndefined();
    expect(kindProblem("router", "https://router.corp.example")).toBeUndefined();
    expect(kindProblem("anthropic", "https://router.corp.example")).toBe(
      'profil "anthropic" ma stały adres https://api.anthropic.com; dla innego adresu wybierz profil "router"',
    );
    expect(kindProblem("router", "https://api.anthropic.com")).toBe(
      'adres https://api.anthropic.com należy do profilu "anthropic", nie "router"',
    );
    expect(PROFILE_KINDS).toEqual(["anthropic", "router"]);
  });

  it("holds the Anthropic profile to its one way of authenticating", () => {
    expect(authProblem("anthropic", "x-api-key")).toBeUndefined();
    expect(authProblem("router", "bearer")).toBeUndefined();
    expect(authProblem("router", "x-api-key")).toBeUndefined();
    expect(authProblem("anthropic", "bearer")).toBe(
      'profil "anthropic" uwierzytelnia się wyłącznie kluczem w nagłówku x-api-key',
    );
  });

  it("takes only an ISO 8601 text for a point in time", () => {
    expect(isIsoDate("2026-10-10T20:46:44.847Z")).toBe(true);
    expect(isIsoDate("2026-10-10T22:46:44+02:00")).toBe(true);
    expect(isIsoDate("2026-10-10")).toBe(false);
    expect(isIsoDate("10 October 2026 20:46 UTC")).toBe(false);
    expect(isIsoDate("2026-13-45T00:00:00Z")).toBe(false);
    expect(isIsoDate(1_760_000_000)).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
  });
});
