// The NEAR/USD median of four public exchanges, computed exactly as the OutLayer guest does
// (oracle/nearusd-guest/src/lib.rs): integer 18-decimal parsing, never a float; the median of the
// answers (the floor of the mean of the two middle values when their number is even);
// spread = ceil((max - min) x 10,000 / median); one drop of the value farthest from the median (the
// higher one on a tie) when the spread is above the limit and a source can be spared; observed_at =
// the oldest time among the sources used. Both implementations are checked on the guest's shared
// tests/vectors.json (nearusd.test.ts), so the reporter path and the TEE path store the same number.

export type SourceName = "coinbase" | "kraken" | "gemini" | "coingecko";

/** In the order the guest asks them. */
export const SOURCES: readonly SourceName[] = ["coinbase", "kraken", "gemini", "coingecko"];

export const SOURCE_URLS: Record<SourceName, string> = {
  coinbase: "https://api.exchange.coinbase.com/products/NEAR-USD/ticker",
  kraken: "https://api.kraken.com/0/public/Ticker?pair=NEARUSD",
  gemini: "https://api.gemini.com/v1/pubticker/nearusd",
  coingecko: "https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd&include_last_updated_at=true",
};

export const WAD = 10n ** 18n;
const DECIMALS = 18;
const MAX_U128 = (1n << 128n) - 1n;
/** The guest keeps its whole output under 1 KiB. */
export const MAX_EVIDENCE = 480;
const SPREAD_OVERFLOW = 4_294_967_295;

export interface Quote {
  source: SourceName;
  /** The price as the source printed it. */
  raw: string;
  priceWad: bigint;
  /** Unix seconds. */
  observedAt: number;
}

export interface Reading {
  priceWad: bigint;
  observedAt: number;
  sourcesUsed: number;
  spreadBps: number;
  dropped: SourceName | null;
}

export interface Refusal {
  note: string;
  sourcesUsed: number;
  spreadBps: number;
}

export type Aggregate = { ok: true; reading: Reading } | { ok: false; refusal: Refusal };

/** "3.5047" as 3504700000000000000; digits past the 18th are dropped. Throws on anything else. */
export function parseDecimalWad(s: string): bigint {
  const bad = (): Error => new Error(`not a decimal: ${s}`);
  const dot = s.indexOf(".");
  const whole = dot < 0 ? s : s.slice(0, dot);
  const frac = dot < 0 ? "" : s.slice(dot + 1);
  if (whole === "" || !/^\d+$/.test(whole) || !/^\d*$/.test(frac)) throw bad();
  const kept = frac.slice(0, DECIMALS).padEnd(DECIMALS, "0");
  const value = BigInt(whole) * WAD + BigInt(kept);
  if (BigInt(whole) > MAX_U128 || value > MAX_U128) throw bad();
  return value;
}

