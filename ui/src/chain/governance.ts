// What the Propose, Proposals, Proposal, Resolve and Admin screens of the redesign show, as pure functions over the
// decoded chain shapes: the board's filters and totals, a proposal's state chip and pledge bar, where an event stands
// in its resolution, when Finalize may be pressed, the resolution history, and the pause plan of the owner console.
// The contract re-checks every rule; these only decide what a screen says and which buttons wait.
import type { Announce } from "./adapter";
import type { EventState, PauseFlag, Pledge, ProposalSource, ProposalStatus, ProposalSummary } from "./domain";
import { countdown, fmt, fmtNear } from "./format";
import { CATEGORY_NAMES, pledgedValue } from "./market";
import { isLive, isTerminal } from "./proposals";

// ---- the proposals board ----

export const BOARD_FILTERS = ["all", "live", "review", "opened", "closed"] as const;
export type BoardFilter = (typeof BOARD_FILTERS)[number];
export const BOARD_LABEL: Record<BoardFilter, string> = {
  all: "All",
  live: "Collecting pledges",
  review: "In review",
  opened: "Opened",
  closed: "Closed",
};

/** Which proposals a filter of the board keeps (lists never say ready or waiting; those count as live). */
export function boardFilter<T extends Pick<ProposalSummary, "status">>(ps: readonly T[], f: BoardFilter): T[] {
  switch (f) {
    case "all":
      return [...ps];
    case "live":
      return ps.filter((p) => isLive(p.status) && p.status !== "review");
    case "review":
      return ps.filter((p) => p.status === "review");
    case "opened":
      return ps.filter((p) => p.status === "opened");
    case "closed":
      return ps.filter((p) => isTerminal(p.status));
  }
}

export type BoardStats = { total: number; live: number; opened: number; pledged: bigint };

/** The board's header: every proposal, the live ones, the opened ones, and what is pledged to live ones (USDC value). */
export function boardStats(ps: readonly Pick<ProposalSummary, "status" | "pledgedUsdc" | "pledgedWnear" | "sHint">[]): BoardStats {
  const live = ps.filter((p) => isLive(p.status));
  return {
    total: ps.length,
    live: live.length,
    opened: ps.filter((p) => p.status === "opened").length,
    pledged: live.reduce((t, p) => t + pledgedValue(p), 0n),
  };
}

/** The look of a status chip (`rs__state--…`): green when it opened or can, amber while it waits, muted once closed. */
export type ChipTone = "open" | "live" | "final" | "off";
export const PROPOSAL_CHIP: Record<ProposalStatus, ChipTone> = {
  review: "live",
  pledging: "open",
  ready: "final",
  waiting: "live",
  opened: "final",
  rejected: "off",
  cancelled: "off",
  expired: "off",
  void: "off",
};

/** "12 d left" while pledges are taken, else nothing. */
export function timeLeft(expiresAtSec: number, nowSec: number): string | undefined {
  if (expiresAtSec <= 0) return undefined;
  const left = expiresAtSec - nowSec;
  if (left <= 0) return "pledging closed";
  if (left < 3_600) return `${Math.max(1, Math.floor(left / 60))} min left`;
  if (left < 86_400) return `${Math.floor(left / 3_600)} h left`;
  return `${Math.floor(left / 86_400)} d left`;
}

/**
 * The two parts of the pledge bar, as percentages of the goal: USDC pledged, then wNEAR at the proposal's NEAR price
 * hint. Clamped so they never draw past a full bar.
 */
export function pledgeBar(p: Pick<ProposalSummary, "pledgedUsdc" | "pledgedWnear" | "sHint" | "goal">): { usdc: number; wnear: number } {
  if (p.goal <= 0n) return { usdc: 0, wnear: 0 };
  const share = (x: bigint) => Number((x * 10_000n) / p.goal) / 100;
  const usdc = Math.min(100, share(p.pledgedUsdc));
  const wnear = Math.min(100 - usdc, share((p.pledgedWnear * p.sHint) / 10n ** 18n));
  return { usdc, wnear };
}

/** The categories a new event can take, in the order the board names them (market.ts), never another numbering. */
export const PROPOSE_CATEGORIES: readonly { id: number; label: string }[] = [1, 2, 3, 0].map((id) => ({ id, label: CATEGORY_NAMES[id] }));

