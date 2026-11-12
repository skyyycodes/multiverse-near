// The fixture read source: answers the same view methods as the contract (and the two NEP-141 tokens) from the
// replayed demo story, through the same JSON shapes, so the real decoders run on it too.
import type { ReadSource } from "../data/source";
import type { TxOutcome } from "../near/outcome";
import type { Asset } from "../types";
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
export function createFixtureSource(stage?: Stage): ReadSource {
  return {
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
            return { spec: "ft-1.0.0", name: asset === "wnear" ? "Wrapped Ether (test)" : "USD Coin (test)", symbol: asset.toUpperCase(), decimals: asset === "wnear" ? 18 : 6 } as T;
          case "storage_balance_of":
            return (me && (asset === "wnear" || me.usdcRegistered) ? { total: "1250000000000000000000", available: "0" } : null) as T;
          case "storage_balance_bounds":
            return { min: "1250000000000000000000", max: "1250000000000000000000" } as T;
        }
        throw new Error(`MethodNotFound: ${method}`);
      }

      switch (method) {
        case "get_app_config":
          return appConfig() as T;
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
  };
}
