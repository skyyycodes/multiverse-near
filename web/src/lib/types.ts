// JSON returned by the contract's views (snake_case, as served; SPEC-contract 3.9). U128 values are decimal strings,
// u64/u32/u8 are numbers.
// Units: every amount the contract keeps is 18-decimal fixed point for both assets (the NEP-141 edge scales USDC up by
// 1e12 and wNEAR down by 1e6), prices are USDC per NEAR in 18 decimals, odds and rates are 18-decimal fractions. Only
// ft_balance_of on the token contracts answers in token units (USDC 6 decimals, wNEAR 24).

export type U128 = string;
export type Mask = number;
export type Asset = "wnear" | "usdc";

export type TierJson = "normal" | "safe" | "bold";
export type PauseFlagJson = "trade" | "mint" | "transfer" | "lend" | "liquidate" | "oracle" | "pledge" | "exit";
export type WorldStatusJson = "no_pool" | "young" | "shallow" | "out_of_band" | "trusted";
export type LiquidationJson = "none" | "paused" | "paused_halted" | "paused_reference" | "paused_no_price" | "liquidatable";

export interface AssetCfg {
  token_id: string;
  symbol: string;
  decimals: number;
}

export interface DemoRecord {
  spice_event: number;
  fed_event: number;
  past_fed_event: number | null;
  scenario_2x2: number;
  scenario_binary: number;
  implied_spot: U128;
  odds_ships_bps: number;
  odds_cuts_bps: number;
  odds_source: string | null;
  seeded_at_sec: number;
  spot_from: "2x2" | "binary";
}

/** The keys `get_app_config` gained in v2 (absent on a v1 contract, which the version gate then turns away). */
export interface AppConfigV2Keys {
  code_version: string;
  state_version: number;
  paused: PauseFlagJson[];
  guardian_id: string | null;
  pending_owner_id: string | null;
  max_worlds: number;
  max_events: number;
  max_trade_fills: number;
  max_trade_fills_8w: number;
  reference_configured: boolean;
  proposal_count: number;
  lending: {
    min_loan: U128;
    full_liquidation_hf: U128;
    small_loan: U128;
    close_factor: U128;
    max_collateral_pieces: number;
    /** Safe, Normal, Bold. */
    defaults: { tier: TierJson; config: TierConfigViewJson }[];
  };
}

export interface AppConfigView extends Partial<AppConfigV2Keys> {
  owner_id: string;
  reporter_id: string | null;
  wnear: AssetCfg;
  usdc: AssetCfg;
  lltv: U128;
  liquidation_bonus: U128;
  borrow_rate_per_sec: U128;
  dispute_window_sec: number;
  twap_window_sec: number;
  min_pool_depth: U128;
  fee_base_pips: number;
  fee_cap_pips: number;
  order_book: boolean;
  root_lp: boolean;
  spot_pool_id: number | null;
  event_count: number;
  scenario_count: number;
  /** Whatever JSON the owner stored with set_demo_record; read field by field. */
  demo: Partial<DemoRecord> | null;
}

export interface WorldViewJson {
  index: number;
  mask: Mask;
  label: string;
  possible: boolean;
  pool_initialized: boolean;
  wnear_price: U128;
  backed: boolean;
  wnear_token_id: string;
  usdc_token_id: string;
  user_wnear: U128;
  user_usdc: U128;
  collateral_wnear: U128;
  collateral_usdc: U128;
  odds: U128;
  /** The world's own pool, for get_pool; null before it is created. */
  pool_id: number | null;
}

export interface ScenarioViewJson {
  scenario_id: number;
  world_count: number;
  possible: Mask;
  resolution_count: number;
  halted: boolean;
  event_ids: number[];
  spot_price: U128;
  worlds: WorldViewJson[];
  odds_known: boolean;
  implied_spot: U128;
}

/** v1 `get_scenario(scenario_id)` (panics `UnknownScenario(id)` for an id that does not exist). */
export interface ScenarioInfoJson {
  scenario_id: number;
  event_ids: number[];
  outcome_counts: number[];
  world_count: number;
  root: number;
  possible: number;
  resolution_count: number;
  resolved_events: number;
  halted: boolean;
  pool_ids: number[];
}

