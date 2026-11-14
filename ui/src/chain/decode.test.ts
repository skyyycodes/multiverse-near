import { describe, expect, it } from "vitest";
import { decodeAccount, decodeConfig, decodeEvent, decodeTrade } from "./decode";
import type { AccountViewJson, AppConfigView, EventViewJson, TradeViewJson } from "./types";

describe("view JSON at the edge", () => {
  it("reads the on-chain demo record whether ids come as numbers or strings", () => {
    const cfg = {
      owner_id: "multiverse-lending.testnet",
      reporter_id: null,
      wnear: { token_id: "wnear.multiverse-lending.testnet", decimals: 24, symbol: "wNEAR" },
      usdc: { token_id: "usdc.multiverse-lending.testnet", decimals: 6, symbol: "USDC" },
      lltv: "750000000000000000",
      liquidation_bonus: "50000000000000000",
      borrow_rate_per_sec: "1585489599",
      dispute_window_sec: 30,
      twap_window_sec: 60,
      min_pool_depth: "10000000000000000000000",
      order_book: true,
      root_lp: false,
      demo: { scenario_2x2: "5", scenario_binary: 6, past_fed_event: null, spice_event: 7, fed_event: "8" },
    } as unknown as AppConfigView;
    const c = decodeConfig(cfg);
    expect(c.demo).toEqual({ spiceEvent: 7, fedEvent: 8, pastFedEvent: null, scenario2x2: 5, scenarioBinary: 6 });
    expect(c.usdc.decimals).toBe(6);
    expect(c.lltv).toBe(750_000_000_000_000_000n);
    expect(decodeConfig({ ...cfg, demo: null }).demo).toBeNull();
  });

  it("turns U128 strings into bigint and orders worlds by index", () => {
    const v = {
      scenario: {
        scenario_id: 1,
        world_count: 2,
        possible: 3,
        resolution_count: 0,
        halted: false,
        event_ids: [1],
        spot_price: "3037866632000000000",
        odds_known: true,
        implied_spot: "3200020000000000000",
        worlds: [1, 0].map((i) => ({
          index: i,
          mask: 1 << i,
          label: i ? "DELAYED" : "SHIPS",
          possible: true,
          pool_initialized: true,
          wnear_price: i ? "2800000000000000000" : "3400000000000000000",
          backed: true,
          wnear_token_id: `2:wnear:${1 << i}`,
          usdc_token_id: `2:usdc:${1 << i}`,
          user_wnear: "0",
          user_usdc: "0",
          collateral_wnear: "0",
          collateral_usdc: "0",
          odds: i ? "333300000000000000" : "666700000000000000",
          pool_id: 10 + i,
        })),
      },
      events: [],
      orders: [{ id: "12", maker: "ravi.testnet", scenario_id: 1, mask: 2, side: "bid", price: "1", amount: "2", remaining: "2", escrow: "2", expiry_sec: 99, epoch: 0 }],
      impact: [{ at_sec: 5, prices: ["1", "0"] }],
      now_sec: 1_800_000_000,
    } as TradeViewJson;
    const t = decodeTrade(v);
    expect(t.scenario.worlds.map((w) => w.label)).toEqual(["SHIPS", "DELAYED"]);
    expect(t.scenario.spotPrice).toBe(3_037_866_632_000_000_000n);
    expect(t.orders[0].id).toBe(12n);
    expect(t.orders[0].expiry).toBe(99n);
    expect(t.impact[0].prices).toEqual([1n, 0n]);
    expect(t.nowSec).toBe(1_800_000_000n);
  });

  it("keeps a missing health factor as infinite", () => {
    const a = decodeAccount({
      debt: "0",
      health_factor: null,
      worst_world: null,
      collateral_values: ["0", "0"],
      world_price_ok: [true, true],
      collateral: [],
      supplied: "0",
      supply_principal: "0",
      market_supply: "0",
      market_borrow: "0",
      utilization: "0",
      borrow_rate_per_sec: "0",
      supply_rate_per_sec: "0",
      lltv: "0",
      liquidation: "none",
      unpriced_world: null,
    } as AccountViewJson);
    expect(a.healthFactor).toBeNull();
    expect(a.worstWorld).toBeNull();
  });

  it("keeps an OutLayer proposal's source", () => {
    const e = decodeEvent({
      id: 3,
      question: "Did the Fed cut at its October 27-28, 2026 meeting?",
      rule: "r",
      outcome_names: ["CUTS", "HOLDS"],
      deadline_sec: 0,
      proposed_at_sec: 1793300000,
      proposed_outcome: 1,
      proposal_open: true,
      finalized: false,
      outcome: 0,
      finalizable_at_sec: 1793300030,
      proposed_by: "outlayer",
    } satisfies EventViewJson);
    expect(e.proposedBy).toBe("outlayer");
    expect(e.finalizableAt).toBe(1793300030n);
  });
});
