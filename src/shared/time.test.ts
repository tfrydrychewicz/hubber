import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addDays,
  type Day,
  diffDays,
  type Instant,
  instantOf,
  localDayOf,
  parseDay,
  parseInstant,
  periodEnd,
  periodStart,
  weekdayOf,
} from "./time.ts";
import { NAMED_PERIODS, type NamedPeriod } from "./vocabulary.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The day that a test names, checked like any other text. */
function asDay(text: string): Day {
  const parsed = parseDay(text);
  if (parsed === undefined) throw new Error(`The test names a day that does not exist: ${text}`);
  return parsed;
}

/** A Date in a year that Date.UTC() cannot name: it reads the years 0 to 99 as 1900 to 1999. */
function utc(
  year: number,
  month = 1,
  day = 1,
  ...time: [hours?: number, minutes?: number, seconds?: number, ms?: number]
) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(time[0] ?? 0, time[1] ?? 0, time[2] ?? 0, time[3] ?? 0);
  return date;
}

// Spellings of a moment that are not the one spelling, and moments that do not exist.
const NOT_INSTANTS: [what: string, text: string][] = [
  ["a space in place of the T", "2026-10-11 09:36:07.123Z"],
  ["no milliseconds", "2026-10-11T09:36:07Z"],
  ["two fractional digits", "2026-10-11T09:36:07.12Z"],
  ["four fractional digits", "2026-10-11T09:36:07.1234Z"],
  ["a comma before the milliseconds", "2026-10-11T09:36:07,123Z"],
  ["an offset in place of the Z", "2026-10-11T11:36:07.123+02:00"],
  ["a zero offset in place of the Z", "2026-10-11T09:36:07.123+00:00"],
  ["no zone", "2026-10-11T09:36:07.123"],
  ["lower-case letters", "2026-10-11t09:36:07.123z"],
  ["no seconds", "2026-10-11T09:36Z"],
  ["a day alone", "2026-10-11"],
  ["a year of six digits", "+002026-10-11T09:36:07.123Z"],
  ["a year before the year 0", "-000001-01-01T00:00:00.000Z"],
  // SQLite's date functions read a minus sign before four digits as a year before the year 0.
  ["a year of four digits with a minus sign", "-2026-10-11T09:36:07.123Z"],
  ["a year of four digits with a plus sign", "+2026-10-11T09:36:07.123Z"],
  ["month 13", "2026-13-11T09:36:07.123Z"],
  ["month 0", "2026-00-11T09:36:07.123Z"],
  ["day 32", "2026-10-32T09:36:07.123Z"],
  ["day 0", "2026-10-00T09:36:07.123Z"],
  ["the thirtieth of February", "2026-02-30T09:36:07.123Z"],
  ["the 29th of February in a year that has none", "2026-02-29T09:36:07.123Z"],
  ["the 31st of April", "2026-04-31T09:36:07.123Z"],
  ["hour 24, which is the next day spelled another way", "2026-10-11T24:00:00.000Z"],
  ["hour 24 with minutes", "2026-10-11T24:30:15.123Z"],
  ["hour 25", "2026-10-11T25:00:00.000Z"],
  ["minute 60", "2026-10-11T09:60:07.123Z"],
  ["second 60", "2026-10-11T23:59:60.000Z"],
  ["a space in front", " 2026-10-11T09:36:07.123Z"],
  ["a space behind", "2026-10-11T09:36:07.123Z "],
  ["a line break behind", "2026-10-11T09:36:07.123Z\n"],
  ["milliseconds since 1970", "1791711367123"],
  ["a word", "now"],
  ["the empty text", ""],
];

