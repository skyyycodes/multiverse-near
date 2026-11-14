"use client";

import Link from "next/link";
import { Chip } from "@/components/ui/Bits";
import { ProgressBar } from "@/components/ui/Progress";
import type { ProposalSummary } from "@/lib/domain";
import { fmt, fmtBps, relTime } from "@/lib/format";
import { proposalHref } from "@/lib/links";
import { type EventTexts, eventsOf, letter, pledgedValue } from "@/lib/market";

/** "In review", "Collecting pledges", "Goal reached". */
export function proposalStatusLabel(p: Pick<ProposalSummary, "status" | "progressBps">): string {
  if (p.status === "review") return "In review";
  if (p.progressBps >= 10_000) return "Goal reached";
  return "Collecting pledges";
}

/** "{value} / {goal} USDC pledged · {pct}" (web 7.5). */
export const pledgeLine = (p: ProposalSummary): string => `${fmt(pledgedValue(p), 0)} / ${fmt(p.goal, 0)} USDC pledged · ${fmtBps(Math.floor(p.progressBps))}`;

/** A proposed market collecting pledges: its question(s), progress to the goal, pledgers and time left. */
export function ProposalCard({ proposal: p, texts, nowSec }: { proposal: ProposalSummary; texts: EventTexts; nowSec: number }) {
  const events = p.kind === "market" ? eventsOf(p.eventIds, texts) : undefined;
  const kicker = p.kind === "new_event" ? "Proposed · New event" : `Proposed · Combination · ${p.worldCount} worlds`;
  const left = p.expiresAtSec > 0 ? p.expiresAtSec - nowSec : undefined;
  return (
    <Link
      href={proposalHref(p.proposalId)}
      data-demo="proposal-card"
      data-proposal={p.proposalId}
      data-status={p.status}
      className="focus-ring flex min-w-0 flex-col gap-3 rounded-[22px] border border-dashed border-line-strong bg-sheet p-4 text-ink shadow-card hover:border-ink/30 lg:p-5"
    >
      <span className="flex flex-wrap items-center gap-1.5">
        <Chip tone="neutral">{kicker}</Chip>
        <Chip tone={p.status === "review" ? "warn" : p.progressBps >= 10_000 ? "pos" : "info"}>{proposalStatusLabel(p)}</Chip>
        <span className="num ml-auto text-[12px] text-faint">p{p.proposalId}</span>
      </span>
      {p.newEvent ? (
        <span className="line-clamp-2 font-display text-[16px] leading-snug font-medium">{p.newEvent.question}</span>
      ) : events ? (
        <span className="flex flex-col gap-1">
          {events.map((e, k) => (
            <span key={k} className="flex min-w-0 gap-2 text-[14px] leading-snug" title={e.question}>
              <span className="label shrink-0 pt-[3px] text-faint">{letter(k)}</span>
              <span className="truncate">{e.question}</span>
            </span>
          ))}
        </span>
      ) : (
        <span className="skeleton h-4 w-3/4 rounded" aria-hidden="true" />
      )}
      <ProgressBar valueBps={p.progressBps} label={pledgeLine(p)} demo="pledge-progress" />
      <span className="flex items-center justify-between gap-3 text-[12px] text-mute">
        <span className="num">
          {p.pledgers} {p.pledgers === 1 ? "pledger" : "pledgers"}
          {left !== undefined && ` · ${left > 0 ? `${relTime(left).replace(/^in /, "")} left` : "expired"}`}
        </span>
        <span data-demo="proposal-pledge" className="inline-flex min-h-9 items-center rounded-full bg-ink px-4 text-[13px] font-semibold text-white">
          Pledge
        </span>
      </span>
    </Link>
  );
}
