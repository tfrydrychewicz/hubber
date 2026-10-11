import { inspect } from "node:util";

export const HIDDEN = "[ukryte]";

const MIN_LENGTH = 8;
const MAX_LENGTH = 8192;
// Visible ASCII without the double quote and the backslash: what every HTTP stack sends as a
// header value unchanged. A text that repeats such a value can still spell it in other ways;
// createRedactor() reads them.
const SHAPE = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

export type SecretProblem = "empty" | "bearer-prefix" | "too-short" | "too-long" | "not-a-header-value";

/** For messages. None of them repeats the value. */
export const SECRET_PROBLEM_TEXT: Record<SecretProblem, string> = {
  empty: "jest puste",
  "bearer-prefix": "zaczyna się od słowa „Bearer”; podaj sam token, aplikacja dopisuje to słowo sama",
  "too-short": `jest krótsze niż ${MIN_LENGTH} znaków`,
  "too-long": `jest dłuższe niż ${MAX_LENGTH} znaków`,
  "not-a-header-value":
    "zawiera znak, którego nie da się wysłać w nagłówku: odstęp, znak nowej linii, cudzysłów, ukośnik wsteczny albo znak spoza ASCII",
};

/**
 * A credential in memory. The value leaves only through reveal(): a log line, JSON.stringify()
 * or util.inspect() of anything that holds a Secret prints a placeholder instead.
 */
export class Secret {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  /**
   * Accepts what can be sent as a header value as it is, after trimming the white space around
   * it (a file or a command ends its output with a newline). The check comes first because
   * Headers.set() repeats a value with a line break inside in its error message.
   */
  static parse(raw: string): Secret | SecretProblem {
    const value = raw.trim();
    if (value === "") return "empty";
    if (/^bearer\s/i.test(value)) return "bearer-prefix";
    if (!SHAPE.test(value)) return "not-a-header-value";
    if (value.length < MIN_LENGTH) return "too-short";
    if (value.length > MAX_LENGTH) return "too-long";
    return new Secret(value);
  }

  reveal(): string {
    return this.#value;
  }

  equals(other: Secret): boolean {
    return this.#value === other.#value;
  }

  toString(): string {
    return HIDDEN;
  }

  toJSON(): string {
    return HIDDEN;
  }

  [inspect.custom](): string {
    return HIDDEN;
  }
}

/** A text as a reader of escapes sees it. */
interface Reading {
  text: string;
  /** Where the character at `index` of `text` begins in the original; the length of `text` gives where the original ends. */
  place: (index: number) => number;
}

