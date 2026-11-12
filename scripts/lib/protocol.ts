// Typed calls into the Multiverse contract and the two mock tokens. Amounts cross this boundary as
// bigint internal units (18 decimals) and become U128 strings only in the JSON.

import type { Deployments } from "./deployments.ts";
import { call, ensureStorage, ftTransferCall, ONE_YOCTO, view, type CallResult, type FtTransferCallOptions } from "./near.ts";
import { exactRaw, parseNear, splitByCap, tgas, toInternal, toRaw, u128 } from "./units.ts";

export type AssetName = "wnear" | "usdc";

export interface PoolView {
  id: number;
  kind: "within" | "between" | "spot";
  scenario_id: number | null;
  world: number | null;
  mask0: number;
  mask1: number;
  token0: string;
  token1: string;
  reserve0: string;
  reserve1: string;
  wnear_reserve: string | null;
  usdc_reserve: string | null;
  liquidity: string;
  fee_pips: number;
  swap_count: number;
  price: string;
  twap_price: string | null;
  twap_ok: boolean;
}

export interface ScenarioInfo {
  scenario_id: number;
  event_ids: number[];
  world_count: number;
  root: number;
  possible: number;
  resolution_count: number;
  halted: boolean;
  pool_ids: number[];
}

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

export interface OrderView {
  id: string;
  maker: string;
  scenario_id: number;
  mask: number;
  side: "bid" | "ask";
  price: string;
  amount: string;
  remaining: string;
  escrow: string;
  expiry_sec: number;
  epoch: number;
}

export interface WorldBacking {
  world: number;
  possible: boolean;
  wnear_backed: boolean;
  usdc_backed: boolean;
}

export interface DemoRecord {
  spice_event: number;
  fed_event: number;
  past_fed_event: number | null;
  scenario_2x2: number;
  scenario_binary: number;
  implied_spot: string;
  odds_ships_bps: number;
  odds_cuts_bps: number;
  odds_source: string | null;
  seeded_at_sec: number;
  seeded_block: number;
  spot_from: "2x2" | "binary";
  ravi_order: string | null;
}

export interface AppConfig {
  owner_id: string;
  reporter_id: string | null;
  lltv: string;
  dispute_window_sec: number;
  twap_window_sec: number;
  twap_min_age_sec: number;
  min_pool_depth: string;
  order_book: boolean;
  root_lp: boolean;
  spot_pool_id: number | null;
  event_count: number;
  scenario_count: number;
  demo: DemoRecord | null;
}

export interface HealthView {
  health_factor: string | null;
  worst_world: number | null;
}

export interface CollateralPiece {
  piece: string;
  amount: string;
}

export const DEFAULT_PERSONA_STORAGE = parseNear("0.5");
export const OWNER_STORAGE = parseNear("3");
const CALL_GAS = tgas(100);

/** The contract and its two tokens, for one deployments file. */
export class Protocol {
  readonly d: Deployments;
  readonly contract: string;

  constructor(d: Deployments) {
    this.d = d;
    this.contract = d.contractId;
  }

  token(asset: AssetName): string {
    return asset === "wnear" ? this.d.wnear : this.d.usdc;
  }

  decimals(asset: AssetName): number {
    return this.d.tokens[asset].decimals;
  }