export interface EventViewJson {
  id: number;
  question: string;
  rule: string;
  outcome_names: string[];
  deadline_sec: number;
  proposed_at_sec: number;
  proposed_outcome: number;
  proposal_open: boolean;
  finalized: boolean;
  outcome: number;
  finalizable_at_sec: number;
  proposed_by: "admin" | "reporter" | "outlayer" | null;
}

export interface OrderViewJson {
  /** U64 as a decimal string. */
  id: string;
  maker: string;
  scenario_id: number;
  mask: Mask;
  side: "bid" | "ask";
  price: U128;
  amount: U128;
  remaining: U128;
  /** What the order still holds: USDC for a bid, NEAR for an ask. */
  escrow: U128;
  expiry_sec: number;
  epoch: number;
}

export interface ImpactPointJson {
  at_sec: number;
  prices: U128[];
}

export interface CollateralPieceJson {
  token_id: string;
  label: string;
  asset: Asset;
  mask: Mask;
  is_real: boolean;
  amount: U128;
}

/** v1 keys always; the v2 keys on a v2 contract (a v1 contract never sends them). */
export interface AccountViewJson extends Partial<AccountViewV2Keys> {
  debt: U128;
  health_factor: U128 | null;
  worst_world: number | null;
  collateral_values: U128[];
  world_price_ok: boolean[];
  collateral: CollateralPieceJson[];
  supplied: U128;
  supply_principal: U128;
  market_supply: U128;
  market_borrow: U128;
  utilization: U128;
  borrow_rate_per_sec: U128;
  supply_rate_per_sec: U128;
  lltv: U128;
  liquidation: LiquidationJson;
  unpriced_world: number | null;
}

/** The keys `AccountView` gained in v2 (SPEC-contract 3.9 LEND); every one is present on a v2 contract. */
export interface AccountViewV2Keys {
  tier: TierJson;
  borrow_ltv: U128;
  /** Null without debt. */
  borrow_health_factor: U128 | null;
  borrow_limit: U128;
  max_borrow: U128;
  liquidation_bonus: U128;
  insurance: U128;
  min_loan: U128;
  frozen: boolean;
  max_repay: U128;
  write_off_ready: boolean;
  /** One per world of the scenario. */
  world_status: WorldStatusJson[];
  borrow_block: string | null;
  liquidation_factor: U128;
}

export type AccountViewV2Json = AccountViewJson & AccountViewV2Keys;

export interface RootLpViewJson {
  share_supply: U128;
  your_shares: U128;
  share_decimals: number;
  preview_withdraw: null | { wnear: U128[]; usdc: U128[] };
  holdings: { world: number; wnear_idle: U128; usdc_idle: U128; wnear_fees: U128; usdc_fees: U128 }[];
}

export interface TradeViewJson {
  scenario: ScenarioViewJson;
  events: EventViewJson[];
  orders: OrderViewJson[];
  impact: ImpactPointJson[];
  now_sec: number;
}

export interface BorrowViewJson {
  scenario: ScenarioViewJson;
  account: AccountViewJson;
  now_sec: number;
}

export interface LendViewJson {
  account: AccountViewJson;
  root_lp: RootLpViewJson | null;
  worlds: { index: number; mask: Mask; label: string; possible: boolean }[];
}

export interface ResolveViewJson {
  scenario: ScenarioViewJson;
  events: EventViewJson[];
  past_fed_event: EventViewJson | null;
  account: AccountViewJson;
  now_sec: number;
}

export interface AdminViewJson {
  scenario: ScenarioViewJson;
  events: EventViewJson[];
  past_fed_event: EventViewJson | null;
  owner_id: string;
  now_sec: number;
}

export interface LpPreviewJson {
  shares: U128;
  wnear_kept: U128[];
  usdc_kept: U128[];
}

/** NEP-145 storage_balance_of / storage_balance_bounds (yoctoNEAR strings). */
export interface StorageBalance {
  total: U128;
  available: U128;
}
export interface StorageBounds {
  min: U128;
  max: U128 | null;
}

