"use client";

import Link from "next/link";
import { useState } from "react";
import { IconChevronLeft, IconCopy } from "@/components/brand/Icons";
import { Chip, InfoRows } from "@/components/ui/Bits";
import { Dialog } from "@/components/ui/Dialog";
import type { PriceCheck } from "@/lib/domain";
import { humanError } from "@/lib/errors";
import { fmtPct, fmtPrice, pct, referenceOrigin, relTime } from "@/lib/format";
import { useNowSeconds } from "@/lib/hooks/useClock";
import { useHalted } from "@/lib/hooks/useData";
import { useMarketCard } from "@/lib/hooks/useMarket";
import { useEventTexts, usePriceCheck } from "@/lib/hooks/useMarkets";
import { marketsHref, shareUrl } from "@/lib/links";
import {
  categoryName,
  CHECK_LABEL,
  checkState,
  eventOdds,
  kindLabel,
  letter,
  nextDeadline,
  oddsPair,
  STATUS_LABEL,
  STATUS_TONE,
  statusLine,
  utcMinute,
} from "@/lib/market";
import { MarketTabs } from "./MarketTabs";

const ONE = 10n ** 18n;

/**
 * The top of every market-scoped screen (web 6.3), on the dark hero: back to the list, what the market is, its odds,
 * its next deadline and status, the outside price check, share, and the market's tabs. `compact`: questions on one
 * line, no odds (Borrow, Lend, Resolve, World, the phone forms).
 */
