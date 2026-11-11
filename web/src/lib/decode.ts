// View JSON → app shapes. U128 strings become bigint here and nowhere else.
import type {
  Account,
  AdminSnapshot,
  AppConfig,
  BorrowSnapshot,
  EventState,
  ImpactPoint,
  LendSnapshot,
  LpPreview,
  ResolveSnapshot,
  RootLp,
  Scenario,
  TradeSnapshot,
  World,
} from "./domain";
import type { Order } from "./orders";
import type {
  AccountViewJson,
  AdminViewJson,
  AppConfigView,
  BorrowViewJson,
  EventViewJson,
  LendViewJson,
  LpPreviewJson,
  OrderViewJson,
  ResolveViewJson,
  RootLpViewJson,
  ScenarioViewJson,
  TradeViewJson,
  WorldViewJson,
} from "./types";

export const big = (v: string | number | null | undefined): bigint => {
  if (v === null || v === undefined || v === "") return 0n;
  return BigInt(typeof v === "number" ? Math.trunc(v) : v);
};

export function decodeWorld(w: WorldViewJson): World {
  return {
    index: w.index,
    mask: w.mask,
    label: w.label,
    possible: w.possible,
    poolInitialized: w.pool_initialized,
    wethPrice: big(w.weth_price),
    backed: w.backed,
    wethTokenId: w.weth_token_id,
    usdcTokenId: w.usdc_token_id,
    userWeth: big(w.user_weth),
    userUsdc: big(w.user_usdc),
    collateralWeth: big(w.collateral_weth),
    collateralUsdc: big(w.collateral_usdc),
    odds: big(w.odds),
    poolId: w.pool_id,
  };
}

export function decodeScenario(s: ScenarioViewJson): Scenario {
  return {
    scenarioId: s.scenario_id,
    worldCount: s.world_count,
    possible: s.possible,
    resolutionCount: s.resolution_count,
    halted: s.halted,
    eventIds: s.event_ids,
    spotPrice: big(s.spot_price),
    worlds: [...s.worlds].sort((a, b) => a.index - b.index).map(decodeWorld),
    oddsKnown: s.odds_known,
    impliedSpot: big(s.implied_spot),
  };
}

export function decodeEvent(e: EventViewJson): EventState {
  return {
    id: e.id,
    question: e.question,
    rule: e.rule,
    outcomeNames: e.outcome_names,
    deadline: big(e.deadline_sec),
    proposedAt: big(e.proposed_at_sec),
    proposedOutcome: e.proposed_outcome,
    proposalOpen: e.proposal_open,
    finalized: e.finalized,
    outcome: e.outcome,
    finalizableAt: big(e.finalizable_at_sec),
    proposedBy: e.proposed_by ?? null,
  };
}

export function decodeOrder(o: OrderViewJson): Order {
  return {
    id: big(o.id),
    maker: o.maker,
    scenarioId: o.scenario_id,
    mask: o.mask,
    side: o.side,
    price: big(o.price),
    amount: big(o.amount),
    remaining: big(o.remaining),
    expiry: big(o.expiry_sec),
    epoch: o.epoch,
    // The view lists open-or-stale orders that still hold escrow; a cancelled order has nothing left and is not listed.
    cancelled: false,
  };
}

export function decodeAccount(a: AccountViewJson): Account {
  return {
    debt: big(a.debt),
    healthFactor: a.health_factor === null ? null : big(a.health_factor),
    worstWorld: a.worst_world,
    collateralValues: a.collateral_values.map(big),
    worldPriceOk: a.world_price_ok,
    collateral: a.collateral.map((c) => ({
      tokenId: c.token_id,
      label: c.label,
      asset: c.asset,
      mask: c.mask,
      isReal: c.is_real,
      amount: big(c.amount),
    })),
    supplied: big(a.supplied),
    supplyPrincipal: big(a.supply_principal),
    marketSupply: big(a.market_supply),
    marketBorrow: big(a.market_borrow),
    utilization: big(a.utilization),
    borrowRatePerSecond: big(a.borrow_rate_per_sec),
    supplyRatePerSecond: big(a.supply_rate_per_sec),
    lltv: big(a.lltv),
    liquidation: a.liquidation,
    unpricedWorld: a.unpriced_world ?? null,
  };
}

