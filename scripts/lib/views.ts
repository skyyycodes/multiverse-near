// Hand-mirrored types for every view shape of SPEC-C 3.9 (plus K4-K6 of SPEC.md 2.2), with one runtime
// decoder per type. A decoder checks that every declared key is present with the right JSON type
// and ignores keys it does not know (views only ever add keys). U128 values stay strings, checked
// as such; turn them into bigint with `u128()` (units.ts) where the arithmetic happens. u64 values
// stay numbers (block times, ids). Tested against fixtures in fixtures/v2/, which `measure
// --capture-fixtures` refreshes from a sandbox contract, so a renamed key fails a unit test instead
// of a 24-hour soak.

import type { AssetName, Tier } from "./msgs.ts";

/** A u128 as the contract serializes it: a decimal string. */
export type U128 = string;

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

export type Decoder<T> = (x: unknown, path: string) => T;

function describe(x: unknown): string {
  if (x === undefined) return "nothing";
  if (x === null) return "null";
  if (Array.isArray(x)) return "an array";
  const text = JSON.stringify(x);
  return `${typeof x} ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`;
}

const fail = (path: string, expected: string, x: unknown): never => {
  throw new DecodeError(`${path}: expected ${expected}, got ${describe(x)}`);
};

const MAX_U128 = (1n << 128n) - 1n;

export const dU128: Decoder<U128> = (x, path) => {
  if (typeof x !== "string" || !/^\d+$/.test(x) || BigInt(x) > MAX_U128) return fail(path, "U128 string", x);
  return x;
};

/** A signed decimal string (near_books().own_free). */
export const dSignedDecimal: Decoder<string> = (x, path) => {
  if (typeof x !== "string" || !/^-?\d+$/.test(x)) return fail(path, "signed decimal string", x);
  return x;
};

/** u64 / u32 / u8 values, kept as numbers; they must be safe integers. */
export const dU64: Decoder<number> = (x, path) => {
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0) return fail(path, "unsigned integer", x);
  return x;
};

const dUint =
  (max: number): Decoder<number> =>
  (x, path) => {
    const n = dU64(x, path);
    if (n > max) return fail(path, `integer ≤ ${max}`, x);
    return n;
  };
export const dU8 = dUint(255);
export const dU16 = dUint(65_535);
export const dU32 = dUint(4_294_967_295);

export const dStr: Decoder<string> = (x, path) => (typeof x === "string" ? x : fail(path, "string", x));
export const dBool: Decoder<boolean> = (x, path) => (typeof x === "boolean" ? x : fail(path, "boolean", x));

export const dNullable =
  <T>(d: Decoder<T>): Decoder<T | null> =>
  (x, path) =>
    x === null ? null : d(x, path);

export const dArr =
  <T>(d: Decoder<T>): Decoder<T[]> =>
  (x, path) => {
    if (!Array.isArray(x)) return fail(path, "array", x);
    return x.map((v, i) => d(v, `${path}[${i}]`));
  };

export const dPair =
  <T>(d: Decoder<T>): Decoder<[T, T]> =>
  (x, path) => {
    if (!Array.isArray(x) || x.length !== 2) return fail(path, "array of 2", x);
    return [d(x[0], `${path}[0]`), d(x[1], `${path}[1]`)];
  };

export const dTriple =
  <T>(d: Decoder<T>): Decoder<[T, T, T]> =>
  (x, path) => {
    if (!Array.isArray(x) || x.length !== 3) return fail(path, "array of 3", x);
    return [d(x[0], `${path}[0]`), d(x[1], `${path}[1]`), d(x[2], `${path}[2]`)];
  };

export const dLit =
  <const T extends string>(...values: T[]): Decoder<T> =>
  (x, path) =>
    typeof x === "string" && (values as string[]).includes(x) ? (x as T) : fail(path, values.map((v) => `"${v}"`).join(" | "), x);

export type Shape<T> = { [K in keyof T]-?: Decoder<T[K]> };

/** An object with every key of `shape` present; unknown keys are dropped, never refused. */
export const dObj =
  <T>(shape: Shape<T>): Decoder<T> =>
  (x, path) => {
    if (typeof x !== "object" || x === null || Array.isArray(x)) return fail(path, "object", x);
    const src = x as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(shape) as (keyof T & string)[]) {
      if (!(key in src)) throw new DecodeError(`${path}.${key}: missing`);
      out[key] = (shape[key] as Decoder<unknown>)(src[key], `${path}.${key}`);
    }
    return out as T;
  };

/** A decoder with the root path filled in, the form every caller uses. */
export const top =
  <T>(d: Decoder<T>, name: string) =>
  (x: unknown, path: string = name): T =>
    d(x, path);

// Shared enums

export const PAUSE_FLAGS = ["trade", "mint", "transfer", "lend", "liquidate", "oracle", "pledge", "exit"] as const;
export type PauseFlag = (typeof PAUSE_FLAGS)[number];
const dPauseFlag = dLit(...PAUSE_FLAGS);
const dTier: Decoder<Tier> = dLit("normal", "safe", "bold");
const dAsset: Decoder<AssetName> = dLit("wnear", "usdc");

// OPS

export interface ContractVersion {
  code_version: string;
  state_version: number;
  recorded_code_version: string;
  upgraded_at_sec: number;
  upgraded_from: string;
  event_version: string;
  legacy_scenario_count: number;
}
const dContractVersion = dObj<ContractVersion>({
  code_version: dStr,
  state_version: dU32,
  recorded_code_version: dStr,
  upgraded_at_sec: dU64,
  upgraded_from: dStr,
  event_version: dStr,
  legacy_scenario_count: dU64,
});
export const decodeContractVersion = top(dContractVersion, "contract_version");

