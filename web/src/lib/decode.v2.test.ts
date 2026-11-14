// The v2 decoders on SPEC-shaped samples (SPEC-contract 3.9): every view decodes to bigint/camelCase, a missing v2 key
// throws ViewShapeError naming its path, and an unknown enum value (a tier, a status) throws instead of passing through.
import { describe, expect, it } from "vitest";
import {
  bigNeed,
  decodeAccount,
  decodeBooks,
  decodeBorrowers,
  decodeConfig,
  decodeEventCheck,
  decodeEventMeta,
  decodeHoldings,
  decodeLendingTiers,
  decodeLiquidationQuote,
  decodeLiquidationStatus,
  decodeListMarkets,
  decodeMarketCheck,
  decodeMarketParams,
  decodeMarketView,
  decodeNearBooks,
  decodeOutLayerConfig,
  decodePause,
  decodePledgeOrNull,
  decodePledgePreview,
  decodePriceCheck,
  decodeProposal,
  decodeProposalList,
  decodeReference,
  decodeReferenceConfig,
  decodeRelated,
  decodeSeedPreview,
  decodeSeedVault,
  decodeVersion,
  decodeWorldPrices,
  decodeWorldSupply,
  need,
  parseVerseTokenId,
  tierOf,
  V1_CONTRACT_VERSION,
  ViewShapeError,
} from "./decode";
import type {
  AccountViewJson,
  AccountViewV2Json,
  AppConfigView,
  LendingTierJson,
  MarketCardJson,
  MarketViewJson,
  OpeningPreviewJson,
  ProposalSummaryJson,
  ProposalViewJson,
  TierConfigViewJson,
} from "./types";

const E18 = 10n ** 18n;
const s = (x: bigint) => x.toString();

const tierCfg = (lltv: string, borrowLtv: string): TierConfigViewJson => ({
  lltv,
  borrow_ltv: borrowLtv,
  liquidation_bonus: "60000000000000000",
  reserve_factor: "100000000000000000",
  rate_base: "634195839",
  rate_slope1: "1902587519",
  rate_slope2: "16489091831",
  rate_kink: "800000000000000000",
  max_utilization: "900000000000000000",
  borrow_cap: null,
});

const accountV1 = (): AccountViewJson => ({
  debt: s(3_000n * E18),
  health_factor: "1220000000000000000",
  worst_world: 3,
  collateral_values: [s(7_399n * E18), s(5_865n * E18), s(6_451n * E18), s(4_881n * E18)],
  world_price_ok: [true, true, false, true],
  collateral: [{ token_id: "1:wnear:1", label: "SHIPS·CUTS", asset: "wnear", mask: 1, is_real: false, amount: s(2_000n * E18) }],
  supplied: "0",
  supply_principal: "0",
  market_supply: s(100_000n * E18),
  market_borrow: s(3_000n * E18),
  utilization: "30000000000000000",
  borrow_rate_per_sec: "1585489599",
  supply_rate_per_sec: "0",
  lltv: "750000000000000000",
  liquidation: "none",
  unpriced_world: null,
});

const accountV2 = (): AccountViewV2Json => ({
  ...accountV1(),
  liquidation: "paused_reference",
  tier: "safe",
  borrow_ltv: "500000000000000000",
  borrow_health_factor: "1100000000000000000",
  borrow_limit: s(2_440n * E18),
  max_borrow: "0",
  liquidation_bonus: "50000000000000000",
  insurance: s(12n * E18),
  min_loan: s(100n * E18),
  frozen: false,
  max_repay: s(1_500n * E18),
  write_off_ready: false,
  world_status: ["trusted", "trusted", "young", "out_of_band"],
  borrow_block: "ReferenceStale(4000, 3600)",
  liquidation_factor: "950000000000000000",
});

const marketView = (tier: "safe" | "normal" | "bold"): MarketViewJson => ({
  total_supply: s(10_000n * E18),
  total_borrow: s(4_000n * E18),
  total_supply_shares: s(10_000n * E18),
  total_borrow_shares: s(4_000n * E18),
  utilization: "400000000000000000",
  supply_rate_per_sec: "100",
  borrow_rate_per_sec: "300",
  last_update_sec: 1_800_000_000,
  tier,
  insurance: s(5n * E18),
  liquid: s(6_000n * E18),
  bad_debt_covered: "0",
  bad_debt_socialized: "0",
  borrowers: 2,
  frozen: tier === "bold",
  config: tierCfg("700000000000000000", "600000000000000000"),
});

