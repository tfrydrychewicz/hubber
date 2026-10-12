// Random numbers that are the same on every run, with a stream of their own for every entity.
//
// One sequential generator would make every number depend on every draw before it: the day the
// generator learns to write one more thing, all the data it wrote before would shift, and every
// test that knows a generated value would break. Here each entity draws from a stream that is
// derived from the seed and from what the entity is ("capture", day, index), so new draws for a
// new kind of entity leave the old ones where they were.

/** Four 32-bit words from a text (cyrb128). Not cryptographic: it only has to spread the keys. */
function hash128(text: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export interface Rng {
  /** A whole number from 0 to 2^32 - 1. */
  u32(): number;
  /** A number from 0 up to, and not including, 1. */
  next(): number;
  /** A whole number from min to max, both included. */
  int(min: number, max: number): number;
  /** True with the given probability. */
  chance(probability: number): boolean;
  /** One of the list; every member is as likely as every other. */
  pick<T>(list: readonly T[]): T;
  /** An index of the list of weights, drawn by weight. */
  weighted(weights: readonly number[]): number;
  /** A positive number with the given median and a long tail: durations, sizes, delays. */
  logNormal(median: number, sigma: number): number;
}

/** The generator sfc32, seeded with four words. */
function sfc32(a: number, b: number, c: number, d: number): Rng {
  const u32 = (): number => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  // The first numbers of sfc32 still show the seed.
  for (let i = 0; i < 12; i++) u32();
  const next = (): number => u32() / 4294967296;
  return {
    u32,
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (probability) => next() < probability,
    pick: (list) => list[Math.floor(next() * list.length)] as (typeof list)[number],
    weighted: (weights) => {
      let total = 0;
      for (const weight of weights) total += weight;
      let at = next() * total;
      for (let i = 0; i < weights.length; i++) {
        at -= weights[i] as number;
        if (at < 0) return i;
      }
      return weights.length - 1;
    },
    logNormal: (median, sigma) => {
      // Box and Muller; one number of the pair is enough.
      const u = Math.max(next(), 1e-12);
      const v = next();
      return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
    },
  };
}

export interface Streams {
  /** The stream of one entity. The same label and key always give the same numbers. */
  stream(label: string, ...key: readonly number[]): Rng;
}

export function createStreams(seed: number): Streams {
  return {
    stream: (label, ...key) => {
      const [a, b, c, d] = hash128(`${seed}\u0000${label}\u0000${key.join(",")}`);
      return sfc32(a, b, c, d);
    },
  };
}
