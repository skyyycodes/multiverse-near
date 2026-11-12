// The acceptance flow of the web app, as transactions: every step the UI walk-through takes, with
// the views checked after each one. On testnet every transaction prints its explorer link.
//
//   NEAR_NETWORK=sandbox|testnet pnpm e2e [--no-seed] [--allow-pending]
//
// It seeds a fresh demo first (pass --no-seed to use the current one) and resolves that demo's
// events at the end, so run it on a demo nobody is presenting. Steps that need a part of the
// contract this build lacks (it answers NotImplemented) are reported as pending, together with the
// steps that depend on them; the run exits non-zero unless --allow-pending.

import { join } from "node:path";
import { parseArgs } from "node:util";

import { chainNowSec, waitForChainTime } from "./lib/chain.ts";
import {
  BOOK_ASK_PRICE,
  BOOK_BID_PRICE,
  BOOK_SIZE_WNEAR,
  CARL_WNEAR,
  fmt2,
  fmt4,
  fmtHf,
  MASK_DELAYED_HOLDS,
  MASK_L_SHAPE,
  MASK_SHIPS_CUTS,
  ODDS_SHIPS_BPS,
  orderCost,
  PUSH_WNEAR,
  SALE_WNEAR,
  SEED_2X2,
  UMA_USDC,
  UMA_WNEAR,
  wmul,
} from "./lib/demo.ts";
import { requireDeployments } from "./lib/deployments.ts";
import { HOLDS } from "./lib/fred.ts";
import { call, NETWORK, REPO_ROOT, RPC_URL, TxFailedError } from "./lib/near.ts";
import { fedCutsOdds } from "./lib/polymarket.ts";
import { pieceCovers, Protocol, type DemoRecord, type OrderView } from "./lib/protocol.ts";
import { reporterDeps } from "./lib/reporter.ts";
import { resolveOnce, resolverEvents } from "./lib/resolver.ts";
import { plan2x2, waitForTwap } from "./lib/sale.ts";
import { seedDemo } from "./lib/seed.ts";
import { internalStep, tgas, u128, WAD } from "./lib/units.ts";

const { values: opts } = parseArgs({
  options: {
    "no-seed": { type: "boolean", default: false },
    "allow-pending": { type: "boolean", default: false },
  },
});

const e18 = (n: bigint): bigint => n * WAD;

class Pending extends Error {}

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`    ok: ${what}`);
}

/** Runs `task`, which must fail; returns the failure text. */
async function expectFailure(task: Promise<unknown>, pattern: RegExp, what: string): Promise<string> {
  try {
    await task;
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (!pattern.test(text)) throw new Error(`${what}: failed, but not with ${pattern}: ${text}`);
    console.log(`    ok: ${what} (${pattern.exec(text)?.[0] ?? ""})`);
    return text;
  }
  throw new Error(`${what}: expected a failure, but it went through`);
}

const notImplemented = (err: unknown): string | undefined =>
  err instanceof TxFailedError ? /NotImplemented\(([a-z_]+)\)/.exec(err.message)?.[1] : undefined;

interface StepResult {
  name: string;
  status: "ok" | "pending" | "failed";
  detail: string;
}

class Flow {
  readonly results: StepResult[] = [];
  private readonly missing = new Set<string>();