export interface PoolViewJson {
  id: number;
  kind: string;
  scenario_id: number | null;
  world: number | null;
  mask0: number;
  mask1: number;
  token0: string;
  token1: string;
  reserve0: U128;
  reserve1: U128;
  /** Within-world and spot pools only. */
  wnear_reserve: U128 | null;
  usdc_reserve: U128 | null;
  liquidity: U128;
  fees0: U128;
  fees1: U128;
  fee_pips: number;
  swap_count: number;
  price: U128;
  /** Null until the TWAP window has history. */
  twap_price: U128 | null;
  twap_ok: boolean;
}

// ---- v2 views (SPEC-contract 3.9; SPEC.md 2.2 K4-K6) ----

/** OPS `contract_version()`. */
export interface ContractVersionJson {
  code_version: string;
  state_version: number;
  recorded_code_version: string;
  upgraded_at_sec: number;
  upgraded_from: string;
  event_version: string;
  legacy_scenario_count: number;
}

/** OPS `pause_state()`. */
export interface PauseStateJson {
  paused: PauseFlagJson[];
  since_sec: number;
  liquidations_resume_at_sec: number;
  guardian_id: string | null;
  pending_owner_id: string | null;
}

export interface BooksAssetJson {
  reserves: U128;
  lending_cash: U128;
  insurance: U128;
  internal: U128;
  collateral: U128;
  spot_pool: U128;
  pledges: U128;
  total: U128;
}
/** OPS `books(from_scenario?, limit?)`. */
export interface BooksJson {
  from_scenario: number;
  next_scenario: number | null;
  wnear: BooksAssetJson;
  usdc: BooksAssetJson;
}
/** OPS `near_books()`: yoctoNEAR; `own_free` is a signed decimal. */
export interface NearBooksJson {
  balance: U128;
  storage_stake: U128;
  nep145_available: U128;
  near_held: U128;
  storage_fund: U128;
  own_free: string;
}

/** EW `world_supply(scenario_id)`. */
export interface WorldSupplyJson {
  scenario_id: number;
  possible: number;
  wnear_reserves: U128;
  usdc_reserves: U128;
  wnear: U128[];
  usdc: U128[];
}

/** PRC `world_prices(scenario_id)`, one per world. */
export interface WorldPriceJson {
  world: number;
  status: WorldStatusJson;
  twap: U128;
  spot: U128;
  borrow_price: U128;
  liquidation_price: U128;
  depth: U128;
  age_sec: number;
  full_window: boolean;
}
export interface MarketPriceCfgJson {
  min_age_sec: number;
  min_depth: U128;
  reference: boolean;
  max_deviation: U128;
  max_haircut: U128;
}
/** PRC `price_check(scenario_id)`. */
export interface PriceCheckJson {
  scenario_id: number;
  config: MarketPriceCfgJson;
  reference: null | {
    price: U128;
    observed_at: number;
    age_sec: number;
    source: "none" | "outlayer" | "reporter";
    sources_used: number;
    spread_bps: number;
  };
  implied_twap_spot: U128 | null;
  ratio: U128 | null;
  borrow_block: string | null;
  borrow_factor: U128;
  liquidation_factor: U128;
  liquidation_guard: boolean;
}
/** PRC `get_reference()` (null before the first price). */
export interface ReferenceJson {
  price: U128;
  observed_at: number;
  stored_at: number;
  age_sec: number;
  source: string;
  sources_used: number;
  spread_bps: number;
  request: number;
  pending: boolean;
}
export interface ResourceLimitsJson {
  max_instructions: number;
  max_memory_mb: number;
  max_execution_seconds: number;
}
/** PRC `get_reference_config()` (null until configured). */
export interface ReferenceConfigJson {
  enabled: boolean;
  guest: null | { outlayer_id: string; wasm_url: string; wasm_sha256: string; resource_limits: ResourceLimitsJson; deposit: U128 };
  reporter_id: string | null;
  min_sources: number;
  max_spread_bps: number;
  max_result_delay_sec: number;
  borrow_max_age_sec: number;
  liquidation_max_age_sec: number;
  min_price: U128;
  max_price: U128;
}
/** v1 `get_outlayer_config()` (null until configured). */
export interface OutLayerConfigJson {
  outlayer_id: string;
  wasm_url: string;
  wasm_sha256: string;
  resource_limits: ResourceLimitsJson;
  deposit: U128;
}
/** v1 `get_outlayer_dates(event_id)`. */
export interface FomcDatesJson {
  before: string;
  after: string;
  pending: boolean;
  request: number;
}

