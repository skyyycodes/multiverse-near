// Typed calls into the Multiverse contract and the two mock tokens. Amounts cross this boundary as
// bigint internal units (18 decimals) and become U128 strings only in the JSON.
//
// v2: a wrapper for every entry point and view of SPEC-C 3 (scripts design 10.4), every view
// decoded (views.ts), every msg encoded (msgs.ts), and the version guard (S-2): nothing v2-only (a
// non-Normal tier, a cash liquidation, a v2 method) is sent to a contract whose state version is
// below 2, because a v1 contract silently ignores unknown call arguments and would act on Normal.
// Gas and deposits follow SPEC.md 3.3.

import { ContractMethodNotFoundError } from "near-api-js/rpc-errors";

import type { Deployments } from "./deployments.ts";
import { encodeMsg, tierField, V2OnlyOnV1Contract, type AssetName, type Msg, type PlanEntry, type Receive, type Tier } from "./msgs.ts";
import {
  call,
  ensureStorage,
  ftTransferCall,
  ONE_YOCTO,
  provider,
  view,
  viewAt,
  type BlockRef,
  type CallResult,
  type FtTransferCallOptions,
} from "./near.ts";
import { exactRaw, parseNear, splitByCap, tgas, toInternal, toRaw, u128 } from "./units.ts";
import {
  decodeAccountView,
  decodeAppConfigV2,
  decodeBacking,
  decodeBooksView,
  decodeBorrowerCount,
  decodeBorrowers,
  decodeCollateralOf,
  decodeCollateralValues,
  decodeContractVersion,
  decodeEvent,
  decodeEventCheck,
  decodeEventMeta,
  decodeEvents,
  decodeHealth,
  decodeLendingTiers,
  decodeLiquidationQuote,
  decodeLiquidationStatus,
  decodeMarket,
  decodeMarketCards,
  decodeMarketCheck,
  decodeMarketList,
  decodeMarketOfEvents,
  decodeMarketParams,
  decodeMarketPriceCfg,
  decodeMarketsOf,
  decodeMarketView,
  decodeMtTokens,
  decodeNearBooks,
  decodeOpeningPreview,
  decodeOrder,
  decodePauseView,
  decodePledge,
  decodePledgePreview,
  decodePledgeReturn,
  decodePledges,
  decodePriceCheck,
  decodeProposal,
  decodeProposalList,
  decodeProposalSummaries,
  decodeReference,
  decodeReferenceConfig,
  decodeReferenceMarketOf,
  decodeRelatedMarkets,
  decodeScenario,
  decodeSeedVault,
  decodeSeedWithdrawPreview,
  decodeStorageBalance,
  decodeTierConfig,
  decodeWorldBook,
  decodeWorldPrices,
  decodeWorldSupply,
  type AccountView,
  type AppConfigV2,
  type BooksView,
  type BorrowerRow,
  type BorrowersPage,
  type ContractVersion,
  type EventCheckView,
  type EventMetaView,
  type LendingTierRow,
  type LiquidationQuote,
  type LiquidationStatus,
  type MarketCard,
  type MarketCheck,
  type MarketList,
  type MarketOfEvents,
  type MarketParams,
  type MarketParamsView,
  type MarketPriceCfg,
  type MarketView,
  type MtToken,
  type NearBooksView,
  type OpeningPreview,
  type OpeningTerms,
  type OrderViewV,
  type PauseFlag,
  type PauseView,
  type PledgePreview,
  type PledgeReturn,
  type PledgeView,
  type PriceCheck,
  type ProposalSummary,
  type ProposalView,
  type ReferenceConfig,
  type ReferenceView,
  type RelatedMarkets,
  type ScenarioInfoView,
  type SeedVaultView,
  type SeedWithdrawPreview,
  type StorageBalanceView,
  type TierConfigResult,
  type TierConfigView,
  type WorldBackingView,
  type WorldBookView,
  type WorldPriceRow,
  type WorldSupplyView,
} from "./views.ts";

export type { AssetName, Receive, Tier };

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
  /** v2: the world's price class (world pools); absent on v1. */
  price_status?: string | null;
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

/** What a pinned check reads: the contract's views, the tokens' views and accounts, all at one block. */
export interface ChainReader {
  readonly contract: string;
  viewAt<T>(method: string, args: Record<string, unknown>, block: BlockRef): Promise<T>;
  tokenViewAt<T>(asset: AssetName, method: string, args: Record<string, unknown>, block: BlockRef): Promise<T>;
  accountAt(accountId: string, block: BlockRef): Promise<{ amount: bigint; storageUsage: number; codeHash: string }>;
  /** Block time of `block` in whole seconds. */
  blockTimeSec(block: number): Promise<number>;
  decimals(asset: AssetName): number;
}

/** `tier_config`, `set_tier_config` and `set_default_tier_config` take this shape (all U128 strings). */
export type TierConfigInput = TierConfigView;

export interface LendingParamsInput {
  min_loan: string;
  full_liquidation_hf: string;
  small_loan: string;
}

export interface NewEventSpec {
  question: string;
  outcomeNames: string[];
  rule: string;
  source: string;
  deadlineSec: number;
  category: number;
  terms: OpeningTerms;
}

export type ProposalFilter = "live" | "review" | "pledging" | "opened" | "closed" | "all";

/** What a v1 contract (no `contract_version`) reads as. */
export const V1_CONTRACT_VERSION: ContractVersion = {
  code_version: "1.0.0",
  state_version: 1,
  recorded_code_version: "1.0.0",
  upgraded_at_sec: 0,
  upgraded_from: "",
  event_version: "1.0.0",
  legacy_scenario_count: 0,
};

/** The view does not exist on this contract (a v1 contract asked a v2 view). */
export function isMethodNotFound(err: unknown): boolean {
  if (err instanceof ContractMethodNotFoundError) return true;
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /MethodNotFound|method is not found|Contract method is not found/i.test(text);
}

/**
 * NEAR a proposal attaches (SPEC.md 3.3): bond + reserve_base + W × reserve_per_world, with W = 2
 * for a new event. Testnet column: 0.30 NEAR for Kind A, 0.15 / 0.20 / 0.30 for Kind B at 2 / 4 / 8.
 */
export function requiredDeposit(params: MarketParams, kind: "new_event" | "market", worldCount: number): bigint {
  if (![2, 4, 8].includes(worldCount)) throw new Error(`a market has 2, 4 or 8 worlds, not ${worldCount}`);
  if (kind === "new_event" && worldCount !== 2) throw new Error("a new event's market has 2 worlds");
  const bond = u128(kind === "new_event" ? params.bond_new_event : params.bond_market, "bond");
  return bond + u128(params.reserve_base, "reserve_base") + BigInt(worldCount) * u128(params.reserve_per_world, "reserve_per_world");
}

/** `top_up_proposal` deposit: ceil((needed − available) × 1.1), 0 when nothing is missing. */
export function topUpAmount(needed: bigint, available: bigint): bigint {
  if (needed <= available) return 0n;
  return ((needed - available) * 11n + 9n) / 10n;
}

/** The canonical event set of a combination: ascending, no duplicates, 1 to 3 events (SPEC-C 3.7.1). */
export function canonicalEvents(eventIds: readonly number[]): number[] {
  if (eventIds.length < 1 || eventIds.length > 3) throw new Error(`BadEventCount(${eventIds.length})`);
  const sorted = [...eventIds].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1]) throw new Error(`DuplicateEvent(${sorted[i]})`);
  return sorted;
}

