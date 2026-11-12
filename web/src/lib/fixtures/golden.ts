// Design fixtures: the seeded demo replayed through constant-product maths, one stage at a time,
// so every screen can be rendered and photographed before the contract is deployed. Nothing here is read in a real
// build: NEXT_PUBLIC_FIXTURES=1 switches the data source.
import type {
  AccountViewJson,
  AppConfigView,
  EventViewJson,
  ImpactPointJson,
  OrderViewJson,
  PoolViewJson,
  RootLpViewJson,
  ScenarioViewJson,
  WorldViewJson,
} from "../types";
import { E18, addLiquidity, priceOf, seededPool, sellInto, type Pool } from "./amm";

export const STAGES = ["seeded", "sold", "borrowed", "book", "lp", "pushed", "proposed", "fed", "collapsed"] as const;
export type Stage = (typeof STAGES)[number];
export const PERSONAS = ["alice", "bob", "ravi", "sam", "uma", "carl", "dana", "owner"] as const;
export type Persona = (typeof PERSONAS)[number];

export const ROOT_ACCOUNT = "multiverse-lending.testnet";
export const FIXTURE_IDS = {
  contract: `app.${ROOT_ACCOUNT}`,
  wnear: `wnear.${ROOT_ACCOUNT}`,
  usdc: `usdc.${ROOT_ACCOUNT}`,
} as const;
export const personaAccount = (p: Persona) => (p === "owner" ? ROOT_ACCOUNT : `${p}.${ROOT_ACCOUNT}`);
export const personaOf = (accountId: string | null | undefined): Persona | undefined =>
  PERSONAS.find((p) => personaAccount(p) === accountId);

/** "3700" or "0.5" → 18-decimal bigint. */
export function wad(s: string): bigint {
  const [w, f = ""] = s.split(".");
  return BigInt(w) * E18 + BigInt((f + "0".repeat(18)).slice(0, 18));
}

const reached = (stage: Stage, from: Stage) => STAGES.indexOf(stage) >= STAGES.indexOf(from);

const S2X2 = 1;
const SBIN = 2;
const LABELS: Record<number, string[]> = {
  [S2X2]: ["SHIPS·CUTS", "DELAYED·CUTS", "SHIPS·HOLDS", "DELAYED·HOLDS"],
  [SBIN]: ["SHIPS", "DELAYED"],
};
const EVENTS_OF: Record<number, number[]> = { [S2X2]: [1, 2], [SBIN]: [1] };

const LLTV = wad("0.75");
const BORROW_RATE = 1_585_489_599n;
const SHIPS_BPS = 6667n;
const CUTS_BPS = 104n;
const SPOT = wad("3037.866632");
const SEEDED_AT = 1_794_337_200; // 2026-11-11 09:00 UTC
const DAY = 86_400;

const EVENTS: Record<number, Omit<EventViewJson, "proposed_at_sec" | "proposed_outcome" | "proposal_open" | "finalized" | "outcome" | "finalizable_at_sec" | "proposed_by">> = {
  1: {
    id: 1,
    question: "Will Glamsterdam ship on mainnet by Dec 31, 2026?",
    rule: "SHIPS if the Glamsterdam upgrade is active on Ethereum mainnet before 2027-01-01 00:00 UTC; otherwise DELAYED. During the hackathon this event is resolved from a team-controlled API (demo).",
    outcome_names: ["SHIPS", "DELAYED"],
    deadline_sec: 1798761599,
  },
  2: {
    id: 2,
    question: "Will the Fed cut at its December meeting?",
    rule: "CUTS if and only if the upper limit of the federal funds target range (FRED DFEDTARU) after the Dec 8-9, 2026 FOMC meeting is lower than before it; otherwise HOLDS (a hike resolves HOLDS).",
    outcome_names: ["CUTS", "HOLDS"],
    deadline_sec: 1796842800,
  },
  3: {
    id: 3,
    question: "Did the Fed cut at its October 27-28, 2026 meeting?",
    rule: "CUTS if and only if both limits of the federal funds target range (FRED DFEDTARU and DFEDTARL) are lower on 2026-10-29 than on 2026-10-27; HOLDS if neither is; if they disagree, nothing is reported.",
    outcome_names: ["CUTS", "HOLDS"],
    deadline_sec: 1793210400,
  },
};