/** How a proposal's transaction is announced in the toasts. */
export const proposalAnnounce = (title: string, pending: string, done: string): Announce => ({ kind: "other", title, pending, done });

/** "10 USDC + 2.50 wNEAR", or "nothing". */
export const pledgeWords = (pl: Pick<Pledge, "usdc" | "wnear">): string =>
  [pl.usdc > 0n ? `${fmt(pl.usdc)} USDC` : "", pl.wnear > 0n ? `${fmtNear(pl.wnear)} wNEAR` : ""].filter(Boolean).join(" + ") || "nothing";

// ---- the storage balance on the contract (NEP-145) ----

/**
 * Proposals and pledges are stored at the caller's expense: the contract charges the bytes to the caller's storage
 * balance and refuses with InsufficientStorage when its free part is short. A screen keeps this much free.
 */
export const STORAGE_MARGIN = 20_000_000_000_000_000_000_000n; // 0.02 NEAR

/** What to add so the free storage balance reaches the margin (0 when it already does). */
export const storageTopUp = (free: bigint | undefined, margin = STORAGE_MARGIN): bigint => (free === undefined ? margin : free >= margin ? 0n : margin - free);

/** The free NEAR worth taking back, keeping the margin for the next proposal or pledge (0 below a thousandth). */
export function storageToWithdraw(free: bigint, margin = STORAGE_MARGIN): bigint {
  const out = free - margin;
  return out >= 1_000_000_000_000_000_000_000n ? out : 0n;
}

// ---- resolution ----

export const RESOLVE_STEPS = ["Open", "Proposed", "Dispute window", "Final"] as const;

/**
 * Where an event stands on the four-step line: 0 open, 2 inside its dispute window, 3 waiting for someone to finalize,
 * 4 final (every step done). Without chain time a proposal reads as inside its window.
 */
export function resolveStep(e: Pick<EventState, "finalized" | "proposalOpen" | "finalizableAt">, now: bigint | undefined): number {
  if (e.finalized) return RESOLVE_STEPS.length;
  if (!e.proposalOpen) return 0;
  return now !== undefined && now >= e.finalizableAt ? 3 : 2;
}

/** Who named a result, in words. */
export const SOURCE_WORDS: Record<ProposalSource, string> = { reporter: "the reporter", admin: "the owner", outlayer: "OutLayer (TEE)" };

const nice = (s: string | undefined) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : "");

/** The event's state chip: "Final: Holds", "Proposed Cuts · 4:59", "Window closed", or "Open". */
export function eventChip(e: Pick<EventState, "finalized" | "outcome" | "proposalOpen" | "proposedOutcome" | "finalizableAt" | "outcomeNames">, now: bigint | undefined): { tone: ChipTone; text: string } {
  if (e.finalized) return { tone: "final", text: `Final: ${nice(e.outcomeNames[e.outcome])}` };
  if (e.proposalOpen) {
    const left = now === undefined ? undefined : e.finalizableAt - now;
    const tail = left === undefined ? "" : left > 0n ? ` · ${countdown(left)}` : " · window closed";
    return { tone: "live", text: `Proposed ${nice(e.outcomeNames[e.proposedOutcome])}${tail}` };
  }
  return { tone: "open", text: "Open" };
}

/** One line on where the result stands, for under the timeline. */
export function eventStatusLine(e: Pick<EventState, "finalized" | "outcome" | "proposalOpen" | "proposedOutcome" | "proposedAt" | "proposedBy" | "outcomeNames">, inGrid = true): string {
  const by = e.proposedBy ? ` by ${SOURCE_WORDS[e.proposedBy]}` : "";
  if (e.finalized) return `Resolved ${nice(e.outcomeNames[e.outcome])}${by}.${inGrid ? " Worlds without it are closed for good." : ""}`;
  if (e.proposalOpen) return `${nice(e.outcomeNames[e.proposedOutcome])} proposed${by}. Anyone can dispute it in the window; then anyone can finalize it.`;
  // A disputed proposal keeps its time and outcome in storage, so an open event with a proposal time had one.
  if (e.proposedAt > 0n) return `No result yet. The last proposal (${nice(e.outcomeNames[e.proposedOutcome])}${by}) was disputed.`;
  return "No result yet.";
}