  async step(name: string, needs: string[], task: () => Promise<void>): Promise<void> {
    const blocked = needs.filter((n) => this.missing.has(n));
    console.log(`\n== ${name}`);
    if (blocked.length > 0) {
      console.log(`  pending: needs ${blocked.join(", ")}`);
      this.results.push({ name, status: "pending", detail: `needs ${blocked.join(", ")}` });
      this.missing.add(name);
      return;
    }
    try {
      await task();
      this.results.push({ name, status: "ok", detail: "" });
    } catch (err) {
      const missing = err instanceof Pending ? err.message : notImplemented(err);
      if (missing) {
        console.log(`  pending: ${missing} is not in this contract build`);
        this.results.push({ name, status: "pending", detail: `${missing} not implemented` });
        this.missing.add(name);
        return;
      }
      this.results.push({ name, status: "failed", detail: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }
}

async function assertBacked(p: Protocol, record: DemoRecord): Promise<void> {
  for (const sid of [record.scenario_2x2, record.scenario_binary]) {
    const worlds = await p.backing(sid);
    const bad = worlds.filter((w) => !w.wnear_backed || !w.usdc_backed).map((w) => w.world);
    if (bad.length > 0) throw new Error(`scenario ${sid}: worlds ${bad.join(", ")} are not backed`);
  }
  console.log("    ok: every world of both scenarios is backed");
}

async function perWorld(p: Protocol, sid: number, account: string): Promise<{ wnear: bigint; usdc: bigint }[]> {
  const s = await p.scenario(sid);
  const pieces = await p.collateral(sid, account);
  return Array.from({ length: s.world_count }, (_, w) => {
    let wnear = 0n;
    let usdc = 0n;
    for (const piece of pieces) {
      const c = pieceCovers(piece.piece, w);
      if (c.covers && c.asset === "wnear") wnear += u128(piece.amount);
      if (c.covers && c.asset === "usdc") usdc += u128(piece.amount);
    }
    return { wnear, usdc };
  });
}

interface LiquidateEvent {
  account_id: string;
  liquidator_id: string;
  repaid: string;
  pieces: string[];
  seized: string[];
}

/** The data of the one `liquidate` event among `logs`. */
function liquidateEvent(logs: string[]): LiquidateEvent {
  const found = logs
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice("EVENT_JSON:".length)) as { event: string; data: LiquidateEvent[] })
    .filter((e) => e.event === "liquidate");
  const data = found[0]?.data[0];
  if (found.length !== 1 || !data) throw new Error(`expected one liquidate event, found ${found.length}`);
  return data;
}

/** What `account` holds of a collateral piece outside lending: verse pieces in the ledger, real ones internally. */
async function pieceHolding(p: Protocol, sid: number, account: string, piece: string): Promise<bigint> {
  const { asset } = pieceCovers(piece, 0);
  if (piece === asset) return p.realBalance(account, asset);
  return p.verseBalance(account, sid, asset, Number(piece.split(":")[2]));
}

async function postOrder(p: Protocol, maker: string, sid: number, mask: number, side: "bid" | "ask", price: bigint, amount: bigint): Promise<string> {
  const expiry = (await chainNowSec()) + 24 * 3600;
  const r = await p.call1y<string>(maker, "post_order", {
    scenario_id: sid,
    mask,
    side,
    price: price.toString(),
    amount: amount.toString(),
    expiry_sec: expiry,
  }, `${maker}: post_order ${side} ${fmt4(price)} x ${fmt2(amount)} in mask ${mask}`);
  if (typeof r.value !== "string") throw new Error(`post_order returned ${r.returnText}`);
  return r.value;
}

async function main(): Promise<void> {
  const d = await requireDeployments();
  const p = new Protocol(d);
  const { root: owner } = d;
  const { alice, bob, ravi, sam, uma, carl, leo } = d.personas;
  console.log(`${NETWORK} via ${RPC_URL}; contract ${d.contractId}`);

  let record: DemoRecord;
  if (opts["no-seed"]) {
    record = await p.demoRecord();
  } else {
    const odds = await fedCutsOdds();
    record = await seedDemo(p, { shipsBps: ODDS_SHIPS_BPS, cutsBps: odds.cutsBps, oddsSource: odds.source, spotFrom: "2x2", withRavi: true });
  }
  const s = record.scenario_2x2;
  const sBin = record.scenario_binary;
  await waitForTwap(p, record);
  const flow = new Flow();
  const state: { proceeds: bigint[]; raviFilled: boolean; askId?: string; bidId?: string } = { proceeds: [], raviFilled: false };

  await flow.step("1. grid, disconnected", [], async () => {
    const grid = await p.scenario(s);
    const bin = await p.scenario(sBin);
    check(grid.world_count === 4 && bin.world_count === 2, "4 cells in the 2x2, 2 in the binary");
    const pools = await p.worldPools(s);
    for (const [w, seed] of SEED_2X2.entries()) {
      check(pools.get(w)?.price === seed.price.toString(), `world ${w} pool price ${fmt2(seed.price)}`);
    }
    const odds = await p.odds(s);
    check(odds.known && odds.q.reduce((a, b) => a + b, 0n) === WAD, "odds known and summing to 100%");
    const implied = await p.impliedSpot(s);
    const spot = await p.spotPrice();
    console.log(`    implied spot ${fmt4(implied)}, actual ${fmt4(spot)}`);
    check(implied > 0n && spot > 0n, "implied and actual spot shown");
    await assertBacked(p, record);
  });

  await flow.step("2. register and connect Alice", [], async () => {
    await p.ensureStorage(owner, alice);
    const wnear = await p.walletInternal("wnear", alice);
    console.log(`    wallet: ${fmt2(wnear)} wNEAR`);
    check(wnear >= SALE_WNEAR, "Alice holds at least 2,000 wNEAR");
  });

  await flow.step("3-4. sell in DELAYED·CUTS, SHIPS·HOLDS and DELAYED·HOLDS", [], async () => {
    const plans = await plan2x2(p, record);
    check(plans[3]?.length === 1, "DELAYED·HOLDS sells via Ravi's bid + pool");
    const quote = await p.quoteSell(s, SALE_WNEAR, MASK_L_SHAPE);
    check(quote[0] === 0n, "SHIPS·CUTS keeps 2,000 NEAR");
    await p.send(alice, "wnear", SALE_WNEAR, {
      action: "conditional_sell",
      scenario_id: s,
      sell_mask: MASK_L_SHAPE,
      plans,
      min_out: plans.map(() => "0"),
      to_lending: true,
    }, { label: "alice: conditional_sell 2,000 NEAR in the L-shape, to lending" });
    const held = await perWorld(p, s, alice);
    check(held[0]?.wnear === SALE_WNEAR && held[0]?.usdc === 0n, "SHIPS·CUTS: you hold 2,000.00 NEAR here, loan collateral");
    for (const w of [1, 2, 3]) check((held[w]?.usdc ?? 0n) > 0n && held[w]?.wnear === 0n, `world ${w}: USDC here, loan collateral`);
    state.proceeds = held.map((h) => h.usdc);
    console.log(`    DELAYED·HOLDS proceeds ${fmt2(state.proceeds[3] ?? 0n)}`);
    check((await p.collateral(s, alice)).length === 4, "posted collateral lists 4 pieces");
    const order = (await p.order(record.ravi_order ?? "0")) as OrderView;
    check(order.remaining === "0", "Ravi's bid has left the book");
    state.raviFilled = true;
    await assertBacked(p, record);
  });

  await flow.step("5. borrow 3000", ["3-4. sell in DELAYED·CUTS, SHIPS·HOLDS and DELAYED·HOLDS"], async () => {
    const before = await p.health(s, alice);
    check(before.hf === null, "HF is infinite before borrowing");
    check(before.worst === 3, "worst world DELAYED·HOLDS");
    const wallet = await p.walletBalance("usdc", alice);
    await p.call1y(alice, "borrow", { scenario_id: s, amount: e18(3000n).toString() }, "alice: borrow 3000 USDC");
    check((await p.walletBalance("usdc", alice)) - wallet === p.rawOf("usdc", e18(3000n)), "3000 USDC paid to Alice's wallet");
    const { hf, worst } = await p.health(s, alice);
    const values = await p.collateralValues(s, alice);
    const lltv = u128((await p.appConfig()).lltv);
    const debt = await p.debt(s, alice);
    const expected = (wmul(values[3] ?? 0n, lltv) * WAD) / debt;
    console.log(`    HF ${fmtHf(hf)} (expected about ${fmt2(expected)}), worst world ${worst}`);
    check(hf !== null && worst === 3 && (hf > expected ? hf - expected : expected - hf) * 1_000_000n <= expected, "HF = DH proceeds x 0.75 / debt");
    await assertBacked(p, record);
  });

  await flow.step("6. lend (Leo supplies and withdraws all)", [], async () => {
    await p.ensureStorage(owner, leo);
    await p.mint(owner, "usdc", leo, e18(1000n));
    const wallet = await p.walletBalance("usdc", leo);
    await p.send(leo, "usdc", e18(1000n), { action: "supply", scenario_id: s });
    const supplied = u128(await p.view<string>("supply_balance_of", { scenario_id: s, account_id: leo }));
    check(supplied >= e18(1000n) - 1n, `Leo's supply reads ${fmt2(supplied)}`);
    const market = await p.view<{ utilization: string; total_supply: string; total_borrow: string }>("market_state", { scenario_id: s });
    console.log(`    utilization ${fmt2(u128(market.utilization) * 100n)}%, supplied ${fmt2(u128(market.total_supply))}`);
    await p.call1y(leo, "withdraw_supply", { scenario_id: s, amount: null }, "leo: withdraw_supply all");
    check(u128(await p.view<string>("supply_balance_of", { scenario_id: s, account_id: leo })) === 0n, "nothing left supplied");
    // Shares round down and the 18-decimal amount is floored to USDC's 6, so without interest in between the
    // withdrawal can come back one base unit short.
    check((await p.walletBalance("usdc", leo)) + 1n >= wallet, "the wallet got the USDC back, less at most one base unit");
    await assertBacked(p, record);
  });

  await flow.step("7. order book in SHIPS·CUTS (Ravi asks 3.75, bids 3.60 for 1,000 NEAR each; Sam takes the ask)", [], async () => {
    for (const who of [ravi, sam]) await p.ensureStorage(owner, who);
    const bidCost = orderCost(BOOK_SIZE_WNEAR, BOOK_BID_PRICE);
    const askCost = orderCost(BOOK_SIZE_WNEAR, BOOK_ASK_PRICE);
    await p.mintAndSplit(owner, ravi, "wnear", s, [MASK_SHIPS_CUTS, 0xe], BOOK_SIZE_WNEAR);
    await p.mintAndSplit(owner, ravi, "usdc", s, [MASK_SHIPS_CUTS, 0xe], bidCost);
    state.askId = await postOrder(p, ravi, s, MASK_SHIPS_CUTS, "ask", BOOK_ASK_PRICE, BOOK_SIZE_WNEAR);
    state.bidId = await postOrder(p, ravi, s, MASK_SHIPS_CUTS, "bid", BOOK_BID_PRICE, BOOK_SIZE_WNEAR);
    const book = await p.view<{ bids: OrderView[]; asks: OrderView[] }>("orders_for_world", { scenario_id: s, world: 0, limit: null });
    check(book.asks.some((o) => o.id === state.askId) && book.bids.some((o) => o.id === state.bidId), "both orders on the ladder");
    const poolPrice = u128((await p.worldPools(s)).get(0)?.price ?? "0");
    check(BOOK_BID_PRICE < poolPrice && poolPrice < BOOK_ASK_PRICE, `bid and ask sit around the pool line (${fmt4(poolPrice)})`);
    await p.mintAndSplit(owner, sam, "usdc", s, [MASK_SHIPS_CUTS, 0xe], askCost);
    const before = await p.verseBalance(sam, s, "wnear", MASK_SHIPS_CUTS);
    await p.call1y(sam, "fill_order", {
      order_id: state.askId,
      amount: BOOK_SIZE_WNEAR.toString(),
      limit_price: BOOK_ASK_PRICE.toString(),
    }, `sam: buy ${fmt2(BOOK_SIZE_WNEAR)} NEAR from ask #${state.askId} at ${fmt4(BOOK_ASK_PRICE)}`);
    check((await p.verseBalance(sam, s, "wnear", MASK_SHIPS_CUTS)) - before === BOOK_SIZE_WNEAR, "Sam received 1,000 wNEAR-if-SHIPS·CUTS");
    check((await p.order(state.askId))?.remaining === "0", "the ask is filled");
    await assertBacked(p, record);
  });

  await flow.step("8. Root LP (Uma deposits 5,000 NEAR + 20,000 USDC, withdraws all)", [], async () => {
    if (!(await p.appConfig()).root_lp) throw new Pending("root_lp");
    await p.ensureStorage(owner, uma);
    await p.mint(owner, "wnear", uma, UMA_WNEAR);
    await p.send(uma, "wnear", UMA_WNEAR, { action: "deposit" });
    await p.mint(owner, "usdc", uma, UMA_USDC);
    await p.send(uma, "usdc", UMA_USDC, { action: "lp_deposit", scenario_id: s, wnear_amount: UMA_WNEAR.toString(), min_shares: "0" }, { allowRefund: true });
    const shares = await p.view<{ balance: string }>("root_lp_shares_of", { scenario_id: s, account_id: uma });
    check(u128(shares.balance) > 0n, `Uma holds ${fmt2(u128(shares.balance))} shares`);
    const zeros = Array.from({ length: 4 }, () => "0");
    const wallet = await p.walletBalance("usdc", uma);
    await p.call1y(uma, "lp_withdraw", { scenario_id: s, shares: shares.balance, min_wnear_out: zeros, min_usdc_out: zeros }, "uma: lp_withdraw all");
    check((await p.walletBalance("usdc", uma)) > wallet, "withdraw all returned real USDC");
    await assertBacked(p, record);
  });

  await flow.step("9. admin pushes DELAYED·HOLDS down with 3,000 NEAR; Carl's unhedged loan", [], async () => {
    await p.ensureStorage(owner, carl);
    await p.mint(owner, "wnear", carl, CARL_WNEAR);
    await p.send(carl, "wnear", CARL_WNEAR, { action: "deposit_collateral", scenario_id: s });
    const carlValues = await p.collateralValues(s, carl);
    const lltv = u128((await p.appConfig()).lltv);
    const worstValue = carlValues.reduce((m, v) => (v < m ? v : m));
    const loan = (wmul(worstValue, lltv) * 97n) / 100n;
    await p.call1y(carl, "borrow", { scenario_id: s, amount: loan.toString() }, `carl: borrow ${fmt2(loan)} against ${fmt2(CARL_WNEAR)} real NEAR`);
    const aliceBefore = await p.health(s, alice);

    const poolId = (await p.worldPools(s)).get(3)?.id;
    if (poolId === undefined) throw new Error("no DELAYED·HOLDS pool");
    const priceBefore = u128((await p.pool(poolId))?.price ?? "0");
    await p.mintAndSplit(owner, owner, "wnear", s, [MASK_DELAYED_HOLDS, 0x7], PUSH_WNEAR);
    await p.call1y(owner, "swap", { pool_id: poolId, zero_for_one: true, amount_in: PUSH_WNEAR.toString(), min_out: "0" }, "owner: sell 3,000 wNEAR-if-DELAYED·HOLDS");
    const priceAfter = u128((await p.pool(poolId))?.price ?? "0");
    console.log(`    DELAYED·HOLDS: $${fmt4(priceBefore)} -> $${fmt4(priceAfter)}`);
    check(priceAfter < priceBefore, "the pool price fell");
    const { twap_window_sec } = await p.appConfig();
    await waitForChainTime((await chainNowSec()) + twap_window_sec + 1, "the TWAP to take the new price");
    const aliceAfter = await p.health(s, alice);
    check(aliceAfter.hf === aliceBefore.hf || (aliceBefore.hf !== null && aliceAfter.hf !== null && aliceAfter.hf * 1000n >= aliceBefore.hf * 999n),
      `Alice's HF unchanged (${fmtHf(aliceBefore.hf)} -> ${fmtHf(aliceAfter.hf)}): she holds USDC there`);
    const status = await p.view<{ status: string }>("liquidation_status", { scenario_id: s, account_id: carl });
    check(status.status === "liquidatable", `Carl shows Liquidatable (HF ${fmtHf((await p.health(s, carl)).hf)})`);
    await assertBacked(p, record);
  });

  await flow.step("9b. Leo liquidates Carl (repay max, half the debt at most)", ["9. admin pushes DELAYED·HOLDS down with 3,000 NEAR; Carl's unhedged loan"], async () => {
    const hfBefore = (await p.health(s, carl)).hf;
    const debtBefore = await p.debt(s, carl);
    const pieces = (await p.collateral(s, carl)).map((c) => c.piece);
    // half the debt in whole USDC, with room for interest accrued until the transaction runs; the rest comes back
    const scale = internalStep(p.decimals("usdc"));
    const send = ((debtBefore / 2n + debtBefore / 1000n + scale - 1n) / scale) * scale;
    await p.ensureStorage(owner, leo);
    await p.mint(owner, "usdc", leo, send);
    const held = await Promise.all(pieces.map((piece) => pieceHolding(p, s, leo, piece)));
    const r = await p.send(leo, "usdc", send, { action: "liquidate", scenario_id: s, account_id: carl, repay_amount: "max" }, {
      allowRefund: true,
      label: `leo: liquidate ${carl} with up to ${fmt2(send)} USDC`,
    });
    const ev = liquidateEvent(r.logs);
    check(ev.account_id === carl && ev.liquidator_id === leo, "the liquidate event names Carl and Leo");
    const repaid = u128(ev.repaid);
    const debtAfter = await p.debt(s, carl);
    const hfAfter = (await p.health(s, carl)).hf;
    console.log(`    Carl: HF ${fmtHf(hfBefore)} -> ${fmtHf(hfAfter)}, debt ${fmt2(debtBefore)} -> ${fmt2(debtAfter)}`);
    console.log(`    repaid ${fmt2(repaid)} USDC (Leo sent ${fmt2(send)}, ${fmt2(send - r.used * scale)} came back)`);
    // the debt when the liquidation ran is what it repaid plus what is left, give or take the rounding up of each
    check(repaid > 0n && 2n * repaid <= repaid + debtAfter + 2n, "repaid is at most 50% of the debt");
    check(r.used * scale >= repaid && r.used * scale - repaid < scale, "Leo paid the repaid amount, rounded up to a whole USDC unit");
    let seizedAny = false;
    for (const [i, piece] of ev.pieces.entries()) {
      const seized = u128(ev.seized[i] ?? "0");
      const at = pieces.indexOf(piece);
      if (at < 0) throw new Error(`liquidate event names ${piece}, not one of Carl's pieces`);
      const gained = (await pieceHolding(p, s, leo, piece)) - (held[at] ?? 0n);
      const where = piece.includes(":") ? "in Leo's ledger" : "in Leo's internal balance";
      console.log(`    seized ${fmt2(seized)} of ${piece}, ${where}`);
      // a real USDC piece shares Leo's balance with the dust of his payment
      const dust = piece === "usdc" ? r.used * scale - repaid : 0n;
      check(gained === seized + dust, `${piece}: the seized amount is credited ${where}`);
      seizedAny ||= seized > 0n;
    }
    check(seizedAny, "Leo seized collateral");
    check(hfBefore !== null && hfAfter !== null && hfAfter > hfBefore, "Carl's HF rose");
    await assertBacked(p, record);
  });

  await flow.step("10. resolution: the reporter proposes Fed HOLDS, Glamsterdam resolves DELAYED", [], async () => {
    const deps = reporterDeps(p, join(REPO_ROOT, "deployments", "demo-outcomes.json"));
    const fed = resolverEvents(record, "team").filter((e) => e.eventId === record.fed_event);
    const run = await resolveOnce(fed, deps, false);
    check(run.proposed.length === 1, "the reporter proposed the Fed outcome");
    const proposed = await p.event(record.fed_event);
    check(proposed.proposal_open && proposed.proposed_outcome === HOLDS && proposed.proposed_by === "reporter", "Proposed: HOLDS, by the reporter");
    check((await p.scenario(s)).halted, "paused: resolution pending");
    const poolId = (await p.worldPools(s)).get(2)?.id ?? 0;
    await expectFailure(
      p.call1y(owner, "swap", { pool_id: poolId, zero_for_one: false, amount_in: e18(100n).toString(), min_out: "0" }, "owner: swap while halted"),
      /ScenarioHalted\(\d+\)/,
      "trading pauses while a resolution is pending",
    );
    const carlStatus = await p.view<{ status: string }>("liquidation_status", { scenario_id: s, account_id: carl });
    const carlHf = (await p.health(s, carl)).hf;
    const carlUnder = carlHf !== null && carlHf < WAD;
    check(carlStatus.status === (carlUnder ? "paused_halted" : "none"), `liquidation paused (Carl's HF ${fmtHf(carlHf)}: ${carlStatus.status})`);
    await p.mint(owner, "usdc", leo, e18(1n));
    await expectFailure(
      p.send(leo, "usdc", e18(1n), { action: "liquidate", scenario_id: s, account_id: carl, repay_amount: "max" }, { label: "leo: liquidate while halted" }),
      /ScenarioHalted\(\d+\)/,
      "a liquidation is refused while a resolution is pending",
    );
    await expectFailure(call(sam, d.contractId, "finalize", { event_id: record.fed_event }, { gas: tgas(100) }), /DisputeWindowNotOver\(\d+, \d+\)/, "finalize waits for the window");
    await waitForChainTime(proposed.finalizable_at_sec, "the dispute window");
    await call(sam, d.contractId, "finalize", { event_id: record.fed_event }, { gas: tgas(100), label: "sam: finalize the Fed event" });
    const after = await p.scenario(s);
    check(after.possible === 0xc && !after.halted, "CUTS column gone: still possible SHIPS·HOLDS, DELAYED·HOLDS");
    await p.call1y(owner, "admin_resolve", { event_id: record.glam_event, outcome: 1 }, "owner: admin_resolve Glamsterdam DELAYED");
    check((await p.scenario(s)).possible === MASK_DELAYED_HOLDS, "only DELAYED·HOLDS is still possible");
    check((await p.scenario(sBin)).possible === 0x2, "binary: only DELAYED is still possible");
    await assertBacked(p, record);
  });

  await flow.step("11a. Alice closes her loan and redeems", ["3-4. sell in DELAYED·CUTS, SHIPS·HOLDS and DELAYED·HOLDS", "5. borrow 3000"], async () => {
    const debt = await p.debt(s, alice);
    const scale = internalStep(p.decimals("usdc"));
    const send = ((debt + debt / 1000n + scale - 1n) / scale) * scale;
    await p.mint(owner, "usdc", alice, send);
    const wallet = await p.walletBalance("usdc", alice);
    await p.send(alice, "usdc", send, { action: "close_after_resolution", scenario_id: s }, { allowRefund: true, label: "alice: close_after_resolution" });
    check((await p.debt(s, alice)) === 0n, "loan repaid");
    check((await p.collateral(s, alice)).length === 0, "collateral released");
    const gained = ((await p.walletBalance("usdc", alice)) - wallet) * scale;
    const expected = (state.proceeds[3] ?? 0n) - debt;
    console.log(`    Repaid $${fmt2(debt)}; wallet change ${fmt2(gained)} USDC (expected about ${fmt2(expected)})`);
    check(gained > expected - e18(1n) && gained < expected + e18(1n), "You receive, real: matches");
    await assertBacked(p, record);
  });

  await flow.step("11b. Ravi redeems his DELAYED·HOLDS position", [], async () => {
    if (!state.raviFilled && record.ravi_order) {
      await p.call1y(ravi, "cancel_order", { order_id: record.ravi_order }, "ravi: cancel his unfilled bid");
    }
    const asset = state.raviFilled ? "wnear" : "usdc";
    const amount = await p.verseBalance(ravi, s, asset, MASK_DELAYED_HOLDS);
    check(amount > 0n, `Ravi holds ${fmt2(amount)} ${d.tokens[asset].symbol}-if-DELAYED·HOLDS`);
    const wallet = await p.walletBalance(asset, ravi);
    await p.call1y(ravi, "redeem", { scenario_id: s, asset, mask: MASK_DELAYED_HOLDS, amount: amount.toString() }, `ravi: redeem ${asset}`);
    check(p.internalOf(asset, (await p.walletBalance(asset, ravi)) - wallet) === amount, "redeemed 1:1 into the wallet");
    await assertBacked(p, record);
  });

  await flow.step("12. failure paths", [], async () => {
    if (state.bidId) {
      await expectFailure(
        p.call1y(sam, "fill_order", { order_id: state.bidId, amount: BOOK_SIZE_WNEAR.toString(), limit_price: "0" }, "sam: sell into a stale SHIPS·CUTS bid"),
        /OrderNotOpen\(\d+\)|DeadVerse\(\d+\)/,
        "a stale order after resolution cannot be filled",
      );
    }
    const leoWnear = await p.walletInternal("wnear", leo);
    await expectFailure(p.send(leo, "wnear", leoWnear + e18(1000n), { action: "deposit" }), /balance|enough/i, "an amount above the wallet fails");
    await p.mint(owner, "usdc", leo, e18(1n));
    const leoUsdc = await p.walletBalance("usdc", leo);
    await expectFailure(p.send(leo, "usdc", e18(1n), { action: "nope" }), /BadMessage\([^)]*\)?/, "a malformed message is a failure, not Done");
    check((await p.walletBalance("usdc", leo)) === leoUsdc, "and the tokens came back");
    await assertBacked(p, record);
  });

  console.log("\n== summary");
  for (const r of flow.results) console.log(`  ${r.status.padEnd(7)} ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  const pending = flow.results.filter((r) => r.status === "pending");
  if (pending.length > 0 && !opts["allow-pending"]) {
    console.log(`${pending.length} step(s) pending; pass --allow-pending to accept that`);
    process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