export const worldCountOf = (eventCount: number): number => 2 ** eventCount;

export const DEFAULT_PERSONA_STORAGE = parseNear("0.5");
export const OWNER_STORAGE = parseNear("3");
const CALL_GAS = tgas(100);
const MAX_UPGRADE_ACCOUNTS = 100;
/** set_market_listing / set_event_meta: 0.01 NEAR pays any growth, the excess comes back (K8). */
export const LISTING_DEPOSIT = parseNear("0.01");
/** set_reference_config pays its own storage (≤ ~2.4 KB). */
export const REFERENCE_CONFIG_DEPOSIT = parseNear("0.05");

const str = (n: bigint): string => n.toString();

/** The contract and its two tokens, for one deployments file. */
export class Protocol implements ChainReader {
  readonly d: Deployments;
  readonly contract: string;
  private versionCache: Promise<ContractVersion> | undefined;

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

  viewAt<T>(method: string, args: Record<string, unknown>, block: BlockRef): Promise<T> {
    return viewAt<T>(this.contract, method, args, block);
  }

  tokenViewAt<T>(asset: AssetName, method: string, args: Record<string, unknown>, block: BlockRef): Promise<T> {
    return viewAt<T>(this.token(asset), method, args, block);
  }

  async accountAt(accountId: string, block: BlockRef): Promise<{ amount: bigint; storageUsage: number; codeHash: string }> {
    const v = await provider.viewAccount({ accountId, blockQuery: block === "final" ? { finality: "final" } : { blockId: block } });
    return { amount: BigInt(v.amount), storageUsage: v.storage_usage, codeHash: v.code_hash };
  }

  async blockTimeSec(block: number): Promise<number> {
    const b = await provider.viewBlock({ blockId: block });
    return Number(BigInt(b.header.timestamp_nanosec) / 1_000_000_000n);
  }

  /** A decoded view at `block` (default the latest final block). */
  private async v<T>(method: string, args: Record<string, unknown>, decode: (x: unknown, path?: string) => T, block: BlockRef = "final"): Promise<T> {
    return decode(await this.viewAt<unknown>(method, args, block), method);
  }

  // Version guard (S-2)

  /** `contract_version()`, cached per Protocol; a contract without it is v1 (state version 1). */
  version(refresh = false): Promise<ContractVersion> {
    if (refresh || !this.versionCache) {
      this.versionCache = this.viewAt<unknown>("contract_version", {}, "final").then(
        (x) => decodeContractVersion(x),
        (err: unknown) => {
          if (isMethodNotFound(err)) return V1_CONTRACT_VERSION;
          this.versionCache = undefined;
          throw err;
        },
      );
    }
    return this.versionCache;
  }

  async stateVersion(): Promise<number> {
    return (await this.version()).state_version;
  }

  /** Throws V2OnlyOnV1Contract(`what`) unless the contract is v2 or later. */
  async requireV2(what: string): Promise<void> {
    if ((await this.stateVersion()) < 2) throw new V2OnlyOnV1Contract(what);
  }

  /** Call arguments plus the tier when it is not Normal; reads the version only when it must. */
  async withTier<T extends Record<string, unknown>>(args: T, tier: Tier = "normal"): Promise<T & { tier?: Tier }> {
    if (tier === "normal") return args;
    return { ...args, ...tierField(tier, await this.stateVersion()) };
  }

  /** `msg` for an ft_transfer_call, checked against the contract's version. */
  async encode(m: Msg): Promise<string> {
    const needsVersion =
      m.action === "fund_insurance" ||
      m.action === "pledge" ||
      ("tier" in m && m.tier !== undefined && m.tier !== "normal") ||
      (m.action === "liquidate" && (m.receive === "cash" || m.min_out !== undefined));
    return encodeMsg(m, needsVersion ? await this.stateVersion() : 1);
  }

  // Sends

  /** Owner/user call with 1 yocto, as every value-moving method wants. */
  call1y<T = unknown>(signer: string, method: string, args: Record<string, unknown>, label?: string): Promise<CallResult<T>> {
    return call<T>(signer, this.contract, method, args, { deposit: ONE_YOCTO, gas: CALL_GAS, label: label ?? `${signer}: ${method}` });
  }

