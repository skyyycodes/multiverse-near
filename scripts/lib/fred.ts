// FOMC outcomes from FRED's federal funds target range: the public fredgraph.csv download (no API
// key), integer basis points, and both limits must agree.

export const CUTS = 0;
export const HOLDS = 1;
export const NO_RESULT = -1;
export type FomcOutcome = typeof CUTS | typeof HOLDS | typeof NO_RESULT;

export const FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv";
export const SOURCE_LABEL = "FRED DFEDTARU + DFEDTARL";

export type FredSeries = "DFEDTARU" | "DFEDTARL";
export type FetchText = (url: string) => Promise<string>;

export interface FredOptions {
  baseUrl?: string;
  fetchText?: FetchText;
}

/** "4.00" -> 400n. Truncates past two decimals; no floating point anywhere. */
export function toBps(value: string): bigint {
  const [whole = "", frac = "", ...rest] = value.trim().split(".");
  if (rest.length > 0 || !/^\d+$/.test(whole) || !/^\d*$/.test(frac)) {
    throw new Error(`not a rate: ${value}`);
  }
  return BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2));
}

/**
 * The value for `date` from a fredgraph.csv body, or null when FRED has no observation for that day
 * yet. For such a day FRED answers with the whole series instead of an empty file, so the row is
 * matched by its date rather than taken from a fixed line; FRED also writes a missing value as "."
 * or leaves it empty.
 */
export function bpsFromCsv(csv: string, date: string): bigint | null {
  const row = csv.split("\n").find((line) => line.startsWith(`${date},`));
  const value = row?.split(",")[1]?.trim() ?? "";
  if (value === "" || value === ".") return null;
  return toBps(value);
}

export function fredCsvUrl(series: FredSeries, date: string, baseUrl = FRED_CSV_URL): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`not a YYYY-MM-DD date: ${date}`);
  return `${baseUrl}?id=${series}&cosd=${date}&coed=${date}`;
}

// FRED's bot filter stalls some clients until they time out, depending on the user agent; a curl
// user agent got through from Node, curl and Rust alike when we probed it.
const USER_AGENT = "curl/8.7.1";

export const fetchText: FetchText = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GET ${url} answered HTTP ${res.status}`);
  return res.text();
};

export async function fredBps(series: FredSeries, date: string, options: FredOptions = {}): Promise<bigint | null> {
  const get = options.fetchText ?? fetchText;
  return bpsFromCsv(await get(fredCsvUrl(series, date, options.baseUrl)), date);
}

/**
 * CUTS if both limits are lower after the meeting than before it, HOLDS if neither is (a hike is
 * HOLDS), NO_RESULT if the two limits disagree or FRED has no row yet for any of the four reads
 * (the day's rows appear around 13:00 UTC; a missing row must never read as HOLDS). `before` is the
 * meeting's first day and `after` the day after the statement. Fetch errors and unparseable values
 * still throw: the caller writes nothing that run.
 */
export async function fomcOutcome(before: string, after: string, options: FredOptions = {}): Promise<FomcOutcome> {
  // Sequential, in the original order, stopping at the first missing row.
  const reads: [FredSeries, string][] = [
    ["DFEDTARU", after],
    ["DFEDTARU", before],
    ["DFEDTARL", after],
    ["DFEDTARL", before],
  ];
  const bps: bigint[] = [];
  for (const [series, date] of reads) {
    const value = await fredBps(series, date, options);
    if (value === null) return NO_RESULT;
    bps.push(value);
  }
  const [upperAfter, upperBefore, lowerAfter, lowerBefore] = bps as [bigint, bigint, bigint, bigint];
  const upperCut = upperAfter < upperBefore;
  const lowerCut = lowerAfter < lowerBefore;
  if (upperCut !== lowerCut) return NO_RESULT;
  return upperCut ? CUTS : HOLDS;
}
