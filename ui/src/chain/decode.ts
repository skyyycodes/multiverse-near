// View JSON → app shapes. U128 strings become bigint here and nowhere else.
//
// v1 keys keep their v1 decoding (`big`: a missing value reads as 0). Every v2 key goes through `need`: a field the SPEC
// promises and the view lacks throws ViewShapeError, so a build that does not match the contract says so instead of
// showing zeros (W-D6). A v1-shaped view (an AccountView or app config without any v2 key) still decodes, with the v2
// fields as v1 behaved, so the version gate can read a v1 contract and turn it away with the upgrade notice.
import type {
  Account,
  AdminSnapshot,
  AppConfig,
  Books,
  BooksAsset,
  BorrowerRow,
  BorrowersPage,
  BorrowSnapshot,
  CollateralValues,
  ContractVersion,
  EventCheck,
  EventMeta,
  EventState,
  FomcDates,
  GuestConfig,
  HealthView,
  Holding,
  ImpactPoint,
  LendingConfig,
  LendingMarket,
  LendingTier,
  LendSnapshot,
  LiquidationQuote,
  LiquidationState,
  LiquidationStatus,
  LpPreview,
  MarketCard,
  MarketCheck,
  MarketList,
  MarketOfEvents,
  MarketParams,
  MarketParamsView,
  MarketPriceCfg,
  MarketStatus,
  NearBooks,
  NewEvent,
  Opened,
  OpeningPreview,
  OpeningTerms,
  PauseFlag,
  PauseState,
  Pledge,
  PledgePreview,
  PriceCheck,
  Proposal,
  ProposalList,
  ProposalStatus,
  ProposalSummary,
  Reference,
  ReferenceConfig,
  RelatedMarkets,
  ResolveSnapshot,
  RootLp,
  Scenario,
  ScenarioInfo,
  SeedPreview,
  SeedVault,
  Tier,
  TierConfig,
  TierConfigResult,
  TokenAmount,
  TradeSnapshot,
  VoidReason,
  World,
  WorldPrice,
  WorldStatus,
  WorldSupply,
} from "./domain";
import type { Order } from "./orders";
import type {
  AccountViewJson,
  AdminViewJson,
  AppConfigView,
  Asset,
  BooksAssetJson,
  BooksJson,
  BorrowersPageJson,
  BorrowViewJson,
  CollateralValuesJson,
  ContractVersionJson,
  EventCheckJson,
  EventMetaJson,
  EventViewJson,
  FomcDatesJson,
  HealthViewJson,
  LendingTierJson,
  LendViewJson,
  LiquidationQuoteJson,
  LiquidationStatusJson,
  ListMarketsJson,
  ListProposalsJson,
  LpPreviewJson,
  MarketCardJson,
  MarketCheckJson,
  MarketOfEventsJson,
  MarketParamsViewJson,
  MarketPriceCfgJson,
  MarketViewJson,
  MtTokenJson,
  NearBooksJson,
  OpeningPreviewJson,
  OrderViewJson,
  OutLayerConfigJson,
  PauseStateJson,
  PledgePreviewJson,
  PledgeViewJson,
  PriceCheckJson,
  ProposalSummaryJson,
  ProposalViewJson,
  ReferenceConfigJson,
  ReferenceJson,
  RelatedMarketsJson,
  ResolveViewJson,
  RootLpViewJson,
  ScenarioInfoJson,
  ScenarioViewJson,
  SeedVaultJson,
  SeedWithdrawPreviewJson,
  TierConfigResultJson,
  TierConfigViewJson,
  TradeViewJson,
  WorldPriceJson,
  WorldSupplyJson,
  WorldViewJson,
} from "./types";

export const big = (v: string | number | null | undefined): bigint => {
  if (v === null || v === undefined || v === "") return 0n;
  return BigInt(typeof v === "number" ? Math.trunc(v) : v);
};

// ---- strict helpers for v2 keys ----

/**
 * The view and this build disagree on a field's shape: the contract is not the one this build was made for. The message
 * is what the screen's ChainWait shows; `detail` names the field.
 */
export class ViewShapeError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`This build does not match the contract: reload, or tell the operator. (${detail})`);
    this.name = "ViewShapeError";
    this.detail = detail;
  }
}

/** A value the v2 contract always sends; missing means the build and the contract disagree. */
export function need<T>(v: T | undefined, path: string): T {
  if (v === undefined) throw new ViewShapeError(`${path} missing`);
  return v;
}

/** A required U128 or integer: a decimal string (or a safe integer), never null. */
export function bigNeed(v: string | number | null | undefined, path: string): bigint {
  if (v === undefined) throw new ViewShapeError(`${path} missing`);
  if (v === null) throw new ViewShapeError(`${path} is null`);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new ViewShapeError(`${path} is not an integer: ${v}`);
    return BigInt(v);
  }
  if (typeof v !== "string" || !/^-?\d+$/.test(v)) throw new ViewShapeError(`${path} is not an integer: ${JSON.stringify(v)}`);
  return BigInt(v);
}

/** A U128 the SPEC types as optional: the key must be there, null allowed. */
export function bigOrNull(v: string | number | null | undefined, path: string): bigint | null {
  if (v === undefined) throw new ViewShapeError(`${path} missing`);
  return v === null ? null : bigNeed(v, path);
}

/** A u8/u32/u64 the view sends as a JSON number. */
export function numNeed(v: number | null | undefined, path: string): number {
  if (v === undefined) throw new ViewShapeError(`${path} missing`);
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new ViewShapeError(`${path} is not an integer: ${JSON.stringify(v)}`);
  return v;
}

export function numOrNull(v: number | null | undefined, path: string): number | null {
  if (v === undefined) throw new ViewShapeError(`${path} missing`);
  return v === null ? null : numNeed(v, path);
}

export function boolNeed(v: boolean | null | undefined, path: string): boolean {
  if (typeof v !== "boolean") throw new ViewShapeError(v === undefined ? `${path} missing` : `${path} is not a boolean`);
  return v;
}

export function strNeed(v: string | null | undefined, path: string): string {
  if (typeof v !== "string") throw new ViewShapeError(v === undefined ? `${path} missing` : `${path} is not a string`);
  return v;
}

export function strOrNull(v: string | null | undefined, path: string): string | null {
  if (v === undefined) throw new ViewShapeError(`${path} missing`);
  return v === null ? null : strNeed(v, path);
}

export function arrNeed<T>(v: readonly T[] | null | undefined, path: string): readonly T[] {
  if (!Array.isArray(v)) throw new ViewShapeError(v === undefined ? `${path} missing` : `${path} is not a list`);
  return v;
}

/** One of a closed set of strings (an enum the contract serialises in snake_case). */
export function oneOf<T extends string>(v: string | null | undefined, values: readonly T[], path: string): T {
  if (v === undefined) throw new ViewShapeError(`${path} missing`);
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) throw new ViewShapeError(`${path} is not one of ${values.join(", ")}: ${JSON.stringify(v)}`);
  return v as T;
}

export const TIER_NAMES: readonly Tier[] = ["safe", "normal", "bold"];
const PAUSE_FLAGS: readonly PauseFlag[] = ["trade", "mint", "transfer", "lend", "liquidate", "oracle", "pledge", "exit"];
const WORLD_STATUSES: readonly WorldStatus[] = ["no_pool", "young", "shallow", "out_of_band", "trusted"];
const LIQUIDATION_STATES: readonly LiquidationState[] = ["none", "paused", "paused_halted", "paused_reference", "paused_no_price", "liquidatable"];
const MARKET_STATUSES: readonly MarketStatus[] = ["open", "deciding", "partly_resolved", "resolved"];
const PROPOSAL_STATUSES: readonly ProposalStatus[] = ["review", "pledging", "ready", "waiting", "opened", "rejected", "cancelled", "expired", "void"];
const SUMMARY_STATUSES: readonly ProposalStatus[] = ["review", "pledging", "opened", "rejected", "cancelled", "expired", "void"];
const VOID_REASONS: readonly VoidReason[] = ["none", "review_timeout", "event_resolved", "event_full", "market_exists", "evicted"];
const ASSETS: readonly Asset[] = ["wnear", "usdc"];