/** LEND: a tier's config as the views show it; `borrow_cap` null for none. */
export interface TierConfigViewJson {
  lltv: U128;
  borrow_ltv: U128;
  liquidation_bonus: U128;
  reserve_factor: U128;
  rate_base: U128;
  rate_slope1: U128;
  rate_slope2: U128;
  rate_kink: U128;
  max_utilization: U128;
  borrow_cap: U128 | null;
}
/** LEND `market_state(scenario_id, tier?)`: the v1 MarketView plus the tier's books. */
export interface MarketViewJson {
  total_supply: U128;
  total_borrow: U128;
  total_supply_shares: U128;
  total_borrow_shares: U128;
  utilization: U128;
  supply_rate_per_sec: U128;
  borrow_rate_per_sec: U128;
  last_update_sec: number;
  tier: TierJson;
  insurance: U128;
  liquid: U128;
  bad_debt_covered: U128;
  bad_debt_socialized: U128;
  borrowers: number;
  frozen: boolean;
  config: TierConfigViewJson;
}
/** LEND `tier_config(scenario_id, tier)`. */
export interface TierConfigResultJson {
  config: TierConfigViewJson;
  frozen: boolean;
  source: "stored" | "default";
}
/** LEND `lending_tiers(scenario_id, account_id?)`: Safe, Normal, Bold. */
export interface LendingTierJson {
  tier: TierJson;
  market: MarketViewJson;
  account: AccountViewV2Json | null;
}
/** LEND `liquidation_status(scenario_id, account_id, tier?)`. */
export interface LiquidationStatusJson {
  status: LiquidationJson;
  unpriced_world: number | null;
  tier: TierJson;
  max_repay: U128;
  full_seize_repay: U128;
  write_off_ready: boolean;
}
/** v1 `health_factor(..)` and `collateral_values(..)` (+ `tier?`). */
export interface HealthViewJson {
  health_factor: U128 | null;
  worst_world: number | null;
}
export interface CollateralValuesJson {
  values: U128[];
  possible: number;
}
export interface BorrowerRowJson {
  index: number;
  account_id: string;
  debt: U128;
  health_factor: U128 | null;
  worst_world: number | null;
  c_min: U128;
  liquidation: LiquidationJson;
  unpriced_world: number | null;
  max_repay: U128;
  full_seize_repay: U128;
  write_off_ready: boolean;
}
/** LEND `borrowers(scenario_id, tier?, from_index?, limit?, max_health_factor?)`. */
export interface BorrowersPageJson {
  scenario_id: number;
  tier: TierJson;
  total: number;
  from_index: number;
  next_index: number | null;
  now_sec: number;
  rows: BorrowerRowJson[];
}
/** LEND `liquidation_quote(scenario_id, account_id, tier?, repay_amount?, receive?)`. */
export interface LiquidationQuoteJson {
  error: string | null;
  liquidation: LiquidationJson;
  debt: U128;
  health_factor: U128 | null;
  cap: U128;
  full_seize_repay: U128;
  repay: U128;
  target: U128;
  seize_all: boolean;
  written_off: U128;
  price_factor: U128;
  pieces: { piece: string; held: U128; seized: U128 }[];
  cash: null | {
    sold: U128[];
    received: U128[];
    merged: U128;
    real_usdc: U128;
    redeemed: U128;
    cash: U128;
    left_usdc: U128[];
    dead: string[];
    guard_ok: boolean;
  };
}