export function decodeRootLp(r: RootLpViewJson): RootLp {
  return {
    shareSupply: big(r.share_supply),
    yourShares: big(r.your_shares),
    shareDecimals: r.share_decimals,
    previewWithdraw: r.preview_withdraw ? { weth: r.preview_withdraw.weth.map(big), usdc: r.preview_withdraw.usdc.map(big) } : null,
    holdings: r.holdings.map((h) => ({
      world: h.world,
      wethIdle: big(h.weth_idle),
      usdcIdle: big(h.usdc_idle),
      wethFees: big(h.weth_fees),
      usdcFees: big(h.usdc_fees),
    })),
  };
}

const decodeImpact = (p: { at_sec: number; prices: string[] }): ImpactPoint => ({ at: p.at_sec, prices: p.prices.map(big) });

export const decodeTrade = (v: TradeViewJson): TradeSnapshot => ({
  scenario: decodeScenario(v.scenario),
  events: v.events.map(decodeEvent),
  orders: v.orders.map(decodeOrder),
  impact: v.impact.map(decodeImpact),
  nowSec: big(v.now_sec),
});

export const decodeBorrow = (v: BorrowViewJson): BorrowSnapshot => ({
  scenario: decodeScenario(v.scenario),
  account: decodeAccount(v.account),
  nowSec: big(v.now_sec),
});

export const decodeLend = (v: LendViewJson): LendSnapshot => ({
  account: decodeAccount(v.account),
  rootLp: v.root_lp ? decodeRootLp(v.root_lp) : null,
  worlds: [...v.worlds].sort((a, b) => a.index - b.index),
});

export const decodeResolve = (v: ResolveViewJson): ResolveSnapshot => ({
  scenario: decodeScenario(v.scenario),
  events: v.events.map(decodeEvent),
  pastFedEvent: v.past_fed_event ? decodeEvent(v.past_fed_event) : null,
  account: decodeAccount(v.account),
  nowSec: big(v.now_sec),
});

export const decodeAdmin = (v: AdminViewJson): AdminSnapshot => ({
  scenario: decodeScenario(v.scenario),
  events: v.events.map(decodeEvent),
  pastFedEvent: v.past_fed_event ? decodeEvent(v.past_fed_event) : null,
  ownerId: v.owner_id,
  nowSec: big(v.now_sec),
});

/** Ids in the owner-set demo record may come as numbers or numeric strings; anything else reads as missing. */
function idOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

export function decodeConfig(c: AppConfigView): AppConfig {
  const demo = c.demo && typeof c.demo === "object" ? (c.demo as unknown as Record<string, unknown>) : null;
  return {
    ownerId: c.owner_id,
    reporterId: c.reporter_id,
    weth: { tokenId: c.weth.token_id, decimals: c.weth.decimals, symbol: c.weth.symbol },
    usdc: { tokenId: c.usdc.token_id, decimals: c.usdc.decimals, symbol: c.usdc.symbol },
    lltv: big(c.lltv),
    liquidationBonus: big(c.liquidation_bonus),
    borrowRatePerSec: big(c.borrow_rate_per_sec),
    disputeWindowSec: c.dispute_window_sec,
    twapWindowSec: c.twap_window_sec,
    minPoolDepth: big(c.min_pool_depth),
    orderBook: Boolean(c.order_book),
    rootLp: Boolean(c.root_lp),
    demo: demo
      ? {
          glamEvent: idOf(demo.glam_event),
          fedEvent: idOf(demo.fed_event),
          pastFedEvent: idOf(demo.past_fed_event),
          scenario2x2: idOf(demo.scenario_2x2),
          scenarioBinary: idOf(demo.scenario_binary),
        }
      : null,
  };
}

export const decodeLpPreview = (v: LpPreviewJson): LpPreview => ({
  shares: big(v.shares),
  wethKept: v.weth_kept.map(big),
  usdcKept: v.usdc_kept.map(big),
});
