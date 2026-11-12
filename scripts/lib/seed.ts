// Seeds the demo on a deployed contract: the three events, the 2x2 and binary scenarios, every
// world pool, the odds pools, the spot pool (or a move of the existing one), Bob's supply, Ravi's
// bid and Alice's wallet, then the on-chain demo record. Each run creates fresh events and
// scenarios, so a reset is just another seed.

import { chainHeight, chainNowSec } from "./chain.ts";
import {
  ALICE_USDC,
  ALICE_WNEAR,
  BOB_SUPPLY,
  checkBps,
  DEMO_EVENTS,
  fmt2,
  fmt4,
  fmtDiff,
  fmtOdds,
  independentOdds,
  MASK_DELAYED_HOLDS,
  ODDS_POOL_DEPTH,
  oddsPairs,
  orderCost,
  planSpotMove,
  RAVI_BID_WNEAR,
  RAVI_EXPIRY_SEC,
  raviBidPrice,
  SALE_WNEAR,
  SEED_2X2,
  SEED_BINARY,
  seedReserves,
  singles,
  SPOT_DEPTH,
  sumOver,
  wmul,
  type WorldSeed,
} from "./demo.ts";
import { NETWORK } from "./near.ts";
import { OWNER_STORAGE, Protocol, type DemoRecord } from "./protocol.ts";
import { roundDownToStep, roundUpToStep, u128, WAD } from "./units.ts";

export interface SeedOptions {
  shipsBps: number;
  cutsBps: number;
  oddsSource: string;
  spotFrom: "2x2" | "binary";
  withRavi: boolean;
}

async function createEvents(p: Protocol, owner: string): Promise<Record<"glam" | "fed" | "pastFed", number>> {
  const ids: Partial<Record<"glam" | "fed" | "pastFed", number>> = {};
  for (const e of DEMO_EVENTS) {
    const r = await p.call1y<number>(owner, "create_event", {
      question: e.question,
      outcome_names: e.outcomeNames,
      rule: e.rule,
      deadline_sec: e.deadlineSec,
    }, `create_event ${e.key}`);
    if (typeof r.value !== "number") throw new Error(`create_event ${e.key} returned ${r.returnText}`);
    ids[e.key] = r.value;
  }
  return ids as Record<"glam" | "fed" | "pastFed", number>;
}

async function createScenario(p: Protocol, owner: string, eventIds: number[]): Promise<number> {
  const r = await p.call1y<number>(owner, "create_scenario", { event_ids: eventIds }, `create_scenario [${eventIds.join(", ")}]`);
  if (typeof r.value !== "number") throw new Error(`create_scenario returned ${r.returnText}`);
  return r.value;
}

/** Splits enough of both assets into every world, then opens each world's pool at its price. */
async function seedWorlds(p: Protocol, owner: string, sid: number, seeds: readonly WorldSeed[]): Promise<void> {
  const maxWnear = seeds.reduce((m, s) => (s.depth > m ? s.depth : m), 0n);
  const maxUsdc = roundUpToStep(
    seeds.reduce((m, s) => (wmul(s.depth, s.price) > m ? wmul(s.depth, s.price) : m), 0n),
    p.decimals("usdc"),
  );
  const masks = singles(seeds.length);
  await p.mintAndSplit(owner, owner, "wnear", sid, masks, maxWnear);
  await p.mintAndSplit(owner, owner, "usdc", sid, masks, maxUsdc);
  for (const [w, s] of seeds.entries()) {
    await p.call1y(owner, "create_within_pool", {
      scenario_id: sid,
      world: w,
      wnear_amount: s.depth.toString(),
      usdc_amount: wmul(s.depth, s.price).toString(),
    }, `create_within_pool s${sid} w${w}`);
  }
}

/** One odds pool per pair of the tree, the less likely side `ODDS_POOL_DEPTH` deep. */
async function seedOdds(p: Protocol, owner: string, sid: number, q: bigint[]): Promise<void> {
  const root = (1 << q.length) - 1;
  for (const [x, y] of oddsPairs(q.length)) {
    const rest = root & ~(x | y);
    await p.mintAndSplit(owner, owner, "usdc", sid, rest ? [x, y, rest] : [x, y], ODDS_POOL_DEPTH);
    const [ax, ay] = seedReserves(sumOver(q, x), sumOver(q, y), ODDS_POOL_DEPTH);
    await p.call1y(owner, "create_between_pool", {
      scenario_id: sid,
      mask_x: x,
      mask_y: y,
      amount_x: ax.toString(),
      amount_y: ay.toString(),
    }, `create_between_pool s${sid} ${x}/${y}`);
  }
}

