// Invariant checks over pinned views (S-4): every read of one check names the same block. They are
// shared by e2e, upgrade (R3/R4/R6), soak, watch, rehearse suites and seed-v2's final checks, and
// each one names the spec invariant it reads (SPEC-C 5).

import type { CheckResult } from "./books.ts";
import { orderCost } from "./demo.ts";
import type { LiquidateEvent } from "./events.ts";
import { tierField, type Tier } from "./msgs.ts";
import { pieceCovers, type ChainReader } from "./protocol.ts";
import { u128, WAD } from "./units.ts";
import {
  decodeBacking,
  decodeBorrowerCount,
  decodeBorrowers,
  decodeContractVersion,
  decodeMarketView,
  decodeOrder,
  decodeProposalList,
  decodeBooksView,
  decodeScenario,
  decodeStorageBalance,
  decodeWorldBook,
  decodeWorldPrices,
  decodeWorldSupply,
  type BorrowerRow,
  type ProposalSummary,
  type TierConfigView,
} from "./views.ts";

export type { CheckResult };

/** The state version this tooling is built for (SPEC-C 4.1). */
export const STATE_VERSION = 2;
/** SPEC-C 3.6.2: 1,000% APR per second. */
export const MAX_RATE_PER_SEC = 317_097_919_837n;

const ok = (name: string, detail: string, block: number): CheckResult => ({ name, ok: true, detail, block });
const bad = (name: string, detail: string, block: number): CheckResult => ({ name, ok: false, detail, block });

const tierArgs = (tier: Tier): { tier?: Tier } => tierField(tier, STATE_VERSION);
const mulDivDown = (a: bigint, b: bigint, c: bigint): bigint => (a * b) / c;
const bit = (mask: number, w: number): boolean => (mask & (1 << w)) !== 0;

// Integer mirrors of math/irm.rs (SPEC-C 3.6.2), used to check what market_state reports.

export function utilizationOf(tba: bigint, tsa: bigint): bigint {
  if (tba === 0n) return 0n;
  if (tba >= tsa) return WAD;
  return mulDivDown(tba, WAD, tsa);
}

export function borrowRateOf(u: bigint, cfg: Pick<TierConfigView, "rate_base" | "rate_slope1" | "rate_slope2" | "rate_kink">): bigint {
  const util = u > WAD ? WAD : u;
  const base = u128(cfg.rate_base, "rate_base");
  const slope1 = u128(cfg.rate_slope1, "rate_slope1");
  const slope2 = u128(cfg.rate_slope2, "rate_slope2");
  const kink = u128(cfg.rate_kink, "rate_kink");
  if (util <= kink) return base + (kink === 0n ? 0n : mulDivDown(slope1, util, kink));
  return base + slope1 + mulDivDown(slope2, util - kink, WAD - kink);
}

// V-1: every possible world is backed

/** For each possible world, the supply of each asset covering it equals the scenario's reserve. `full` also asks `backing()` (30.7 Tgas at 8 worlds). */
export async function checkBacking(p: ChainReader, sid: number, block: number, full = false): Promise<CheckResult> {
  const name = `V-1 backing s${sid}`;
  const ws = decodeWorldSupply(await p.viewAt<unknown>("world_supply", { scenario_id: sid }, block));
  const wr = u128(ws.wnear_reserves);
  const ur = u128(ws.usdc_reserves);
  const off: string[] = [];
  for (let w = 0; w < Math.max(ws.wnear.length, ws.usdc.length); w++) {
    if (!bit(ws.possible, w)) continue;
    const wn = u128(ws.wnear[w] ?? "0");
    const us = u128(ws.usdc[w] ?? "0");
    if (wn !== wr) off.push(`w${w} wNEAR ${wn} ≠ reserve ${wr}`);
    if (us !== ur) off.push(`w${w} USDC ${us} ≠ reserve ${ur}`);
  }
  if (full) {
    const b = decodeBacking(await p.viewAt<unknown>("backing", { scenario_id: sid }, block));
    for (const row of b.worlds) {
      if (row.possible && (!row.wnear_backed || !row.usdc_backed)) off.push(`backing(): w${row.world} not backed`);
    }
  }
  return off.length === 0 ? ok(name, `${ws.wnear.length} worlds, possible 0b${ws.possible.toString(2)}`, block) : bad(name, off.join("; "), block);
}