const card = (sid: number, listed = true): MarketCardJson => ({
  scenario_id: sid,
  listed,
  origin: "pledged",
  proposal_id: 3,
  event_ids: [2, 5],
  world_count: 4,
  possible: 15,
  status: "open",
  categories: [2, 3],
  deadline_sec: 1_830_000_000,
  created_at_sec: 1_795_000_000,
  odds: ["400000000000000000", "200000000000000000", "300000000000000000", "100000000000000000"],
  odds_known: true,
  world_prices: ["3700000000000000000", "3000000000000000000", "3300000000000000000", "2500000000000000000"],
  implied_spot: "3240000000000000000",
  pool_value: s(42_000n * E18),
  min_world_depth: s(10_000n * E18),
  pool_count: 7,
  lendable: false,
  seed: { proposal_id: 3, supply: s(29_113n * E18), unlock_at_sec: 1_795_604_800 },
});

const preview = (): OpeningPreviewJson => ({
  can_open: false,
  blocker: "GoalNotReached(29113000000000000000000, 42000000000000000000000)",
  s_ref: "3240000000000000000",
  anchors: [{ scenario_id: 5, implied: "3240000000000000000" }],
  references: [{ event_id: 2, scenario_id: 3, odds0: "400000000000000000", ratio0: "1100000000000000000", ratio1: "900000000000000000", implied: "3240000000000000000" }],
  odds: ["250000000000000000", "250000000000000000", "250000000000000000", "250000000000000000"],
  prices: ["3500000000000000000", "3000000000000000000", "3300000000000000000", "2900000000000000000"],
  usable_value: s(29_113n * E18),
  used_wnear: s(1_000n * E18),
  used_usdc: s(20_000n * E18),
  unused_wnear: "0",
  unused_usdc: s(10n * E18),
  world_pools: [{ world: 0, wnear: s(250n * E18), usdc: s(875n * E18) }],
  odds_pools: [{ mask0: 3, mask1: 12, amount0: s(100n * E18), amount1: s(100n * E18) }],
  idle: [{ token_id: "7:usdc:15", amount: "12" }],
  idle_value: "12",
  thinnest_world_usdc: s(875n * E18),
  needs: "usdc",
  storage_estimate: "120000000000000000000000",
  reserve_available: "300000000000000000000000",
});

const summary = (): ProposalSummaryJson => ({
  proposal_id: 3,
  kind: "market",
  proposer: "dana.multiverse-near.testnet",
  status: "pledging",
  void_reason: null,
  blocker: null,
  event_ids: [2, 5],
  world_count: 4,
  new_event: null,
  category: 0,
  deadline_sec: 1_830_000_000,
  created_at_sec: 1_795_000_000,
  approved_at_sec: 1_795_000_000,
  expires_at_sec: 1_796_000_000,
  open_not_before_sec: 0,
  goal: s(42_000n * E18),
  ideal_wnear: s(3_000n * E18),
  ideal_usdc: s(32_000n * E18),
  s_hint: "3240000000000000000",
  pledged_wnear: s(1_000n * E18),
  pledged_usdc: s(25_873n * E18),
  pledgers: 2,
  progress_bps: 6_931,
  bond: "150000000000000000000000",
  reserve: "50000000000000000000000",
  seed_lock_sec: 604_800,
  opened: null,
});

/** Throws ViewShapeError with `path` in the message. */
function shapeError(fn: () => unknown, path: string) {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ViewShapeError);
  expect((err as Error).message).toContain(path);
}

const without = <T extends object>(o: T, key: string): T => {
  const c = { ...o } as Record<string, unknown>;
  delete c[key];
  return c as T;
};

