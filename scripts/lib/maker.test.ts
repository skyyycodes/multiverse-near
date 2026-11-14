// The maker's decision (inside the band, a move, too far) and its sizing: each world pool lands on
// price x reference / implied under the contract's own CPMM maths and each pool's fee, so the
// implied spot meets the reference; min_out and the split shortfall.

import assert from "node:assert/strict";
import { test } from "node:test";

import { makerPools, offBps, planMaker, splitNeed, swapOut, type MakerPool, type PoolRow } from "./maker.ts";

const WAD = 10n ** 18n;
const e18 = (n: bigint): bigint => n * WAD;
const cents = (n: bigint): bigint => (n * WAD) / 100n;

/** Two worlds at odds 0.6 / 0.4 priced 3.80 and 2.70 (implied 3.36), fees 1.5% and 0.43%. */
const ODDS = [(6n * WAD) / 10n, (4n * WAD) / 10n];
function pools(): MakerPool[] {
  const pool = (id: number, world: number, wnear: bigint, price: bigint, feePips: number): MakerPool => ({
    id,
    world,
    wnearToken: `1:wnear:${1 << world}`,
    usdcToken: `1:usdc:${1 << world}`,
    wnearReserve: wnear,
    usdcReserve: (wnear * price) / WAD,
    price,
    feePips,
  });
  return [pool(1, 0, e18(100_000n), cents(380n), 15_000), pool(2, 1, e18(60_000n), cents(270n), 4_306)];
}
const implied = (ps: MakerPool[]): bigint => ps.reduce((a, p, w) => a + ((ODDS[w] ?? 0n) * p.price) / WAD, 0n);

/** Applies a swap the way cpmm.rs does (fee out of the reserves) and reprices the pool. */
function apply(p: MakerPool, wnearIn: boolean, amountIn: bigint): MakerPool {
  const afterFee = (amountIn * (1_000_000n - BigInt(p.feePips))) / 1_000_000n;
  const [rin, rout] = wnearIn ? [p.wnearReserve, p.usdcReserve] : [p.usdcReserve, p.wnearReserve];
  const out = swapOut(rin, rout, amountIn, p.feePips);
  const [w, u] = wnearIn ? [p.wnearReserve + afterFee, p.usdcReserve - out] : [p.wnearReserve - out, p.usdcReserve + afterFee];
  return { ...p, wnearReserve: w, usdcReserve: u, price: (u * WAD) / w };
}

test("offBps is |reference / implied - 1|, rounded down", () => {
  assert.equal(offBps(cents(336n), cents(336n)), 0);
  assert.equal(offBps(cents(350n), cents(336n)), 416);
  assert.equal(offBps(cents(322n), cents(336n)), 416);
  assert.throws(() => offBps(cents(336n), 0n), /implied spot unknown/);
});

test("inside the band nothing moves; past the cap nothing moves either", () => {
  const ps = pools();
  const i = implied(ps);
  assert.equal(i, cents(336n));
  assert.deepEqual(planMaker(cents(349n), i, ps), { kind: "within", offBps: 386 });
  assert.equal(planMaker(cents(322n), i, ps).kind, "move");
  assert.equal(planMaker(cents(450n), i, ps).kind, "too_far");
  assert.equal(planMaker(cents(250n), i, ps).kind, "too_far");
  assert.equal(planMaker(cents(340n), i, ps, { thresholdBps: 50, maxBps: 10_000, slippageBps: 100 }).kind, "move");
});

for (const [name, ref] of [
  ["NEAR up 6%: USDC buys wNEAR in every world", (cents(336n) * 106n) / 100n],
  ["NEAR down 6%: wNEAR sells in every world", (cents(336n) * 94n) / 100n],
] as const) {
  test(`${name}; each pool lands on price x f with its own fee, the implied spot on the reference`, () => {
    const ps = pools();
    const plan = planMaker(ref, implied(ps), ps);
    assert.equal(plan.kind, "move");
    if (plan.kind !== "move") return;
    assert.equal(plan.moves.length, 2);
    const after = ps.map((p) => {
      const m = plan.moves.find((x) => x.poolId === p.id);
      assert.ok(m);
      assert.equal(m.wnearIn, ref < cents(336n));
      assert.equal(m.tokenIn, m.wnearIn ? p.wnearToken : p.usdcToken);
      const [rin, rout] = m.wnearIn ? [p.wnearReserve, p.usdcReserve] : [p.usdcReserve, p.wnearReserve];
      assert.equal(m.minOut, (swapOut(rin, rout, m.amountIn, p.feePips) * 9_900n) / 10_000n, "min_out = the quote less 1%");
      const q = apply(p, m.wnearIn, m.amountIn);
      assert.ok(offBps(m.to, q.price) === 0, `pool ${p.id} landed at ${q.price}, wanted ${m.to}`);
      return q;
    });
    assert.ok(offBps(ref, implied(after)) <= 1, `implied ${implied(after)} vs reference ${ref}`);
  });
}

test("ignoring the pool's fee would fall short: the 1.5% pool needs more input than at 0.3%", () => {
  const ps = pools();
  const ref = (cents(336n) * 106n) / 100n;
  const withFee = planMaker(ref, implied(ps), ps);
  const flat = planMaker(ref, implied(ps), ps.map((p) => ({ ...p, feePips: 3_000 })));
  assert.ok(withFee.kind === "move" && flat.kind === "move");
  assert.ok((withFee.moves[0]?.amountIn ?? 0n) > (flat.moves[0]?.amountIn ?? 0n));
});

test("splitNeed: the largest shortfall per asset after the verse balances, plus 2%; zero when covered", () => {
  const ps = pools();
  const plan = planMaker((cents(336n) * 106n) / 100n, implied(ps), ps);
  assert.ok(plan.kind === "move");
  const [a, b] = plan.moves;
  assert.ok(a && b && !a.wnearIn && !b.wnearIn);
  const big = a.amountIn > b.amountIn ? a.amountIn : b.amountIn;
  assert.deepEqual(splitNeed(plan.moves), { wnear: 0n, usdc: (big * 10_200n + 9_999n) / 10_000n });
  const have = new Map([[a.tokenIn, a.amountIn], [b.tokenIn, b.amountIn - e18(10n)]]);
  assert.deepEqual(splitNeed(plan.moves, (id) => have.get(id) ?? 0n), { wnear: 0n, usdc: (e18(10n) * 10_200n) / 10_000n });
  assert.deepEqual(splitNeed(plan.moves, () => e18(1_000_000n)), { wnear: 0n, usdc: 0n });
});

test("makerPools keeps the world pools of a pools_of answer and refuses an unexpected token order", () => {
  const row = (over: Partial<PoolRow>): PoolRow => ({
    id: 1,
    kind: "within",
    world: 0,
    token0: "1:wnear:1",
    token1: "1:usdc:1",
    wnear_reserve: "100",
    usdc_reserve: "300",
    price: "3000000000000000000",
    fee_pips: 3000,
    ...over,
  });
  const got = makerPools([row({}), row({ id: 5, kind: "between", world: null, wnear_reserve: null, usdc_reserve: null })]);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], { id: 1, world: 0, wnearToken: "1:wnear:1", usdcToken: "1:usdc:1", wnearReserve: 100n, usdcReserve: 300n, price: 3n * WAD, feePips: 3000 });
  assert.throws(() => makerPools([row({ token0: "1:usdc:1", token1: "1:wnear:1" })]), /is not wNEAR \/ USDC/);
});
