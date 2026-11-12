// Decodes view answers captured from the contract on a freshly seeded sandbox node, so a renamed field or a changed
// number encoding shows up here rather than as a blank screen. The capture was recorded before the collateral token
// moved to 24-decimal wNEAR and rescaled by hand to match (prices / 1000, wNEAR amounts x 1000, USD amounts as
// recorded): re-capture it from a seeded sandbox node once the renamed contract is deployed there.
import { describe, expect, it } from "vitest";
import { big, decodeAdmin, decodeBorrow, decodeConfig, decodeLend, decodeLpPreview, decodeResolve, decodeTrade } from "./decode";
import views from "./testdata/sandbox-views.json";
import type { AdminViewJson, AppConfigView, BorrowViewJson, LendViewJson, LpPreviewJson, PoolViewJson, ResolveViewJson, TradeViewJson } from "./types";

describe("views as the contract serves them", () => {
  it("reads the app config and the demo record", () => {
    const c = decodeConfig(views.get_app_config as AppConfigView);
    expect(c.usdc).toEqual({ tokenId: "usdc.test.near", decimals: 6, symbol: "USDC" });
    expect(c.demo).toMatchObject({ scenario2x2: 1, scenarioBinary: 2, spiceEvent: 1, fedEvent: 2, pastFedEvent: 3 });
    expect(c.lltv).toBe(750_000_000_000_000_000n);
  });

  it("reads the trade snapshot: worlds, pools, orders with string ids", () => {
    const t = decodeTrade(views.trade_view as TradeViewJson);
    expect(t.scenario.worlds.map((w) => w.label)).toEqual(["SHIPS·CUTS", "DELAYED·CUTS", "SHIPS·HOLDS", "DELAYED·HOLDS"]);
    expect(t.scenario.worlds[3].poolId).toBe(4);
    expect(t.orders).toHaveLength(1);
    expect(t.orders[0]).toMatchObject({ id: 1n, maker: "ravi.test.near", side: "bid", mask: 8 });
    expect(t.events.map((e) => e.id)).toEqual(t.scenario.eventIds);
    expect(t.nowSec).toBeGreaterThan(0n);
  });

  it("reads the per-screen snapshots", () => {
    const b = decodeBorrow(views.borrow_view as BorrowViewJson);
    expect(b.account.healthFactor).toBeNull();
    expect(b.account.liquidation).toBe("none");
    const l = decodeLend(views.lend_view as LendViewJson);
    expect(l.account.supplied).toBe(100_000n * 10n ** 18n);
    expect(l.rootLp?.holdings).toHaveLength(4);
    const r = decodeResolve(views.resolve_view as ResolveViewJson);
    expect(r.pastFedEvent?.id).toBe(3);
    const a = decodeAdmin(views.admin_view as AdminViewJson);
    expect(a.ownerId).toBe("test.near");
  });

  it("reads quotes, a Root LP preview and a pool", () => {
    // Alice's 2,000 NEAR in the L-shape, pool only: the seeded demo's numbers.
    expect(views.quote_sell.map(big)).toEqual([0n, 5_865_050_885_346_196_835_107n, 6_451_555_973_880_816_518_618n, 4_748_297_375_815_592_703_719n]);
    const p = decodeLpPreview(views.preview_lp_deposit as LpPreviewJson);
    expect(p.shares).toBeGreaterThan(0n);
    const pool = views.get_pool as PoolViewJson;
    expect(pool.wnear_reserve).not.toBeNull();
    expect(typeof pool.fee_pips).toBe("number");
  });
});
