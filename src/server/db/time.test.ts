// The day arithmetic of src/shared/time.ts against the date functions of SQLite. The code counts
// days as numbers and the database compares the same days as text and counts them with date():
// a read that does the one and a view that does the other must come to the same day. The test is
// here and not beside the module because src/shared does not import the database library.
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { addDays, type Day, diffDays, periodEnd, periodStart, weekdayOf } from "../../shared/time.ts";

const connection = new Database(":memory:");

afterAll(() => {
  connection.close();
});

// The days of a span, each with what SQLite makes of it. SQLite counts the last day of a month
// back from the first day of the next one, and has no day after 9999-12-31 to count back from:
// a period that ends with a December ends on the 31st, written out.
const WALK = connection.prepare(`
  WITH RECURSIVE
    span (day) AS (SELECT :first UNION ALL SELECT date(day, :step) FROM span WHERE date(day, :step) <= :last),
    parts AS (
      SELECT day,
             strftime('%Y', day) AS year,
             CAST(strftime('%m', day) AS INTEGER) AS month,
             CAST(strftime('%u', day) AS INTEGER) AS weekday
        FROM span
    ),
    firsts AS (
      SELECT *, year || '-' || printf('%02d', (month - 1) / 3 * 3 + 1) || '-01' AS first_of_quarter FROM parts
    )
  SELECT day,
         weekday,
         CAST(julianday(day) - julianday('1970-01-01') AS INTEGER) AS number,
         date(day, '+1 day') AS next,
         date(day, '-1 day') AS previous,
         date(day, '+45 days') AS plus45,
         date(day, '-400 days') AS minus400,
         date(day, '-' || (weekday - 1) || ' days') AS week_first,
         date(day, '-' || (weekday - 1) || ' days', '+4 days') AS week_last,
         date(day, 'start of month') AS month_first,
         CASE WHEN month = 12 THEN year || '-12-31' ELSE date(day, 'start of month', '+1 month', '-1 day') END
           AS month_last,
         date(first_of_quarter) AS quarter_first,
         CASE WHEN month >= 10 THEN year || '-12-31' ELSE date(first_of_quarter, '+3 months', '-1 day') END
           AS quarter_last,
         date(year || CASE WHEN month <= 6 THEN '-01-01' ELSE '-07-01' END) AS half_first,
         date(year || CASE WHEN month <= 6 THEN '-06-30' ELSE '-12-31' END) AS half_last,
         date(day, 'start of year') AS year_first,
         date(year || '-12-31') AS year_last
    FROM firsts
`);

interface Row {
  day: Day;
  number: number;
  [column: string]: string | number | null;
}

const EPOCH = "1970-01-01" as Day;
const OUTSIDE = "outside the years 0000 to 9999";

// What the code counts for each column of the walk.
const COUNTED: [column: string, count: (day: Day, row: Row) => Day | number][] = [
  ["weekday", (day) => weekdayOf(day)],
  ["number", (day) => diffDays(EPOCH, day)],
  ["day", (_day, row) => addDays(EPOCH, row.number)],
  ["next", (day) => addDays(day, 1)],
  ["previous", (day) => addDays(day, -1)],
  ["plus45", (day) => addDays(day, 45)],
  ["minus400", (day) => addDays(day, -400)],
  ["week_first", (day) => periodStart(day, "week")],
  ["week_last", (day) => periodEnd(day, "week")],
  ["month_first", (day) => periodStart(day, "month")],
  ["month_last", (day) => periodEnd(day, "month")],
  ["quarter_first", (day) => periodStart(day, "quarter")],
  ["quarter_last", (day) => periodEnd(day, "quarter")],
  ["half_first", (day) => periodStart(day, "half")],
  ["half_last", (day) => periodEnd(day, "half")],
  ["year_first", (day) => periodStart(day, "year")],
  ["year_last", (day) => periodEnd(day, "year")],
];

/** What the code gives: its answer, or that the day lies outside the years a day can have. */
function ours(count: () => Day | number): string | number {
  try {
    return count();
  } catch (error) {
    if (error instanceof RangeError) return OUTSIDE;
    throw error;
  }
}

/** What SQLite gives. After the year 9999 it has no answer; before the year 0 it writes the year with a minus sign. */
const theirs = (value: string | number | null | undefined) =>
  value === null || (typeof value === "string" && value.startsWith("-")) ? OUTSIDE : value;

// The first walk makes more than a million comparisons: about a second by itself, and several
// times that when the machine is busy with the rest of the suite. So the walks get more time than
// a test has otherwise.
describe("the day arithmetic and the date functions of SQLite", { timeout: 60_000 }, () => {
  it.each([
    // Two hundred years, with 1900 and 2100, which are no leap years, and 2000, which is one.
    ["every day of the years 1900 to 2100", "1900-01-01", "+1 day", "2100-12-31", 73_414],
    ["every day of the year 0, where days before it lie outside", "0000-01-01", "+1 day", "0000-12-31", 366],
    ["every day of the year 9999, where days after it do", "9999-01-01", "+1 day", "9999-12-31", 365],
    // 211 days are thirty weeks and a day, so the walk falls on every weekday and in every part of a year.
    ["every 211th day of all the years there are", "0000-01-01", "+211 days", "9999-12-17", 17_311],
  ])("agree on %s", (_what, first, step, last, days) => {
    const rows = WALK.all({ first, step, last }) as Row[];

    const differences: string[] = [];
    for (const row of rows) {
      for (const [column, count] of COUNTED) {
        const [inCode, inSqlite] = [ours(() => count(row.day, row)), theirs(row[column])];
        if (inCode !== inSqlite) differences.push(`${column} of ${row.day}: ${inCode} in code, ${inSqlite} in SQLite`);
      }
    }

    expect(differences.slice(0, 20)).toEqual([]);
    expect(rows).toHaveLength(days);
    expect([rows[0]?.day, rows.at(-1)?.day]).toEqual([first, last]);
  });

  // Where a day would leave the years 0000 to 9999 the code refuses. SQLite gives nothing after
  // the year 9999 and a year with a minus sign before the year 0, and the walks above take both
  // for the same refusal: this is what they rest on.
  it("leave the years a day can have at the same days", () => {
    const edge = (day: string) => WALK.get({ first: day, step: "+1 day", last: day }) as Row;

    expect(edge("9999-12-31")).toMatchObject({ next: null, plus45: null, month_last: "9999-12-31" });
    expect(() => addDays("9999-12-31" as Day, 1)).toThrow(RangeError);
    expect(edge("0000-01-01")).toMatchObject({ previous: "-0001-12-31", week_first: "-0001-12-27", weekday: 6 });
    expect(() => addDays("0000-01-01" as Day, -1)).toThrow(RangeError);
    expect(() => periodStart("0000-01-01" as Day, "week")).toThrow(RangeError);
  });
});