export interface PauseView {
  paused: PauseFlag[];
  since_sec: number;
  liquidations_resume_at_sec: number;
  guardian_id: string | null;
  pending_owner_id: string | null;
}
const dPauseView = dObj<PauseView>({
  paused: dArr(dPauseFlag),
  since_sec: dU64,
  liquidations_resume_at_sec: dU64,
  guardian_id: dNullable(dStr),
  pending_owner_id: dNullable(dStr),
});
export const decodePauseView = top(dPauseView, "pause_state");

export interface BooksSideView {
  reserves: U128;
  lending_cash: U128;
  insurance: U128;
  internal: U128;
  collateral: U128;
  spot_pool: U128;
  pledges: U128;
  total: U128;
}
const dBooksSide = dObj<BooksSideView>({
  reserves: dU128,
  lending_cash: dU128,
  insurance: dU128,
  internal: dU128,
  collateral: dU128,
  spot_pool: dU128,
  pledges: dU128,
  total: dU128,
});

export interface BooksView {
  from_scenario: number;
  next_scenario: number | null;
  wnear: BooksSideView;
  usdc: BooksSideView;
}
const dBooksView = dObj<BooksView>({ from_scenario: dU64, next_scenario: dNullable(dU64), wnear: dBooksSide, usdc: dBooksSide });
export const decodeBooksView = top(dBooksView, "books");

export interface NearBooksView {
  balance: U128;
  storage_stake: U128;
  nep145_available: U128;
  near_held: U128;
  storage_fund: U128;
  /** yocto, signed: M-13 holds iff ≥ 0 */
  own_free: string;
}
const dNearBooks = dObj<NearBooksView>({
  balance: dU128,
  storage_stake: dU128,
  nep145_available: dU128,
  near_held: dU128,
  storage_fund: dU128,
  own_free: dSignedDecimal,
});
export const decodeNearBooks = top(dNearBooks, "near_books");

// EW

export interface WorldSupplyView {
  scenario_id: number;
  possible: number;
  wnear_reserves: U128;
  usdc_reserves: U128;
  wnear: U128[];
  usdc: U128[];
}
const dWorldSupply = dObj<WorldSupplyView>({
  scenario_id: dU64,
  possible: dU8,
  wnear_reserves: dU128,
  usdc_reserves: dU128,
  wnear: dArr(dU128),
  usdc: dArr(dU128),
});
export const decodeWorldSupply = top(dWorldSupply, "world_supply");
export const decodeMarketsOf = top(dArr(dU64), "markets_of");

export interface MtToken {
  token_id: string;
  owner_id: string | null;
  base_metadata_id: string;
}
const dMtToken = dObj<MtToken>({ token_id: dStr, owner_id: dNullable(dStr), base_metadata_id: dStr });
export const decodeMtTokens = top(dArr(dMtToken), "mt_tokens");

// PRC

export const WORLD_STATUSES = ["no_pool", "young", "shallow", "out_of_band", "trusted"] as const;
export type WorldStatus = (typeof WORLD_STATUSES)[number];

export interface WorldPriceRow {
  world: number;
  status: WorldStatus;
  twap: U128;
  spot: U128;
  borrow_price: U128;
  liquidation_price: U128;
  depth: U128;
  age_sec: number;
  full_window: boolean;
}
const dWorldPriceRow = dObj<WorldPriceRow>({
  world: dU8,
  status: dLit(...WORLD_STATUSES),
  twap: dU128,
  spot: dU128,
  borrow_price: dU128,
  liquidation_price: dU128,
  depth: dU128,
  age_sec: dU64,
  full_window: dBool,
});
export const decodeWorldPrices = top(dArr(dWorldPriceRow), "world_prices");

export interface MarketPriceCfg {
  min_age_sec: number;
  min_depth: U128;
  reference: boolean;
  max_deviation: U128;
  max_haircut: U128;
}
const dMarketPriceCfg = dObj<MarketPriceCfg>({
  min_age_sec: dU64,
  min_depth: dU128,
  reference: dBool,
  max_deviation: dU128,
  max_haircut: dU128,
});
export const decodeMarketPriceCfg = top(dMarketPriceCfg, "market_price_config");

export interface PriceCheckReference {
  price: U128;
  observed_at: number;
  age_sec: number;
  source: "none" | "outlayer" | "reporter";
  sources_used: number;
  spread_bps: number;
}

export interface PriceCheck {
  scenario_id: number;
  config: MarketPriceCfg;
  reference: PriceCheckReference | null;
  implied_twap_spot: U128 | null;
  ratio: U128 | null;
  borrow_block: string | null;
  borrow_factor: U128;
  liquidation_factor: U128;
  liquidation_guard: boolean;
}
const dPriceCheck = dObj<PriceCheck>({
  scenario_id: dU64,
  config: dMarketPriceCfg,
  reference: dNullable(
    dObj<PriceCheckReference>({
      price: dU128,
      observed_at: dU64,
      age_sec: dU64,
      source: dLit("none", "outlayer", "reporter"),
      sources_used: dU8,
      spread_bps: dU32,
    }),
  ),
  implied_twap_spot: dNullable(dU128),
  ratio: dNullable(dU128),
  borrow_block: dNullable(dStr),
  borrow_factor: dU128,
  liquidation_factor: dU128,
  liquidation_guard: dBool,
});
export const decodePriceCheck = top(dPriceCheck, "price_check");