const NOT_DAYS: [what: string, text: string][] = [
  ["the thirtieth of February", "2026-02-30"],
  ["the 29th of February in a year that has none", "2026-02-29"],
  ["the 29th of February of 1900, which was no leap year", "1900-02-29"],
  ["the 31st of April", "2026-04-31"],
  ["month 13", "2026-13-01"],
  ["month 0", "2026-00-10"],
  ["day 0", "2026-10-00"],
  ["day 32", "2026-10-32"],
  ["a month without its leading zero", "2026-1-05"],
  ["a day without its leading zero", "2026-10-5"],
  ["a year of two digits", "26-10-11"],
  ["a year of five digits", "12026-10-11"],
  // SQLite's date() reads a minus sign before four digits as a year before the year 0.
  ["a year with a minus sign", "-2026-10-11"],
  ["a year with a plus sign", "+2026-10-11"],
  ["a day with a time", "2026-10-11T00:00:00.000Z"],
  ["no hyphens", "20261011"],
  ["slashes", "2026/10/11"],
  ["the day first", "11-10-2026"],
  ["a space in front", " 2026-10-11"],
  ["a space behind", "2026-10-11 "],
  ["a line break behind", "2026-10-11\n"],
  ["a word", "today"],
  ["the empty text", ""],
];

/**
 * What can stand where a text belongs when a value comes from outside: the body of a request or
 * a tool call of the model, which the compiler has not seen. Each is no text, though several
 * would print as the given one.
 */
const notTexts = (text: string): [what: string, value: unknown][] => [
  ["a list with the text in it", [text]],
  ["a list in a list", [[text]]],
  ["an object that prints as the text", { toString: () => text }],
  ["a Date", new Date("2026-10-11T09:36:07.123Z")],
  ["a number", 20261011],
  ["true", true],
  ["null", null],
  ["undefined", undefined],
];

describe("instantOf", () => {
  it("writes the moment as toISOString() does", () => {
    const date = new Date(Date.UTC(2026, 9, 11, 9, 36, 7, 123));

    expect(instantOf(date)).toBe("2026-10-11T09:36:07.123Z");
    expect(instantOf(date)).toBe(date.toISOString());
  });

  it("writes UTC, whatever zone the Date was made in", () => {
    expect(instantOf(new Date("2026-10-11T11:36:07.123+02:00"))).toBe("2026-10-11T09:36:07.123Z");
  });

  it("fills every part to its full width", () => {
    expect(instantOf(new Date(Date.UTC(2026, 0, 5, 3, 4, 5, 6)))).toBe("2026-01-05T03:04:05.006Z");
    expect(instantOf(utc(7, 2, 3))).toBe("0007-02-03T00:00:00.000Z");
  });

  it("reaches from the first millisecond of the year 0 to the last of the year 9999", () => {
    expect(instantOf(utc(0))).toBe("0000-01-01T00:00:00.000Z");
    expect(instantOf(utc(9999, 12, 31, 23, 59, 59, 999))).toBe("9999-12-31T23:59:59.999Z");
  });

  it.each([
    ["an invalid Date", new Date(Number.NaN)],
    ["a Date made from words", new Date("yesterday")],
    // toISOString() writes these with a sign and six digits.
    ["a moment after the year 9999", utc(10_000)],
    ["a moment before the year 0", utc(0, 1, 1, 0, 0, 0, -1)],
  ])("throws a RangeError for %s", (_what, date) => {
    expect(() => instantOf(date)).toThrow(RangeError);
  });

  it("gives texts whose order is the order of the moments", () => {
    const dates = [
      new Date(Date.UTC(2026, 9, 11, 9, 36, 7, 123)),
      new Date(Date.UTC(2026, 9, 11, 9, 36, 7, 124)),
      new Date(Date.UTC(2026, 9, 11, 10, 0, 0, 0)),
      new Date(Date.UTC(2026, 9, 12, 0, 0, 0, 0)),
      new Date(Date.UTC(2026, 10, 1, 0, 0, 0, 0)),
      new Date(Date.UTC(2027, 0, 1, 0, 0, 0, 0)),
      utc(999, 12, 31, 23, 59, 59, 999),
      utc(1000),
      utc(0),
      utc(9999, 12, 31, 23, 59, 59, 999),
    ];
    const byTime = [...dates].sort((a, b) => a.getTime() - b.getTime()).map(instantOf);
    const byText = dates.map(instantOf).sort();

    expect(byText).toEqual(byTime);
  });
});

