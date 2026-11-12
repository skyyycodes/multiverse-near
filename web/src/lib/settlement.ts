// What closing a position does with each piece of collateral, and which wallet tokens can be redeemed.
import type { Collateral, Scenario } from "./domain";
import type { NepEvent } from "./near/outcome";
import type { Asset } from "./types";

/** real: real wNEAR/USDC, returned as is. redeems: covers every world still possible, so it is worth the real asset
 *  1:1. live: some worlds still possible, returned as a world token. dead: no possible world, returned, worthless. */
export type Fate = "real" | "redeems" | "live" | "dead";

export type Piece = Collateral & { fate: Fate };

export type ClosePlan = {
  pieces: Piece[];
  /** Real USDC and wNEAR that reach the wallet: redeemed pieces plus real collateral. */
  realUsdc: bigint;
  realWnear: bigint;
};

/** The real tokens' symbols, as the contract names its world tokens ("wNEAR-if-DELAYED·HOLDS"). */
export const SYMBOL = { wnear: "wNEAR", usdc: "USDC" } as const;

export function fateOf(c: Collateral, possible: number): Fate {
  if (c.isReal) return "real";
  const alive = c.mask & possible;
  return alive === possible ? "redeems" : alive === 0 ? "dead" : "live";
}

export function planClose(collateral: readonly Collateral[], possible: number): ClosePlan {
  const pieces = collateral.map((c) => ({ ...c, fate: fateOf(c, possible) }));
  const sum = (asset: Asset) =>
    pieces.filter((p) => (p.fate === "redeems" || p.fate === "real") && p.asset === asset).reduce((s, p) => s + p.amount, 0n);
  return { pieces, realUsdc: sum("usdc"), realWnear: sum("wnear") };
}

export function fateText(p: Piece): string {
  const symbol = SYMBOL[p.asset];
  switch (p.fate) {
    case "redeems":
      return `collapsed: redeemed 1:1 for real ${symbol}`;
    case "live":
      return "still live: returned as a world token";
    case "dead":
      return "dead: returned, worth nothing";
    case "real":
      return `real ${symbol}: returned`;
  }
}

export type RedeemRow = { asset: Asset; symbol: (typeof SYMBOL)[Asset]; tokenId: string; mask: number; amount: bigint; label: string };

/**
 * Single-world tokens in the wallet whose world is the only one left: each redeems 1:1 for the real asset. A world
 * qualifies only when its mask covers every possible world, so the list appears only after full resolution.
 */
export function walletRedeemable(s: Scenario): RedeemRow[] {
  return s.worlds.flatMap((w) => {
    if ((w.mask & s.possible) !== s.possible) return [];
    const rows: RedeemRow[] = [
      { asset: "wnear", symbol: "wNEAR", tokenId: w.wnearTokenId, mask: w.mask, amount: w.userWnear, label: `wNEAR-if-${w.label}` },
      { asset: "usdc", symbol: "USDC", tokenId: w.usdcTokenId, mask: w.mask, amount: w.userUsdc, label: `USDC-if-${w.label}` },
    ];
    return rows.filter((r) => r.amount > 0n);
  });
}

export type CloseSummary = { repaid: bigint; usdc: bigint; wnear: bigint };

/**
 * What a close did, from the transaction's own NEP-297 logs: `closed` carries the repaid debt, each `redeemed` an
 * asset and an amount (internal 18-decimal units). Undefined when the logs say nothing about a close.
 */
export function summarizeClose(events: readonly NepEvent[]): CloseSummary | undefined {
  const mv = events.filter((e) => e.standard === "multiverse");
  const closed = mv.find((e) => e.event === "closed");
  if (!closed) return undefined;
  const amount = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : typeof v === "number" ? BigInt(Math.trunc(v)) : 0n);
  const repaid = closed.data.reduce((s, d) => s + amount(d.repaid), 0n);
  const redeemed = mv.filter((e) => e.event === "redeemed").flatMap((e) => e.data);
  const total = (asset: Asset) => redeemed.filter((d) => d.asset === asset).reduce((s, d) => s + amount(d.amount), 0n);
  return { repaid, usdc: total("usdc"), wnear: total("wnear") };
}
