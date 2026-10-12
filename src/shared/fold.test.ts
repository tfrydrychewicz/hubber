import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FOLD_VERSION, foldName } from "./fold.ts";

// Characters that cannot be seen, that sit on the letter before them or that look like another
// one are written as escapes in this file: in an editor nobody could tell which they are.
describe("the rules of folding and their tests", () => {
  it.each(["fold.ts", "fold.test.ts"])("are written in %s without a character that an editor does not show", (file) => {
    const source = readFileSync(join(import.meta.dirname, file), "utf8");

    // Marks that sit on their neighbour, format characters, controls and every space but the plain
    // one. The end of a line is no such character, however the file was checked out.
    const unseen = [...source].filter(
      (character) => /[\p{M}\p{Cf}\p{Cc}\p{Z}]/u.test(character) && !" \n\r".includes(character),
    );

    expect(unseen.map((character) => character.codePointAt(0)?.toString(16))).toEqual([]);
  });
});

describe("foldName", () => {
  it.each([
    ["K. Żyła", "k. zyla"],
    ["Łukasz Żółć", "lukasz zolc"],
    ["Ł", "l"],
    ["ł", "l"],
    ["ŁÓDŹ", "lodz"],
    ["Zażółć gęślą jaźń", "zazolc gesla jazn"],
    ["ĄĆĘŁŃÓŚŹŻ", "acelnoszz"],
    ["ąćęłńóśźż", "acelnoszz"],
    ["Anna Kowalska", "anna kowalska"],
    ["Migracja płatności", "migracja platnosci"],
  ])("folds %s to %s", (name, folded) => {
    expect(foldName(name)).toBe(folded);
  });

  it("makes one space of every run of white space and leaves none at the ends", () => {
    expect(foldName("Anna  Kowalska")).toBe("anna kowalska");
    expect(foldName("  Anna Kowalska  ")).toBe("anna kowalska");
    expect(foldName("Anna\tKowalska\n")).toBe("anna kowalska");
    // A no-break space, as a name copied out of a messenger can carry, and the wide space of an
    // East Asian keyboard.
    expect(foldName("Anna\u00a0Kowalska")).toBe("anna kowalska");
    expect(foldName("Anna\u3000Kowalska")).toBe("anna kowalska");
    expect(foldName(" \t\n ")).toBe("");
    expect(foldName("")).toBe("");
  });

  it("folds a letter the same way whether its mark is part of it or follows it", () => {
    const composed = "\u017by\u0142a"; // "Żyła" with "Ż" as one character
    const decomposed = "Z\u0307y\u0142a"; // "Z" and the dot above as two

    expect(composed).not.toBe(decomposed);
    expect(foldName(composed)).toBe("zyla");
    expect(foldName(decomposed)).toBe("zyla");
  });

  it("drops the marks of other languages as well", () => {
    expect(foldName("José Müller")).toBe("jose muller");
    expect(foldName("Škoda Ångström")).toBe("skoda angstrom");
    expect(foldName("İstanbul")).toBe("istanbul");
  });

  // Letters with a stroke, a bar or a shape of their own are whole letters to Unicode, not a
  // letter and a mark, so taking apart leaves them as they are.
  it.each([
    ["Tromsø", "tromso"],
    ["KØBENHAVN", "kobenhavn"],
    ["Đakovo", "dakovo"],
    ["Međimurje", "medimurje"],
    ["Đà Nẵng", "da nang"],
    ["Seyðisfjörður", "seydisfjordur"],
    ["Þingvellir", "thingvellir"],
    ["þÞ", "thth"],
    ["Straße", "strasse"],
    // The capital sharp s, which a spelling in capitals alone uses.
    ["STRA\u1e9eE", "strasse"],
    ["Ærø", "aero"],
    ["Encyclopædia", "encyclopaedia"],
    ["Œuvre", "oeuvre"],
    ["cœur", "coeur"],
    ["Işık", "isik"],
    ["ışık", "isik"],
    ["IŞIK", "isik"],
    ["Ħamrun", "hamrun"],
    ["Ŧ and ŧ", "t and t"],
  ])("folds the letters that do not come apart: %s to %s", (name, folded) => {
    expect(foldName(name)).toBe(folded);
  });

  it("gives one spelling to a name however its special letters were typed", () => {
    expect(new Set(["Straße", "Strasse", "STRASSE", "STRA\u1e9eE"].map(foldName)).size).toBe(1);
    expect(new Set(["Işık", "ışık", "IŞIK", "İşik", "isik"].map(foldName)).size).toBe(1);
    expect(new Set(["Tromsø", "Tromso", "TROMSØ"].map(foldName)).size).toBe(1);
  });

  // What a name pasted from a chat, a web page or a document carries and nobody sees.
  it.each([
    ["a zero-width space inside a name", "Anna\u200bKowalska", "annakowalska"],
    ["a zero-width joiner and a zero-width non-joiner", "An\u200dna Kowal\u200cska", "anna kowalska"],
    ["a left-to-right mark behind a name", "Anna Kowalska\u200e", "anna kowalska"],
    ["a right-to-left mark in front of a name", "\u200fAnna Kowalska", "anna kowalska"],
    ["the marks that embed a direction", "\u202aAnna\u202c Kowalska", "anna kowalska"],
    ["a soft hyphen where a line may break", "Kowal\u00adska", "kowalska"],
    ["a word joiner", "Anna\u2060Kowalska", "annakowalska"],
    ["a byte order mark in front of a text", "\ufeffAnna Kowalska", "anna kowalska"],
    // JavaScript counts the byte order mark as white space. It is removed before spaces are looked at.
    ["a byte order mark inside a word, where it is no space", "Anna\ufeffKowalska", "annakowalska"],
    ["a zero-width space between two spaces, which then are one", "Anna \u200b Kowalska", "anna kowalska"],
    ["a format character outside the first 65536", "Anna\u{e0001}Kowalska", "annakowalska"],
    // A sign that Unicode puts before a number in Arabic text: a format character that is seen.
    ["a format character that shows", "Anna\u0600Kowalska", "annakowalska"],
    // What is to be ignored where it cannot be shown, and is no format character to Unicode.
    ["a variation selector behind a name", "Anna Kowalska\ufe0f", "anna kowalska"],
    ["a variation selector outside the first 65536", "Anna\u{e0100} Kowalska", "anna kowalska"],
    ["a Hangul filler, which is a letter that shows nothing", "Anna\u3164Kowalska", "annakowalska"],
    ["the Hangul fillers of the other three kinds", "An\u115fna Kowal\u1160ska\uffa0", "anna kowalska"],
    ["a Mongolian variation selector", "Anna\u180b Kowalska", "anna kowalska"],
    ["a Khmer vowel that is not written", "Anna\u17b4 Kowalska", "anna kowalska"],
    ["the mark that keeps two marks apart", "Anna\u034f Kowalska", "anna kowalska"],
    ["a place that Unicode keeps for such a character to come", "Anna\u2065 Kowalska\u{e0080}", "anna kowalska"],
    ["a name of nothing but fillers and selectors", "\u3164\u115f\u1160\uffa0\ufe0f\u{e0100}", ""],
    ["a name of nothing but characters that cannot be seen", "\u200b\u200e\u00ad\u2060\ufeff", ""],
  ])("drops %s", (_what, name, folded) => {
    expect(foldName(name)).toBe(folded);
  });

  // A control character shows nothing either, but several of them stand between words: the tab,
  // the ends of a line. All of them count as white space.
  it.each([
    ["the character that ends a text in C", "Anna Kowalska\u0000", "anna kowalska"],
    ["the character that ends a text in C, inside a name", "Anna\u0000Kowalska", "anna kowalska"],
    ["the next-line character, which JavaScript does not take for white space", "Anna\u0085Kowalska", "anna kowalska"],
    ["an escape character", "Anna\u001bKowalska", "anna kowalska"],
    ["the delete character", "Anna\u007fKowalska", "anna kowalska"],
    ["the last control character there is", "Anna\u009fKowalska", "anna kowalska"],
    [
      "a run of control characters and spaces, which is one space",
      "Anna \u0000\u0085\t \u001f Kowalska",
      "anna kowalska",
    ],
    ["a name of nothing but control characters", "\u0000\u0001\u0085\u009f", ""],
  ])("takes a control character for white space: %s", (_what, name, folded) => {
    expect(foldName(name)).toBe(folded);
  });

  it.each([
    ["the typographic apostrophe", "O\u2019Brien"],
    ["a left single quotation mark", "O\u2018Brien"],
    ["a single quotation mark turned the other way", "O\u201bBrien"],
    ["the apostrophe that is a letter", "O\u02bcBrien"],
    ["the turned comma that is a letter", "O\u02bbBrien"],
    ["the reversed comma that is a letter", "O\u02bdBrien"],
    ["the full-width apostrophe", "O\uff07Brien"],
    // What a keyboard without an apostrophe key at hand gives: the accents that stand alone, and
    // the sign for minutes and feet.
    ["an acute accent", "O\u00b4Brien"],
    ["a grave accent", "O`Brien"],
    ["a prime", "O\u2032Brien"],
    // The same two accents under their Greek names: to Unicode each is the same character as
    // the one above, and a text that was put into one of the normal forms holds that one.
    ["the Greek acute accent that stands alone", "O\u1ffdBrien"],
    ["the Greek grave accent that stands alone", "O\u1fefBrien"],
    ["the full-width grave accent", "O\uff40Brien"],
  ])("folds %s to the apostrophe of the keyboard", (_what, name) => {
    expect(foldName(name)).toBe("o'brien");
    expect(foldName(name)).toBe(foldName("O'Brien"));
  });

  // The capital sigma has two small letters, and which one it becomes depends on what stands
  // beside it: an apostrophe does not count as standing there, another sign does. Whatever is
  // folded to an apostrophe is one before the letters are made small.
  it("folds a name alike whichever sign stands for its apostrophe, also beside a Greek sigma", () => {
    const signs = ["'", "\u2019", "\u2018", "\u201b", "\u02bc", "\u02bb", "\u02bd", "\uff07", "\u00b4", "`", "\u2032"];

    // Capitals: an alpha and a sigma on either side of the sign.
    for (const [before, after] of [
      ["ΑΣ", "Α"],
      ["Α", "Σ"],
    ]) {
      const folded = signs.map((sign) => foldName(`${before}${sign}${after}`));

      expect(new Set(folded).size).toBe(1);
      expect(folded[0]).toContain("'");
    }
  });

  it("folds the signs that Unicode builds from primes to as many apostrophes", () => {
    expect(foldName("5\u2033")).toBe("5''");
    expect(foldName("5\u2034")).toBe("5'''");
  });

  it.each([
    ["a hyphen", "\u2010"],
    ["a non-breaking hyphen", "\u2011"],
    ["a figure dash", "\u2012"],
    ["an en dash", "\u2013"],
    ["an em dash", "\u2014"],
    ["a horizontal bar", "\u2015"],
    ["a minus sign", "\u2212"],
    ["a small em dash", "\ufe58"],
    ["a full-width hyphen", "\uff0d"],
  ])("folds %s to the hyphen of the keyboard", (_what, dash) => {
    expect(foldName(`Kowalska${dash}Nowak`)).toBe("kowalska-nowak");
    expect(foldName(`PAY${dash}123`)).toBe("pay-123");
  });

  // Unicode keeps some characters only because an older character set had them: a ligature
  // that a PDF puts into a name, the wide letters of an East Asian keyboard.
  it.each([
    ["a ligature", "Of\ufb01ce sta\ufb00", "office staff"],
    ["full-width letters and digits", "\uff21\uff4e\uff4e\uff41 \uff11\uff12", "anna 12"],
    ["a superscript", "Atlas\u00b2", "atlas2"],
    ["the sign for a number", "Projekt \u2116 5", "projekt no 5"],
    ["an ellipsis in one character", "Atlas\u2026", "atlas..."],
  ])("folds the forms that stand for other characters: %s", (_what, name, folded) => {
    expect(foldName(name)).toBe(folded);
  });

  it("keeps what is not a letter with a mark: digits, punctuation, handles and addresses", () => {
    expect(foldName("PAY-123")).toBe("pay-123");
    expect(foldName("@PNowak")).toBe("@pnowak");
    expect(foldName("Anna.Kowalska@Corp.Example")).toBe("anna.kowalska@corp.example");
    expect(foldName("Ania z płatności (2)")).toBe("ania z platnosci (2)");
    expect(foldName("O'Brien")).toBe("o'brien");
  });

  it("leaves a folded name as it is", () => {
    const names = [
      "K.  Żyła",
      "ŁÓDŹ",
      "José Müller",
      "İstanbul",
      "  Anna\tKowalska ",
      "ΟΔΟΣ",
      "Straße",
      "@PNowak",
      "Tromsø Þingvellir Ærø",
      "O\u2019Brien \u2013 Kowal\u00adska\u200b",
      "Of\ufb01ce",
    ];

    for (const name of names) expect(foldName(foldName(name))).toBe(foldName(name));
  });

  // The marks of other scripts stay, and Unicode has one order for the marks of a letter. A
  // character that is dropped from between two of them must not leave them in another order:
  // the name would look the same and fold differently.
  it("gives marks that stay one order, whatever was dropped from between them", () => {
    // The Hebrew letter bet with its two points.
    const [bet, dagesh, sheva] = ["\u05d1", "\u05bc", "\u05b0"];
    const folded = foldName(bet + sheva + dagesh);

    expect(foldName(bet + dagesh + sheva)).toBe(folded);
    // A zero-width joiner, and the mark that is there to keep two marks apart.
    expect(foldName(`${bet}${dagesh}\u200d${sheva}`)).toBe(folded);
    expect(foldName(`${bet}${dagesh}\u034f${sheva}`)).toBe(folded);
    expect(foldName(folded)).toBe(folded);
    // A character that cannot be seen and is a letter to Unicode: a Hangul filler.
    expect(foldName(`${bet}${dagesh}\u3164${sheva}`)).toBe(folded);
  });

  // No writing puts thirty marks on one letter; a text that does is made to look broken, or to
  // keep the server busy: Unicode sorts the marks of a letter, and sorting a long run takes
  // time by the square of its length.
  describe("with more than thirty marks on one character", () => {
    // A Hebrew letter and a point that the rule keeps; a mark of the Latin range, which it drops.
    const [bet, sheva, acute] = ["\u05d1", "\u05b0", "\u0301"];

    it("keeps the first thirty of them", () => {
      expect(foldName(bet + sheva.repeat(30))).toBe(bet + sheva.repeat(30));
      expect(foldName(bet + sheva.repeat(31))).toBe(bet + sheva.repeat(30));
      expect(foldName(`${bet}${sheva.repeat(500)} ${bet}${sheva.repeat(5)}`)).toBe(
        `${bet}${sheva.repeat(30)} ${bet}${sheva.repeat(5)}`,
      );
    });

    it("counts marks of every kind", () => {
      // A Devanagari sign that takes a place of its own behind the letter, and a circle that goes around it.
      for (const mark of ["\u0903", "\u20dd"]) {
        expect(foldName(`a${mark.repeat(40)}`), mark.codePointAt(0)?.toString(16)).toBe(`a${mark.repeat(30)}`);
      }
    });

    it("counts the marks as the text has them, those that are dropped afterwards included", () => {
      expect(foldName(`e${acute.repeat(29)}${sheva}`)).toBe(`e${sheva}`);
      expect(foldName(`e${acute.repeat(30)}${sheva}`)).toBe("e");
    });

    it("counts across what cannot be seen", () => {
      // A zero-width joiner, a Hangul filler, a variation selector.
      for (const unseen of ["\u200d", "\u3164", "\ufe0f"]) {
        const which = unseen.codePointAt(0)?.toString(16);

        expect(foldName(`${bet}${sheva.repeat(20)}${unseen}${sheva.repeat(20)}`), which).toBe(bet + sheva.repeat(30));
        // One run of forty: its first thirty are the twenty marks that are dropped and ten points.
        expect(foldName(`e${acute.repeat(20)}${unseen}${sheva.repeat(20)}`), which).toBe(`e${sheva.repeat(10)}`);
      }
    });

    it("counts the half-width sound marks of katakana, which become marks when a text is taken apart", () => {
      // Half-width ka with fifty voiced sound marks: the ka of full width with thirty marks.
      expect(foldName(`\uff76${"\uff9e".repeat(50)}`)).toBe(`\u30ab${"\u3099".repeat(30)}`);
    });

    // Where those two come from. What makes a long run slow is every character that Unicode
    // sorts with its neighbours once a text is taken apart. The marks are such characters, and
    // of all the others these two are the only ones in the Unicode of this runtime: one more
    // after an upgrade belongs into the rule beside them.
    it("names every character outside the marks that is sorted as a mark once a text is taken apart", () => {
      // Sorted with its neighbours: behind a mark of the highest class, or before one of the
      // lowest, a character changes places with it.
      const [lowest, highest] = ["\u0334", "\u0345"];
      const isSorted = (character: string) =>
        (highest + character).normalize("NFD") !== highest + character ||
        (character + lowest).normalize("NFD") !== character + lowest;

      const found: string[] = [];
      for (let point = 0; point <= 0x10ffff; point++) {
        // The two halves of a pair are no characters.
        if (point >= 0xd800 && point <= 0xdfff) continue;
        const character = String.fromCodePoint(point);
        const first = String.fromCodePoint(character.normalize("NFKD").codePointAt(0) ?? 0);
        if (isSorted(first) && !/^\p{M}$/u.test(character)) found.push(point.toString(16));
      }

      expect(found).toEqual(["ff9e", "ff9f"]);
    });

    it("counts again when the text has been taken apart, where a character can bring marks of its own", () => {
      // The syllable ga is ka and a voiced sound mark; with thirty points behind it that is one more than thirty.
      expect(foldName(`\u304c${sheva.repeat(30)}`)).toBe(`\u304b\u3099${sheva.repeat(29)}`);
      // A Tibetan vowel sign that is two signs to Unicode: thirty of them are sixty.
      expect(foldName(`a${"\u0f73".repeat(30)}`)).toBe(`a${"\u0f71".repeat(30)}`);
    });

    it("leaves a text with thirty marks or fewer on a character as it would be without the limit", () => {
      const vietnamese = "Nguy\u1ec5n Th\u1ecb Ng\u1ecdc \u00c1nh";
      const pointed = "\u05d1\u05bc\u05b0\u05e8\u05b5\u05d0\u05e9\u05c1\u05b4\u05d9\u05ea";

      expect(foldName(vietnamese)).toBe("nguyen thi ngoc anh");
      expect(foldName(pointed)).toBe(pointed.normalize("NFKD"));
    });

    // Each of these took from seconds to more than ten minutes while nothing limited the marks of
    // a character, or would take them if the limit were counted another way. The time a test may
    // take is the measure: with the limit each is folded in a few milliseconds.
    it.each([
      ["marks of the Latin range, out of order", () => `a${"\u0315\u0300\u0323\u0328\u0334".repeat(26_000)}`],
      ["Hebrew points, out of order", () => `\u05d1${"\u05c2\u05c1\u05bc\u05b9\u05b0".repeat(26_000)}`],
      ["half-width sound marks between overlays", () => `\uff76${"\uff9e\u0334".repeat(65_000)}`],
      ["points with a zero-width joiner between them", () => `\u05d1${"\u05bc\u200d\u05b0\u200d".repeat(130_000)}`],
      ["points with a Hangul filler between them", () => `\u05d1${"\u05bc\u3164\u05b0\u3164".repeat(130_000)}`],
      ["points with a variation selector between them", () => `\u05d1${"\u05bc\ufe0f\u05b0\ufe0f".repeat(130_000)}`],
      [
        "points with a place between them that Unicode keeps for a character to be ignored",
        () => `\u05d1${"\u05bc\u2065\u05b0\u2065".repeat(130_000)}`,
      ],
      ["nothing but variation selectors", () => `a${"\ufe0f".repeat(1_000_000)}`],
      [
        "twenty-nine points and a hundred thousand joiners behind them",
        () => `${"\u05b0".repeat(29)}${"\u200d".repeat(100_000)}x`,
      ],
    ])("folds a long run in the time of any other text: %s", { timeout: 2_000 }, (_what, text) => {
      const folded = foldName(text());

      expect([...folded.matchAll(/\p{M}+/gu)].every(([marks]) => [...marks].length <= 30)).toBe(true);
      expect(foldName(folded)).toBe(folded);
    });
  });

  // Unicode has more than one spelling for many a text: a letter with its mark as one character
  // or as two, and marks in any order. A text is the same name in each of them.
  it("folds a text alike in each of the spellings that Unicode takes for the same text", () => {
    const texts = [
      "K. \u017by\u0142a",
      "Z\u0307y\u0142a",
      "Nguy\u1ec5n",
      "e\u0328\u0301 e\u0301\u0328",
      "\u05d1\u05b0\u05bc",
      "O\u00b4Brien O\u1ffdBrien O`Brien O\u1fefBrien",
      "\u304c\u30d1 \u1100\u1161\u11a8 \uac01",
      "\u0622\u0653 \u212b \u2126 \ufb2c",
    ];

    for (const text of texts) {
      expect(foldName(text.normalize("NFC")), text).toBe(foldName(text));
      expect(foldName(text.normalize("NFD")), text).toBe(foldName(text));
    }
  });

  it("tells apart names that differ in more than case, marks and spacing", () => {
    expect(foldName("Anna Kowalska")).not.toBe(foldName("Anna Kowalski"));
    expect(foldName("AnnaKowalska")).not.toBe(foldName("Anna Kowalska"));
    expect(foldName("Kowalska-Nowak")).not.toBe(foldName("Kowalska Nowak"));
    expect(foldName("OBrien")).not.toBe(foldName("O'Brien"));
  });
});

