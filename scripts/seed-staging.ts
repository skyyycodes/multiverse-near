// Seeds the staging go-live market list (SPEC.md 7.5, scripts design 13 as changed by SPEC.md 3.8
// and 12) on the fresh v2 contract, around the real NEAR/USD price. Every step reads the journal
// deployments/staging.seed.json first, so a re-run continues where the last one stopped.
//
//   NEAR_NETWORK=staging pnpm -C scripts seed:staging [--phase a|b|c|all] [--only <step>] [--dry-run]
//
// Phase a (at once): the price S (median of Coinbase, Kraken, Gemini and CoinGecko, logged to
//   $PRICE_LOG_DIR/seed-prices-<time>.json), storage deposits, the outside NEAR/USD reference (reporter
//   path), F6 on by default, the go-live MarketParams, the four owner events with their rules and
//   sources, the owner-funded markets `spice-fed` (the anchor), `fed-oct` and `near-nov1`, lenders
//   in all three tiers, Bold insurance, Ravi's orders and Alice's sale in `fed-oct`.
// Phase b (once `spice-fed` has a full TWAP window): the borrowers (Alice Normal, Sam Safe, Carl and
//   Leo Bold; Leo at 0.99 x max_borrow, CMP-01), and the pledge-funded markets `fed-dec` and `spice`
//   (Kind B) and `near-dec31` (Kind A, approved by the owner).
// Phase c (once `near-dec31` has a full window): its odds pool deepened (ECO-02), the pledge-funded
//   combinations `spice-near` (4 worlds) and `three` (8 worlds), the demo record, `resolutionHold`
//   and `goLiveAt` in deployments/staging.json, and the final checks.
//
// `fed-oct` and `near-nov1` are real past events whose outcomes are public (FRED: HOLDS; Coinbase
// close of 2026-11-01: 4.284 > 4.00, YES); they stay unresolved for the video (CMP-05).

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { chainHeight, chainNowSec } from "./lib/chain.ts";
import { orderCost, oddsPairs, seedReserves, singles, sumOver, wmul } from "./lib/demo.ts";
import { DEPLOYMENTS_DIR, requireDeployments, writeDeployments, type Deployments } from "./lib/deployments.ts";
import { actions, DEFAULT_RPC_URL, NETWORK, nearBalance, REPO_ROOT, sendTransaction, spendable } from "./lib/near.ts";
import { fedCutsOdds } from "./lib/polymarket.ts";
import { Protocol } from "./lib/protocol.ts";
import { fetchNearUsd, wadText, type SpotReading } from "./lib/spot.ts";
import { formatNear, parseNear, roundDownToStep, roundUpToStep, u128, WAD } from "./lib/units.ts";
import type { Tier } from "./lib/msgs.ts";
import type { MarketParams, ReferenceConfig } from "./lib/views.ts";