// The character behind each letter that JSON allows after a backslash. The backslash itself is
// left out: a value that holds one is found by the way a JSON writer spells the whole value.
const JSON_LETTERS: ReadonlyMap<string, string> = new Map([
  ['"', '"'],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

const HEX_PAIR = /^[0-9a-f]{2}$/i;
const HEX_QUAD = /^[0-9a-f]{4}$/i;

/**
 * Reads the escapes of JSON ("\/", "\u002f"), of a URL ("%2F"), or both, and leaves the rest of
 * the text as it stands.
 *
 * Any number of backslashes may stand before a JSON escape: in a JSON text that is itself held
 * in a JSON string every backslash is doubled. Reading more of them than a parser would hides
 * nothing but a spelling of the value. Of the URL escapes only those of ASCII are read; a value
 * with other characters is found by the way a URL writer spells the whole value.
 */
function read(original: string, escapes: { json: boolean; url: boolean }): Reading {
  const characters: string[] = [];
  const starts: number[] = [];
  let index = 0;
  const take = (character: string, end: number) => {
    characters.push(character);
    starts.push(index);
    index = end;
  };
  while (index < original.length) {
    const character = original.charAt(index);
    if (escapes.json && character === "\\") {
      let letterAt = index + 1;
      while (original.charAt(letterAt) === "\\") letterAt++;
      const letter = original.charAt(letterAt);
      const digits = original.slice(letterAt + 1, letterAt + 5);
      if (letter === "u" && HEX_QUAD.test(digits)) {
        take(String.fromCharCode(Number.parseInt(digits, 16)), letterAt + 5);
        continue;
      }
      const escaped = JSON_LETTERS.get(letter);
      if (escaped !== undefined) {
        take(escaped, letterAt + 1);
        continue;
      }
      // Backslashes that escape nothing, all at once: looking at each of them for what follows
      // the others would take the square of their number.
      while (index < letterAt) take("\\", index + 1);
      continue;
    }
    if (escapes.url && character === "%") {
      const digits = original.slice(index + 1, index + 3);
      const code = HEX_PAIR.test(digits) ? Number.parseInt(digits, 16) : Number.NaN;
      if (code < 0x80) {
        take(String.fromCharCode(code), index + 3);
        continue;
      }
    }
    take(character, index + 1);
  }
  return { text: characters.join(""), place: (at) => starts[at] ?? original.length };
}

/** A value as it is, and as the standard writers of JSON and of URLs spell it. */
function spellings(value: string): string[] {
  const inJson = JSON.stringify(value).slice(1, -1);
  // A lone surrogate has no percent-encoding.
  const inUrl = value.isWellFormed() ? encodeURIComponent(value) : value;
  return [value, inJson, inUrl, inUrl.replace(/%[0-9A-F]{2}/g, (escaped) => escaped.toLowerCase())];
}

/**
 * A function that replaces every occurrence of the given values in a text: as they are, and as
 * JSON and URLs write them, in whichever of their escapes ("\/", "\u003d", "%2F", "%2f") and for
 * however many of the characters.
 *
 * The JSON escapes are what matters most. A reader that parses the text gets the plain value
 * out of each of them, wherever it stands: in a value, in a key, or in JSON nested in a string.
 * So the text is searched once more the way such a reader sees it, and what is found there is
 * replaced in the text itself, before anyone parses it.
 *
 * Out of reach are spellings that transform the value as a whole: base64, a hash, a part of it.
 */
export function createRedactor(values: Iterable<string>): (text: string) => string {
  // An empty value would be found between any two characters.
  const needles = [...new Set([...values].filter((value) => value !== "").flatMap(spellings))];
  return (text) => {
    const hasJson = text.includes("\\");
    const hasUrl = text.includes("%");
    const readings: Reading[] = [{ text, place: (at) => at }];
    if (hasJson) readings.push(read(text, { json: true, url: false }));
    if (hasUrl) readings.push(read(text, { json: false, url: true }));
    if (hasJson && hasUrl) readings.push(read(text, { json: true, url: true }));

    // Every stretch of the original that spells a value, as [start, end).
    const found: Array<[start: number, end: number]> = [];
    for (const reading of readings) {
      for (const needle of needles) {
        for (let at = reading.text.indexOf(needle); at !== -1; at = reading.text.indexOf(needle, at + 1)) {
          found.push([reading.place(at), reading.place(at + needle.length)]);
        }
      }
    }
    found.sort((a, b) => a[0] - b[0]);

    const pieces: string[] = [];
    // The end of the stretch hidden last: the original is dealt with up to here.
    let done = 0;
    for (const [start, end] of found) {
      // Stretches that overlap are hidden as one: where a value begins with another one, or is
      // found in two readings, nothing of the longer stretch may stay.
      if (start >= done) pieces.push(text.slice(done, start), HIDDEN);
      done = Math.max(done, end);
    }
    pieces.push(text.slice(done));
    return pieces.join("");
  };
}

/** Replaces every occurrence of the given secrets, in each spelling that createRedactor() reads. */
export function redactSecrets(text: string, secrets: Iterable<Secret>): string {
  return createRedactor(Array.from(secrets, (secret) => secret.reveal()))(text);
}
