"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Screen } from "@/components/shell/Screen";
import { ConfigGuard } from "@/components/trade/Guard";
import { Chip, InfoRows, Segmented } from "@/components/ui/Bits";
import { DateTimeField } from "@/components/ui/DateTimeField";
import { ChainWait } from "@/components/ui/Notice";
import { ProgressBar } from "@/components/ui/Progress";
import { Block, Sheet, SheetTitle } from "@/components/ui/Surface";
import { TextArea, TextField } from "@/components/ui/TextField";
import { TxButton } from "@/components/ui/TxButton";
import { CONTRACT_ID } from "@/lib/data/client";
import type { EventState, MarketParamsView } from "@/lib/domain";
import { humanError } from "@/lib/errors";
import { fmt, fmtNear, fmtPrice, utcDate } from "@/lib/format";
import { useNowSeconds } from "@/lib/hooks/useClock";
import { useDebounced } from "@/lib/hooks/useDebounced";
import { useAllMarkets, useEventCheck, useEvents, useMarketCheck, useMarketParams, useProposalList } from "@/lib/hooks/useProposal";
import { useSubmit } from "@/lib/hooks/useTx";
import { marketHref, proposalHref, proposeHref } from "@/lib/links";
import { createdProposalId } from "@/lib/near/outcome";
import { GAS_MAX, proposeEvent, proposeMarket } from "@/lib/near/tx";
import {
  CATEGORIES,
  deadlineSpreadNote,
  eventFormErrors,
  LIMITS,
  nearText,
  normaliseTerms,
  parseEventsParam,
  progressPct,
  proposalDeposit,
  proposalTitle,
  STATUS_LABEL,
  STATUS_TONE,
  togglePick,
  worldsOf,
  type EventForm,
} from "@/lib/proposals";

type Kind = "market" | "event";

/** Propose (web 6.8): combine open events into a new market, or suggest a brand-new event for the admin to check. */
export function ProposeScreen() {
  return <ConfigGuard>{() => <Propose />}</ConfigGuard>;
}

function Propose() {
  const search = useSearchParams();
  const router = useRouter();
  const kind: Kind = search.get("kind") === "event" ? "event" : "market";
  const mp = useMarketParams();
  const initialEvents = useMemo(() => parseEventsParam(search.get("events")), [search]);

  return (
    <Screen
      demo="propose"
      hero={
        <div className="flex flex-col gap-3">
          <span className="label text-white/65">Pledge-funded markets</span>
          <h1 className="font-display text-[34px] leading-[1.05] font-medium tracking-[-0.015em]">Propose a new market</h1>
          <p className="max-w-xl text-[14px] leading-relaxed text-white/75">
            Combine events that already trade into one market, or suggest a brand-new yes/no question. Pledges fund the
            starting liquidity; the market opens when they reach the goal.
          </p>
        </div>
      }
      aside={
        <>
          {mp.data && <Rules mp={mp.data} />}
          <LiveProposals />
        </>
      }
    >
      <Block>
        <Segmented
          options={[
            { value: "market", label: "Combine events", demo: "propose-kind-market" },
            { value: "event", label: "New event", demo: "propose-kind-event" },
          ]}
          value={kind}
          onChange={(k) => router.replace(proposeHref({ kind: k === "event" ? "event" : undefined }), { scroll: false })}
        />
        {!mp.data ? (
          <ChainWait error={mp.error?.message} onRetry={() => void mp.refetch()} />
        ) : kind === "market" ? (
          <ComboForm key={initialEvents.join(",")} mp={mp.data} initial={initialEvents} />
        ) : (
          <NewEventForm mp={mp.data} />
        )}
      </Block>
    </Screen>
  );
}

function Rules({ mp }: { mp: MarketParamsView }) {
  return (
    <Sheet demo="propose-rules">
      <SheetTitle>How proposals work</SheetTitle>
      <p className="text-[13px] leading-relaxed text-mute">
        A proposal costs a refundable bond plus a storage reserve. Pledges are real money locked until the market opens;
        until then every pledger can withdraw everything. When pledges reach the goal the market opens by itself
        (combinations) or after an admin check (new events), and the pledges become its starting liquidity. If the
        proposal expires, is rejected, or an event resolves first, every pledge is refunded in full. The bond comes back
        when the market opens or the proposal ends normally; it is kept only if the proposal expires with less than{" "}
        {mp.params.spamFloorBps / 100}% of its goal pledged.
      </p>
    </Sheet>
  );
}