type Book = { orders: OrderViewJson[] };
type Positions = {
  wallet: { wnear: bigint; usdc: bigint }; // token units: WETH 18 decimals, USDC 6
  verse: Record<number, { wnear: bigint[]; usdc: bigint[] }>;
  collateral: Record<number, { asset: "wnear" | "usdc"; mask: number; amount: bigint; real?: boolean }[]>;
  debt: Record<number, bigint>;
  supplied: Record<number, { amount: bigint; principal: bigint }>;
  lpShares: Record<number, bigint>;
  registered: boolean;
  usdcRegistered: boolean;
};

export type FixtureWorld = {
  stage: Stage;
  now: number;
  pools: Record<number, Pool[]>;
  possible: Record<number, number>;
  resolutionCount: Record<number, number>;
  halted: Record<number, boolean>;
  impact: Record<number, ImpactPointJson[]>;
  book: Book;
  accounts: Record<Persona, Positions>;
  events: Record<number, EventViewJson>;
  vault: Record<number, { supply: bigint; liquidity: bigint[]; fees: { wnear: bigint; usdc: bigint }[] } | undefined>;
  market: Record<number, { supply: bigint; borrow: bigint }>;
};

const usdcUnits = (x: bigint) => x / 10n ** 12n;
const zeros = (n: number) => Array.from({ length: n }, () => 0n);

function emptyPositions(): Positions {
  return {
    wallet: { wnear: 0n, usdc: 0n },
    verse: { [S2X2]: { wnear: zeros(4), usdc: zeros(4) }, [SBIN]: { wnear: zeros(2), usdc: zeros(2) } },
    collateral: { [S2X2]: [], [SBIN]: [] },
    debt: {},
    supplied: {},
    lpShares: {},
    registered: true,
    usdcRegistered: true,
  };
}

const pricesOf = (pools: Pool[], possible: number): string[] =>
  pools.map((p, i) => (((possible >> i) & 1) === 1 ? priceOf(p).toString() : "0"));

