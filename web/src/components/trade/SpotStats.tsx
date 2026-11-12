"use client";

import { StatTile } from "@/components/ui/Bits";
import type { EventState, ImpactPoint, Scenario } from "@/lib/domain";
import { fmtPrice } from "@/lib/format";
import { allBacked, impactGap, impactSeries, impliedNote, sparklinePath, SPARK_H, SPARK_W } from "@/lib/spot";

/** Actual spot, implied spot, the Impact Meter and the backing check. */
export function SpotStats({ scenario, impact }: { scenario: Scenario; impact: readonly ImpactPoint[] }) {
  const note = impliedNote(scenario);
  const backed = allBacked(scenario);
  return (
    <div className="grid grid-cols-2 gap-2 xl:grid-cols-4" data-demo="spot-stats">
      <StatTile
        demo="stat-actual-spot"
        label="Actual spot"
        value={scenario.spotPrice > 0n ? fmtPrice(scenario.spotPrice) : "—"}
        note="real wNEAR / USDC pool"
      />
      <StatTile
        demo="stat-implied-spot"
        label="Implied spot"
        value={scenario.impliedSpot > 0n ? fmtPrice(scenario.impliedSpot) : "—"}
        note={
          note.kind === "diff" ? (
            <>
              odds × world prices · <span className="whitespace-nowrap">{note.diff}</span> vs actual
            </>
          ) : (
            note.text
          )
        }
      />
      <StatTile demo="stat-impact" label="Impact meter" value={fmtPrice(impactGap(scenario))} note="gap between the highest and lowest world price">
        <Sparkline points={impactSeries(impact, scenario.possible)} />
      </StatTile>
      <StatTile
        demo="stat-backing"
        label="Every world balances"
        value={backed ? "✓ all backed" : "✗ check failed"}
        tone={backed ? "pos" : "neg"}
        note="live tokens = real reserves, per world"
      />
    </div>
  );
}

export function Sparkline({ points }: { points: ReturnType<typeof impactSeries> }) {
  const path = sparklinePath(points);
  if (!path) return <span className="text-[12px] text-mute">no swaps yet</span>;
  return (
    <svg width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} aria-label="Impact meter history" role="img" className="shrink-0">
      <path d={path} fill="none" stroke="var(--color-cobalt)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** The precise rule of each event, under the grid. */
export function Rules({ events, onDark }: { events: readonly EventState[]; onDark?: boolean }) {
  return (
    <div className={`flex flex-col gap-2.5 text-[12px] leading-relaxed ${onDark ? "text-white/60" : "text-mute"}`} data-demo="rules">
      {events.map((e) => (
        <p key={e.id}>
          <span className={onDark ? "text-white" : "text-ink"}>{e.question}</span> {e.rule}
          {e.finalized
            ? ` Resolved: ${e.outcomeNames[e.outcome]}.`
            : e.proposalOpen
              ? " A result is proposed and in its dispute window."
              : ""}
        </p>
      ))}
    </div>
  );
}