/** 3502350000000000000 as "3.50235" (no trailing zeros). */
export function formatWad(value: bigint): string {
  const whole = value / WAD;
  const frac = value % WAD;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(DECIMALS, "0").replace(/0+$/, "")}`;
}

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

/** Days from 1970-01-01 (Howard Hinnant's algorithm); null before 1970. */
function daysFromCivil(year: number, month: number, day: number): number | null {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = month > 2 ? month - 3 : month + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days = era * 146_097 + doe - 719_468;
  return days < 0 ? null : days;
}

/** `YYYY-MM-DDTHH:MM:SS[.fraction](Z|+00:00)` as Unix seconds (the fraction dropped); UTC only. */
export function parseUtcTime(s: string): number | null {
  if (s.length < 20) return null;
  const num = (from: number, to: number): number | null => {
    const part = s.slice(from, to);
    return /^\d+$/.test(part) ? Number(part) : null;
  };
  if (s[4] !== "-" || s[7] !== "-" || s[10] !== "T" || s[13] !== ":" || s[16] !== ":") return null;
  const [year, month, day, hour, minute, second] = [num(0, 4), num(5, 7), num(8, 10), num(11, 13), num(14, 16), num(17, 19)];
  if (year === null || month === null || day === null || hour === null || minute === null || second === null) return null;
  let rest = s.slice(19);
  if (rest.startsWith(".")) {
    const digits = /^\.(\d+)/.exec(rest);
    if (!digits) return null;
    rest = rest.slice(digits[0].length);
  }
  if (rest !== "Z" && rest !== "+00:00") return null;
  if (month < 1 || month > 12 || day === 0 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;
  const days = daysFromCivil(year, month, day);
  return days === null ? null : days * 86_400 + hour * 3_600 + minute * 60 + second;
}

/** JSON.parse that keeps every number literal's source text (Node 22+), so no price passes a float. */
function parseKeepingNumbers(body: string): unknown {
  return JSON.parse(body, function (this: unknown, _key: string, value: unknown, context?: { source?: string }) {
    return typeof value === "number" ? { __number: context?.source ?? String(value) } : value;
  });
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const numberText = (x: unknown): string | null => (isObj(x) && typeof x.__number === "string" ? x.__number : null);
/** A JSON u64 field (serde's u64): an integer literal without sign, fraction or exponent. */
function u64Field(x: unknown, what: string): number {
  const text = numberText(x);
  if (text === null || !/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error(`bad response: ${what} is not an unsigned integer`);
  return Number(text);
}
function strField(x: unknown, what: string): string {
  if (typeof x !== "string") throw new Error(`bad response: ${what} is not a string`);
  return x;
}

/** Restores the numbers that `parseKeepingNumbers` wrapped (for error texts). */
const plain = (x: unknown): unknown => {
  const n = numberText(x);
  if (n !== null) return Number(n);
  if (Array.isArray(x)) return x.map(plain);
  if (isObj(x)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, plain(v)]));
  return x;
};

/** One source's response body as a quote. Kraken prints no time: its quote is observed `now`. */
export function parseQuote(source: SourceName, body: string, now: number): Quote {
  let json: unknown;
  try {
    json = parseKeepingNumbers(body);
  } catch (err) {
    throw new Error(`bad response: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObj(json)) throw new Error("bad response: not an object");
  let raw: string;
  let observedAt: number;
  switch (source) {
    case "coinbase": {
      raw = strField(json.price, "price");
      const time = strField(json.time, "time");
      const at = parseUtcTime(time);
      if (at === null) throw new Error(`bad time: ${time}`);
      observedAt = at;
      break;
    }
    case "kraken": {
      if (!Array.isArray(json.error)) throw new Error("bad response: error is not a list");
      if (json.error.length > 0) throw new Error(`error: ${JSON.stringify(plain(json.error))}`);
      const result = json.result === undefined ? {} : json.result;
      if (!isObj(result)) throw new Error("bad response: result is not an object");
      const keys = Object.keys(result);
      const pair = "NEARUSD" in result ? result.NEARUSD : keys.length === 1 ? result[keys[0] ?? ""] : undefined;
      if (pair === undefined) throw new Error("no NEARUSD pair");
      const last = isObj(pair) && Array.isArray(pair.c) ? pair.c[0] : undefined;
      if (typeof last !== "string") throw new Error("no last trade");
      raw = last;
      observedAt = now;
      break;
    }
    case "gemini": {
      raw = strField(json.last, "last");
      if (!isObj(json.volume)) throw new Error("bad response: no volume");
      observedAt = Math.floor(u64Field(json.volume.timestamp, "volume.timestamp") / 1_000);
      break;
    }
    case "coingecko": {
      if (!isObj(json.near)) throw new Error("bad response: no near");
      const usd = numberText(json.near.usd);
      if (usd === null) throw new Error("bad response: near.usd is not a number");
      raw = usd;
      observedAt = u64Field(json.near.last_updated_at, "near.last_updated_at");
      break;
    }
  }
  const priceWad = parseDecimalWad(raw);
  if (priceWad === 0n) throw new Error(`zero price: ${raw}`);
  return { source, raw, priceWad, observedAt };
}

function median(sorted: readonly bigint[]): bigint {
  const n = sorted.length;
  if (n % 2 === 1) return sorted[(n - 1) / 2] ?? 0n;
  const a = sorted[n / 2 - 1] ?? 0n;
  const b = sorted[n / 2] ?? 0n;
  return a / 2n + b / 2n + ((a % 2n) + (b % 2n)) / 2n;
}

function spreadBps(sorted: readonly bigint[], mid: bigint): number {
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  if (min === undefined || max === undefined) return 0;
  if (mid === 0n) return SPREAD_OVERFLOW;
  const scaled = (max - min) * 10_000n;
  const bps = (scaled + mid - 1n) / mid;
  return bps > BigInt(SPREAD_OVERFLOW) ? SPREAD_OVERFLOW : Number(bps);
}

const absDiff = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a);