/** Replays the demo story up to `stage`. */
export function buildWorld(stage: Stage, now = Math.floor(Date.now() / 1000)): FixtureWorld {
  const pools: Record<number, Pool[]> = {
    [S2X2]: [
      seededPool(wad("100"), wad("3700")),
      seededPool(wad("100"), wad("3000")),
      seededPool(wad("100"), wad("3300")),
      seededPool(wad("40"), wad("2500")),
    ],
    [SBIN]: [seededPool(wad("100"), wad("3400")), seededPool(wad("100"), wad("2800"))],
  };
  const impact: Record<number, ImpactPointJson[]> = { [S2X2]: [], [SBIN]: [] };
  const accounts = Object.fromEntries(PERSONAS.map((p) => [p, emptyPositions()])) as Record<Persona, Positions>;
  const book: Book = { orders: [] };
  const vault: FixtureWorld["vault"] = { [S2X2]: undefined, [SBIN]: undefined };
  const market = { [S2X2]: { supply: wad("100000"), borrow: 0n }, [SBIN]: { supply: wad("100000"), borrow: 0n } };
  const alice = accounts.alice;
  const ravi = accounts.ravi;
  const uma = accounts.uma;
  const carl = accounts.carl;

  // Seeding: Alice holds 2 WETH and 50 USDC; Bob has supplied 100,000 to each market; Ravi bids 2,450 for 1 WETH in
  // DELAYED·HOLDS, so his other three worlds keep 2,450 USDC each.
  alice.wallet = { wnear: wad("2"), usdc: usdcUnits(wad("50")) };
  accounts.bob.wallet = { wnear: 0n, usdc: usdcUnits(wad("10000")) };
  accounts.bob.supplied = { [S2X2]: { amount: wad("100000"), principal: wad("100000") }, [SBIN]: { amount: wad("100000"), principal: wad("100000") } };
  ravi.wallet = { wnear: wad("2"), usdc: usdcUnits(wad("5000")) };
  ravi.verse[S2X2].usdc = [wad("2450"), wad("2450"), wad("2450"), 0n];
  accounts.sam.wallet = { wnear: 0n, usdc: usdcUnits(wad("3000")) };
  uma.wallet = { wnear: wad("5"), usdc: usdcUnits(wad("20000")) };
  accounts.carl.wallet = { wnear: wad("2"), usdc: 0n };
  accounts.owner.wallet = { wnear: wad("3"), usdc: 0n };
  accounts.dana.wallet = { wnear: wad("1"), usdc: 0n };
  accounts.dana.registered = false;
  accounts.dana.usdcRegistered = false;
  const raviBid: OrderViewJson = {
    id: "1",
    maker: personaAccount("ravi"),
    scenario_id: S2X2,
    mask: 8,
    side: "bid",
    price: wad("2450").toString(),
    amount: wad("1").toString(),
    remaining: wad("1").toString(),
    escrow: wad("2450").toString(),
    expiry_sec: SEEDED_AT + 30 * DAY,
    epoch: 0,
  };
  book.orders.push(raviBid);

  if (reached(stage, "sold")) {
    // Alice sells 2 ETH in the L-shape (DELAYED or HOLDS) into lending. Ravi's bid takes 1 ETH in DELAYED·HOLDS.
    const p = pools[S2X2];
    const r1 = sellInto(p[1], wad("2"), 15000n);
    const r2 = sellInto(p[2], wad("2"), 15000n);
    const r3 = sellInto(p[3], wad("1"), 15000n);
    const fromBid = wad("2450");
    pools[S2X2] = [p[0], r1.pool, r2.pool, r3.pool];
    impact[S2X2].push(
      { at_sec: now - 900, prices: pricesOf([p[0], r1.pool, p[2], p[3]], 15) },
      { at_sec: now - 899, prices: pricesOf([p[0], r1.pool, r2.pool, p[3]], 15) },
      { at_sec: now - 898, prices: pricesOf(pools[S2X2], 15) },
    );
    alice.wallet.wnear = 0n;
    alice.collateral[S2X2] = [
      { asset: "wnear", mask: 1, amount: wad("2") },
      { asset: "usdc", mask: 2, amount: r1.out },
      { asset: "usdc", mask: 4, amount: r2.out },
      { asset: "usdc", mask: 8, amount: fromBid + r3.out },
    ];
    raviBid.remaining = "0";
    raviBid.escrow = "0";
    ravi.verse[S2X2].wnear[3] += wad("1");
  }

  if (reached(stage, "borrowed")) {
    const debt = wad("3000.412328");
    alice.debt[S2X2] = debt;
    alice.wallet.usdc += usdcUnits(wad("3000"));
    market[S2X2].borrow += debt;
    market[S2X2].supply += wad("1.233972");
    accounts.bob.supplied[S2X2] = { amount: wad("100001.233972"), principal: wad("100000") };
  }

  if (reached(stage, "book")) {
    // Ravi quotes SHIPS·CUTS on both sides; Sam and Uma add a little depth.
    const exp = now + DAY - 1200;
    const order = (id: number, maker: Persona, side: "bid" | "ask", price: string, amount: string): OrderViewJson => ({
      id: String(id),
      maker: personaAccount(maker),
      scenario_id: S2X2,
      mask: 1,
      side,
      price: wad(price).toString(),
      amount: wad(amount).toString(),
      remaining: wad(amount).toString(),
      escrow: (side === "bid" ? (wad(price) * wad(amount)) / 10n ** 18n : wad(amount)).toString(),
      expiry_sec: exp,
      epoch: 0,
    });
    book.orders.push(order(2, "ravi", "ask", "3750", "0.5"), order(3, "ravi", "bid", "3600", "0.5"), order(4, "sam", "bid", "3525", "0.25"), order(5, "ravi", "ask", "3880", "0.4"));
    ravi.wallet.wnear -= wad("0.9");
    ravi.wallet.usdc -= usdcUnits(wad("1800"));
    for (const w of [1, 2, 3]) {
      ravi.verse[S2X2].wnear[w] += wad("0.9");
      ravi.verse[S2X2].usdc[w] += wad("1800");
    }
    accounts.sam.wallet.usdc -= usdcUnits(wad("881.25"));
    for (const w of [1, 2, 3]) accounts.sam.verse[S2X2].usdc[w] += wad("881.25");
  }

  if (reached(stage, "lp")) {
    // Uma underwrites every world with 5 WETH and 20,000 USDC.
    const deposit = { wnear: wad("5"), usdc: wad("20000") };
    const adds = pools[S2X2].map((p) => addLiquidity(p, deposit.wnear, deposit.usdc));
    pools[S2X2] = pools[S2X2].map((p, i) => ({ ...p, x: p.x + adds[i].keptWnear, y: p.y + adds[i].keptUsdc, t: p.t + adds[i].liquidity }));
    const backWnear = adds.map((a) => deposit.wnear - a.keptWnear);
    const backUsdc = adds.map((a) => deposit.usdc - a.keptUsdc);
    const min = (xs: bigint[]) => xs.reduce((m, x) => (x < m ? x : m));
    const realWnear = min(backWnear);
    const realUsdc = min(backUsdc);
    uma.wallet = { wnear: realWnear, usdc: usdcUnits(realUsdc) };
    uma.verse[S2X2] = { wnear: backWnear.map((b) => b - realWnear), usdc: backUsdc.map((b) => b - realUsdc) };
    const liquidity = adds.map((a) => a.liquidity);
    const supply = min(liquidity);
    vault[S2X2] = { supply, liquidity, fees: liquidity.map(() => ({ wnear: 0n, usdc: 0n })) };
    uma.lpShares[S2X2] = supply - 1000n;
  }

  if (reached(stage, "pushed")) {
    // Carl hedges only SHIPS·CUTS and borrows close to the limit; then the operator pushes DELAYED·HOLDS down.
    const p = pools[S2X2];
    const sale = sellInto(p[0], wad("2"), 15000n);
    pools[S2X2][0] = sale.pool;
    carl.wallet.wnear = 0n;
    carl.collateral[S2X2] = [
      { asset: "usdc", mask: 1, amount: sale.out },
      { asset: "wnear", mask: 2, amount: wad("2") },
      { asset: "wnear", mask: 4, amount: wad("2") },
      { asset: "wnear", mask: 8, amount: wad("2") },
    ];
    const dhBefore = priceOf(pools[S2X2][3]);
    const cmin = (wad("2") * dhBefore) / E18;
    const borrow = ((((cmin * 75n) / 100n) * 100n) / 106n / E18) * E18;
    carl.debt[S2X2] = borrow;
    carl.wallet.usdc = usdcUnits(borrow);
    market[S2X2].borrow += borrow;
    impact[S2X2].push({ at_sec: now - 300, prices: pricesOf(pools[S2X2], 15) });

    const push = sellInto(pools[S2X2][3], wad("3"), 15000n);
    const fee = (wad("3") * 15000n) / 1_000_000n;
    pools[S2X2][3] = push.pool;
    accounts.owner.wallet.wnear = 0n;
    accounts.owner.verse[S2X2].usdc[3] += push.out;
    for (const w of [0, 1, 2]) accounts.owner.verse[S2X2].wnear[w] += wad("3");
    impact[S2X2].push({ at_sec: now - 240, prices: pricesOf(pools[S2X2], 15) });
    const v = vault[S2X2];
    if (v) v.fees[3] = { wnear: (fee * v.liquidity[3]) / pools[S2X2][3].t, usdc: 0n };
  }

  const possible = { [S2X2]: 15, [SBIN]: 3 };
  const resolutionCount = { [S2X2]: 0, [SBIN]: 0 };
  if (reached(stage, "fed")) {
    possible[S2X2] = 0b1100;
    resolutionCount[S2X2] = 1;
  }
  if (reached(stage, "collapsed")) {
    possible[S2X2] = 0b1000;
    resolutionCount[S2X2] = 2;
    possible[SBIN] = 0b10;
    resolutionCount[SBIN] = 1;
  }
  const halted = { [S2X2]: stage === "proposed", [SBIN]: false };

  const events: Record<number, EventViewJson> = {};
  for (const id of [1, 2, 3]) {
    events[id] = { ...EVENTS[id], proposed_at_sec: 0, proposed_outcome: 0, proposal_open: false, finalized: false, outcome: 0, finalizable_at_sec: 0, proposed_by: null };
  }
  if (reached(stage, "sold")) {
    // The resolver has already settled the past meeting from FRED: both limits unchanged, so HOLDS.
    events[3] = { ...events[3], proposed_at_sec: SEEDED_AT + 3600, proposed_outcome: 1, finalized: true, outcome: 1, proposed_by: "reporter" };
  }
  if (stage === "proposed") {
    events[2] = { ...events[2], proposed_at_sec: now - 9, proposed_outcome: 1, proposal_open: true, finalizable_at_sec: now - 9 + 30, proposed_by: "reporter" };
  }
  if (reached(stage, "fed")) {
    events[2] = { ...events[2], proposed_at_sec: now - 400, proposed_outcome: 1, finalized: true, outcome: 1, proposed_by: "reporter" };
  }
  if (reached(stage, "collapsed")) {
    events[1] = { ...events[1], proposed_at_sec: now - 120, proposed_outcome: 1, finalized: true, outcome: 1, proposed_by: "reporter" };
  }

  return { stage, now, pools, possible, resolutionCount, halted, impact, book, accounts, events, vault, market };
}

