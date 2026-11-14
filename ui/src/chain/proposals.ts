// What the Propose and Proposal screens show, as pure functions (web design 6.8, 6.9, 7.5-7.8): the stage of a
// proposal, pledge progress, Kind A opening terms, deposits, seed withdrawal minimums and the new-event form checks.
// Everything is bigint or integer bps; the contract re-checks every rule and its word is final.
import type { MarketParams, MarketParamsView, Proposal, ProposalStatus, ProposalSummary, VoidReason } from "./domain";
import { blockerText } from "./errors";
import { fmt, fmtPrice, utcDate, utf8Bytes } from "./format";

const WAD = 10n ** 18n;
const DAY = 86_400;

// ---- stages (6.9) ----

export type Tone = "pos" | "neg" | "warn" | "neutral" | "info";

export const STATUS_LABEL: Record<ProposalStatus, string> = {
  review: "In review",
  pledging: "Collecting pledges",
  ready: "Ready to open",
  waiting: "Goal reached",
  opened: "Open",
  rejected: "Rejected",
  cancelled: "Cancelled",
  expired: "Expired",
  void: "Void",
};

export const STATUS_TONE: Record<ProposalStatus, Tone> = {
  review: "info",
  pledging: "info",
  ready: "pos",
  waiting: "warn",
  opened: "pos",
  rejected: "neg",
  cancelled: "neutral",
  expired: "neutral",
  void: "neutral",
};

export const VOID_REASON: Record<VoidReason, string> = {
  none: "",
  review_timeout: "the admin's check did not come in time",
  event_resolved: "an event resolved before the market opened",
  event_full: "the event has no room for another market",
  market_exists: "this market already exists",
  evicted: "a better-funded proposal took its place",
};

export const TERMINAL: readonly ProposalStatus[] = ["rejected", "cancelled", "expired", "void"];
export const isTerminal = (s: ProposalStatus) => TERMINAL.includes(s);
/** Pledges are taken (and can be withdrawn) until the market opens or the proposal ends. */
export const isLive = (s: ProposalStatus) => s === "review" || s === "pledging" || s === "ready" || s === "waiting";

export type Stage = { title: string; detail?: string; tone: Tone };

/** The stage line of the proposal page: the effective status in words, with the wait-class blocker. */
export function proposalStage(p: Pick<Proposal, "status" | "blocker" | "voidReason" | "opened">, worldLabel?: (w: number) => string): Stage {
  switch (p.status) {
    case "review":
      return { title: "In review by the admin", detail: "Pledges are welcome while the admin checks the question.", tone: "info" };
    case "pledging":
      return { title: "Collecting pledges", tone: "info" };
    case "ready":
      return { title: "Goal reached: ready to open", detail: "Anyone can open it now.", tone: "pos" };
    case "waiting": {
      const why = p.blocker ? (blockerText(p.blocker, { worldLabel }) ?? p.blocker) : "the opening checks";
      return { title: "Goal reached, waiting", detail: why, tone: "warn" };
    }
    case "opened":
      return { title: p.opened ? `Open: market #${p.opened.scenarioId}` : "Open", tone: "pos" };
    case "rejected":
      return { title: "Rejected", detail: "Every pledge can be refunded in full.", tone: "neg" };
    case "cancelled":
      return { title: "Cancelled", detail: "Every pledge can be refunded in full.", tone: "neutral" };
    case "expired":
      return { title: "Expired", detail: "Pledging closed before the market opened. Every pledge can be refunded in full.", tone: "neutral" };
    case "void": {
      const reason = p.voidReason && p.voidReason !== "none" ? VOID_REASON[p.voidReason] : "";
      return { title: reason ? `Void: ${reason}` : "Void", detail: "Every pledge can be refunded in full.", tone: "neutral" };
    }
  }
}

// ---- pledge progress (7.5) ----

/** The auto-open trigger's own value: USDC plus wNEAR at the proposal's NEAR price hint. */
export const pledgeValue = (usdc: bigint, wnear: bigint, sHint: bigint): bigint => usdc + (wnear * sHint) / WAD;

/** Progress in bps as a percentage with one decimal, unclamped ("69.3%", "121%"). */
export function progressPct(bps: number): string {
  const v = Math.max(0, Math.trunc(bps));
  const whole = Math.floor(v / 100);
  const tenth = Math.floor((v % 100) / 10);
  return tenth === 0 ? `${whole}%` : `${whole}.${tenth}%`;
}

export function progressLine(p: Pick<ProposalSummary, "pledgedUsdc" | "pledgedWnear" | "sHint" | "goal" | "progressBps">): string {
  const value = pledgeValue(p.pledgedUsdc, p.pledgedWnear, p.sHint);
  return `${fmt(value, 0)} of ${fmt(p.goal, 0)} USDC (${progressPct(p.progressBps)}; wNEAR counted at ${fmtPrice(p.sHint)})`;
}