describe("FOLD_VERSION", () => {
  // The texts that hold the rules of foldName() in place: every character of the alphabets
  // that names are written in here, of the punctuation around them and of what pasted text
  // carries unseen. Only characters that Unicode has assigned, so that a newer Unicode in the
  // runtime adds nothing to them.
  const CHARACTERS: [first: number, last: number][] = [
    // Controls, ASCII, Latin-1, Latin Extended-A and -B, IPA, modifier letters, combining marks.
    [0x0000, 0x036f],
    // Greek and Coptic, without the places that are left empty.
    [0x0370, 0x0377],
    [0x037a, 0x037f],
    [0x0384, 0x038a],
    [0x038c, 0x038c],
    [0x038e, 0x03a1],
    [0x03a3, 0x03ff],
    // Cyrillic and its supplement.
    [0x0400, 0x052f],
    // Latin Extended Additional.
    [0x1e00, 0x1eff],
    // General punctuation: spaces, hyphens and dashes, quotation marks, format characters.
    [0x2000, 0x2064],
    [0x2066, 0x206f],
    // The superscript and the subscript minus, the minus sign, the ideographic space.
    [0x207b, 0x207b],
    [0x208b, 0x208b],
    [0x2212, 0x2212],
    [0x3000, 0x3000],
    // Latin ligatures, small dashes, the byte order mark, full-width ASCII.
    [0xfb00, 0xfb06],
    [0xfe58, 0xfe58],
    [0xfe63, 0xfe63],
    [0xfeff, 0xfeff],
    [0xff01, 0xff5e],
    // Outside the first 65536: a letter that stands for another, an emoji, a format character.
    [0x1d400, 0x1d400],
    [0x1f600, 0x1f600],
    [0xe0001, 0xe0001],
    // Outside all of these, some members of every class that a rule names as a class, so that a
    // rule which is narrowed to the characters above does not go unseen.
    // Format characters: the Arabic ones that show, the Arabic letter mark, the signs of an
    // annotation between the lines, a tag.
    [0x0600, 0x0605],
    [0x061c, 0x061c],
    [0xfff9, 0xfffb],
    [0xe0020, 0xe0020],
    // To be ignored where they cannot be shown, and no format characters: the Hangul fillers,
    // two Khmer vowels, the Mongolian variation selectors with the vowel separator among them,
    // the variation selectors and one of those outside the first 65536.
    [0x115f, 0x1160],
    [0x17b4, 0x17b5],
    [0x180b, 0x180f],
    [0x3164, 0x3164],
    [0xfe00, 0xfe0f],
    [0xffa0, 0xffa0],
    [0xe0100, 0xe0100],
    // Hyphens and dashes: Armenian, Hebrew, Mongolian, of two and of three ems, the wave dash, Yezidi.
    [0x058a, 0x058a],
    [0x05be, 0x05be],
    [0x1806, 0x1806],
    [0x2e3a, 0x2e3b],
    [0x301c, 0x301c],
    [0x10ead, 0x10ead],
    // The other hyphens and dashes that are left whole when a text is taken apart, so that the
    // class alone decides them: Canadian, four of the supplemental punctuation, the wavy dash,
    // the double hyphen of katakana and hiragana, and the hyphen of Garay, which Unicode has
    // had since its version 16.
    [0x1400, 0x1400],
    [0x2e17, 0x2e17],
    [0x2e1a, 0x2e1a],
    [0x2e40, 0x2e40],
    [0x2e5d, 0x2e5d],
    [0x3030, 0x3030],
    [0x30a0, 0x30a0],
    [0x10d6e, 0x10d6e],
    // The Greek grave and acute accents that stand alone, the half-width sound marks of
    // katakana, and digits that are not folded: Arabic-Indic.
    [0x1fef, 0x1fef],
    [0x1ffd, 0x1ffd],
    [0xff9e, 0xff9f],
    [0x0660, 0x0669],
  ];
  // Whole names, for what depends on the neighbours of a character: the sigma at the end of a
  // word and beside what stands for an apostrophe, marks in an order of their own, a sign that
  // is repeated, control characters among spaces, the limit of thirty marks on one character
  // and what does not divide a run of them.
  const NAMES = [
    "Kowalska--Nowak",
    "O''Brien",
    `e${"\u0301".repeat(20)}\u200d${"\u05b0".repeat(20)} e${"\u0301".repeat(20)}\u3164${"\u05b0".repeat(20)}`,
    `a${"\u0903".repeat(31)} a${"\u20dd".repeat(31)}`,
    "ΑΣ\u2032Α Α\u201bΣ ΑΣ'Α",
    "Anna \u0000\u0085\t Kowalska\u0000",
    `\u05d1${"\u05b0".repeat(31)}`,
    `e${"\u0301".repeat(30)}\u05b0 e${"\u0301".repeat(29)}\u05b0`,
    `\u05d1${"\u05b0".repeat(20)}\u200d${"\u05b0".repeat(20)}`,
    `\u05d1${"\u05b0".repeat(20)}\u3164${"\u05b0".repeat(20)}`,
    `\u304c${"\u05b0".repeat(30)}`,
    `a${"\u0f73".repeat(30)}`,
    `\uff76${"\uff9e\u0334".repeat(20)}`,
    "\u05d1\u05bc\u3164\u05b0",
    "K.  Żyła",
    "ΟΔΟΣ ΟΔΟΣ.",
    "Σ",
    "Straße",
    "İstanbul Işık",
    "O\u2019Brien \u2013 Kowal\u00adska\u200b",
    "\u05d1\u05bc\u200d\u05b0",
    "e\u0328\u0301 \u0301e",
    // Far longer than any name: a rule that cuts a name at a length shows here.
    "Anna Maria ".repeat(40),
  ];

  function texts(): string[] {
    const all = [...NAMES];
    for (const [first, last] of CHARACTERS) {
      for (let point = first; point <= last; point++) {
        const character = String.fromCodePoint(point);
        // Alone, inside a word, and between two spaces.
        all.push(character, `a${character}B`, `x ${character} y`);
      }
    }
    return all;
  }

  /**
   * What the rules of each version make of the texts, as a sha256 over the folded spellings.
   * The folded spellings are stored. A change of foldName() that changes this hash changes what
   * is stored for some name: it gets a new FOLD_VERSION, a line of its own here with the hash
   * that the failing test prints, and a migration of the stored values. The line of a version
   * that names were stored with is never edited, and neither are the texts: with other texts
   * the same rules have another hash.
   */
  const FOLDED: Record<number, string> = {
    1: "b9f82e59dde50d8ec010f1852ae80254fa63a40b5ca14377a19669ec70efc9d7",
  };

  it("is the newest version that has its rules recorded", () => {
    expect(Math.max(...Object.keys(FOLDED).map(Number))).toBe(FOLD_VERSION);
  });

  it("stands for rules that fold a fixed set of texts as they did when it was given", () => {
    const hash = createHash("sha256")
      .update(JSON.stringify(texts().map(foldName)))
      .digest("hex");

    expect(hash).toBe(FOLDED[FOLD_VERSION]);
  });

  it("stands for rules that leave every one of those texts as it is once it is folded", () => {
    const changedAgain = texts().filter((text) => foldName(foldName(text)) !== foldName(text));

    expect(changedAgain).toEqual([]);
  });

  // The limit of thirty marks is counted in the text as it arrives, so it is the one rule that
  // can tell two spellings of a text apart: a letter with its mark is one character in the one
  // and two in the other. The texts that are there for the limit are left out.
  it("stands for rules that fold every one of those texts alike in each spelling Unicode has for it", () => {
    // More than thirty marks in a row, once every mark stands by itself and nothing unseen is between them.
    const beyondTheLimit = (text: string) =>
      /\p{M}{31}/u.test(text.normalize("NFD").replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, ""));
    const withinTheLimit = texts().filter((text) => !beyondTheLimit(text));
    const foldedApart = withinTheLimit.filter(
      (text) =>
        foldName(text.normalize("NFC")) !== foldName(text) || foldName(text.normalize("NFD")) !== foldName(text),
    );

    expect(foldedApart).toEqual([]);
    expect(texts().length - withinTheLimit.length).toBeLessThan(20);
  });

  it("has only assigned characters among its texts", () => {
    const unassigned = CHARACTERS.flatMap(([first, last]) =>
      Array.from({ length: last - first + 1 }, (_, index) => first + index).filter((point) =>
        /^\p{Cn}$/u.test(String.fromCodePoint(point)),
      ),
    );

    expect(unassigned.map((point) => point.toString(16))).toEqual([]);
  });
});