const ODDS_SHARE = { cuts: CUTS_BPS * 10n ** 14n, ships: SHIPS_BPS * 10n ** 14n };

/** The odds tree of the lens: parents first, mass[y] = parent − mass[x] so the live worlds sum to exactly 1e18. */
export function oddsOf(sid: number, possible: number): bigint[] {
  const live = (m: number) => (m & possible) !== 0;
  const mass = new Map<number, bigint>();
  const pairs: [number, number, bigint][] =
    sid === S2X2
      ? [
          [0x3, 0xc, ODDS_SHARE.cuts],
          [0x1, 0x2, ODDS_SHARE.ships],
          [0x4, 0x8, ODDS_SHARE.ships],
        ]
      : [[0x1, 0x2, ODDS_SHARE.ships]];
  const root = sid === S2X2 ? 0xf : 0x3;
  mass.set(root, E18);
  for (const [x, y, shareX] of pairs) {
    const parent = mass.get(x | y) ?? 0n;
    const share = !live(x) || !live(y) ? (live(x) ? E18 : 0n) : shareX;
    const mx = (parent * share) / E18;
    mass.set(x, mx);
    mass.set(y, parent - mx);
  }
  const n = sid === S2X2 ? 4 : 2;
  return Array.from({ length: n }, (_, w) => (live(1 << w) ? (mass.get(1 << w) ?? 0n) : 0n));
}

