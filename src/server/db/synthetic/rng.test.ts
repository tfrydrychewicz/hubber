import { describe, expect, it } from "vitest";
import { createStreams, type Rng } from "./rng.ts";

const draw = (rng: Rng, count: number): number[] => Array.from({ length: count }, () => rng.u32());
const mean = (numbers: readonly number[]): number => numbers.reduce((sum, number) => sum + number, 0) / numbers.length;

describe("createStreams", () => {
  it("gives the same numbers for the same seed, label and key, however often it is asked", () => {
    const first = draw(createStreams(1).stream("capture", 12, 3), 50);

    expect(draw(createStreams(1).stream("capture", 12, 3), 50)).toEqual(first);
    // Numbers that come out of a fixed seed are part of what a seed means: a change of the
    // generator that moves them changes every world, and every file written from one.
    expect(first.slice(0, 3)).toEqual([846603378, 2732623817, 3538487520]);
  });

  it("gives other numbers for another seed, another label and another key", () => {
    const first = draw(createStreams(1).stream("capture", 12, 3), 8);

    expect(draw(createStreams(2).stream("capture", 12, 3), 8)).not.toEqual(first);
    expect(draw(createStreams(1).stream("captures", 12, 3), 8)).not.toEqual(first);
    expect(draw(createStreams(1).stream("capture", 12, 4), 8)).not.toEqual(first);
    expect(draw(createStreams(1).stream("capture", 3, 12), 8)).not.toEqual(first);
    // The label and the key are kept apart: neither can spell the other.
    expect(draw(createStreams(1).stream("capture", 1, 23), 8)).not.toEqual(
      draw(createStreams(1).stream("capture", 12, 3), 8),
    );
    expect(draw(createStreams(1).stream("capture1", 2), 8)).not.toEqual(
      draw(createStreams(1).stream("capture", 12), 8),
    );
  });

  it("keeps the streams apart: what one entity draws moves no number of another", () => {
    const streams = createStreams(7);
    const alone = draw(streams.stream("item", 5), 20);
    const other = streams.stream("item", 6);
    const mixed = streams.stream("item", 5);

    const drawn = Array.from({ length: 20 }, () => {
      other.next();
      other.next();
      return mixed.u32();
    });

    expect(drawn).toEqual(alone);
  });
});

describe("a stream of random numbers", () => {
  const rng = () => createStreams(3).stream("test");

  it("draws fractions from 0 up to 1, spread evenly", () => {
    const stream = rng();
    const numbers = Array.from({ length: 20_000 }, () => stream.next());

    expect(Math.min(...numbers)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...numbers)).toBeLessThan(1);
    expect(mean(numbers)).toBeGreaterThan(0.49);
    expect(mean(numbers)).toBeLessThan(0.51);
    const tenths = Array.from({ length: 10 }, (_, tenth) => numbers.filter((n) => Math.floor(n * 10) === tenth).length);
    for (const count of tenths) {
      expect(count).toBeGreaterThan(1_850);
      expect(count).toBeLessThan(2_150);
    }
  });

  it("draws whole numbers from both ends of a range, and none outside it", () => {
    const stream = rng();
    const numbers = Array.from({ length: 2_000 }, () => stream.int(3, 6));

    expect([...new Set(numbers)].sort()).toEqual([3, 4, 5, 6]);
    for (const value of [3, 4, 5, 6]) expect(numbers.filter((n) => n === value).length).toBeGreaterThan(400);
    expect(stream.int(9, 9)).toBe(9);
  });

  it("is true as often as the probability says: never at 0, always at 1", () => {
    const stream = rng();
    const hits = (probability: number) =>
      Array.from({ length: 10_000 }, () => stream.chance(probability)).filter(Boolean).length;

    expect(hits(0)).toBe(0);
    expect(hits(1)).toBe(10_000);
    const fifth = hits(0.2);
    expect(fifth).toBeGreaterThan(1_850);
    expect(fifth).toBeLessThan(2_150);
  });

  it("picks every member of a list about as often as every other", () => {
    const stream = rng();
    const picked = Array.from({ length: 3_000 }, () => stream.pick(["a", "b", "c"] as const));

    for (const member of ["a", "b", "c"]) {
      expect(picked.filter((one) => one === member).length).toBeGreaterThan(900);
    }
  });

  it("draws an index by its weight, and never one whose weight is 0", () => {
    const stream = rng();
    const drawn = Array.from({ length: 10_000 }, () => stream.weighted([15, 70, 0, 15]));
    const share = (index: number) => drawn.filter((one) => one === index).length / drawn.length;

    expect(share(2)).toBe(0);
    expect(share(1)).toBeGreaterThan(0.67);
    expect(share(1)).toBeLessThan(0.73);
    expect(share(0)).toBeGreaterThan(0.13);
    expect(share(3)).toBeGreaterThan(0.13);
  });

  it("draws durations with the given median and a long tail", () => {
    const stream = rng();
    const numbers = Array.from({ length: 10_000 }, () => stream.logNormal(40, 0.8)).sort((a, b) => a - b);

    expect(numbers[0]).toBeGreaterThan(0);
    expect(numbers[5_000]).toBeGreaterThan(37);
    expect(numbers[5_000]).toBeLessThan(43);
    // The tail: one draw in twenty is more than three times the median.
    expect(numbers[9_500]).toBeGreaterThan(120);
    expect(mean(numbers)).toBeGreaterThan(numbers[5_000] as number);
  });
});