describe("parseInstant", () => {
  it.each([
    "2026-10-11T09:36:07.123Z",
    "2026-10-12T00:00:00.000Z",
    "2026-12-31T23:59:59.999Z",
    "2024-02-29T12:00:00.000Z",
    "0000-01-01T00:00:00.000Z",
    "9999-12-31T23:59:59.999Z",
  ])("accepts %s as it is", (text) => {
    expect(parseInstant(text)).toBe(text);
  });

  it.each(NOT_INSTANTS)("refuses %s", (_what, text) => {
    expect(parseInstant(text)).toBeUndefined();
  });

  it.each(notTexts("2026-10-11T09:36:07.123Z"))("refuses %s, which is no text", (_what, value) => {
    expect(parseInstant(value as string)).toBeUndefined();
  });

  it("asks whether a value is a text before it reads it", () => {
    const print = vi.fn(() => "2026-10-11T09:36:07.123Z");

    expect(parseInstant({ toString: print } as unknown as string)).toBeUndefined();
    expect(print).not.toHaveBeenCalled();
  });

  it("accepts everything that instantOf() writes", () => {
    for (let time = Date.UTC(2023, 11, 30); time < Date.UTC(2028, 2, 2); time += 86_400_000 * 0.37 + 1) {
      const instant = instantOf(new Date(time));
      expect(parseInstant(instant)).toBe(instant);
    }
  });

  it("gives a value that is an instant to the compiler", () => {
    const parsed: Instant | undefined = parseInstant("2026-10-11T09:36:07.123Z");
    // @ts-expect-error a text that nothing has checked is not an instant
    const unchecked: Instant = "2026-10-11T09:36:07.123Z";
    // @ts-expect-error an instant is not a day
    const day: Day | undefined = parsed;

    expect([parsed, unchecked, day]).toEqual(Array.from({ length: 3 }, () => "2026-10-11T09:36:07.123Z"));
  });
});