const { values: opts } = parseArgs({
  options: {
    phase: { type: "string", default: "a" },
    only: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

const JOURNAL = join(DEPLOYMENTS_DIR, `${NETWORK}.seed.json`);
const PRICE_LOG_DIR = process.env.PRICE_LOG_DIR || join(REPO_ROOT, "logs", NETWORK);
const e18 = (n: bigint): bigint => n * WAD;
const bps = (n: number): bigint => BigInt(n) * 10n ** 14n;

// Events (owner `create_event` + `set_event_meta`). Every rule ends with its machine tag (scripts 11.6).
const EVENTS = {
  spice: {
    question: "Will SPICE ship on NEAR mainnet by Mar 31, 2027?",
    outcomeNames: ["SHIPS", "DELAYED"],
    rule:
      "SHIPS if SPICE, NEAR's separation of consensus and execution, is active on NEAR mainnet before 2027-04-01 00:00 UTC, " +
      "shown by the nearcore release that enables it and the protocol_version of mainnet RPC `status`; otherwise DELAYED. " +
      "[ifverse:evidence]",
    source: "github.com/near/nearcore/releases and the protocol_version of rpc.mainnet.near.org status",
    deadlineSec: 1806537599,
    category: 1,
  },
  fed: {
    question: "Will the Fed cut at its December 8-9, 2026 meeting?",
    outcomeNames: ["CUTS", "HOLDS"],
    rule:
      "CUTS if both limits of the federal funds target range (FRED DFEDTARU and DFEDTARL) on 2026-12-10 are lower than on " +
      "2026-12-08; HOLDS if neither is lower (a hike resolves HOLDS). [ifverse:fomc:2026-12-08:2026-12-10]",
    source: "FRED DFEDTARU and DFEDTARL (fred.stlouisfed.org)",
    deadlineSec: 1796842800,
    category: 2,
  },
  fedOct: {
    question: "Did the Fed cut at its October 27-28, 2026 meeting?",
    outcomeNames: ["CUTS", "HOLDS"],
    rule:
      "CUTS if both limits of the federal funds target range (FRED DFEDTARU and DFEDTARL) on 2026-10-29 are lower than on " +
      "2026-10-27; HOLDS if neither is lower (a hike resolves HOLDS). [ifverse:fomc:2026-10-27:2026-10-29]",
    source: "FRED DFEDTARU and DFEDTARL (fred.stlouisfed.org)",
    deadlineSec: 1793210400,
    category: 2,
  },
  nearPast: {
    question: "Did NEAR close above $4.00 on Nov 1, 2026?",
    outcomeNames: ["YES", "NO"],
    rule:
      "YES if the Coinbase Exchange NEAR-USD daily candle for 2026-11-01 (UTC) closes strictly above 4.00 USD, otherwise NO. " +
      "The reporter reports the Coinbase outcome once that candle exists, with the Kraken and Gemini closes for the same UTC " +
      "day in the evidence when available; a disagreement is stated in the evidence and left to the dispute window. " +
      "[ifverse:price_close:NEAR-USD:2026-11-01:4.00]",
    source: "Coinbase Exchange NEAR-USD daily candles (api.exchange.coinbase.com), Kraken NEARUSD OHLC",
    deadlineSec: 1793577599,
    category: 3,
  },
} as const;
type EventKey = keyof typeof EVENTS;

/** E_NEAR, proposed by Sam as a Kind A: K = S rounded down to 0.25. */
function nearDec31(kWad: bigint): { question: string; outcomeNames: string[]; rule: string; source: string; deadlineSec: number; category: number } {
  const k = wadText(kWad, 2);
  return {
    question: `Will NEAR close above $${k} on Dec 31, 2026?`,
    outcomeNames: ["YES", "NO"],
    rule:
      `YES if the Coinbase Exchange NEAR-USD daily candle for 2026-12-31 (UTC) closes strictly above ${k} USD, otherwise NO. ` +
      "The reporter reports the Coinbase outcome once that candle exists, with the Kraken and Gemini closes for the same UTC " +
      "day in the evidence when available; a disagreement is stated in the evidence and left to the dispute window. " +
      `[ifverse:price_close:NEAR-USD:2026-12-31:${k}]`,
    source: "Coinbase Exchange NEAR-USD daily candles (api.exchange.coinbase.com), Kraken NEARUSD OHLC",
    deadlineSec: 1798761599,
    category: 3,
  };
}

// The 2x2 shape of v1 (SHIPS·CUTS, DELAYED·CUTS, SHIPS·HOLDS, DELAYED·HOLDS), scaled so the implied
// spot is S. DELAYED·HOLDS is the thinner world (60,000 wNEAR: a 2,000 wNEAR sale stays well inside
// the 10% TWAP band).
const SHAPE_2X2 = [bps(37_000), bps(30_000), bps(33_000), bps(25_000)];
const DEPTH_2X2 = [e18(100_000n), e18(100_000n), e18(100_000n), e18(60_000n)];
/** The less likely side of each spice-fed odds pool: deep, so a trade never thins the anchor below 10,000. */
const ANCHOR_ODDS_DEPTH = e18(3_000_000n);
const PAST_DEPTH = e18(10_000n);
const PAST_ODDS_DEPTH = e18(100_000n);
const SHIPS_BPS = 6667;

const LEND = { bob: "safe", leo: "normal", uma: "bold" } as const;
const LENDER_USDC = e18(100_000n);
const INSURANCE_USDC = e18(1_000n);
const PERSONA_FLOAT = parseNear("0.4");
const MASK_DH = 0x8;
const MASK_SC = 0x1;

interface StepRecord {
  at: string;
  txs?: string[];
  note?: string;
}

interface Journal {
  price?: { s: string; observedAt: number; spreadBps: number; sources: { source: string; price: string; at: number }[]; log: string; k: string };
  odds?: { shipsBps: number; cutsBps: number; source: string };
  events: Partial<Record<EventKey | "near", number>>;
  markets: Record<string, { sid?: number; pid?: number; poolsAt?: number; openedAt?: number; prices?: string[]; orders?: string[] }>;
  steps: Record<string, StepRecord>;
}

async function readJournal(): Promise<Journal> {
  if (!existsSync(JOURNAL)) return { events: {}, markets: {}, steps: {} };
  return JSON.parse(await readFile(JOURNAL, "utf8")) as Journal;
}

async function saveJournal(j: Journal): Promise<void> {
  const tmp = `${JOURNAL}.tmp`;
  await writeFile(tmp, `${JSON.stringify(j, null, 2)}\n`);
  await rename(tmp, JOURNAL);
}

let J: Journal;
let P: Protocol;
let D: Deployments;
const dry = opts["dry-run"];
const txs: string[] = [];

const owner = (): string => D.root;
const persona = (name: keyof Deployments["personas"]): string => D.personas[name];

/** Runs `fn` unless the journal says the step is done; records its tx hashes. */
async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  if (opts.only && opts.only !== name) return;
  if (J.steps[name] && !opts.only) {
    console.log(`= ${name}: done ${J.steps[name]?.at}`);
    return;
  }
  console.log(`> ${name}`);
  if (dry) return;
  txs.length = 0;
  const note = await fn();
  J.steps[name] = { at: new Date().toISOString(), txs: [...txs], ...(note ? { note } : {}) };
  await saveJournal(J);
}

const S = (): bigint => u128(J.price?.s, "journal price");

/** Remembers the hash of every transaction a step sends. */
function rec<T extends { hash: string }>(r: T): T {
  txs.push(r.hash);
  return r;
}

/** p_w = S x shape_w / M with M = sum q_w x shape_w: the implied spot of the seeded pools is S. */
export function scalePrices(s: bigint, q: bigint[], shape: bigint[]): bigint[] {
  const m = q.reduce((acc, qw, w) => acc + (qw * (shape[w] ?? 0n)) / WAD, 0n);
  return shape.map((x) => (s * x) / m);
}

/** Independent odds of the 2x2 worlds, WAD, summing to 1e18 (world = ships digit + 2 x fed digit). */
function odds2x2(shipsBps: number, cutsBps: number): bigint[] {
  const s = BigInt(shipsBps);
  const c = BigInt(cutsBps);
  const k = 10n ** 10n;
  return [s * c * k, (10_000n - s) * c * k, s * (10_000n - c) * k, (10_000n - s) * (10_000n - c) * k];
}

/** Tops `account` up from the root so it has at least `min` NEAR free (a 300 Tgas call needs 0.31). */
async function ensureFloat(account: string, min = PERSONA_FLOAT): Promise<void> {
  const free = spendable(await nearBalance(account));
  if (free >= min) return;
  const amount = min - free + parseNear("0.05");
  rec(await sendTransaction(owner(), account, [actions.transfer(amount)], { label: `top up ${account} by ${formatNear(amount)} NEAR` }));
}

/** Mints to the account (the root is the faucet owner) and splits it from root into `masks`. */
async function mintSplit(account: string, asset: "wnear" | "usdc", sid: number, masks: number[], amount: bigint): Promise<void> {
  const amt = asset === "usdc" ? roundUpToStep(amount, 6) : amount;
  await P.mint(owner(), asset, account, amt);
  rec(await P.sendMsg(account, asset, amt, { action: "split", scenario_id: sid, to_masks: masks }));
}

async function mintTo(account: string, asset: "wnear" | "usdc", amount: bigint): Promise<bigint> {
  const amt = asset === "usdc" ? roundUpToStep(amount, 6) : amount;
  await P.mint(owner(), asset, account, amt);
  return amt;
}

// Phase a

async function priceStep(): Promise<void> {
  const r: SpotReading = await readPrice();
  const fetchedAt = new Date().toISOString();
  const k = (r.priceWad / (WAD / 4n)) * (WAD / 4n);
  await mkdir(PRICE_LOG_DIR, { recursive: true });
  const log = join(PRICE_LOG_DIR, `seed-prices-${fetchedAt.replace(/[:.]/g, "")}.json`);
  const body = {
    purpose: "staging seed price S (median of four public NEAR/USD sources)",
    fetchedAt,
    median: wadText(r.priceWad, 6),
    medianWad: r.priceWad.toString(),
    spreadBps: r.spreadBps,
    observedAt: r.observedAtSec,
    observedAtIso: new Date(r.observedAtSec * 1000).toISOString(),
    used: r.used,
    dropped: r.dropped ?? null,
    failed: r.failed,
    sources: r.sources.map((q) => ({ source: q.source, raw: q.raw, observedAt: q.observedAtSec, observedAtIso: new Date(q.observedAtSec * 1000).toISOString() })),
    k: wadText(k, 2),
    rules: "median (floor mean of the middle two when even); spread ceil((max-min)*10000/median) <= 200 bps; >= 3 sources",
  };
  await writeFile(log, `${JSON.stringify(body, null, 2)}\n`);
  J.price = {
    s: r.priceWad.toString(),
    observedAt: r.observedAtSec,
    spreadBps: r.spreadBps,
    sources: r.sources.map((q) => ({ source: q.source, price: q.raw, at: q.observedAtSec })),
    log,
    k: k.toString(),
  };
  const fed = await fedCutsOdds();
  J.odds = { shipsBps: SHIPS_BPS, cutsBps: fed.cutsBps, source: `SPICE: no market exists, 66.67% assumed; ${fed.source}` };
  console.log(`  S = ${wadText(r.priceWad, 5)} (spread ${r.spreadBps} bps, ${r.used} sources), K = ${wadText(k, 2)}; log ${log}`);
  console.log(`  odds: SHIPS ${SHIPS_BPS} bps, CUTS ${fed.cutsBps} bps (${fed.source})`);
}

async function storageStep(): Promise<void> {
  await P.ensureStorage(owner(), owner(), parseNear("1.0"));
  for (const name of ["alice", "bob", "ravi", "sam", "uma", "carl", "leo"] as const) await P.ensureStorage(owner(), persona(name), parseNear("0.1"));
  await P.ensureStorage(owner(), D.reporter, parseNear("0.02"));
  if (D.ops?.keeper) await P.ensureStorage(owner(), D.ops.keeper, parseNear("0.05"));
}

/** The median now, retried while a source is briefly unreachable (rate limits, timeouts). */
async function readPrice(): Promise<SpotReading> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchNearUsd({ timeoutMs: 8_000 });
    } catch (err) {
      if (attempt >= 5) throw err;
      console.log(`  price read ${attempt} failed (${err instanceof Error ? err.message : String(err)}); again in 10 s`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

async function reportReference(): Promise<void> {
  const stored = await P.reference();
  if (stored && stored.age_sec < 120) {
    console.log(`  reference ${wadText(u128(stored.price), 5)} is ${stored.age_sec} s old (${stored.source}); not reported again`);
    return;
  }
  const r = await readPrice();
  rec(await P.reportReference(D.reporter, r.priceWad, r.observedAtSec));
  console.log(`  reference ${wadText(r.priceWad, 5)} observed ${new Date(r.observedAtSec * 1000).toISOString()} (${r.used} sources, ${r.spreadBps} bps)`);
}

async function referenceStep(): Promise<void> {
  const cfg: ReferenceConfig = {
    enabled: true,
    guest: null,
    reporter_id: D.reporter,
    min_sources: 3,
    max_spread_bps: 200,
    max_result_delay_sec: 300,
    borrow_max_age_sec: 3_600,
    liquidation_max_age_sec: 300,
    min_price: (WAD / 10n).toString(),
    max_price: e18(1_000n).toString(),
  };
  rec(await P.setReferenceConfig(owner(), cfg));
  await reportReference();
}

async function priceDefaultsStep(): Promise<void> {
  rec(
    await P.setDefaultPriceConfig(owner(), {
      min_age_sec: 1_800,
      min_depth: e18(50_000n).toString(),
      reference: true,
      max_deviation: (WAD / 10n).toString(),
      max_haircut: (WAD / 5n).toString(),
    }),
  );
}

async function setParams(change: (p: MarketParams) => MarketParams): Promise<void> {
  const current = (await P.marketParams()).params;
  rec(await P.setMarketParams(owner(), change(current)));
}

async function paramsStep(): Promise<void> {
  // the testnet column (new() wrote it) with the go-live changes of K2 / 3.8 G4
  await setParams((p) => ({ ...p, require_external: true, min_reference_odds_depth_usdc: e18(10_000n).toString() }));
}

async function eventsStep(): Promise<void> {
  for (const key of Object.keys(EVENTS) as EventKey[]) {
    if (J.events[key]) continue;
    const e = EVENTS[key];
    const r = rec(await P.call1y<number>(owner(), "create_event", { question: e.question, outcome_names: e.outcomeNames, rule: e.rule, deadline_sec: e.deadlineSec }, `create_event ${key}`));
    if (typeof r.value !== "number") throw new Error(`create_event returned ${r.returnText}`);
    J.events[key] = r.value;
    await saveJournal(J);
    rec(await P.setEventMeta(owner(), r.value, e.source, e.category));
    console.log(`  ${key}: event ${r.value}`);
  }
}

/** World pools at `prices` with `depths` wNEAR, and one odds pool per pair at `q` (less likely side `oddsDepth`). */
async function seedMarket(key: string, eventKeys: EventKey[], prices: bigint[], depths: bigint[], q: bigint[], oddsDepth: bigint): Promise<number> {
  const m = (J.markets[key] ??= {});
  if (m.sid === undefined) {
    const ids = eventKeys.map((e) => J.events[e] as number);
    m.sid = await P.createScenario(owner(), ids);
    m.prices = prices.map(String);
    await saveJournal(J);
    console.log(`  ${key}: scenario ${m.sid}`);
  }
  const sid = m.sid;
  const n = prices.length;
  const pools = await P.worldPools(sid);
  if (pools.size < n) {
    const maxWnear = depths.reduce((a, b) => (b > a ? b : a), 0n);
    const usdcNeed = depths.map((d, w) => roundUpToStep(wmul(d, prices[w] ?? 0n), 6));
    const maxUsdc = usdcNeed.reduce((a, b) => (b > a ? b : a), 0n);
    const haveW = await P.verseBalance(owner(), sid, "wnear", 1);
    if (haveW < maxWnear) await mintSplit(owner(), "wnear", sid, singles(n), maxWnear);
    const haveU = await P.verseBalance(owner(), sid, "usdc", 1);
    if (haveU < maxUsdc) await mintSplit(owner(), "usdc", sid, singles(n), maxUsdc);
    for (let w = 0; w < n; w++) {
      if (pools.has(w)) continue;
      await P.createWithinPool(owner(), sid, w, depths[w] ?? 0n, usdcNeed[w] ?? 0n);
    }
  }
  const between = (await P.view<{ kind: string; mask0: number; mask1: number }[]>("pools_of", { scenario_id: sid })).filter((p) => p.kind === "between");
  const root = (1 << n) - 1;
  for (const [x, y] of oddsPairs(n)) {
    if (between.some((b) => (b.mask0 === x && b.mask1 === y) || (b.mask0 === y && b.mask1 === x))) continue;
    const rest = root & ~(x | y);
    await mintSplit(owner(), "usdc", sid, rest ? [x, y, rest] : [x, y], oddsDepth);
    const [ax, ay] = seedReserves(sumOver(q, x), sumOver(q, y), oddsDepth);
    await P.createBetweenPool(owner(), sid, x, y, roundDownToStep(ax, 6) || ax, roundDownToStep(ay, 6) || ay);
  }
  m.poolsAt ??= await chainNowSec();
  await saveJournal(J);
  const card = await P.market(sid);
  if (!card?.listed) rec(await P.setMarketListing(owner(), sid, true));
  return sid;
}

async function spiceFedStep(): Promise<void> {
  const q = odds2x2(J.odds?.shipsBps ?? SHIPS_BPS, J.odds?.cutsBps ?? 100);
  const prices = scalePrices(S(), q, SHAPE_2X2);
  const sid = await seedMarket("spice-fed", ["spice", "fed"], prices, DEPTH_2X2, q, ANCHOR_ODDS_DEPTH);
  for (const e of ["spice", "fed"] as const) {
    if ((await P.referenceMarketOf(J.events[e] as number)) !== sid) rec(await P.setReferenceMarket(owner(), J.events[e] as number, sid));
  }
  await setParams((p) => ({ ...p, anchors: [sid, 0, 0] }));
  console.log(`  spice-fed ${sid}: prices ${prices.map((p) => wadText(p, 4)).join(" / ")}, implied ${wadText(await P.impliedSpot(sid), 5)} vs S ${wadText(S(), 5)}`);
}

async function pastStep(key: "fed-oct" | "near-nov1"): Promise<void> {
  // the known loser at 1%: owner-funded for the same reason as in markets.md 17
  const q = key === "fed-oct" ? [bps(100), bps(9_900)] : [bps(9_900), bps(100)];
  const shape = key === "fed-oct" ? [bps(11_500), bps(10_000)] : [bps(10_100), bps(9_900)];
  const prices = scalePrices(S(), q, shape);
  const sid = await seedMarket(key, [key === "fed-oct" ? "fedOct" : "nearPast"], prices, [PAST_DEPTH, PAST_DEPTH], q, PAST_ODDS_DEPTH);
  console.log(`  ${key} ${sid}: prices ${prices.map((p) => wadText(p, 4)).join(" / ")}`);
}

async function lendersStep(): Promise<void> {
  const sid = J.markets["spice-fed"]?.sid as number;
  for (const [name, tier] of Object.entries(LEND) as [keyof typeof LEND, Tier][]) {
    const who = persona(name);
    if ((await P.supplyBalance(sid, who, tier)) > 0n) continue;
    await ensureFloat(who);
    await mintTo(who, "usdc", LENDER_USDC);
    rec(await P.supply(who, sid, LENDER_USDC, tier));
  }
  const bold = await P.marketState(sid, "bold");
  if (u128(bold.insurance) === 0n) {
    await mintTo(owner(), "usdc", INSURANCE_USDC);
    rec(await P.fundInsurance(owner(), sid, INSURANCE_USDC, "bold"));
  }
}

async function ordersStep(): Promise<string> {
  const sid = J.markets["spice-fed"]?.sid as number;
  const ravi = persona("ravi");
  await ensureFloat(ravi);
  const pools = await P.worldPools(sid);
  const pDH = u128(pools.get(3)?.price);
  const pSC = u128(pools.get(0)?.price);
  const size = e18(1_000n);
  const expiry = (await chainNowSec()) + 30 * 24 * 3600;
  // the standing bid in DELAYED·HOLDS 2% under the pool, escrowed in USDC-if-DELAYED·HOLDS
  const bid = (pDH * 9_800n) / 10_000n;
  await mintSplit(ravi, "usdc", sid, [MASK_DH, 0x1, 0x2, 0x4], orderCost(size, bid));
  const o1 = await P.postOrder(ravi, sid, MASK_DH, "bid", bid, size, expiry);
  // an ask/bid pair in SHIPS·CUTS around the pool price
  await mintSplit(ravi, "wnear", sid, singles(4), size);
  const ask = (pSC * 10_200n) / 10_000n;
  const o2 = await P.postOrder(ravi, sid, MASK_SC, "ask", ask, size, expiry);
  const bidSc = (pSC * 9_800n) / 10_000n;
  await mintSplit(ravi, "usdc", sid, [MASK_SC, 0x2, 0x4, 0x8], orderCost(size, bidSc));
  const o3 = await P.postOrder(ravi, sid, MASK_SC, "bid", bidSc, size, expiry);
  (J.markets["spice-fed"] as { orders?: string[] }).orders = [o1, o2, o3];
  return `ravi orders: DH bid ${o1} at ${wadText(bid, 4)}; SC ask ${o2} at ${wadText(ask, 4)}, bid ${o3} at ${wadText(bidSc, 4)}`;
}

async function aliceFedOctStep(): Promise<void> {
  const sid = J.markets["fed-oct"]?.sid as number;
  const alice = persona("alice");
  await ensureFloat(alice);
  const amount = e18(200n);
  await mintTo(alice, "wnear", amount);
  // sells her wNEAR in HOLDS (world 1): she keeps wNEAR-if-CUTS and holds USDC-if-HOLDS
  rec(await P.sendMsg(alice, "wnear", amount, { action: "conditional_sell", scenario_id: sid, sell_mask: 0x2, plans: [[], []], min_out: ["0", "0"], to_lending: false }));
}

// Phase b

async function fullWindow(key: string): Promise<void> {
  const sid = J.markets[key]?.sid as number;
  const rows = await P.worldPrices(sid);
  const bad = rows.filter((r) => r.status !== "trusted");
  if (bad.length > 0) {
    const since = J.markets[key]?.poolsAt ?? J.markets[key]?.openedAt ?? 0;
    const left = since + 1_800 - (await chainNowSec());
    throw new Error(`${key} (${sid}) is not trusted yet: ${bad.map((r) => `w${r.world} ${r.status}`).join(", ")}; about ${Math.max(0, left)} s of the TWAP window left`);
  }
}

async function borrowersStep(): Promise<string> {
  const sid = J.markets["spice-fed"]?.sid as number;
  await fullWindow("spice-fed");
  await reportReference();
  const check = await P.priceCheck(sid);
  if (check.borrow_block !== null) throw new Error(`spice-fed borrow_block ${check.borrow_block}`);
  const notes: string[] = [];
  // Alice: 2,000 wNEAR, keeps SHIPS·CUTS, sells the rest into lending (Normal), borrows 0.8 x max
  const alice = persona("alice");
  if ((await P.debt(sid, alice, "normal")) === 0n) {
    await ensureFloat(alice);
    const amount = e18(2_000n);
    await mintTo(alice, "wnear", amount);
    rec(await P.sendMsg(alice, "wnear", amount, { action: "conditional_sell", scenario_id: sid, sell_mask: 0xe, plans: [[], [], [], []], min_out: ["0", "0", "0", "0"], to_lending: true, tier: "normal" }));
    notes.push(await borrowShare(sid, alice, "normal", 8_000n));
  }
  for (const [name, tier, wnear, shareBps] of [
    ["sam", "safe", e18(500n), 5_000n],
    ["carl", "bold", e18(1_000n), 9_000n],
    ["leo", "bold", e18(1_000n), 9_900n],
  ] as const) {
    const who = persona(name);
    if ((await P.debt(sid, who, tier)) > 0n) continue;
    await ensureFloat(who);
    await mintTo(who, "wnear", wnear);
    rec(await P.depositCollateralMsg(who, "wnear", sid, wnear, tier));
    notes.push(await borrowShare(sid, who, tier, shareBps));
  }
  return notes.join("; ");
}

async function borrowShare(sid: number, who: string, tier: Tier, shareBps: bigint): Promise<string> {
  const v = await P.accountView(sid, who, tier);
  const max = u128(v?.max_borrow);
  const amount = roundDownToStep((max * shareBps) / 10_000n, 6);
  rec(await P.borrow(who, sid, amount, tier));
  const after = await P.accountView(sid, who, tier);
  const line = `${who.split(".")[0]} ${tier}: borrowed ${wadText(amount, 2)} of max ${wadText(max, 2)}, HF ${after?.health_factor ? wadText(u128(after.health_factor), 3) : "inf"}`;
  console.log(`  ${line}`);
  return line;
}

/**
 * Pledges the ideal mix (+2%) from two personas, one asset each; the pledge that reaches the goal
 * schedules the opening. Short of the goal (the planner's usable value), both sides grow by 10% a round.
 */
async function pledgeToGoal(key: string, pid: number, wnearFrom: string, usdcFrom: string): Promise<number> {
  let p = await P.proposal(pid);
  if (!p) throw new Error(`no proposal ${pid}`);
  let margin = 10_200n;
  for (let round = 0; round < 4 && !p.opened; round++) {
    const wantW = (u128(p.ideal_wnear) * margin) / 10_000n;
    const wantU = roundUpToStep((u128(p.ideal_usdc) * margin) / 10_000n, 6);
    for (const [who, asset, want, have] of [
      [wnearFrom, "wnear", wantW, u128(p.pledged_wnear)],
      [usdcFrom, "usdc", wantU, u128(p.pledged_usdc)],
    ] as const) {
      if (have >= want) continue;
      await ensureFloat(who);
      const amount = asset === "usdc" ? roundUpToStep(want - have, 6) : want - have;
      await mintTo(who, asset, amount);
      const r = rec(await P.pledge(who, pid, asset, amount));
      if (r.logs.some((l) => l.includes('"market_opened"'))) console.log(`  ${key}: opened by ${who}'s pledge`);
    }
    p = await P.proposal(pid);
    if (!p) throw new Error(`no proposal ${pid}`);
    if (!p.opened && p.status === "ready") {
      await ensureFloat(owner());
      rec(await P.openMarket(owner(), pid));
      p = await P.proposal(pid);
      if (!p) throw new Error(`no proposal ${pid}`);
    }
    if (!p.opened) console.log(`  ${key}: proposal ${pid} status ${p.status}, blocker ${p.blocker}`);
    margin += 1_000n;
  }
  if (!p.opened) throw new Error(`${key}: proposal ${pid} did not open (${p.blocker})`);
  return p.opened.scenario_id;
}

async function kindB(key: string, proposer: string, eventKeys: (EventKey | "near")[], wnearFrom: string, usdcFrom: string): Promise<string> {
  const m = (J.markets[key] ??= {});
  const ids = eventKeys.map((e) => J.events[e] as number);
  if (m.pid === undefined) {
    const check = await P.marketCheck(ids);
    if (check.blocker !== null) throw new Error(`${key}: market_check(${ids.join(", ")}) blocker ${check.blocker}`);
    await ensureFloat(proposer, PERSONA_FLOAT + u128(check.bond) + u128(check.reserve));
    const r = rec(await P.proposeMarket(proposer, ids));
    if (typeof r.value !== "number") throw new Error(`propose_market returned ${r.returnText}`);
    m.pid = r.value;
    await saveJournal(J);
    console.log(`  ${key}: proposal ${m.pid} by ${proposer}, goal ${wadText(u128(check.goal), 0)} USDC`);
  }
  m.sid = await pledgeToGoal(key, m.pid, wnearFrom, usdcFrom);
  m.openedAt ??= await chainNowSec();
  await saveJournal(J);
  return `${key}: proposal ${m.pid} opened scenario ${m.sid}`;
}

async function nearDec31Step(): Promise<string> {
  const m = (J.markets["near-dec31"] ??= {});
  const spec = nearDec31(u128(J.price?.k, "K"));
  const sam = persona("sam");
  if (m.pid === undefined) {
    const params = (await P.marketParams()).params;
    await ensureFloat(sam, PERSONA_FLOAT + parseNear("0.3"));
    const r = rec(
      await P.proposeEvent(sam, { question: spec.question, outcomeNames: spec.outcomeNames, rule: spec.rule, source: spec.source, deadlineSec: spec.deadlineSec, category: spec.category, terms: { odds0_bps: 5_000, mult_bps: [11_000, 9_000] } }, params),
    );
    if (typeof r.value !== "number") throw new Error(`propose_event returned ${r.returnText}`);
    m.pid = r.value;
    await saveJournal(J);
    console.log(`  near-dec31: Kind A proposal ${m.pid} by sam: "${spec.question}"`);
  }
  const p = await P.proposal(m.pid);
  if (p?.status === "review") {
    await ensureFloat(owner());
    rec(await P.approveProposal(owner(), m.pid, null));
  }
  m.sid = await pledgeToGoal("near-dec31", m.pid, persona("uma"), persona("bob"));
  m.openedAt ??= await chainNowSec();
  const card = await P.market(m.sid);
  J.events.near = card?.event_ids[0];
  await saveJournal(J);
  return `near-dec31: proposal ${m.pid} opened scenario ${m.sid}, event ${J.events.near}`;
}

// Phase c

async function deepenStep(): Promise<string> {
  await fullWindow("near-dec31");
  const sid = J.markets["near-dec31"]?.sid as number;
  const pools = await P.view<{ id: number; kind: string; mask0: number; mask1: number; reserve0: string; reserve1: string }[]>("pools_of", { scenario_id: sid });
  const odds = pools.find((p) => p.kind === "between");
  if (!odds) throw new Error("near-dec31 has no odds pool");
  const r0 = u128(odds.reserve0);
  const r1 = u128(odds.reserve1);
  const target = e18(20_000n);
  const small = r0 < r1 ? r0 : r1;
  if (small >= target) return `odds pool ${odds.id} already ${wadText(small, 0)} on its smaller side`;
  // add at the current ratio until the smaller reserve reaches 20,000 (+1%)
  const factor = ((target - small) * 10_100n) / 10_000n;
  const a0 = roundUpToStep((r0 * factor) / small, 6);
  const a1 = roundUpToStep((r1 * factor) / small, 6);
  const need = a0 > a1 ? a0 : a1;
  await mintSplit(owner(), "usdc", sid, [odds.mask0, odds.mask1], need);
  rec(await P.callWith(owner(), "add_liquidity", { pool_id: odds.id, amount0: a0.toString(), amount1: a1.toString(), min_liquidity: "0" }, { deposit: 1n, gasTgas: 100 }));
  const after = (await P.view<{ id: number; reserve0: string; reserve1: string }[]>("pools_of", { scenario_id: sid })).find((p) => p.id === odds.id);
  return `odds pool ${odds.id}: ${wadText(r0, 0)}/${wadText(r1, 0)} -> ${after?.reserve0 ? wadText(u128(after.reserve0), 0) : "?"}/${after?.reserve1 ? wadText(u128(after.reserve1), 0) : "?"}`;
}

async function recordStep(): Promise<void> {
  const sf = J.markets["spice-fed"]?.sid as number;
  const record = {
    spice_event: J.events.spice,
    fed_event: J.events.fed,
    past_fed_event: J.events.fedOct,
    scenario_2x2: sf,
    scenario_binary: J.markets.spice?.sid ?? sf,
    implied_spot: (await P.impliedSpot(sf)).toString(),
    odds_ships_bps: J.odds?.shipsBps,
    odds_cuts_bps: J.odds?.cutsBps,
    odds_source: J.odds?.source ?? null,
    seeded_at_sec: await chainNowSec(),
    seeded_block: await chainHeight(),
    spot_from: "2x2",
    ravi_order: J.markets["spice-fed"]?.orders?.[0] ?? null,
    v: 2,
    seed_price: {
      price: J.price?.s,
      observed_at: J.price?.observedAt,
      spread_bps: J.price?.spreadBps,
      sources: J.price?.sources,
    },
    events: (Object.entries(J.events) as [string, number][]).map(([key, event_id]) => ({ key, event_id })),
    markets: Object.entries(J.markets)
      .filter(([, m]) => m.sid !== undefined)
      .map(([key, m]) => ({ key, scenario_id: m.sid, origin: m.pid === undefined ? "owner" : "pledged", ...(m.pid === undefined ? {} : { proposal_id: m.pid }) })),
  };
  rec(await P.setDemoRecord(owner(), record));
  const d = await requireDeployments();
  await writeDeployments({ ...d, resolutionHold: [J.events.fedOct as number, J.events.nearPast as number], goLiveAt: new Date().toISOString() });
}

async function checksStep(): Promise<string> {
  const lines: string[] = [];
  for await (const card of P.listMarkets({ listedOnly: true })) {
    const check = await P.priceCheck(card.scenario_id);
    lines.push(
      `${card.scenario_id} W${card.world_count} ${card.origin}${card.proposal_id !== null ? ` p${card.proposal_id}` : ""} events [${card.event_ids.join(",")}] ` +
        `lendable ${card.lendable} implied ${wadText(u128(card.implied_spot), 4)} ref ${check.config.reference} borrow_block ${check.borrow_block}`,
    );
  }
  for (const l of lines) console.log(`  ${l}`);
  const sf = J.markets["spice-fed"]?.sid as number;
  const sfCheck = await P.priceCheck(sf);
  if (sfCheck.borrow_block !== null) console.log(`  WARNING spice-fed borrow_block ${sfCheck.borrow_block}`);
  if (J.events.near !== undefined && J.events.fed !== undefined) {
    const mc = await P.marketCheck([J.events.fed, J.events.near]);
    lines.push(`market_check([fed, near]) blocker ${mc.blocker}, goal ${wadText(u128(mc.goal), 0)}`);
    console.log(`  ${lines[lines.length - 1]}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  if (NETWORK !== "staging") throw new Error("NEAR_NETWORK must be staging");
  D = await requireDeployments();
  if (!D.contract) throw new Error("no contract in deployments/staging.json; run deploy.ts first");
  P = new Protocol(D);
  J = await readJournal();
  console.log(`${NETWORK} via ${DEFAULT_RPC_URL}; contract ${D.contractId}; journal ${JOURNAL}${dry ? " (dry run)" : ""}`);
  const v = await P.version();
  if (v.state_version !== 2) throw new Error(`contract state version ${v.state_version}`);
  const phase = opts.phase;
  const runA = phase === "a" || phase === "all";
  const runB = phase === "b" || phase === "all";
  const runC = phase === "c" || phase === "all";
  if (runA) {
    await step("price", priceStep);
    await step("storage", storageStep);
    await step("reference", referenceStep);
    await step("price-defaults", priceDefaultsStep);
    await step("params", paramsStep);
    await step("events", eventsStep);
    await step("spice-fed", spiceFedStep);
    await step("fed-oct", () => pastStep("fed-oct"));
    await step("near-nov1", () => pastStep("near-nov1"));
    await step("lenders", lendersStep);
    await step("orders", ordersStep);
    await step("alice-fed-oct", aliceFedOctStep);
  }
  if (runB) {
    await step("borrowers", borrowersStep);
    await step("reference-b", reportReference);
    await step("fed-dec", () => kindB("fed-dec", persona("uma"), ["fed"], persona("leo"), persona("alice")));
    await step("spice", () => kindB("spice", persona("bob"), ["spice"], persona("carl"), persona("sam")));
    await step("near-dec31", nearDec31Step);
  }
  if (runC) {
    await step("deepen", deepenStep);
    await step("reference-c", reportReference);
    await step("spice-near", () => kindB("spice-near", persona("alice"), ["near", "spice"], persona("ravi"), persona("leo")));
    await step("three", () => kindB("three", persona("ravi"), ["spice", "fed", "near"], persona("carl"), persona("uma")));
    await step("record", recordStep);
    await step("checks", checksStep);
  }
  const root = await nearBalance(owner());
  console.log(`root ${owner()} has ${formatNear(spendable(root))} NEAR free`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