export type MarketStatusJson = "open" | "deciding" | "partly_resolved" | "resolved";
/** MKT: one market of the list (`list_markets`, `market_cards`, `get_market`). */
export interface MarketCardJson {
  scenario_id: number;
  listed: boolean;
  origin: "legacy" | "owner" | "pledged";
  proposal_id: number | null;
  event_ids: number[];
  world_count: number;
  possible: number;
  status: MarketStatusJson;
  categories: number[];
  deadline_sec: number;
  created_at_sec: number;
  odds: U128[];
  odds_known: boolean;
  world_prices: U128[];
  implied_spot: U128;
  pool_value: U128;
  min_world_depth: U128;
  pool_count: number;
  lendable: boolean;
  seed: null | { proposal_id: number; supply: U128; unlock_at_sec: number };
}
export interface ListMarketsJson {
  markets: MarketCardJson[];
  next_from: number | null;
}
export interface RelatedMarketJson {
  scenario_id: number;
  event_ids: number[];
  world_count: number;
  status: MarketStatusJson;
  listed: boolean;
}
export interface RelatedMarketsJson {
  markets: RelatedMarketJson[];
  proposals: ProposalSummaryJson[];
}
export interface MarketOfEventsJson {
  canonical: number[];
  listed_market: number | null;
  live_proposal: number | null;
}