/**
 * Why Finalize waits, or undefined when it may be sent: anyone may finalize once the window has passed by the chain's
 * own clock (the last block seen, not the ticking estimate).
 */
export function finalizeBlocker(e: Pick<EventState, "proposalOpen" | "finalizableAt" | "finalized">, now: bigint | undefined, blockTime: bigint | undefined): string | undefined {
  if (e.finalized) return "Already final";
  if (!e.proposalOpen) return "No result proposed yet";
  if (now === undefined || blockTime === undefined) return "Reading chain time…";
  if (now < e.finalizableAt) return `Finalize in ${countdown(e.finalizableAt - now)}`;
  if (blockTime < e.finalizableAt) return "Finalize opens with the next block";
  return undefined;
}

/** Why the owner's dispute waits, or undefined: only an open proposal, only inside its window. */
export function disputeBlocker(e: Pick<EventState, "proposalOpen" | "finalizableAt">, now: bigint | undefined): string | undefined {
  if (!e.proposalOpen) return "No proposal to dispute";
  if (now === undefined) return "Reading chain time…";
  if (now >= e.finalizableAt) return "Dispute window over";
  return undefined;
}

export type HistoryRow = { id: number; question: string; outcome: string; by: string; atSec: number };

/** Every finalized event once, newest result first: what the chain decided, by whom and when it was proposed. */
export function resolutionHistory(events: readonly EventState[]): HistoryRow[] {
  const seen = new Map<number, EventState>();
  for (const e of events) if (e.finalized && !seen.has(e.id)) seen.set(e.id, e);
  return [...seen.values()]
    .sort((a, b) => (a.proposedAt === b.proposedAt ? b.id - a.id : a.proposedAt > b.proposedAt ? -1 : 1))
    .map((e) => ({ id: e.id, question: e.question, outcome: nice(e.outcomeNames[e.outcome]), by: e.proposedBy ? SOURCE_WORDS[e.proposedBy] : "", atSec: Number(e.proposedAt) }));
}

/** The resolve board's header: distinct events, how many are final, how many wait in a window. */
export function resolveStats(events: readonly Pick<EventState, "id" | "finalized" | "proposalOpen">[]): { events: number; final: number; proposed: number } {
  const byId = new Map(events.map((e) => [e.id, e]));
  const all = [...byId.values()];
  return { events: all.length, final: all.filter((e) => e.finalized).length, proposed: all.filter((e) => e.proposalOpen).length };
}

/** Seconds as the dispute window reads: "10 min", "30 s", "2 h". */
export function windowWords(sec: number): string {
  if (sec < 60) return `${sec} s`;
  if (sec < 3_600) return `${Math.round(sec / 60)} min`;
  return `${Math.round(sec / 3_600)} h`;
}

// ---- the owner console ----

/** Who the wallet is to the contract. */
export function roleOf(account: string | null | undefined, ownerId: string | undefined, guardianId: string | null | undefined): { isOwner: boolean; isGuardian: boolean } {
  const a = account?.toLowerCase();
  return { isOwner: Boolean(a && ownerId && a === ownerId.toLowerCase()), isGuardian: Boolean(a && guardianId && a === guardianId.toLowerCase()) };
}

/** The flags a selection would pause (running ones) and unpause (paused ones). */
export function pausePlan(selected: readonly PauseFlag[], paused: readonly PauseFlag[]): { toPause: PauseFlag[]; toUnpause: PauseFlag[] } {
  return { toPause: selected.filter((f) => !paused.includes(f)), toUnpause: selected.filter((f) => paused.includes(f)) };
}

export const MAX_REASON_BYTES = 256;
export const MAX_GRACE_SEC = 86_400;

/** The liquidation grace typed in seconds: a whole number from 0 to a day, else undefined. */
export function parseGrace(s: string): number | undefined {
  const t = s.trim();
  if (!/^\d{1,6}$/.test(t)) return undefined;
  const n = Number(t);
  return n <= MAX_GRACE_SEC ? n : undefined;
}
