// Spot bar maths: implied spot against actual spot, the Impact Meter gap, and its sparkline.
import type { ImpactPoint, Scenario } from "./domain";
import { fmtUsd, pct } from "./format";

const CENT = 10n ** 16n;

export type ImpliedNote =
  | { kind: "unknown"; text: string }
  | { kind: "no-pool"; text: string }
  | { kind: "no-spot"; text: string }
  | { kind: "equal"; text: string }
  | { kind: "diff"; text: string; diff: string };

/** Where implied spot sits against actual spot, or why it is unknown. */
export function impliedNote(s: Pick<Scenario, "oddsKnown" | "impliedSpot" | "spotPrice">): ImpliedNote {
  if (!s.oddsKnown) return { kind: "unknown", text: "odds × world prices (needs every between-world pool)" };
  if (s.impliedSpot === 0n) return { kind: "no-pool", text: "odds × world prices (a world has no pool)" };
  if (s.spotPrice === 0n) return { kind: "no-spot", text: "odds × world prices" };
  const diff = s.impliedSpot - s.spotPrice;
  const abs = diff < 0n ? -diff : diff;
  if (abs < CENT) return { kind: "equal", text: "odds × world prices · equal to actual" };
  // No "+" for a negative difference: fmtUsd already writes "-$".
  const d = `${diff > 0n ? "+" : ""}${fmtUsd(diff)} (${pct(abs, s.spotPrice, 2)})`;
  return { kind: "diff", text: `odds × world prices · ${d} vs actual`, diff: d };
}

/** The headline gap: highest minus lowest pool price over the worlds still possible; 0 with fewer than two. */
export function impactGap(s: Pick<Scenario, "worlds">): bigint {
  const live = s.worlds.filter((w) => w.possible && w.poolInitialized).map((w) => w.wnearPrice);
  if (live.length < 2) return 0n;
  return live.reduce((m, v) => (v > m ? v : m)) - live.reduce((m, v) => (v < m ? v : m));
}

export type GapPoint = { at: number; gap: bigint };

/**
 * The gap after every recorded swap, over the worlds possible NOW (so a resolution rewrites the past series without
 * the dead worlds). Points with fewer than two live prices are skipped.
 */
export function impactSeries(points: readonly ImpactPoint[], possible: number): GapPoint[] {
  const out: GapPoint[] = [];
  for (const p of points) {
    const live = p.prices.filter((v, i) => ((possible >> i) & 1) === 1 && v > 0n);
    if (live.length < 2) continue;
    const hi = live.reduce((m, v) => (v > m ? v : m));
    const lo = live.reduce((m, v) => (v < m ? v : m));
    out.push({ at: p.at, gap: hi - lo });
  }
  return out;
}

export const SPARK_W = 96;
export const SPARK_H = 28;

/** SVG path of the gap history in a 96×28 box, or undefined with fewer than two points ("no swaps yet"). */
export function sparklinePath(points: readonly GapPoint[]): string | undefined {
  if (points.length < 2) return undefined;
  const max = points.reduce((m, p) => (p.gap > m ? p.gap : m), 1n);
  return points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * SPARK_W;
      const y = SPARK_H - Number((p.gap * BigInt(SPARK_H - 2)) / max) - 1;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export const allBacked = (s: Pick<Scenario, "worlds">) => s.worlds.filter((w) => w.possible).every((w) => w.backed);
