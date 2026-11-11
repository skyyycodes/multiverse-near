"use client";

import type { ReactNode } from "react";
import type { EventState, ProposalSource } from "@/lib/domain";
import { countdown, utcDate } from "@/lib/format";

const SOURCE: Record<ProposalSource, string> = {
  reporter: "the resolver",
  admin: "the admin override",
  outlayer: "OutLayer (TEE)",
};

type Props = {
  event: EventState;
  /** Chain time, ticking (see useChainClock). */
  now?: bigint;
  /** The dispute window, for the countdown ring. */
  windowSec: number;
  kicker?: string;
  children?: ReactNode;
};

/** One event: question, outcomes, the precise rule, and where its resolution stands. */
export function EventCard({ event: e, now, windowSec, kicker, children }: Props) {
  const left = e.proposalOpen && now !== undefined ? e.finalizableAt - now : undefined;
  return (
    <article className="flex flex-col gap-3.5 rounded-[22px] border border-line bg-sheet p-5" data-demo="event-card" data-event={e.id}>
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {kicker && <div className="label mb-1 text-mute">{kicker}</div>}
          <h3 className="font-display text-[17px] leading-snug font-medium text-ink">{e.question}</h3>
        </div>
        {left !== undefined && left > 0n ? <Ring left={left} total={BigInt(Math.max(1, windowSec))} /> : <Badge event={e} />}
      </header>
      {left !== undefined && left > 0n && (
        <div>
          <Badge event={e} />
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {e.outcomeNames.map((name, i) => (
          <span key={name} className={`num rounded-full border px-3 py-1 text-[12px] font-medium tracking-[0.06em] ${chipTone(e, i)}`}>
            {name}
          </span>
        ))}
      </div>
      <p className="text-[12px] leading-relaxed text-mute">{e.rule}</p>
      <StatusLine event={e} now={now} />
      {children}
    </article>
  );
}

function chipTone(e: EventState, i: number): string {
  if (e.finalized) return i === e.outcome ? "border-pos/40 bg-pos-bright/12 text-pos" : "border-line text-mute line-through";
  if (e.proposalOpen && i === e.proposedOutcome) return "border-warn/40 bg-warn-bright/15 text-warn";
  return "border-line-strong text-ink";
}

function Badge({ event: e }: { event: EventState }) {
  const [text, tone] = e.finalized
    ? [`Resolved: ${e.outcomeNames[e.outcome]}`, "bg-pos-bright/12 text-pos"]
    : e.proposalOpen
      ? [`Proposed: ${e.outcomeNames[e.proposedOutcome]}`, "bg-warn-bright/18 text-warn"]
      : ["Open", "bg-tile text-mute"];
  return (
    <span className={`num inline-flex shrink-0 rounded-full px-3 py-1 text-[12px] font-medium whitespace-nowrap ${tone}`} data-demo="event-badge">
      {text}
    </span>
  );
}

/** Time left in the dispute window as a closing ring with m:ss inside. */
function Ring({ left, total }: { left: bigint; total: bigint }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, Number(left) / Number(total)));
  return (
    <div className="relative grid size-14 shrink-0 place-items-center" role="timer" aria-label={`Dispute window: ${countdown(left)} left`} data-demo="dispute-ring">
      <svg width="56" height="56" viewBox="0 0 56 56" className="-rotate-90" aria-hidden="true">
        <circle cx="28" cy="28" r={r} fill="none" stroke="var(--color-line)" strokeWidth="4" />
        <circle
          cx="28"
          cy="28"
          r={r}
          fill="none"
          stroke="var(--color-warn-bright)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          style={{ transition: "stroke-dashoffset 1s linear" }}
        />
      </svg>
      <span className="num absolute text-[12px] font-medium text-ink">{countdown(left)}</span>
    </div>
  );
}

function StatusLine({ event: e, now }: { event: EventState; now?: bigint }) {
  const by = e.proposedBy ? ` by ${SOURCE[e.proposedBy]}` : "";
  if (e.finalized) {
    return (
      <p className="text-[13px] text-ink" data-demo="event-status">
        Resolved <span className="font-semibold">{e.outcomeNames[e.outcome]}</span>
        {by}. Worlds without it are gone for good.
      </p>
    );
  }
  if (e.proposalOpen) {
    const left = now === undefined ? undefined : e.finalizableAt - now;
    return (
      <p className="text-[13px] text-ink" data-demo="event-status">
        <span className="font-semibold">{e.outcomeNames[e.proposedOutcome]}</span> proposed{by}.{" "}
        {left === undefined ? (
          "Reading chain time…"
        ) : left > 0n ? (
          <>
            Dispute window: <span className="num font-semibold text-warn">{countdown(left)}</span> left.
          </>
        ) : (
          "The dispute window is over: anyone can finalize it."
        )}
      </p>
    );
  }
  // A disputed proposal leaves its time and outcome in storage, so an open event with a proposal time had one.
  const disputed = e.proposedAt > 0n;
  return (
    <p className="text-[13px] text-mute" data-demo="event-status">
      No result yet. Deadline <span className="num">{utcDate(e.deadline)}</span>.
      {disputed && ` The last proposal (${e.outcomeNames[e.proposedOutcome]}${e.proposedBy ? `,${by}` : ""}) was disputed.`}
    </p>
  );
}