// V-5: order escrow covers what is left, and fillable orders are on the ladder

export async function checkOrders(p: ChainReader, ids: readonly string[], block: number): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const now = ids.length > 0 ? await p.blockTimeSec(block) : 0;
  for (const id of ids) {
    const name = `V-5 order ${id}`;
    const o = decodeOrder(await p.viewAt<unknown>("get_order", { order_id: id }, block));
    if (o === null) {
      out.push(bad(name, "order not found", block));
      continue;
    }
    const remaining = u128(o.remaining);
    const escrow = u128(o.escrow);
    if (remaining === 0n) {
      out.push(escrow === 0n ? ok(name, "closed", block) : bad(name, `closed with ${escrow} still in escrow`, block));
      continue;
    }
    const price = u128(o.price);
    const problems: string[] = [];
    if (o.side === "bid" && escrow < orderCost(remaining, price)) problems.push(`bid escrow ${escrow} < cost ${orderCost(remaining, price)} of ${remaining} at ${price}`);
    if (o.side === "ask" && escrow !== remaining) problems.push(`ask escrow ${escrow} ≠ remaining ${remaining}`);
    const single = o.mask !== 0 && (o.mask & (o.mask - 1)) === 0;
    if (single) {
      const world = Math.log2(o.mask);
      const s = decodeScenario(await p.viewAt<unknown>("get_scenario", { scenario_id: o.scenario_id }, block));
      const fillable = o.expiry_sec > now && o.epoch === s.resolution_count && bit(s.possible, world);
      if (fillable) {
        const book = decodeWorldBook(await p.viewAt<unknown>("orders_for_world", { scenario_id: o.scenario_id, world, limit: 200 }, block));
        const side = o.side === "bid" ? book.bids : book.asks;
        if (side.length < 200 && !side.some((r) => r.id === o.id)) problems.push(`fillable ${o.side} missing from orders_for_world(${o.scenario_id}, ${world})`);
      }
    }
    out.push(problems.length === 0 ? ok(name, `${o.side} ${remaining} left, escrow ${escrow}`, block) : bad(name, problems.join("; "), block));
  }
  return out;
}

// L-1 and the rate model, per tier market

export async function checkMarket(p: ChainReader, sid: number, tier: Tier, block: number): Promise<CheckResult[]> {
  const tag = `s${sid}/${tier}`;
  const m = decodeMarketView(await p.viewAt<unknown>("market_state", { scenario_id: sid, ...tierArgs(tier) }, block));
  const count = decodeBorrowerCount(await p.viewAt<unknown>("borrower_count", { scenario_id: sid, ...tierArgs(tier) }, block));
  const tsa = u128(m.total_supply);
  const tba = u128(m.total_borrow);
  const ins = u128(m.insurance);
  const u = u128(m.utilization);
  const rate = u128(m.borrow_rate_per_sec);
  const out: CheckResult[] = [];
  const cash = tsa + ins - tba;
  out.push(cash >= 0n ? ok(`L-1 cash ${tag}`, `TSA + INS − TBA = ${cash}`, block) : bad(`L-1 cash ${tag}`, `TSA ${tsa} + INS ${ins} − TBA ${tba} = ${cash} < 0`, block));
  const uWant = utilizationOf(tba, tsa);
  out.push(
    u <= WAD && u === uWant
      ? ok(`utilization ${tag}`, `${u}`, block)
      : bad(`utilization ${tag}`, `reported ${u}, expected ${uWant} from TBA ${tba} / TSA ${tsa} (≤ 1e18)`, block),
  );
  out.push(
    m.borrowers === count
      ? ok(`L-3 borrower count ${tag}`, `${count}`, block)
      : bad(`L-3 borrower count ${tag}`, `market_state.borrowers ${m.borrowers} ≠ borrower_count ${count}`, block),
  );
  const rateWant = borrowRateOf(u, m.config);
  out.push(
    rate === rateWant && rate <= MAX_RATE_PER_SEC
      ? ok(`L-9 rate ${tag}`, `${rate}/s at u ${u}`, block)
      : bad(`L-9 rate ${tag}`, `reported ${rate}/s, the curve gives ${rateWant}/s at u ${u} (max ${MAX_RATE_PER_SEC})`, block),
  );
  return out;
}