/** Opens the spot pool at `implied`, or moves the existing one there with a single swap. */
async function seedSpot(p: Protocol, owner: string, implied: bigint): Promise<"seeded" | "moved"> {
  if (implied === 0n) throw new Error("the implied spot is 0: a pool or the odds are missing");
  const spot = await p.spotPool();
  if (spot === null) {
    const usdc = roundDownToStep(wmul(SPOT_DEPTH, implied), p.decimals("usdc"));
    await p.mint(owner, "wnear", owner, SPOT_DEPTH);
    await p.send(owner, "wnear", SPOT_DEPTH, { action: "deposit" });
    await p.mint(owner, "usdc", owner, usdc);
    await p.send(owner, "usdc", usdc, { action: "deposit" });
    await p.call1y(owner, "create_spot_pool", { wnear_amount: SPOT_DEPTH.toString(), usdc_amount: usdc.toString() }, "create_spot_pool");
    return "seeded";
  }
  const plan = planSpotMove(u128(spot.reserve0), u128(spot.reserve1), implied);
  if (plan) {
    const asset = plan.wnearIn ? "wnear" : "usdc";
    // a little over the estimate; what is left stays in the owner's internal balance for the next move
    const want = roundUpToStep((plan.amountIn * 101n) / 100n, p.decimals(asset));
    const have = await p.realBalance(owner, asset);
    if (have < want) {
      const top = roundUpToStep(want - have, p.decimals(asset));
      await p.mint(owner, asset, owner, top);
      await p.send(owner, asset, top, { action: "deposit" });
    }
  }
  await p.call1y(owner, "move_spot_to", { price: implied.toString() }, `move_spot_to ${fmt4(implied)}`);
  return "moved";
}

/** Ravi's bid 2% under the DELAYED·HOLDS pool price for 1,000 NEAR, from real USDC split around the mask. */
async function postRaviBid(p: Protocol, owner: string, sid: number): Promise<string> {
  const ravi = p.d.personas.ravi;
  const poolPrice = SEED_2X2[3]?.price ?? 0n;
  const price = raviBidPrice(poolPrice);
  const escrow = roundUpToStep(orderCost(RAVI_BID_WNEAR, price), p.decimals("usdc"));
  const others = singles(SEED_2X2.length).filter((m) => m !== MASK_DELAYED_HOLDS);
  await p.mintAndSplit(owner, ravi, "usdc", sid, [MASK_DELAYED_HOLDS, ...others], escrow);
  const expiry = (await chainNowSec()) + RAVI_EXPIRY_SEC;
  const r = await p.call1y<string>(ravi, "post_order", {
    scenario_id: sid,
    mask: MASK_DELAYED_HOLDS,
    side: "bid",
    price: price.toString(),
    amount: RAVI_BID_WNEAR.toString(),
    expiry_sec: expiry,
  }, `ravi: post_order bid ${fmt4(price)} for ${fmt2(RAVI_BID_WNEAR)} NEAR`);
  if (typeof r.value !== "string") throw new Error(`post_order returned ${r.returnText}`);
  return r.value;
}

export async function seedDemo(p: Protocol, o: SeedOptions): Promise<DemoRecord> {
  checkBps(o.shipsBps, "ODDS_SHIPS_BPS");
  checkBps(o.cutsBps, "ODDS_CUTS_BPS");
  const owner = p.d.root;
  const { alice, bob, ravi } = p.d.personas;

  console.log("storage");
  await p.ensureStorage(owner, owner, OWNER_STORAGE);
  for (const who of [alice, bob, ravi]) await p.ensureStorage(owner, who);

  console.log("events and scenarios");
  const ev = await createEvents(p, owner);
  const s2x2 = await createScenario(p, owner, [ev.glam, ev.fed]);
  const sBin = await createScenario(p, owner, [ev.glam]);

  console.log("world pools");
  await seedWorlds(p, owner, s2x2, SEED_2X2);
  await seedWorlds(p, owner, sBin, SEED_BINARY);

  console.log("odds pools");
  await seedOdds(p, owner, s2x2, independentOdds(4, o.shipsBps, o.cutsBps));
  await seedOdds(p, owner, sBin, independentOdds(2, o.shipsBps, o.cutsBps));

  console.log("spot pool");
  const implied = await p.impliedSpot(o.spotFrom === "binary" ? sBin : s2x2);
  const spotAction = await seedSpot(p, owner, implied);

  console.log("wallets and supply");
  await p.mint(owner, "wnear", alice, ALICE_WNEAR);
  await p.mint(owner, "usdc", alice, ALICE_USDC);
  await p.mint(owner, "usdc", bob, 2n * BOB_SUPPLY);
  for (const sid of [s2x2, sBin]) await p.send(bob, "usdc", BOB_SUPPLY, { action: "supply", scenario_id: sid });

  let raviOrder: string | null = null;
  if (o.withRavi) {
    console.log("Ravi's bid");
    raviOrder = await postRaviBid(p, owner, s2x2);
  }

  const record: DemoRecord = {
    glam_event: ev.glam,
    fed_event: ev.fed,
    past_fed_event: ev.pastFed,
    scenario_2x2: s2x2,
    scenario_binary: sBin,
    implied_spot: implied.toString(),
    odds_ships_bps: o.shipsBps,
    odds_cuts_bps: o.cutsBps,
    odds_source: o.oddsSource,
    seeded_at_sec: await chainNowSec(),
    seeded_block: await chainHeight(),
    spot_from: o.spotFrom,
    ravi_order: raviOrder,
  };
  await p.call1y(owner, "set_demo_record", { json: JSON.stringify(record) }, "set_demo_record");
  console.log(`spot pool ${spotAction === "seeded" ? "seeded" : "moved"} to the ${o.spotFrom} implied spot`);
  return record;
}