describe("strict helpers", () => {
  it("need and bigNeed refuse what a v2 view must send", () => {
    expect(need(0, "x")).toBe(0);
    expect(need(null, "x")).toBeNull();
    shapeError(() => need(undefined, "a.b"), "a.b missing");
    expect(bigNeed("12", "x")).toBe(12n);
    expect(bigNeed(7, "x")).toBe(7n);
    shapeError(() => bigNeed(null, "a.c"), "a.c is null");
    shapeError(() => bigNeed("1.5", "a.d"), "a.d is not an integer");
    shapeError(() => bigNeed(2 ** 60, "a.e"), "a.e is not an integer");
  });

  it("reads only the three tier names", () => {
    expect(tierOf("safe", "t")).toBe("safe");
    expect(tierOf("normal", "t")).toBe("normal");
    expect(tierOf("bold", "t")).toBe("bold");
    shapeError(() => tierOf("Bold", "lending_tiers[2].tier"), "lending_tiers[2].tier is not one of safe, normal, bold");
    shapeError(() => tierOf(undefined, "x.tier"), "x.tier missing");
  });
});

describe("OPS views", () => {
  it("contract_version and the v1 stand-in", () => {
    const v = decodeVersion({
      code_version: "2.0.0",
      state_version: 2,
      recorded_code_version: "2.0.0",
      upgraded_at_sec: 1_796_000_000,
      upgraded_from: "1.0.0",
      event_version: "2.0.0",
      legacy_scenario_count: 6,
    });
    expect(v).toEqual({
      codeVersion: "2.0.0",
      stateVersion: 2,
      recordedCodeVersion: "2.0.0",
      upgradedAtSec: 1_796_000_000,
      upgradedFrom: "1.0.0",
      eventVersion: "2.0.0",
      legacyScenarioCount: 6,
    });
    expect(V1_CONTRACT_VERSION).toMatchObject({ stateVersion: 1, codeVersion: "1.0.0" });
    shapeError(() => decodeVersion({ code_version: "2.0.0" } as never), "contract_version.state_version missing");
  });

  it("pause_state", () => {
    const p = decodePause({ paused: ["trade", "lend"], since_sec: 100, liquidations_resume_at_sec: 1_900, guardian_id: "guardian.ifverse-staging.testnet", pending_owner_id: null });
    expect(p).toEqual({ paused: ["trade", "lend"], sinceSec: 100n, liquidationsResumeAtSec: 1_900n, guardianId: "guardian.ifverse-staging.testnet", pendingOwnerId: null });
    shapeError(() => decodePause({ paused: ["trade", "everything"], since_sec: 0, liquidations_resume_at_sec: 0, guardian_id: null, pending_owner_id: null } as never), "pause_state.paused[1]");
    shapeError(() => decodePause({ paused: [], since_sec: 0, liquidations_resume_at_sec: 0, guardian_id: null } as never), "pause_state.pending_owner_id missing");
  });

  it("books and near_books", () => {
    const asset = { reserves: "1", lending_cash: "2", insurance: "3", internal: "4", collateral: "5", spot_pool: "6", pledges: "7", total: "25" };
    const b = decodeBooks({ from_scenario: 1, next_scenario: null, wnear: asset, usdc: asset });
    expect(b.usdc).toEqual({ reserves: 1n, lendingCash: 2n, insurance: 3n, internal: 4n, collateral: 5n, spotPool: 6n, pledges: 7n, total: 25n });
    expect(b.nextScenario).toBeNull();
    const n = decodeNearBooks({ balance: "10", storage_stake: "4", nep145_available: "2", near_held: "1", storage_fund: "1", own_free: "-3" });
    expect(n.ownFree).toBe(-3n);
  });

  it("the app config's v2 keys, strictly once any is there", () => {
    const v1: AppConfigView = {
      owner_id: "multiverse-near.testnet",
      reporter_id: null,
      wnear: { token_id: "wnear.multiverse-near.testnet", symbol: "wNEAR", decimals: 24 },
      usdc: { token_id: "usdc.multiverse-near.testnet", symbol: "USDC", decimals: 6 },
      lltv: "750000000000000000",
      liquidation_bonus: "50000000000000000",
      borrow_rate_per_sec: "1585489599",
      dispute_window_sec: 30,
      twap_window_sec: 1800,
      min_pool_depth: "10000000000000000000000",
      fee_base_pips: 3000,
      fee_cap_pips: 15000,
      order_book: true,
      root_lp: true,
      spot_pool_id: 11,
      event_count: 3,
      scenario_count: 6,
      demo: null,
    };
    const old = decodeConfig(v1);
    expect(old).toMatchObject({ stateVersion: 1, codeVersion: "1.0.0", paused: [], spotPoolId: 11, scenarioCount: 6 });
    expect(old.lending.defaults.normal.lltv).toBe(750_000_000_000_000_000n);

    const v2: AppConfigView = {
      ...v1,
      code_version: "2.0.0",
      state_version: 2,
      paused: ["oracle"],
      guardian_id: null,
      pending_owner_id: null,
      max_worlds: 8,
      max_events: 3,
      max_trade_fills: 20,
      max_trade_fills_8w: 18,
      reference_configured: true,
      proposal_count: 4,
      lending: {
        min_loan: s(100n * E18),
        full_liquidation_hf: "900000000000000000",
        small_loan: s(200n * E18),
        close_factor: "500000000000000000",
        max_collateral_pieces: 20,
        defaults: [
          { tier: "safe", config: tierCfg("600000000000000000", "500000000000000000") },
          { tier: "normal", config: tierCfg("700000000000000000", "600000000000000000") },
          { tier: "bold", config: tierCfg("800000000000000000", "700000000000000000") },
        ],
      },
    };
    const c = decodeConfig(v2);
    expect(c).toMatchObject({ stateVersion: 2, paused: ["oracle"], maxWorlds: 8, maxTradeFills8w: 18, referenceConfigured: true, proposalCount: 4 });
    expect(c.lending.minLoan).toBe(100n * E18);
    expect(c.lending.defaults.bold.borrowLtv).toBe(700_000_000_000_000_000n);
    expect(c.lending.defaults.safe.borrowCap).toBeNull();
    shapeError(() => decodeConfig(without(v2, "max_trade_fills_8w")), "get_app_config.max_trade_fills_8w missing");
    shapeError(
      () => decodeConfig({ ...v2, lending: { ...v2.lending!, defaults: v2.lending!.defaults.slice(0, 2) } }),
      "get_app_config.lending.defaults has no bold tier",
    );
  });
});

