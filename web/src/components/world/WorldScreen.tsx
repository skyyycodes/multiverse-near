"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Screen } from "@/components/shell/Screen";
import { ConfigGuard } from "@/components/trade/Guard";
import { PillLink } from "@/components/ui/Button";
import { Chip, InfoRows } from "@/components/ui/Bits";
import { ChainWait } from "@/components/ui/Notice";
import { Block } from "@/components/ui/Surface";
import type { AppConfig, EventState, Scenario, World } from "@/lib/domain";
import { fmt, fmtUsd, fmtNear, pct } from "@/lib/format";
import { useNowSeconds } from "@/lib/hooks/useClock";
import { usePool, useScenarioId, useTrade } from "@/lib/hooks/useData";
import { useIsDesktop } from "@/lib/hooks/useMedia";
import { useWallet } from "@/lib/near/wallet";
import { cellBook } from "@/lib/orders";
import { Aurora, BackedBadge } from "./WorldCard";
import { hueOf, spaced } from "./hues";

const ONE = 10n ** 18n;

/** One world at a time: a carousel of world cards, its price, and what is known about its pool. */
export function WorldScreen() {
  return <ConfigGuard>{(config) => <WorldDetail config={config} />}</ConfigGuard>;
}

function WorldDetail({ config }: { config: AppConfig }) {
  const params = useSearchParams();
  const router = useRouter();
  const wallet = useWallet();
  const desktop = useIsDesktop();
  const sid = useScenarioId(config);
  const trade = useTrade(sid, wallet.accountId);
  const s = trade.data?.scenario;
  const count = s?.worlds.length ?? 0;
  const requested = Number(params.get("w") ?? 0);
  const [index, setIndex] = useState(Number.isInteger(requested) && requested >= 0 ? requested : 0);
  const current = s ? Math.min(index, count - 1) : 0;
  const world = s?.worlds[current];

  const select = (i: number) => {
    setIndex(i);
    router.replace(`/world/?w=${i}`, { scroll: false });
  };

  return (
    <Screen
      demo="world"
      back={{ href: "/", label: "Trade" }}
      asideFirst
      hero={s ? <Carousel scenario={s} index={current} onIndex={select} wide={desktop} /> : <div className="skeleton-dark h-56 rounded-[22px]" />}
      aside={
        s && world && trade.data ? (
          <WorldInfo config={config} scenario={s} world={world} orders={trade.data.orders} />
        ) : (
          <Block>
            <ChainWait error={trade.error?.message} onRetry={() => void trade.refetch()} />
          </Block>
        )
      }
    >
      {s && world && trade.data && <Conditions scenario={s} world={world} events={trade.data.events} />}
    </Screen>
  );
}

/** Swipeable cards with dots; the scroll position decides which world the rest of the screen describes. */
function Carousel({ scenario, index, onIndex, wide }: { scenario: Scenario; index: number; onIndex: (i: number) => void; wide: boolean }) {
  const track = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  // Bring the chosen card into view when the index changes from outside the track (dots, the link it was opened with).
  useEffect(() => {
    const el = track.current?.children[index] as HTMLElement | undefined;
    el?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", inline: "center", block: "nearest" });
  }, [index, reduce]);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const mid = el.scrollLeft + el.clientWidth / 2;
        let best = 0;
        let dist = Infinity;
        Array.from(el.children).forEach((c, i) => {
          const h = c as HTMLElement;
          const d = Math.abs(h.offsetLeft + h.offsetWidth / 2 - mid);
          if (d < dist) {
            dist = d;
            best = i;
          }
        });
        if (best !== index) onIndex(best);
      }, 120);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      clearTimeout(t);
    };
  }, [index, onIndex]);

  return (
    <div className="flex flex-col gap-4" data-demo="world-carousel">
      <div
        ref={track}
        className={`no-scrollbar flex snap-x snap-mandatory gap-3 overflow-x-auto py-2 ${wide ? "px-[calc(50%-220px)] [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]" : "-mx-4 px-[max(16px,calc(50%-150px))]"}`}
      >
        {scenario.worlds.map((w, i) => (
          <DetailCard key={w.mask} world={w} active={i === index} wide={wide} count={scenario.worlds.length} oddsKnown={scenario.oddsKnown} onClick={() => onIndex(i)} />
        ))}
      </div>
      <div className="flex items-center justify-center gap-1.5" role="tablist" aria-label="Worlds">
        {scenario.worlds.map((w, i) => (
          <button
            key={w.mask}
            type="button"
            role="tab"
            aria-selected={i === index}
            aria-label={w.label}
            onClick={() => onIndex(i)}
            className="focus-ring grid h-6 place-items-center rounded-full px-1"
          >
            <span className={`block h-1.5 rounded-full transition-all ${i === index ? "w-6 bg-white" : "w-1.5 bg-white/35"}`} />
          </button>
        ))}
      </div>
    </div>
  );
}

