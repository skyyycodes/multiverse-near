"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { IconBack, IconBorrow, IconChevronRight, IconLend, IconProtect } from "@/components/brand/Icons";
import { Mark } from "@/components/brand/Mark";
import { HeroNumber } from "@/components/shell/Screen";
import { SectionLabel } from "@/components/ui/Bits";
import { WorldGlyph, WorldThumb } from "@/components/world/WorldBits";
import type { CellQuote } from "@/components/world/WorldCard";
import { hueOf, spaced } from "@/components/world/hues";
import type { Scenario, World } from "@/lib/domain";
import { fmt, fmtUsd, fmtWeth, pct, wholeUsd } from "@/lib/format";
import type { Balances } from "@/lib/hooks/useData";
import { useWallet } from "@/lib/near/wallet";

const ONE = 10n ** 18n;
const CENT = 10n ** 16n;
const COUNT = ["", "one", "two", "three", "four"];

/** "implied by the four futures: $3,037.86 ✓", or the difference, or why it is unknown. */
export function impliedLine(s: Scenario): ReactNode {
  const live = s.worlds.filter((w) => w.possible).length;
  const n = COUNT[live] ?? String(live);
  if (!s.oddsKnown) return "Implied spot unknown until every between-world pool exists";
  if (s.impliedSpot === 0n) return "Implied spot unknown: a world has no pool";
  const head = `implied by the ${n} ${live === 1 ? "future" : "futures"}: ${fmtUsd(s.impliedSpot)}`;
  if (s.spotPrice === 0n) return head;
  const diff = s.impliedSpot - s.spotPrice;
  const abs = diff < 0n ? -diff : diff;
  if (abs < CENT) return <>{head} <span className="text-pos-dark">✓</span></>;
  return `${head} (${diff > 0n ? "+" : ""}${fmtUsd(diff)})`;
}

/** Wallet balances as chips; one "Connect" pill while signed out. */
export function BalanceChips({ balances, loading, hideConnect }: { balances?: Balances; loading?: boolean; hideConnect?: boolean }) {
  const wallet = useWallet();
  if (!wallet.accountId) {
    // On a desktop the header already offers the connect button.
    if (hideConnect) return <span className="text-[13px] text-white/60">Connect a NEAR wallet to trade, borrow or lend.</span>;
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void wallet.connect()}
          className="focus-ring h-10 rounded-full bg-white px-4 text-[14px] font-semibold text-ink hover:bg-ice"
          data-demo="connect-chip"
        >
          Connect NEAR wallet
        </button>
        <span className="text-[12px] text-white/60">to trade, borrow or lend</span>
      </div>
    );
  }
  const b = balances;
  const inner = innerChipText(b);
  return (
    <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 lg:mx-0 lg:px-0" data-demo="balance-chips">
      <BalanceChip glyph={<EthGlyph />} label="WETH" value={b ? fmtWeth(b.weth) : undefined} loading={loading} />
      <BalanceChip glyph={<UsdGlyph />} label="USDC" value={b ? fmt(b.usdc) : undefined} loading={loading} />
      {inner && <BalanceChip glyph={<Mark size={20} />} label="In Multiverse" value={inner} />}
    </div>
  );
}

/**
 * The "In Multiverse" chip's text, or nothing when the amount rounds to zero at the chip's precision: a withdrawal can
 * leave a few billionths of a USDC of rounding behind, and a chip reading 0.00 looks like money left over.
 */
export function innerChipText(b: Balances | undefined): string | undefined {
  if (!b) return undefined;
  const parts = [
    b.innerUsdc >= 10n ** 16n ? `${fmt(b.innerUsdc)} USDC` : undefined,
    b.innerWeth >= 10n ** 14n ? `${fmtWeth(b.innerWeth)} WETH` : undefined,
  ].filter((p) => p !== undefined);
  return parts.length > 0 ? parts.join(" + ") : undefined;
}

function BalanceChip({ glyph, label, value, loading }: { glyph: ReactNode; label: string; value?: string; loading?: boolean }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2.5 rounded-full border border-white/10 bg-white/8 pr-4 pl-1.5 backdrop-blur-sm">
      <span className="grid size-9 place-items-center rounded-full bg-navy-950/70">{glyph}</span>
      <span className="flex flex-col leading-tight">
        <span className="text-[10px] font-medium tracking-[0.08em] text-white/60 uppercase">{label}</span>
        {loading && !value ? (
          <span className="skeleton-dark mt-0.5 h-3.5 w-16 rounded" />
        ) : (
          <span className="num text-[14px] text-white">{value ?? "—"}</span>
        )}
      </span>
    </div>
  );
}