describe("LEND views", () => {
  it("an AccountView with every v2 key, and a v1 one", () => {
    const a = decodeAccount(accountV2());
    expect(a).toMatchObject({
      tier: "safe",
      liquidation: "paused_reference",
      borrowLtv: 500_000_000_000_000_000n,
      borrowHealthFactor: 1_100_000_000_000_000_000n,
      borrowLimit: 2_440n * E18,
      minLoan: 100n * E18,
      maxRepay: 1_500n * E18,
      worldStatus: ["trusted", "trusted", "young", "out_of_band"],
      borrowBlock: "ReferenceStale(4000, 3600)",
      liquidationFactor: 950_000_000_000_000_000n,
    });
    shapeError(() => decodeAccount(without(accountV2(), "borrow_ltv"), "borrow_view.account"), "borrow_view.account.borrow_ltv missing");
    shapeError(() => decodeAccount({ ...accountV2(), tier: "medium" } as never), "account.tier is not one of");
    shapeError(() => decodeAccount({ ...accountV2(), world_status: ["trusted", "stale"] } as never), "account.world_status[1]");
    // A v1 view (no v2 key at all) reads as v1 behaved; required as v2, it throws.
    const v1 = decodeAccount(accountV1());
    expect(v1).toMatchObject({ tier: "normal", borrowLtv: 750_000_000_000_000_000n, maxRepay: 3_000n * E18, worldStatus: ["trusted", "trusted", "no_pool", "trusted"] });
    shapeError(() => decodeAccount(accountV1(), "lending_tiers[0].account", true), "lending_tiers[0].account.tier missing");
  });

  it("market_state and lending_tiers in Safe, Normal, Bold order", () => {
    const m = decodeMarketView(marketView("bold"));
    expect(m).toMatchObject({ tier: "bold", liquid: 6_000n * E18, borrowers: 2, frozen: true });
    expect(m.config.rateKink).toBe(800_000_000_000_000_000n);
    const rows: LendingTierJson[] = [
      { tier: "safe", market: marketView("safe"), account: accountV2() },
      { tier: "normal", market: marketView("normal"), account: null },
      { tier: "bold", market: marketView("bold"), account: null },
    ];
    const t = decodeLendingTiers(rows);
    expect(t.map((x) => x.tier)).toEqual(["safe", "normal", "bold"]);
    expect(t[0].account?.tier).toBe("safe");
    shapeError(() => decodeLendingTiers([rows[1], rows[0], rows[2]]), "lending_tiers is not Safe, Normal, Bold");
    shapeError(() => decodeLendingTiers([{ ...rows[0], market: without(marketView("safe"), "liquid") }, rows[1], rows[2]]), "lending_tiers[0].market.liquid missing");
  });

  it("liquidation_status, borrowers and liquidation_quote", () => {
    expect(
      decodeLiquidationStatus({ status: "liquidatable", unpriced_world: null, tier: "normal", max_repay: "5", full_seize_repay: "9", write_off_ready: false }),
    ).toEqual({ status: "liquidatable", unpricedWorld: null, tier: "normal", maxRepay: 5n, fullSeizeRepay: 9n, writeOffReady: false });
    const page = decodeBorrowers({
      scenario_id: 1,
      tier: "normal",
      total: 3,
      from_index: 0,
      next_index: null,
      now_sec: 1_800_000_000,
      rows: [
        {
          index: 0,
          account_id: "carl.multiverse-near.testnet",
          debt: "446411128000000000000",
          health_factor: "951870000000000000",
          worst_world: 3,
          c_min: "1",
          liquidation: "paused",
          unpriced_world: null,
          max_repay: "2",
          full_seize_repay: "3",
          write_off_ready: false,
        },
      ],
    });
    expect(page.rows[0]).toMatchObject({ accountId: "carl.multiverse-near.testnet", liquidation: "paused", healthFactor: 951_870_000_000_000_000n });
    expect(page.nowSec).toBe(1_800_000_000n);

    const quote = {
      error: null,
      liquidation: "liquidatable",
      debt: "446411128000000000000",
      health_factor: "951870000000000000",
      cap: "446411128000000000000",
      full_seize_repay: "500000000000000000000",
      repay: "446411128000000000000",
      target: "0",
      seize_all: true,
      written_off: "0",
      price_factor: "1000000000000000000",
      pieces: [{ piece: "1:wnear:15", held: "10", seized: "4" }],
      cash: { sold: ["1", "0"], received: ["2", "0"], merged: "3", real_usdc: "4", redeemed: "5", cash: "464980000000000000000", left_usdc: ["0", "0"], dead: ["1:usdc:2"], guard_ok: true },
    } as const;
    const q = decodeLiquidationQuote({ ...quote, pieces: [...quote.pieces], cash: { ...quote.cash, sold: [...quote.cash.sold], received: [...quote.cash.received], left_usdc: [...quote.cash.left_usdc], dead: [...quote.cash.dead] } });
    expect(q.cash?.cash).toBe(464_980_000_000_000_000_000n);
    expect(q.pieces[0]).toEqual({ piece: "1:wnear:15", held: 10n, seized: 4n });
    shapeError(() => decodeLiquidationQuote(without(quote, "cash") as never), "liquidation_quote.cash missing");
    expect(decodeLiquidationQuote({ ...quote, pieces: [], cash: null }).cash).toBeNull();
  });
});