export function MarketHeader({ sid, compact }: { sid: number; compact?: boolean }) {
  const card = useMarketCard(sid).data ?? undefined;
  const texts = useEventTexts(card?.eventIds ?? []);
  const halted = useHalted(sid).data ?? false;
  const now = Number(useNowSeconds());
  const events = card ? card.eventIds.map((id) => texts.data?.get(id)) : [];
  const loaded = card !== undefined && events.every((e) => e !== undefined);
  const evs = loaded ? events.map((e) => e!) : [];
  const deadline = nextDeadline(evs);
  const cats = card ? [...new Set(card.categories)] : [];

  return (
    <div className="flex flex-col gap-4 text-white" data-demo="market-header">
      <Link
        href={marketsHref}
        data-demo="back-markets"
        className="focus-ring -ml-1 inline-flex min-h-10 items-center gap-1 self-start rounded-full pr-3 text-[14px] text-white/75 hover:text-white"
      >
        <IconChevronLeft size={20} />
        All markets
      </Link>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="num mr-1 text-[13px] font-semibold text-white">#{sid}</span>
        {card && (
          <>
            <Chip onDark>{kindLabel(card.eventIds.length, card.worldCount)}</Chip>
            {cats.map((c) => (
              <Chip key={c} onDark>
                {categoryName(c)}
              </Chip>
            ))}
            <Chip onDark tone={STATUS_TONE[card.status]}>
              {STATUS_LABEL[card.status]}
            </Chip>
            {card.lendable ? (
              <Chip onDark tone="pos">
                Borrowing open
              </Chip>
            ) : (
              <Chip onDark title="Pools are below the lending depth; borrowing opens when they deepen">
                Trading only
              </Chip>
            )}
          </>
        )}
        <PriceCheckChip sid={sid} />
        <ShareButton sid={sid} />
      </div>

      {!loaded ? (
        <span className="skeleton-dark h-6 w-3/4 rounded" aria-hidden="true" />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {evs.map((e, k) => {
            const odds = card && card.oddsKnown ? oddsPair(eventOdds(card, k)) : undefined;
            return (
              <li key={k} className="flex min-w-0 flex-col gap-1.5" data-demo="market-odds" data-event={card!.eventIds[k]}>
                <span className={`flex min-w-0 gap-2 ${compact ? "text-[14px]" : "text-[16px] lg:text-[18px]"} leading-snug`} title={e.question}>
                  {evs.length > 1 && <span className="label shrink-0 pt-[3px] text-white/50">{letter(k)}</span>}
                  <span className={compact ? "truncate" : "font-display font-medium"}>{e.question}</span>
                </span>
                {!compact && (
                  <span className="flex flex-wrap gap-1.5 pl-0">
                    {e.outcomeNames.map((name, o) => (
                      <span key={o} className="num inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-[12px]">
                        <span className="font-semibold text-white">{name}</span>
                        <span className="text-white/70">{odds ? odds[o] : "—"}</span>
                      </span>
                    ))}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-col gap-1 text-[12px] text-white/65">
        {loaded && (
          <span className="num" data-demo="market-deadline">
            {deadline !== undefined ? `Ends ${utcMinute(deadline)} · ${deadline > now ? relTime(deadline - now) : "deadline passed"}` : "Every event resolved"}
          </span>
        )}
        {card && loaded && (
          <span className="num" data-demo="scenario-status">
            {statusLine(sid, card.worldCount, evs, halted)}
          </span>
        )}
      </div>

      <MarketTabs sid={sid} />
    </div>
  );
}

/** The outside NEAR/USD check of this market; tapping it explains the numbers. */
function PriceCheckChip({ sid }: { sid: number }) {
  const pc = usePriceCheck(sid).data;
  const [open, setOpen] = useState(false);
  if (!pc) return null;
  const state = checkState(pc);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} data-demo="market-price-check" data-state={state} className="focus-ring rounded-full">
        <Chip onDark tone={state === "on" ? "pos" : state === "blocked" ? "warn" : "neutral"}>{CHECK_LABEL[state]}</Chip>
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Outside price check" demo="price-check-dialog">
        <PriceCheckBody pc={pc} />
      </Dialog>
    </>
  );
}

function gapText(ratio: bigint): string {
  const d = ratio - ONE;
  const abs = d < 0n ? -d : d;
  return `${d < 0n ? "−" : "+"}${pct(abs, ONE, 2)}`;
}

function PriceCheckBody({ pc }: { pc: PriceCheck }) {
  const r = pc.reference;
  if (!pc.config.reference) {
    return (
      <p className="text-[14px] leading-relaxed text-ink">
        This market does not compare its prices with an outside NEAR/USD feed. Its lending relies on its own pools&apos; 30-minute averages.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[14px] leading-relaxed text-mute">
        Lending compares the NEAR price this market implies (its pools&apos; 30-minute averages) with an outside NEAR/USD median. A large gap pauses new
        borrowing and caps how low liquidations may price.
      </p>
      <InfoRows
        rows={[
          { label: "Outside NEAR/USD", value: r ? fmtPrice(r.price) : "none yet" },
          ...(r
            ? [
                { label: "Source", value: referenceOrigin(r) },
                { label: "Age", value: relTime(-r.ageSec) },
              ]
            : []),
          { label: "Implied spot (30-min average)", value: pc.impliedTwapSpot !== null ? fmtPrice(pc.impliedTwapSpot) : "unknown" },
          { label: "Gap", value: pc.ratio !== null ? gapText(pc.ratio) : "—" },
          { label: "Gap allowed", value: fmtPct(pc.config.maxDeviation) },
          { label: "Liquidation haircut at most", value: fmtPct(pc.config.maxHaircut) },
        ]}
      />
      {pc.borrowBlock && <p className="text-[13px] leading-relaxed text-warn">New borrowing is paused: {humanError(pc.borrowBlock)}.</p>}
    </div>
  );
}

/** Share the market's page: the system sheet where there is one, else the link to the clipboard. */
function ShareButton({ sid }: { sid: number }) {
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const url = shareUrl(sid);
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title: `Market #${sid}`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // the share sheet was dismissed or the clipboard refused: nothing to do
    }
  };
  return (
    <button
      type="button"
      onClick={() => void share()}
      data-demo="market-share"
      className="focus-ring ml-auto inline-flex min-h-8 items-center gap-1.5 rounded-full border border-white/20 px-3 text-[12px] font-medium text-white/85 hover:border-white/50 hover:text-white"
    >
      <IconCopy size={14} />
      {copied ? "Link copied" : "Share"}
    </button>
  );
}
