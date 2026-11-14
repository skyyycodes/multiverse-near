// The fixture read source: answers the same view methods as the contract (and the two NEP-141 tokens) from the
// replayed demo story, through the same JSON shapes, so the real decoders run on it too.
//
// W-0 part (W-FX replaces this file with the full v2 story): the v1 answers, plus `contract_version` and
// `pause_state` in their exact SPEC shapes (a v2 contract, nothing paused), the v2 keys of `get_app_config`,
// `get_scenario` for the fixture scenarios 1 and 2, and `account()` with fixed values.
import type { AccountInfo, ReadSource } from "../data/source";
import type { TxOutcome } from "../near/outcome";
import type { AppConfigV2Keys, Asset, ContractVersionJson, PauseStateJson, ScenarioInfoJson, TierConfigViewJson } from "../types";
import { swapOut } from "./amm";
import {
  FIXTURE_IDS,
  accountJson,
  appConfig,
  buildWorld,
  eventsJson,
  ordersJson,
  personaOf,
  poolJson,
  previewLp,
  rootLpJson,
  scenarioJson,
  type FixtureWorld,
  type Stage,
} from "./golden";
import { fixtureStage } from "./session";

const worlds = new Map<Stage, FixtureWorld>();

/** One world per stage for the whole session, so times inside it (a proposal's window) stay put while the clock runs. */
export function worldFor(stage: Stage): FixtureWorld {
  let w = worlds.get(stage);
  if (!w) {
    w = buildWorld(stage);
    worlds.set(stage, w);
  }
  return w;
}

/** Marks a bundle that carries the fixtures; check-release.mjs refuses any staging or production build holding it. */
export const FIXTURE_SENTINEL = "__IFVERSE_FIXTURES__";

/** A v2 contract, upgraded from v1 (SPEC-contract 3.9 `contract_version`). */
export const FIXTURE_VERSION: ContractVersionJson = {
  code_version: "2.0.0",
  state_version: 2,
  recorded_code_version: "2.0.0",
  upgraded_at_sec: 1_794_700_000,
  upgraded_from: "1.0.0",
  event_version: "2.0.0",
  legacy_scenario_count: 2,
};

/** Nothing paused, no guardian, no owner change pending. */
export const FIXTURE_PAUSE: PauseStateJson = { paused: [], since_sec: 0, liquidations_resume_at_sec: 0, guardian_id: null, pending_owner_id: null };

const tierConfig = (lltv: string, borrowLtv: string, bonus: string, base: string, slope1: string, slope2: string): TierConfigViewJson => ({
  lltv,
  borrow_ltv: borrowLtv,
  liquidation_bonus: bonus,
  reserve_factor: "100000000000000000",
  rate_base: base,
  rate_slope1: slope1,
  rate_slope2: slope2,
  rate_kink: "800000000000000000",
  max_utilization: "900000000000000000",
  borrow_cap: null,
});

/** The v2 keys of `get_app_config` with the SPEC-contract 4.4 tier defaults (Safe 60/50, Normal 70/60, Bold 80/70). */
export const FIXTURE_CONFIG_V2: AppConfigV2Keys = {
  code_version: "2.0.0",
  state_version: 2,
  paused: [],
  guardian_id: null,
  pending_owner_id: null,
  max_worlds: 8,
  max_events: 3,
  max_trade_fills: 20,
  max_trade_fills_8w: 18,
  reference_configured: false,
  proposal_count: 0,
  lending: {
    min_loan: "100000000000000000000",
    full_liquidation_hf: "900000000000000000",
    small_loan: "200000000000000000000",
    close_factor: "500000000000000000",
    max_collateral_pieces: 20,
    // per-second WAD rates of 1/4/45, 2/6/52, 3/9/63 % APR
    defaults: [
      { tier: "safe", config: tierConfig("600000000000000000", "500000000000000000", "50000000000000000", "317097919", "1268391679", "14269406392") },
      { tier: "normal", config: tierConfig("700000000000000000", "600000000000000000", "60000000000000000", "634195839", "1902587519", "16489091831") },
      { tier: "bold", config: tierConfig("800000000000000000", "700000000000000000", "80000000000000000", "951293759", "2853881278", "19977168949") },
    ],
  },
};

/** Every account the fixture wallet signs with holds 5 NEAR and 0.01 NEAR of storage; the contract account has code. */
const FIXTURE_ACCOUNT: AccountInfo = { codeHash: "11111111111111111111111111111111", amount: "5000000000000000000000000", storageUsage: 1_000 };
const FIXTURE_CODE_HASH = "G6GtUs6AqHfxRb8YCdBx5dv1bgiQ3c1gDhPE9ygQTkEt";

function scenarioInfo(world: FixtureWorld, sid: number): ScenarioInfoJson {
  if (!world.pools[sid]) throw new Error(`UnknownScenario(${sid})`);
  const s = scenarioJson(world, sid, undefined);
  const events = eventsJson(world, sid);
  return {
    scenario_id: sid,
    event_ids: s.event_ids,
    outcome_counts: events.map((e) => e.outcome_names.length),
    world_count: s.world_count,
    root: (1 << s.world_count) - 1,
    possible: s.possible,
    resolution_count: s.resolution_count,
    resolved_events: events.reduce((bits, e, k) => (e.finalized ? bits | (1 << k) : bits), 0),
    halted: s.halted,
    pool_ids: s.worlds.map((w) => w.pool_id ?? 0),
  };
}