export interface ReferenceView {
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
const dReferenceView = dObj<ReferenceView>({
  price: dU128,
  observed_at: dU64,
  stored_at: dU64,
  age_sec: dU64,
  source: dStr,
  sources_used: dU8,
  spread_bps: dU32,
  request: dU64,
  pending: dBool,
});
export const decodeReference = top(dNullable(dReferenceView), "get_reference");

export interface ResourceLimits {
  max_instructions: number;
  max_memory_mb: number;
  max_execution_seconds: number;
}
export interface ReferenceGuest {
  outlayer_id: string;
  wasm_url: string;
  wasm_sha256: string;
  resource_limits: ResourceLimits;
  deposit: U128;
}
export interface ReferenceConfig {
  enabled: boolean;
  guest: ReferenceGuest | null;
  reporter_id: string | null;
  min_sources: number;
  max_spread_bps: number;
  max_result_delay_sec: number;
  borrow_max_age_sec: number;
  liquidation_max_age_sec: number;
  min_price: U128;
  max_price: U128;
}
const dReferenceConfig = dObj<ReferenceConfig>({
  enabled: dBool,
  guest: dNullable(
    dObj<ReferenceGuest>({
      outlayer_id: dStr,
      wasm_url: dStr,
      wasm_sha256: dStr,
      resource_limits: dObj<ResourceLimits>({ max_instructions: dU64, max_memory_mb: dU32, max_execution_seconds: dU64 }),
      deposit: dU128,
    }),
  ),
  reporter_id: dNullable(dStr),
  min_sources: dU8,
  max_spread_bps: dU32,
  max_result_delay_sec: dU64,
  borrow_max_age_sec: dU64,
  liquidation_max_age_sec: dU64,
  min_price: dU128,
  max_price: dU128,
});
export const decodeReferenceConfig = top(dNullable(dReferenceConfig), "get_reference_config");

// LEND

export interface TierConfigView {
  lltv: U128;
  borrow_ltv: U128;
  liquidation_bonus: U128;
  reserve_factor: U128;
  rate_base: U128;
  rate_slope1: U128;
  rate_slope2: U128;
  rate_kink: U128;
  max_utilization: U128;
  /** null = no cap */
  borrow_cap: U128 | null;
}
const dTierConfig = dObj<TierConfigView>({
  lltv: dU128,
  borrow_ltv: dU128,
  liquidation_bonus: dU128,
  reserve_factor: dU128,
  rate_base: dU128,
  rate_slope1: dU128,
  rate_slope2: dU128,
  rate_kink: dU128,
  max_utilization: dU128,
  borrow_cap: dNullable(dU128),
});

export interface MarketView {
  total_supply: U128;
  total_borrow: U128;
  total_supply_shares: U128;
  total_borrow_shares: U128;
  utilization: U128;
  supply_rate_per_sec: U128;
  borrow_rate_per_sec: U128;
  last_update_sec: number;
  tier: Tier;
  insurance: U128;
  liquid: U128;
  bad_debt_covered: U128;
  bad_debt_socialized: U128;
  borrowers: number;
  frozen: boolean;
  config: TierConfigView;
}
const dMarketView = dObj<MarketView>({
  total_supply: dU128,
  total_borrow: dU128,
  total_supply_shares: dU128,
  total_borrow_shares: dU128,
  utilization: dU128,
  supply_rate_per_sec: dU128,
  borrow_rate_per_sec: dU128,
  last_update_sec: dU64,
  tier: dTier,
  insurance: dU128,
  liquid: dU128,
  bad_debt_covered: dU128,
  bad_debt_socialized: dU128,
  borrowers: dU32,
  frozen: dBool,
  config: dTierConfig,
});
export const decodeMarketView = top(dMarketView, "market_state");

export const LIQUIDATION_STATUSES = ["none", "paused", "paused_halted", "paused_reference", "paused_no_price", "liquidatable"] as const;
export type LiquidationStatusName = (typeof LIQUIDATION_STATUSES)[number];

export interface LiquidationStatus {
  status: LiquidationStatusName;
  unpriced_world: number | null;
  tier: Tier;
  max_repay: U128;
  full_seize_repay: U128;
  write_off_ready: boolean;
}
const dLiquidationStatus = dObj<LiquidationStatus>({
  status: dLit(...LIQUIDATION_STATUSES),
  unpriced_world: dNullable(dU8),
  tier: dTier,
  max_repay: dU128,
  full_seize_repay: dU128,
  write_off_ready: dBool,
});
export const decodeLiquidationStatus = top(dLiquidationStatus, "liquidation_status");

export interface TierConfigResult {
  config: TierConfigView;
  frozen: boolean;
  source: "stored" | "default";
}
const dTierConfigResult = dObj<TierConfigResult>({ config: dTierConfig, frozen: dBool, source: dLit("stored", "default") });
export const decodeTierConfig = top(dTierConfigResult, "tier_config");

export interface HealthView {
  health_factor: U128 | null;
  worst_world: number | null;
}
export const decodeHealth = top(dObj<HealthView>({ health_factor: dNullable(dU128), worst_world: dNullable(dU8) }), "health_factor");

export interface CollateralValuesView {
  values: U128[];
  possible: number;
}
export const decodeCollateralValues = top(dObj<CollateralValuesView>({ values: dArr(dU128), possible: dU8 }), "collateral_values");

export interface CollateralEntry {
  piece: string;
  amount: U128;
}
export const decodeCollateralOf = top(dArr(dObj<CollateralEntry>({ piece: dStr, amount: dU128 })), "collateral_of");

export interface CollateralPieceView {
  token_id: string;
  label: string;
  asset: AssetName;
  mask: number;
  is_real: boolean;
  amount: U128;
}
const dCollateralPiece = dObj<CollateralPieceView>({ token_id: dStr, label: dStr, asset: dAsset, mask: dU8, is_real: dBool, amount: dU128 });

export interface AccountView {
  debt: U128;
  health_factor: U128 | null;
  worst_world: number | null;
  collateral_values: U128[];
  world_price_ok: boolean[];
  collateral: CollateralPieceView[];
  supplied: U128;
  supply_principal: U128;
  market_supply: U128;
  market_borrow: U128;
  utilization: U128;
  borrow_rate_per_sec: U128;
  supply_rate_per_sec: U128;
  lltv: U128;
  liquidation: LiquidationStatusName;
  unpriced_world: number | null;
  tier: Tier;
  borrow_ltv: U128;
  borrow_health_factor: U128 | null;
  borrow_limit: U128;
  max_borrow: U128;
  liquidation_bonus: U128;
  insurance: U128;
  min_loan: U128;
  frozen: boolean;
  max_repay: U128;
  write_off_ready: boolean;
  world_status: string[];
  borrow_block: string | null;
  liquidation_factor: U128;
}
const dAccountView = dObj<AccountView>({
  debt: dU128,
  health_factor: dNullable(dU128),
  worst_world: dNullable(dU8),
  collateral_values: dArr(dU128),
  world_price_ok: dArr(dBool),
  collateral: dArr(dCollateralPiece),
  supplied: dU128,
  supply_principal: dU128,
  market_supply: dU128,
  market_borrow: dU128,
  utilization: dU128,
  borrow_rate_per_sec: dU128,
  supply_rate_per_sec: dU128,
  lltv: dU128,
  liquidation: dLit(...LIQUIDATION_STATUSES),
  unpriced_world: dNullable(dU8),
  tier: dTier,
  borrow_ltv: dU128,
  borrow_health_factor: dNullable(dU128),
  borrow_limit: dU128,
  max_borrow: dU128,
  liquidation_bonus: dU128,
  insurance: dU128,
  min_loan: dU128,
  frozen: dBool,
  max_repay: dU128,
  write_off_ready: dBool,
  world_status: dArr(dStr),
  borrow_block: dNullable(dStr),
  liquidation_factor: dU128,
});
export const decodeAccountView = top(dAccountView, "account");

export interface LendingTierRow {
  tier: Tier;
  market: MarketView;
  account: AccountView | null;
}
export const decodeLendingTiers = top(dArr(dObj<LendingTierRow>({ tier: dTier, market: dMarketView, account: dNullable(dAccountView) })), "lending_tiers");

export interface BorrowerRow {
  index: number;
  account_id: string;
  debt: U128;
  health_factor: U128 | null;
  worst_world: number | null;
  c_min: U128;
  liquidation: string;
  unpriced_world: number | null;
  max_repay: U128;
  full_seize_repay: U128;
  write_off_ready: boolean;
}
export interface BorrowersPage {
  scenario_id: number;
  tier: Tier;
  total: number;
  from_index: number;
  next_index: number | null;
  now_sec: number;
  rows: BorrowerRow[];
}
const dBorrowersPage = dObj<BorrowersPage>({
  scenario_id: dU64,
  tier: dTier,
  total: dU32,
  from_index: dU32,
  next_index: dNullable(dU32),
  now_sec: dU64,
  rows: dArr(
    dObj<BorrowerRow>({
      index: dU32,
      account_id: dStr,
      debt: dU128,
      health_factor: dNullable(dU128),
      worst_world: dNullable(dU8),
      c_min: dU128,
      liquidation: dStr,
      unpriced_world: dNullable(dU8),
      max_repay: dU128,
      full_seize_repay: dU128,
      write_off_ready: dBool,
    }),
  ),
});
export const decodeBorrowers = top(dBorrowersPage, "borrowers");
export const decodeBorrowerCount = top(dU32, "borrower_count");

export interface QuotePiece {
  piece: string;
  held: U128;
  seized: U128;
}
export interface CashQuote {
  sold: U128[];
  received: U128[];
  merged: U128;
  real_usdc: U128;
  redeemed: U128;
  cash: U128;
  left_usdc: U128[];
  dead: string[];
  guard_ok: boolean;
}
export interface LiquidationQuote {
  error: string | null;
  liquidation: string;
  debt: U128;
  health_factor: U128 | null;
  cap: U128;
  full_seize_repay: U128;
  repay: U128;
  target: U128;
  seize_all: boolean;
  written_off: U128;
  price_factor: U128;
  pieces: QuotePiece[];
  cash: CashQuote | null;
}
const dLiquidationQuote = dObj<LiquidationQuote>({
  error: dNullable(dStr),
  liquidation: dStr,
  debt: dU128,
  health_factor: dNullable(dU128),
  cap: dU128,
  full_seize_repay: dU128,
  repay: dU128,
  target: dU128,
  seize_all: dBool,
  written_off: dU128,
  price_factor: dU128,
  pieces: dArr(dObj<QuotePiece>({ piece: dStr, held: dU128, seized: dU128 })),
  cash: dNullable(
    dObj<CashQuote>({
      sold: dArr(dU128),
      received: dArr(dU128),
      merged: dU128,
      real_usdc: dU128,
      redeemed: dU128,
      cash: dU128,
      left_usdc: dArr(dU128),
      dead: dArr(dStr),
      guard_ok: dBool,
    }),
  ),
});
export const decodeLiquidationQuote = top(dLiquidationQuote, "liquidation_quote");

// MKT

export interface OpeningTerms {
  odds0_bps: number;
  mult_bps: [number, number];
}
const dTerms = dObj<OpeningTerms>({ odds0_bps: dU16, mult_bps: dPair(dU16) });

/** The 33 fields of SPEC-C 2.4 (K14), in Borsh order. NEAR amounts are yocto; USDC amounts internal. */
export interface MarketParams {
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
const dMarketParams = dObj<MarketParams>({
  bond_new_event: dU128,
  bond_market: dU128,
  reserve_base: dU128,
  reserve_per_world: dU128,
  proposal_ttl_sec: dU64,
  review_ttl_sec: dU64,
  min_pledge_window_sec: dU64,
  min_market_life_sec: dU64,
  notice_sec: dU64,
  seed_lock_sec: dU64,
  evict_min_age_sec: dU64,
  spam_floor_bps: dU16,
  goal_depth_usdc: dU128,
  min_open_depth_usdc: dU128,
  min_goal_usdc: dU128,
  goal_round_usdc: dU128,
  beta_bps: dU16,
  odds_clamp_bps: dU16,
  mult_a_bps: dPair(dU16),
  mult_b_bps: dPair(dU16),
  anchors: dTriple(dU64),
  max_anchor_divergence_bps: dU16,
  max_reference_divergence_bps: dU16,
  min_reference_depth_usdc: dU128,
  min_reference_odds_depth_usdc: dU128,
  require_external: dBool,
  max_external_divergence_bps: dU16,
  min_pledge_usdc: dU128,
  min_pledge_wnear: dU128,
  max_pledges_per_account: dU8,
  max_active_per_account: dU8,
  max_live_per_event: dU8,
  seed_depth_floor: dBool,
});
export const MARKET_PARAMS_FIELDS = 33;

export interface MarketParamsView {
  params: MarketParams;
  reserve_w2: U128;
  reserve_w4: U128;
  reserve_w8: U128;
  storage_fund: U128;
}
export const decodeMarketParams = top(
  dObj<MarketParamsView>({ params: dMarketParams, reserve_w2: dU128, reserve_w4: dU128, reserve_w8: dU128, storage_fund: dU128 }),
  "market_params",
);

export type ProposalKind = "new_event" | "market";
export const PROPOSAL_STATUSES = ["review", "pledging", "opened", "rejected", "cancelled", "expired", "void"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export type ProposalViewStatus = ProposalStatus | "ready" | "waiting";
export const VOID_REASONS = ["none", "review_timeout", "event_resolved", "event_full", "market_exists", "evicted"] as const;
export type VoidReason = (typeof VOID_REASONS)[number];
const dKind = dLit("new_event", "market");
const dVoidReason = dLit(...VOID_REASONS);

export interface NewEventView {
  question: string;
  outcome_names: string[];
  rule: string;
  source: string;
  deadline_sec: number;
  category: number;
  terms: OpeningTerms;
}
export interface NewEventSummary {
  question: string;
  outcome_names: string[];
  deadline_sec: number;
  category: number;
  terms: OpeningTerms;
}
export interface OpenedView {
  scenario_id: number;
  opened_at_sec: number;
  s_ref: U128;
  shares: U128;
  unlock_at_sec: number;
}
const dOpened = dObj<OpenedView>({ scenario_id: dU64, opened_at_sec: dU64, s_ref: dU128, shares: dU128, unlock_at_sec: dU64 });

export interface AnchorView {
  scenario_id: number;
  implied: U128;
}
export interface ReferenceMarketView {
  event_id: number;
  scenario_id: number;
  odds0: U128;
  ratio0: U128;
  ratio1: U128;
  implied: U128;
}
export interface WorldPoolPlan {
  world: number;
  wnear: U128;
  usdc: U128;
}
export interface OddsPoolPlan {
  mask0: number;
  mask1: number;
  amount0: U128;
  amount1: U128;
}
export interface TokenAmount {
  token_id: string;
  amount: U128;
}
const dTokenAmount = dObj<TokenAmount>({ token_id: dStr, amount: dU128 });

export interface OpeningPreview {
  can_open: boolean;
  blocker: string | null;
  s_ref: U128 | null;
  anchors: AnchorView[];
  references: ReferenceMarketView[];
  odds: U128[];
  prices: U128[];
  usable_value: U128;
  used_wnear: U128;
  used_usdc: U128;
  unused_wnear: U128;
  unused_usdc: U128;
  world_pools: WorldPoolPlan[];
  odds_pools: OddsPoolPlan[];
  idle: TokenAmount[];
  idle_value: U128;
  thinnest_world_usdc: U128;
  needs: AssetName | null;
  storage_estimate: U128;
  reserve_available: U128;
}
const dOpeningPreview = dObj<OpeningPreview>({
  can_open: dBool,
  blocker: dNullable(dStr),
  s_ref: dNullable(dU128),
  anchors: dArr(dObj<AnchorView>({ scenario_id: dU64, implied: dU128 })),
  references: dArr(
    dObj<ReferenceMarketView>({ event_id: dU64, scenario_id: dU64, odds0: dU128, ratio0: dU128, ratio1: dU128, implied: dU128 }),
  ),
  odds: dArr(dU128),
  prices: dArr(dU128),
  usable_value: dU128,
  used_wnear: dU128,
  used_usdc: dU128,
  unused_wnear: dU128,
  unused_usdc: dU128,
  world_pools: dArr(dObj<WorldPoolPlan>({ world: dU8, wnear: dU128, usdc: dU128 })),
  odds_pools: dArr(dObj<OddsPoolPlan>({ mask0: dU8, mask1: dU8, amount0: dU128, amount1: dU128 })),
  idle: dArr(dTokenAmount),
  idle_value: dU128,
  thinnest_world_usdc: dU128,
  needs: dNullable(dAsset),
  storage_estimate: dU128,
  reserve_available: dU128,
});
export const decodeOpeningPreview = top(dOpeningPreview, "opening_preview");

interface ProposalCommon {
  proposal_id: number;
  kind: ProposalKind;
  proposer: string;
  void_reason: VoidReason | null;
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
  opened: OpenedView | null;
}
const commonShape: Shape<ProposalCommon> = {
  proposal_id: dU64,
  kind: dKind,
  proposer: dStr,
  void_reason: dNullable(dVoidReason),
  blocker: dNullable(dStr),
  event_ids: dArr(dU64),
  world_count: dU8,
  category: dU8,
  deadline_sec: dU64,
  created_at_sec: dU64,
  approved_at_sec: dU64,
  expires_at_sec: dU64,
  open_not_before_sec: dU64,
  goal: dU128,
  ideal_wnear: dU128,
  ideal_usdc: dU128,
  s_hint: dU128,
  pledged_wnear: dU128,
  pledged_usdc: dU128,
  pledgers: dU32,
  progress_bps: dU32,
  bond: dU128,
  reserve: dU128,
  seed_lock_sec: dU64,
  opened: dNullable(dOpened),
};

export interface ProposalView extends ProposalCommon {
  status: ProposalViewStatus;
  new_event: NewEventView | null;
  preview: OpeningPreview | null;
}
const dProposalView = dObj<ProposalView>({
  ...commonShape,
  status: dLit(...PROPOSAL_STATUSES, "ready", "waiting"),
  new_event: dNullable(
    dObj<NewEventView>({
      question: dStr,
      outcome_names: dArr(dStr),
      rule: dStr,
      source: dStr,
      deadline_sec: dU64,
      category: dU8,
      terms: dTerms,
    }),
  ),
  preview: dNullable(dOpeningPreview),
});
export const decodeProposal = top(dNullable(dProposalView), "get_proposal");

export interface ProposalSummary extends ProposalCommon {
  status: ProposalStatus;
  new_event: NewEventSummary | null;
}
const dProposalSummary = dObj<ProposalSummary>({
  ...commonShape,
  status: dLit(...PROPOSAL_STATUSES),
  new_event: dNullable(dObj<NewEventSummary>({ question: dStr, outcome_names: dArr(dStr), deadline_sec: dU64, category: dU8, terms: dTerms })),
});
export const decodeProposalSummaries = top(dArr(dProposalSummary), "proposals_of_event");

export interface ProposalList {
  proposals: ProposalSummary[];
  next_from: number | null;
}
export const decodeProposalList = top(dObj<ProposalList>({ proposals: dArr(dProposalSummary), next_from: dNullable(dU64) }), "list_proposals");

export type PledgeState = "pledged" | "refundable" | "seed";
export interface PledgeView {
  proposal_id: number;
  account_id: string;
  wnear: U128;
  usdc: U128;
  state: PledgeState;
  shares: U128 | null;
  withdrawn_shares: U128;
  unused_wnear: U128;
  unused_usdc: U128;
  unused_paid: boolean;
  unlock_at_sec: number;
  max_withdrawable_shares: U128;
}
const dPledgeView = dObj<PledgeView>({
  proposal_id: dU64,
  account_id: dStr,
  wnear: dU128,
  usdc: dU128,
  state: dLit("pledged", "refundable", "seed"),
  shares: dNullable(dU128),
  withdrawn_shares: dU128,
  unused_wnear: dU128,
  unused_usdc: dU128,
  unused_paid: dBool,
  unlock_at_sec: dU64,
  max_withdrawable_shares: dU128,
});
export const decodePledge = top(dNullable(dPledgeView), "pledge_of");
export const decodePledges = top(dArr(dPledgeView), "pledges_of");

export interface PledgePreview {
  usable_before: U128;
  usable_after: U128;
  deployed_part: U128;
  goal_reached_after: boolean;
  needs: AssetName | null;
}
export const decodePledgePreview = top(
  dObj<PledgePreview>({ usable_before: dU128, usable_after: dU128, deployed_part: dU128, goal_reached_after: dBool, needs: dNullable(dAsset) }),
  "pledge_preview",
);

export interface MarketCheck {
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
export const decodeMarketCheck = top(
  dObj<MarketCheck>({
    canonical: dArr(dU64),
    world_count: dU8,
    blocker: dNullable(dStr),
    listed_market: dNullable(dU64),
    live_proposal: dNullable(dU64),
    goal: dU128,
    ideal_wnear: dU128,
    ideal_usdc: dU128,
    bond: dU128,
    reserve: dU128,
    expires_at_sec: dU64,
  }),
  "market_check",
);

/** K4 */
export interface EventCheckView {
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
export const decodeEventCheck = top(
  dObj<EventCheckView>({
    blocker: dNullable(dStr),
    live_proposal: dNullable(dU64),
    goal: dU128,
    ideal_wnear: dU128,
    ideal_usdc: dU128,
    s_ref: dNullable(dU128),
    odds: dPair(dU128),
    prices: dPair(dU128),
    bond: dU128,
    reserve: dU128,
  }),
  "event_check",
);

export type MarketOrigin = "legacy" | "owner" | "pledged";
export const MARKET_CARD_STATUSES = ["open", "deciding", "partly_resolved", "resolved"] as const;
export type MarketCardStatus = (typeof MARKET_CARD_STATUSES)[number];
const dCardStatus = dLit(...MARKET_CARD_STATUSES);

export interface SeedSummary {
  proposal_id: number;
  supply: U128;
  unlock_at_sec: number;
}
export interface MarketCard {
  scenario_id: number;
  listed: boolean;
  origin: MarketOrigin;
  proposal_id: number | null;
  event_ids: number[];
  world_count: number;
  possible: number;
  status: MarketCardStatus;
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
  seed: SeedSummary | null;
}
const dMarketCard = dObj<MarketCard>({
  scenario_id: dU64,
  listed: dBool,
  origin: dLit("legacy", "owner", "pledged"),
  proposal_id: dNullable(dU64),
  event_ids: dArr(dU64),
  world_count: dU8,
  possible: dU8,
  status: dCardStatus,
  categories: dArr(dU8),
  deadline_sec: dU64,
  created_at_sec: dU64,
  odds: dArr(dU128),
  odds_known: dBool,
  world_prices: dArr(dU128),
  implied_spot: dU128,
  pool_value: dU128,
  min_world_depth: dU128,
  pool_count: dU32,
  lendable: dBool,
  seed: dNullable(dObj<SeedSummary>({ proposal_id: dU64, supply: dU128, unlock_at_sec: dU64 })),
});
export const decodeMarketCard = top(dMarketCard, "market_card");
export const decodeMarket = top(dNullable(dMarketCard), "get_market");
export const decodeMarketCards = top(dArr(dMarketCard), "market_cards");

export interface MarketList {
  markets: MarketCard[];
  next_from: number | null;
}
export const decodeMarketList = top(dObj<MarketList>({ markets: dArr(dMarketCard), next_from: dNullable(dU64) }), "list_markets");

export interface RelatedMarket {
  scenario_id: number;
  event_ids: number[];
  world_count: number;
  status: MarketCardStatus;
  listed: boolean;
}
export interface RelatedMarkets {
  markets: RelatedMarket[];
  proposals: ProposalSummary[];
}
export const decodeRelatedMarkets = top(
  dObj<RelatedMarkets>({
    markets: dArr(dObj<RelatedMarket>({ scenario_id: dU64, event_ids: dArr(dU64), world_count: dU8, status: dCardStatus, listed: dBool })),
    proposals: dArr(dProposalSummary),
  }),
  "related_markets",
);

export interface MarketOfEvents {
  canonical: number[];
  listed_market: number | null;
  live_proposal: number | null;
}
export const decodeMarketOfEvents = top(
  dObj<MarketOfEvents>({ canonical: dArr(dU64), listed_market: dNullable(dU64), live_proposal: dNullable(dU64) }),
  "market_of_events",
);
export const decodeReferenceMarketOf = top(dNullable(dU64), "reference_market_of");

export interface EventMetaView {
  event_id: number;
  proposal_id: number;
  proposer: string | null;
  source: string;
  category: number;
}
export const decodeEventMeta = top(
  dNullable(dObj<EventMetaView>({ event_id: dU64, proposal_id: dU64, proposer: dNullable(dStr), source: dStr, category: dU8 })),
  "event_meta",
);

export interface SeedPositionView {
  pool_id: number;
  liquidity: U128;
  amount0: U128;
  amount1: U128;
  fees0: U128;
  fees1: U128;
}
export interface SeedVaultView {
  proposal_id: number;
  supply: U128;
  unlock_at_sec: number;
  positions: SeedPositionView[];
  idle: TokenAmount[];
}
export const decodeSeedVault = top(
  dNullable(
    dObj<SeedVaultView>({
      proposal_id: dU64,
      supply: dU128,
      unlock_at_sec: dU64,
      positions: dArr(dObj<SeedPositionView>({ pool_id: dU64, liquidity: dU128, amount0: dU128, amount1: dU128, fees0: dU128, fees1: dU128 })),
      idle: dArr(dTokenAmount),
    }),
  ),
  "seed_vault",
);

/** K5 */
export interface PerWorldAmounts {
  wnear: U128[];
  usdc: U128[];
}
export interface SeedWithdrawPreview {
  wnear_out: U128;
  usdc_out: U128;
  tokens: TokenAmount[];
  max_shares: U128;
  locked_until_sec: number;
  per_world: PerWorldAmounts;
}
export const decodeSeedWithdrawPreview = top(
  dObj<SeedWithdrawPreview>({
    wnear_out: dU128,
    usdc_out: dU128,
    tokens: dArr(dTokenAmount),
    max_shares: dU128,
    locked_until_sec: dU64,
    per_world: dObj<PerWorldAmounts>({ wnear: dArr(dU128), usdc: dArr(dU128) }),
  }),
  "preview_seed_withdraw",
);

export interface PledgeReturn {
  wnear: U128;
  usdc: U128;
}
export const decodePledgeReturn = top(dObj<PledgeReturn>({ wnear: dU128, usdc: dU128 }), "pledge_return");

/** v1 `EventView`; `get_events` (K6) returns a list of them in the order asked. */
export interface EventView {
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
const dEventView = dObj<EventView>({
  id: dU64,
  question: dStr,
  rule: dStr,
  outcome_names: dArr(dStr),
  deadline_sec: dU64,
  proposed_at_sec: dU64,
  proposed_outcome: dU8,
  proposal_open: dBool,
  finalized: dBool,
  outcome: dU8,
  finalizable_at_sec: dU64,
  proposed_by: dNullable(dLit("admin", "reporter", "outlayer")),
});
export const decodeEvent = top(dEventView, "get_event");
export const decodeEvents = top(dArr(dEventView), "get_events");

/** v1 `get_scenario`. */
export interface ScenarioInfoView {
  scenario_id: number;
  event_ids: number[];
  world_count: number;
  root: number;
  possible: number;
  resolution_count: number;
  halted: boolean;
  pool_ids: number[];
}
export const decodeScenario = top(
  dObj<ScenarioInfoView>({
    scenario_id: dU64,
    event_ids: dArr(dU64),
    world_count: dU8,
    root: dU8,
    possible: dU8,
    resolution_count: dU8,
    halted: dBool,
    pool_ids: dArr(dU64),
  }),
  "get_scenario",
);

/** v1 `get_order` / order book rows. */
export interface OrderViewV {
  id: string;
  maker: string;
  scenario_id: number;
  mask: number;
  side: "bid" | "ask";
  price: U128;
  amount: U128;
  remaining: U128;
  escrow: U128;
  expiry_sec: number;
  epoch: number;
}
const dOrder = dObj<OrderViewV>({
  id: dU128,
  maker: dStr,
  scenario_id: dU64,
  mask: dU8,
  side: dLit("bid", "ask"),
  price: dU128,
  amount: dU128,
  remaining: dU128,
  escrow: dU128,
  expiry_sec: dU64,
  epoch: dU8,
});
export const decodeOrder = top(dNullable(dOrder), "get_order");

export interface WorldBookView {
  bids: OrderViewV[];
  asks: OrderViewV[];
}
export const decodeWorldBook = top(dObj<WorldBookView>({ bids: dArr(dOrder), asks: dArr(dOrder) }), "orders_for_world");

/** v1 `backing` (audit only: 30.7 Tgas at 8 worlds). */
export interface WorldBackingView {
  world: number;
  possible: boolean;
  wnear_backed: boolean;
  usdc_backed: boolean;
}
export const decodeBacking = top(
  dObj<{ worlds: WorldBackingView[] }>({
    worlds: dArr(dObj<WorldBackingView>({ world: dU8, possible: dBool, wnear_backed: dBool, usdc_backed: dBool })),
  }),
  "backing",
);

export interface StorageBalanceView {
  total: U128;
  available: U128;
}
export const decodeStorageBalance = top(dNullable(dObj<StorageBalanceView>({ total: dU128, available: dU128 })), "storage_balance_of");

// get_app_config (v1 keys kept, v2 keys added)

export interface AssetCfgView {
  token_id: string;
  symbol: string;
  decimals: number;
}
export interface TierDefaultView {
  tier: Tier;
  config: TierConfigView;
}
export interface LendingConfigView {
  min_loan: U128;
  full_liquidation_hf: U128;
  small_loan: U128;
  close_factor: U128;
  max_collateral_pieces: number;
  defaults: TierDefaultView[];
}
export interface AppConfigV2 {
  owner_id: string;
  reporter_id: string | null;
  wnear: AssetCfgView;
  usdc: AssetCfgView;
  lltv: U128;
  liquidation_bonus: U128;
  borrow_rate_per_sec: U128;
  dispute_window_sec: number;
  twap_window_sec: number;
  twap_min_age_sec: number;
  min_pool_depth: U128;
  order_book: boolean;
  root_lp: boolean;
  spot_pool_id: number | null;
  event_count: number;
  scenario_count: number;
  /** The owner's demo record, free-form JSON (scripts read it through protocol.ts DemoRecord). */
  demo: unknown;
  code_version: string;
  state_version: number;
  paused: PauseFlag[];
  guardian_id: string | null;
  pending_owner_id: string | null;
  max_worlds: number;
  max_events: number;
  max_trade_fills: number;
  max_trade_fills_8w: number;
  reference_configured: boolean;
  proposal_count: number;
  lending: LendingConfigView;
}
const dAssetCfg = dObj<AssetCfgView>({ token_id: dStr, symbol: dStr, decimals: dU8 });
const dAny: Decoder<unknown> = (x) => x;
export const decodeAppConfigV2 = top(
  dObj<AppConfigV2>({
    owner_id: dStr,
    reporter_id: dNullable(dStr),
    wnear: dAssetCfg,
    usdc: dAssetCfg,
    lltv: dU128,
    liquidation_bonus: dU128,
    borrow_rate_per_sec: dU128,
    dispute_window_sec: dU64,
    twap_window_sec: dU64,
    twap_min_age_sec: dU64,
    min_pool_depth: dU128,
    order_book: dBool,
    root_lp: dBool,
    spot_pool_id: dNullable(dU64),
    event_count: dU64,
    scenario_count: dU64,
    demo: dAny,
    code_version: dStr,
    state_version: dU32,
    paused: dArr(dPauseFlag),
    guardian_id: dNullable(dStr),
    pending_owner_id: dNullable(dStr),
    max_worlds: dU8,
    max_events: dU8,
    max_trade_fills: dU32,
    max_trade_fills_8w: dU32,
    reference_configured: dBool,
    proposal_count: dU64,
    lending: dObj<LendingConfigView>({
      min_loan: dU128,
      full_liquidation_hf: dU128,
      small_loan: dU128,
      close_factor: dU128,
      max_collateral_pieces: dU32,
      defaults: dArr(dObj<TierDefaultView>({ tier: dTier, config: dTierConfig })),
    }),
  }),
  "get_app_config",
);

/** Every decoder by the view method it decodes, for table-driven checks and `measure --capture-fixtures`. */
export const VIEW_DECODERS: Readonly<Record<string, (x: unknown, path?: string) => unknown>> = {
  contract_version: decodeContractVersion,
  pause_state: decodePauseView,
  books: decodeBooksView,
  near_books: decodeNearBooks,
  world_supply: decodeWorldSupply,
  markets_of: decodeMarketsOf,
  mt_tokens: decodeMtTokens,
  world_prices: decodeWorldPrices,
  price_check: decodePriceCheck,
  get_reference: decodeReference,
  get_reference_config: decodeReferenceConfig,
  get_market_price_config: decodeMarketPriceCfg,
  get_default_price_config: decodeMarketPriceCfg,
  market_state: decodeMarketView,
  liquidation_status: decodeLiquidationStatus,
  tier_config: decodeTierConfig,
  health_factor: decodeHealth,
  collateral_values: decodeCollateralValues,
  collateral_of: decodeCollateralOf,
  lending_tiers: decodeLendingTiers,
  borrowers: decodeBorrowers,
  borrower_count: decodeBorrowerCount,
  liquidation_quote: decodeLiquidationQuote,
  market_params: decodeMarketParams,
  get_proposal: decodeProposal,
  list_proposals: decodeProposalList,
  proposals_of_event: decodeProposalSummaries,
  pledge_of: decodePledge,
  pledges_of: decodePledges,
  pledge_preview: decodePledgePreview,
  opening_preview: decodeOpeningPreview,
  market_check: decodeMarketCheck,
  event_check: decodeEventCheck,
  list_markets: decodeMarketList,
  market_cards: decodeMarketCards,
  get_market: decodeMarket,
  related_markets: decodeRelatedMarkets,
  market_of_events: decodeMarketOfEvents,
  reference_market_of: decodeReferenceMarketOf,
  event_meta: decodeEventMeta,
  seed_vault: decodeSeedVault,
  preview_seed_withdraw: decodeSeedWithdrawPreview,
  get_events: decodeEvents,
  get_event: decodeEvent,
  get_scenario: decodeScenario,
  get_order: decodeOrder,
  orders_for_world: decodeWorldBook,
  backing: decodeBacking,
  storage_balance_of: decodeStorageBalance,
  get_app_config: decodeAppConfigV2,
};
