// The reporter's decision logic, kept apart from signing so it can be tested without a chain. The
// order of checks follows the old workflow: skip finalized events, skip events whose proposal is
// still in its dispute window, write nothing when the source has no answer, otherwise propose.

import { NO_RESULT, SOURCE_LABEL, type FomcOutcome } from "./fred.ts";
import type { DemoRecord, EventView } from "./protocol.ts";

export type ResolverTarget = "fomc" | "team" | "all";

export type ResolverEvent =
  | { kind: "fomc"; eventId: number; label: string; before: string; after: string }
  | { kind: "team"; eventId: number; label: string; key: string; outcomes: string[] };

export const TEAM_SOURCE_LABEL = "team-controlled outcomes file (demo)";

export function parseTarget(value: string): ResolverTarget {
  if (value === "fomc" || value === "team" || value === "all") return value;
  throw new Error(`--target must be fomc, team or all, not "${value}"`);
}

/**
 * The events the resolver looks after, from the on-chain demo record: the past FOMC meeting on real
 * FRED data, and the two grid events from the team file (Fed first, then Glamsterdam).
 */
export function resolverEvents(demo: DemoRecord, target: ResolverTarget): ResolverEvent[] {
  const fomc: ResolverEvent[] =
    demo.past_fed_event === null
      ? []
      : [
          {
            kind: "fomc",
            eventId: demo.past_fed_event,
            label: "Did the Fed cut at its October 27-28, 2026 meeting?",
            before: "2026-10-27",
            after: "2026-10-29",
          },
        ];
  const team: ResolverEvent[] = [
    { kind: "team", eventId: demo.fed_event, label: "Fed, December meeting", key: "fed-december-2026", outcomes: ["CUTS", "HOLDS"] },
    { kind: "team", eventId: demo.glam_event, label: "Glamsterdam by Dec 31", key: "glamsterdam-2026", outcomes: ["SHIPS", "DELAYED"] },
  ];
  if (target === "fomc") return fomc;
  if (target === "team") return team;
  return [...fomc, ...team];
}

/** Index of the file's outcome name for `key`, or NO_RESULT when it is missing or not one of `outcomes`. */
export function teamOutcome(file: unknown, key: string, outcomes: readonly string[]): number {
  const all = typeof file === "object" && file !== null && "outcomes" in file ? (file as { outcomes: unknown }).outcomes : undefined;
  const name = typeof all === "object" && all !== null ? (all as Record<string, unknown>)[key] : undefined;
  if (typeof name !== "string") return NO_RESULT;
  return outcomes.indexOf(name);
}

export interface ResolverDeps {
  getEvent(eventId: number): Promise<EventView>;
  nowSec(): Promise<number>;
  fomcOutcome(before: string, after: string): Promise<FomcOutcome>;
  teamFile(): Promise<unknown>;
  report(eventId: number, outcome: number, evidence: string): Promise<void>;
  finalize(eventId: number): Promise<void>;
  log(line: string): void;
}

export interface RunResult {
  /** Events proposed in this run, with the second their window closes. */
  proposed: { eventId: number; finalizableAt: number }[];
  finalized: number[];
}

/**
 * One pass over `events`. With `finalize`, a proposal whose window is over is finalized (anyone
 * may); without it such events are left alone. Errors propagate and stop the pass, like before:
 * the next run retries.
 */
export async function resolveOnce(events: readonly ResolverEvent[], deps: ResolverDeps, finalize: boolean): Promise<RunResult> {
  const result: RunResult = { proposed: [], finalized: [] };
  let teamFile: unknown;
  for (const ev of events) {
    const tag = `event ${ev.eventId} (${ev.label})`;
    const e = await deps.getEvent(ev.eventId);
    if (e.finalized) {
      deps.log(`${tag}: already resolved (${e.outcome_names[e.outcome] ?? e.outcome}), skipping`);
      continue;
    }
    if (e.proposal_open) {
      if (finalize && (await deps.nowSec()) >= e.finalizable_at_sec) {
        await deps.finalize(ev.eventId);
        result.finalized.push(ev.eventId);
        deps.log(`${tag}: finalized ${e.outcome_names[e.proposed_outcome] ?? e.proposed_outcome}`);
      } else {
        deps.log(`${tag}: a result is already in its dispute window, skipping (finalizable at ${e.finalizable_at_sec})`);
      }
      continue;
    }
    let outcome: number;
    let evidence: string;
    if (ev.kind === "fomc") {
      outcome = await deps.fomcOutcome(ev.before, ev.after);
      evidence = `${SOURCE_LABEL}, ${ev.before} vs ${ev.after}`;
    } else {
      teamFile ??= await deps.teamFile();
      outcome = teamOutcome(teamFile, ev.key, ev.outcomes);
      evidence = `${TEAM_SOURCE_LABEL}, key ${ev.key}`;
    }
    if (outcome === NO_RESULT || outcome < 0 || outcome >= e.outcome_names.length) {
      deps.log(`${tag}: sources disagree or have no result yet; writing nothing`);
      continue;
    }
    const name = e.outcome_names[outcome] ?? String(outcome);
    deps.log(`${tag}: source ${ev.kind === "fomc" ? SOURCE_LABEL : TEAM_SOURCE_LABEL} says ${name}`);
    await deps.report(ev.eventId, outcome, `${evidence}: ${name}`);
    const after = await deps.getEvent(ev.eventId);
    result.proposed.push({ eventId: ev.eventId, finalizableAt: after.finalizable_at_sec });
  }
  return result;
}
