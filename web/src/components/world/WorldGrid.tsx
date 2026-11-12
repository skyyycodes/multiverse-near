"use client";

import { Fragment, type ReactNode } from "react";
import type { EventState, Scenario, World } from "@/lib/domain";
import { fmtUsd } from "@/lib/format";
import { AxisLabel } from "./WorldBits";
import { WorldCard, type CellQuote } from "./WorldCard";
import { hueOf } from "./hues";

/** The event that ruled `outcome` out, if it has resolved to something else. */
const resolvedAway = (e: EventState, outcome: string) => e.finalized && e.outcomeNames[e.outcome] !== outcome;

/**
 * Lays worlds out the way the two events cross: rows are event A's outcomes, columns event B's, world = a + 2b. A
 * scenario with one event is a plain row of two.
 */
function Axes({
  scenario,
  events,
  cell,
  onDark,
  compact,
  gap,
}: {
  scenario: Scenario;
  events: readonly EventState[];
  cell: (w: World) => ReactNode;
  onDark?: boolean;
  compact?: boolean;
  gap: string;
}) {
  const worlds = scenario.worlds;
  if (scenario.worldCount === 4 && events.length === 2 && worlds.length === 4) {
    const [a, b] = events;
    return (
      <div className={`grid ${compact ? "grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]" : "grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,1fr)]"} ${gap}`}>
        <div />
        {b.outcomeNames.map((name) => (
          <AxisLabel key={name} outcome={name} question={b.question} resolvedAway={resolvedAway(b, name)} onDark={onDark} compact={compact} />
        ))}
        {[0, 1].map((row) => (
          <Fragment key={row}>
            <AxisLabel
              outcome={a.outcomeNames[row]}
              question={a.question}
              resolvedAway={resolvedAway(a, a.outcomeNames[row])}
              vertical
              onDark={onDark}
              compact={compact}
            />
            {[0, 1].map((col) => (
              <Fragment key={col}>{cell(worlds[row + 2 * col])}</Fragment>
            ))}
          </Fragment>
        ))}
      </div>
    );
  }
  return <div className={`grid grid-cols-2 ${gap}`}>{worlds.map((w) => <Fragment key={w.mask}>{cell(w)}</Fragment>)}</div>;
}

/** The big grid of aurora world cards (desktop trade, resolve, admin). */
export function WorldGrid({
  scenario,
  events,
  selected = 0,
  onToggle,
  quotes,
  badge,
  details = true,
  onDark = true,
}: {
  scenario: Scenario;
  events: readonly EventState[];
  selected?: number;
  onToggle?: (mask: number) => void;
  quotes?: readonly CellQuote[];
  badge?: string;
  details?: boolean;
  onDark?: boolean;
}) {
  return (
    <div data-demo="world-grid">
      <Axes
        scenario={scenario}
        events={events}
        onDark={onDark}
        gap="gap-3"
        cell={(w) => (
          <WorldCard
            world={w}
            oddsKnown={scenario.oddsKnown}
            selected={(selected & w.mask) !== 0}
            onToggle={onToggle}
            quote={quotes?.[w.index]}
            badge={badge}
            detailsHref={details ? `/world/?w=${w.index}` : undefined}
          />
        )}
      />
    </div>
  );
}

/**
 * The compact picker inside forms: one pill per world on the same axes. Selected pills get a 2 px ink border and their
 * hue filled in.
 */
export function WorldPicker({
  scenario,
  events,
  selected,
  onToggle,
  demo = "world-pick",
}: {
  scenario: Scenario;
  events: readonly EventState[];
  selected: number;
  onToggle: (mask: number) => void;
  demo?: string;
}) {
  return (
    <div data-demo={`${demo}-grid`}>
      <Axes
        scenario={scenario}
        events={events}
        compact
        gap="gap-2"
        cell={(w) => {
          const on = (selected & w.mask) !== 0;
          const dead = !w.possible;
          const hue = hueOf(w.index, !dead);
          return (
            <button
              type="button"
              aria-pressed={on}
              disabled={dead}
              onClick={() => onToggle(w.mask)}
              data-demo={demo}
              data-world={w.label}
              className={`focus-ring relative flex min-h-[68px] min-w-0 flex-col items-start justify-center gap-1 overflow-hidden rounded-[16px] bg-sheet px-2.5 py-2.5 text-left transition-[box-shadow,opacity] ${
                dead ? "cursor-not-allowed opacity-45" : ""
              } ${on ? "shadow-[inset_0_0_0_2px_var(--color-ink)]" : "shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:shadow-[inset_0_0_0_1px_var(--color-ink)]"}`}
            >
              <span
                aria-hidden="true"
                className="absolute inset-x-3 top-0 h-[3px] rounded-b-full transition-opacity"
                style={{ background: hue, opacity: on ? 1 : 0.45 }}
              />
              <span className={`block w-full min-w-0 truncate text-[11px] font-semibold text-ink ${dead ? "line-through" : ""}`}>{w.label}</span>
              <span className="num text-[14px] text-mute">{w.poolInitialized ? fmtUsd(w.wnearPrice) : "no pool"}</span>
            </button>
          );
        }}
      />
    </div>
  );
}