describe("PRC views", () => {
  it("world_prices ordered by world, price_check and the reference", () => {
    const w = (world: number, status: string) => ({
      world,
      status,
      twap: "3700000000000000000",
      spot: "3710000000000000000",
      borrow_price: "3700000000000000000",
      liquidation_price: "3500000000000000000",
      depth: s(50_000n * E18),
      age_sec: 4000,
      full_window: true,
    });
    const prices = decodeWorldPrices([w(1, "young"), w(0, "trusted")] as never);
    expect(prices.map((p) => [p.world, p.status])).toEqual([
      [0, "trusted"],
      [1, "young"],
    ]);
    shapeError(() => decodeWorldPrices([w(0, "stale")] as never), "world_prices[0].status");

    const cfg = { min_age_sec: 1800, min_depth: s(50_000n * E18), reference: true, max_deviation: "100000000000000000", max_haircut: "200000000000000000" };
    const pc = decodePriceCheck({
      scenario_id: 5,
      config: cfg,
      reference: { price: "3240000000000000000", observed_at: 1, age_sec: 60, source: "outlayer", sources_used: 4, spread_bps: 12 },
      implied_twap_spot: "3200000000000000000",
      ratio: "987654320987654320",
      borrow_block: null,
      borrow_factor: "1000000000000000000",
      liquidation_factor: "1000000000000000000",
      liquidation_guard: false,
    });
    expect(pc.reference?.source).toBe("outlayer");
    expect(pc.config.minDepth).toBe(50_000n * E18);
    const blocked = decodePriceCheck({
      scenario_id: 5,
      config: cfg,
      reference: null,
      implied_twap_spot: null,
      ratio: null,
      borrow_block: "ReferenceMissing",
      borrow_factor: "1",
      liquidation_factor: "1",
      liquidation_guard: true,
    });
    expect(blocked).toMatchObject({ reference: null, ratio: null, borrowBlock: "ReferenceMissing", liquidationGuard: true });

    expect(decodeReference(null)).toBeNull();
    const r = decodeReference({ price: "3240000000000000000", observed_at: 10, stored_at: 11, age_sec: 5, source: "reporter", sources_used: 3, spread_bps: 40, request: 2, pending: false });
    expect(r).toMatchObject({ price: 3_240_000_000_000_000_000n, source: "reporter", request: 2 });
  });

  it("reference and OutLayer configs", () => {
    const guest = {
      outlayer_id: "outlayer.testnet",
      wasm_url: "https://ifverse-staging.vercel.app/outlayer/nearusd-guest.wasm",
      wasm_sha256: "ab".repeat(32),
      resource_limits: { max_instructions: 1_000_000_000, max_memory_mb: 128, max_execution_seconds: 30 },
      deposit: "5000000000000000000000",
    };
    const rc = decodeReferenceConfig({
      enabled: true,
      guest,
      reporter_id: "resolver.ifverse-staging.testnet",
      min_sources: 3,
      max_spread_bps: 200,
      max_result_delay_sec: 600,
      borrow_max_age_sec: 3600,
      liquidation_max_age_sec: 21600,
      min_price: "100000000000000000",
      max_price: "1000000000000000000000",
    });
    expect(rc?.guest?.deposit).toBe(5_000_000_000_000_000_000_000n);
    expect(decodeReferenceConfig(null)).toBeNull();
    expect(decodeOutLayerConfig(guest)?.resourceLimits.maxMemoryMb).toBe(128);
    shapeError(() => decodeOutLayerConfig(without(guest, "deposit")), "get_outlayer_config.deposit missing");
  });
});

