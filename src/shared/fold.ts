// The one function behind every *_norm column: a name as it is compared when the question is
// "do these two spellings mean the same person or item?". The database cannot do this itself:
// SQLite's lower() knows ASCII only.

/**
 * Counts the rules of foldName(). The folded spellings are stored, so a change to the rules is a
 * migration of the stored values, written in code, and raises this number. fold.test.ts holds
 * the rules of each number in place by what they make of a fixed set of texts.
 */
export const FOLD_VERSION = 1;

// The classes of characters below are those of Unicode, in the version that the runtime has.

// What a text carries without showing it: text pasted from a chat, a web page or a document
// more often than typed text. Two classes together: the format characters (category Cf) and
// everything that is to be ignored where it cannot be shown (the property
// Default_Ignorable_Code_Point). The first holds the soft hyphen, the zero-width space and
// joiners, the marks of writing direction, the word joiner, the byte order mark and the tags;
// the second adds the variation selectors, the Hangul fillers, two Khmer vowels that are not
// written, the mark that keeps two marks apart, and the places that Unicode keeps for more
// characters of the kind. Category Cf also has a few signs that are seen, such as the one
// that Arabic puts before a number: they go with the rest of it.
const UNSEEN = String.raw`[\p{Cf}\p{Default_Ignorable_Code_Point}]`;
const UNSEEN_CHARACTERS = new RegExp(UNSEEN, "gv");

// What stands on the character before it: the marks (category M), and the two half-width sound
// marks of katakana, which are letters to Unicode until a text is taken apart.
const MARK = String.raw`[\p{M}\uff9e\uff9f]`;

// A run of marks from its thirty-first on: thirty marks that are seen, with whatever is not seen
// among them, and then every further mark. No writing puts thirty marks on one letter. A text
// that does is made to look broken, or to keep the server busy: Unicode sorts the marks of a
// letter when a text is taken apart, in a time that grows by the square of their number, and
// for a megabyte of marks that is more than ten minutes.
const MARKS_BEYOND_THIRTY = new RegExp(`((?:[${MARK}--${UNSEEN}]${UNSEEN}*){30})[${MARK}${UNSEEN}]+`, "gv");

// An acute accent that stands alone, typed where an apostrophe belongs. The second is the same
// character to Unicode under its Greek name: a text in one of the normal forms has the first
// in its place.
const ACUTE_ACCENT = /[\u00b4\u1ffd]/g;

// The marks that Unicode writes as characters of their own after a letter has been taken apart:
// the acute of "ó", the ogonek of "ą", the dot of "ż".
const COMBINING_MARKS = /[\u0300-\u036f]/g;

// What typography and a keyboard put in the place of the apostrophe: the single quotation
// marks, in both directions, the modifier letters that are an apostrophe or a comma turned or
// reversed, the grave accent and the prime.
const APOSTROPHES = /[\u2018\u2019\u201b\u02bb\u02bc\u02bd`\u2032]/g;

// Every hyphen and dash that Unicode knows, the minus sign among them.
const DASHES = /\p{Dash}/gu;

// Letters that are whole to Unicode, so taking apart leaves them as they are: the stroke of "ł"
// or "ø" is part of the letter, not a mark. Each folds to the plain letters that commonly stand
// in for it where it cannot be typed: Polish ł; Danish and Norwegian ø and æ; Croatian and
// Vietnamese đ; Icelandic ð and þ; German ß; French œ; Turkish ı; Maltese ħ; Sami ŧ. The small
// letters only: the text is in lower case by the time they are looked for.
const PLAIN_LETTERS = {
  ł: "l",
  ø: "o",
  đ: "d",
  ð: "d",
  þ: "th",
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ı: "i",
  ħ: "h",
  ŧ: "t",
} as const;
const WHOLE_LETTERS = new RegExp(`[${Object.keys(PLAIN_LETTERS).join("")}]`, "g");

// White space, and the control characters (category Cc): they show nothing either, and several
// of them stand between words, the tab and the ends of a line among them.
const WHITE_SPACE = /[\s\p{Cc}]+/gu;

/**
 * Folds a name for matching: letters without their diacritics, in lower case, with single
 * spaces and none at the ends, and without what cannot be seen. "K.  Żyła" and "k. zyla" fold
 * to the same text, and so do a name that was typed and the same name pasted from a document.
 * A folded name folds to itself, and two spellings that are one text to Unicode (a letter with
 * its mark as one character or as two) fold alike, unless a character has more than 30 marks.
 *
 * The whole rule, in the order of its steps:
 *   1. A character keeps at most 30 marks: of a run of marks the first 30 stay. A mark is a
 *      character of category M or one of U+FF9E and U+FF9F; what step 5 removes is not
 *      counted and does not end a run.
 *   2. The acute accent that stands alone (U+00B4, U+1FFD) becomes an apostrophe.
 *   3. The text is taken apart (Unicode's form NFKD).
 *   4. The combining marks U+0300 to U+036F are removed.
 *   5. What cannot be seen is removed: category Cf and the property
 *      Default_Ignorable_Code_Point.
 *   6. The text is put in order once more (NFKD), and step 1 is done again.
 *   7. U+2018, U+2019, U+201B, U+02BB, U+02BC, U+02BD, the grave accent (U+0060) and the
 *      prime (U+2032) become an apostrophe, and every hyphen and dash (the property Dash)
 *      becomes a hyphen-minus.
 *   8. The text is put in lower case.
 *   9. The eleven letters that do not come apart become plain ones: ł l, ø o, đ d, ð d,
 *      þ th, ß ss, æ ae, œ oe, ı i, ħ h, ŧ t.
 *  10. Every run of white space and control characters (category Cc) becomes one space, and
 *      there is none at the ends.
 */
export function foldName(text: string): string {
  return (
    text
      // Before anything that sorts the marks, which is what takes the time.
      .replace(MARKS_BEYOND_THIRTY, "$1")
      // Before the text is taken apart: that would make a space and a combining mark of the
      // accent, and two words of the name.
      .replace(ACUTE_ACCENT, "'")
      // Takes "ż" apart into "z" and its dot, whichever way the text spelled it, and replaces
      // the characters that only stand for others: a ligature, a full-width letter, a
      // no-break space.
      .normalize("NFKD")
      .replace(COMBINING_MARKS, "")
      .replace(UNSEEN_CHARACTERS, "")
      // What was removed may have stood between two marks that stay, those of Hebrew for one,
      // and kept them out of the order Unicode has for them. Without this step such a name
      // would fold differently from the same name without the invisible character.
      .normalize("NFKD")
      // Taken apart, a character can have more marks than it had: the syllable "が" is "か" and
      // a mark, and some marks are two or three. Counted only at the start, a folded name
      // could hold more than thirty, and would lose them when it is folded again.
      .replace(MARKS_BEYOND_THIRTY, "$1")
      // Only now, and not with the acute accent: the full-width grave accent and the double
      // prime have become a grave accent and two primes when the text was taken apart. And
      // before the letters are made small: a capital sigma becomes one of two small letters by
      // what stands beside it, where an apostrophe counts for nothing and another sign for a
      // neighbour, so the name must hold the apostrophe by then, whichever sign was typed.
      .replace(APOSTROPHES, "'")
      .replace(DASHES, "-")
      .toLowerCase()
      .replace(WHOLE_LETTERS, (letter) => PLAIN_LETTERS[letter as keyof typeof PLAIN_LETTERS])
      .replace(WHITE_SPACE, " ")
      .trim()
  );
}