  view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return view<T>(this.contract, method, args);
  }

  /** Owner/user call with 1 yocto, as every value-moving method wants. */
  call1y<T = unknown>(signer: string, method: string, args: Record<string, unknown>, label?: string): Promise<CallResult<T>> {
    return call<T>(signer, this.contract, method, args, { deposit: ONE_YOCTO, gas: CALL_GAS, label: label ?? `${signer}: ${method}` });
  }

  async ensureStorage(payer: string, account: string, minAvailable = DEFAULT_PERSONA_STORAGE): Promise<void> {
    await ensureStorage(payer, this.contract, account, { minAvailable });
  }

  /** The wallet's token balance in the token's own base units (24 decimals for wNEAR, 6 for USDC). */
  async walletBalance(asset: AssetName, account: string): Promise<bigint> {
    return u128(await view<string>(this.token(asset), "ft_balance_of", { account_id: account }), "ft_balance_of");
  }

  /** The wallet's token balance in internal units, floored to what the contract would credit. */
  async walletInternal(asset: AssetName, account: string): Promise<bigint> {
    return this.internalOf(asset, await this.walletBalance(asset, account));
  }

  /** Token base units of `asset` to internal units. */
  internalOf(asset: AssetName, raw: bigint): bigint {
    return toInternal(raw, this.decimals(asset));
  }

  /** Internal units to token base units of `asset`, as the contract pays out. */
  rawOf(asset: AssetName, internal: bigint): bigint {
    return toRaw(internal, this.decimals(asset));
  }

  /** Faucet-mints whole token units worth `internal` to `account`, in calls under the per-call cap. */
  async mint(signer: string, asset: AssetName, account: string, internal: bigint): Promise<void> {
    const raw = exactRaw(internal, this.decimals(asset), `${asset} mint`);
    for (const amount of splitByCap(raw, BigInt(this.d.tokens[asset].maxMintPerCall))) {
      await call(signer, this.token(asset), "mint", { account_id: account, amount: amount.toString() }, {
        label: `mint ${amount} ${asset} base units to ${account}`,
      });
    }
  }

  /** `ft_transfer_call` of `internal` units into the contract with an action message. */
  async send(
    signer: string,
    asset: AssetName,
    internal: bigint,
    msg: Record<string, unknown>,
    options: FtTransferCallOptions = {},
  ): Promise<CallResult<string> & { used: bigint }> {
    const amount = exactRaw(internal, this.decimals(asset), `${asset} transfer`);
    const label = options.label ?? `${signer}: ${String(msg.action)} with ${amount} ${asset} base units`;
    return ftTransferCall(signer, this.token(asset), this.contract, amount, JSON.stringify(msg), { ...options, label });
  }

  /** Mints to `account` and splits the real asset from root into `toMasks` for it. */
  async mintAndSplit(minter: string, account: string, asset: AssetName, scenarioId: number, toMasks: number[], internal: bigint): Promise<void> {
    await this.mint(minter, asset, account, internal);
    await this.send(account, asset, internal, { action: "split", scenario_id: scenarioId, to_masks: toMasks });
  }

  appConfig(): Promise<AppConfig> {
    return this.view<AppConfig>("get_app_config");
  }

  scenario(id: number): Promise<ScenarioInfo> {
    return this.view<ScenarioInfo>("get_scenario", { scenario_id: id });
  }

  event(id: number): Promise<EventView> {
    return this.view<EventView>("get_event", { event_id: id });
  }

  label(scenarioId: number, mask: number): Promise<string> {
    return this.view<string>("verse_label", { scenario_id: scenarioId, mask });
  }

  pool(id: number): Promise<PoolView | null> {
    return this.view<PoolView | null>("get_pool", { pool_id: id });
  }

  spotPool(): Promise<PoolView | null> {
    return this.view<PoolView | null>("get_spot_pool");
  }

  async worldPools(scenarioId: number): Promise<Map<number, PoolView>> {
    const pools = await this.view<PoolView[]>("pools_of", { scenario_id: scenarioId });
    return new Map(pools.filter((p) => p.kind === "within" && p.world !== null).map((p) => [p.world as number, p]));
  }

  async odds(scenarioId: number): Promise<{ q: bigint[]; known: boolean }> {
    const o = await this.view<{ q: string[]; known: boolean }>("odds", { scenario_id: scenarioId });
    return { q: o.q.map((v) => u128(v, "odds")), known: o.known };
  }

  async impliedSpot(scenarioId: number): Promise<bigint> {
    return u128(await this.view<string>("implied_spot", { scenario_id: scenarioId }), "implied_spot");
  }

  async spotPrice(): Promise<bigint> {
    return u128(await this.view<string>("spot_price"), "spot_price");
  }

  async quoteSell(scenarioId: number, wnearAmount: bigint, sellMask: number): Promise<bigint[]> {
    const q = await this.view<string[]>("quote_sell", { scenario_id: scenarioId, wnear_amount: wnearAmount.toString(), sell_mask: sellMask });
    return q.map((v) => u128(v, "quote_sell"));
  }

  order(id: string): Promise<OrderView | null> {
    return this.view<OrderView | null>("get_order", { order_id: id });
  }

  async verseBalance(account: string, scenarioId: number, asset: AssetName, mask: number): Promise<bigint> {
    const v = await this.view<string>("mt_balance_of", { account_id: account, token_id: `${scenarioId}:${asset}:${mask}` });
    return u128(v, "mt_balance_of");
  }

  async realBalance(account: string, asset: AssetName): Promise<bigint> {
    return u128(await this.view<string>("real_balance_of", { account_id: account, asset }), "real_balance_of");
  }

  async debt(scenarioId: number, account: string): Promise<bigint> {
    return u128(await this.view<string>("debt_of", { scenario_id: scenarioId, account_id: account }), "debt_of");
  }

  async health(scenarioId: number, account: string): Promise<{ hf: bigint | null; worst: number | null }> {
    const h = await this.view<HealthView>("health_factor", { scenario_id: scenarioId, account_id: account });
    return { hf: h.health_factor === null ? null : u128(h.health_factor, "health_factor"), worst: h.worst_world };
  }

  async collateralValues(scenarioId: number, account: string): Promise<bigint[]> {
    const v = await this.view<{ values: string[] }>("collateral_values", { scenario_id: scenarioId, account_id: account });
    return v.values.map((x) => u128(x, "collateral_values"));
  }

  collateral(scenarioId: number, account: string): Promise<CollateralPiece[]> {
    return this.view<CollateralPiece[]>("collateral_of", { scenario_id: scenarioId, account_id: account });
  }

  async backing(scenarioId: number): Promise<WorldBacking[]> {
    return (await this.view<{ worlds: WorldBacking[] }>("backing", { scenario_id: scenarioId })).worlds;
  }

  async demoRecord(): Promise<DemoRecord> {
    const demo = (await this.appConfig()).demo;
    if (!demo) throw new Error(`${this.contract} has no demo record; run seed-demo.ts first`);
    return demo;
  }
}

/** Ids of the pieces a world counts: verse pieces whose mask covers it, and real ones. */
export function pieceCovers(piece: string, world: number): { asset: AssetName; covers: boolean } {
  if (piece === "wnear" || piece === "usdc") return { asset: piece, covers: true };
  const [, asset, mask] = piece.split(":");
  if ((asset !== "wnear" && asset !== "usdc") || mask === undefined) throw new Error(`unknown collateral piece ${piece}`);
  return { asset, covers: (Number(mask) & (1 << world)) !== 0 };
}
