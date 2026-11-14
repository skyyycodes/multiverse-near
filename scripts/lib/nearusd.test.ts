// The median rule against the guest's shared vectors (oracle/nearusd-guest/tests/vectors.json):
// both implementations must agree on every decimal, time, source body, aggregate and whole run.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { REPO_ROOT } from "./near.ts";
import { aggregate, fetchSources, formatWad, parseDecimalWad, parseQuote, parseUtcTime, SOURCES, spotFrom, type Fetched, type Quote, type SourceName } from "./nearusd.ts";

interface Vectors {
  decimals: { raw: string; wad: string | null }[];
  times: { raw: string; sec: number | null }[];
  sources: { name: string; source: SourceName; now: number; body: string; quote: { raw: string; price_wad: string; observed_at: number } | null }[];
  aggregate: {
    name: string;
    min_sources: number;
    max_spread_bps: number;
    quotes: { source: SourceName; raw: string; price_wad: string; observed_at: number }[];
    result: { price_wad: string; observed_at: number; sources_used: number; spread_bps: number; dropped: SourceName | null } | { error: string; sources_used: number; spread_bps: number };
  }[];
  runs: {
    name: string;
    input: string;
    now: number;
    /** null = the fetch failed; the guest's test harness answers "HTTP 503" for it. */
    bodies: Partial<Record<SourceName, string | null>>;
    output: { price_wad: string | null; observed_at: number; sources_used: number; spread_bps: number; evidence: string };
  }[];
}

const V = JSON.parse(readFileSync(join(REPO_ROOT, "oracle", "nearusd-guest", "tests", "vectors.json"), "utf8")) as Vectors;

test("decimals parse as the guest parses them", () => {
  assert.ok(V.decimals.length >= 10);
  for (const c of V.decimals) {
    let got: string | null;
    try {
      got = parseDecimalWad(c.raw).toString();
    } catch {
      got = null;
    }
    assert.equal(got, c.wad, JSON.stringify(c.raw));
  }
  assert.equal(formatWad(3_502_350_000_000_000_000n), "3.50235");
  assert.equal(formatWad(4n * 10n ** 18n), "4");
});

test("times parse as the guest parses them", () => {
  for (const c of V.times) assert.equal(parseUtcTime(c.raw), c.sec, c.raw);
});

test("every source body gives the guest's quote, or none", () => {
  for (const c of V.sources) {
    let got: Quote | null;
    try {
      got = parseQuote(c.source, c.body, c.now);
    } catch {
      got = null;
    }
    if (c.quote === null) {
      assert.equal(got, null, c.name);
      continue;
    }
    assert.ok(got, c.name);
    assert.equal(got.raw, c.quote.raw, c.name);
    assert.equal(got.priceWad.toString(), c.quote.price_wad, c.name);
    assert.equal(got.observedAt, c.quote.observed_at, c.name);
  }
});

test("the median, spread and outlier rules match every aggregate vector", () => {
  assert.ok(V.aggregate.length >= 10);
  for (const c of V.aggregate) {
    const quotes: Quote[] = c.quotes.map((q) => ({ source: q.source, raw: q.raw, priceWad: BigInt(q.price_wad), observedAt: q.observed_at }));
    const got = aggregate(quotes, c.min_sources, c.max_spread_bps);
    if ("error" in c.result) {
      assert.equal(got.ok, false, c.name);
      if (!got.ok) assert.deepEqual(got.refusal, { note: c.result.error, sourcesUsed: c.result.sources_used, spreadBps: c.result.spread_bps }, c.name);
      continue;
    }
    assert.equal(got.ok, true, c.name);
    if (got.ok) {
      assert.deepEqual(
        { ...got.reading, priceWad: got.reading.priceWad.toString() },
        { priceWad: c.result.price_wad, observedAt: c.result.observed_at, sourcesUsed: c.result.sources_used, spreadBps: c.result.spread_bps, dropped: c.result.dropped },
        c.name,
      );
    }
  }
});

test("whole runs print the guest's output and evidence", () => {
  for (const r of V.runs) {
    const input = JSON.parse(r.input) as { min_sources: number; max_spread_bps: number };
    const fetched = Object.fromEntries(
      SOURCES.map((s): [SourceName, Fetched] => {
        const body = r.bodies[s];
        return [s, typeof body === "string" ? { body } : { error: "HTTP 503" }];
      }),
    ) as Record<SourceName, Fetched>;
    const out = spotFrom(fetched, r.now, input.min_sources, input.max_spread_bps);
    assert.deepEqual(
      { price_wad: out.priceWad === null ? null : out.priceWad.toString(), observed_at: out.observedAt, sources_used: out.sourcesUsed, spread_bps: out.spreadBps, evidence: out.evidence },
      r.output,
      r.name,
    );
  }
});

test("fetchSources reports HTTP errors and timeouts per source", async () => {
  const fake = async (url: string): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
    if (url.includes("coinbase")) return { ok: false, status: 503, text: async () => "" };
    if (url.includes("kraken")) throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const got = await fetchSources(fake, 10);
  assert.deepEqual(got.coinbase, { error: "HTTP 503" });
  assert.deepEqual(got.kraken, { error: "timeout" });
  assert.deepEqual(got.gemini, { body: "{}" });
});