export type ProposalStatusJson = "review" | "pledging" | "ready" | "waiting" | "opened" | "rejected" | "cancelled" | "expired" | "void";
/** A summary's status: the proposal page splits `pledging` into `ready` / `waiting`, lists do not. */
export type ProposalSummaryStatusJson = Exclude<ProposalStatusJson, "ready" | "waiting">;
export type VoidReasonJson = "none" | "review_timeout" | "event_resolved" | "event_full" | "market_exists" | "evicted";
export interface OpeningTermsJson {
  odds0_bps: number;
  mult_bps: [number, number];
}
export interface NewEventJson {
  question: string;
  outcome_names: string[];
  rule: string;
  source: string;
  deadline_sec: number;
  category: number;
  terms: OpeningTermsJson;
}
export type NewEventSummaryJson = Omit<NewEventJson, "rule" | "source">;
export interface OpenedJson {
  scenario_id: number;
  opened_at_sec: number;
  s_ref: U128;
  shares: U128;
  unlock_at_sec: number;
}
interface ProposalCommonJson {
  proposal_id: number;
  kind: "new_event" | "market";
  proposer: string;
  void_reason: VoidReasonJson | null;
  blocker: string | null;
  event_ids: number[];
  world_count: number;
  category: number;
  deadline_sec: number;
  created_at_sec: number;
  approved_at_sec: number;
  expires_at_sec: number;
  open_not_before_sec: number;
  goal: U128;
  ideal_wnear: U128;
  ideal_usdc: U128;
  s_hint: U128;
  pledged_wnear: U128;
  pledged_usdc: U128;
  pledgers: number;
  progress_bps: number;
  bond: U128;
  reserve: U128;
  seed_lock_sec: number;
  opened: OpenedJson | null;
}
/** MKT `get_proposal(proposal_id)` (null for an unknown id); runs `open_check`, so it carries the preview. */
export interface ProposalViewJson extends ProposalCommonJson {
  status: ProposalStatusJson;
  new_event: NewEventJson | null;
  preview: OpeningPreviewJson | null;
}
/** MKT list rows: the view without the preview, the new event's rule and source, and the ready/waiting split. */
export interface ProposalSummaryJson extends ProposalCommonJson {
  status: ProposalSummaryStatusJson;
  new_event: NewEventSummaryJson | null;
}
export interface ListProposalsJson {
  proposals: ProposalSummaryJson[];
  next_from: number | null;
}
export interface OpeningPreviewJson {
  can_open: boolean;
  blocker: string | null;
  s_ref: U128 | null;
  anchors: { scenario_id: number; implied: U128 }[];
  references: { event_id: number; scenario_id: number; odds0: U128; ratio0: U128; ratio1: U128; implied: U128 }[];
  odds: U128[];
  prices: U128[];
  usable_value: U128;
  used_wnear: U128;
  used_usdc: U128;
  unused_wnear: U128;
  unused_usdc: U128;
  world_pools: { world: number; wnear: U128; usdc: U128 }[];
  odds_pools: { mask0: number; mask1: number; amount0: U128; amount1: U128 }[];
  idle: { token_id: string; amount: U128 }[];
  idle_value: U128;
  thinnest_world_usdc: U128;
  needs: Asset | null;
  storage_estimate: U128;
  reserve_available: U128;
}
export interface PledgeViewJson {
  proposal_id: number;
  account_id: string;
  wnear: U128;
  usdc: U128;
  state: "pledged" | "refundable" | "seed";
  shares: U128 | null;
  withdrawn_shares: U128;
  unused_wnear: U128;
  unused_usdc: U128;
  unused_paid: boolean;
  unlock_at_sec: number;
  max_withdrawable_shares: U128;
}
export interface PledgePreviewJson {
  usable_before: U128;
  usable_after: U128;
  deployed_part: U128;
  goal_reached_after: boolean;
  needs: Asset | null;
}
/** The 33 fields of `MarketParams` (SPEC-contract 2.4; SPEC.md K14). */
export interface MarketParamsJson {
  bond_new_event: U128;
  bond_market: U128;
  reserve_base: U128;
  reserve_per_world: U128;
  proposal_ttl_sec: number;
  review_ttl_sec: number;
  min_pledge_window_sec: number;
  min_market_life_sec: number;
  notice_sec: number;
  seed_lock_sec: number;
  evict_min_age_sec: number;
  spam_floor_bps: number;
  goal_depth_usdc: U128;
  min_open_depth_usdc: U128;
  min_goal_usdc: U128;
  goal_round_usdc: U128;
  beta_bps: number;
  odds_clamp_bps: number;
  mult_a_bps: [number, number];
  mult_b_bps: [number, number];
  anchors: [number, number, number];
  max_anchor_divergence_bps: number;
  max_reference_divergence_bps: number;
  min_reference_depth_usdc: U128;
  min_reference_odds_depth_usdc: U128;
  require_external: boolean;
  max_external_divergence_bps: number;
  min_pledge_usdc: U128;
  min_pledge_wnear: U128;
  max_pledges_per_account: number;
  max_active_per_account: number;
  max_live_per_event: number;
  seed_depth_floor: boolean;
}
/** MKT `market_params()`. */
export interface MarketParamsViewJson {
  params: MarketParamsJson;
  reserve_w2: U128;
  reserve_w4: U128;
  reserve_w8: U128;
  storage_fund: U128;
}
/** MKT `market_check(event_ids)`. */
export interface MarketCheckJson {
  canonical: number[];
  world_count: number;
  blocker: string | null;
  listed_market: number | null;
  live_proposal: number | null;
  goal: U128;
  ideal_wnear: U128;
  ideal_usdc: U128;
  bond: U128;
  reserve: U128;
  expires_at_sec: number;
}
/** MKT `event_check(question, terms, deadline_sec)` (SPEC.md K4). */
export interface EventCheckJson {
  blocker: string | null;
  live_proposal: number | null;
  goal: U128;
  ideal_wnear: U128;
  ideal_usdc: U128;
  s_ref: U128 | null;
  odds: [U128, U128];
  prices: [U128, U128];
  bond: U128;
  reserve: U128;
}
/** MKT `event_meta(event_id)` (null without one). */
export interface EventMetaJson {
  event_id: number;
  proposal_id: number;
  proposer: string | null;
  source: string;
  category: number;
}
export interface TokenAmountJson {
  token_id: string;
  amount: U128;
}
/** MKT `seed_vault(scenario_id)` (null for a market not opened from pledges). */
export interface SeedVaultJson {
  proposal_id: number;
  supply: U128;
  unlock_at_sec: number;
  positions: { pool_id: number; liquidity: U128; amount0: U128; amount1: U128; fees0: U128; fees1: U128 }[];
  idle: TokenAmountJson[];
}
/** MKT `preview_seed_withdraw(proposal_id, account_id, shares?)`, with `per_world` (SPEC.md K5). */
export interface SeedWithdrawPreviewJson {
  wnear_out: U128;
  usdc_out: U128;
  tokens: TokenAmountJson[];
  max_shares: U128;
  locked_until_sec: number;
  per_world: { wnear: U128[]; usdc: U128[] };
}
/** NEP-245 `mt_tokens_for_owner` / `mt_tokens` row. */
export interface MtTokenJson {
  token_id: string;
  owner_id: string | null;
  base_metadata_id: string;
}
