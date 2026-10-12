// Instants and calendar days as the database stores them: text, in one spelling each. The
// database refuses every other spelling, so text order is time order, and a value of these two
// types is one that it accepts. No trigger reads the clock: every instant comes from the caller,
// which is what lets a test with a fixed clock be exact.
import type { NamedPeriod } from "./vocabulary.ts";

declare const instantBrand: unique symbol;
declare const dayBrand: unique symbol;

/** A moment in UTC, exactly as Date.prototype.toISOString() writes it: "2026-10-11T09:36:07.123Z". */
export type Instant = string & { readonly [instantBrand]: true };
/** A calendar day without a time zone: "2026-10-11". */
export type Day = string & { readonly [dayBrand]: true };

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The instant of a Date. Throws a RangeError for an invalid Date, and for one before the year 0
 * or after the year 9999: toISOString() writes those years with a sign and six digits, which is
 * another spelling.
 */
export function instantOf(date: Date): Instant {
  // toISOString() throws the RangeError for an invalid Date itself.
  const text = date.toISOString();
  if (!INSTANT.test(text)) throw new RangeError(`Not an instant with a four-digit year: ${text}`);
  return text as Instant;
}

/**
 * The text as an instant, when it is spelled the one way toISOString() spells it and names a
 * moment that exists. Everything else is undefined: another precision, an offset in place of
 * "Z", hour 24, a thirtieth of February, and a value that is no text.
 */
export function parseInstant(text: string): Instant | undefined {
  // What arrives from outside has not been seen by the compiler. A pattern reads whatever it is
  // given as the text it prints as, a list with one instant in it as that instant.
  if (typeof text !== "string") return undefined;
  if (!INSTANT.test(text)) return undefined;
  const time = Date.parse(text);
  // Date.parse() takes hour 24 and, in some engines, a day that the month does not have, and
  // moves them to the instant they stand for. Written back, that instant is spelled differently.
  if (Number.isNaN(time) || new Date(time).toISOString() !== text) return undefined;
  return text as Instant;
}

/**
 * The text as a day, when it is spelled YYYY-MM-DD and that day is in the calendar. Everything
 * else is undefined, and so is a value that is no text: a list with one day in it prints as
 * that day, and would come back as the list.
 */
export function parseDay(text: string): Day | undefined {
  if (typeof text !== "string") return undefined;
  const match = DAY.exec(text);
  if (match === null) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // setUTCFullYear() and not Date.UTC(): the latter reads the years 0 to 99 as 1900 to 1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  // A day that the month does not have rolls over into the next month.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return text as Day;
}

/**
 * The calendar day of a Date in the time zone of this machine: the day the owner would say it
 * is. Throws a RangeError for an invalid Date and for a year that does not have four digits.
 */
export function localDayOf(date: Date): Day {
  const year = date.getFullYear();
  if (!(year >= 0 && year <= 9999)) throw new RangeError(`Not a day with a four-digit year: ${String(date)}`);
  return spell(year, date.getMonth() + 1, date.getDate());
}

