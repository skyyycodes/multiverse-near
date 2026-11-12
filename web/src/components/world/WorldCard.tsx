"use client";

import { motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { BranchLines } from "@/components/brand/BranchLines";
import { IconArrowUpRight } from "@/components/brand/Icons";
import type { World } from "@/lib/domain";
import type { CellQuote } from "@/lib/orders";
import { fmt, fmtUsd, fmtNear, pct, wholeUsd } from "@/lib/format";
import { alpha, hueOf } from "./hues";

const ONE = 10n ** 18n;

export type { CellQuote };

/** The aurora behind a world: deep navy with a large soft glow in the world's hue. */
export function auroraStyle(index: number, alive: boolean, strength = 1): CSSProperties {
  const hue = hueOf(index, alive);
  return {
    background: [
      `radial-gradient(110% 85% at 88% -4%, ${alpha(hue, 0.62 * strength)} 0%, ${alpha(hue, 0.2 * strength)} 40%, transparent 66%)`,
      `radial-gradient(70% 60% at -6% 108%, ${alpha(hue, 0.2 * strength)} 0%, transparent 70%)`,
      "linear-gradient(160deg, #0b1236 0%, #050a24 55%, #03061a 100%)",
    ].join(", "),
  };
}

export function Aurora({ index, alive, strength }: { index: number; alive: boolean; strength?: number }) {
  return (
    <>
      <span aria-hidden="true" className="absolute inset-0" style={auroraStyle(index, alive, strength)} />
      <BranchLines opacity={0.1} />
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-white/10 ring-inset" />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent"
      />
    </>
  );
}

export function BackedBadge({ ok, onDark = true }: { ok: boolean; onDark?: boolean }) {
  const tone = ok ? (onDark ? "bg-pos-dark/15 text-pos-dark" : "bg-pos-bright/12 text-pos") : onDark ? "bg-neg-dark/15 text-neg-dark" : "bg-neg-bright/12 text-neg";
  return (
    <span
      className={`num inline-flex shrink-0 items-center rounded-full px-2 py-1 text-[11px] leading-none whitespace-nowrap ${tone}`}
      title="Backing invariant: in this world, live tokens add up exactly to the real reserves"
    >
      {ok ? "✓ backed" : "✗ unbacked"}
    </span>
  );
}

/** "You hold 2.0000 WETH + 1.00 USDC here · loan collateral", or nothing when the account holds nothing here. */
export function Holdings({ world, className = "" }: { world: World; className?: string }) {
  const wnearHeld = world.userWnear + world.collateralWnear;
  const usdcHeld = world.userUsdc + world.collateralUsdc;
  if (wnearHeld === 0n && usdcHeld === 0n) return null;
  const posted = world.collateralWnear > 0n || world.collateralUsdc > 0n;
  return (
    <span className={`num block text-[12px] leading-snug ${className}`}>
      You hold{wnearHeld > 0n ? ` ${fmtNear(wnearHeld)} WETH` : ""}
      {wnearHeld > 0n && usdcHeld > 0n ? " +" : ""}
      {usdcHeld > 0n ? ` ${fmt(usdcHeld)} USDC` : ""} here
      {posted && <span className="opacity-60"> · loan collateral</span>}
    </span>
  );
}

type Props = {
  world: World;
  oddsKnown: boolean;
  selected: boolean;
  /** Without it the card is read-only (resolve screen). */
  onToggle?: (mask: number) => void;
  quote?: CellQuote;
  /** Corner tag on a selected card: SELL on the sell tab, BOOK when its order book is open. */
  badge?: string;
  detailsHref?: string;
};

/**
 * One world on the grid. Tapping it adds it to the sale (or opens its order book); a world ruled out by a resolution
 * loses its hue and fades back.
 */
export function WorldCard({ world, oddsKnown, selected, onToggle, quote, badge = "SELL", detailsHref }: Props) {
  const reduce = useReducedMotion();
  const dead = !world.possible;
  const readOnly = !onToggle;
  const hue = hueOf(world.index, !dead);
  const ring: CSSProperties = selected ? { boxShadow: `0 0 0 2px ${hue}, 0 18px 50px -18px ${alpha(hue, 0.7)}` } : {};
  return (
    <div className="relative min-w-0">
      <motion.button
        type="button"
        disabled={dead || readOnly}
        onClick={() => onToggle?.(world.mask)}
        aria-pressed={readOnly ? undefined : selected}
        data-demo="world-card"
        data-world={world.label}
        animate={dead ? { opacity: 0.35, scale: 0.985, filter: "grayscale(1)" } : { opacity: 1, scale: 1, filter: "grayscale(0)" }}
        transition={{ duration: reduce ? 0 : 0.9, ease: "easeOut" }}
        style={ring}
        className={`focus-ring relative isolate flex min-h-[214px] w-full flex-col gap-4 overflow-hidden rounded-[22px] p-5 text-left text-white shadow-card transition-shadow ${
          readOnly ? "cursor-default" : dead ? "cursor-not-allowed" : "hover:shadow-[0_0_0_1px_rgba(255,255,255,0.25)]"
        }`}
      >
        <Aurora index={world.index} alive={!dead} />
        <span className={`relative z-10 block truncate text-[13px] font-semibold tracking-[0.06em] ${selected ? "pr-28" : "pr-10"} ${dead ? "line-through" : ""}`}>
          {world.label}
        </span>
        <span className="relative z-10 -mt-2 flex">
          <BackedBadge ok={world.backed} />
        </span>
        <span className="relative z-10 block">
          <span className="numeral block text-[34px]">{world.poolInitialized ? fmtUsd(world.wnearPrice) : "no pool"}</span>
          <span className="mt-1.5 block text-[12px] text-white/60">ETH price if this world happens</span>
        </span>
        <span className="relative z-10 grid grid-cols-3 gap-2">
          <Metric
            label="odds"
            value={oddsKnown ? pct(world.odds, ONE) : undefined}
            title={
              oddsKnown
                ? "Market odds of this world, from the between-world pools (risk-neutral, not a probability)"
                : "Unknown until every between-world pool exists"
            }
          />
          <Metric label="best bid" value={quote && (quote.bid !== undefined ? wholeUsd(quote.bid) : "—")} />
          <Metric label="best ask" value={quote && (quote.ask !== undefined ? wholeUsd(quote.ask) : "—")} />
        </span>
        <Holdings world={world} className="relative z-10 text-white/90" />
        {selected && (
          <span
            className={`absolute top-5 z-10 rounded-full px-2.5 py-1 text-[10px] leading-none font-bold tracking-[0.1em] text-ink ${detailsHref ? "right-14" : "right-4"}`}
            style={{ background: hue }}
          >
            {badge}
          </span>
        )}
      </motion.button>
      {detailsHref && (
        <Link
          href={detailsHref}
          aria-label={`${world.label}: world details`}
          title="World details"
          data-demo="world-details"
          className="focus-ring absolute top-3.5 right-3.5 z-20 grid size-9 place-items-center rounded-full bg-white/10 text-white/80 backdrop-blur-sm hover:bg-white/20 hover:text-white"
        >
          <IconArrowUpRight size={18} />
        </Link>
      )}
    </div>
  );
}

function Metric({ label, value, title }: { label: string; value?: string; title?: string }): ReactNode {
  return (
    <span className="block min-w-0" title={title ?? (value === undefined ? "not available yet" : undefined)}>
      <span className="block text-[11px] text-white/55">{label}</span>
      <span className="num block truncate text-[14px] text-white">{value ?? "—"}</span>
    </span>
  );
}