/** Proposals still taking pledges, newest first, so a visitor can pledge to one instead of proposing again. */
function LiveProposals() {
  const list = useProposalList("live", 12);
  const rows = list.data?.proposals ?? [];
  const ids = rows.flatMap((p) => p.eventIds);
  const events = useEvents(ids);
  const q = (id: number) => events.data?.find((e) => e.id === id)?.question;
  return (
    <Sheet demo="live-proposals">
      <SheetTitle sub="Pledge to one of these instead of proposing it again.">Collecting pledges</SheetTitle>
      {list.isPending ? (
        <ChainWait />
      ) : rows.length === 0 ? (
        <p className="text-[13px] text-mute">No proposal is collecting pledges right now.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((p) => (
            <li key={p.proposalId}>
              <Link href={proposalHref(p.proposalId)} className="focus-ring flex flex-col gap-2 rounded-[16px] border border-line p-3.5 hover:border-ink/30" data-demo="live-proposal" data-proposal={p.proposalId}>
                <span className="flex items-center justify-between gap-2">
                  <span className="num text-[12px] text-mute">
                    #{p.proposalId} · {p.kind === "new_event" ? "new event" : `${p.worldCount} worlds`}
                  </span>
                  <Chip tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Chip>
                </span>
                <span className="text-[14px] leading-snug font-medium text-ink">{proposalTitle(p, q)}</span>
                <ProgressBar valueBps={Math.min(p.progressBps, 10_000)} label={`${progressPct(p.progressBps)} of ${fmt(p.goal, 0)} USDC`} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

// ---- Combine events (Kind B) ----

function ComboForm({ mp, initial }: { mp: MarketParamsView; initial: number[] }) {
  const router = useRouter();
  const submit = useSubmit();
  const markets = useAllMarkets(true);
  const eventIds = useMemo(() => [...new Set((markets.data ?? []).flatMap((m) => m.eventIds))], [markets.data]);
  const events = useEvents(eventIds);
  const [picked, setPicked] = useState<number[]>(initial);
  const [refused, setRefused] = useState(false);
  const check = useMarketCheck(picked);
  const c = check.data && check.data.canonical.join(",") === [...picked].sort((a, b) => a - b).join(",") ? check.data : undefined;

  const candidates = (events.data ?? []).filter((e) => !e.finalized);
  const marketsOf = (id: number) => (markets.data ?? []).filter((m) => m.eventIds.includes(id)).length;
  const pickedEvents = picked.map((id) => (events.data ?? []).find((e) => e.id === id)).filter((e): e is EventState => Boolean(e));
  const spread = deadlineSpreadNote(pickedEvents);
  const W = c?.worldCount ?? worldsOf(picked.length);
  const deposit = c ? c.bond + c.reserve : proposalDeposit("market", W, mp).total;

  const toggle = (id: number) => {
    const r = togglePick(picked, id);
    setRefused(r.refused);
    setPicked(r.next);
  };

  let blocker: string | undefined;
  if (picked.length === 0) blocker = "Pick one to three events";
  else if (!c) blocker = check.isError ? "Could not check this combination" : "Checking…";
  else if (c.listedMarket !== null) blocker = "This market already exists";
  else if (c.liveProposal !== null) blocker = "Already proposed";
  else if (c.blocker) blocker = humanError(c.blocker);

  return (
    <div className="flex flex-col gap-5" data-demo="propose-combo">
      <div className="flex flex-col gap-2">
        <h2 className="font-display text-[20px] font-medium text-ink">Pick 1 to 3 events</h2>
        <p className="text-[13px] leading-relaxed text-mute">Order does not matter: A × B and B × A are the same market. Each event doubles the worlds.</p>
      </div>
      {events.isPending && eventIds.length > 0 ? (
        <ChainWait />
      ) : markets.isError || events.isError ? (
        <ChainWait error={(markets.error ?? events.error)?.message} onRetry={() => void markets.refetch()} />
      ) : candidates.length === 0 ? (
        <p className="text-[13px] text-mute">No open event to combine yet.</p>
      ) : (
        <ul className="flex flex-col gap-2" data-demo="propose-events">
          {candidates.map((e) => {
            const on = picked.includes(e.id);
            return (
              <li key={e.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  data-demo="propose-event"
                  data-event={e.id}
                  onClick={() => toggle(e.id)}
                  className={`focus-ring flex w-full flex-col gap-1.5 rounded-[16px] border p-3.5 text-left transition-colors ${on ? "border-ink bg-ink text-white" : "border-line-strong bg-sheet text-ink hover:border-ink/40"}`}
                >
                  <span className="text-[14px] leading-snug font-medium">{e.question}</span>
                  <span className={`num text-[12px] ${on ? "text-white/75" : "text-mute"}`}>
                    {e.outcomeNames.join(" / ")} · deadline {utcDate(e.deadline)} · in {marketsOf(e.id)} {marketsOf(e.id) === 1 ? "market" : "markets"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {refused && <p className="text-[13px] text-neg">Up to 3 events</p>}

      {picked.length > 0 && (
        <div className="flex flex-col gap-3" data-demo="propose-check">
          {c?.listedMarket != null && (
            <p className="text-[14px] text-ink">
              This market already exists: #{c.listedMarket}.{" "}
              <Link href={marketHref(c.listedMarket)} className="font-medium text-cobalt-ink underline-offset-2 hover:underline">
                Open it
              </Link>
            </p>
          )}
          {c?.liveProposal != null && (
            <p className="text-[14px] text-ink">
              Already proposed: #{c.liveProposal}.{" "}
              <Link href={proposalHref(c.liveProposal)} className="font-medium text-cobalt-ink underline-offset-2 hover:underline">
                Pledge to it instead
              </Link>
            </p>
          )}
          {c?.blocker && <p className="text-[13px] text-neg">{humanError(c.blocker)}</p>}
          {pickedEvents.length > 1 && (
            <ul className="flex flex-col gap-1 text-[12px] text-mute" data-demo="propose-deadlines">
              {pickedEvents.map((e) => (
                <li key={e.id} className="num">
                  Event #{e.id}: deadline {utcDate(e.deadline)}
                </li>
              ))}
              {spread && <li className="text-warn">{spread}</li>}
            </ul>
          )}
          {c && (
            <InfoRows
              rows={[
                { label: "Worlds · pools", value: `${c.worldCount} worlds · ${2 * c.worldCount - 1} pools`, demo: "propose-worlds" },
                { label: "Pledge goal", value: `${fmt(c.goal, 0)} USDC`, demo: "propose-goal" },
                { label: "Best mix", value: `≈ ${fmtNear(c.idealWnear)} wNEAR + ${fmt(c.idealUsdc, 0)} USDC` },
                { label: "You attach now", value: `${nearText(deposit)} NEAR`, demo: "propose-cost" },
                { label: "Pledging closes", value: utcDate(c.expiresAtSec) },
              ]}
            />
          )}
          {c && (
            <p className="text-[12px] leading-relaxed text-mute">
              Bond {nearText(c.bond)} NEAR (back when it opens or ends normally) + reserve {nearText(c.reserve)} NEAR (pays the new market&apos;s storage; the
              rest comes back).
            </p>
          )}
        </div>
      )}

      <TxButton
        demo="propose-confirm"
        action="propose"
        label={picked.length ? `Propose this market · ${nearText(deposit)} NEAR` : "Propose this market"}
        busyLabel="Proposing…"
        blocker={blocker}
        needs={{ contract: true }}
        gas={GAS_MAX}
        deposit={deposit}
        run={async () => {
          let pid: number | undefined;
          const hash = await submit(proposeMarket(CONTRACT_ID, picked, deposit), undefined, (o) => {
            pid = createdProposalId(o);
          });
          if (pid !== undefined) router.push(proposalHref(pid));
          return hash;
        }}
      />
    </div>
  );
}

// ---- New event (Kind A) ----

const DRAFT_KEY = "ifverse.propose.draft";

function blankForm(): EventForm {
  return { question: "", outcomes: ["YES", "NO"], rule: "", source: "", deadlineSec: undefined, category: 0, odds0Bps: 5_000, multBps: [11_000, 9_000] };
}

function loadDraft(): EventForm {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return blankForm();
    const d = JSON.parse(raw) as Partial<EventForm>;
    const base = blankForm();
    return {
      question: typeof d.question === "string" ? d.question : base.question,
      outcomes: Array.isArray(d.outcomes) && d.outcomes.length === 2 ? [String(d.outcomes[0]), String(d.outcomes[1])] : base.outcomes,
      rule: typeof d.rule === "string" ? d.rule : base.rule,
      source: typeof d.source === "string" ? d.source : base.source,
      deadlineSec: typeof d.deadlineSec === "number" ? d.deadlineSec : undefined,
      category: typeof d.category === "number" ? d.category : 0,
      odds0Bps: typeof d.odds0Bps === "number" ? d.odds0Bps : base.odds0Bps,
      multBps: Array.isArray(d.multBps) && d.multBps.length === 2 ? [Number(d.multBps[0]), Number(d.multBps[1])] : base.multBps,
    };
  } catch {
    return blankForm();
  }
}

function saveDraft(f: EventForm | null) {
  try {
    if (f) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(f));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // a blocked storage only loses the draft
  }
}

/** A whole percentage typed by the viewer as bps; NaN stays NaN so the check flags it. */
const pctToBps = (s: string) => (/^\d{1,3}$/.test(s.trim()) ? Number(s.trim()) * 100 : NaN);

function NewEventForm({ mp }: { mp: MarketParamsView }) {
  const router = useRouter();
  const submit = useSubmit();
  const nowSec = Number(useNowSeconds());
  // The form renders only in the browser (behind the config guard), so the draft is read on the first render.
  const [f, setF] = useState<EventForm>(loadDraft);
  const [mult, setMult] = useState<[string, string]>(() => [String(Math.round(f.multBps[0] / 100)), String(Math.round(f.multBps[1] / 100))]);
  useEffect(() => saveDraft(f), [f]);

  const set = (patch: Partial<EventForm>) => setF((x) => ({ ...x, ...patch }));
  const errors = eventFormErrors(f, nowSec, mp.params);
  const earliest = nowSec + mp.params.minPledgeWindowSec + mp.params.minMarketLifeSec;
  const norm = normaliseTerms(f.odds0Bps, f.multBps);
  const o0 = f.outcomes[0].trim() || "outcome 1";
  const o1 = f.outcomes[1].trim() || "outcome 2";

  const checkArgs = useDebounced(
    !errors.question && !errors.deadline && !errors.terms && f.deadlineSec !== undefined
      ? { question: f.question, terms: { odds0Bps: f.odds0Bps, multBps: f.multBps }, deadlineSec: f.deadlineSec }
      : undefined,
    400,
  );
  const check = useEventCheck(checkArgs);
  const ec = check.data;
  const deposit = ec ? ec.bond + ec.reserve : proposalDeposit("new_event", 2, mp).total;
  const bond = ec?.bond ?? mp.params.bondNewEvent;
  const reserve = ec?.reserve ?? mp.reserveW2;

  const firstError = Object.values(errors)[0];
  let blocker = firstError;
  if (!blocker && ec?.liveProposal != null) blocker = "This question is already proposed";
  else if (!blocker && ec?.blocker) blocker = humanError(ec.blocker);

  return (
    <div className="flex flex-col gap-5" data-demo="propose-event-form">
      <TextArea
        label="Question"
        rows={2}
        value={f.question}
        onChange={(v) => set({ question: v })}
        maxBytes={LIMITS.question}
        placeholder="Will … happen by … ?"
        demo="propose-question"
        error={f.question ? errors.question : undefined}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="First outcome"
          value={f.outcomes[0]}
          onChange={(v) => set({ outcomes: [v, f.outcomes[1]] })}
          maxBytes={LIMITS.outcome}
          demo="propose-outcome-0"
          error={errors.outcome0}
        />
        <TextField
          label="Second outcome"
          value={f.outcomes[1]}
          onChange={(v) => set({ outcomes: [f.outcomes[0], v] })}
          maxBytes={LIMITS.outcome}
          demo="propose-outcome-1"
          error={errors.outcome1}
        />
      </div>
      <TextArea
        label="Rule"
        rows={6}
        value={f.rule}
        onChange={(v) => set({ rule: v })}
        maxBytes={LIMITS.rule}
        placeholder={`${o0} if … on {source} as of {date} UTC; otherwise ${o1}.`}
        demo="propose-rule"
        error={f.rule ? errors.rule : undefined}
      />
      <TextField
        label="Data source"
        value={f.source}
        onChange={(v) => set({ source: v })}
        maxBytes={LIMITS.source}
        hint="A public URL or a named public dataset"
        demo="propose-source"
        error={f.source ? errors.source : undefined}
      />
      <DateTimeField
        label="Deadline"
        valueSec={f.deadlineSec}
        onChange={(v) => set({ deadlineSec: v })}
        minSec={earliest}
        demo="propose-deadline"
        hint={`At least ${utcDate(earliest)}: the pledge window plus the market's minimum life`}
      />
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-ink">Category</span>
        <Segmented
          size="sm"
          options={CATEGORIES.map((c, i) => ({ value: String(i), label: c, demo: `propose-category-${i}` }))}
          value={String(f.category)}
          onChange={(v) => set({ category: Number(v) })}
        />
      </div>

      <div className="flex flex-col gap-3 rounded-[18px] bg-tile p-4" data-demo="propose-terms">
        <span className="label text-mute">Opening terms</span>
        <label className="flex flex-col gap-1.5">
          <span className="flex items-baseline justify-between text-[13px] text-ink">
            <span>Chance of {o0}</span>
            <span className="num font-semibold">{f.odds0Bps / 100}%</span>
          </span>
          <input
            type="range"
            min={Math.max(1, mp.params.oddsClampBps / 100)}
            max={Math.min(99, 100 - mp.params.oddsClampBps / 100)}
            step={1}
            value={f.odds0Bps / 100}
            onChange={(e) => set({ odds0Bps: Number(e.target.value) * 100 })}
            data-demo="propose-odds"
            className="accent-ink"
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <label key={i} className="flex flex-col gap-1.5 text-[13px] text-ink">
              <span>NEAR if {i === 0 ? o0 : o1} (% of today)</span>
              <span className="flex items-center gap-2 rounded-[14px] border border-line-strong bg-sheet px-3.5 focus-within:border-ink">
                <input
                  value={mult[i]}
                  inputMode="numeric"
                  onChange={(e) => {
                    const next: [string, string] = i === 0 ? [e.target.value, mult[1]] : [mult[0], e.target.value];
                    setMult(next);
                    set({ multBps: [pctToBps(next[0]), pctToBps(next[1])] });
                  }}
                  data-demo={`propose-mult-${i}`}
                  className="num h-11 min-w-0 flex-1 bg-transparent text-[16px] outline-none"
                />
                <span className="text-mute">%</span>
              </span>
            </label>
          ))}
        </div>
        <p className="text-[12px] leading-relaxed text-mute">
          Balanced to today&apos;s price: NEAR {norm[0] / 100}% of today if {o0}, {norm[1] / 100}% if {o1}. Each must stay between{" "}
          {mp.params.multABps[0] / 100}% and {mp.params.multABps[1] / 100}%.
        </p>
        {errors.terms && <p className="text-[12px] text-neg">{errors.terms}</p>}
      </div>

      <div className="flex flex-col gap-2" data-demo="propose-preview">
        {ec && ec.sRef !== null ? (
          <InfoRows
            rows={[
              { label: `Opening NEAR price if ${o0}`, value: fmtPrice(ec.prices[0]) },
              { label: `Opening NEAR price if ${o1}`, value: fmtPrice(ec.prices[1]) },
              { label: "Today's NEAR price", value: fmtPrice(ec.sRef) },
              { label: "Pledge goal", value: `${fmt(ec.goal, 0)} USDC` },
              { label: "Best mix", value: `≈ ${fmtNear(ec.idealWnear)} wNEAR + ${fmt(ec.idealUsdc, 0)} USDC` },
            ]}
          />
        ) : (
          <p className="text-[12px] leading-relaxed text-mute">
            {check.isFetching ? "Pricing the opening…" : "Fill in the question, deadline and terms to see the opening prices and the pledge goal."}
          </p>
        )}
      </div>

      <p className="text-[12px] leading-relaxed text-mute" data-demo="propose-checklist">
        An admin checks three things before pledges can open the market: a clear yes/no answer, a public data source, and
        that nobody can cause the outcome. You can collect pledges while it is reviewed.
      </p>
      <p className="text-[12px] leading-relaxed text-mute" data-demo="propose-cost">
        You attach {nearText(deposit)} NEAR: bond {nearText(bond)} (back at approval) + reserve {nearText(reserve)}.
      </p>

      <TxButton
        demo="propose-confirm"
        action="propose"
        label={`Propose this event · ${nearText(deposit)} NEAR`}
        busyLabel="Proposing…"
        blocker={blocker}
        needs={{ contract: true }}
        gas={GAS_MAX}
        deposit={deposit}
        run={async () => {
          let pid: number | undefined;
          const hash = await submit(
            proposeEvent(
              CONTRACT_ID,
              {
                question: f.question,
                outcomeNames: [f.outcomes[0], f.outcomes[1]],
                rule: f.rule,
                source: f.source,
                deadlineSec: f.deadlineSec!,
                category: f.category,
                terms: { odds0Bps: f.odds0Bps, multBps: f.multBps },
              },
              deposit,
            ),
            undefined,
            (o) => {
              pid = createdProposalId(o);
            },
          );
          saveDraft(null);
          if (pid !== undefined) router.push(proposalHref(pid));
          return hash;
        }}
      />
    </div>
  );
}
