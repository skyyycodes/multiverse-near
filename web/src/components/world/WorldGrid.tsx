"use client";

import { Fragment, type ReactNode } from "react";
import type { EventState, Scenario, World } from "@/lib/domain";
import { fmtUsd } from "@/lib/format";
import { useIsWide } from "@/lib/hooks/useMedia";
import { worldHref } from "@/lib/links";
import { AxisLabel } from "./WorldBits";
import { WorldCard, type CellQuote } from "./WorldCard";
import { hueOf, initials } from "./hues";

/** The event that ruled `outcome` out, if it has resolved to something else. */
const resolvedAway = (e: EventState, outcome: string) => e.finalized && e.outcomeNames[e.outcome] !== outcome;

/**
 * Lays worlds out the way the events cross: rows are event A's outcomes, columns event B's, world = a + 2b. Three
 * events make two such 2×2 blocks, one per outcome of event C (world = a + 2b + 4c). One event is a plain row of two.
 */
function Axes({
  scenario,
  events,
  cell,
  onDark,
  compact,
  sideBySide,
  gap,
}: {
  scenario: Scenario;
  events: readonly EventState[];
  cell: (w: World) => ReactNode;
  onDark?: boolean;
  compact?: boolean;
  /** Eight worlds: the two blocks next to each other instead of stacked. */
  sideBySide?: boolean;
  gap: string;
}) {
  const worlds = scenario.worlds;
  if (scenario.worldCount === 8 && events.length === 3 && worlds.length === 8) {
    const [a, b, c] = events;
    return (
      <div className="flex flex-col gap-3">
        {!compact && <AxisCaptions rows={a} cols={b} blocks={c} onDark={onDark} />}
        <div className={sideBySide ? "grid grid-cols-2 gap-5" : "flex flex-col gap-4"}>
          {[0, 1].map((k) => (
            <div key={k} className="flex min-w-0 flex-col gap-2" data-demo="grid-block" data-block={k}>
              <span
                title={c.question}
                className={`text-[12px] font-semibold tracking-[0.08em] ${
                  resolvedAway(c, c.outcomeNames[k]) ? `${onDark ? "text-white/40" : "text-faint"} line-through` : onDark ? "text-white" : "text-ink"
                }`}
              >
                <span className={`label mr-1.5 ${onDark ? "text-white/45" : "text-faint"}`}>C:</span>
                {c.outcomeNames[k]}
              </span>
              <Square a={a} b={b} at={(row, col) => worlds[row + 2 * col + 4 * k]} cell={cell} onDark={onDark} gap={gap} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (scenario.worldCount === 4 && events.length === 2 && worlds.length === 4) {
    const [a, b] = events;
    return (
      <div className="flex flex-col gap-3">
        {!compact && <AxisCaptions rows={a} cols={b} onDark={onDark} />}
        <Square a={a} b={b} at={(row, col) => worlds[row + 2 * col]} cell={cell} onDark={onDark} gap={gap} />
      </div>
    );
  }
  return <div className={`grid grid-cols-2 ${gap}`}>{worlds.map((w) => <Fragment key={w.mask}>{cell(w)}</Fragment>)}</div>;
}

/** One 2×2 block: event B's outcomes over the columns, event A's beside the rows. */
function Square({
  a,
  b,
  at,
  cell,
  onDark,
  gap,
}: {
  a: EventState;
  b: EventState;
  at: (row: number, col: number) => World;
  cell: (w: World) => ReactNode;
  onDark?: boolean;
  gap: string;
}) {
  return (
    <div className={`grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] ${gap}`}>
      <div />
      {b.outcomeNames.map((name) => (
        <AxisLabel key={name} outcome={name} question={b.question} resolvedAway={resolvedAway(b, name)} onDark={onDark} />
      ))}
      {[0, 1].map((row) => (
        <Fragment key={row}>
          <AxisLabel outcome={a.outcomeNames[row]} question={a.question} resolvedAway={resolvedAway(a, a.outcomeNames[row])} vertical onDark={onDark} />
          {[0, 1].map((col) => (
            <Fragment key={col}>{cell(at(row, col))}</Fragment>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

/** Each axis's question once and in full, above the grid: rows are event A's outcomes, columns event B's, grids C's. */
function AxisCaptions({ rows, cols, blocks, onDark }: { rows: EventState; cols: EventState; blocks?: EventState; onDark?: boolean }) {
  const line = (axis: string, e: EventState) => (
    <p className="text-[12px] leading-snug" title={e.question}>
      <span className={`label mr-1.5 ${onDark ? "text-white/45" : "text-faint"}`}>{axis}</span>
      <span className={onDark ? "text-white/75" : "text-mute"}>{e.question}</span>
    </p>
  );
  return (
    <div className="flex flex-col gap-1" data-demo="grid-axes">
      {line("Rows", rows)}
      {line("Columns", cols)}
      {blocks && line("Grids", blocks)}
    </div>
  );
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
  // Eight worlds: two blocks side by side with compact cards from 1280 px, stacked full cards below that.
  const wide = useIsWide() && scenario.worldCount === 8;
  return (
    <div data-demo="world-grid">
      <Axes
        scenario={scenario}
        events={events}
        onDark={onDark}
        sideBySide={wide}
        gap="gap-3"
        cell={(w) => (
          <WorldCard
            world={w}
            oddsKnown={scenario.oddsKnown}
            selected={(selected & w.mask) !== 0}
            onToggle={onToggle}
            quote={quotes?.[w.index]}
            badge={badge}
            size={wide ? "compact" : "full"}
            detailsHref={details && !wide ? worldHref(scenario.scenarioId, w.index) : undefined}
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
              <span className={`block w-full min-w-0 truncate text-[11px] font-semibold text-ink ${dead ? "line-through" : ""}`} title={w.label}>
                {scenario.worldCount === 8 ? initials(w.label) : w.label}
              </span>
              <span className="num text-[14px] text-mute">{w.poolInitialized ? fmtUsd(w.wnearPrice) : "no pool"}</span>
            </button>
          );
        }}
      />
    </div>
  );
}
