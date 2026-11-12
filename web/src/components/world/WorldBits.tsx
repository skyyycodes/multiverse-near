"use client";

import { motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import type { World } from "@/lib/domain";
import { fmtUsd, pct } from "@/lib/format";
import { Aurora } from "./WorldCard";
import { alpha, hueOf, initials } from "./hues";

const ONE = 10n ** 18n;

/** The 40 px square in list rows: the world's initials on a tint of its hue. */
export function WorldGlyph({ world, size = 40 }: { world: Pick<World, "index" | "label" | "possible">; size?: number }) {
  const hue = hueOf(world.index, world.possible);
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-[12px] font-display text-[12px] font-semibold tracking-[0.02em] ${
        world.possible ? "text-ink" : "text-faint line-through"
      }`}
      style={{ width: size, height: size, background: world.possible ? alpha(hue, 0.22) : "#EEF2F7", boxShadow: `inset 0 0 0 1px ${alpha(hue, 0.35)}` }}
    >
      {initials(world.label)}
    </span>
  );
}

/** A small aurora card in the phone's futures strip; opens the world's detail. */
export function WorldThumb({ world, oddsKnown }: { world: World; oddsKnown: boolean }) {
  const reduce = useReducedMotion();
  const dead = !world.possible;
  return (
    <motion.div
      className="min-w-0"
      animate={dead ? { opacity: 0.4, filter: "grayscale(1)" } : { opacity: 1, filter: "grayscale(0)" }}
      transition={{ duration: reduce ? 0 : 0.9, ease: "easeOut" }}
    >
      <Link
        href={`/world/?w=${world.index}`}
        data-demo="world-thumb"
        data-world={world.label}
        aria-label={`${world.label}: ${world.poolInitialized ? fmtUsd(world.wnearPrice) : "no pool"}`}
        className="focus-ring relative isolate flex h-[108px] flex-col justify-between overflow-hidden rounded-[18px] p-3 text-white shadow-card"
      >
        <Aurora index={world.index} alive={!dead} strength={1.1} />
        <span className={`relative font-mono text-[11px] font-medium text-white/80 ${dead ? "line-through" : ""}`}>{initials(world.label)}</span>
        <span className="relative flex flex-col">
          <span className="num text-[16px] leading-tight">{world.poolInitialized ? fmtUsd(world.wnearPrice) : "—"}</span>
          <span className="num text-[11px] text-white/60">{oddsKnown ? pct(world.odds, ONE) : "—"}</span>
        </span>
      </Link>
    </motion.div>
  );
}

/**
 * An outcome over a column or beside a row of the grid; struck through once its event resolved the other way. The
 * event's question is in the title; the grid prints each axis's question once, above it.
 */
export function AxisLabel({
  outcome,
  question,
  resolvedAway,
  vertical,
  onDark,
}: {
  outcome: string;
  question?: string;
  resolvedAway: boolean;
  vertical?: boolean;
  onDark?: boolean;
}) {
  return (
    <div
      className={`flex min-w-0 flex-col ${vertical ? "justify-center pr-1" : "justify-end px-1 pb-0.5"}`}
      title={question}
      data-demo="axis-label"
    >
      <span
        className={`text-[12px] font-semibold tracking-[0.08em] ${
          resolvedAway ? `${onDark ? "text-white/40" : "text-faint"} line-through` : onDark ? "text-white" : "text-ink"
        }`}
      >
        {outcome}
      </span>
    </div>
  );
}