export function scenarioJson(world: FixtureWorld, sid: number, persona: Persona | undefined): ScenarioViewJson {
  const pools = world.pools[sid];
  const possible = world.possible[sid];
  const q = oddsOf(sid, possible);
  const me = persona ? world.accounts[persona] : undefined;
  const coll = me?.collateral[sid] ?? [];
  const worlds: WorldViewJson[] = pools.map((p, w) => {
    const mask = 1 << w;
    const inWorld = (asset: "wnear" | "usdc") => coll.filter((c) => c.asset === asset && !c.real && (c.mask & mask) !== 0).reduce((s, c) => s + c.amount, 0n);
    return {
      index: w,
      mask,
      label: LABELS[sid][w],
      possible: (possible & mask) !== 0,
      pool_initialized: true,
      wnear_price: priceOf(p).toString(),
      backed: true,
      wnear_token_id: `${sid}:wnear:${mask}`,
      usdc_token_id: `${sid}:usdc:${mask}`,
      user_wnear: (me?.verse[sid].wnear[w] ?? 0n).toString(),
      user_usdc: (me?.verse[sid].usdc[w] ?? 0n).toString(),
      collateral_wnear: inWorld("wnear").toString(),
      collateral_usdc: inWorld("usdc").toString(),
      odds: q[w].toString(),
      pool_id: sid * 10 + w,
    };
  });
  const implied = worlds.filter((w) => w.possible).reduce((s, w) => s + (BigInt(w.odds) * BigInt(w.wnear_price)) / E18, 0n);
  return {
    scenario_id: sid,
    world_count: pools.length,
    possible,
    resolution_count: world.resolutionCount[sid],
    halted: world.halted[sid],
    event_ids: EVENTS_OF[sid],
    spot_price: SPOT.toString(),
    worlds,
    odds_known: true,
    implied_spot: implied.toString(),
  };
}