/** The card: where this world sits on the grid (its quadrant lit), its number, odds and outcome label. */
function DetailCard({
  world,
  active,
  wide,
  count,
  oddsKnown,
  onClick,
}: {
  world: World;
  active: boolean;
  wide: boolean;
  count: number;
  oddsKnown: boolean;
  onClick: () => void;
}) {
  const reduce = useReducedMotion();
  const dead = !world.possible;
  const hue = hueOf(world.index, !dead);
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-label={`World ${world.index}: ${world.label}`}
      aria-current={active ? "true" : undefined}
      data-demo="world-detail-card"
      data-world={world.label}
      animate={{ scale: active ? 1 : 0.94, opacity: dead ? 0.45 : active ? 1 : 0.7, filter: dead ? "grayscale(1)" : "grayscale(0)" }}
      transition={{ duration: reduce ? 0 : 0.26, ease: "easeOut" }}
      className={`focus-ring relative isolate flex shrink-0 snap-center flex-col justify-between overflow-hidden rounded-[24px] p-5 text-left text-white shadow-card ${
        wide ? "h-[276px] w-[440px]" : "h-[206px] w-[300px]"
      }`}
    >
      <Aurora index={world.index} alive={!dead} strength={1.25} />
      <span className="relative flex items-start justify-between">
        <span className="font-mono text-[12px] tracking-[0.12em] text-white/75">WORLD {world.index}</span>
        <BackedBadge ok={world.backed} />
      </span>
      <span className="relative grid place-items-center" aria-hidden="true">
        <span className={`grid gap-1 ${count === 4 ? "grid-cols-2" : "grid-cols-2"}`}>
          {(count === 4 ? [0, 2, 1, 3] : [0, 1]).map((q) => (
            <span
              key={q}
              className="size-5 rounded-[6px]"
              style={q === world.index ? { background: hue, boxShadow: `0 0 24px ${hue}` } : { boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.28)" }}
            />
          ))}
        </span>
      </span>
      <span className="relative flex items-end justify-between gap-3">
        <span className="num rounded-full bg-white/12 px-2.5 py-1 text-[12px] text-white backdrop-blur-sm">
          odds {oddsKnown ? pct(world.odds, ONE) : "—"}
        </span>
        <span className={`text-right font-display text-[17px] font-medium tracking-[0.02em] ${dead ? "line-through" : ""}`}>{spaced(world.label)}</span>
      </span>
    </motion.button>
  );
}

