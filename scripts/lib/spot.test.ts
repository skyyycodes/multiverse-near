import assert from "node:assert/strict";
import { test } from "node:test";

import { aggregate, decimalToWad, type SourceQuote } from "./spot.ts";

const q = (source: SourceQuote["source"], price: string, at = 100): SourceQuote => ({ source, priceWad: decimalToWad(price), observedAtSec: at, raw: price });

test("the median of four is the floor mean of the middle two, spread rounded up", () => {
  const r = aggregate([q("coinbase", "3.5118", 103), q("kraken", "3.5111", 104), q("gemini", "3.4810", 101), q("coingecko", "3.51", 99)]);
  assert.equal(r.priceWad, decimalToWad("3.51055"));
  assert.equal(r.spreadBps, 88);
  assert.equal(r.used, 4);
  assert.equal(r.observedAtSec, 99);
  assert.equal(r.dropped, undefined);
});

test("a wide spread drops the farthest value once", () => {
  const r = aggregate([q("coinbase", "3.50"), q("kraken", "3.51"), q("gemini", "3.52"), q("coingecko", "3.90")]);
  assert.equal(r.dropped, "coingecko");
  assert.equal(r.priceWad, decimalToWad("3.51"));
  assert.equal(r.used, 3);
});

test("too few sources or a spread still too wide is refused", () => {
  assert.throws(() => aggregate([q("coinbase", "3.50"), q("kraken", "3.51")]), /only 2 of 3/);
  assert.throws(() => aggregate([q("coinbase", "3.00"), q("kraken", "3.50"), q("gemini", "4.00")]), /disagree/);
});

test("decimal prices parse without floating point", () => {
  assert.equal(decimalToWad("3.34"), 3_340_000_000_000_000_000n);
  assert.equal(decimalToWad(3.34), 3_340_000_000_000_000_000n);
  assert.throws(() => decimalToWad("-1"));
});