/** "normal" | "safe" | "bold", else ViewShapeError. */
export const tierOf = (t: string | null | undefined, path: string): Tier => oneOf(t, TIER_NAMES, path);

const bigs = (v: readonly (string | number)[] | null | undefined, path: string): bigint[] => arrNeed(v, path).map((x, i) => bigNeed(x, `${path}[${i}]`));
const nums = (v: readonly number[] | null | undefined, path: string): number[] => arrNeed(v, path).map((x, i) => numNeed(x, `${path}[${i}]`));
const assetOrNull = (v: string | null | undefined, path: string): Asset | null => (need(v, path) === null ? null : oneOf(v, ASSETS, path));

// ---- v1 views (unchanged keys) ----

export function decodeWorld(w: WorldViewJson): World {
  return {
    index: w.index,
    mask: w.mask,
    label: w.label,
    possible: w.possible,
    poolInitialized: w.pool_initialized,
    wnearPrice: big(w.wnear_price),
    backed: w.backed,
    wnearTokenId: w.wnear_token_id,
    usdcTokenId: w.usdc_token_id,
    userWnear: big(w.user_wnear),
    userUsdc: big(w.user_usdc),
    collateralWnear: big(w.collateral_wnear),
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

export const decodeScenarioInfo = (s: ScenarioInfoJson): ScenarioInfo => ({
  scenarioId: s.scenario_id,
  eventIds: s.event_ids,
  outcomeCounts: s.outcome_counts,
  worldCount: s.world_count,
  root: s.root,
  possible: s.possible,
  resolutionCount: s.resolution_count,
  resolvedEvents: s.resolved_events,
  halted: s.halted,
  poolIds: s.pool_ids,
});

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

const WAD = 10n ** 18n;

const ACCOUNT_V2_KEYS = [
  "tier",
  "borrow_ltv",
  "borrow_health_factor",
  "borrow_limit",
  "max_borrow",
  "liquidation_bonus",
  "insurance",
  "min_loan",
  "frozen",
  "max_repay",
  "write_off_ready",
  "world_status",
  "borrow_block",
  "liquidation_factor",
] as const;

/** An AccountView: v1 keys always; the v2 keys strictly once any of them is there (`v2`: required). */
export function decodeAccount(a: AccountViewJson, path = "account", v2?: boolean): Account {
  const isV2 = v2 ?? ACCOUNT_V2_KEYS.some((k) => k in a);
  const debt = big(a.debt);
  const healthFactor = a.health_factor === null ? null : big(a.health_factor);
  const lltv = big(a.lltv);
  const base = {
    debt,
    healthFactor,
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
    lltv,
    unpricedWorld: a.unpriced_world ?? null,
  };
  if (!isV2) {
    return {
      ...base,
      liquidation: a.liquidation,
      tier: "normal",
      borrowLtv: lltv,
      borrowHealthFactor: healthFactor,
      borrowLimit: 0n,
      maxBorrow: 0n,
      liquidationBonus: 0n,
      insurance: 0n,
      minLoan: 0n,
      frozen: false,
      maxRepay: debt,
      writeOffReady: false,
      worldStatus: a.world_price_ok.map((ok) => (ok ? "trusted" : "no_pool")),
      borrowBlock: null,
      liquidationFactor: WAD,
    };
  }
  return {
    ...base,
    liquidation: oneOf(a.liquidation, LIQUIDATION_STATES, `${path}.liquidation`),
    tier: tierOf(a.tier, `${path}.tier`),
    borrowLtv: bigNeed(a.borrow_ltv, `${path}.borrow_ltv`),
    borrowHealthFactor: bigOrNull(a.borrow_health_factor, `${path}.borrow_health_factor`),
    borrowLimit: bigNeed(a.borrow_limit, `${path}.borrow_limit`),
    maxBorrow: bigNeed(a.max_borrow, `${path}.max_borrow`),
    liquidationBonus: bigNeed(a.liquidation_bonus, `${path}.liquidation_bonus`),
    insurance: bigNeed(a.insurance, `${path}.insurance`),
    minLoan: bigNeed(a.min_loan, `${path}.min_loan`),
    frozen: boolNeed(a.frozen, `${path}.frozen`),
    maxRepay: bigNeed(a.max_repay, `${path}.max_repay`),
    writeOffReady: boolNeed(a.write_off_ready, `${path}.write_off_ready`),
    worldStatus: arrNeed(a.world_status, `${path}.world_status`).map((s, i) => oneOf(s, WORLD_STATUSES, `${path}.world_status[${i}]`)),
    borrowBlock: strOrNull(a.borrow_block, `${path}.borrow_block`),
    liquidationFactor: bigNeed(a.liquidation_factor, `${path}.liquidation_factor`),
  };
}

export function decodeRootLp(r: RootLpViewJson): RootLp {
  return {
    shareSupply: big(r.share_supply),
    yourShares: big(r.your_shares),
    shareDecimals: r.share_decimals,
    previewWithdraw: r.preview_withdraw ? { wnear: r.preview_withdraw.wnear.map(big), usdc: r.preview_withdraw.usdc.map(big) } : null,
    holdings: r.holdings.map((h) => ({
      world: h.world,
      wnearIdle: big(h.wnear_idle),
      usdcIdle: big(h.usdc_idle),
      wnearFees: big(h.wnear_fees),
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
  account: decodeAccount(v.account, "borrow_view.account"),
  nowSec: big(v.now_sec),
});

export const decodeLend = (v: LendViewJson): LendSnapshot => ({
  account: decodeAccount(v.account, "lend_view.account"),
  rootLp: v.root_lp ? decodeRootLp(v.root_lp) : null,
  worlds: [...v.worlds].sort((a, b) => a.index - b.index),
});

export const decodeResolve = (v: ResolveViewJson): ResolveSnapshot => ({
  scenario: decodeScenario(v.scenario),
  events: v.events.map(decodeEvent),
  pastFedEvent: v.past_fed_event ? decodeEvent(v.past_fed_event) : null,
  account: decodeAccount(v.account, "resolve_view.account"),
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

const CONFIG_V2_KEYS = [
  "code_version",
  "state_version",
  "paused",
  "guardian_id",
  "pending_owner_id",
  "max_worlds",
  "max_events",
  "max_trade_fills",
  "max_trade_fills_8w",
  "reference_configured",
  "proposal_count",
  "lending",
] as const;

/** What a v1 contract's single lending market was, as the three v2 tier configs (the version gate turns it away). */
function v1Lending(c: AppConfigView): LendingConfig {
  const lltv = big(c.lltv);
  const cfg: TierConfig = {
    lltv,
    borrowLtv: lltv,
    liquidationBonus: big(c.liquidation_bonus),
    reserveFactor: 0n,
    rateBase: big(c.borrow_rate_per_sec),
    rateSlope1: 0n,
    rateSlope2: 0n,
    rateKink: WAD,
    maxUtilization: WAD,
    borrowCap: null,
  };
  return { minLoan: 0n, fullLiquidationHf: 0n, smallLoan: 0n, closeFactor: WAD / 2n, maxCollateralPieces: 20, defaults: { safe: cfg, normal: cfg, bold: cfg } };
}

function decodeLending(l: AppConfigView["lending"], path: string): LendingConfig {
  const lending = need(l, path);
  const defaults: Partial<Record<Tier, TierConfig>> = {};
  arrNeed(lending.defaults, `${path}.defaults`).forEach((d, i) => {
    defaults[tierOf(d.tier, `${path}.defaults[${i}].tier`)] = decodeTierConfig(d.config, `${path}.defaults[${i}].config`);
  });
  for (const t of TIER_NAMES) if (!defaults[t]) throw new ViewShapeError(`${path}.defaults has no ${t} tier`);
  return {
    minLoan: bigNeed(lending.min_loan, `${path}.min_loan`),
    fullLiquidationHf: bigNeed(lending.full_liquidation_hf, `${path}.full_liquidation_hf`),
    smallLoan: bigNeed(lending.small_loan, `${path}.small_loan`),
    closeFactor: bigNeed(lending.close_factor, `${path}.close_factor`),
    maxCollateralPieces: numNeed(lending.max_collateral_pieces, `${path}.max_collateral_pieces`),
    defaults: defaults as Record<Tier, TierConfig>,
  };
}

export function decodeConfig(c: AppConfigView): AppConfig {
  const demo = c.demo && typeof c.demo === "object" ? (c.demo as unknown as Record<string, unknown>) : null;
  const v1 = {
    ownerId: c.owner_id,
    reporterId: c.reporter_id,
    wnear: { tokenId: c.wnear.token_id, decimals: c.wnear.decimals, symbol: c.wnear.symbol },
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
          spiceEvent: idOf(demo.spice_event),
          fedEvent: idOf(demo.fed_event),
          pastFedEvent: idOf(demo.past_fed_event),
          scenario2x2: idOf(demo.scenario_2x2),
          scenarioBinary: idOf(demo.scenario_binary),
        }
      : null,
    spotPoolId: c.spot_pool_id ?? null,
    eventCount: c.event_count,
    scenarioCount: c.scenario_count,
  };
  if (!CONFIG_V2_KEYS.some((k) => k in c)) {
    return {
      ...v1,
      codeVersion: "1.0.0",
      stateVersion: 1,
      paused: [],
      guardianId: null,
      pendingOwnerId: null,
      maxWorlds: 4,
      maxEvents: 2,
      maxTradeFills: 20,
      maxTradeFills8w: 20,
      referenceConfigured: false,
      proposalCount: 0,
      lending: v1Lending(c),
    };
  }
  const p = "get_app_config";
  return {
    ...v1,
    codeVersion: strNeed(c.code_version, `${p}.code_version`),
    stateVersion: numNeed(c.state_version, `${p}.state_version`),
    paused: arrNeed(c.paused, `${p}.paused`).map((f, i) => oneOf(f, PAUSE_FLAGS, `${p}.paused[${i}]`)),
    guardianId: strOrNull(c.guardian_id, `${p}.guardian_id`),
    pendingOwnerId: strOrNull(c.pending_owner_id, `${p}.pending_owner_id`),
    maxWorlds: numNeed(c.max_worlds, `${p}.max_worlds`),
    maxEvents: numNeed(c.max_events, `${p}.max_events`),
    maxTradeFills: numNeed(c.max_trade_fills, `${p}.max_trade_fills`),
    maxTradeFills8w: numNeed(c.max_trade_fills_8w, `${p}.max_trade_fills_8w`),
    referenceConfigured: boolNeed(c.reference_configured, `${p}.reference_configured`),
    proposalCount: numNeed(c.proposal_count, `${p}.proposal_count`),
    lending: decodeLending(c.lending, `${p}.lending`),
  };
}

export const decodeLpPreview = (v: LpPreviewJson): LpPreview => ({
  shares: big(v.shares),
  wnearKept: v.wnear_kept.map(big),
  usdcKept: v.usdc_kept.map(big),
});

// ---- v2 views: OPS ----

/** What a contract without `contract_version` (MethodNotFound) is: v1. */
export const V1_CONTRACT_VERSION: ContractVersion = {
  codeVersion: "1.0.0",
  stateVersion: 1,
  recordedCodeVersion: "1.0.0",
  upgradedAtSec: 0,
  upgradedFrom: "",
  eventVersion: "1.0.0",
  legacyScenarioCount: 0,
};

export function decodeVersion(v: ContractVersionJson, p = "contract_version"): ContractVersion {
  need(v, p);
  return {
    codeVersion: strNeed(v.code_version, `${p}.code_version`),
    stateVersion: numNeed(v.state_version, `${p}.state_version`),
    recordedCodeVersion: strNeed(v.recorded_code_version, `${p}.recorded_code_version`),
    upgradedAtSec: numNeed(v.upgraded_at_sec, `${p}.upgraded_at_sec`),
    upgradedFrom: strNeed(v.upgraded_from, `${p}.upgraded_from`),
    eventVersion: strNeed(v.event_version, `${p}.event_version`),
    legacyScenarioCount: numNeed(v.legacy_scenario_count, `${p}.legacy_scenario_count`),
  };
}

export function decodePause(v: PauseStateJson, p = "pause_state"): PauseState {
  need(v, p);
  return {
    paused: arrNeed(v.paused, `${p}.paused`).map((f, i) => oneOf(f, PAUSE_FLAGS, `${p}.paused[${i}]`)),
    sinceSec: bigNeed(v.since_sec, `${p}.since_sec`),
    liquidationsResumeAtSec: bigNeed(v.liquidations_resume_at_sec, `${p}.liquidations_resume_at_sec`),
    guardianId: strOrNull(v.guardian_id, `${p}.guardian_id`),
    pendingOwnerId: strOrNull(v.pending_owner_id, `${p}.pending_owner_id`),
  };
}

function decodeBooksAsset(a: BooksAssetJson, p: string): BooksAsset {
  need(a, p);
  return {
    reserves: bigNeed(a.reserves, `${p}.reserves`),
    lendingCash: bigNeed(a.lending_cash, `${p}.lending_cash`),
    insurance: bigNeed(a.insurance, `${p}.insurance`),
    internal: bigNeed(a.internal, `${p}.internal`),
    collateral: bigNeed(a.collateral, `${p}.collateral`),
    spotPool: bigNeed(a.spot_pool, `${p}.spot_pool`),
    pledges: bigNeed(a.pledges, `${p}.pledges`),
    total: bigNeed(a.total, `${p}.total`),
  };
}

export const decodeBooks = (v: BooksJson, p = "books"): Books => ({
  fromScenario: numNeed(v.from_scenario, `${p}.from_scenario`),
  nextScenario: numOrNull(v.next_scenario, `${p}.next_scenario`),
  wnear: decodeBooksAsset(v.wnear, `${p}.wnear`),
  usdc: decodeBooksAsset(v.usdc, `${p}.usdc`),
});

export const decodeNearBooks = (v: NearBooksJson, p = "near_books"): NearBooks => ({
  balance: bigNeed(v.balance, `${p}.balance`),
  storageStake: bigNeed(v.storage_stake, `${p}.storage_stake`),
  nep145Available: bigNeed(v.nep145_available, `${p}.nep145_available`),
  nearHeld: bigNeed(v.near_held, `${p}.near_held`),
  storageFund: bigNeed(v.storage_fund, `${p}.storage_fund`),
  ownFree: bigNeed(v.own_free, `${p}.own_free`),
});

// ---- EW ----

export const decodeWorldSupply = (v: WorldSupplyJson, p = "world_supply"): WorldSupply => ({
  scenarioId: numNeed(v.scenario_id, `${p}.scenario_id`),
  possible: numNeed(v.possible, `${p}.possible`),
  wnearReserves: bigNeed(v.wnear_reserves, `${p}.wnear_reserves`),
  usdcReserves: bigNeed(v.usdc_reserves, `${p}.usdc_reserves`),
  wnear: bigs(v.wnear, `${p}.wnear`),
  usdc: bigs(v.usdc, `${p}.usdc`),
});

/** `markets_of(account_id)`: scenario ids, ascending. */
export const decodeMarketsOf = (v: number[], p = "markets_of"): number[] => nums(v, p);

/** `<scenario>:<asset>:<mask>`, the NEP-245 id of a verse token; undefined for anything else. */
export function parseVerseTokenId(tokenId: string): { scenarioId: number; asset: Asset; mask: number } | undefined {
  const m = /^(\d+):(wnear|usdc):(\d+)$/.exec(tokenId);
  if (!m) return undefined;
  const scenarioId = Number(m[1]);
  const mask = Number(m[3]);
  if (!Number.isSafeInteger(scenarioId) || mask < 1 || mask > 255) return undefined;
  return { scenarioId, asset: m[2] as Asset, mask };
}

/** `mt_tokens_for_owner` rows with their `mt_batch_balance_of` amounts (same order): the verse tokens held, zeros dropped. */
export function decodeHoldings(tokens: MtTokenJson[], balances: (string | number)[], p = "mt_tokens_for_owner"): Holding[] {
  const rows = arrNeed(tokens, p);
  const amounts = bigs(balances, "mt_batch_balance_of");
  if (amounts.length !== rows.length) throw new ViewShapeError(`mt_batch_balance_of has ${amounts.length} amounts for ${rows.length} tokens`);
  const out: Holding[] = [];
  rows.forEach((t, i) => {
    const id = strNeed(t.token_id, `${p}[${i}].token_id`);
    const parsed = parseVerseTokenId(id);
    if (parsed && amounts[i] > 0n) out.push({ tokenId: id, ...parsed, amount: amounts[i] });
  });
  return out;
}

// ---- PRC ----

export const decodeWorldPrice = (w: WorldPriceJson, p: string): WorldPrice => ({
  world: numNeed(w.world, `${p}.world`),
  status: oneOf(w.status, WORLD_STATUSES, `${p}.status`),
  twap: bigNeed(w.twap, `${p}.twap`),
  spot: bigNeed(w.spot, `${p}.spot`),
  borrowPrice: bigNeed(w.borrow_price, `${p}.borrow_price`),
  liquidationPrice: bigNeed(w.liquidation_price, `${p}.liquidation_price`),
  depth: bigNeed(w.depth, `${p}.depth`),
  ageSec: numNeed(w.age_sec, `${p}.age_sec`),
  fullWindow: boolNeed(w.full_window, `${p}.full_window`),
});

/** `world_prices(scenario_id)`, ordered by world. */
export const decodeWorldPrices = (v: WorldPriceJson[], p = "world_prices"): WorldPrice[] =>
  arrNeed(v, p)
    .map((w, i) => decodeWorldPrice(w, `${p}[${i}]`))
    .sort((a, b) => a.world - b.world);

export const decodePriceCfg = (c: MarketPriceCfgJson, p = "price_config"): MarketPriceCfg => ({
  minAgeSec: numNeed(need(c, p).min_age_sec, `${p}.min_age_sec`),
  minDepth: bigNeed(c.min_depth, `${p}.min_depth`),
  reference: boolNeed(c.reference, `${p}.reference`),
  maxDeviation: bigNeed(c.max_deviation, `${p}.max_deviation`),
  maxHaircut: bigNeed(c.max_haircut, `${p}.max_haircut`),
});

export function decodePriceCheck(v: PriceCheckJson, p = "price_check"): PriceCheck {
  const r = need(v.reference, `${p}.reference`);
  return {
    scenarioId: numNeed(v.scenario_id, `${p}.scenario_id`),
    config: decodePriceCfg(v.config, `${p}.config`),
    reference:
      r === null
        ? null
        : {
            price: bigNeed(r.price, `${p}.reference.price`),
            observedAt: numNeed(r.observed_at, `${p}.reference.observed_at`),
            ageSec: numNeed(r.age_sec, `${p}.reference.age_sec`),
            source: oneOf(r.source, ["none", "outlayer", "reporter"] as const, `${p}.reference.source`),
            sourcesUsed: numNeed(r.sources_used, `${p}.reference.sources_used`),
            spreadBps: numNeed(r.spread_bps, `${p}.reference.spread_bps`),
          },
    impliedTwapSpot: bigOrNull(v.implied_twap_spot, `${p}.implied_twap_spot`),
    ratio: bigOrNull(v.ratio, `${p}.ratio`),
    borrowBlock: strOrNull(v.borrow_block, `${p}.borrow_block`),
    borrowFactor: bigNeed(v.borrow_factor, `${p}.borrow_factor`),
    liquidationFactor: bigNeed(v.liquidation_factor, `${p}.liquidation_factor`),
    liquidationGuard: boolNeed(v.liquidation_guard, `${p}.liquidation_guard`),
  };
}

/** `get_reference()`: null before the first price. */
export function decodeReference(v: ReferenceJson | null, p = "get_reference"): Reference | null {
  if (v === null) return null;
  return {
    price: bigNeed(need(v, p).price, `${p}.price`),
    observedAt: numNeed(v.observed_at, `${p}.observed_at`),
    storedAt: numNeed(v.stored_at, `${p}.stored_at`),
    ageSec: numNeed(v.age_sec, `${p}.age_sec`),
    source: strNeed(v.source, `${p}.source`),
    sourcesUsed: numNeed(v.sources_used, `${p}.sources_used`),
    spreadBps: numNeed(v.spread_bps, `${p}.spread_bps`),
    request: numNeed(v.request, `${p}.request`),
    pending: boolNeed(v.pending, `${p}.pending`),
  };
}

function decodeGuest(g: OutLayerConfigJson, p: string): GuestConfig {
  const limits = need(g.resource_limits, `${p}.resource_limits`);
  return {
    outlayerId: strNeed(g.outlayer_id, `${p}.outlayer_id`),
    wasmUrl: strNeed(g.wasm_url, `${p}.wasm_url`),
    wasmSha256: strNeed(g.wasm_sha256, `${p}.wasm_sha256`),
    resourceLimits: {
      maxInstructions: numNeed(limits.max_instructions, `${p}.resource_limits.max_instructions`),
      maxMemoryMb: numNeed(limits.max_memory_mb, `${p}.resource_limits.max_memory_mb`),
      maxExecutionSeconds: numNeed(limits.max_execution_seconds, `${p}.resource_limits.max_execution_seconds`),
    },
    deposit: bigNeed(g.deposit, `${p}.deposit`),
  };
}

/** `get_reference_config()`: null until the owner configures it. */
export function decodeReferenceConfig(v: ReferenceConfigJson | null, p = "get_reference_config"): ReferenceConfig | null {
  if (v === null) return null;
  const guest = need(v.guest, `${p}.guest`);
  return {
    enabled: boolNeed(v.enabled, `${p}.enabled`),
    guest: guest === null ? null : decodeGuest(guest, `${p}.guest`),
    reporterId: strOrNull(v.reporter_id, `${p}.reporter_id`),
    minSources: numNeed(v.min_sources, `${p}.min_sources`),
    maxSpreadBps: numNeed(v.max_spread_bps, `${p}.max_spread_bps`),
    maxResultDelaySec: numNeed(v.max_result_delay_sec, `${p}.max_result_delay_sec`),
    borrowMaxAgeSec: numNeed(v.borrow_max_age_sec, `${p}.borrow_max_age_sec`),
    liquidationMaxAgeSec: numNeed(v.liquidation_max_age_sec, `${p}.liquidation_max_age_sec`),
    minPrice: bigNeed(v.min_price, `${p}.min_price`),
    maxPrice: bigNeed(v.max_price, `${p}.max_price`),
  };
}

/** `get_outlayer_config()`: null until configured. */
export const decodeOutLayerConfig = (v: OutLayerConfigJson | null, p = "get_outlayer_config"): GuestConfig | null => (v === null ? null : decodeGuest(v, p));

export const decodeFomcDates = (v: FomcDatesJson | null, p = "get_outlayer_dates"): FomcDates | null =>
  v === null
    ? null
    : {
        before: strNeed(v.before, `${p}.before`),
        after: strNeed(v.after, `${p}.after`),
        pending: boolNeed(v.pending, `${p}.pending`),
        request: numNeed(v.request, `${p}.request`),
      };

// ---- LEND ----

export function decodeTierConfig(c: TierConfigViewJson, p = "config"): TierConfig {
  need(c, p);
  return {
    lltv: bigNeed(c.lltv, `${p}.lltv`),
    borrowLtv: bigNeed(c.borrow_ltv, `${p}.borrow_ltv`),
    liquidationBonus: bigNeed(c.liquidation_bonus, `${p}.liquidation_bonus`),
    reserveFactor: bigNeed(c.reserve_factor, `${p}.reserve_factor`),
    rateBase: bigNeed(c.rate_base, `${p}.rate_base`),
    rateSlope1: bigNeed(c.rate_slope1, `${p}.rate_slope1`),
    rateSlope2: bigNeed(c.rate_slope2, `${p}.rate_slope2`),
    rateKink: bigNeed(c.rate_kink, `${p}.rate_kink`),
    maxUtilization: bigNeed(c.max_utilization, `${p}.max_utilization`),
    borrowCap: bigOrNull(c.borrow_cap, `${p}.borrow_cap`),
  };
}

/** `market_state(scenario_id, tier?)`. */
export function decodeMarketView(m: MarketViewJson, p = "market_state"): LendingMarket {
  need(m, p);
  return {
    tier: tierOf(m.tier, `${p}.tier`),
    totalSupply: bigNeed(m.total_supply, `${p}.total_supply`),
    totalBorrow: bigNeed(m.total_borrow, `${p}.total_borrow`),
    totalSupplyShares: bigNeed(m.total_supply_shares, `${p}.total_supply_shares`),
    totalBorrowShares: bigNeed(m.total_borrow_shares, `${p}.total_borrow_shares`),
    utilization: bigNeed(m.utilization, `${p}.utilization`),
    supplyRatePerSec: bigNeed(m.supply_rate_per_sec, `${p}.supply_rate_per_sec`),
    borrowRatePerSec: bigNeed(m.borrow_rate_per_sec, `${p}.borrow_rate_per_sec`),
    lastUpdateSec: numNeed(m.last_update_sec, `${p}.last_update_sec`),
    insurance: bigNeed(m.insurance, `${p}.insurance`),
    liquid: bigNeed(m.liquid, `${p}.liquid`),
    badDebtCovered: bigNeed(m.bad_debt_covered, `${p}.bad_debt_covered`),
    badDebtSocialized: bigNeed(m.bad_debt_socialized, `${p}.bad_debt_socialized`),
    borrowers: numNeed(m.borrowers, `${p}.borrowers`),
    frozen: boolNeed(m.frozen, `${p}.frozen`),
    config: decodeTierConfig(m.config, `${p}.config`),
  };
}

export const decodeTierConfigResult = (v: TierConfigResultJson, p = "tier_config"): TierConfigResult => ({
  config: decodeTierConfig(v.config, `${p}.config`),
  frozen: boolNeed(v.frozen, `${p}.frozen`),
  source: oneOf(v.source, ["stored", "default"] as const, `${p}.source`),
});

/** `lending_tiers(scenario_id, account_id?)`: the three tiers in display order (Safe, Normal, Bold). */
export function decodeLendingTiers(v: LendingTierJson[], p = "lending_tiers"): LendingTier[] {
  const rows = arrNeed(v, p).map((t, i) => {
    const tier = tierOf(t.tier, `${p}[${i}].tier`);
    const account = need(t.account, `${p}[${i}].account`);
    return {
      tier,
      market: decodeMarketView(t.market, `${p}[${i}].market`),
      account: account === null ? null : decodeAccount(account, `${p}[${i}].account`, true),
    };
  });
  if (rows.length !== 3 || rows.some((r, i) => r.tier !== TIER_NAMES[i])) {
    throw new ViewShapeError(`${p} is not Safe, Normal, Bold: ${rows.map((r) => r.tier).join(", ")}`);
  }
  return rows;
}

export const decodeLiquidationStatus = (v: LiquidationStatusJson, p = "liquidation_status"): LiquidationStatus => ({
  status: oneOf(v.status, LIQUIDATION_STATES, `${p}.status`),
  unpricedWorld: numOrNull(v.unpriced_world, `${p}.unpriced_world`),
  tier: tierOf(v.tier, `${p}.tier`),
  maxRepay: bigNeed(v.max_repay, `${p}.max_repay`),
  fullSeizeRepay: bigNeed(v.full_seize_repay, `${p}.full_seize_repay`),
  writeOffReady: boolNeed(v.write_off_ready, `${p}.write_off_ready`),
});

export const decodeHealth = (v: HealthViewJson, p = "health_factor"): HealthView => ({
  healthFactor: bigOrNull(v.health_factor, `${p}.health_factor`),
  worstWorld: numOrNull(v.worst_world, `${p}.worst_world`),
});

export const decodeCollateralValues = (v: CollateralValuesJson, p = "collateral_values"): CollateralValues => ({
  values: bigs(v.values, `${p}.values`),
  possible: numNeed(v.possible, `${p}.possible`),
});

export function decodeBorrowers(v: BorrowersPageJson, p = "borrowers"): BorrowersPage {
  return {
    scenarioId: numNeed(v.scenario_id, `${p}.scenario_id`),
    tier: tierOf(v.tier, `${p}.tier`),
    total: numNeed(v.total, `${p}.total`),
    fromIndex: numNeed(v.from_index, `${p}.from_index`),
    nextIndex: numOrNull(v.next_index, `${p}.next_index`),
    nowSec: bigNeed(v.now_sec, `${p}.now_sec`),
    rows: arrNeed(v.rows, `${p}.rows`).map((r, i) => {
      const q = `${p}.rows[${i}]`;
      return {
        index: numNeed(r.index, `${q}.index`),
        accountId: strNeed(r.account_id, `${q}.account_id`),
        debt: bigNeed(r.debt, `${q}.debt`),
        healthFactor: bigOrNull(r.health_factor, `${q}.health_factor`),
        worstWorld: numOrNull(r.worst_world, `${q}.worst_world`),
        cMin: bigNeed(r.c_min, `${q}.c_min`),
        liquidation: oneOf(r.liquidation, LIQUIDATION_STATES, `${q}.liquidation`),
        unpricedWorld: numOrNull(r.unpriced_world, `${q}.unpriced_world`),
        maxRepay: bigNeed(r.max_repay, `${q}.max_repay`),
        fullSeizeRepay: bigNeed(r.full_seize_repay, `${q}.full_seize_repay`),
        writeOffReady: boolNeed(r.write_off_ready, `${q}.write_off_ready`),
      } satisfies BorrowerRow;
    }),
  };
}

export function decodeLiquidationQuote(v: LiquidationQuoteJson, p = "liquidation_quote"): LiquidationQuote {
  const cash = need(v.cash, `${p}.cash`);
  const c = `${p}.cash`;
  return {
    error: strOrNull(v.error, `${p}.error`),
    liquidation: oneOf(v.liquidation, LIQUIDATION_STATES, `${p}.liquidation`),
    debt: bigNeed(v.debt, `${p}.debt`),
    healthFactor: bigOrNull(v.health_factor, `${p}.health_factor`),
    cap: bigNeed(v.cap, `${p}.cap`),
    fullSeizeRepay: bigNeed(v.full_seize_repay, `${p}.full_seize_repay`),
    repay: bigNeed(v.repay, `${p}.repay`),
    target: bigNeed(v.target, `${p}.target`),
    seizeAll: boolNeed(v.seize_all, `${p}.seize_all`),
    writtenOff: bigNeed(v.written_off, `${p}.written_off`),
    priceFactor: bigNeed(v.price_factor, `${p}.price_factor`),
    pieces: arrNeed(v.pieces, `${p}.pieces`).map((x, i) => ({
      piece: strNeed(x.piece, `${p}.pieces[${i}].piece`),
      held: bigNeed(x.held, `${p}.pieces[${i}].held`),
      seized: bigNeed(x.seized, `${p}.pieces[${i}].seized`),
    })),
    cash:
      cash === null
        ? null
        : {
            sold: bigs(cash.sold, `${c}.sold`),
            received: bigs(cash.received, `${c}.received`),
            merged: bigNeed(cash.merged, `${c}.merged`),
            realUsdc: bigNeed(cash.real_usdc, `${c}.real_usdc`),
            redeemed: bigNeed(cash.redeemed, `${c}.redeemed`),
            cash: bigNeed(cash.cash, `${c}.cash`),
            leftUsdc: bigs(cash.left_usdc, `${c}.left_usdc`),
            dead: arrNeed(cash.dead, `${c}.dead`).map((d, i) => strNeed(d, `${c}.dead[${i}]`)),
            guardOk: boolNeed(cash.guard_ok, `${c}.guard_ok`),
          },
  };
}

// ---- MKT ----

export function decodeMarketCard(m: MarketCardJson, p = "market"): MarketCard {
  need(m, p);
  const seed = need(m.seed, `${p}.seed`);
  return {
    scenarioId: numNeed(m.scenario_id, `${p}.scenario_id`),
    listed: boolNeed(m.listed, `${p}.listed`),
    origin: oneOf(m.origin, ["legacy", "owner", "pledged"] as const, `${p}.origin`),
    proposalId: numOrNull(m.proposal_id, `${p}.proposal_id`),
    eventIds: nums(m.event_ids, `${p}.event_ids`),
    worldCount: numNeed(m.world_count, `${p}.world_count`),
    possible: numNeed(m.possible, `${p}.possible`),
    status: oneOf(m.status, MARKET_STATUSES, `${p}.status`),
    categories: nums(m.categories, `${p}.categories`),
    deadlineSec: numNeed(m.deadline_sec, `${p}.deadline_sec`),
    createdAtSec: numNeed(m.created_at_sec, `${p}.created_at_sec`),
    odds: bigs(m.odds, `${p}.odds`),
    oddsKnown: boolNeed(m.odds_known, `${p}.odds_known`),
    worldPrices: bigs(m.world_prices, `${p}.world_prices`),
    impliedSpot: bigNeed(m.implied_spot, `${p}.implied_spot`),
    poolValue: bigNeed(m.pool_value, `${p}.pool_value`),
    minWorldDepth: bigNeed(m.min_world_depth, `${p}.min_world_depth`),
    poolCount: numNeed(m.pool_count, `${p}.pool_count`),
    lendable: boolNeed(m.lendable, `${p}.lendable`),
    seed:
      seed === null
        ? null
        : {
            proposalId: numNeed(seed.proposal_id, `${p}.seed.proposal_id`),
            supply: bigNeed(seed.supply, `${p}.seed.supply`),
            unlockAtSec: numNeed(seed.unlock_at_sec, `${p}.seed.unlock_at_sec`),
          },
  };
}

/** `get_market(scenario_id)`: null for a scenario that does not exist. */
export const decodeMarketCardOrNull = (m: MarketCardJson | null, p = "get_market"): MarketCard | null => (m === null ? null : decodeMarketCard(m, p));

export const decodeMarketCards = (v: MarketCardJson[], p = "market_cards"): MarketCard[] => arrNeed(v, p).map((m, i) => decodeMarketCard(m, `${p}[${i}]`));

export const decodeListMarkets = (v: ListMarketsJson, p = "list_markets"): MarketList => ({
  markets: decodeMarketCards(v.markets, `${p}.markets`),
  nextFrom: numOrNull(v.next_from, `${p}.next_from`),
});

export const decodeRelated = (v: RelatedMarketsJson, p = "related_markets"): RelatedMarkets => ({
  markets: arrNeed(v.markets, `${p}.markets`).map((m, i) => ({
    scenarioId: numNeed(m.scenario_id, `${p}.markets[${i}].scenario_id`),
    eventIds: nums(m.event_ids, `${p}.markets[${i}].event_ids`),
    worldCount: numNeed(m.world_count, `${p}.markets[${i}].world_count`),
    status: oneOf(m.status, MARKET_STATUSES, `${p}.markets[${i}].status`),
    listed: boolNeed(m.listed, `${p}.markets[${i}].listed`),
  })),
  proposals: arrNeed(v.proposals, `${p}.proposals`).map((x, i) => decodeProposalSummary(x, `${p}.proposals[${i}]`)),
});

export const decodeMarketOfEvents = (v: MarketOfEventsJson, p = "market_of_events"): MarketOfEvents => ({
  canonical: nums(v.canonical, `${p}.canonical`),
  listedMarket: numOrNull(v.listed_market, `${p}.listed_market`),
  liveProposal: numOrNull(v.live_proposal, `${p}.live_proposal`),
});

function decodeTerms(t: { odds0_bps: number; mult_bps: [number, number] }, p: string): OpeningTerms {
  need(t, p);
  const mult = nums(t.mult_bps, `${p}.mult_bps`);
  if (mult.length !== 2) throw new ViewShapeError(`${p}.mult_bps has ${mult.length} values, not 2`);
  return { odds0Bps: numNeed(t.odds0_bps, `${p}.odds0_bps`), multBps: [mult[0], mult[1]] };
}

function decodeNewEvent(e: ProposalViewJson["new_event"] | ProposalSummaryJson["new_event"], p: string, full: boolean): NewEvent | null {
  if (need(e, p) === null || e === null) return null;
  const out: NewEvent = {
    question: strNeed(e.question, `${p}.question`),
    outcomeNames: arrNeed(e.outcome_names, `${p}.outcome_names`).map((o, i) => strNeed(o, `${p}.outcome_names[${i}]`)),
    deadlineSec: numNeed(e.deadline_sec, `${p}.deadline_sec`),
    category: numNeed(e.category, `${p}.category`),
    terms: decodeTerms(e.terms, `${p}.terms`),
  };
  if (full) {
    const f = e as NonNullable<ProposalViewJson["new_event"]>;
    out.rule = strNeed(f.rule, `${p}.rule`);
    out.source = strNeed(f.source, `${p}.source`);
  }
  return out;
}

function decodeOpened(o: ProposalSummaryJson["opened"], p: string): Opened | null {
  if (need(o, p) === null || o === null) return null;
  return {
    scenarioId: numNeed(o.scenario_id, `${p}.scenario_id`),
    openedAtSec: numNeed(o.opened_at_sec, `${p}.opened_at_sec`),
    sRef: bigNeed(o.s_ref, `${p}.s_ref`),
    shares: bigNeed(o.shares, `${p}.shares`),
    unlockAtSec: numNeed(o.unlock_at_sec, `${p}.unlock_at_sec`),
  };
}

function decodeProposalCommon(v: ProposalSummaryJson | ProposalViewJson, p: string, statuses: readonly ProposalStatus[], full: boolean): ProposalSummary {
  need(v, p);
  const voidReason = need(v.void_reason, `${p}.void_reason`);
  return {
    proposalId: numNeed(v.proposal_id, `${p}.proposal_id`),
    kind: oneOf(v.kind, ["new_event", "market"] as const, `${p}.kind`),
    proposer: strNeed(v.proposer, `${p}.proposer`),
    status: oneOf(v.status, statuses, `${p}.status`),
    voidReason: voidReason === null ? null : oneOf(voidReason, VOID_REASONS, `${p}.void_reason`),
    blocker: strOrNull(v.blocker, `${p}.blocker`),
    eventIds: nums(v.event_ids, `${p}.event_ids`),
    worldCount: numNeed(v.world_count, `${p}.world_count`),
    newEvent: decodeNewEvent(v.new_event, `${p}.new_event`, full),
    category: numNeed(v.category, `${p}.category`),
    deadlineSec: numNeed(v.deadline_sec, `${p}.deadline_sec`),
    createdAtSec: numNeed(v.created_at_sec, `${p}.created_at_sec`),
    approvedAtSec: numNeed(v.approved_at_sec, `${p}.approved_at_sec`),
    expiresAtSec: numNeed(v.expires_at_sec, `${p}.expires_at_sec`),
    openNotBeforeSec: numNeed(v.open_not_before_sec, `${p}.open_not_before_sec`),
    goal: bigNeed(v.goal, `${p}.goal`),
    idealWnear: bigNeed(v.ideal_wnear, `${p}.ideal_wnear`),
    idealUsdc: bigNeed(v.ideal_usdc, `${p}.ideal_usdc`),
    sHint: bigNeed(v.s_hint, `${p}.s_hint`),
    pledgedWnear: bigNeed(v.pledged_wnear, `${p}.pledged_wnear`),
    pledgedUsdc: bigNeed(v.pledged_usdc, `${p}.pledged_usdc`),
    pledgers: numNeed(v.pledgers, `${p}.pledgers`),
    progressBps: numNeed(v.progress_bps, `${p}.progress_bps`),
    bond: bigNeed(v.bond, `${p}.bond`),
    reserve: bigNeed(v.reserve, `${p}.reserve`),
    seedLockSec: numNeed(v.seed_lock_sec, `${p}.seed_lock_sec`),
    opened: decodeOpened(v.opened, `${p}.opened`),
  };
}

/** A list row: no preview, no rule or source, never ready/waiting. */
export const decodeProposalSummary = (v: ProposalSummaryJson, p = "proposal"): ProposalSummary => decodeProposalCommon(v, p, SUMMARY_STATUSES, false);

/** `get_proposal(proposal_id)`: null for an unknown id. */
export function decodeProposal(v: ProposalViewJson | null, p = "get_proposal"): Proposal | null {
  if (v === null) return null;
  const preview = need(v.preview, `${p}.preview`);
  return { ...decodeProposalCommon(v, p, PROPOSAL_STATUSES, true), preview: preview === null ? null : decodeOpeningPreview(preview, `${p}.preview`) };
}

export const decodeProposalList = (v: ListProposalsJson, p = "list_proposals"): ProposalList => ({
  proposals: arrNeed(v.proposals, `${p}.proposals`).map((x, i) => decodeProposalSummary(x, `${p}.proposals[${i}]`)),
  nextFrom: numOrNull(v.next_from, `${p}.next_from`),
});

export const decodeProposalSummaries = (v: ProposalSummaryJson[], p = "proposals_of_event"): ProposalSummary[] =>
  arrNeed(v, p).map((x, i) => decodeProposalSummary(x, `${p}[${i}]`));

const tokenAmounts = (v: { token_id: string; amount: string }[], p: string): TokenAmount[] =>
  arrNeed(v, p).map((t, i) => ({ tokenId: strNeed(t.token_id, `${p}[${i}].token_id`), amount: bigNeed(t.amount, `${p}[${i}].amount`) }));

export function decodeOpeningPreview(v: OpeningPreviewJson, p = "opening_preview"): OpeningPreview {
  need(v, p);
  return {
    canOpen: boolNeed(v.can_open, `${p}.can_open`),
    blocker: strOrNull(v.blocker, `${p}.blocker`),
    sRef: bigOrNull(v.s_ref, `${p}.s_ref`),
    anchors: arrNeed(v.anchors, `${p}.anchors`).map((a, i) => ({
      scenarioId: numNeed(a.scenario_id, `${p}.anchors[${i}].scenario_id`),
      implied: bigNeed(a.implied, `${p}.anchors[${i}].implied`),
    })),
    references: arrNeed(v.references, `${p}.references`).map((r, i) => {
      const q = `${p}.references[${i}]`;
      return {
        eventId: numNeed(r.event_id, `${q}.event_id`),
        scenarioId: numNeed(r.scenario_id, `${q}.scenario_id`),
        odds0: bigNeed(r.odds0, `${q}.odds0`),
        ratio0: bigNeed(r.ratio0, `${q}.ratio0`),
        ratio1: bigNeed(r.ratio1, `${q}.ratio1`),
        implied: bigNeed(r.implied, `${q}.implied`),
      };
    }),
    odds: bigs(v.odds, `${p}.odds`),
    prices: bigs(v.prices, `${p}.prices`),
    usableValue: bigNeed(v.usable_value, `${p}.usable_value`),
    usedWnear: bigNeed(v.used_wnear, `${p}.used_wnear`),
    usedUsdc: bigNeed(v.used_usdc, `${p}.used_usdc`),
    unusedWnear: bigNeed(v.unused_wnear, `${p}.unused_wnear`),
    unusedUsdc: bigNeed(v.unused_usdc, `${p}.unused_usdc`),
    worldPools: arrNeed(v.world_pools, `${p}.world_pools`).map((w, i) => ({
      world: numNeed(w.world, `${p}.world_pools[${i}].world`),
      wnear: bigNeed(w.wnear, `${p}.world_pools[${i}].wnear`),
      usdc: bigNeed(w.usdc, `${p}.world_pools[${i}].usdc`),
    })),
    oddsPools: arrNeed(v.odds_pools, `${p}.odds_pools`).map((o, i) => ({
      mask0: numNeed(o.mask0, `${p}.odds_pools[${i}].mask0`),
      mask1: numNeed(o.mask1, `${p}.odds_pools[${i}].mask1`),
      amount0: bigNeed(o.amount0, `${p}.odds_pools[${i}].amount0`),
      amount1: bigNeed(o.amount1, `${p}.odds_pools[${i}].amount1`),
    })),
    idle: tokenAmounts(v.idle, `${p}.idle`),
    idleValue: bigNeed(v.idle_value, `${p}.idle_value`),
    thinnestWorldUsdc: bigNeed(v.thinnest_world_usdc, `${p}.thinnest_world_usdc`),
    needs: assetOrNull(v.needs, `${p}.needs`),
    storageEstimate: bigNeed(v.storage_estimate, `${p}.storage_estimate`),
    reserveAvailable: bigNeed(v.reserve_available, `${p}.reserve_available`),
  };
}

export function decodePledge(v: PledgeViewJson, p = "pledge"): Pledge {
  need(v, p);
  return {
    proposalId: numNeed(v.proposal_id, `${p}.proposal_id`),
    accountId: strNeed(v.account_id, `${p}.account_id`),
    wnear: bigNeed(v.wnear, `${p}.wnear`),
    usdc: bigNeed(v.usdc, `${p}.usdc`),
    state: oneOf(v.state, ["pledged", "refundable", "seed"] as const, `${p}.state`),
    shares: bigOrNull(v.shares, `${p}.shares`),
    withdrawnShares: bigNeed(v.withdrawn_shares, `${p}.withdrawn_shares`),
    unusedWnear: bigNeed(v.unused_wnear, `${p}.unused_wnear`),
    unusedUsdc: bigNeed(v.unused_usdc, `${p}.unused_usdc`),
    unusedPaid: boolNeed(v.unused_paid, `${p}.unused_paid`),
    unlockAtSec: numNeed(v.unlock_at_sec, `${p}.unlock_at_sec`),
    maxWithdrawableShares: bigNeed(v.max_withdrawable_shares, `${p}.max_withdrawable_shares`),
  };
}

/** `pledge_of(proposal_id, account_id)`: null without a pledge. */
export const decodePledgeOrNull = (v: PledgeViewJson | null, p = "pledge_of"): Pledge | null => (v === null ? null : decodePledge(v, p));
export const decodePledges = (v: PledgeViewJson[], p = "pledges_of"): Pledge[] => arrNeed(v, p).map((x, i) => decodePledge(x, `${p}[${i}]`));

export const decodePledgePreview = (v: PledgePreviewJson, p = "pledge_preview"): PledgePreview => ({
  usableBefore: bigNeed(v.usable_before, `${p}.usable_before`),
  usableAfter: bigNeed(v.usable_after, `${p}.usable_after`),
  deployedPart: bigNeed(v.deployed_part, `${p}.deployed_part`),
  goalReachedAfter: boolNeed(v.goal_reached_after, `${p}.goal_reached_after`),
  needs: assetOrNull(v.needs, `${p}.needs`),
});

function pair(v: readonly number[] | undefined, p: string): [number, number] {
  const n = nums(v, p);
  if (n.length !== 2) throw new ViewShapeError(`${p} has ${n.length} values, not 2`);
  return [n[0], n[1]];
}

export function decodeMarketParams(v: MarketParamsViewJson, p = "market_params"): MarketParamsView {
  const x = need(v.params, `${p}.params`);
  const q = `${p}.params`;
  const anchors = nums(x.anchors, `${q}.anchors`);
  if (anchors.length !== 3) throw new ViewShapeError(`${q}.anchors has ${anchors.length} values, not 3`);
  const params: MarketParams = {
    bondNewEvent: bigNeed(x.bond_new_event, `${q}.bond_new_event`),
    bondMarket: bigNeed(x.bond_market, `${q}.bond_market`),
    reserveBase: bigNeed(x.reserve_base, `${q}.reserve_base`),
    reservePerWorld: bigNeed(x.reserve_per_world, `${q}.reserve_per_world`),
    proposalTtlSec: numNeed(x.proposal_ttl_sec, `${q}.proposal_ttl_sec`),
    reviewTtlSec: numNeed(x.review_ttl_sec, `${q}.review_ttl_sec`),
    minPledgeWindowSec: numNeed(x.min_pledge_window_sec, `${q}.min_pledge_window_sec`),
    minMarketLifeSec: numNeed(x.min_market_life_sec, `${q}.min_market_life_sec`),
    noticeSec: numNeed(x.notice_sec, `${q}.notice_sec`),
    seedLockSec: numNeed(x.seed_lock_sec, `${q}.seed_lock_sec`),
    evictMinAgeSec: numNeed(x.evict_min_age_sec, `${q}.evict_min_age_sec`),
    spamFloorBps: numNeed(x.spam_floor_bps, `${q}.spam_floor_bps`),
    goalDepthUsdc: bigNeed(x.goal_depth_usdc, `${q}.goal_depth_usdc`),
    minOpenDepthUsdc: bigNeed(x.min_open_depth_usdc, `${q}.min_open_depth_usdc`),
    minGoalUsdc: bigNeed(x.min_goal_usdc, `${q}.min_goal_usdc`),
    goalRoundUsdc: bigNeed(x.goal_round_usdc, `${q}.goal_round_usdc`),
    betaBps: numNeed(x.beta_bps, `${q}.beta_bps`),
    oddsClampBps: numNeed(x.odds_clamp_bps, `${q}.odds_clamp_bps`),
    multABps: pair(x.mult_a_bps, `${q}.mult_a_bps`),
    multBBps: pair(x.mult_b_bps, `${q}.mult_b_bps`),
    anchors: [anchors[0], anchors[1], anchors[2]],
    maxAnchorDivergenceBps: numNeed(x.max_anchor_divergence_bps, `${q}.max_anchor_divergence_bps`),
    maxReferenceDivergenceBps: numNeed(x.max_reference_divergence_bps, `${q}.max_reference_divergence_bps`),
    minReferenceDepthUsdc: bigNeed(x.min_reference_depth_usdc, `${q}.min_reference_depth_usdc`),
    minReferenceOddsDepthUsdc: bigNeed(x.min_reference_odds_depth_usdc, `${q}.min_reference_odds_depth_usdc`),
    requireExternal: boolNeed(x.require_external, `${q}.require_external`),
    maxExternalDivergenceBps: numNeed(x.max_external_divergence_bps, `${q}.max_external_divergence_bps`),
    minPledgeUsdc: bigNeed(x.min_pledge_usdc, `${q}.min_pledge_usdc`),
    minPledgeWnear: bigNeed(x.min_pledge_wnear, `${q}.min_pledge_wnear`),
    maxPledgesPerAccount: numNeed(x.max_pledges_per_account, `${q}.max_pledges_per_account`),
    maxActivePerAccount: numNeed(x.max_active_per_account, `${q}.max_active_per_account`),
    maxLivePerEvent: numNeed(x.max_live_per_event, `${q}.max_live_per_event`),
    seedDepthFloor: boolNeed(x.seed_depth_floor, `${q}.seed_depth_floor`),
  };
  return {
    params,
    reserveW2: bigNeed(v.reserve_w2, `${p}.reserve_w2`),
    reserveW4: bigNeed(v.reserve_w4, `${p}.reserve_w4`),
    reserveW8: bigNeed(v.reserve_w8, `${p}.reserve_w8`),
    storageFund: bigNeed(v.storage_fund, `${p}.storage_fund`),
  };
}

export const decodeMarketCheck = (v: MarketCheckJson, p = "market_check"): MarketCheck => ({
  canonical: nums(v.canonical, `${p}.canonical`),
  worldCount: numNeed(v.world_count, `${p}.world_count`),
  blocker: strOrNull(v.blocker, `${p}.blocker`),
  listedMarket: numOrNull(v.listed_market, `${p}.listed_market`),
  liveProposal: numOrNull(v.live_proposal, `${p}.live_proposal`),
  goal: bigNeed(v.goal, `${p}.goal`),
  idealWnear: bigNeed(v.ideal_wnear, `${p}.ideal_wnear`),
  idealUsdc: bigNeed(v.ideal_usdc, `${p}.ideal_usdc`),
  bond: bigNeed(v.bond, `${p}.bond`),
  reserve: bigNeed(v.reserve, `${p}.reserve`),
  expiresAtSec: numNeed(v.expires_at_sec, `${p}.expires_at_sec`),
});

export function decodeEventCheck(v: EventCheckJson, p = "event_check"): EventCheck {
  const odds = bigs(v.odds, `${p}.odds`);
  const prices = bigs(v.prices, `${p}.prices`);
  if (odds.length !== 2 || prices.length !== 2) throw new ViewShapeError(`${p} odds and prices need two values each`);
  return {
    blocker: strOrNull(v.blocker, `${p}.blocker`),
    liveProposal: numOrNull(v.live_proposal, `${p}.live_proposal`),
    goal: bigNeed(v.goal, `${p}.goal`),
    idealWnear: bigNeed(v.ideal_wnear, `${p}.ideal_wnear`),
    idealUsdc: bigNeed(v.ideal_usdc, `${p}.ideal_usdc`),
    sRef: bigOrNull(v.s_ref, `${p}.s_ref`),
    odds: [odds[0], odds[1]],
    prices: [prices[0], prices[1]],
    bond: bigNeed(v.bond, `${p}.bond`),
    reserve: bigNeed(v.reserve, `${p}.reserve`),
  };
}

/** `event_meta(event_id)`: null for an event without one. */
export function decodeEventMeta(v: EventMetaJson | null, p = "event_meta"): EventMeta | null {
  if (v === null) return null;
  return {
    eventId: numNeed(need(v, p).event_id, `${p}.event_id`),
    proposalId: numNeed(v.proposal_id, `${p}.proposal_id`),
    proposer: strOrNull(v.proposer, `${p}.proposer`),
    source: strNeed(v.source, `${p}.source`),
    category: numNeed(v.category, `${p}.category`),
  };
}

/** `seed_vault(scenario_id)`: null for a market that was not opened from pledges. */
export function decodeSeedVault(v: SeedVaultJson | null, p = "seed_vault"): SeedVault | null {
  if (v === null) return null;
  return {
    proposalId: numNeed(need(v, p).proposal_id, `${p}.proposal_id`),
    supply: bigNeed(v.supply, `${p}.supply`),
    unlockAtSec: numNeed(v.unlock_at_sec, `${p}.unlock_at_sec`),
    positions: arrNeed(v.positions, `${p}.positions`).map((x, i) => {
      const q = `${p}.positions[${i}]`;
      return {
        poolId: numNeed(x.pool_id, `${q}.pool_id`),
        liquidity: bigNeed(x.liquidity, `${q}.liquidity`),
        amount0: bigNeed(x.amount0, `${q}.amount0`),
        amount1: bigNeed(x.amount1, `${q}.amount1`),
        fees0: bigNeed(x.fees0, `${q}.fees0`),
        fees1: bigNeed(x.fees1, `${q}.fees1`),
      };
    }),
    idle: tokenAmounts(v.idle, `${p}.idle`),
  };
}

export function decodeSeedPreview(v: SeedWithdrawPreviewJson, p = "preview_seed_withdraw"): SeedPreview {
  const perWorld = need(v.per_world, `${p}.per_world`);
  return {
    wnearOut: bigNeed(v.wnear_out, `${p}.wnear_out`),
    usdcOut: bigNeed(v.usdc_out, `${p}.usdc_out`),
    tokens: tokenAmounts(v.tokens, `${p}.tokens`),
    maxShares: bigNeed(v.max_shares, `${p}.max_shares`),
    lockedUntilSec: numNeed(v.locked_until_sec, `${p}.locked_until_sec`),
    perWorld: { wnear: bigs(perWorld.wnear, `${p}.per_world.wnear`), usdc: bigs(perWorld.usdc, `${p}.per_world.usdc`) },
  };
}

/** `get_events(event_ids)` (SPEC.md K6): the v1 EventView, same order as asked. */
export const decodeEvents = (v: EventViewJson[], p = "get_events"): EventState[] => arrNeed(v, p).map(decodeEvent);
