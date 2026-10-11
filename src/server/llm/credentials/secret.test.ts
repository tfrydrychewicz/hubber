import { format, inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createRedactor, HIDDEN, redactSecrets, SECRET_PROBLEM_TEXT, Secret } from "./secret.ts";

const PLANT = "hubber-planted-secret-7f3a9c";

function secret(value: string): Secret {
  const parsed = Secret.parse(value);
  if (typeof parsed === "string") throw new Error(`Not accepted as a secret: ${parsed}`);
  return parsed;
}

describe("Secret", () => {
  it("gives the value through reveal(), without the white space around it", () => {
    expect(secret(`  ${PLANT}\n`).reveal()).toBe(PLANT);
  });

  it("shows a placeholder everywhere else", () => {
    const value = secret(PLANT);
    const holder = { credential: value, nested: [value] };

    const shown = [
      String(value),
      `${value}`,
      JSON.stringify(holder),
      inspect(holder, { depth: 5, showHidden: true }),
      format("%s %o %j", value, value, value),
      JSON.stringify({ ...value }),
      new Error(`refused: ${value}`).message,
    ];

    for (const text of shown) expect(text).not.toContain(PLANT);
    for (const text of shown.slice(0, 5)) expect(text).toContain(HIDDEN);
  });

  it("compares by value", () => {
    expect(secret(PLANT).equals(secret(` ${PLANT} `))).toBe(true);
    expect(secret(PLANT).equals(secret(`${PLANT}-other`))).toBe(false);
  });

  it.each([
    ["only white space", "   ", "empty"],
    ["seven characters", "short-7", "too-short"],
    ["the word Bearer in front", `Bearer ${PLANT}`, "bearer-prefix"],
    ["the word in lower case and a tab", `bearer\t${PLANT}`, "bearer-prefix"],
    ["a line break and a header after it", `${PLANT}\nX-Injected: 1`, "not-a-header-value"],
    // Without a space: what is refused here is the line break itself.
    ["a line break and nothing else that is out of place", `${PLANT}\nX-Injected:1`, "not-a-header-value"],
    ["a carriage return and a line break", `${PLANT}\r\nx`, "not-a-header-value"],
    ["a tab inside", `${PLANT}\tx`, "not-a-header-value"],
    ["a NUL character", `${PLANT}\u0000x`, "not-a-header-value"],
    ["a space inside", `${PLANT} with space`, "not-a-header-value"],
    ["a letter outside ASCII", `${PLANT}-ż`, "not-a-header-value"],
    ["a double quote", `${PLANT}"quoted`, "not-a-header-value"],
    ["a backslash", `${PLANT}\\escaped`, "not-a-header-value"],
    ["8193 characters", "x".repeat(8193), "too-long"],
  ])("refuses a value with %s", (_case, raw, problem) => {
    expect(Secret.parse(raw)).toBe(problem);
  });

  // Headers.set() repeats a value it cannot take in its own error message, and a value with a
  // quote or a backslash is spelled differently wherever it is written down as JSON.
  it("accepts the visible ASCII characters other than the double quote and the backslash, and no other", () => {
    const accepted: number[] = [];
    // Past ASCII as well: Latin-1, where a header would still take the byte, and beyond.
    for (let code = 0; code <= 0x17f; code++) {
      // In the middle of the value, where the trimming of its ends does not reach.
      const parsed = Secret.parse(`${PLANT}${String.fromCharCode(code)}${PLANT}`);
      if (typeof parsed !== "string") accepted.push(code);
      else expect(parsed, `the character with code ${code}`).toBe("not-a-header-value");
    }

    const visible = Array.from({ length: 0x7e - 0x21 + 1 }, (_, index) => 0x21 + index);
    expect(accepted).toEqual(visible.filter((code) => code !== 0x22 && code !== 0x5c));
  });

  it("accepts the shortest and the longest value it allows", () => {
    expect(secret("exactly8").reveal()).toBe("exactly8");
    expect(secret("x".repeat(8192)).reveal()).toHaveLength(8192);
  });

  it("words every refusal without room for the value", () => {
    expect(SECRET_PROBLEM_TEXT).toEqual({
      empty: "jest puste",
      "bearer-prefix": "zaczyna się od słowa „Bearer”; podaj sam token, aplikacja dopisuje to słowo sama",
      "too-short": "jest krótsze niż 8 znaków",
      "too-long": "jest dłuższe niż 8192 znaków",
      "not-a-header-value":
        "zawiera znak, którego nie da się wysłać w nagłówku: odstęp, znak nowej linii, cudzysłów, ukośnik wsteczny albo znak spoza ASCII",
    });
  });
});

