// A seeded pseudo-random generator for reproducible runs (soak picks, test data): xoshiro128**
// (Blackman and Vigna), 32-bit state words, seeded through splitmix32 so any seed gives a non-zero
// state. Never used for keys or anything secret, and never for money arithmetic: amounts it helps
// pick are turned into bigint base units by the caller.

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

/** splitmix32: expands one 32-bit seed into well-mixed words. */
function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** A string seed folded to 32 bits (FNV-1a), so "soak-2026-11-20" works as a seed. */
export function seedOf(seed: number | string): number {
  if (typeof seed === "number") {
    if (!Number.isSafeInteger(seed)) throw new Error(`seed must be a safe integer, not ${seed}`);
    return ((seed >>> 0) ^ (Math.floor(seed / 2 ** 32) >>> 0)) >>> 0;
  }
  let h = 0x811c9dc5;
  for (const ch of Buffer.from(seed, "utf8")) h = Math.imul(h ^ ch, 0x01000193) >>> 0;
  return h >>> 0;
}

export class Prng {
  private s: [number, number, number, number];

  /** From a seed (splitmix32-expanded), or from four explicit state words (reference vectors). */
  constructor(seed: number | string | readonly [number, number, number, number]) {
    if (Array.isArray(seed)) {
      const [a, b, c, d] = seed as readonly [number, number, number, number];
      this.s = [a >>> 0, b >>> 0, c >>> 0, d >>> 0];
    } else {
      const next = splitmix32(seedOf(seed as number | string));
      this.s = [next(), next(), next(), next()];
    }
    if (this.s.every((w) => w === 0)) throw new Error("xoshiro128** state must not be all zero");
  }

  /** The next 32-bit output. */
  nextU32(): number {
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] = (s[2] ^ s[0]) >>> 0;
    s[3] = (s[3] ^ s[1]) >>> 0;
    s[1] = (s[1] ^ s[2]) >>> 0;
    s[0] = (s[0] ^ s[3]) >>> 0;
    s[2] = (s[2] ^ t) >>> 0;
    s[3] = rotl(s[3], 11);
    return result;
  }

  /** A float in [0, 1) with 32 bits of randomness. */
  next(): number {
    return this.nextU32() / 2 ** 32;
  }

  /** An integer in [0, n), without modulo bias. */
  int(n: number): number {
    if (!Number.isInteger(n) || n <= 0 || n > 2 ** 32) throw new Error(`int(n) needs 1 ≤ n ≤ 2^32, not ${n}`);
    const limit = 2 ** 32 - (2 ** 32 % n);
    for (;;) {
      const x = this.nextU32();
      if (x < limit) return x % n;
    }
  }

  /** A bigint in [0, n) (amounts in base units), without modulo bias. */
  bigint(n: bigint): bigint {
    if (n <= 0n) throw new Error(`bigint(n) needs n > 0, not ${n}`);
    const bits = n.toString(2).length;
    const words = Math.ceil(bits / 32);
    const mask = (1n << BigInt(bits)) - 1n;
    for (;;) {
      let x = 0n;
      for (let i = 0; i < words; i++) x = (x << 32n) | BigInt(this.nextU32());
      x &= mask;
      if (x < n) return x;
    }
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from an empty list");
    return items[this.int(items.length)] as T;
  }

  /** An index chosen with probability weight_i / Σ weights (integer weights, so the draw is exact). */
  weighted(weights: readonly number[]): number {
    const total = weights.reduce((a, w) => {
      if (!Number.isInteger(w) || w < 0) throw new Error(`weights must be non-negative integers, not ${w}`);
      return a + w;
    }, 0);
    if (total <= 0) throw new Error("weights sum to zero");
    let r = this.int(total);
    for (const [i, w] of weights.entries()) {
      if (r < w) return i;
      r -= w;
    }
    return weights.length - 1;
  }

  /** The current state, to resume a run exactly where it stopped. */
  state(): [number, number, number, number] {
    return [...this.s];
  }
}