describe("EW views and holdings", () => {
  it("world_supply and NEP-245 holdings", () => {
    expect(decodeWorldSupply({ scenario_id: 5, possible: 255, wnear_reserves: "1", usdc_reserves: "2", wnear: ["1", "2"], usdc: ["3", "4"] }).usdc).toEqual([3n, 4n]);
    expect(parseVerseTokenId("12:wnear:15")).toEqual({ scenarioId: 12, asset: "wnear", mask: 15 });
    expect(parseVerseTokenId("lp:3")).toBeUndefined();
    expect(parseVerseTokenId("1:usdc:0")).toBeUndefined();
    const h = decodeHoldings(
      [
        { token_id: "1:wnear:15", owner_id: null, base_metadata_id: "1:wnear:15" },
        { token_id: "1:usdc:2", owner_id: null, base_metadata_id: "1:usdc:2" },
        { token_id: "3:usdc:1", owner_id: null, base_metadata_id: "3:usdc:1" },
      ],
      ["5", "0", "7"],
    );
    expect(h).toEqual([
      { tokenId: "1:wnear:15", scenarioId: 1, asset: "wnear", mask: 15, amount: 5n },
      { tokenId: "3:usdc:1", scenarioId: 3, asset: "usdc", mask: 1, amount: 7n },
    ]);
    expect(() => decodeHoldings([{ token_id: "1:wnear:1", owner_id: null, base_metadata_id: "" }], [])).toThrow(ViewShapeError);
  });
});