async function borrowerRowsAt(p: ChainReader, sid: number, tier: Tier, block: number): Promise<{ rows: BorrowerRow[]; total: number }> {
  const rows: BorrowerRow[] = [];
  let from: number | null = null;
  let total = 0;
  for (;;) {
    const page = decodeBorrowers(await p.viewAt<unknown>("borrowers", { scenario_id: sid, ...tierArgs(tier), from_index: from, limit: 100, max_health_factor: null }, block));
    total = page.total;
    rows.push(...page.rows);
    if (page.next_index === null) return { rows, total };
    if (from !== null && page.next_index <= from) throw new Error(`borrowers: next_index ${page.next_index} does not advance past ${from}`);
    from = page.next_index;
  }
}

/** L-3 for one account: it has debt in the market if and only if the index lists it. */
export async function checkBorrowerIndex(p: ChainReader, sid: number, tier: Tier, account: string, block: number): Promise<CheckResult> {
  const name = `L-3 index s${sid}/${tier} ${account}`;
  const debt = u128(await p.viewAt<string>("debt_of", { scenario_id: sid, account_id: account, ...tierArgs(tier) }, block), "debt_of");
  const { rows } = await borrowerRowsAt(p, sid, tier, block);
  const indexed = rows.some((r) => r.account_id === account);
  if (debt > 0n === indexed) return ok(name, debt > 0n ? `debt ${debt}, indexed` : "no debt, not indexed", block);
  return bad(name, debt > 0n ? `debt ${debt} but not in the borrower index` : "in the borrower index without debt", block);
}

/** L-3 for a whole market: the index is dense (0..total−1), without duplicates. */
export async function checkBorrowerList(p: ChainReader, sid: number, tier: Tier, block: number): Promise<CheckResult> {
  const name = `L-3 index s${sid}/${tier} dense`;
  const { rows, total } = await borrowerRowsAt(p, sid, tier, block);
  const indexes = rows.map((r) => r.index).sort((a, b) => a - b);
  const accounts = new Set(rows.map((r) => r.account_id));
  const dense = indexes.length === total && indexes.every((v, i) => v === i);
  if (dense && accounts.size === rows.length) return ok(name, `${total} borrowers`, block);
  return bad(name, `total ${total}, ${rows.length} rows, ${accounts.size} distinct accounts, indexes ${indexes.slice(0, 10).join(",")}${indexes.length > 10 ? "…" : ""}`, block);
}

/** 10 bps: one block of interest (≤ 2.4e-8/s at 75% APR) and the TWAP slide around a resolution. */
export const HF_DROP_ALLOWANCE_BPS = 10n;

/**
 * V-3 around a resolution (SPEC.md 3.8, 11.2): HF read at H − 1 (before the finalize receipt) and
 * at H. A violation iff after < before × min(1, lfAfter / lfBefore) × (1 − 0.0010). Every drop is
 * reported, allowed or not; a missing or infinite HF on either side has nothing to compare.
 */