export const eventsJson = (world: FixtureWorld, sid: number): EventViewJson[] => EVENTS_OF[sid].map((id) => world.events[id]);

export function ordersJson(world: FixtureWorld, sid: number): OrderViewJson[] {
  return world.book.orders.filter((o) => o.scenario_id === sid && BigInt(o.remaining) > 0n);
}

export function accountJson(world: FixtureWorld, sid: number, persona: Persona | undefined): AccountViewJson {
  const me = persona ? world.accounts[persona] : undefined;
  const pools = world.pools[sid];
  const possible = world.possible[sid];
  const coll = me?.collateral[sid] ?? [];
  const values = pools.map((p, w) => {
    const mask = 1 << w;
    if ((possible & mask) === 0) return 0n;
    return coll
      .filter((c) => c.real || (c.mask & mask) !== 0)
      .reduce((s, c) => s + (c.asset === "usdc" ? c.amount : (c.amount * priceOf(p)) / E18), 0n);
  });
  const liveIdx = values.map((_, i) => i).filter((i) => (possible >> i) & 1);
  const worst = liveIdx.reduce((best, i) => (best === -1 || values[i] < values[best] ? i : best), -1);
  const debt = me?.debt[sid] ?? 0n;
  const hf = debt > 0n && worst >= 0 ? (values[worst] * LLTV) / debt : null;
  const m = world.market[sid];
  const util = m.supply === 0n ? 0n : (m.borrow * E18) / m.supply;
  const supplied = me?.supplied[sid];
  let liquidation: AccountViewJson["liquidation"] = "none";
  if (hf !== null && hf < E18) liquidation = world.halted[sid] ? "paused_halted" : "liquidatable";
  return {
    debt: debt.toString(),
    health_factor: hf === null ? null : hf.toString(),
    worst_world: worst >= 0 ? worst : null,
    collateral_values: values.map(String),
    world_price_ok: pools.map(() => true),
    collateral: coll.map((c) => ({
      token_id: c.real ? c.asset : `${sid}:${c.asset}:${c.mask}`,
      label: c.real ? c.asset.toUpperCase() : `${c.asset.toUpperCase()}-if-${labelOf(sid, c.mask)}`,
      asset: c.asset,
      mask: c.real ? (sid === S2X2 ? 15 : 3) : c.mask,
      is_real: Boolean(c.real),
      amount: c.amount.toString(),
    })),
    supplied: (supplied?.amount ?? 0n).toString(),
    supply_principal: (supplied?.principal ?? 0n).toString(),
    market_supply: m.supply.toString(),
    market_borrow: m.borrow.toString(),
    utilization: util.toString(),
    borrow_rate_per_sec: BORROW_RATE.toString(),
    supply_rate_per_sec: ((BORROW_RATE * util) / E18).toString(),
    lltv: LLTV.toString(),
    liquidation,
    unpriced_world: null,
  };
}

function labelOf(sid: number, mask: number): string {
  const singles = LABELS[sid].filter((_, w) => (mask >> w) & 1);
  return singles.length === 1 ? singles[0] : `0b${mask.toString(2)}`;
}

export function rootLpJson(world: FixtureWorld, sid: number, persona: Persona | undefined): RootLpViewJson | null {
  const v = world.vault[sid];
  const pools = world.pools[sid];
  const possible = world.possible[sid];
  const shares = persona ? (world.accounts[persona].lpShares[sid] ?? 0n) : 0n;
  if (!v) return { share_supply: "0", your_shares: shares.toString(), share_decimals: 18, preview_withdraw: null, holdings: [] };
  const live = pools.map((_, i) => i).filter((i) => (possible >> i) & 1);
  const claim = (i: number, side: "x" | "y") => {
    const p = pools[i];
    const inPool = (((shares * v.liquidity[i]) / v.supply) * (side === "x" ? p.x : p.y)) / p.t;
    const fee = (shares * (side === "x" ? v.fees[i].wnear : v.fees[i].usdc)) / v.supply;
    return inPool + fee;
  };
  return {
    share_supply: v.supply.toString(),
    your_shares: shares.toString(),
    share_decimals: 18,
    preview_withdraw:
      shares > 0n
        ? { wnear: pools.map((_, i) => ((possible >> i) & 1 ? claim(i, "x") : 0n).toString()), usdc: pools.map((_, i) => ((possible >> i) & 1 ? claim(i, "y") : 0n).toString()) }
        : null,
    holdings: live.map((i) => ({ world: i, wnear_idle: "0", usdc_idle: "0", wnear_fees: v.fees[i].wnear.toString(), usdc_fees: v.fees[i].usdc.toString() })),
  };
}

