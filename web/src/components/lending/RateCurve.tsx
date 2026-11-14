"use client";

import type { TierConfig } from "@/lib/domain";
import { pct } from "@/lib/format";
import { annualRate, borrowRate, curvePoints, supplyRate, WAD } from "@/lib/lending";

const W = 358;
const H = 140;
const PAD = { l: 34, r: 10, t: 10, b: 22 };

/** The tier's borrow rate (solid) and supply rate (dashed) against utilization, with the kink and where it is now. */
export function RateCurve({ config, utilization }: { config: TierConfig; utilization: bigint }) {
  const pts = curvePoints(config);
  const top = annualRate(pts[pts.length - 1].borrow);
  const yMax = top > 0n ? top : WAD;
  const x = (u: bigint) => PAD.l + (Number((u * 10_000n) / WAD) / 10_000) * (W - PAD.l - PAD.r);
  const y = (apr: bigint) => H - PAD.b - (Number((apr * 10_000n) / yMax) / 10_000) * (H - PAD.t - PAD.b);
  const line = (k: "borrow" | "supply") => pts.map((p) => `${x(p.u).toFixed(1)},${y(annualRate(p[k])).toFixed(1)}`).join(" ");
  const nowBorrow = annualRate(borrowRate(utilization, config));
  const nowSupply = annualRate(supplyRate(borrowRate(utilization, config), WAD, utilization > WAD ? WAD : utilization, config.reserveFactor));
  const label = `Borrow rate ${pct(nowBorrow, WAD, 2)} at ${pct(utilization, WAD, 0)} utilization; ${pct(top, WAD, 2)} at full use`;
  return (
    <figure className="flex flex-col gap-2" data-demo="rate-curve">
      <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-[520px]">
        <line x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} stroke="var(--color-line-strong)" />
        <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={H - PAD.b} stroke="var(--color-line-strong)" />
        <text x={PAD.l - 4} y={PAD.t + 8} textAnchor="end" fontSize="9" fill="var(--color-mute)">
          {pct(yMax, WAD, 0)}
        </text>
        <text x={PAD.l - 4} y={H - PAD.b} textAnchor="end" fontSize="9" fill="var(--color-mute)">
          0%
        </text>
        {["0%", "50%", "100%"].map((t, i) => (
          <text key={t} x={PAD.l + (i / 2) * (W - PAD.l - PAD.r)} y={H - 6} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} fontSize="9" fill="var(--color-mute)">
            {t}
          </text>
        ))}
        <line x1={x(config.rateKink)} y1={PAD.t} x2={x(config.rateKink)} y2={H - PAD.b} stroke="var(--color-line-strong)" strokeDasharray="2 3" />
        <text x={x(config.rateKink) + 3} y={PAD.t + 8} fontSize="9" fill="var(--color-mute)">
          kink {pct(config.rateKink, WAD, 0)}
        </text>
        <polyline points={line("supply")} fill="none" stroke="var(--color-cobalt)" strokeWidth="2" strokeDasharray="5 4" />
        <polyline points={line("borrow")} fill="none" stroke="var(--color-ink)" strokeWidth="2" />
        <circle cx={x(utilization > WAD ? WAD : utilization)} cy={y(nowBorrow)} r="4" fill="var(--color-ink)" />
        <circle cx={x(utilization > WAD ? WAD : utilization)} cy={y(nowSupply)} r="3.5" fill="var(--color-cobalt)" />
      </svg>
      <figcaption className="num flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-mute">
        <span>
          <span className="text-ink">━</span> borrow {pct(nowBorrow, WAD, 2)}
        </span>
        <span>
          <span className="text-cobalt">┅</span> supply {pct(nowSupply, WAD, 2)}
        </span>
        <span>now at {pct(utilization, WAD, 1)} utilization</span>
      </figcaption>
    </figure>
  );
}