export function checkHfNotLowered(
  before: ReadonlyMap<string, bigint | null>,
  after: ReadonlyMap<string, bigint | null>,
  lfBefore: bigint,
  lfAfter: bigint,
  block = 0,
): CheckResult[] {
  const ratio = lfBefore <= 0n || lfAfter >= lfBefore ? WAD : mulDivDown(lfAfter, WAD, lfBefore);
  const out: CheckResult[] = [];
  for (const [account, hfBefore] of before) {
    if (!after.has(account)) continue;
    const hfAfter = after.get(account) ?? null;
    if (hfBefore === null || hfAfter === null || hfAfter >= hfBefore) continue;
    const floor = mulDivDown(mulDivDown(hfBefore, ratio, WAD), 10_000n - HF_DROP_ALLOWANCE_BPS, 10_000n);
    const dropBps = ((hfBefore - hfAfter) * 10_000n) / hfBefore;
    const detail = `HF ${hfBefore} → ${hfAfter} (−${dropBps} bps), factor ${lfBefore} → ${lfAfter}, floor ${floor}`;
    out.push(hfAfter < floor ? bad(`V-3 ${account}`, detail, block) : ok(`V-3 ${account}`, detail, block));
  }
  return out;
}

/**
 * M-2: books.pledges equals the escrow of every proposal. Before opening a proposal's escrow is its
 * pledged totals exactly; after opening it is the unused part owed plus dust, which no view
 * enumerates, so an opened proposal contributes at most its pledged totals. Without opened
 * proposals the check is exact.
 */
export async function checkPledgeEscrow(p: ChainReader, block: number): Promise<CheckResult> {
  const name = "M-2 pledge escrow";
  const first = decodeBooksView(await p.viewAt<unknown>("books", { from_scenario: null, limit: 1 }, block));
  const books = { wnear: u128(first.wnear.pledges), usdc: u128(first.usdc.pledges) };
  const proposals: ProposalSummary[] = [];
  let from: number | null = null;
  for (;;) {
    const page = decodeProposalList(await p.viewAt<unknown>("list_proposals", { from_id: from, limit: 50, filter: "all" }, block));
    proposals.push(...page.proposals);
    if (page.next_from === null) break;
    if (from !== null && page.next_from >= from) throw new Error(`list_proposals: next_from ${page.next_from} does not move below ${from}`);
    from = page.next_from;
  }
  return judgePledgeEscrow(books, proposals, block, name);
}

export function judgePledgeEscrow(
  books: { wnear: bigint; usdc: bigint },
  proposals: readonly Pick<ProposalSummary, "proposal_id" | "status" | "pledged_wnear" | "pledged_usdc">[],
  block: number,
  name = "M-2 pledge escrow",
): CheckResult {
  const exact = { wnear: 0n, usdc: 0n };
  const bound = { wnear: 0n, usdc: 0n };
  let opened = 0;
  for (const pr of proposals) {
    const w = u128(pr.pledged_wnear);
    const u = u128(pr.pledged_usdc);
    if (pr.status === "opened") {
      opened += 1;
      bound.wnear += w;
      bound.usdc += u;
    } else {
      exact.wnear += w;
      exact.usdc += u;
    }
  }
  const problems: string[] = [];
  for (const a of ["wnear", "usdc"] as const) {
    if (opened === 0 && books[a] !== exact[a]) problems.push(`${a}: books ${books[a]} ≠ Σ escrow ${exact[a]}`);
    if (opened > 0 && (books[a] < exact[a] || books[a] > exact[a] + bound[a])) {
      problems.push(`${a}: books ${books[a]} outside [${exact[a]}, ${exact[a] + bound[a]}] (${opened} opened)`);
    }
  }
  const detail = `${proposals.length} proposals (${opened} opened); wNEAR ${books.wnear}, USDC ${books.usdc}`;
  return problems.length === 0 ? ok(name, detail, block) : bad(name, problems.join("; "), block);
}