async function scenarioLines(p: Protocol, sid: number, seeds: readonly WorldSeed[]): Promise<string[]> {
  const alice = p.d.personas.alice;
  const pools = await p.worldPools(sid);
  const { q, known } = await p.odds(sid);
  const lines: string[] = [];
  for (let w = 0; w < seeds.length; w++) {
    const mask = 1 << w;
    const pool = pools.get(w);
    const price = pool ? fmt2(u128(pool.price)) : "n/a";
    const odds = known ? fmtOdds(q[w] ?? 0n) : "n/a";
    const wnear = await p.verseBalance(alice, sid, "wnear", mask);
    const usdc = await p.verseBalance(alice, sid, "usdc", mask);
    lines.push(
      `world ${w} ${await p.label(sid, mask)}: pool price ${price} | odds ${odds} | Alice holds wNEAR-if-w ${fmt2(wnear)}, USDC-if-w ${fmt2(usdc)}`,
    );
  }
  const implied = await p.impliedSpot(sid);
  const spot = await p.spotPrice();
  lines.push(
    implied === 0n
      ? `implied spot n/a (odds unknown, or a pool is missing) | actual spot ${fmt4(spot)}`
      : `implied spot ${fmt4(implied)} | actual spot ${fmt4(spot)} | difference ${fmtDiff(implied, spot, 4)}`,
  );
  return lines;
}

/** Pool-only and bid-then-pool proceeds of the 2,000 NEAR DELAYED·HOLDS sale, and whether the bid helps. */
export async function raviPlan(p: Protocol, sid: number, orderId: string | null): Promise<{
  poolOnly: bigint;
  withBid: bigint;
  fill: bigint;
  price: bigint;
  open: boolean;
}> {
  const poolOnly = (await p.quoteSell(sid, SALE_WNEAR, MASK_DELAYED_HOLDS))[3] ?? 0n;
  const order = orderId ? await p.order(orderId) : null;
  if (!order) return { poolOnly, withBid: 0n, fill: 0n, price: 0n, open: false };
  const scenario = await p.scenario(sid);
  const remaining = u128(order.remaining);
  const open = remaining !== 0n && order.epoch === scenario.resolution_count && (await chainNowSec()) < order.expiry_sec;
  const fill = remaining < SALE_WNEAR ? remaining : SALE_WNEAR;
  const price = u128(order.price);
  const rest = SALE_WNEAR > fill ? ((await p.quoteSell(sid, SALE_WNEAR - fill, MASK_DELAYED_HOLDS))[3] ?? 0n) : 0n;
  return { poolOnly, withBid: (fill * price) / WAD + rest, fill, price, open };
}

export async function printSeedReport(p: Protocol, record: DemoRecord): Promise<void> {
  const s2x2 = record.scenario_2x2;
  const sBin = record.scenario_binary;
  console.log("");
  console.log(`network: ${NETWORK}`);
  console.log(`spot pool at the ${record.spot_from} implied spot (USDC per NEAR): ${fmt4(await p.spotPrice())}`);
  console.log(`odds: SHIPS ${record.odds_ships_bps} bps, CUTS ${record.odds_cuts_bps} bps (${record.odds_source ?? "no source"})`);
  console.log(`Bob supplied USDC to each market: ${fmt2(BOB_SUPPLY)}`);
  console.log("");
  console.log(`== 2x2 scenario (Glamsterdam x Fed), scenario ${s2x2}`);
  for (const line of await scenarioLines(p, s2x2, SEED_2X2)) console.log(line);
  console.log("");
  console.log(`== binary scenario (Glamsterdam), scenario ${sBin}`);
  for (const line of await scenarioLines(p, sBin, SEED_BINARY)) console.log(line);
  console.log("");
  console.log(`== Ravi's standing bid in DELAYED·HOLDS (scenario ${s2x2})`);
  if (!record.ravi_order) {
    console.log("no standing bid for Ravi");
  } else {
    const order = await p.order(record.ravi_order);
    if (order) console.log(`order ${order.id}: ${order.side} ${fmt4(u128(order.price))} USDC per NEAR for ${fmt2(u128(order.amount))} NEAR`);
    const plan = await raviPlan(p, s2x2, record.ravi_order);
    console.log(`2,000 NEAR sale, pool alone: ${fmt2(plan.poolOnly)} USDC, average ${fmt4((plan.poolOnly * WAD) / SALE_WNEAR)}`);
    console.log(`2,000 NEAR sale, Ravi's bid then the pool: ${fmt2(plan.withBid)} USDC, average ${fmt4((plan.withBid * WAD) / SALE_WNEAR)}`);
    if (plan.withBid <= plan.poolOnly) console.log("WARNING: the pool alone pays more, so the router would not use Ravi's bid");
  }
  console.log(`events: glam ${record.glam_event}, fed ${record.fed_event}, past fed ${record.past_fed_event ?? "-"}`);
}