/** The title of a proposal in one line: a new event's question, else the combined events (named by the caller). */
export function proposalTitle(p: Pick<ProposalSummary, "proposalId" | "kind" | "newEvent" | "eventIds">, question?: (eventId: number) => string | undefined): string {
  if (p.newEvent) return p.newEvent.question;
  const qs = p.eventIds.map((e) => question?.(e) ?? `Event #${e}`);
  return qs.join(" × ") || `Proposal #${p.proposalId}`;
}

// ---- Kind A opening terms (7.7) ----

/**
 * The normalised multipliers in bps: m_i = raw_i / k with k = q0·raw0 + q1·raw1, so the opening prices S_ref × m_i
 * imply today's price S_ref. Rounded down; 0 when k is 0.
 */
export function normaliseTerms(odds0Bps: number, raw: readonly [number, number]): [number, number] {
  // A field being edited (empty or not a whole percent) has no terms yet; termsProblem names the error.
  if (!Number.isInteger(odds0Bps) || !raw.every(Number.isInteger)) return [0, 0];
  const q0 = BigInt(odds0Bps);
  const q1 = 10_000n - q0;
  const k = q0 * BigInt(raw[0]) + q1 * BigInt(raw[1]);
  if (k <= 0n) return [0, 0];
  const scale = 10_000n * 10_000n;
  return [Number((BigInt(raw[0]) * scale) / k), Number((BigInt(raw[1]) * scale) / k)];
}

/** The contract's `BadTerms` checks in words, or undefined: odds within the clamp, raw and normalised within mult_a. */
export function termsProblem(odds0Bps: number, raw: readonly [number, number], params: Pick<MarketParams, "oddsClampBps" | "multABps">): string | undefined {
  const clamp = params.oddsClampBps;
  if (!Number.isInteger(odds0Bps) || odds0Bps < clamp || odds0Bps > 10_000 - clamp) {
    return `The chance must be between ${clamp / 100}% and ${(10_000 - clamp) / 100}%`;
  }
  const [low, high] = params.multABps;
  const range = `${low / 100}% and ${high / 100}% of today's price`;
  if (raw.some((m) => !Number.isInteger(m) || m < low || m > high)) return `Each NEAR price must be between ${range}`;
  const norm = normaliseTerms(odds0Bps, raw);
  if (norm.some((m) => m < low || m > high)) return `After balancing to today's price, each NEAR price must stay between ${range}`;
  return undefined;
}

// ---- deposits (7.8) ----

/** The opening reserve a market of `worldCount` worlds holds (`reserve_base + W × reserve_per_world`). */
export function reserveFor(worldCount: number, mp: MarketParamsView): bigint {
  if (worldCount === 2) return mp.reserveW2;
  if (worldCount === 4) return mp.reserveW4;
  if (worldCount === 8) return mp.reserveW8;
  return mp.params.reserveBase + BigInt(worldCount) * mp.params.reservePerWorld;
}

/** What a proposal attaches (yocto): its bond plus the reserve; exactly that, no more. */
export function proposalDeposit(kind: "market" | "new_event", worldCount: number, mp: MarketParamsView): { bond: bigint; reserve: bigint; total: bigint } {
  const bond = kind === "market" ? mp.params.bondMarket : mp.params.bondNewEvent;
  const reserve = reserveFor(kind === "market" ? worldCount : 2, mp);
  return { bond, reserve, total: bond + reserve };
}

/** NEAR from yocto with three decimals, rounded up (a deposit is never understated). */
export function nearText(yocto: bigint): string {
  const milli = 10n ** 21n;
  const up = ((yocto + milli - 1n) / milli) * milli;
  return fmt(up / 10n ** 6n, 3);
}

// ---- seed withdrawal minimums (7.6) ----

/** Per world, 99.5% of what the preview says the world gets; "0" for a dead world. */
export function seedMinimums(perWorld: { wnear: readonly bigint[]; usdc: readonly bigint[] }, worldCount: number, possible: number): { wnear: bigint[]; usdc: bigint[] } {
  const min = (xs: readonly bigint[]) =>
    Array.from({ length: worldCount }, (_, w) => (((possible >> w) & 1) === 1 ? ((xs[w] ?? 0n) * 995n) / 1000n : 0n));
  return { wnear: min(perWorld.wnear), usdc: min(perWorld.usdc) };
}

// ---- combinations (6.8) ----

export const MAX_EVENTS = 3;

/** Tapping an event: picks it, unpicks it, or refuses a fourth. */
export function togglePick(picked: readonly number[], id: number, max = MAX_EVENTS): { next: number[]; refused: boolean } {
  if (picked.includes(id)) return { next: picked.filter((x) => x !== id), refused: false };
  if (picked.length >= max) return { next: [...picked], refused: true };
  return { next: [...picked, id], refused: false };
}

/** `events=7,8` → [7, 8]: non-negative integers only, without repeats, at most three. */
export function parseEventsParam(v: string | null): number[] {
  if (!v) return [];
  const ids = v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number)
    .filter((n) => Number.isSafeInteger(n));
  return [...new Set(ids)].slice(0, MAX_EVENTS);
}

