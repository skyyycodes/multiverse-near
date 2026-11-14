"use client";

import Link from "next/link";
import type { EventState, MarketCard, ProposalSource } from "@/lib/domain";
import { useEventMeta } from "@/lib/hooks/useMarkets";
import { proposalHref } from "@/lib/links";
import { categoryName, isWebSource, letter, shortDate, utcMinute } from "@/lib/market";

const RESOLVED_BY: Readonly<Record<ProposalSource, string>> = { outlayer: "OutLayer (TEE)", reporter: "the reporter", admin: "the admin override" };

/** Each event's precise rule under the market: outcomes, rule, data source, category, deadline and how it resolved. */
export function Rules({ events, onDark }: { events: readonly EventState[]; onDark?: boolean }) {
  return (
    <div className={`flex flex-col gap-4 text-[12px] leading-relaxed ${onDark ? "text-white/60" : "text-mute"}`} data-demo="rules">
      {events.map((e, k) => (
        <EventRule key={e.id} event={e} k={events.length > 1 ? k : undefined} onDark={onDark} />
      ))}
    </div>
  );
}

function EventRule({ event: e, k, onDark }: { event: EventState; k?: number; onDark?: boolean }) {
  const meta = useEventMeta(e.id).data;
  const strong = onDark ? "text-white" : "text-ink";
  const status = e.finalized
    ? `Resolved ${e.outcomeNames[e.outcome]}${e.proposedBy ? ` by ${RESOLVED_BY[e.proposedBy]}` : ""}.`
    : e.proposalOpen
      ? `${e.outcomeNames[e.proposedOutcome]} is proposed and in its dispute window.`
      : undefined;
  return (
    <div className="flex flex-col gap-1" data-event={e.id}>
      <p>
        {k !== undefined && <span className={`label mr-1.5 ${onDark ? "text-white/45" : "text-faint"}`}>{letter(k)}</span>}
        <span className={`font-medium ${strong}`}>{e.question}</span> <span className="num">({e.outcomeNames.join(" / ")})</span>
      </p>
      <p>{e.rule}</p>
      <p className="num">
        {meta?.source ? (
          <>
            Data source:{" "}
            {isWebSource(meta.source) ? (
              <a href={meta.source.trim()} target="_blank" rel="noreferrer" className={`underline-offset-2 hover:underline ${onDark ? "text-sky" : "text-cobalt-ink"}`}>
                {meta.source.trim()}
              </a>
            ) : (
              <span className={strong}>{meta.source}</span>
            )}
            {" · "}
          </>
        ) : null}
        {meta ? `${categoryName(meta.category)} · ` : ""}
        Deadline {utcMinute(Number(e.deadline))}
      </p>
      {status && <p className={strong}>{status}</p>}
    </div>
  );
}

/** A market opened by pledges: which proposal, when, and when its pledgers' seed liquidity unlocks. */
export function SeedInfo({ card, onDark }: { card: MarketCard; onDark?: boolean }) {
  if (card.origin !== "pledged" || card.proposalId === null) return null;
  const unlock = card.seed?.unlockAtSec;
  return (
    <p className={`text-[13px] leading-relaxed ${onDark ? "text-white/70" : "text-mute"}`} data-demo="market-seed">
      Opened from pledges (
      <Link href={proposalHref(card.proposalId)} className={`underline-offset-2 hover:underline ${onDark ? "text-white" : "text-cobalt-ink"}`}>
        proposal #{card.proposalId}
      </Link>
      ){card.createdAtSec > 0 ? ` on ${shortDate(card.createdAtSec)}` : ""}. The pledgers&apos; seed liquidity stays in the pools
      {unlock ? ` until ${shortDate(unlock)}, then it can be withdrawn` : ""}.
    </p>
  );
}