/** NEP-145 records are sane: available ≤ total, both non-negative (the decoder refuses a negative). */
export async function checkStorage(p: ChainReader, accounts: readonly string[], block: number): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const account of accounts) {
    const name = `storage ${account}`;
    const sb = decodeStorageBalance(await p.viewAt<unknown>("storage_balance_of", { account_id: account }, block));
    if (sb === null) {
      out.push(ok(name, "not registered", block));
      continue;
    }
    const total = u128(sb.total);
    const available = u128(sb.available);
    out.push(available <= total ? ok(name, `available ${available} of ${total}`, block) : bad(name, `available ${available} > total ${total}`, block));
  }
  return out;
}

/** OPS-4 and the code: stored state version is current, recorded code version matches, code hash unchanged. */
export async function checkVersion(p: ChainReader, codeHash: string, block: number): Promise<CheckResult> {
  const name = "OPS-4 version";
  const v = decodeContractVersion(await p.viewAt<unknown>("contract_version", {}, block));
  const account = await p.accountAt(p.contract, block);
  const problems: string[] = [];
  if (v.state_version !== STATE_VERSION) problems.push(`state version ${v.state_version}, expected ${STATE_VERSION}`);
  if (v.recorded_code_version !== v.code_version) problems.push(`recorded ${v.recorded_code_version} ≠ code ${v.code_version}`);
  if (account.codeHash !== codeHash) problems.push(`code hash ${account.codeHash}, expected ${codeHash}`);
  return problems.length === 0 ? ok(name, `${v.code_version} (state ${v.state_version}), ${codeHash}`, block) : bad(name, problems.join("; "), block);
}

/**
 * V-4 for one liquidation: the seized slice is worth at least the repayment in every possible world,
 * at the liquidation prices (TWAP × f_l) of the block before the liquidation. Seize-all liquidations
 * and write-offs are outside V-4 (the whole collateral goes, the rest is bad debt). The allowance
 * covers the floor of each piece's seizure and valuation.
 */
export async function checkLiquidation(p: ChainReader, ev: LiquidateEvent, block: number): Promise<CheckResult> {
  const name = `V-4 liquidation s${ev.scenario_id} ${ev.account_id}`;
  if (u128(ev.written_off ?? "0") > 0n || ev.seize_all === true) return ok(name, "seize-all or write-off: outside V-4", block);
  const before = block - 1;
  const s = decodeScenario(await p.viewAt<unknown>("get_scenario", { scenario_id: ev.scenario_id }, before));
  const rows = decodeWorldPrices(await p.viewAt<unknown>("world_prices", { scenario_id: ev.scenario_id }, before));
  return judgeLiquidation(ev, s.possible, s.world_count, rows.map((r) => u128(r.liquidation_price)), block, name);
}

export function judgeLiquidation(
  ev: Pick<LiquidateEvent, "repaid" | "pieces" | "seized">,
  possible: number,
  worldCount: number,
  liquidationPrices: readonly bigint[],
  block: number,
  name = "V-4 liquidation",
): CheckResult {
  const repaid = u128(ev.repaid);
  if (ev.pieces.length !== ev.seized.length) return bad(name, `${ev.pieces.length} pieces but ${ev.seized.length} seized amounts`, block);
  const short: string[] = [];
  for (let w = 0; w < worldCount; w++) {
    if (!bit(possible, w)) continue;
    const price = liquidationPrices[w] ?? 0n;
    let value = 0n;
    let allowance = 0n;
    for (const [i, piece] of ev.pieces.entries()) {
      const c = pieceCovers(piece, w);
      if (!c.covers) continue;
      const amount = u128(ev.seized[i] ?? "0");
      if (c.asset === "usdc") {
        value += amount;
        allowance += 1n;
      } else {
        value += mulDivDown(amount, price, WAD);
        allowance += 1n + (price + WAD - 1n) / WAD;
      }
    }
    if (value + allowance < repaid) short.push(`w${w}: slice ${value} < repaid ${repaid}`);
  }
  return short.length === 0 ? ok(name, `slice ≥ repaid ${repaid} in every possible world`, block) : bad(name, short.join("; "), block);
}
