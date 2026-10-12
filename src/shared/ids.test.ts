import { afterEach, describe, expect, it, vi } from "vitest";
import { ID_PREFIXES, type IdKind, type ItemId, idKindOf, isId, newId, type PersonId, type SourceId } from "./ids.ts";

const KINDS = Object.keys(ID_PREFIXES) as IdKind[];
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Makes the next id come out of the given bytes instead of random ones. */
function drawBytes(bytes: number[]): void {
  vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
    (array as Uint8Array).set(bytes);
    return array;
  });
}

describe("ID_PREFIXES", () => {
  it("gives every kind three lower-case letters of its own", () => {
    const prefixes = Object.values(ID_PREFIXES);

    for (const prefix of prefixes) expect(prefix).toMatch(/^[a-z]{3}$/);
    // Two kinds with one prefix could not be told apart by their ids.
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

describe("newId", () => {
  it.each(KINDS)("writes the prefix of %s, an underscore and twelve characters of the alphabet", (kind) => {
    const id = newId(kind);

    expect(id.slice(0, 4)).toBe(`${ID_PREFIXES[kind]}_`);
    expect(id.slice(4)).toHaveLength(12);
    expect([...id.slice(4)].every((character) => ALPHABET.includes(character))).toBe(true);
  });

  it("takes each character from five bits of a byte drawn with crypto.getRandomValues", () => {
    drawBytes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(newId("item")).toBe("itm_0123456789ab");

    drawBytes([12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
    expect(newId("item")).toBe("itm_cdefghjkmnpq");

    // The three bits above the five are dropped, so 32, 64 and 255 are 0, 0 and 31.
    drawBytes([24, 25, 26, 27, 28, 29, 30, 31, 32, 64, 224, 255]);
    expect(newId("item")).toBe("itm_rstvwxyz000z");
  });

  it("asks for twelve random bytes, no more and no fewer", () => {
    const draw = vi.spyOn(crypto, "getRandomValues");

    newId("fact");

    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw.mock.calls[0]?.[0]).toBeInstanceOf(Uint8Array);
    expect(draw.mock.calls[0]?.[0]).toHaveLength(12);
  });

  it("does not repeat itself", () => {
    const ids = new Set(Array.from({ length: 20_000 }, () => newId("operation")));

    expect(ids.size).toBe(20_000);
  });

  it("uses the whole alphabet and nothing outside it", () => {
    const seen = new Set(Array.from({ length: 2_000 }, () => newId("run").slice(4)).join(""));

    expect([...seen].sort().join("")).toBe(ALPHABET);
  });
});

describe("isId", () => {
  it.each(KINDS)("accepts what newId() writes for %s, and for no other kind", (kind) => {
    const id = newId(kind);

    expect(KINDS.filter((other) => isId(other, id))).toEqual([kind]);
  });

  it.each([
    ["a short id, as tests write them into the database", "itm_p1"],
    ["eleven characters", "itm_0123456789a"],
    ["thirteen characters", "itm_0123456789abc"],
    ["the prefix alone", "itm_"],
    ["no underscore", "itm0123456789abc"],
    ["a hyphen in place of the underscore", "itm-0123456789ab"],
    ["an upper-case prefix", "ITM_0123456789ab"],
    ["an upper-case character", "itm_0123456789aB"],
    ["the letter i, which the alphabet leaves out", "itm_0123456789ai"],
    ["the letter l, which the alphabet leaves out", "itm_0123456789al"],
    ["the letter o, which the alphabet leaves out", "itm_0123456789ao"],
    ["the letter u, which the alphabet leaves out", "itm_0123456789au"],
    ["a space in front", " itm_0123456789ab"],
    ["a space behind", "itm_0123456789ab "],
    ["a line break behind", "itm_0123456789ab\n"],
    ["a NUL character behind", "itm_0123456789ab\u0000"],
    ["a NUL character in the place of a character", "itm_0123456789a\u0000"],
    ["an id inside a longer text", "see itm_0123456789ab"],
    ["the empty text", ""],
  ])("refuses %s", (_what, value) => {
    expect(isId("item", value)).toBe(false);
  });

  it.each([
    ["a number", 42],
    ["null", null],
    ["undefined", undefined],
    ["an object that prints as an id", { toString: () => "itm_0123456789ab" }],
    ["a list with an id in it", ["itm_0123456789ab"]],
  ])("refuses %s", (_what, value) => {
    expect(isId("item", value)).toBe(false);
  });

  it("refuses the id of another kind", () => {
    expect(isId("item", "per_0123456789ab")).toBe(false);
    expect(isId("person", "per_0123456789ab")).toBe(true);
  });

  it("narrows the value to the id type of the kind", () => {
    const value: unknown = newId("item");
    const narrowed = (): ItemId | undefined => (isId("item", value) ? value : undefined);

    expect(narrowed()).toBe(value);
  });
});

describe("idKindOf", () => {
  it.each(KINDS)("names %s for an id of that kind", (kind) => {
    expect(idKindOf(newId(kind))).toBe(kind);
  });

  it("names the kind of everything that isId() accepts", () => {
    for (const kind of KINDS) {
      const id = newId(kind);
      expect(isId(kind, id)).toBe(true);
      expect(idKindOf(id)).toBe(kind);
    }
  });

  // It reads ids that the application holds, and the database holds more than newId() writes:
  // it checks the prefix and the characters, not the length.
  it.each([
    ["a short id, as tests write them into the database", "itm_p1", "item"],
    ["an id with the letters that newId() leaves out", "per_ilou", "person"],
    ["an id with an underscore and digits after the prefix", "fct_2026_10", "fact"],
    ["an id longer than newId() writes", `opr_${"z".repeat(40)}`, "operation"],
  ])("names the kind of %s", (_what, text, kind) => {
    expect(idKindOf(text)).toBe(kind);
  });

  it.each([
    ["a prefix that no kind has", "xyz_0123456789ab"],
    ["a known prefix and nothing after it", "opr_"],
    ["a known prefix without the underscore", "itm0123456789ab"],
    ["a known prefix after another character", "xitm_0123456789ab"],
    ["an upper-case prefix", "ITM_0123456789ab"],
    ["an upper-case character", "itm_0123456789aB"],
    ["punctuation", "itm_a-b"],
    ["a space", "itm_a b"],
    ["a line break behind", "itm_0123456789ab\n"],
    // The text functions of SQLite stop reading at a NUL character; an id ends where its text ends.
    ["a NUL character behind", "itm_0123456789ab\u0000"],
    ["a NUL character and what the rule forbids behind it", "itm_a\u0000B-! <x>"],
    ["a letter with a mark", "itm_ż"],
    ["the empty text", ""],
  ])("gives nothing for %s", (_what, text) => {
    expect(idKindOf(text)).toBeUndefined();
  });
});

describe("the id types", () => {
  it("keep the ids of different kinds apart", () => {
    const item: ItemId = newId("item");
    // @ts-expect-error an item id is not a person id
    const person: PersonId = newId("item");
    // A capture is the one kind of source there is so far.
    const source: SourceId = newId("capture");
    // @ts-expect-error an item is not a source
    const notASource: SourceId = newId("item");

    expect([item, person, notASource].every((id) => id.startsWith("itm_"))).toBe(true);
    expect(source.startsWith("cap_")).toBe(true);
  });
});