const EthGlyph = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2.5 6 12.2l6 3.5 6-3.5L12 2.5Z" fill="#D0F6F9" />
    <path d="m6 13.6 6 7.9 6-7.9-6 3.5-6-3.5Z" fill="#8FBEDC" />
  </svg>
);
const UsdGlyph = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9.5" fill="#2899D2" />
    <path d="M14.6 9.2c-.4-.9-1.4-1.5-2.6-1.5-1.5 0-2.6.8-2.6 2s1 1.7 2.6 2c1.6.3 2.7.8 2.7 2.1s-1.2 2.1-2.7 2.1c-1.3 0-2.4-.6-2.8-1.6M12 6.2v1.5M12 16v1.6" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" fill="none" />
  </svg>
);

/** The headline: ETH's real spot price, and what the futures together imply. */
export function SpotHero({ scenario }: { scenario: Scenario | undefined }) {
  return (
    <HeroNumber
      demo="hero-spot"
      label="ETH spot"
      loading={!scenario}
      value={scenario && scenario.spotPrice > 0n ? fmtUsd(scenario.spotPrice) : "—"}
      sub={scenario ? impliedLine(scenario) : undefined}
    />
  );
}

/** The phone's futures strip: every world as a small aurora card. */
export function FuturesStrip({ scenario }: { scenario: Scenario }) {
  return (
    <div className={`grid gap-2 ${scenario.worlds.length === 4 ? "grid-cols-4" : "grid-cols-2"}`} data-demo="futures-strip">
      {scenario.worlds.map((w) => (
        <WorldThumb key={w.mask} world={w} oddsKnown={scenario.oddsKnown} />
      ))}
    </div>
  );
}

/** Protect, Back, Borrow, Lend. Each tile shows a hint of what it does. */
export function ActionTiles({ scenario, sellMask }: { scenario: Scenario; sellMask: number }) {
  return (
    <div className="grid grid-cols-4 gap-2" data-demo="action-tiles">
      <Tile href="/sell/" label="Protect" icon={<IconProtect size={20} />} demo="tile-protect">
        <Dots scenario={scenario} mode="feared" mask={sellMask} />
      </Tile>
      <Tile href="/orders/?buy=1" label="Back" icon={<IconBack size={20} />} demo="tile-back">
        <Dots scenario={scenario} mode="one" />
      </Tile>
      <Tile href="/borrow/" label="Borrow" icon={<IconBorrow size={20} />} demo="tile-borrow">
        <Bars scenario={scenario} />
      </Tile>
      <Tile href="/lend/" label="Lend" icon={<IconLend size={20} />} demo="tile-lend">
        <Dots scenario={scenario} mode="all" />
      </Tile>
    </div>
  );
}

function Tile({ href, label, icon, children, demo }: { href: string; label: string; icon: ReactNode; children: ReactNode; demo: string }) {
  return (
    <Link
      href={href}
      data-demo={demo}
      className="focus-ring flex h-[92px] min-w-0 flex-col justify-between rounded-[18px] bg-white/95 p-3 text-ink shadow-[0_10px_30px_-18px_rgba(1,4,39,0.9)] transition-transform active:scale-[0.98]"
    >
      <span className="flex items-start justify-between">
        <span className="grid size-8 place-items-center rounded-[10px] bg-ink text-white">{icon}</span>
        {children}
      </span>
      <span className="text-[11px] font-bold tracking-[0.08em] uppercase">{label}</span>
    </Link>
  );
}

/**
 * Four dots in grid order. "feared": the worlds picked for a sale are hollow rings (what Protect sells away); "one":
 * a single future lit (what Back buys); "all": every world, softly (what Lend covers).
 */
