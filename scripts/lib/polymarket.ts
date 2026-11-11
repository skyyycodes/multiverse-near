// P(CUTS) for the December FOMC from Polymarket's public gamma API, used only to price the demo's
// odds pools. A hike counts as HOLDS, so the cut outcomes' share of all Yes prices is P(CUTS).
// Decimal strings are parsed into integers; no floating point.

import { ODDS_CUTS_FALLBACK_BPS } from "./demo.ts";

export const POLYMARKET_FED_SLUG = "fed-decision-in-december-20260729232808632";
export const GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";
export const FALLBACK_READ_ON = "2026-11-06";

interface GammaMarket {
  question?: unknown;
  outcomes?: unknown;
  outcomePrices?: unknown;
}

interface GammaEvent {
  closed?: unknown;
  markets?: unknown;
}

// Prices come with up to a handful of decimals; 18 digits is far more than any of them carry.
const PRICE_DIGITS = 18;

function parsePrice(value: unknown): bigint {
  const text = String(value).trim();
  const match = /^(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) throw new Error(`not a price: ${JSON.stringify(value)}`);
  const frac = (match[2] ?? "").slice(0, PRICE_DIGITS).padEnd(PRICE_DIGITS, "0");
  return BigInt(match[1] ?? "0") * 10n ** BigInt(PRICE_DIGITS) + BigInt(frac);
}

function jsonList(value: unknown, what: string): unknown[] {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error(`${what} is not a list`);
  return parsed;
}

/**
 * Basis points of CUTS from a gamma `events?slug=` answer: exactly one open event; for every market
 * the Yes price adds to the total, and to the cut share when the question mentions a decrease.
 * Rounded half up and clamped to 1..9999.
 */
export function cutsBpsFromGamma(body: unknown): number {
  if (!Array.isArray(body) || body.length !== 1) {
    throw new Error(`expected one Polymarket event, got ${Array.isArray(body) ? body.length : "no list"}`);
  }
  const event = body[0] as GammaEvent;
  if (event.closed === true) throw new Error("the Polymarket event is closed");
  const markets = jsonList(event.markets, "markets") as GammaMarket[];
  let total = 0n;
  let cut = 0n;
  let cutMarkets = 0;
  for (const market of markets) {
    const outcomes = jsonList(market.outcomes, "outcomes");
    const prices = jsonList(market.outcomePrices, "outcomePrices");
    const yesAt = outcomes.indexOf("Yes");
    if (yesAt < 0) throw new Error(`a market without a Yes outcome: ${String(market.question)}`);
    const yes = parsePrice(prices[yesAt]);
    total += yes;
    if (String(market.question ?? "").toLowerCase().includes("decrease")) {
      cut += yes;
      cutMarkets++;
    }
  }
  if (total <= 0n || cutMarkets === 0) throw new Error("no cut market or no prices");
  const bps = (2n * cut * 10_000n + total) / (2n * total);
  return Number(bps < 1n ? 1n : bps > 9_999n ? 9_999n : bps);
}

export interface FedOdds {
  cutsBps: number;
  source: string;
  live: boolean;
}

export type FetchJson = (url: string) => Promise<unknown>;

const fetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GET ${url} answered HTTP ${res.status}`);
  return res.json();
};

/**
 * `ODDS_CUTS_BPS` wins when set; otherwise Polymarket, and if that fails the reading of
 * 2026-11-06 (100 bps), said so in the source string.
 */
export async function fedCutsOdds(
  env: Record<string, string | undefined> = process.env,
  get: FetchJson = fetchJson,
  now: () => Date = () => new Date(),
): Promise<FedOdds> {
  const slug = env.POLYMARKET_FED_SLUG || POLYMARKET_FED_SLUG;
  if (env.ODDS_CUTS_BPS) {
    return { cutsBps: Number(env.ODDS_CUTS_BPS), source: env.ODDS_SOURCE || "ODDS_CUTS_BPS from the environment", live: false };
  }
  try {
    const cutsBps = cutsBpsFromGamma(await get(`${GAMMA_EVENTS_URL}?slug=${encodeURIComponent(slug)}`));
    return { cutsBps, source: `Fed: Polymarket ${slug} at ${now().toISOString().replace(/\.\d{3}Z$/, "Z")}`, live: true };
  } catch (err) {
    console.warn(`Polymarket odds unavailable (${err instanceof Error ? err.message : String(err)}); using ${ODDS_CUTS_FALLBACK_BPS} bps`);
    return {
      cutsBps: ODDS_CUTS_FALLBACK_BPS,
      source: `Fed: Polymarket ${slug} as read on ${FALLBACK_READ_ON} (offline fallback)`,
      live: false,
    };
  }
}
