"use client";

import Link from "next/link";
import { initials } from "@/components/world/hues";
import { Chip } from "@/components/ui/Bits";
import type { MarketCard as Card } from "@/lib/domain";
import { fmtCompactUsd, fmtUsd } from "@/lib/format";
import { marketHref } from "@/lib/links";
import {
  categoryName,
  eventOdds,
  type EventTexts,
  eventsOf,
  isPossible,
  kindLabel,
  letter,
  oddsPair,
  priceRange,
  shortDate,
  STATUS_LABEL,
  STATUS_TONE,
  survivor,
  worldLabel,
} from "@/lib/market";
import { MiniGrid } from "./MiniGrid";

/** One market of the list: what it asks, the odds, NEAR's price in its worlds, the money in its pools. */
export function MarketCard({ card, texts, last }: { card: Card; texts: EventTexts; last?: boolean }) {
  const events = eventsOf(card.eventIds, texts);
  const single = card.eventIds.length === 1;
  const cats = [...new Set(card.categories)];
  return (
    <Link
      href={marketHref(card.scenarioId)}
      data-demo="market-card"
      data-market={card.scenarioId}
      data-status={card.status}
      className={`focus-ring flex min-w-0 flex-col gap-3 rounded-[22px] border bg-sheet p-4 text-ink shadow-card transition-[box-shadow,border-color] hover:border-ink/30 lg:p-5 ${
        last ? "border-cobalt/50" : "border-line"
      }`}
    >
      <span className="flex flex-wrap items-center gap-1.5">
        <Chip tone="neutral">{kindLabel(card.eventIds.length, card.worldCount)}</Chip>
        {cats.map((c) => (
          <Chip key={c} tone="neutral">
            {categoryName(c)}
          </Chip>
        ))}
        <Chip tone={STATUS_TONE[card.status]}>{STATUS_LABEL[card.status]}</Chip>
        {last && (
          <span data-demo="last-market">
            <Chip tone="info">Last opened</Chip>
          </span>
        )}
        <span className="num ml-auto text-[12px] text-faint">#{card.scenarioId}</span>
      </span>

      {!events ? (
        <span className="flex flex-col gap-1.5" aria-hidden="true">
          <span className="skeleton h-4 w-11/12 rounded" />
          <span className="skeleton h-4 w-2/3 rounded" />
        </span>
      ) : single ? (
        <span className="line-clamp-2 font-display text-[16px] leading-snug font-medium">{events[0].question}</span>
      ) : (
        <span className="flex flex-col gap-1">
          {events.map((e, k) => (
            <span key={k} className="flex min-w-0 gap-2 text-[14px] leading-snug" title={e.question}>
              <span className="label shrink-0 pt-[3px] text-faint">{letter(k)}</span>
              <span className="truncate">{e.question}</span>
            </span>
          ))}
        </span>
      )}

      <CardOdds card={card} texts={texts} />
      <CardPrices card={card} texts={texts} />

      <span className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line pt-3 text-[12px] text-mute">
        <span className="num font-semibold text-ink" data-demo="card-pool">
          {fmtCompactUsd(card.poolValue)} in pools
        </span>
        <span className="num" data-demo="card-deadline">
          {card.deadlineSec > 0 ? `Ends ${shortDate(card.deadlineSec)}` : "No deadline"}
        </span>
        <span className="ml-auto flex flex-wrap gap-1.5">
          {card.lendable ? (
            <Chip tone="pos">Borrowing open</Chip>
          ) : (
            <Chip tone="neutral" title="Pools are below the lending depth; borrowing opens when they deepen">
              Trading only
            </Chip>
          )}
          {card.origin === "pledged" && <Chip tone="info">Opened by pledges</Chip>}
        </span>
      </span>
    </Link>
  );
}

/** Single event: one pill per outcome; a combination: one line per event with outcome 0's odds. */
export function CardOdds({ card, texts }: { card: Card; texts: EventTexts }) {
  const events = eventsOf(card.eventIds, texts);
  if (!events) return null;
  if (!card.oddsKnown) {
    return (
      <span className="text-[13px] text-mute" data-demo="card-odds">
        Odds not known yet
      </span>
    );
  }
  if (events.length === 1) {
    const [a, b] = oddsPair(eventOdds(card, 0));
    const names = events[0].outcomeNames;
    return (
      <span className="flex flex-wrap gap-2" data-demo="card-odds">
        <OddsPill name={names[0]} value={a} />
        <OddsPill name={names[1]} value={b} />
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-0.5 text-[13px]" data-demo="card-odds">
      {events.map((e, k) => (
        <span key={k} className="num flex min-w-0 gap-1.5 text-mute">
          <span className="text-faint">{letter(k)} ·</span>
          <span className="truncate font-semibold text-ink">{e.outcomeNames[0]}</span>
          <span>{oddsPair(eventOdds(card, k))[0]}</span>
        </span>
      ))}
    </span>
  );
}

function OddsPill({ name, value }: { name: string; value: string }) {
  return (
    <span className="num inline-flex min-w-0 items-center gap-1.5 rounded-full bg-tile px-3 py-1.5 text-[13px]">
      <span className="truncate font-semibold text-ink">{name}</span>
      <span className="text-mute">{value}</span>
    </span>
  );
}

/** NEAR's price in each world (single event), or the implied price and the range across worlds (a combination). */
export function CardPrices({ card, texts }: { card: Card; texts: EventTexts }) {
  const events = eventsOf(card.eventIds, texts);
  if (!events) return null;
  const left = survivor(card.possible, card.worldCount);
  if (card.status === "resolved" && left !== undefined) {
    return (
      <span className="text-[13px] text-mute" data-demo="card-prices">
        Resolved: <span className="font-semibold text-ink">{worldLabel(events, left)}</span>
      </span>
    );
  }
  if (events.length === 1) {
    const parts = card.worldPrices
      .map((p, w) => ({ p, w }))
      .filter(({ p, w }) => isPossible(card.possible, w) && p > 0n)
      .map(({ p, w }) => `${fmtUsd(p)} if ${worldLabel(events, w)}`);
    return (
      <span className="num text-[13px] text-mute" data-demo="card-prices">
        {parts.length > 0 ? `NEAR ${parts.join(" · ")}` : "No world prices yet"}
      </span>
    );
  }
  const range = priceRange(card);
  const title = card.worldPrices
    .map((p, w) => (isPossible(card.possible, w) ? `${initials(worldLabel(events, w))} ${p > 0n ? fmtUsd(p) : "—"}` : undefined))
    .filter(Boolean)
    .join(", ");
  return (
    <span className="num flex items-center gap-2.5 text-[13px] text-mute" data-demo="card-prices">
      <MiniGrid worldCount={card.worldCount} possible={card.possible} title={title} />
      <span className="min-w-0">
        {card.impliedSpot > 0n ? `Implied NEAR ${fmtUsd(card.impliedSpot)}` : "Implied NEAR unknown"}
        {range && ` · ${fmtUsd(range.min)} to ${fmtUsd(range.max)} across worlds`}
      </span>
    </span>
  );
}