const nowSec = () => Math.floor(Date.now() / 1000);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function quote(world: FixtureWorld, sid: number, amount: bigint, mask: number): string[] {
  const pools = world.pools[sid];
  return pools.map((p, w) => {
    const bit = 1 << w;
    if ((mask & bit) === 0 || (world.possible[sid] & bit) === 0 || world.halted[sid]) return "0";
    return swapOut(p.x, p.y, amount, p.feePips).toString();
  });
}

/** `stage` pins the story stage (tests); without it the stage comes from the page's ?fx= and the session. */
export function createFixtureSource(stage?: Stage): ReadSource & { kind: typeof FIXTURE_SENTINEL } {
  return {
    kind: FIXTURE_SENTINEL,
    async view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
      await delay(120);
      const world = worldFor(stage ?? fixtureStage());
      const sid = Number(args.scenario_id);
      const account = (args.account_id as string | null | undefined) ?? null;
      const persona = personaOf(account);

      if (contractId === FIXTURE_IDS.wnear || contractId === FIXTURE_IDS.usdc) {
        const asset: Asset = contractId === FIXTURE_IDS.wnear ? "wnear" : "usdc";
        const me = persona ? world.accounts[persona] : undefined;
        switch (method) {
          case "ft_balance_of":
            return (me ? me.wallet[asset] : 0n).toString() as T;
          case "ft_metadata":
            return asset === "wnear"
              ? ({ spec: "ft-1.0.0", name: "Mock Wrapped NEAR", symbol: "wNEAR", decimals: 24 } as T)
              : ({ spec: "ft-1.0.0", name: "Mock USD Coin", symbol: "USDC", decimals: 6 } as T);
          case "storage_balance_of":
            return (me && (asset === "wnear" || me.usdcRegistered) ? { total: "1250000000000000000000", available: "0" } : null) as T;
          case "storage_balance_bounds":
            return { min: "1250000000000000000000", max: "1250000000000000000000" } as T;
        }
        throw new Error(`MethodNotFound: ${method}`);
      }

      switch (method) {
        case "get_app_config":
          return { ...appConfig(), ...FIXTURE_CONFIG_V2 } as T;
        case "contract_version":
          return FIXTURE_VERSION as T;
        case "pause_state":
          return FIXTURE_PAUSE as T;
        case "get_scenario":
          return scenarioInfo(world, sid) as T;
        case "trade_view":
          return { scenario: scenarioJson(world, sid, persona), events: eventsJson(world, sid), orders: ordersJson(world, sid), impact: world.impact[sid], now_sec: nowSec() } as T;
        case "borrow_view":
          return { scenario: scenarioJson(world, sid, persona), account: accountJson(world, sid, persona), now_sec: nowSec() } as T;
        case "lend_view":
          return {
            account: accountJson(world, sid, persona),
            root_lp: rootLpJson(world, sid, persona),
            worlds: scenarioJson(world, sid, undefined).worlds.map((w) => ({ index: w.index, mask: w.mask, label: w.label, possible: w.possible })),
          } as T;
        case "resolve_view":
          return { scenario: scenarioJson(world, sid, persona), events: eventsJson(world, sid), past_fed_event: world.events[3], account: accountJson(world, sid, persona), now_sec: nowSec() } as T;
        case "admin_view":
          return { scenario: scenarioJson(world, sid, persona), events: eventsJson(world, sid), past_fed_event: world.events[3], owner_id: appConfig().owner_id, now_sec: nowSec() } as T;
        case "quote_sell":
          return quote(world, sid, BigInt(String(args.wnear_amount)), Number(args.sell_mask)) as T;
        case "quote_sell_parts": {
          const parts = (args.parts as { world: number; wnear_amount: string }[]) ?? [];
          return parts.map((p) => quote(world, sid, BigInt(p.wnear_amount), 1 << p.world)[p.world]) as T;
        }
        case "preview_lp_deposit":
          return previewLp(world, sid, BigInt(String(args.wnear_amount)), BigInt(String(args.usdc_amount))) as T;
        case "real_balance_of":
          return "0" as T;
        case "storage_balance_of": {
          const me = persona ? world.accounts[persona] : undefined;
          return (me?.registered ? { total: "100000000000000000000000", available: "61500000000000000000000" } : null) as T;
        }
        case "storage_balance_bounds":
          return { min: "100000000000000000000000", max: null } as T;
        case "get_pool":
          return poolJson(world, Number(args.pool_id)) as T;
        case "is_halted":
          return scenarioJson(world, sid, undefined).halted as T;
      }
      throw new Error(`MethodNotFound: ${method}`);
    },
    async txStatus(hash: string): Promise<TxOutcome> {
      return { status: { SuccessValue: "" }, transaction: { hash }, receipts_outcome: [] };
    },
    async account(accountId: string): Promise<AccountInfo> {
      await delay(60);
      return accountId === FIXTURE_IDS.contract ? { ...FIXTURE_ACCOUNT, codeHash: FIXTURE_CODE_HASH, amount: "12000000000000000000000000", storageUsage: 934_321 } : FIXTURE_ACCOUNT;
    },
  };
}