/** A date of the calendar in the spelling of a day. */
function spell(year: number, month: number, dayOfMonth: number): Day {
  const pad = (value: number, length: number) => String(value).padStart(length, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(dayOfMonth, 2)}` as Day;
}

// Day arithmetic. A day is counted as a whole number, 0 for 1970-01-01, and never becomes a
// Date on the way: a Date is a moment, and which day a moment falls on depends on the time zone
// of the machine. The calendar is the one of today in every year, also in the years before it
// was introduced: SQLite's date() and the Date object count the same way.

const DAYS_IN_400_YEARS = 146_097;
/** From the first of March of the year 0 to 1970-01-01. */
const DAYS_BEFORE_1970 = 719_468;

/**
 * The number of a date of the calendar. The count runs in years that begin on the first of
 * March, so that the day a leap year adds is the last one of its year and no month has to ask
 * whether that day is behind it. From March on the months have 31, 30, 31, 30 and 31 days and
 * then the same again: 153 days in every five.
 */
function numberOfDate(year: number, month: number, dayOfMonth: number): number {
  const marchYear = month > 2 ? year : year - 1;
  // Four hundred years are one turn of the leap year rule. Math.floor() and not a remainder: the
  // first two months of the year 0 belong to the year before it.
  const era = Math.floor(marchYear / 400);
  const yearOfEra = marchYear - era * 400;
  const dayOfYear = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + dayOfMonth - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * DAYS_IN_400_YEARS + dayOfEra - DAYS_BEFORE_1970;
}

/** The date of the calendar that has the number. */
function dateOfNumber(number: number): [year: number, month: number, dayOfMonth: number] {
  const sinceMarchOfYear0 = number + DAYS_BEFORE_1970;
  const era = Math.floor(sinceMarchOfYear0 / DAYS_IN_400_YEARS);
  const dayOfEra = sinceMarchOfYear0 - era * DAYS_IN_400_YEARS;
  // Less the leap days that lie before the day: one in four years, none in a hundred, one in four hundred.
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthFromMarch = Math.floor((5 * dayOfYear + 2) / 153);
  const dayOfMonth = dayOfYear - Math.floor((153 * monthFromMarch + 2) / 5) + 1;
  const month = monthFromMarch < 10 ? monthFromMarch + 3 : monthFromMarch - 9;
  return [yearOfEra + era * 400 + (month > 2 ? 0 : 1), month, dayOfMonth];
}

/**
 * The year, the month and the number of a day. Throws a RangeError for a text that is not a
 * day of the calendar: the type promises one, and a cast can break the promise.
 */
function readDay(day: Day): { year: number; month: number; number: number } {
  const match = DAY.exec(day);
  if (match !== null) {
    const [year, month, dayOfMonth] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const number = numberOfDate(year, month, dayOfMonth);
    // A day that the month does not have, and a month that the year does not have, count on
    // into the next one: the number then belongs to a date that is spelled differently.
    const [sameYear, sameMonth, sameDay] = dateOfNumber(number);
    if (sameYear === year && sameMonth === month && sameDay === dayOfMonth) return { year, month, number };
  }
  throw new RangeError(`Not a day: ${day}`);
}

/** The day that has the number. Throws a RangeError for a day outside the years 0000 to 9999. */
function dayOfNumber(number: number): Day {
  const [year, month, dayOfMonth] = dateOfNumber(number);
  if (!(year >= 0 && year <= 9999)) throw new RangeError(`Not a day with a four-digit year: the year ${year}`);
  return spell(year, month, dayOfMonth);
}

/**
 * The day that many days after the given one, or before it for a negative count. Throws a
 * RangeError for a count that is not a whole number, and for a day that would lie outside the
 * years 0000 to 9999, which is no day to the database.
 */
export function addDays(day: Day, count: number): Day {
  if (!Number.isInteger(count)) throw new RangeError(`Not a whole number of days: ${count}`);
  return dayOfNumber(readDay(day).number + count);
}

/** How many days the second day is after the first; negative when it is before it. */
export function diffDays(from: Day, to: Day): number {
  return readDay(to).number - readDay(from).number;
}

/** The day of the week: 1 is Monday, 7 is Sunday. */
export function weekdayOf(day: Day): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  // 1970-01-01 was a Thursday. The remainder of a negative number is negative, hence the second step.
  const fromMonday = (((readDay(day).number + 3) % 7) + 7) % 7;
  return (fromMonday + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

/** How many months the periods of the calendar have. A week is counted in days. */
const MONTHS_IN = { month: 1, quarter: 3, half: 6, year: 12 } as const;

/** Of the period of the calendar that holds the day: its year, its first month and how many months it has. */
function calendarPeriod(
  day: Day,
  period: keyof typeof MONTHS_IN,
): { year: number; firstMonth: number; months: number } {
  // Object.hasOwn() and not a look-up: "toString" would find a function there.
  if (!Object.hasOwn(MONTHS_IN, period)) throw new RangeError(`Not a named period: ${String(period)}`);
  const { year, month } = readDay(day);
  const months = MONTHS_IN[period];
  return { year, firstMonth: month - ((month - 1) % months), months };
}

/**
 * The first day of the named period that holds the day. Quarters, halves and years are those
 * of the calendar year. A week is the working week and starts on its Monday: for a Saturday and
 * a Sunday it is the week that has just ended.
 */
export function periodStart(day: Day, period: NamedPeriod): Day {
  if (period === "week") return addDays(day, 1 - weekdayOf(day));
  const { year, firstMonth } = calendarPeriod(day, period);
  return spell(year, firstMonth, 1);
}

/**
 * The last day of the named period that holds the day: the last day of the month, the quarter,
 * the half or the year, and the Friday of the week. For a Saturday and a Sunday that Friday is
 * before the day.
 */
export function periodEnd(day: Day, period: NamedPeriod): Day {
  if (period === "week") return addDays(day, 5 - weekdayOf(day));
  const { year, firstMonth, months } = calendarPeriod(day, period);
  // The day before the first day of the period that follows. That day is counted as a number
  // and not spelled: after the last period of the year 9999 it is no day.
  const next = firstMonth + months;
  return dayOfNumber((next > 12 ? numberOfDate(year + 1, 1, 1) : numberOfDate(year, next, 1)) - 1);
}