/** What a new Root LP deposit would buy: per live world, the pool keeps what fits its price; shares from the
 *  smallest world, less the 1,000 locked forever on the first deposit. */
export function previewLp(world: FixtureWorld, sid: number, wnear: bigint, usdc: bigint) {
  if (wnear === 0n || usdc === 0n) throw new Error("ZeroAmount");
  const pools = world.pools[sid];
  const possible = world.possible[sid];
  const v = world.vault[sid];
  const adds = pools.map((p, i) => ((possible >> i) & 1 ? addLiquidity(p, wnear, usdc) : undefined));
  const liquidity = adds.filter((a): a is NonNullable<typeof a> => a !== undefined).map((a) => a.liquidity);
  const minL = liquidity.reduce((m, x) => (x < m ? x : m));
  const shares = v ? (minL * v.supply) / (v.liquidity.reduce((m, x) => (x < m ? x : m)) || 1n) : minL - 1000n;
  if (shares <= 0n || minL <= 1000n) throw new Error("DepositTooSmall");
  return {
    shares: shares.toString(),
    wnear_kept: adds.map((a) => (a ? a.keptWnear : 0n).toString()),
    usdc_kept: adds.map((a) => (a ? a.keptUsdc : 0n).toString()),
  };
}

export function appConfig(): AppConfigView {
  return {
    owner_id: ROOT_ACCOUNT,
    reporter_id: `resolver.${ROOT_ACCOUNT}`,
    wnear: { token_id: FIXTURE_IDS.wnear, decimals: 18, symbol: "WETH" },
    usdc: { token_id: FIXTURE_IDS.usdc, decimals: 6, symbol: "USDC" },
    lltv: LLTV.toString(),
    liquidation_bonus: wad("0.05").toString(),
    borrow_rate_per_sec: BORROW_RATE.toString(),
    dispute_window_sec: 30,
    twap_window_sec: 60,
    min_pool_depth: wad("10000").toString(),
    fee_base_pips: 3000,
    fee_cap_pips: 10000,
    order_book: true,
    root_lp: true,
    spot_pool_id: 0,
    event_count: 3,
    scenario_count: 2,
    demo: {
      spice_event: 1,
      fed_event: 2,
      past_fed_event: 3,
      scenario_2x2: S2X2,
      scenario_binary: SBIN,
      implied_spot: SPOT.toString(),
      odds_ships_bps: Number(SHIPS_BPS),
      odds_cuts_bps: Number(CUTS_BPS),
      odds_source: "Fed: Polymarket fed-decision-in-december at 2026-11-11T09:00Z",
      seeded_at_sec: SEEDED_AT,
      spot_from: "2x2",
    },
  };
}

export const poolJson = (world: FixtureWorld, poolId: number) => {
  const sid = Math.floor(poolId / 10);
  const p = world.pools[sid]?.[poolId % 10];
  if (!p) throw new Error(`UnknownPool(${poolId})`);
  const price = priceOf(p).toString();
  const json: PoolViewJson = {
    id: poolId,
    kind: "within",
    scenario_id: sid,
    world: poolId % 10,
    mask0: 1 << poolId % 10,
    mask1: 1 << poolId % 10,
    token0: "",
    token1: "",
    reserve0: p.x.toString(),
    reserve1: p.y.toString(),
    wnear_reserve: p.x.toString(),
    usdc_reserve: p.y.toString(),
    liquidity: "0",
    fees0: "0",
    fees1: "0",
    fee_pips: Number(p.feePips),
    swap_count: 0,
    price,
    twap_price: price,
    twap_ok: true,
  };
  return json;
};

export { S2X2 as FIXTURE_SCENARIO_2X2, SBIN as FIXTURE_SCENARIO_BINARY };