/** When the deadlines of combined events differ by more than 30 days, the market narrows after the earlier one. */
export function deadlineSpreadNote(events: readonly { question: string; deadline: bigint }[]): string | undefined {
  if (events.length < 2) return undefined;
  const sorted = [...events].sort((a, b) => (a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (last.deadline - first.deadline <= BigInt(30 * DAY)) return undefined;
  return `From ${utcDate(first.deadline)} this becomes a market on the later ${sorted.length > 2 ? "events" : `event (“${last.question}”)`}: the earlier one will have resolved.`;
}

/** 2^n worlds and 2W − 1 pools for n binary events. */
export const worldsOf = (eventCount: number): number => 2 ** eventCount;

// ---- the new-event form (6.8) ----

export const LIMITS = { question: 280, outcome: 32, rule: 1024, source: 256 } as const;
export const CATEGORIES = ["Economy", "Crypto", "Tech", "Other"] as const;

export type EventForm = {
  question: string;
  outcomes: [string, string];
  rule: string;
  source: string;
  deadlineSec: number | undefined;
  category: number;
  odds0Bps: number;
  multBps: [number, number];
};

export type FormErrors = Partial<Record<"question" | "outcome0" | "outcome1" | "rule" | "source" | "deadline" | "terms", string>>;

/** Each field's problem, mirroring the contract's text, deadline and terms checks; empty when the form can be sent. */
export function eventFormErrors(f: EventForm, nowSec: number, params: Pick<MarketParams, "minPledgeWindowSec" | "minMarketLifeSec" | "oddsClampBps" | "multABps">): FormErrors {
  const e: FormErrors = {};
  // the form sends each text trimmed, so the limits count the trimmed text
  const text = (v: string, max: number, name: string) => (v.trim() === "" ? `Write the ${name}` : utf8Bytes(v.trim()) > max ? `At most ${max} bytes` : undefined);
  e.question = text(f.question, LIMITS.question, "question");
  e.rule = text(f.rule, LIMITS.rule, "rule");
  e.source = text(f.source, LIMITS.source, "data source");
  e.outcome0 = text(f.outcomes[0], LIMITS.outcome, "first outcome");
  e.outcome1 = text(f.outcomes[1], LIMITS.outcome, "second outcome");
  if (!e.outcome0 && f.outcomes[0].includes("·")) e.outcome0 = "No “·” in an outcome name";
  if (!e.outcome1 && f.outcomes[1].includes("·")) e.outcome1 = "No “·” in an outcome name";
  if (!e.outcome0 && !e.outcome1 && f.outcomes[0].trim() === f.outcomes[1].trim()) e.outcome1 = "The two outcomes need different names";
  const earliest = nowSec + params.minPledgeWindowSec + params.minMarketLifeSec;
  if (f.deadlineSec === undefined) e.deadline = "Pick the deadline (UTC)";
  else if (f.deadlineSec < earliest) e.deadline = `At least ${utcDate(earliest)}: the pledge window plus the market's minimum life`;
  e.terms = termsProblem(f.odds0Bps, f.multBps, params);
  for (const k of Object.keys(e) as (keyof FormErrors)[]) if (!e[k]) delete e[k];
  return e;
}

/** Seconds as a short span: "15 min", "2 h", "7 d". */
export function spanWords(sec: number): string {
  if (sec < 60) return `${sec} s`;
  if (sec < 3_600) return `${Math.floor(sec / 60)} min`;
  if (sec < DAY) return `${Math.floor(sec / 3_600)} h`;
  return `${Math.floor(sec / DAY)} d`;
}

// ---- the proposal page (6.9) ----

/** `?p=12` → 12; anything but a non-negative integer → undefined. */
export function parseProposalParam(v: string | null): number | undefined {
  if (!v || !/^\d{1,15}$/.test(v.trim())) return undefined;
  const n = Number(v.trim());
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * World labels of binary events in canonical (ascending id) order, as the contract's `verse_label` names single worlds:
 * world w takes outcome (w >> k) & 1 of event k, the names joined by "·".
 */
export function worldLabels(events: readonly { outcomeNames: readonly string[] }[]): string[] {
  const n = events.length;
  return Array.from({ length: 2 ** n }, (_, w) => events.map((e, k) => e.outcomeNames[(w >> k) & 1] ?? String((w >> k) & 1)).join("·"));
}

/** Which pledge actions the page offers for a status and the viewer's pledge. */
export function pledgeActions(
  status: ProposalStatus,
  pledge: { wnear: bigint; usdc: bigint; state: "pledged" | "refundable" | "seed"; unusedWnear: bigint; unusedUsdc: bigint; unusedPaid: boolean } | null,
): { pledge: boolean; withdraw: boolean; refund: boolean; claim: boolean; seed: boolean } {
  const holds = pledge !== null && (pledge.wnear > 0n || pledge.usdc > 0n);
  const opened = status === "opened";
  return {
    pledge: isLive(status),
    withdraw: isLive(status) && holds,
    refund: isTerminal(status) && holds,
    claim: opened && pledge !== null && !pledge.unusedPaid && (pledge.unusedWnear > 0n || pledge.unusedUsdc > 0n),
    seed: opened && pledge !== null && pledge.state === "seed",
  };
}
