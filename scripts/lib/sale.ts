// Alice's demo sale: 2 NEAR sold in the L-shape of the 2x2 (DELAYED or HOLDS) through Ravi's bid
// and the pools, and 2 wNEAR-if-DELAYED in the binary, each with a 3,000 USDC loan, one
// ft_transfer_call per scenario. Run once the pools are old enough to price lending
// (twap_min_age_sec after seeding); until a full window has passed the TWAP is their whole history.

import { chainNowSec, waitForChainTime } from "./chain.ts";
import {
  BORROW_USDC,
  fmt2,
  fmtHf,
  MASK_BIN_DELAYED,
  MASK_L_SHAPE,
  SALE_WNEAR,
  wmul,
} from "./demo.ts";
import { NETWORK } from "./near.ts";
import { pieceCovers, Protocol, type DemoRecord } from "./protocol.ts";
import { raviPlan } from "./seed.ts";
import { u128 } from "./units.ts";

export type PlanFill = { order_id: string; amount: string };

/** The sale plan for the 2x2: Ravi's bid first in DELAYED·HOLDS when it pays more than the pool alone. */
export async function plan2x2(p: Protocol, record: DemoRecord): Promise<PlanFill[][]> {
  const plans: PlanFill[][] = [[], [], [], []];
  if (!record.ravi_order) return plans;
  const r = await raviPlan(p, record.scenario_2x2, record.ravi_order);
  if (!r.open) {
    console.log(`Ravi's bid (order ${record.ravi_order}) is no longer open; the pool takes the whole sale`);
    return plans;
  }
  console.log(
    `DELAYED·HOLDS plan: Ravi's bid (order ${record.ravi_order}) ${fmt2(r.fill)} NEAR at ${fmt2(r.price)}, ` +
      `then the pool: ${fmt2(r.withBid)} USDC; pool alone: ${fmt2(r.poolOnly)}`,
  );
  if (r.withBid > r.poolOnly) plans[3] = [{ order_id: record.ravi_order, amount: r.fill.toString() }];
  return plans;
}

/**
 * Waits until every world pool of both scenarios is old enough for lending to use its TWAP. Both
 * lengths come from get_app_config. Nothing has traded in the pools since seeding, so their whole
 * history, which is what the TWAP averages until a full window has passed, is the seeded price.
 */
export async function waitForTwap(p: Protocol, record: DemoRecord): Promise<void> {
  const { twap_min_age_sec, twap_window_sec } = await p.appConfig();
  await waitForChainTime(
    record.seeded_at_sec + Math.min(twap_min_age_sec, twap_window_sec) + 1,
    `the pools to be old enough to price lending (TWAP window ${twap_window_sec} s, priced after ${twap_min_age_sec} s)`,
  );
}

export async function sellAndBorrow(p: Protocol, record: DemoRecord): Promise<void> {
  const alice = p.d.personas.alice;
  await p.ensureStorage(p.d.root, alice);
  // her two "stage" NEAR stay untouched; these four are for the two sales
  await p.mint(p.d.root, "wnear", alice, 2n * SALE_WNEAR);
  const plans = await plan2x2(p, record);
  const sales: [number, number, PlanFill[][]][] = [
    [record.scenario_2x2, MASK_L_SHAPE, plans],
    [record.scenario_binary, MASK_BIN_DELAYED, [[], []]],
  ];
  for (const [sid, mask, plan] of sales) {
    await p.send(alice, "wnear", SALE_WNEAR, {
      action: "sell_and_borrow",
      scenario_id: sid,
      sell_mask: mask,
      plans: plan,
      min_out: plan.map(() => "0"),
      borrow_amount: BORROW_USDC.toString(),
    }, { label: `alice: sell_and_borrow s${sid} mask ${mask}` });
  }
}

async function scenarioReport(p: Protocol, sid: number, title: string): Promise<void> {
  const alice = p.d.personas.alice;
  const s = await p.scenario(sid);
  const pools = await p.worldPools(sid);
  const pieces = await p.collateral(sid, alice);
  const values = await p.collateralValues(sid, alice);
  const { hf, worst } = await p.health(sid, alice);
  const { lltv } = await p.appConfig();
  console.log("");
  console.log(`== ${title} and borrowed ${fmt2(await p.debt(sid, alice))} USDC (scenario ${sid})`);
  for (let w = 0; w < s.world_count; w++) {
    let wnear = 0n;
    let usdc = 0n;
    for (const piece of pieces) {
      const c = pieceCovers(piece.piece, w);
      if (!c.covers) continue;
      if (c.asset === "wnear") wnear += u128(piece.amount);
      else usdc += u128(piece.amount);
    }
    const twap = pools.get(w)?.twap_price;
    console.log(
      `world ${w} ${await p.label(sid, 1 << w)}: wNEAR-if-w ${fmt2(wnear)}, USDC-if-w ${fmt2(usdc)} | ` +
        `collateral value ${fmt2(values[w] ?? 0n)} | TWAP price ${twap ? fmt2(u128(twap)) : "n/a"}`,
    );
  }
  const worstValue = worst === null ? 0n : (values[worst] ?? 0n);
  const worstLabel = worst === null ? "n/a" : await p.label(sid, 1 << worst);
  console.log(`worst world: ${worstLabel} | HF ${fmtHf(hf)} | max borrow at HF 1: ${fmt2(wmul(worstValue, u128(lltv)))}`);
}

export async function printSaleReport(p: Protocol, record: DemoRecord): Promise<void> {
  console.log("");
  console.log(`network: ${NETWORK} (block time ${await chainNowSec()})`);
  await scenarioReport(p, record.scenario_2x2, "2x2: Alice sold 2 NEAR in the L-shape (DELAYED or HOLDS)");
  await scenarioReport(p, record.scenario_binary, "binary: Alice sold 2 NEAR-if-DELAYED");
  const dh = (await p.worldPools(record.scenario_2x2)).get(3);
  if (dh) console.log(`DELAYED·HOLDS pool price after the sale: ${fmt2(u128(dh.price))}`);
}
