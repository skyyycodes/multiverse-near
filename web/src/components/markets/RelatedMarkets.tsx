"use client";

import Link from "next/link";
import { Chip } from "@/components/ui/Bits";
import { ProgressBar } from "@/components/ui/Progress";
import { Block } from "@/components/ui/Surface";
import type { MarketCard, ProposalSummary, RelatedMarket } from "@/lib/domain";
import { fmtCompactUsd } from "@/lib/format";
import { useEventTexts, useMarketCards, useRelated } from "@/lib/hooks/useMarkets";
import { marketHref, proposalHref, proposeHref } from "@/lib/links";
import { eventOdds, type EventTexts, oddsPair, STATUS_LABEL, STATUS_TONE } from "@/lib/market";
import { pledgeLine } from "./ProposalCard";

/**
 * Markets that share an event with this one, and live proposals on its events, one group per event (web 6.3); each
 * group ends with a link to propose a new combination with that event. Not shown for an unlisted market.
 */
export function RelatedMarkets({ card }: { card: MarketCard }) {
  const related = useRelated(card.scenarioId, card.listed);
  const markets = related.data?.markets ?? [];
  const proposals = related.data?.proposals ?? [];
  const cards = useMarketCards(markets.map((m) => m.scenarioId).slice(0, 24));
  const ids = [...card.eventIds, ...markets.flatMap((m) => m.eventIds), ...proposals.flatMap((p) => p.eventIds)];
  const texts = useEventTexts(ids).data ?? new Map();
  if (!card.listed) return null;
  const byId = new Map((cards.data ?? []).map((c) => [c.scenarioId, c]));

  return (
    <Block title="Related markets" demo="related-markets">
      <div className="flex flex-col gap-5">
        {card.eventIds.map((e) => {
          const ms = markets.filter((m) => m.eventIds.includes(e));
          const ps = proposals.filter((p) => p.eventIds.includes(e));
          const q = texts.get(e)?.question;
          return (
            <section key={e} className="flex flex-col gap-2" data-event={e}>
              <h3 className="text-[13px] leading-snug text-mute">
                With: <span className="font-medium text-ink">{q ?? `event #${e}`}</span>
              </h3>
              {ms.length === 0 && ps.length === 0 && <p className="text-[13px] text-faint">No other market uses this event yet.</p>}
              {ms.length > 0 && (
                <ul className="flex flex-col">
                  {ms.map((m) => (
                    <RelatedRow key={m.scenarioId} market={m} card={byId.get(m.scenarioId)} shared={e} texts={texts} />
                  ))}
                </ul>
              )}
              {ps.length > 0 && (
                <ul className="flex flex-col gap-2">
                  {ps.map((p) => (
                    <RelatedProposal key={p.proposalId} proposal={p} shared={e} texts={texts} />
                  ))}
                </ul>
              )}
              <Link
                href={proposeHref({ kind: "market", events: [e] })}
                data-demo="combine-event"
                data-event={e}
                className="focus-ring self-start rounded-full py-1 text-[13px] font-medium text-cobalt-ink underline-offset-2 hover:underline"
              >
                + Combine this event with another
              </Link>
            </section>
          );
        })}
      </div>
    </Block>
  );
}

/** The other events of a market, by question ("× Will the Fed cut…"); a single-event market by its own question. */
function otherQuestions(eventIds: readonly number[], shared: number, texts: EventTexts): string {
  const others = eventIds.filter((id) => id !== shared);
  const names = (others.length ? others : eventIds).map((id) => texts.get(id)?.question ?? `event #${id}`);
  return others.length ? `× ${names.join(" × ")}` : names.join(" × ");
}

function RelatedRow({ market: m, card, shared, texts }: { market: RelatedMarket; card?: MarketCard; shared: number; texts: EventTexts }) {
  return (
    <li>
      <Link
        href={marketHref(m.scenarioId)}
        data-demo="related-row"
        data-market={m.scenarioId}
        className="focus-ring -mx-2 flex min-h-[56px] items-center gap-3 rounded-[14px] px-2 py-2 hover:bg-tile"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[14px] text-ink">{otherQuestions(m.eventIds, shared, texts)}</span>
          <span className="num flex flex-wrap gap-x-2 text-[12px] text-mute">
            <span>
              #{m.scenarioId} · {m.worldCount} worlds
            </span>
            {card?.oddsKnown &&
              m.eventIds.map((id, k) => {
                const name = texts.get(id)?.outcomeNames[0];
                return name ? (
                  <span key={id}>
                    {name} {oddsPair(eventOdds(card, k))[0]}
                  </span>
                ) : null;
              })}
            {card && <span>{fmtCompactUsd(card.poolValue)} in pools</span>}
          </span>
        </span>
        <Chip tone={STATUS_TONE[m.status]}>{STATUS_LABEL[m.status]}</Chip>
        <span className="text-[13px] font-semibold text-ink">Open</span>
      </Link>
    </li>
  );
}

function RelatedProposal({ proposal: p, shared, texts }: { proposal: ProposalSummary; shared: number; texts: EventTexts }) {
  return (
    <li>
      <Link
        href={proposalHref(p.proposalId)}
        data-demo="related-proposal"
        data-proposal={p.proposalId}
        className="focus-ring flex flex-col gap-2 rounded-[16px] border border-dashed border-line-strong p-3 hover:border-ink/30"
      >
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
            Proposed: {p.newEvent ? p.newEvent.question : otherQuestions(p.eventIds, shared, texts)}
          </span>
          <span className="shrink-0 rounded-full bg-ink px-3 py-1 text-[12px] font-semibold text-white">Pledge</span>
        </span>
        <ProgressBar valueBps={p.progressBps} label={pledgeLine(p)} />
      </Link>
    </li>
  );
}