/** The guest's median rule over the sources that answered. */
export function aggregate(quotes: readonly Quote[], minSources: number, maxSpreadBps: number): Aggregate {
  const n = quotes.length;
  if (n < minSources || n === 0) return { ok: false, refusal: { note: `too few sources (${n} < ${minSources})`, sourcesUsed: n, spreadBps: 0 } };
  // stable sort by price, as Rust's sort_by_key
  const used = [...quotes].sort((a, b) => (a.priceWad < b.priceWad ? -1 : a.priceWad > b.priceWad ? 1 : 0));
  let sorted = used.map((q) => q.priceWad);
  let mid = median(sorted);
  let spread = spreadBps(sorted, mid);
  let dropped: SourceName | null = null;
  if (spread > maxSpreadBps && n > minSources) {
    let far = 0;
    sorted.forEach((p, i) => {
      if (absDiff(p, mid) >= absDiff(sorted[far] ?? 0n, mid)) far = i;
    });
    dropped = used.splice(far, 1)[0]?.source ?? null;
    sorted = used.map((q) => q.priceWad);
    mid = median(sorted);
    spread = spreadBps(sorted, mid);
  }
  if (spread > maxSpreadBps) return { ok: false, refusal: { note: `spread ${spread} bps above ${maxSpreadBps}`, sourcesUsed: used.length, spreadBps: spread } };
  return {
    ok: true,
    reading: { priceWad: mid, observedAt: Math.min(...used.map((q) => q.observedAt)), sourcesUsed: used.length, spreadBps: spread, dropped },
  };
}

/** At most `max` bytes (UTF-8), cut on a character boundary, as the guest clips. */
export function clip(s: string, max: number): string {
  const bytes = Buffer.from(s, "utf8");
  if (bytes.length <= max) return s;
  let end = max;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/** A source's response body, or why there is none ("HTTP 503", "timeout"). */
export type Fetched = { body: string } | { error: string };

export interface SpotOutput {
  /** null = no price (the reason is in `evidence`). */
  priceWad: bigint | null;
  observedAt: number;
  sourcesUsed: number;
  spreadBps: number;
  evidence: string;
  quotes: Quote[];
}

/** The guest's `run` over bodies already fetched: the same output, the same evidence text. */
export function spotFrom(fetched: Record<SourceName, Fetched>, now: number, minSources: number, maxSpreadBps: number): SpotOutput {
  const quotes: Quote[] = [];
  const parts: string[] = [];
  for (const source of SOURCES) {
    const f = fetched[source];
    try {
      if ("error" in f) throw new Error(f.error);
      const q = parseQuote(source, f.body, now);
      parts.push(`${source}=${q.raw}`);
      quotes.push(q);
    } catch (err) {
      parts.push(`${source}: ${clip(err instanceof Error ? err.message : String(err), 80)}`);
    }
  }
  const sources = parts.join(" ");
  const agg = aggregate(quotes, minSources, maxSpreadBps);
  if (!agg.ok) {
    return {
      priceWad: null,
      observedAt: now,
      sourcesUsed: agg.refusal.sourcesUsed,
      spreadBps: agg.refusal.spreadBps,
      evidence: clip(`${sources}: ${agg.refusal.note}`, MAX_EVIDENCE),
      quotes,
    };
  }
  const r = agg.reading;
  const evidence = `${sources} median=${formatWad(r.priceWad)}${r.dropped ? ` dropped=${r.dropped}` : ""}`;
  return { priceWad: r.priceWad, observedAt: r.observedAt, sourcesUsed: r.sourcesUsed, spreadBps: r.spreadBps, evidence: clip(evidence, MAX_EVIDENCE), quotes };
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Asks the four sources in parallel, each with its own timeout (the guest allows 5 s per stage). */
export async function fetchSources(fetchFn: FetchLike = fetch, timeoutMs = 5_000): Promise<Record<SourceName, Fetched>> {
  const one = async (source: SourceName): Promise<Fetched> => {
    try {
      const res = await fetchFn(SOURCE_URLS[source], { headers: { "User-Agent": "curl/8.7.1", Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      return { body: await res.text() };
    } catch (err) {
      const e = err as { name?: string; message?: string };
      return { error: e.name === "TimeoutError" || e.name === "AbortError" ? "timeout" : (e.message ?? String(err)) };
    }
  };
  const answers = await Promise.all(SOURCES.map(one));
  return Object.fromEntries(SOURCES.map((s, i) => [s, answers[i] as Fetched])) as Record<SourceName, Fetched>;
}
