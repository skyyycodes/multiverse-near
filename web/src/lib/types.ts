// JSON returned by the Multiverse contract's views (snake_case, as served). U128 values are decimal strings.
// Units: every amount the contract keeps is 18-decimal fixed point for both assets (the NEP-141 edge scales USDC up by
// 1e12 and wNEAR down by 1e6), prices are USDC per NEAR in 18 decimals, odds and rates are 18-decimal fractions. Only
// ft_balance_of on the token contracts answers in token units (USDC 6 decimals, wNEAR 24).

export type U128 = string;
export type Mask = number;
export type Asset = "wnear" | "usdc";

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

export interface AppConfigView {
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

export interface AccountViewJson {
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
  liquidation: "none" | "liquidatable" | "paused_halted" | "paused_no_price";
  unpriced_world: number | null;
}

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
