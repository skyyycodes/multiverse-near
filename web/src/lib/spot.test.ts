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
  wethPrice: price === "0" ? 0n : wad(price),
  backed,
  wethTokenId: "",
  usdcTokenId: "",
  userWeth: 0n,
  userUsdc: 0n,
  collateralWeth: 0n,
  collateralUsdc: 0n,
  odds: 0n,
  poolId: null,
});

describe("implied spot note", () => {
  const base = { oddsKnown: true, impliedSpot: wad("3037.866632"), spotPrice: wad("3037.866632") };
  it("explains every case in order", () => {
    expect(impliedNote({ ...base, oddsKnown: false }).text).toBe("odds × world prices (needs every between-world pool)");
    expect(impliedNote({ ...base, impliedSpot: 0n }).text).toBe("odds × world prices (a world has no pool)");
    expect(impliedNote({ ...base, spotPrice: 0n }).text).toBe("odds × world prices");
    expect(impliedNote({ ...base, impliedSpot: base.spotPrice + 10n ** 16n - 1n }).text).toBe("odds × world prices · equal to actual");
  });

  it("signs the difference once: + above, the formatter's minus below", () => {
    const up = impliedNote({ ...base, impliedSpot: wad("3200.02"), spotPrice: wad("3037.86") });
    expect(up.text).toBe("odds × world prices · +$162.16 (5.34%) vs actual");
    const down = impliedNote({ ...base, impliedSpot: wad("2913.54"), spotPrice: wad("3037.86") });
    expect(down.text).toBe("odds × world prices · -$124.32 (4.09%) vs actual");
  });
});

describe("impact meter", () => {
  it("is the gap between the highest and lowest live world price", () => {
    const worlds = [world(0, "3700"), world(1, "3000"), world(2, "3300"), world(3, "2500")];
    expect(impactGap({ worlds })).toBe(wad("1200"));
    expect(impactGap({ worlds: [world(0, "3700"), world(1, "3000", false)] })).toBe(0n);
    expect(impactGap({ worlds: [world(0, "3700"), world(1, "0")] })).toBe(0n);
  });

  it("recomputes history over the worlds possible now and skips points with one live price", () => {
    const pts = [
      { at: 1, prices: [wad("3700"), wad("3000"), wad("3300"), wad("2500")] },
      { at: 2, prices: [wad("3700"), wad("2883.84"), wad("3300"), wad("2500")] },
      { at: 3, prices: [0n, 0n, wad("3300"), 0n] },
    ];
    expect(impactSeries(pts, 0b1111).map((p) => p.gap)).toEqual([wad("1200"), wad("1200")]);
    expect(impactSeries(pts, 0b1100).map((p) => p.gap)).toEqual([wad("800"), wad("800")]);
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
