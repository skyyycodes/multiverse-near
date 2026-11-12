import { describe, expect, it } from "vitest";
import type { World } from "./domain";
import { parseAmount } from "./format";
import { allBacked, impactGap, impactSeries, impliedNote, sparklinePath } from "./spot";

const wad = (s: string) => parseAmount(s)!;

const world = (i: number, price: string, possible = true, backed = true): World => ({
  index: i,
  mask: 1 << i,
  label: `W${i}`,
  possible,
  poolInitialized: price !== "0",
  wnearPrice: price === "0" ? 0n : wad(price),
  backed,
  wnearTokenId: "",
  usdcTokenId: "",
  userWnear: 0n,
  userUsdc: 0n,
  collateralWnear: 0n,
  collateralUsdc: 0n,
  odds: 0n,
  poolId: null,
});

describe("implied spot note", () => {
  const base = { oddsKnown: true, impliedSpot: wad("3.037866632"), spotPrice: wad("3.037866632") };
  it("explains every case in order", () => {
    expect(impliedNote({ ...base, oddsKnown: false }).text).toBe("odds × world prices (needs every between-world pool)");
    expect(impliedNote({ ...base, impliedSpot: 0n }).text).toBe("odds × world prices (a world has no pool)");
    expect(impliedNote({ ...base, spotPrice: 0n }).text).toBe("odds × world prices");
    expect(impliedNote({ ...base, impliedSpot: base.spotPrice + 10n ** 14n - 1n }).text).toBe("odds × world prices · equal to actual");
  });

  it("signs the difference once: + above, the formatter's minus below", () => {
    const up = impliedNote({ ...base, impliedSpot: wad("3.20002"), spotPrice: wad("3.03786") });
    expect(up.text).toBe("odds × world prices · +$0.1621 (5.34%) vs actual");
    const down = impliedNote({ ...base, impliedSpot: wad("2.91354"), spotPrice: wad("3.03786") });
    expect(down.text).toBe("odds × world prices · -$0.1243 (4.09%) vs actual");
  });

  it("shows a difference cents would hide", () => {
    const near = impliedNote({ ...base, impliedSpot: wad("3.0377"), spotPrice: wad("3.0379") });
    expect(near.text).toBe("odds × world prices · -$0.0002 (0.01%) vs actual");
  });
});

describe("impact meter", () => {
  it("is the gap between the highest and lowest live world price", () => {
    const worlds = [world(0, "3.70"), world(1, "3.00"), world(2, "3.30"), world(3, "2.50")];
    expect(impactGap({ worlds })).toBe(wad("1.20"));
    expect(impactGap({ worlds: [world(0, "3.70"), world(1, "3.00", false)] })).toBe(0n);
    expect(impactGap({ worlds: [world(0, "3.70"), world(1, "0")] })).toBe(0n);
  });

  it("recomputes history over the worlds possible now and skips points with one live price", () => {
    const pts = [
      { at: 1, prices: [wad("3.70"), wad("3.00"), wad("3.30"), wad("2.50")] },
      { at: 2, prices: [wad("3.70"), wad("2.8838"), wad("3.30"), wad("2.50")] },
      { at: 3, prices: [0n, 0n, wad("3.30"), 0n] },
    ];
    expect(impactSeries(pts, 0b1111).map((p) => p.gap)).toEqual([wad("1.20"), wad("1.20")]);
    expect(impactSeries(pts, 0b1100).map((p) => p.gap)).toEqual([wad("0.80"), wad("0.80")]);
  });

  it("draws a 96×28 sparkline, or nothing with fewer than two points", () => {
    expect(sparklinePath([])).toBeUndefined();
    expect(sparklinePath([{ at: 1, gap: 5n }])).toBeUndefined();
    expect(sparklinePath([{ at: 1, gap: 0n }, { at: 2, gap: 10n }])).toBe("M0.0,27.0 L96.0,1.0");
  });

  it("checks backing over the possible worlds only", () => {
    expect(allBacked({ worlds: [world(0, "1"), world(1, "1", false, false)] })).toBe(true);
    expect(allBacked({ worlds: [world(0, "1", true, false)] })).toBe(false);
  });
});