describe("redactSecrets", () => {
  it("finds a secret in plain, JSON and percent-encoded text", () => {
    const value = "abc+/=:secret-value";
    const text = `plain ${value} json ${JSON.stringify({ key: value })} url ${encodeURIComponent(value)}`;

    expect(redactSecrets(text, [secret(value)])).toBe(`plain ${HIDDEN} json {"key":"${HIDDEN}"} url ${HIDDEN}`);
  });

  it("replaces every occurrence of every secret", () => {
    const text = "first-secret-1, second-secret-2, first-secret-1 again";

    expect(redactSecrets(text, [secret("first-secret-1"), secret("second-secret-2")])).toBe(
      `${HIDDEN}, ${HIDDEN}, ${HIDDEN} again`,
    );
  });

  it("leaves nothing of a secret that begins with another one", () => {
    const text = "rotating-token-1 then rotating-token-10";

    for (const secrets of [
      [secret("rotating-token-1"), secret("rotating-token-10")],
      [secret("rotating-token-10"), secret("rotating-token-1")],
    ]) {
      expect(redactSecrets(text, secrets)).toBe(`${HIDDEN} then ${HIDDEN}`);
    }
  });

  it("leaves a text without secrets as it is", () => {
    expect(redactSecrets("nothing to hide", [secret(PLANT)])).toBe("nothing to hide");
    expect(redactSecrets(PLANT, [])).toBe(PLANT);
  });

  // Shaped like a base64 token: "/", "+" and "=" are the characters that writers of JSON and of
  // URLs disagree about.
  const TOKEN = "hubberPlanted/Zm9v+YmFy/c2VjcmV0+w==";
  const everyCharacter = (spell: (code: number) => string) =>
    Array.from(TOKEN, (character) => spell(character.charCodeAt(0))).join("");
  const unicodeEscape = (code: number) => `\\u${code.toString(16).padStart(4, "0")}`;

  it.each([
    ["with the slashes escaped, as PHP writes JSON", TOKEN.replaceAll("/", "\\/")],
    [
      "with \\u003d and \\u002b, as HTML-safe writers of JSON do",
      TOKEN.replaceAll("=", "\\u003d").replaceAll("+", "\\u002b"),
    ],
    ["with the escapes in capitals", TOKEN.replaceAll("/", "\\u002F").replaceAll("+", "\\u002B")],
    ["with every character as a \\u escape", everyCharacter(unicodeEscape)],
    [
      "percent-encoded in small letters",
      encodeURIComponent(TOKEN).replace(/%[0-9A-F]{2}/g, (escaped) => escaped.toLowerCase()),
    ],
    ["percent-encoded in every character", everyCharacter((code) => `%${code.toString(16)}`)],
    [
      "percent-encoded where a URL must be, with its slashes left alone",
      TOKEN.replaceAll("+", "%2B").replaceAll("=", "%3D"),
    ],
    ["percent-encoded in part and then written as JSON by PHP", TOKEN.replaceAll("=", "%3d").replaceAll("/", "\\/")],
  ])("finds a secret %s", (_case, spelled) => {
    // The case and the control agree only if the spelling is one that a reader turns back into the token.
    expect(spelled).not.toBe(TOKEN);
    expect(spelled).not.toContain(TOKEN);

    expect(redactSecrets(`refused: ${spelled}, again: ${spelled}.`, [secret(TOKEN)])).toBe(
      `refused: ${HIDDEN}, again: ${HIDDEN}.`,
    );
  });

  it("leaves nothing for a JSON parser to turn back into the secret, in a value, in a key or in nested JSON", () => {
    const escaped = TOKEN.replaceAll("/", "\\/").replaceAll("=", "\\u003d");
    const inner = `{"upstream":"bad token ${escaped}"}`;
    const body = `{"error":{"message":"bad token ${escaped}","seen":{"${escaped}":true},"raw":${JSON.stringify(inner)},"twice":${JSON.stringify(JSON.stringify(inner))}}}`;
    // Parsed as it stands, the body gives the token back in all four places.
    const leaked = JSON.parse(body);
    expect(leaked.error.message).toBe(`bad token ${TOKEN}`);
    expect(Object.keys(leaked.error.seen)).toEqual([TOKEN]);
    expect(JSON.parse(leaked.error.raw).upstream).toBe(`bad token ${TOKEN}`);
    expect(JSON.parse(JSON.parse(leaked.error.twice)).upstream).toBe(`bad token ${TOKEN}`);

    const cleaned = JSON.parse(redactSecrets(body, [secret(TOKEN)]));

    expect(cleaned.error.message).toBe(`bad token ${HIDDEN}`);
    expect(Object.keys(cleaned.error.seen)).toEqual([HIDDEN]);
    expect(JSON.parse(cleaned.error.raw)).toEqual({ upstream: `bad token ${HIDDEN}` });
    expect(JSON.parse(JSON.parse(cleaned.error.twice))).toEqual({ upstream: `bad token ${HIDDEN}` });
  });

  it("leaves alone escapes that spell something else", () => {
    const text = "path C:\\\\users\\/x, 100%25 sure, \\u0041\\u002f, hubberPlanted\\/Zm9v and c2VjcmV0+w== apart";

    expect(redactSecrets(text, [secret(TOKEN)])).toBe(text);
  });

  it("finds a secret of the greatest length in every spelling, in a long text and in little time", () => {
    // A pattern with a group for each character would be too large to compile at this length.
    const longest = `${"%/+=x9".repeat(1366)}`.slice(0, 8192);
    const filler = "lorem ipsum %2f \\u0041 \\/ ".repeat(20_000);
    const text = `${filler}${longest}${filler}${Array.from(longest, (character) => unicodeEscape(character.charCodeAt(0))).join("")}${filler}${encodeURIComponent(longest)}`;
    const started = performance.now();

    const cleaned = redactSecrets(text, [secret(longest), secret(PLANT)]);

    expect(cleaned).toBe(`${filler}${HIDDEN}${filler}${HIDDEN}${filler}${HIDDEN}`);
    // Far above what it takes: the text is one and a half megabytes, and the time grows with its length, not with a power of it.
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("is not slowed down by a text made to look like the beginning of a secret, or like an escape, over and over", () => {
    const started = performance.now();

    redactSecrets("\\".repeat(1_000_000), [secret(TOKEN)]);
    redactSecrets("%25".repeat(300_000), [secret(`${"%25".repeat(40)}%26`)]);
    redactSecrets("\\u0061".repeat(150_000), [secret(`${"a".repeat(4000)}b`)]);

    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("createRedactor", () => {
  it("replaces values of any shape, as they are and as JSON and URLs write them", () => {
    // What the diagnostics command may be given for a credential: not something a header takes.
    const value = 'to"ken\nwith\\odd ż characters';
    const redact = createRedactor([value]);

    expect(redact(`plain ${value}.`)).toBe(`plain ${HIDDEN}.`);
    expect(redact(JSON.stringify({ message: `refused ${value}` }))).toBe(`{"message":"refused ${HIDDEN}"}`);
    expect(redact(`?token=${encodeURIComponent(value)}&x=1`)).toBe(`?token=${HIDDEN}&x=1`);
    expect(redact(`?token=${encodeURIComponent(value).toLowerCase()}&x=1`)).toBe(`?token=${HIDDEN}&x=1`);
  });

  it("ignores an empty value, which would be found everywhere", () => {
    expect(createRedactor(["", "stand-in-key"])("the stand-in-key was sent")).toBe(`the ${HIDDEN} was sent`);
    expect(createRedactor([""])("nothing to hide")).toBe("nothing to hide");
  });

  it("hides occurrences that follow one another or overlap, each of them whole", () => {
    expect(createRedactor(["abcabcab"])("abcabcabcabcab|abcabcababcabcab")).toBe(`${HIDDEN}|${HIDDEN}${HIDDEN}`);
  });
});