  /** A contract call with an explicit deposit and gas (SPEC.md 3.3). */
  callWith<T = unknown>(
    signer: string,
    method: string,
    args: Record<string, unknown>,
    opts: { deposit: bigint; gasTgas: number; label?: string; keyVariant?: string },
  ): Promise<CallResult<T>> {
    return call<T>(signer, this.contract, method, args, {
      deposit: opts.deposit,
      gas: tgas(opts.gasTgas),
      keyVariant: opts.keyVariant,
      label: opts.label ?? `${signer}: ${method}`,
    });
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

  /** `ft_transfer_call` of `internal` units into the contract with an action message (v1 form, unchecked). */
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

  /** `ft_transfer_call` with a typed msg (msgs.ts): stable bytes, client-side checks, the version guard. */
  async sendMsg(
    signer: string,
    asset: AssetName,
    internal: bigint,
    m: Msg,
    options: FtTransferCallOptions = {},
  ): Promise<CallResult<string> & { used: bigint }> {
    const amount = exactRaw(internal, this.decimals(asset), `${asset} transfer`);
    const msg = await this.encode(m);
    const label = options.label ?? `${signer}: ${m.action} with ${amount} ${asset} base units`;
    return ftTransferCall(signer, this.token(asset), this.contract, amount, msg, { ...options, label });
  }

  /** Mints to `account` and splits the real asset from root into `toMasks` for it. */
  async mintAndSplit(minter: string, account: string, asset: AssetName, scenarioId: number, toMasks: number[], internal: bigint): Promise<void> {
    await this.mint(minter, asset, account, internal);
    await this.sendMsg(account, asset, internal, { action: "split", scenario_id: scenarioId, to_masks: toMasks });
  }

  // v1 views

  appConfig(): Promise<AppConfig> {
    return this.view<AppConfig>("get_app_config");
  }

  /** `get_app_config` with the v2 keys, decoded. */
  appConfigV2(block: BlockRef = "final"): Promise<AppConfigV2> {
    return this.v("get_app_config", {}, decodeAppConfigV2, block);
  }

  scenario(id: number): Promise<ScenarioInfo> {
    return this.view<ScenarioInfo>("get_scenario", { scenario_id: id });
  }

  scenarioAt(id: number, block: BlockRef): Promise<ScenarioInfoView> {
    return this.v("get_scenario", { scenario_id: id }, decodeScenario, block);
  }

  event(id: number): Promise<EventView> {
    return this.view<EventView>("get_event", { event_id: id });
  }

  /** K6: up to 24 events in the order asked. */
  async events(ids: number[], block: BlockRef = "final"): Promise<EventView[]> {
    if (ids.length > 24) throw new Error(`TooManyIds(${ids.length}, 24)`);
    await this.requireV2("get_events");
    return this.v("get_events", { event_ids: ids }, decodeEvents, block);
  }

  eventAt(id: number, block: BlockRef): Promise<EventView> {
    return this.v("get_event", { event_id: id }, decodeEvent, block);
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

  orderAt(id: string, block: BlockRef): Promise<OrderViewV | null> {
    return this.v("get_order", { order_id: id }, decodeOrder, block);
  }

  ordersForWorld(sid: number, world: number, limit: number | null, block: BlockRef = "final"): Promise<WorldBookView> {
    return this.v("orders_for_world", { scenario_id: sid, world, limit }, decodeWorldBook, block);
  }

  async verseBalance(account: string, scenarioId: number, asset: AssetName, mask: number): Promise<bigint> {
    const v = await this.view<string>("mt_balance_of", { account_id: account, token_id: `${scenarioId}:${asset}:${mask}` });
    return u128(v, "mt_balance_of");
  }

  async realBalance(account: string, asset: AssetName): Promise<bigint> {
    return u128(await this.view<string>("real_balance_of", { account_id: account, asset }), "real_balance_of");
  }

  async backing(scenarioId: number, block: BlockRef = "final"): Promise<WorldBacking[]> {
    const b: { worlds: WorldBackingView[] } = await this.v("backing", { scenario_id: scenarioId }, decodeBacking, block);
    return b.worlds;
  }

  storageBalance(account: string, block: BlockRef = "final"): Promise<StorageBalanceView | null> {
    return this.v("storage_balance_of", { account_id: account }, decodeStorageBalance, block);
  }

  async demoRecord(): Promise<DemoRecord> {
    const demo = (await this.appConfig()).demo;
    if (!demo) throw new Error(`${this.contract} has no demo record; run seed-demo.ts first`);
    return demo;
  }

  // OPS

  pauseState(block: BlockRef = "final"): Promise<PauseView> {
    return this.v("pause_state", {}, decodePauseView, block);
  }

  /** One page of `books` (default 50 scenarios, at most 100). */
  books(from: number | null = null, limit: number | null = null, block: BlockRef = "final"): Promise<BooksView> {
    return this.v("books", { from_scenario: from, limit }, decodeBooksView, block);
  }

  /** Every page of `books` at one block (the block must be a height, so the pages agree). */
  async booksAll(block: number): Promise<BooksView[]> {
    const pages: BooksView[] = [];
    let from: number | null = null;
    for (;;) {
      const page: BooksView = await this.books(from, 100, block);
      pages.push(page);
      if (page.next_scenario === null) return pages;
      if (from !== null && page.next_scenario <= from) throw new Error(`books: next_scenario ${page.next_scenario} does not advance past ${from}`);
      from = page.next_scenario;
    }
  }

  nearBooks(block: BlockRef = "final"): Promise<NearBooksView> {
    return this.v("near_books", {}, decodeNearBooks, block);
  }

  /** Owner or guardian; no deposit, so the guardian's function-call key (`pause` variant) can sign. */
  async pause(signer: string, flags: PauseFlag[], reason: string, keyVariant?: string): Promise<CallResult<unknown>> {
    if (flags.length === 0) throw new Error("EmptyPauseFlags");
    if (Buffer.byteLength(reason) > 256) throw new Error("TextTooLong(reason)");
    await this.requireV2("pause");
    return this.callWith(signer, "pause", { flags, reason }, { deposit: 0n, gasTgas: 30, keyVariant, label: `${signer}: pause ${flags.join(",")}` });
  }

  async unpause(owner: string, flags: PauseFlag[], graceSec?: number): Promise<CallResult<unknown>> {
    if (flags.length === 0) throw new Error("EmptyPauseFlags");
    await this.requireV2("unpause");
    return this.callWith(owner, "unpause", { flags, liquidation_grace_sec: graceSec ?? null }, {
      deposit: ONE_YOCTO,
      gasTgas: 30,
      label: `${owner}: unpause ${flags.join(",")}${graceSec === undefined ? "" : ` (grace ${graceSec} s)`}`,
    });
  }

  async setGuardian(owner: string, guardianId: string | null): Promise<CallResult<unknown>> {
    await this.requireV2("set_guardian");
    return this.callWith(owner, "set_guardian", { guardian_id: guardianId }, { deposit: ONE_YOCTO, gasTgas: 30 });
  }

  async proposeOwner(owner: string, ownerId: string | null): Promise<CallResult<unknown>> {
    await this.requireV2("propose_owner");
    return this.callWith(owner, "propose_owner", { owner_id: ownerId }, { deposit: ONE_YOCTO, gasTgas: 30 });
  }

  async acceptOwner(signer: string): Promise<CallResult<unknown>> {
    await this.requireV2("accept_owner");
    return this.callWith(signer, "accept_owner", {}, { deposit: ONE_YOCTO, gasTgas: 30 });
  }

  async upgradeAccounts(signer: string, ids: string[]): Promise<CallResult<number>> {
    if (ids.length > MAX_UPGRADE_ACCOUNTS) throw new Error(`TooManyAccounts(${ids.length}, ${MAX_UPGRADE_ACCOUNTS})`);
    await this.requireV2("upgrade_accounts");
    return this.callWith<number>(signer, "upgrade_accounts", { account_ids: ids }, { deposit: ONE_YOCTO, gasTgas: 300, label: `${signer}: upgrade_accounts(${ids.length})` });
  }

  // EW

  worldSupply(sid: number, block: BlockRef = "final"): Promise<WorldSupplyView> {
    return this.v("world_supply", { scenario_id: sid }, decodeWorldSupply, block);
  }

  marketsOf(account: string, block: BlockRef = "final"): Promise<number[]> {
    return this.v("markets_of", { account_id: account }, decodeMarketsOf, block);
  }

  mtTokens(from: string | null = null, limit: number | null = null): Promise<MtToken[]> {
    return this.v("mt_tokens", { from_index: from, limit }, decodeMtTokens);
  }

  /** Every token `account` holds, page by page (NEP-245 order: scenario, asset, mask). */
  async *mtTokensForOwner(account: string, pageSize = 50): AsyncGenerator<MtToken> {
    for (let from = 0; ; from += pageSize) {
      const page = await this.v("mt_tokens_for_owner", { account_id: account, from_index: String(from), limit: pageSize }, decodeMtTokens);
      yield* page;
      if (page.length < pageSize) return;
    }
  }

  // PRC

  worldPrices(sid: number, block: BlockRef = "final"): Promise<WorldPriceRow[]> {
    return this.v("world_prices", { scenario_id: sid }, decodeWorldPrices, block);
  }

  priceCheck(sid: number, block: BlockRef = "final"): Promise<PriceCheck> {
    return this.v("price_check", { scenario_id: sid }, decodePriceCheck, block);
  }

  reference(block: BlockRef = "final"): Promise<ReferenceView | null> {
    return this.v("get_reference", {}, decodeReference, block);
  }

  referenceConfig(block: BlockRef = "final"): Promise<ReferenceConfig | null> {
    return this.v("get_reference_config", {}, decodeReferenceConfig, block);
  }

  marketPriceConfig(sid: number, block: BlockRef = "final"): Promise<MarketPriceCfg> {
    return this.v("get_market_price_config", { scenario_id: sid }, decodeMarketPriceCfg, block);
  }

  defaultPriceConfig(block: BlockRef = "final"): Promise<MarketPriceCfg> {
    return this.v("get_default_price_config", {}, decodeMarketPriceCfg, block);
  }

  /** Payable: at least `guest.deposit` (0.005 NEAR); 300 Tgas (the request needs ≥ 240). */
  async requestReference(signer: string, deposit: bigint, keyVariant?: string): Promise<CallResult<unknown>> {
    await this.requireV2("request_reference");
    return this.callWith(signer, "request_reference", {}, { deposit, gasTgas: 300, keyVariant });
  }

  /** The resolver's `reference` function-call key; no deposit. */
  async reportReference(reporter: string, priceWad: bigint, observedAtSec: number, keyVariant = "reference"): Promise<CallResult<unknown>> {
    await this.requireV2("report_reference");
    return this.callWith(reporter, "report_reference", { price: str(priceWad), observed_at: observedAtSec }, {
      deposit: 0n,
      gasTgas: 30,
      keyVariant,
    });
  }

  async setReferenceConfig(owner: string, cfg: ReferenceConfig, deposit = REFERENCE_CONFIG_DEPOSIT): Promise<CallResult<unknown>> {
    await this.requireV2("set_reference_config");
    return this.callWith(owner, "set_reference_config", { config: cfg }, { deposit, gasTgas: 30 });
  }

  async setDefaultPriceConfig(owner: string, cfg: MarketPriceCfg): Promise<CallResult<unknown>> {
    await this.requireV2("set_default_price_config");
    return this.callWith(owner, "set_default_price_config", { cfg }, { deposit: ONE_YOCTO, gasTgas: 30 });
  }

  async setMarketPriceConfig(owner: string, sid: number, cfg: MarketPriceCfg): Promise<CallResult<unknown>> {
    await this.requireV2("set_market_price_config");
    return this.callWith(owner, "set_market_price_config", { scenario_id: sid, cfg }, { deposit: ONE_YOCTO, gasTgas: 30 });
  }

  // LEND views

  private async tierView<T>(method: string, args: Record<string, unknown>, tier: Tier, decode: (x: unknown, path?: string) => T, block: BlockRef): Promise<T> {
    return this.v(method, await this.withTier(args, tier), decode, block);
  }

  async debt(scenarioId: number, account: string, tier: Tier = "normal", block: BlockRef = "final"): Promise<bigint> {
    const args = await this.withTier({ scenario_id: scenarioId, account_id: account }, tier);
    return u128(await this.viewAt<string>("debt_of", args, block), "debt_of");
  }

  async health(scenarioId: number, account: string, tier: Tier = "normal", block: BlockRef = "final"): Promise<{ hf: bigint | null; worst: number | null }> {
    const h = await this.tierView("health_factor", { scenario_id: scenarioId, account_id: account }, tier, decodeHealth, block);
    return { hf: h.health_factor === null ? null : u128(h.health_factor, "health_factor"), worst: h.worst_world };
  }

  async collateralValues(scenarioId: number, account: string, tier: Tier = "normal", block: BlockRef = "final"): Promise<bigint[]> {
    const v = await this.tierView("collateral_values", { scenario_id: scenarioId, account_id: account }, tier, decodeCollateralValues, block);
    return v.values.map((x) => u128(x, "collateral_values"));
  }

  collateral(scenarioId: number, account: string, tier: Tier = "normal", block: BlockRef = "final"): Promise<CollateralPiece[]> {
    return this.tierView("collateral_of", { scenario_id: scenarioId, account_id: account }, tier, decodeCollateralOf, block);
  }

  async supplyBalance(sid: number, account: string, tier: Tier = "normal", block: BlockRef = "final"): Promise<bigint> {
    return u128(await this.viewAt<string>("supply_balance_of", await this.withTier({ scenario_id: sid, account_id: account }, tier), block), "supply_balance_of");
  }

  async supplyPrincipal(sid: number, account: string, tier: Tier = "normal", block: BlockRef = "final"): Promise<bigint> {
    return u128(await this.viewAt<string>("supply_principal_of", await this.withTier({ scenario_id: sid, account_id: account }, tier), block), "supply_principal_of");
  }

  /** v2 `market_state` (v1 keys plus the tier's books and config). */
  marketState(sid: number, tier: Tier = "normal", block: BlockRef = "final"): Promise<MarketView> {
    return this.tierView("market_state", { scenario_id: sid }, tier, decodeMarketView, block);
  }

  liquidationStatus(sid: number, account: string, tier: Tier = "normal", block: BlockRef = "final"): Promise<LiquidationStatus> {
    return this.tierView("liquidation_status", { scenario_id: sid, account_id: account }, tier, decodeLiquidationStatus, block);
  }

  async tierConfig(sid: number, tier: Tier, block: BlockRef = "final"): Promise<TierConfigResult> {
    await this.requireV2("tier_config");
    return this.v("tier_config", { scenario_id: sid, tier }, decodeTierConfig, block);
  }

  async lendingTiers(sid: number, account: string | null = null, block: BlockRef = "final"): Promise<LendingTierRow[]> {
    await this.requireV2("lending_tiers");
    return this.v("lending_tiers", { scenario_id: sid, account_id: account }, decodeLendingTiers, block);
  }

  /** The tier's `AccountView` as `borrow_view` embeds it (via `lending_tiers`). */
  async accountView(sid: number, account: string, tier: Tier = "normal", block: BlockRef = "final"): Promise<AccountView | null> {
    const rows = await this.lendingTiers(sid, account, block);
    const row = rows.find((r) => r.tier === tier);
    if (!row) throw new Error(`lending_tiers(${sid}) has no ${tier} row`);
    return row.account === null ? null : decodeAccountView(row.account, `lending_tiers.${tier}.account`);
  }

  async borrowerCount(sid: number, tier: Tier = "normal", block: BlockRef = "final"): Promise<number> {
    await this.requireV2("borrower_count");
    return this.tierView("borrower_count", { scenario_id: sid }, tier, decodeBorrowerCount, block);
  }

  async borrowers(
    sid: number,
    tier: Tier = "normal",
    opts: { fromIndex?: number; limit?: number; maxHf?: bigint } = {},
    block: BlockRef = "final",
  ): Promise<BorrowersPage> {
    await this.requireV2("borrowers");
    const args = {
      scenario_id: sid,
      from_index: opts.fromIndex ?? null,
      limit: opts.limit ?? null,
      max_health_factor: opts.maxHf === undefined ? null : str(opts.maxHf),
    };
    return this.tierView("borrowers", args, tier, decodeBorrowers, block);
  }

  /** Every borrower of a market (optionally HF below `maxHf`), page by page at one block. */
  async *allBorrowers(sid: number, tier: Tier = "normal", maxHf?: bigint, block: BlockRef = "final"): AsyncGenerator<BorrowerRow> {
    let from: number | undefined;
    for (;;) {
      const page: BorrowersPage = await this.borrowers(sid, tier, { fromIndex: from, limit: 100, maxHf }, block);
      yield* page.rows;
      if (page.next_index === null) return;
      if (from !== undefined && page.next_index <= from) throw new Error(`borrowers: next_index ${page.next_index} does not advance past ${from}`);
      from = page.next_index;
    }
  }

  async liquidationQuote(
    sid: number,
    account: string,
    tier: Tier = "normal",
    repay: bigint | "max" | null = null,
    receive: Receive | null = null,
    block: BlockRef = "final",
  ): Promise<LiquidationQuote> {
    await this.requireV2("liquidation_quote");
    const args = {
      scenario_id: sid,
      account_id: account,
      repay_amount: repay === null ? null : repay === "max" ? "max" : str(repay),
      receive,
    };
    return this.tierView("liquidation_quote", args, tier, decodeLiquidationQuote, block);
  }

  // LEND methods (direct calls, 1 yocto)

  async borrow(signer: string, sid: number, amount: bigint, tier: Tier = "normal"): Promise<CallResult<unknown>> {
    return this.callWith(signer, "borrow", await this.withTier({ scenario_id: sid, amount: str(amount) }, tier), {
      deposit: ONE_YOCTO,
      gasTgas: 150,
      label: `${signer}: borrow ${amount} (${tier})`,
    });
  }

  async withdrawSupply(signer: string, sid: number, amount: bigint | null, tier: Tier = "normal"): Promise<CallResult<string>> {
    return this.callWith<string>(signer, "withdraw_supply", await this.withTier({ scenario_id: sid, amount: amount === null ? null : str(amount) }, tier), {
      deposit: ONE_YOCTO,
      gasTgas: 150,
    });
  }

  async depositCollateral(signer: string, sid: number, piece: string, amount: bigint, tier: Tier = "normal"): Promise<CallResult<unknown>> {
    return this.callWith(signer, "deposit_collateral", await this.withTier({ scenario_id: sid, piece, amount: str(amount) }, tier), {
      deposit: ONE_YOCTO,
      gasTgas: 100,
    });
  }

  async withdrawCollateral(signer: string, sid: number, piece: string, amount: bigint, tier: Tier = "normal"): Promise<CallResult<unknown>> {
    return this.callWith(signer, "withdraw_collateral", await this.withTier({ scenario_id: sid, piece, amount: str(amount) }, tier), {
      deposit: ONE_YOCTO,
      gasTgas: 100,
    });
  }

  async repayFromBalance(signer: string, sid: number, amount: bigint | null, tier: Tier = "normal"): Promise<CallResult<string>> {
    return this.callWith<string>(signer, "repay_from_balance", await this.withTier({ scenario_id: sid, amount: amount === null ? null : str(amount) }, tier), {
      deposit: ONE_YOCTO,
      gasTgas: 100,
    });
  }

  async closeAfterResolution(signer: string, sid: number, tier: Tier = "normal"): Promise<CallResult<string>> {
    return this.callWith<string>(signer, "close_after_resolution", await this.withTier({ scenario_id: sid }, tier), { deposit: ONE_YOCTO, gasTgas: 150 });
  }

  async writeOffBadDebt(signer: string, sid: number, account: string, tier: Tier = "normal"): Promise<CallResult<string>> {
    await this.requireV2("write_off_bad_debt");
    return this.callWith<string>(signer, "write_off_bad_debt", await this.withTier({ scenario_id: sid, account_id: account }, tier), {
      deposit: ONE_YOCTO,
      gasTgas: 150,
    });
  }

  /** Direct `conditional_sell` from the inner wNEAR balance. */
  async conditionalSellDirect(
    signer: string,
    sid: number,
    amount: bigint,
    o: { sellMask: number; plans: PlanEntry[][]; minOut: bigint[]; toLending: boolean; tier?: Tier },
  ): Promise<CallResult<string[]>> {
    const base = { scenario_id: sid, amount: str(amount), sell_mask: o.sellMask, plans: o.plans, min_out: o.minOut.map(str), to_lending: o.toLending };
    const args = o.toLending ? await this.withTier(base, o.tier) : base;
    return this.callWith<string[]>(signer, "conditional_sell", args, { deposit: ONE_YOCTO, gasTgas: 300 });
  }

  /** Direct `conditional_buy` from the inner USDC balance. */
  async conditionalBuyDirect(
    signer: string,
    sid: number,
    amount: bigint,
    o: { buyMask: number; plans: PlanEntry[][]; minOut: bigint[]; toLending: boolean; tier?: Tier },
  ): Promise<CallResult<string[]>> {
    const base = { scenario_id: sid, amount: str(amount), buy_mask: o.buyMask, plans: o.plans, min_out: o.minOut.map(str), to_lending: o.toLending };
    const args = o.toLending ? await this.withTier(base, o.tier) : base;
    return this.callWith<string[]>(signer, "conditional_buy", args, { deposit: ONE_YOCTO, gasTgas: 300 });
  }

  // LEND owner setters (1 yocto, 30 Tgas)

  async setDefaultTierConfig(owner: string, tier: Tier, cfg: TierConfigInput): Promise<CallResult<unknown>> {
    await this.requireV2("set_default_tier_config");
    return this.callWith(owner, "set_default_tier_config", { tier, config: cfg }, { deposit: ONE_YOCTO, gasTgas: 30 });
  }

  async setTierConfig(owner: string, sid: number, tier: Tier, cfg: TierConfigInput): Promise<CallResult<unknown>> {
    await this.requireV2("set_tier_config");
    return this.callWith(owner, "set_tier_config", { scenario_id: sid, tier, config: cfg }, { deposit: ONE_YOCTO, gasTgas: 30 });
  }

  async setMarketFrozen(owner: string, sid: number, tier: Tier, frozen: boolean): Promise<CallResult<unknown>> {
    await this.requireV2("set_market_frozen");
    return this.callWith(owner, "set_market_frozen", { scenario_id: sid, tier, frozen }, { deposit: ONE_YOCTO, gasTgas: 30 });
  }

  async setLendingParams(owner: string, params: LendingParamsInput): Promise<CallResult<unknown>> {
    await this.requireV2("set_lending_params");
    return this.callWith(owner, "set_lending_params", { params }, { deposit: ONE_YOCTO, gasTgas: 30 });
  }

  async withdrawInsurance(owner: string, sid: number, tier: Tier, amount: bigint): Promise<CallResult<string>> {
    await this.requireV2("withdraw_insurance");
    return this.callWith<string>(owner, "withdraw_insurance", { scenario_id: sid, tier, amount: str(amount) }, { deposit: ONE_YOCTO, gasTgas: 30 });
  }

  // LEND msgs (ft_transfer_call, 300 Tgas)

  supply(signer: string, sid: number, amount: bigint, tier: Tier = "normal"): Promise<CallResult<string> & { used: bigint }> {
    return this.sendMsg(signer, "usdc", amount, { action: "supply", scenario_id: sid, tier });
  }

  /** Repay with USDC; with `all` the unused part comes back (allowRefund). */
  repay(signer: string, sid: number, amount: bigint, o: { all: boolean; tier?: Tier }): Promise<CallResult<string> & { used: bigint }> {
    return this.sendMsg(signer, "usdc", amount, { action: "repay", scenario_id: sid, all: o.all, tier: o.tier }, { allowRefund: true });
  }

  /** Liquidate with a USDC budget; whatever is not repaid comes back (allowRefund). Cash mode needs `minOut`. */
  liquidate(
    signer: string,
    sid: number,
    account: string,
    budget: bigint,
    o: { repay?: bigint | "max"; tier?: Tier; receive?: Receive; minOut?: bigint } = {},
  ): Promise<CallResult<string> & { used: bigint }> {
    const repay = o.repay === undefined || o.repay === "max" ? "max" : str(o.repay);
    return this.sendMsg(
      signer,
      "usdc",
      budget,
      {
        action: "liquidate",
        scenario_id: sid,
        account_id: account,
        repay_amount: repay,
        tier: o.tier,
        receive: o.receive === "cash" ? "cash" : undefined,
        min_out: o.minOut === undefined ? undefined : str(o.minOut),
      },
      { allowRefund: true, label: `${signer}: liquidate ${account} in ${sid} (${o.tier ?? "normal"}, ${o.receive ?? "tokens"}) with up to ${budget}` },
    );
  }

  fundInsurance(signer: string, sid: number, amount: bigint, tier: Tier = "normal"): Promise<CallResult<string> & { used: bigint }> {
    return this.sendMsg(signer, "usdc", amount, { action: "fund_insurance", scenario_id: sid, tier });
  }

  depositCollateralMsg(signer: string, asset: AssetName, sid: number, amount: bigint, tier: Tier = "normal"): Promise<CallResult<string> & { used: bigint }> {
    return this.sendMsg(signer, asset, amount, { action: "deposit_collateral", scenario_id: sid, tier });
  }

  /** Close a loan after resolution, paying the debt from `budget` USDC (the rest comes back). */
  closeAfterResolutionMsg(signer: string, sid: number, budget: bigint, tier: Tier = "normal"): Promise<CallResult<string> & { used: bigint }> {
    return this.sendMsg(signer, "usdc", budget, { action: "close_after_resolution", scenario_id: sid, tier }, { allowRefund: true });
  }

  sellAndBorrow(
    signer: string,
    sid: number,
    wnearAmount: bigint,
    o: { sellMask: number; plans: PlanEntry[][]; minOut: bigint[]; borrowAmount: bigint; tier?: Tier },
  ): Promise<CallResult<string> & { used: bigint }> {
    return this.sendMsg(signer, "wnear", wnearAmount, {
      action: "sell_and_borrow",
      scenario_id: sid,
      sell_mask: o.sellMask,
      plans: o.plans,
      min_out: o.minOut.map(str),
      borrow_amount: str(o.borrowAmount),
      tier: o.tier,
    });
  }

  conditionalSell(
    signer: string,
    sid: number,
    wnearAmount: bigint,
    o: { sellMask: number; plans: PlanEntry[][]; minOut: bigint[]; toLending: boolean; tier?: Tier },
  ): Promise<CallResult<string> & { used: bigint }> {
    return this.sendMsg(signer, "wnear", wnearAmount, {
      action: "conditional_sell",
      scenario_id: sid,
      sell_mask: o.sellMask,
      plans: o.plans,
      min_out: o.minOut.map(str),
      to_lending: o.toLending,
      tier: o.tier,
    });
  }

  conditionalBuy(
    signer: string,
    sid: number,
    usdcAmount: bigint,
    o: { buyMask: number; plans: PlanEntry[][]; minOut: bigint[]; toLending: boolean; tier?: Tier },
  ): Promise<CallResult<string> & { used: bigint }> {
    return this.sendMsg(signer, "usdc", usdcAmount, {
      action: "conditional_buy",
      scenario_id: sid,
      buy_mask: o.buyMask,
      plans: o.plans,
      min_out: o.minOut.map(str),
      to_lending: o.toLending,
      tier: o.tier,
    });
  }

  split(signer: string, asset: AssetName, sid: number, toMasks: number[], amount: bigint): Promise<CallResult<string> & { used: bigint }> {
    return this.sendMsg(signer, asset, amount, { action: "split", scenario_id: sid, to_masks: toMasks });
  }

  /** The plain `""` deposit into the inner balance. */
  deposit(signer: string, asset: AssetName, amount: bigint): Promise<CallResult<string> & { used: bigint }> {
    return this.sendMsg(signer, asset, amount, { action: "deposit" });
  }

  // MKT views

  async marketParams(block: BlockRef = "final"): Promise<MarketParamsView> {
    await this.requireV2("market_params");
    return this.v("market_params", {}, decodeMarketParams, block);
  }

  async proposalCount(block: BlockRef = "final"): Promise<number> {
    await this.requireV2("proposal_count");
    const n = await this.viewAt<unknown>("proposal_count", {}, block);
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error(`proposal_count: expected a count, got ${JSON.stringify(n)}`);
    return n;
  }

  async proposal(pid: number, block: BlockRef = "final"): Promise<ProposalView | null> {
    await this.requireV2("get_proposal");
    return this.v("get_proposal", { proposal_id: pid }, decodeProposal, block);
  }

  /** Every proposal matching `filter`, newest first, page by page. */
  async *listProposals(filter: ProposalFilter = "all", block: BlockRef = "final"): AsyncGenerator<ProposalSummary> {
    await this.requireV2("list_proposals");
    let from: number | null = null;
    for (;;) {
      const page: { proposals: ProposalSummary[]; next_from: number | null } = await this.v("list_proposals", { from_id: from, limit: 50, filter }, decodeProposalList, block);
      yield* page.proposals;
      if (page.next_from === null) return;
      if (from !== null && page.next_from >= from) throw new Error(`list_proposals: next_from ${page.next_from} does not move below ${from}`);
      from = page.next_from;
    }
  }

  async proposalsOfEvent(eventId: number): Promise<ProposalSummary[]> {
    await this.requireV2("proposals_of_event");
    return this.v("proposals_of_event", { event_id: eventId }, decodeProposalSummaries);
  }

  async pledgeOf(pid: number, account: string): Promise<PledgeView | null> {
    await this.requireV2("pledge_of");
    return this.v("pledge_of", { proposal_id: pid, account_id: account }, decodePledge);
  }

  async pledgesOf(account: string): Promise<PledgeView[]> {
    await this.requireV2("pledges_of");
    return this.v("pledges_of", { account_id: account }, decodePledges);
  }

  async pledgePreview(pid: number, asset: AssetName, amount: bigint): Promise<PledgePreview> {
    await this.requireV2("pledge_preview");
    return this.v("pledge_preview", { proposal_id: pid, asset, amount: str(amount) }, decodePledgePreview);
  }

  async openingPreview(pid: number): Promise<OpeningPreview> {
    await this.requireV2("opening_preview");
    return this.v("opening_preview", { proposal_id: pid }, decodeOpeningPreview);
  }

  async marketCheck(eventIds: number[]): Promise<MarketCheck> {
    await this.requireV2("market_check");
    return this.v("market_check", { event_ids: eventIds }, decodeMarketCheck);
  }

  /** K4: `propose_event`'s checks from BadTerms on, without panicking. */
  async eventCheck(question: string, terms: OpeningTerms, deadlineSec: number): Promise<EventCheckView> {
    await this.requireV2("event_check");
    return this.v("event_check", { question, terms, deadline_sec: deadlineSec }, decodeEventCheck);
  }

  async listMarketsPage(from: number | null, limit: number | null, listedOnly: boolean, block: BlockRef = "final"): Promise<MarketList> {
    await this.requireV2("list_markets");
    return this.v("list_markets", { from_id: from, limit, listed_only: listedOnly }, decodeMarketList, block);
  }

  /** Every market card, ascending; the contract scans at most 128 ids a call, so pages may be short. */
  async *listMarkets(opts: { listedOnly?: boolean } = {}, block: BlockRef = "final"): AsyncGenerator<MarketCard> {
    let from: number | null = null;
    for (;;) {
      const page: MarketList = await this.listMarketsPage(from, 30, opts.listedOnly ?? true, block);
      yield* page.markets;
      if (page.next_from === null) return;
      if (from !== null && page.next_from <= from) throw new Error(`list_markets: next_from ${page.next_from} does not advance past ${from}`);
      from = page.next_from;
    }
  }

  async marketCards(ids: number[]): Promise<MarketCard[]> {
    if (ids.length > 12) throw new Error(`market_cards takes at most 12 ids, not ${ids.length}`);
    await this.requireV2("market_cards");
    return this.v("market_cards", { scenario_ids: ids }, decodeMarketCards);
  }

  async market(sid: number, block: BlockRef = "final"): Promise<MarketCard | null> {
    await this.requireV2("get_market");
    return this.v("get_market", { scenario_id: sid }, decodeMarket, block);
  }

  async relatedMarkets(sid: number): Promise<RelatedMarkets> {
    await this.requireV2("related_markets");
    return this.v("related_markets", { scenario_id: sid }, decodeRelatedMarkets);
  }

  async marketOfEvents(ids: number[]): Promise<MarketOfEvents> {
    await this.requireV2("market_of_events");
    return this.v("market_of_events", { event_ids: ids }, decodeMarketOfEvents);
  }

  async referenceMarketOf(eventId: number): Promise<number | null> {
    await this.requireV2("reference_market_of");
    return this.v("reference_market_of", { event_id: eventId }, decodeReferenceMarketOf);
  }

  async eventMeta(eventId: number): Promise<EventMetaView | null> {
    await this.requireV2("event_meta");
    return this.v("event_meta", { event_id: eventId }, decodeEventMeta);
  }

  async seedVault(sid: number): Promise<SeedVaultView | null> {
    await this.requireV2("seed_vault");
    return this.v("seed_vault", { scenario_id: sid }, decodeSeedVault);
  }

  async previewSeedWithdraw(pid: number, account: string, shares: bigint | null = null): Promise<SeedWithdrawPreview> {
    await this.requireV2("preview_seed_withdraw");
    return this.v("preview_seed_withdraw", { proposal_id: pid, account_id: account, shares: shares === null ? null : str(shares) }, decodeSeedWithdrawPreview);
  }

  // MKT methods

  /** Kind A: a brand-new binary event; attaches bond + reserve for 2 worlds (0.30 NEAR on testnet). */
  async proposeEvent(signer: string, spec: NewEventSpec, params?: MarketParams): Promise<CallResult<number>> {
    await this.requireV2("propose_event");
    const p = params ?? (await this.marketParams()).params;
    return this.callWith<number>(
      signer,
      "propose_event",
      {
        question: spec.question,
        outcome_names: spec.outcomeNames,
        rule: spec.rule,
        source: spec.source,
        deadline_sec: spec.deadlineSec,
        category: spec.category,
        terms: spec.terms,
      },
      { deposit: requiredDeposit(p, "new_event", 2), gasTgas: 300, label: `${signer}: propose_event "${spec.question}"` },
    );
  }

  /** Kind B: a market on 1-3 open events; attaches bond + reserve for its world count. */
  async proposeMarket(signer: string, eventIds: number[], params?: MarketParams): Promise<CallResult<number>> {
    await this.requireV2("propose_market");
    const ids = canonicalEvents(eventIds);
    const p = params ?? (await this.marketParams()).params;
    return this.callWith<number>(signer, "propose_market", { event_ids: ids }, {
      deposit: requiredDeposit(p, "market", worldCountOf(ids.length)),
      gasTgas: 300,
      label: `${signer}: propose_market [${ids.join(", ")}]`,
    });
  }

  /** A pledge of `amount` of either asset (300 Tgas: an `auto_open` may be scheduled with ≥ 215 left). */
  pledge(signer: string, pid: number, asset: AssetName, amount: bigint): Promise<CallResult<string> & { used: bigint }> {
    return this.sendMsg(signer, asset, amount, { action: "pledge", proposal_id: pid }, { label: `${signer}: pledge ${amount} ${asset} to proposal ${pid}` });
  }

  /** K7: `undefined` = all of that asset, a value = exactly that much (0 = none of it). */
  async withdrawPledge(signer: string, pid: number, o: { wnear?: bigint; usdc?: bigint } = {}): Promise<PledgeReturn> {
    await this.requireV2("withdraw_pledge");
    const r = await this.callWith<unknown>(signer, "withdraw_pledge", {
      proposal_id: pid,
      wnear: o.wnear === undefined ? null : str(o.wnear),
      usdc: o.usdc === undefined ? null : str(o.usdc),
    }, { deposit: ONE_YOCTO, gasTgas: 150 });
    return decodePledgeReturn(r.value, "withdraw_pledge");
  }

  async cancelProposal(signer: string, pid: number): Promise<CallResult<unknown>> {
    await this.requireV2("cancel_proposal");
    return this.callWith(signer, "cancel_proposal", { proposal_id: pid }, { deposit: ONE_YOCTO, gasTgas: 150 });
  }

  async claimUnused(signer: string, pid: number): Promise<PledgeReturn> {
    await this.requireV2("claim_unused");
    const r = await this.callWith<unknown>(signer, "claim_unused", { proposal_id: pid }, { deposit: ONE_YOCTO, gasTgas: 150 });
    return decodePledgeReturn(r.value, "claim_unused");
  }

  async seedWithdraw(signer: string, pid: number, shares: bigint | null, minWnear: bigint[], minUsdc: bigint[]): Promise<CallResult<[string, string]>> {
    await this.requireV2("seed_withdraw");
    return this.callWith<[string, string]>(signer, "seed_withdraw", {
      proposal_id: pid,
      shares: shares === null ? null : str(shares),
      min_wnear_out: minWnear.map(str),
      min_usdc_out: minUsdc.map(str),
    }, { deposit: ONE_YOCTO, gasTgas: 300 });
  }

  async approveProposal(owner: string, pid: number, terms: OpeningTerms | null = null): Promise<CallResult<unknown>> {
    await this.requireV2("approve_proposal");
    return this.callWith(owner, "approve_proposal", { proposal_id: pid, terms }, { deposit: ONE_YOCTO, gasTgas: 300 });
  }

  async rejectProposal(owner: string, pid: number, forfeitBond: boolean): Promise<CallResult<unknown>> {
    await this.requireV2("reject_proposal");
    return this.callWith(owner, "reject_proposal", { proposal_id: pid, forfeit_bond: forfeitBond }, { deposit: ONE_YOCTO, gasTgas: 150 });
  }

  async setMarketParams(owner: string, params: MarketParams): Promise<CallResult<unknown>> {
    await this.requireV2("set_market_params");
    return this.callWith(owner, "set_market_params", { params }, { deposit: ONE_YOCTO, gasTgas: 30 });
  }

  async setReferenceMarket(owner: string, eventId: number, sid: number | null): Promise<CallResult<unknown>> {
    await this.requireV2("set_reference_market");
    return this.callWith(owner, "set_reference_market", { event_id: eventId, scenario_id: sid }, { deposit: ONE_YOCTO, gasTgas: 30 });
  }

  async setMarketListing(owner: string, sid: number, listed: boolean, deposit = LISTING_DEPOSIT): Promise<CallResult<unknown>> {
    await this.requireV2("set_market_listing");
    return this.callWith(owner, "set_market_listing", { scenario_id: sid, listed }, { deposit, gasTgas: 30 });
  }

  async setEventMeta(owner: string, eventId: number, source: string, category: number, deposit = LISTING_DEPOSIT): Promise<CallResult<unknown>> {
    await this.requireV2("set_event_meta");
    return this.callWith(owner, "set_event_meta", { event_id: eventId, source, category }, { deposit, gasTgas: 30 });
  }

  /** Not payable; anyone. */
  async settleProposal(signer: string, pid: number): Promise<CallResult<string>> {
    await this.requireV2("settle_proposal");
    return this.callWith<string>(signer, "settle_proposal", { proposal_id: pid }, { deposit: 0n, gasTgas: 100 });
  }

  /** Not payable; anyone; returns the new scenario id. */
  async openMarket(signer: string, pid: number): Promise<CallResult<number>> {
    await this.requireV2("open_market");
    return this.callWith<number>(signer, "open_market", { proposal_id: pid }, { deposit: 0n, gasTgas: 300 });
  }

  async topUpProposal(signer: string, pid: number, near: bigint): Promise<CallResult<unknown>> {
    if (near <= 0n) throw new Error("ZeroAmount");
    await this.requireV2("top_up_proposal");
    return this.callWith(signer, "top_up_proposal", { proposal_id: pid }, { deposit: near, gasTgas: 30 });
  }

  // v1 owner and user calls

  async createEvent(owner: string, e: { question: string; outcomeNames: string[]; rule: string; deadlineSec: number }): Promise<number> {
    const r = await this.call1y<number>(owner, "create_event", { question: e.question, outcome_names: e.outcomeNames, rule: e.rule, deadline_sec: e.deadlineSec }, `${owner}: create_event "${e.question}"`);
    if (typeof r.value !== "number") throw new Error(`create_event returned ${r.returnText}`);
    return r.value;
  }

  async createScenario(owner: string, eventIds: number[]): Promise<number> {
    const r = await this.call1y<number>(owner, "create_scenario", { event_ids: eventIds }, `${owner}: create_scenario [${eventIds.join(", ")}]`);
    if (typeof r.value !== "number") throw new Error(`create_scenario returned ${r.returnText}`);
    return r.value;
  }

  async createWithinPool(owner: string, sid: number, world: number, wnear: bigint, usdc: bigint): Promise<number> {
    const r = await this.call1y<number>(owner, "create_within_pool", { scenario_id: sid, world, wnear_amount: str(wnear), usdc_amount: str(usdc) }, `${owner}: create_within_pool s${sid} w${world}`);
    if (typeof r.value !== "number") throw new Error(`create_within_pool returned ${r.returnText}`);
    return r.value;
  }

  async createBetweenPool(owner: string, sid: number, maskX: number, maskY: number, amountX: bigint, amountY: bigint): Promise<number> {
    const r = await this.call1y<number>(owner, "create_between_pool", {
      scenario_id: sid,
      mask_x: maskX,
      mask_y: maskY,
      amount_x: str(amountX),
      amount_y: str(amountY),
    }, `${owner}: create_between_pool s${sid} ${maskX}/${maskY}`);
    if (typeof r.value !== "number") throw new Error(`create_between_pool returned ${r.returnText}`);
    return r.value;
  }

  async createSpotPool(owner: string, wnear: bigint, usdc: bigint): Promise<number> {
    const r = await this.call1y<number>(owner, "create_spot_pool", { wnear_amount: str(wnear), usdc_amount: str(usdc) }, `${owner}: create_spot_pool`);
    if (typeof r.value !== "number") throw new Error(`create_spot_pool returned ${r.returnText}`);
    return r.value;
  }

  moveSpotTo(owner: string, price: bigint): Promise<CallResult<unknown>> {
    return this.call1y(owner, "move_spot_to", { price: str(price) }, `${owner}: move_spot_to ${price}`);
  }

  setDemoRecord(owner: string, record: unknown): Promise<CallResult<unknown>> {
    return this.call1y(owner, "set_demo_record", { json: JSON.stringify(record) }, `${owner}: set_demo_record`);
  }

  async swap(signer: string, poolId: number, zeroForOne: boolean, amountIn: bigint, minOut: bigint): Promise<bigint> {
    const r = await this.call1y<string>(signer, "swap", { pool_id: poolId, zero_for_one: zeroForOne, amount_in: str(amountIn), min_out: str(minOut) }, `${signer}: swap ${amountIn} in pool ${poolId}`);
    return u128(r.value, "swap");
  }

  async postOrder(signer: string, sid: number, mask: number, side: "bid" | "ask", price: bigint, amount: bigint, expirySec: number): Promise<string> {
    const r = await this.call1y<string>(signer, "post_order", {
      scenario_id: sid,
      mask,
      side,
      price: str(price),
      amount: str(amount),
      expiry_sec: expirySec,
    }, `${signer}: post_order ${side} ${amount} at ${price} in mask ${mask}`);
    if (typeof r.value !== "string") throw new Error(`post_order returned ${r.returnText}`);
    return r.value;
  }

  fillOrder(signer: string, orderId: string, amount: bigint, limitPrice: bigint): Promise<CallResult<unknown>> {
    return this.call1y(signer, "fill_order", { order_id: orderId, amount: str(amount), limit_price: str(limitPrice) }, `${signer}: fill_order ${orderId}`);
  }

  cancelOrder(signer: string, orderId: string): Promise<CallResult<string>> {
    return this.call1y<string>(signer, "cancel_order", { order_id: orderId }, `${signer}: cancel_order ${orderId}`);
  }

  redeem(signer: string, sid: number, asset: AssetName, mask: number, amount: bigint): Promise<CallResult<unknown>> {
    return this.call1y(signer, "redeem", { scenario_id: sid, asset, mask, amount: str(amount) }, `${signer}: redeem ${amount} ${asset} mask ${mask}`);
  }

  merge(signer: string, sid: number, asset: AssetName, fromMasks: number[], toMask: number, amount: bigint): Promise<CallResult<unknown>> {
    return this.callWith(signer, "merge", { scenario_id: sid, asset, from_masks: fromMasks, to_mask: toMask, amount: str(amount) }, {
      deposit: ONE_YOCTO,
      gasTgas: 150,
    });
  }

  withdraw(signer: string, asset: AssetName, amount: bigint): Promise<CallResult<unknown>> {
    return this.call1y(signer, "withdraw", { asset, amount: str(amount) }, `${signer}: withdraw ${amount} ${asset}`);
  }

  adminResolve(owner: string, eventId: number, outcome: number): Promise<CallResult<unknown>> {
    return this.call1y(owner, "admin_resolve", { event_id: eventId, outcome }, `${owner}: admin_resolve(${eventId}, ${outcome})`);
  }

  /** Anyone; no deposit. */
  finalize(signer: string, eventId: number, keyVariant?: string): Promise<CallResult<unknown>> {
    return this.callWith(signer, "finalize", { event_id: eventId }, { deposit: 0n, gasTgas: 100, keyVariant });
  }

  /** The resolver's `report` function-call key. */
  reportOutcome(reporter: string, eventId: number, outcome: number, evidence: string, keyVariant = "report"): Promise<CallResult<unknown>> {
    return this.callWith(reporter, "report_outcome", { event_id: eventId, outcome, target: this.contract, evidence }, {
      deposit: 0n,
      gasTgas: 50,
      keyVariant,
      label: `${reporter}: report_outcome(${eventId}, ${outcome})`,
    });
  }
}

/** Ids of the pieces a world counts: verse pieces whose mask covers it, and real ones. */
export function pieceCovers(piece: string, world: number): { asset: AssetName; covers: boolean } {
  if (piece === "wnear" || piece === "usdc") return { asset: piece, covers: true };
  const [, asset, mask] = piece.split(":");
  if ((asset !== "wnear" && asset !== "usdc") || mask === undefined) throw new Error(`unknown collateral piece ${piece}`);
  return { asset, covers: (Number(mask) & (1 << world)) !== 0 };
}
