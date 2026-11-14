// The real NEAR/USD price: the median of four public exchange feeds, with the nearusd guest's rules
// (oracle/nearusd-guest): median (floor mean of the two middle values when even), spread =
// ceil((max - min) x 10,000 / median), the value farthest from the median dropped once when the
// spread is too wide and more than `minSources` answered, refused below `minSources` or above
// `maxSpreadBps`, observed at the oldest source time. Decimal strings are parsed with integer
// arithmetic, never through a JS number.

import { parseUnits, WAD } from "./units.ts";

export type PriceSourceName = "coinbase" | "kraken" | "gemini" | "coingecko";

export interface SourceQuote {
  source: PriceSourceName;
  priceWad: bigint;
  observedAtSec: number;
  /** The decimal string as the source gave it. */
  raw: string;
}

export interface SpotReading {
  priceWad: bigint;
  observedAtSec: number;
  sources: SourceQuote[];
  used: number;
  spreadBps: number;
  dropped?: PriceSourceName;
  /** Sources that did not answer, with why. */
  failed: { source: PriceSourceName; error: string }[];
}

const HEADERS = { "User-Agent": "curl/8.7.1", Accept: "application/json" };

/** A decimal price string ("3.3371", 3.34) to WAD, truncating past 18 digits. */
export function decimalToWad(value: unknown): bigint {
  const text = String(value).trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new Error(`not a decimal price: ${JSON.stringify(value)}`);
  return parseUnits(`${m[1]}${m[2] ? `.${m[2].slice(0, 18)}` : ""}`, 18);
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

type Fetcher = (timeoutMs: number) => Promise<SourceQuote>;

const nowSec = (): number => Math.floor(Date.now() / 1000);

export const FETCHERS: Record<PriceSourceName, Fetcher> = {
  coinbase: async (t) => {
    const j = (await getJson("https://api.exchange.coinbase.com/products/NEAR-USD/ticker", t)) as { price: string; time: string };
    return { source: "coinbase", priceWad: decimalToWad(j.price), observedAtSec: Math.floor(Date.parse(j.time) / 1000), raw: j.price };
  },
  kraken: async (t) => {
    const j = (await getJson("https://api.kraken.com/0/public/Ticker?pair=NEARUSD", t)) as { error: string[]; result: Record<string, { c: [string, string] }> };
    if (j.error.length > 0) throw new Error(j.error.join("; "));
    const pair = Object.values(j.result)[0];
    if (!pair) throw new Error("no pair in the answer");
    return { source: "kraken", priceWad: decimalToWad(pair.c[0]), observedAtSec: nowSec(), raw: pair.c[0] };
  },
  gemini: async (t) => {
    const j = (await getJson("https://api.gemini.com/v1/pubticker/nearusd", t)) as { last: string; volume: { timestamp: number } };
    return { source: "gemini", priceWad: decimalToWad(j.last), observedAtSec: Math.floor(j.volume.timestamp / 1000), raw: j.last };
  },
  coingecko: async (t) => {
    const j = (await getJson("https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd&include_last_updated_at=true", t)) as {
      near: { usd: number; last_updated_at: number };
    };
    return { source: "coingecko", priceWad: decimalToWad(j.near.usd), observedAtSec: j.near.last_updated_at, raw: String(j.near.usd) };
  },
};

const medianOf = (sorted: bigint[]): bigint => {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? (sorted[mid] ?? 0n) : ((sorted[mid - 1] ?? 0n) + (sorted[mid] ?? 0n)) / 2n;
};

const spreadOf = (sorted: bigint[], median: bigint): number => {
  const max = sorted[sorted.length - 1] ?? 0n;
  const min = sorted[0] ?? 0n;
  return Number(((max - min) * 10_000n + median - 1n) / median);
};

/** The guest's aggregation, pure. Throws when too few sources answered or they disagree. */
export function aggregate(quotes: SourceQuote[], minSources = 3, maxSpreadBps = 200): Omit<SpotReading, "failed"> {
  let used = [...quotes].sort((a, b) => (a.priceWad < b.priceWad ? -1 : a.priceWad > b.priceWad ? 1 : 0));
  if (used.length < minSources) throw new Error(`only ${used.length} of ${minSources} price sources answered`);
  let median = medianOf(used.map((q) => q.priceWad));
  let spread = spreadOf(used.map((q) => q.priceWad), median);
  let dropped: PriceSourceName | undefined;
  if (spread > maxSpreadBps && used.length > minSources) {
    const dist = (q: SourceQuote): bigint => (q.priceWad > median ? q.priceWad - median : median - q.priceWad);
    const far = used.reduce((a, b) => (dist(b) > dist(a) ? b : a));
    dropped = far.source;
    used = used.filter((q) => q !== far);
    median = medianOf(used.map((q) => q.priceWad));
    spread = spreadOf(used.map((q) => q.priceWad), median);
  }
  if (spread > maxSpreadBps) throw new Error(`price sources disagree: spread ${spread} bps > ${maxSpreadBps}`);
  return {
    priceWad: median,
    observedAtSec: Math.min(...used.map((q) => q.observedAtSec)),
    sources: used,
    used: used.length,
    spreadBps: spread,
    ...(dropped ? { dropped } : {}),
  };
}

/** Reads all four sources (5 s each, in parallel) and aggregates them. */
export async function fetchNearUsd(o: { minSources?: number; maxSpreadBps?: number; timeoutMs?: number } = {}): Promise<SpotReading> {
  const names = Object.keys(FETCHERS) as PriceSourceName[];
  const results = await Promise.allSettled(names.map((n) => FETCHERS[n](o.timeoutMs ?? 5_000)));
  const quotes: SourceQuote[] = [];
  const failed: { source: PriceSourceName; error: string }[] = [];
  results.forEach((r, i) => {
    const source = names[i] as PriceSourceName;
    if (r.status === "fulfilled") quotes.push(r.value);
    else failed.push({ source, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });
  return { ...aggregate(quotes, o.minSources ?? 3, o.maxSpreadBps ?? 200), failed };
}

/** WAD to a short decimal string. */
export const wadText = (wad: bigint, digits = 6): string => {
  const whole = wad / WAD;
  const frac = (wad % WAD).toString().padStart(18, "0").slice(0, digits);
  return `${whole}.${frac}`;
};