function WorldInfo({ config, scenario, world, orders }: { config: AppConfig; scenario: Scenario; world: World; orders: Parameters<typeof cellBook>[0] }) {
  const pool = usePool(world.poolId);
  const now = useNowSeconds();
  const book = cellBook(orders, scenario, world.mask, now);
  const p = pool.data;
  const dead = !world.possible;
  const fee = p?.feePips !== undefined ? `${(p.feePips / 10_000).toFixed(2)}%` : "—";
  const held = world.userWnear + world.collateralWnear > 0n || world.userUsdc + world.collateralUsdc > 0n;
  return (
    <Block demo="world-info">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-full" style={{ background: hueOf(world.index, !dead) }} />
          <span className="label text-mute">{spaced(world.label)}</span>
          {dead && <Chip tone="neutral">resolved away</Chip>}
        </div>
        <span className="numeral text-[44px] text-ink">{world.poolInitialized ? fmtUsd(world.wnearPrice) : "no pool"}</span>
        <span className="text-[13px] text-mute">ETH price if this world happens</span>
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="font-display text-[18px] font-medium text-ink">World info</h3>
        <InfoRows
          rows={[
            { label: "Odds", value: scenario.oddsKnown ? pct(world.odds, ONE) : "—" },
            {
              label: "Pool depth",
              value: p?.wnearReserve !== undefined && p?.usdcReserve !== undefined ? `${fmt(p.wnearReserve)} WETH / ${fmt(p.usdcReserve, 0)} USDC` : "—",
            },
            { label: "Dynamic fee now", value: fee },
            {
              label: "Best bid / best ask",
              value: config.orderBook
                ? `${book.bids[0] ? fmtUsd(book.bids[0].price) : "—"} / ${book.asks[0] ? fmtUsd(book.asks[0].price) : "—"}`
                : "—",
            },
            { label: `TWAP (${config.twapWindowSec} s) price`, value: p?.twapPrice ? fmtUsd(p.twapPrice) : "—" },
            { label: "Your position", value: held ? positionText(world) : "nothing here" },
            { label: "Backed", value: world.backed ? "✓ live tokens = reserves" : "✗ check failed", tone: world.backed ? "text-pos" : "text-neg" },
          ]}
        />
      </div>
      {!dead && (
        <div className="grid grid-cols-2 gap-2">
          <PillLink href={`/sell/?w=${world.index}`} tone="primary" size="lg" demo="world-sell-here">
            Sell here
          </PillLink>
          <PillLink href={`/orders/?w=${world.index}&buy=1`} tone="secondary" size="lg" demo="world-buy-here">
            Buy here
          </PillLink>
          <PillLink href={`/orders/?w=${world.index}`} tone="ghost" size="md" className="col-span-2" demo="world-order-book">
            Order book
          </PillLink>
        </div>
      )}
      {world.userWnear > 0n && dead && <p className="text-[12px] text-mute">Tokens of a world that can no longer happen are worth nothing. {fmtNear(world.userWnear)} WETH-if-{world.label} stays in your wallet.</p>}
    </Block>
  );
}

/** "2.0000 WETH + 1.00 USDC · loan collateral", short enough for one info row. */
function positionText(w: World): string {
  const wnear = w.userWnear + w.collateralWnear;
  const usdc = w.userUsdc + w.collateralUsdc;
  const parts = [wnear > 0n ? `${fmtNear(wnear)} WETH` : "", usdc > 0n ? `${fmt(usdc)} USDC` : ""].filter(Boolean);
  const posted = w.collateralWnear > 0n || w.collateralUsdc > 0n;
  return `${parts.join(" + ")}${posted ? " · collateral" : ""}`;
}

/** The events' outcomes this world stands for, in plain words: what has to happen for its tokens to pay. */
function Conditions({ scenario, world, events }: { scenario: Scenario; world: World; events: readonly EventState[] }) {
  // world = a + 2b: event A's outcome is the low digit, event B's the high one
  const outcomes = events.map((e, k) => ({ e, o: k === 0 ? world.index % 2 : Math.floor(world.index / 2) % 2 }));
  return (
    <Block title="What has to happen" demo="world-conditions">
      <ul className="flex flex-col">
        {outcomes.map(({ e, o }) => {
          const settled = e.finalized;
          const happened = settled && e.outcome === o;
          return (
            <li key={e.id} className="flex items-start justify-between gap-4 border-b border-line py-3 last:border-b-0">
              <span className="text-[14px] leading-snug text-ink">{e.question}</span>
              <Chip tone={settled ? (happened ? "pos" : "neg") : "info"}>
                {e.outcomeNames[o]}
                {settled ? (happened ? " ✓" : " ✗") : ""}
              </Chip>
            </li>
          );
        })}
      </ul>
      <p className="text-[13px] leading-relaxed text-mute">
        If {scenario.worldCount === 4 ? "both happen" : "it happens"}, WETH-if-{world.label} pays 1 real WETH and USDC-if-{world.label} pays 1 real USDC,
        per token. If not, they pay nothing.
      </p>
    </Block>
  );
}