describe("MKT views", () => {
  it("list_markets, cards and related markets", () => {
    const list = decodeListMarkets({ markets: [card(5), card(6, false)], next_from: null });
    expect(list.markets[0]).toMatchObject({ scenarioId: 5, origin: "pledged", status: "open", lendable: false, poolValue: 42_000n * E18 });
    expect(list.markets[0].seed).toEqual({ proposalId: 3, supply: 29_113n * E18, unlockAtSec: 1_795_604_800 });
    expect(list.markets[1].listed).toBe(false);
    expect(list.nextFrom).toBeNull();
    shapeError(() => decodeListMarkets({ markets: [without(card(5), "lendable")], next_from: 13 }), "list_markets.markets[0].lendable missing");
    shapeError(() => decodeListMarkets({ markets: [{ ...card(5), status: "closed" } as never], next_from: null }), "list_markets.markets[0].status");

    const rel = decodeRelated({ markets: [{ scenario_id: 6, event_ids: [2], world_count: 2, status: "partly_resolved", listed: true }], proposals: [summary()] });
    expect(rel.markets[0].status).toBe("partly_resolved");
    expect(rel.proposals[0].progressBps).toBe(6_931);
  });

  it("proposals: the full view with its preview, and list rows", () => {
    const view: ProposalViewJson = {
      ...summary(),
      status: "waiting",
      kind: "new_event",
      new_event: {
        question: "Will NEAR mainnet process 1B transactions by 2027-06-30?",
        outcome_names: ["YES", "NO"],
        rule: "YES if …",
        source: "https://nearblocks.io/charts/txns",
        deadline_sec: 1_814_313_599,
        category: 1,
        terms: { odds0_bps: 4_000, mult_bps: [11_500, 9_000] },
      },
      preview: preview(),
    };
    const p = decodeProposal(view)!;
    expect(p.status).toBe("waiting");
    expect(p.newEvent).toMatchObject({ rule: "YES if …", source: "https://nearblocks.io/charts/txns", terms: { odds0Bps: 4_000, multBps: [11_500, 9_000] } });
    expect(p.preview?.needs).toBe("usdc");
    expect(p.preview?.oddsPools[0]).toEqual({ mask0: 3, mask1: 12, amount0: 100n * E18, amount1: 100n * E18 });
    expect(decodeProposal(null)).toBeNull();
    shapeError(() => decodeProposal({ ...view, preview: { ...preview(), needs: "near" } } as never), "get_proposal.preview.needs");

    const list = decodeProposalList({ proposals: [summary()], next_from: 1 });
    expect(list.proposals[0]).toMatchObject({ proposalId: 3, status: "pledging", pledgedUsdc: 25_873n * E18 });
    expect(list.proposals[0].newEvent).toBeNull();
    // a list row never says ready or waiting
    shapeError(() => decodeProposalList({ proposals: [{ ...summary(), status: "ready" } as never], next_from: null }), "list_proposals.proposals[0].status");
    shapeError(() => decodeProposalList({ proposals: [{ ...summary(), void_reason: "spam" } as never], next_from: null }), "void_reason");
  });

  it("pledges, previews, params and checks", () => {
    expect(decodePledgeOrNull(null)).toBeNull();
    const pl = decodePledgeOrNull({
      proposal_id: 3,
      account_id: "bob.multiverse-near.testnet",
      wnear: "0",
      usdc: s(1_000n * E18),
      state: "seed",
      shares: s(990n * E18),
      withdrawn_shares: "0",
      unused_wnear: "0",
      unused_usdc: s(10n * E18),
      unused_paid: false,
      unlock_at_sec: 1_795_604_800,
      max_withdrawable_shares: "0",
    });
    expect(pl).toMatchObject({ state: "seed", shares: 990n * E18, unusedUsdc: 10n * E18 });
    expect(decodePledgePreview({ usable_before: "1", usable_after: "2", deployed_part: "1", goal_reached_after: true, needs: null })).toEqual({
      usableBefore: 1n,
      usableAfter: 2n,
      deployedPart: 1n,
      goalReachedAfter: true,
      needs: null,
    });

    const params = {
      bond_new_event: "100000000000000000000000",
      bond_market: "50000000000000000000000",
      reserve_base: "50000000000000000000000",
      reserve_per_world: "25000000000000000000000",
      proposal_ttl_sec: 1_209_600,
      review_ttl_sec: 604_800,
      min_pledge_window_sec: 86_400,
      min_market_life_sec: 259_200,
      notice_sec: 3_600,
      seed_lock_sec: 604_800,
      evict_min_age_sec: 259_200,
      spam_floor_bps: 1_000,
      goal_depth_usdc: s(15_000n * E18),
      min_open_depth_usdc: s(10_000n * E18),
      min_goal_usdc: s(10_000n * E18),
      goal_round_usdc: s(1_000n * E18),
      beta_bps: 2_500,
      odds_clamp_bps: 100,
      mult_a_bps: [5_000, 20_000],
      mult_b_bps: [2_000, 50_000],
      anchors: [5, 0, 0],
      max_anchor_divergence_bps: 300,
      max_reference_divergence_bps: 1_000,
      min_reference_depth_usdc: s(10_000n * E18),
      min_reference_odds_depth_usdc: s(1_000n * E18),
      require_external: false,
      max_external_divergence_bps: 1_000,
      min_pledge_usdc: s(10n * E18),
      min_pledge_wnear: s(3n * E18),
      max_pledges_per_account: 32,
      max_active_per_account: 4,
      max_live_per_event: 16,
      seed_depth_floor: true,
    };
    expect(Object.keys(params)).toHaveLength(33);
    const mp = decodeMarketParams({
      params: params as never,
      reserve_w2: "100000000000000000000000",
      reserve_w4: "150000000000000000000000",
      reserve_w8: "250000000000000000000000",
      storage_fund: "0",
    });
    expect(mp.params).toMatchObject({ bondMarket: 50_000_000_000_000_000_000_000n, anchors: [5, 0, 0], multBBps: [2_000, 50_000], seedDepthFloor: true });
    expect(mp.reserveW4).toBe(150_000_000_000_000_000_000_000n);
    shapeError(() => decodeMarketParams({ params: without(params, "seed_depth_floor") as never, reserve_w2: "0", reserve_w4: "0", reserve_w8: "0", storage_fund: "0" }), "market_params.params.seed_depth_floor");

    const mc = decodeMarketCheck({
      canonical: [1, 2],
      world_count: 4,
      blocker: "MarketExists(1)",
      listed_market: 1,
      live_proposal: null,
      goal: "0",
      ideal_wnear: "0",
      ideal_usdc: "0",
      bond: "50000000000000000000000",
      reserve: "150000000000000000000000",
      expires_at_sec: 0,
    });
    expect(mc).toMatchObject({ canonical: [1, 2], blocker: "MarketExists(1)", listedMarket: 1 });
    const ec = decodeEventCheck({
      blocker: null,
      live_proposal: null,
      goal: s(10_000n * E18),
      ideal_wnear: "1",
      ideal_usdc: "2",
      s_ref: null,
      odds: ["400000000000000000", "600000000000000000"],
      prices: ["3700000000000000000", "2900000000000000000"],
      bond: "100000000000000000000000",
      reserve: "100000000000000000000000",
    });
    expect(ec.odds).toEqual([400_000_000_000_000_000n, 600_000_000_000_000_000n]);
    expect(ec.sRef).toBeNull();
    expect(decodeEventMeta(null)).toBeNull();
    expect(decodeEventMeta({ event_id: 4, proposal_id: 2, proposer: "dana.testnet", source: "https://nearblocks.io", category: 1 })).toMatchObject({ eventId: 4, proposer: "dana.testnet" });
  });

  it("seed vaults and the seed withdrawal preview with per_world (K5)", () => {
    expect(decodeSeedVault(null)).toBeNull();
    const v = decodeSeedVault({
      proposal_id: 1,
      supply: s(1_000n * E18),
      unlock_at_sec: 5,
      positions: [{ pool_id: 20, liquidity: "1", amount0: "2", amount1: "3", fees0: "4", fees1: "5" }],
      idle: [{ token_id: "3:usdc:1", amount: "9" }],
    });
    expect(v?.positions[0]).toEqual({ poolId: 20, liquidity: 1n, amount0: 2n, amount1: 3n, fees0: 4n, fees1: 5n });
    const sp = decodeSeedPreview({ wnear_out: "1", usdc_out: "2", tokens: [], max_shares: "3", locked_until_sec: 4, per_world: { wnear: ["1", "0"], usdc: ["2", "0"] } });
    expect(sp.perWorld).toEqual({ wnear: [1n, 0n], usdc: [2n, 0n] });
    shapeError(() => decodeSeedPreview({ wnear_out: "1", usdc_out: "2", tokens: [], max_shares: "3", locked_until_sec: 4 } as never), "preview_seed_withdraw.per_world missing");
  });
});
