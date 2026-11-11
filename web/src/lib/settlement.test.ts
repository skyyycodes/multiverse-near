import { describe, expect, it } from "vitest";
import type { Collateral, Scenario, World } from "./domain";
import { parseAmount } from "./format";
import { fateOf, fateText, planClose, summarizeClose, walletRedeemable } from "./settlement";

const wad = (s: string) => parseAmount(s)!;
const LABELS = ["SHIPS·CUTS", "DELAYED·CUTS", "SHIPS·HOLDS", "DELAYED·HOLDS"];

const piece = (asset: "weth" | "usdc", mask: number, amount: string, isReal = false): Collateral => ({
  tokenId: isReal ? asset : `1:${asset}:${mask}`,
  label: isReal ? asset.toUpperCase() : `${asset.toUpperCase()}-if-${LABELS[Math.log2(mask)] ?? `0b${mask.toString(2)}`}`,
  asset,
  mask: isReal ? 15 : mask,
  isReal,
  amount: wad(amount),
});

// Alice after her L-shape sale into lending.
const alice = [piece("weth", 1, "2"), piece("usdc", 2, "5865.05"), piece("usdc", 4, "6451.55"), piece("usdc", 8, "4881.88")];

describe("closing a position", () => {
  it("before any resolution every piece is still live", () => {
    expect(alice.map((c) => fateOf(c, 0b1111))).toEqual(["live", "live", "live", "live"]);
  });

  it("after HOLDS the CUTS pieces are dead, the HOLDS ones live", () => {
    expect(alice.map((c) => fateOf(c, 0b1100))).toEqual(["dead", "dead", "live", "live"]);
  });

  it("with one world left its pieces redeem 1:1 and real pieces come back as they are", () => {
    const withReal = [...alice, piece("weth", 15, "0.5", true)];
    const plan = planClose(withReal, 0b1000);
    expect(plan.pieces.map((p) => p.fate)).toEqual(["dead", "dead", "dead", "redeems", "real"]);
    expect(plan.realUsdc).toBe(wad("4881.88"));
    expect(plan.realWeth).toBe(wad("0.5"));
    expect(fateText(plan.pieces[3])).toBe("collapsed: redeemed 1:1 for real USDC");
    expect(fateText(plan.pieces[0])).toBe("dead: returned, worth nothing");
    expect(fateText(plan.pieces[4])).toBe("real WETH: returned");
  });

  it("a multi-world piece redeems once it covers every world still possible", () => {
    expect(fateOf(piece("usdc", 0b1100, "1"), 0b1100)).toBe("redeems");
    expect(fateOf(piece("usdc", 0b1110, "1"), 0b1100)).toBe("redeems");
    expect(fateOf(piece("usdc", 0b0110, "1"), 0b1100)).toBe("live");
  });
});

describe("wallet redemption", () => {
  const world = (i: number, possible: boolean, userWeth = "0", userUsdc = "0"): World => ({
    index: i,
    mask: 1 << i,
    label: LABELS[i],
    possible,
    poolInitialized: true,
    wethPrice: wad("2500"),
    backed: true,
    wethTokenId: `1:weth:${1 << i}`,
    usdcTokenId: `1:usdc:${1 << i}`,
    userWeth: userWeth === "0" ? 0n : wad(userWeth),
    userUsdc: userUsdc === "0" ? 0n : wad(userUsdc),
    collateralWeth: 0n,
    collateralUsdc: 0n,
    odds: 0n,
    poolId: null,
  });
  const scenario = (possible: number, worlds: World[]): Scenario => ({
    scenarioId: 1,
    worldCount: 4,
    possible,
    resolutionCount: 2,
    halted: false,
    eventIds: [1, 2],
    spotPrice: 0n,
    worlds,
    oddsKnown: true,
    impliedSpot: 0n,
  });

  it("lists single-world tokens only once their world is the only one left", () => {
    const worlds = [world(0, false, "1"), world(1, false), world(2, true, "0", "10"), world(3, true, "2", "5")];
    expect(walletRedeemable(scenario(0b1100, worlds))).toEqual([]);
    const last = [world(0, false, "1"), world(1, false), world(2, false, "0", "10"), world(3, true, "2", "5")];
    const rows = walletRedeemable(scenario(0b1000, last));
    expect(rows.map((r) => r.label)).toEqual(["WETH-if-DELAYED·HOLDS", "USDC-if-DELAYED·HOLDS"]);
    expect(rows[0]).toMatchObject({ asset: "weth", mask: 8, amount: wad("2"), symbol: "WETH" });
  });
});

describe("close summary from logs", () => {
  it("reads repaid and redeemed amounts from the contract's events", () => {
    const events = [
      { standard: "nep245", event: "mt_burn", data: [{ owner_id: "alice", token_ids: ["1:usdc:8"], amounts: ["1"] }] },
      { standard: "multiverse", event: "closed", data: [{ account_id: "alice", scenario_id: 1, repaid: "3000412328000000000000", pieces: 4 }] },
      { standard: "multiverse", event: "redeemed", data: [{ account_id: "alice", scenario_id: 1, asset: "usdc", mask: 8, amount: "4881885259897065638949" }] },
      { standard: "multiverse", event: "redeemed", data: [{ account_id: "alice", scenario_id: 1, asset: "weth", mask: 8, amount: "500000000000000000" }] },
    ];
    expect(summarizeClose(events)).toEqual({ repaid: 3000412328000000000000n, usdc: 4881885259897065638949n, weth: wad("0.5") });
    expect(summarizeClose(events.slice(0, 1))).toBeUndefined();
  });
});