describe("parseDay", () => {
  it.each([
    "2026-10-11",
    "2026-01-01",
    "2026-12-31",
    "2024-02-29",
    "2000-02-29",
    "0000-01-01",
    "0000-02-29",
    "9999-12-31",
  ])("accepts %s as it is", (text) => {
    expect(parseDay(text)).toBe(text);
  });

  it.each(NOT_DAYS)("refuses %s", (_what, text) => {
    expect(parseDay(text)).toBeUndefined();
  });

  // A list with one day in it prints as that day: taken for a text, the list itself would come
  // back as the Day.
  it.each(notTexts("2026-10-11"))("refuses %s, which is no text", (_what, value) => {
    expect(parseDay(value as string)).toBeUndefined();
  });

  it("asks whether a value is a text before it reads it", () => {
    const print = vi.fn(() => "2026-10-11");

    expect(parseDay({ toString: print } as unknown as string)).toBeUndefined();
    expect(print).not.toHaveBeenCalled();
  });

  it("accepts every day of four years and refuses the days their months do not have", () => {
    const lengths = (year: number) => [31, year % 4 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const two = (value: number) => String(value).padStart(2, "0");

    for (const year of [2024, 2025, 2026, 2027]) {
      lengths(year).forEach((length, index) => {
        for (let day = 1; day <= 31; day++) {
          const text = `${year}-${two(index + 1)}-${two(day)}`;
          expect(parseDay(text), text).toBe(day <= length ? text : undefined);
        }
      });
    }
  });
});

describe("localDayOf", () => {
  // Half past ten in the evening in UTC: already the next day in Warsaw, still the same in New York.
  const lateEvening = new Date("2026-10-11T22:30:00.000Z");

  it.each([
    ["Europe/Warsaw", "2026-10-12"],
    ["UTC", "2026-10-11"],
    ["America/New_York", "2026-10-11"],
    ["Pacific/Auckland", "2026-10-12"],
  ])("gives the day it is in the time zone of the machine (%s)", (zone, day) => {
    vi.stubEnv("TZ", zone);

    expect(localDayOf(lateEvening)).toBe(day);
  });

  it("follows the zone across midnight in the other direction", () => {
    vi.stubEnv("TZ", "America/New_York");

    // Two in the morning in UTC is the evening before in New York.
    expect(localDayOf(new Date("2026-03-01T02:00:00.000Z"))).toBe("2026-02-28");
  });

  // Around midnight of the 31st of December the zone and UTC are in different years.
  it.each([
    ["Europe/Warsaw, where the new year has begun", "Europe/Warsaw", "2026-12-31T23:30:00.000Z", "2027-01-01"],
    ["America/New_York, where it has not", "America/New_York", "2027-01-01T02:00:00.000Z", "2026-12-31"],
  ])("takes the year, too, from the time zone of the machine (%s)", (_what, zone, moment, expected) => {
    vi.stubEnv("TZ", zone);

    expect(localDayOf(new Date(moment))).toBe(expected);
  });

  it("fills month, day and year to their full width", () => {
    vi.stubEnv("TZ", "UTC");

    expect(localDayOf(new Date(Date.UTC(2026, 0, 5, 12)))).toBe("2026-01-05");
    expect(localDayOf(utc(7, 2, 3, 12))).toBe("0007-02-03");
  });

  it("gives a day that parseDay() accepts", () => {
    vi.stubEnv("TZ", "Europe/Warsaw");

    for (let time = Date.UTC(2023, 11, 30); time < Date.UTC(2028, 2, 2); time += 86_400_000 * 0.37 + 1) {
      const day = localDayOf(new Date(time));
      expect(parseDay(day)).toBe(day);
    }
  });

  it.each([
    ["an invalid Date", new Date(Number.NaN)],
    ["a moment after the year 9999", utc(10_000, 6, 1)],
    ["a moment before the year 0", utc(-1, 6, 1)],
  ])("throws a RangeError for %s", (_what, date) => {
    vi.stubEnv("TZ", "UTC");

    expect(() => localDayOf(date)).toThrow(RangeError);
  });
});

/**
 * Every day from the first to the last as the Date object counts them: a calendar that the
 * day arithmetic does not use.
 */
function calendar(first: string, last: string): Day[] {
  const days: Day[] = [];
  const end = Date.parse(`${last}T00:00:00.000Z`);
  for (let time = Date.parse(`${first}T00:00:00.000Z`); time <= end; time += 86_400_000) {
    days.push(asDay(new Date(time).toISOString().slice(0, 10)));
  }
  return days;
}

// Texts that the type calls a day because a caller cast them.
const NOT_DAYS_BY_A_CAST = [
  "2026-02-30",
  "2026-13-01",
  "2026-10-11T08:00:00.000Z",
  "-2026-10-11",
  "11.10.2026",
  "",
] as Day[];

describe("addDays", () => {
  it.each([
    ["the next day", "2026-10-11", 1, "2026-10-12"],
    ["the day before", "2026-10-11", -1, "2026-10-10"],
    ["the day itself for no days", "2026-10-11", 0, "2026-10-11"],
    ["the day two weeks on", "2026-11-17", 14, "2026-12-01"],
    ["the first of the next month after a month of 30 days", "2026-11-30", 1, "2026-12-01"],
    ["the first of the next month after a month of 31 days", "2026-10-31", 1, "2026-11-01"],
    ["the last of the month before", "2026-11-01", -1, "2026-10-31"],
    ["the first day of the next year", "2026-12-31", 1, "2027-01-01"],
    ["the last day of the year before", "2027-01-01", -1, "2026-12-31"],
    ["the same day a year of 365 days on", "2026-01-01", 365, "2027-01-01"],
    ["the same day a year of 366 days on", "2024-01-01", 366, "2025-01-01"],
    ["the 29th of February in a leap year", "2024-02-28", 1, "2024-02-29"],
    ["the first of March after the 29th of February", "2024-02-29", 1, "2024-03-01"],
    ["the 29th of February from the first of March", "2024-03-01", -1, "2024-02-29"],
    ["the first of March in a year without the 29th of February", "2026-02-28", 1, "2026-03-01"],
    ["the first of March in 1900, which was no leap year", "1900-02-28", 1, "1900-03-01"],
    ["the 29th of February in 2000, which was one", "2000-02-28", 1, "2000-02-29"],
    ["the same day four hundred years on", "2000-03-01", 146_097, "2400-03-01"],
    ["the last day there is from the first", "0000-01-01", 3_652_424, "9999-12-31"],
  ])("gives %s (%s and %i)", (_what, from, count, expected) => {
    expect(addDays(asDay(from), count)).toBe(expected);
  });

  it.each([
    ["the day after the last one of the year 9999", "9999-12-31", 1],
    ["the day before the first one of the year 0", "0000-01-01", -1],
    ["half a day", "2026-10-11", 0.5],
    ["a count that is no number", "2026-10-11", Number.NaN],
    ["days without end", "2026-10-11", Number.POSITIVE_INFINITY],
  ])("throws a RangeError for %s", (_what, from, count) => {
    expect(() => addDays(asDay(from), count)).toThrow(RangeError);
  });
});

describe("diffDays", () => {
  it.each([
    ["nothing between a day and itself", "2026-10-11", "2026-10-11", 0],
    ["one to the next day", "2026-10-11", "2026-10-12", 1],
    ["minus one to the day before", "2026-10-12", "2026-10-11", -1],
    ["a week", "2026-10-09", "2026-10-16", 7],
    ["two weeks back", "2026-12-01", "2026-11-17", -14],
    ["across the turn of a month", "2026-09-29", "2026-10-08", 9],
    ["across the turn of the year", "2026-12-27", "2027-01-27", 31],
    ["a February of 28 days", "2027-02-28", "2027-03-28", 28],
    ["a February of 29 days", "2024-02-01", "2024-03-01", 29],
    ["a year of 365 days", "2026-01-01", "2027-01-01", 365],
    ["a year of 366 days", "2024-01-01", "2025-01-01", 366],
    ["back to the year 99", "1970-01-01", "0099-01-01", -683_368],
    ["all the days there are", "0000-01-01", "9999-12-31", 3_652_424],
  ])("counts %s (%s to %s: %i)", (_what, from, to, expected) => {
    expect(diffDays(asDay(from), asDay(to))).toBe(expected);
    expect(diffDays(asDay(to), asDay(from))).toBe(0 - expected);
    // What addDays() takes to get from the one to the other.
    expect(addDays(asDay(from), expected)).toBe(to);
  });
});

describe("weekdayOf", () => {
  it.each([
    ["2026-10-05", 1, "a Monday"],
    ["2026-10-06", 2, "a Tuesday"],
    ["2026-10-07", 3, "a Wednesday"],
    ["2026-10-08", 4, "a Thursday"],
    ["2026-10-09", 5, "a Friday"],
    ["2026-10-10", 6, "a Saturday"],
    ["2026-10-11", 7, "a Sunday"],
    ["2026-10-12", 1, "the Monday after it"],
    ["1970-01-01", 4, "a Thursday"],
    ["2000-01-01", 6, "a Saturday"],
    ["2024-02-29", 4, "a Thursday"],
    ["2026-12-31", 4, "a Thursday"],
    ["2027-01-01", 5, "the Friday after it, in the next year"],
    ["0000-01-01", 6, "a Saturday, by the calendar of today counted back"],
    ["9999-12-31", 5, "a Friday"],
  ])("gives %s the number %i: %s", (text, weekday, _what) => {
    expect(weekdayOf(asDay(text))).toBe(weekday);
  });
});

describe("the day arithmetic", () => {
  // Two hundred years with every kind of year in them (1900 and 2100 are no leap years, 2000
  // is one), and both ends of what a day can be.
  it.each([
    ["0000-01-01", "0001-03-01"],
    ["1899-12-25", "2101-01-07"],
    ["9998-11-01", "9999-12-31"],
  ])("counts as the calendar of the Date object does, day by day from %s to %s", (first, last) => {
    const days = calendar(first, last);
    const origin = asDay(first);

    const differences = days.flatMap((day, index) => {
      const weekday = ((new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7) + 1;
      const next = days[index + 1];
      const wrong = [
        addDays(origin, index) !== day,
        diffDays(origin, day) !== index,
        addDays(day, 0 - index) !== origin,
        weekdayOf(day) !== weekday,
        next !== undefined && (addDays(day, 1) !== next || addDays(next, -1) !== day || diffDays(next, day) !== -1),
      ];
      return wrong.includes(true) ? [`${day}: ${wrong.join(", ")}`] : [];
    });

    expect(differences).toEqual([]);
    expect(days.length).toBeGreaterThan(400);
  });

  it.each([
    ["addDays", (text: Day) => addDays(text, 1)],
    ["diffDays, as the first day", (text: Day) => diffDays(text, asDay("2026-10-11"))],
    ["diffDays, as the second day", (text: Day) => diffDays(asDay("2026-10-11"), text)],
    ["weekdayOf", (text: Day) => weekdayOf(text)],
    ["periodStart", (text: Day) => periodStart(text, "month")],
    ["periodEnd", (text: Day) => periodEnd(text, "month")],
  ])("throws a RangeError when %s is given a text that is no day", (_what, run) => {
    for (const text of NOT_DAYS_BY_A_CAST) expect(() => run(text), JSON.stringify(text)).toThrow(RangeError);
  });

  it("takes a checked day and a named period, to the compiler as well", () => {
    const today = asDay("2026-10-11");
    // @ts-expect-error a text that nothing has checked is not a day
    const unchecked = () => addDays("2026-10-11", 1);
    // @ts-expect-error "approximate" says how well a day is known and names no period
    const noPeriod = () => periodEnd(today, "approximate");
    const weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7 = weekdayOf(today);
    const next: Day = addDays(today, 1);

    expect(unchecked()).toBe("2026-10-12");
    expect(noPeriod).toThrow(RangeError);
    expect([weekday, next]).toEqual([7, "2026-10-12"]);
  });
});

describe("periodStart and periodEnd", () => {
  // A week is the working week: Monday to Friday. A Saturday and a Sunday belong to the week
  // that has just ended, so its end is before them.
  it.each([
    ["a Monday", "2026-10-19", "2026-10-19", "2026-10-23"],
    ["a Wednesday", "2026-10-21", "2026-10-19", "2026-10-23"],
    ["a Friday", "2026-10-23", "2026-10-19", "2026-10-23"],
    ["a Saturday", "2026-10-24", "2026-10-19", "2026-10-23"],
    ["a Sunday", "2026-10-25", "2026-10-19", "2026-10-23"],
    ["the Monday after it", "2026-10-26", "2026-10-26", "2026-10-30"],
    ["a day in a week across the turn of a month", "2026-12-02", "2026-11-30", "2026-12-04"],
    ["the last day of a year in the middle of a week", "2026-12-31", "2026-12-28", "2027-01-01"],
    ["the first day of a year that is a Friday", "2027-01-01", "2026-12-28", "2027-01-01"],
    ["the Sunday after it", "2027-01-03", "2026-12-28", "2027-01-01"],
    ["the 29th of February", "2024-02-29", "2024-02-26", "2024-03-01"],
  ])("give the Monday and the Friday of the week of %s (%s)", (_what, text, monday, friday) => {
    expect(periodStart(asDay(text), "week")).toBe(monday);
    expect(periodEnd(asDay(text), "week")).toBe(friday);
  });

  it.each([
    ["month", "a day inside a month", "2026-11-10", "2026-11-01", "2026-11-30"],
    ["month", "the first day of a month", "2026-11-01", "2026-11-01", "2026-11-30"],
    ["month", "the last day of a month", "2026-11-30", "2026-11-01", "2026-11-30"],
    ["month", "the day before a month", "2026-10-31", "2026-10-01", "2026-10-31"],
    ["month", "the day after a month", "2026-12-01", "2026-12-01", "2026-12-31"],
    ["month", "a February of 28 days", "2026-02-14", "2026-02-01", "2026-02-28"],
    ["month", "a February of 29 days", "2024-02-14", "2024-02-01", "2024-02-29"],
    ["month", "the 29th of February", "2024-02-29", "2024-02-01", "2024-02-29"],
    ["month", "February of 1900, which was no leap year", "1900-02-10", "1900-02-01", "1900-02-28"],
    ["month", "February of 2000, which was one", "2000-02-10", "2000-02-01", "2000-02-29"],
    ["quarter", "the first day of the first quarter", "2026-01-01", "2026-01-01", "2026-03-31"],
    ["quarter", "a day inside the first quarter", "2027-02-01", "2027-01-01", "2027-03-31"],
    ["quarter", "the last day of the first quarter", "2026-03-31", "2026-01-01", "2026-03-31"],
    ["quarter", "the first day of the second quarter", "2026-04-01", "2026-04-01", "2026-06-30"],
    ["quarter", "the last day of the second quarter", "2026-06-30", "2026-04-01", "2026-06-30"],
    ["quarter", "the first day of the third quarter", "2026-07-01", "2026-07-01", "2026-09-30"],
    ["quarter", "the last day of the third quarter", "2026-09-30", "2026-07-01", "2026-09-30"],
    ["quarter", "the first day of the fourth quarter", "2026-10-01", "2026-10-01", "2026-12-31"],
    ["quarter", "a day inside the fourth quarter", "2026-10-12", "2026-10-01", "2026-12-31"],
    ["quarter", "the last day of the fourth quarter", "2026-12-31", "2026-10-01", "2026-12-31"],
    ["quarter", "the 29th of February", "2024-02-29", "2024-01-01", "2024-03-31"],
    ["half", "the first day of the first half", "2026-01-01", "2026-01-01", "2026-06-30"],
    ["half", "a day inside the first half", "2027-03-01", "2027-01-01", "2027-06-30"],
    ["half", "the last day of the first half", "2026-06-30", "2026-01-01", "2026-06-30"],
    ["half", "the first day of the second half", "2026-07-01", "2026-07-01", "2026-12-31"],
    ["half", "the last day of the second half", "2026-12-31", "2026-07-01", "2026-12-31"],
    ["year", "the first day of a year", "2026-01-01", "2026-01-01", "2026-12-31"],
    ["year", "a day inside a year", "2027-05-05", "2027-01-01", "2027-12-31"],
    ["year", "the last day of a year", "2026-12-31", "2026-01-01", "2026-12-31"],
    ["year", "the first day of the next year", "2027-01-01", "2027-01-01", "2027-12-31"],
    ["year", "the 29th of February", "2024-02-29", "2024-01-01", "2024-12-31"],
    ["year", "a day of the first year there is", "0000-06-15", "0000-01-01", "0000-12-31"],
    // No day comes after the last one, so the end of these periods cannot be counted back from the day after it.
    ["month", "the last month there is", "9999-12-15", "9999-12-01", "9999-12-31"],
    ["quarter", "the last quarter there is", "9999-11-15", "9999-10-01", "9999-12-31"],
    ["half", "the last half there is", "9999-08-15", "9999-07-01", "9999-12-31"],
    ["year", "the last year there is", "9999-12-31", "9999-01-01", "9999-12-31"],
  ] as [NamedPeriod, string, string, string, string][])(
    "give the first and the last day of the %s: %s (%s)",
    (period, _what, text, first, last) => {
      expect(periodStart(asDay(text), period)).toBe(first);
      expect(periodEnd(asDay(text), period)).toBe(last);
    },
  );

  it("give every month of a year its length", () => {
    const lengths = (year: number) => [31, year % 4 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const two = (value: number) => String(value).padStart(2, "0");

    for (const year of [2024, 2026]) {
      lengths(year).forEach((length, index) => {
        const middle = asDay(`${year}-${two(index + 1)}-15`);
        expect(periodStart(middle, "month")).toBe(`${year}-${two(index + 1)}-01`);
        expect(periodEnd(middle, "month")).toBe(`${year}-${two(index + 1)}-${two(length)}`);
      });
    }
  });

  // What makes the two days the boundaries of one period, whichever day of it they are asked for.
  it.each(NAMED_PERIODS)("give boundaries that hold together for every day of four years: %s", (period) => {
    const broken = calendar("2023-12-25", "2028-03-05").filter((day) => {
      const [start, end] = [periodStart(day, period), periodEnd(day, period)];
      const holds = [
        parseDay(start) === start && parseDay(end) === end,
        // Asked of its own boundaries, the period is the same one.
        periodStart(start, period) === start && periodEnd(start, period) === end,
        periodStart(end, period) === start && periodEnd(end, period) === end,
        start <= day && start <= end,
        ...(period === "week"
          ? [
              weekdayOf(start) === 1 && weekdayOf(end) === 5 && diffDays(start, end) === 4,
              // The weekend comes after the Friday; the next week begins on the Monday after it.
              diffDays(start, day) === weekdayOf(day) - 1,
              periodStart(addDays(end, 3), period) === addDays(end, 3),
            ]
          : [
              day <= end,
              // Periods of one kind follow each other without a gap.
              periodStart(addDays(end, 1), period) === addDays(end, 1),
              periodEnd(addDays(start, -1), period) === addDays(start, -1),
            ]),
      ];
      return holds.includes(false);
    });

    expect(broken).toEqual([]);
  });

  it("put every smaller period of the calendar inside the larger one", () => {
    const inside = (day: Day, inner: NamedPeriod, outer: NamedPeriod) =>
      periodStart(day, outer) <= periodStart(day, inner) && periodEnd(day, inner) <= periodEnd(day, outer);

    const broken = calendar("2023-12-25", "2028-03-05").filter(
      (day) => !(inside(day, "month", "quarter") && inside(day, "quarter", "half") && inside(day, "half", "year")),
    );

    expect(broken).toEqual([]);
  });

  it("throw a RangeError that names the word for a word that names no period", () => {
    const today = asDay("2026-10-11");
    // Words as they could arrive from outside, where the compiler has not seen them.
    const words: string[] = ["approximate", "day", "toString", ""];

    for (const word of words as NamedPeriod[]) {
      const refusal = expect.objectContaining({ name: "RangeError", message: `Not a named period: ${word}` });
      expect(() => periodStart(today, word), word).toThrow(refusal);
      expect(() => periodEnd(today, word), word).toThrow(refusal);
    }
  });

  it.each(["0000-01-01", "0000-01-02"])(
    "throw a RangeError for the week of %s, whose Monday is before the year 0",
    (text) => {
      // The first day of the year 0 is a Saturday.
      expect(() => periodStart(asDay(text), "week")).toThrow(RangeError);
      expect(() => periodEnd(asDay(text), "week")).toThrow(RangeError);
    },
  );
});