function Dots({ scenario, mode, mask = 0 }: { scenario: Scenario; mode: "feared" | "one" | "all"; mask?: number }) {
  const order = scenario.worlds.length === 4 ? [0, 2, 1, 3] : [0, 1];
  return (
    <span aria-hidden="true" className="grid grid-cols-2 gap-[3px]">
      {order.map((i) => {
        const w = scenario.worlds[i];
        if (!w) return null;
        const hue = hueOf(i, w.possible);
        const hollow = mode === "feared" && (mask & w.mask) !== 0;
        const dim = mode === "one" ? i !== 0 : mode === "all";
        return (
          <span
            key={i}
            className="size-[7px] rounded-full"
            style={{
              background: hollow ? "transparent" : hue,
              boxShadow: hollow ? "inset 0 0 0 1.5px #0A0F1F" : undefined,
              opacity: dim ? (mode === "all" ? 0.6 : 0.22) : 1,
            }}
          />
        );
      })}
    </span>
  );
}

function Bars({ scenario }: { scenario: Scenario }) {
  const heights = [10, 7, 9, 5];
  return (
    <span aria-hidden="true" className="flex items-end gap-[2px]">
      {scenario.worlds.map((w, i) => (
        <span key={w.mask} className="w-[4px] rounded-[1px]" style={{ height: heights[i] ?? 6, background: hueOf(i, w.possible) }} />
      ))}
    </span>
  );
}

/** "Possible futures" list rows; the resolved ones below, greyed. */
export function FuturesList({ scenario, quotes, demo = "futures-list" }: { scenario: Scenario; quotes?: readonly CellQuote[]; demo?: string }) {
  const live = scenario.worlds.filter((w) => w.possible);
  const dead = scenario.worlds.filter((w) => !w.possible);
  return (
    <section className="flex flex-col gap-2" data-demo={demo}>
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-[20px] font-medium text-ink">Possible futures</h2>
        <Link href={`/world/?w=${live[0]?.index ?? 0}`} className="focus-ring rounded-full px-2 py-1 text-[13px] text-mute hover:text-ink">
          View all
        </Link>
      </div>
      <SectionLabel>Possible</SectionLabel>
      <ul className="flex flex-col">
        {live.map((w) => (
          <FutureRow key={w.mask} world={w} oddsKnown={scenario.oddsKnown} quote={quotes?.[w.index]} />
        ))}
      </ul>
      {dead.length > 0 && (
        <>
          <SectionLabel className="mt-2">Resolved away</SectionLabel>
          <ul className="flex flex-col">
            {dead.map((w) => (
              <FutureRow key={w.mask} world={w} oddsKnown={scenario.oddsKnown} quote={quotes?.[w.index]} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function FutureRow({ world, oddsKnown, quote }: { world: World; oddsKnown: boolean; quote?: CellQuote }) {
  const held = world.userUsdc + world.collateralUsdc;
  const heldWeth = world.userWeth + world.collateralWeth;
  const right =
    held > 0n
      ? `you: ${fmt(held)} USDC`
      : heldWeth > 0n
        ? `you: ${fmtWeth(heldWeth)} WETH`
        : quote?.bid !== undefined
          ? `best bid ${wholeUsd(quote.bid)}`
          : quote
            ? "no bids"
            : "";
  return (
    <li>
      <Link
        href={`/world/?w=${world.index}`}
        data-demo="future-row"
        data-world={world.label}
        className="focus-ring -mx-2 flex min-h-[64px] items-center gap-3 rounded-[16px] px-2 py-2.5 hover:bg-tile"
      >
        <WorldGlyph world={world} />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[14px] font-semibold ${world.possible ? "text-ink" : "text-faint line-through"}`}>
            {spaced(world.label)}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-mute">
            <span className="num">odds {oddsKnown && world.possible ? pct(world.odds, ONE) : "—"}</span>
            {world.possible && (
              <>
                <span aria-hidden="true">·</span>
                <span className={world.backed ? "text-pos" : "text-neg"}>{world.backed ? "✓ backed" : "✗ unbacked"}</span>
              </>
            )}
          </span>
        </span>
        <span className="flex flex-col items-end text-right">
          <span className={`num text-[14px] font-semibold ${world.possible ? "text-ink" : "text-faint"}`}>
            {world.possible ? (world.poolInitialized ? fmtUsd(world.wethPrice) : "no pool") : "resolved away"}
          </span>
          {right && world.possible && <span className="num text-[12px] text-mute">{right}</span>}
        </span>
        <IconChevronRight size={18} className="shrink-0 text-faint" />
      </Link>
    </li>
  );
}

