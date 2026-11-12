import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEMO_EVENTS } from "./demo.ts";
import { CUTS, HOLDS, NO_RESULT, type FomcOutcome } from "./fred.ts";
import type { DemoRecord, EventView } from "./protocol.ts";
import { parseTarget, resolveOnce, resolverEvents, teamOutcome, type ResolverDeps } from "./resolver.ts";

const DEMO: DemoRecord = {
  spice_event: 7,
  fed_event: 8,
  past_fed_event: 9,
  scenario_2x2: 5,
  scenario_binary: 6,
  implied_spot: "0",
  odds_ships_bps: 6667,
  odds_cuts_bps: 100,
  odds_source: null,
  seeded_at_sec: 0,
  seeded_block: 0,
  spot_from: "2x2",
  ravi_order: null,
};

const TEAM_FILE = { note: "", outcomes: { "fed-december-2026": "HOLDS", "spice-2027": "DELAYED" } };

// The fixture's ids: 7 SPICE, 8 the December Fed meeting, 9 the past one.
const QUESTIONS = new Map([7, 8, 9].map((id, i) => [id, DEMO_EVENTS[i]!.question]));

function event(id: number, names: string[], patch: Partial<EventView> = {}): EventView {
  return {
    id,
    question: QUESTIONS.get(id) ?? "",
    rule: "",
    outcome_names: names,
    deadline_sec: 0,
    proposed_at_sec: 0,
    proposed_outcome: 0,
    proposal_open: false,
    finalized: false,
    outcome: 0,
    finalizable_at_sec: 0,
    proposed_by: null,
    ...patch,
  };
}

interface Fake {
  deps: ResolverDeps;
  reports: [number, number, string][];
  finalized: number[];
  lines: string[];
}

function fake(events: Map<number, EventView>, fomc: FomcOutcome | Error, now = 100, file: unknown = TEAM_FILE): Fake {
  const f: Fake = { reports: [], finalized: [], lines: [], deps: undefined as unknown as ResolverDeps };
  f.deps = {
    getEvent: async (id) => {
      const e = events.get(id);
      if (!e) throw new Error(`no event ${id}`);
      return e;
    },
    nowSec: async () => now,
    fomcOutcome: async () => {
      if (fomc instanceof Error) throw fomc;
      return fomc;
    },
    teamFile: async () => file,
    report: async (id, outcome, evidence) => {
      f.reports.push([id, outcome, evidence]);
      const e = events.get(id);
      if (e) events.set(id, { ...e, proposal_open: true, proposed_outcome: outcome, finalizable_at_sec: now + 30 });
    },
    finalize: async (id) => {
      f.finalized.push(id);
    },
    log: (line) => f.lines.push(line),
  };
  return f;
}

const allOpen = (): Map<number, EventView> =>
  new Map([
    [7, event(7, ["SHIPS", "DELAYED"])],
    [8, event(8, ["CUTS", "HOLDS"])],
    [9, event(9, ["CUTS", "HOLDS"])],
  ]);

describe("resolver", () => {
  it("targets: fomc is the past meeting, team is Fed then SPICE", () => {
    assert.deepEqual(resolverEvents(DEMO, "fomc").map((e) => e.eventId), [9]);
    assert.deepEqual(resolverEvents(DEMO, "team").map((e) => e.eventId), [8, 7]);
    assert.deepEqual(resolverEvents(DEMO, "all").map((e) => e.eventId), [9, 8, 7]);
    assert.deepEqual(resolverEvents({ ...DEMO, past_fed_event: null }, "fomc"), []);
    assert.throws(() => parseTarget("demo"), /fomc, team or all/);
  });

  it("team outcomes: unknown keys and names are no result", () => {
    assert.equal(teamOutcome(TEAM_FILE, "fed-december-2026", ["CUTS", "HOLDS"]), HOLDS);
    assert.equal(teamOutcome(TEAM_FILE, "spice-2027", ["SHIPS", "DELAYED"]), 1);
    assert.equal(teamOutcome(TEAM_FILE, "missing", ["CUTS", "HOLDS"]), NO_RESULT);
    assert.equal(teamOutcome({ outcomes: { k: "MAYBE" } }, "k", ["CUTS", "HOLDS"]), NO_RESULT);
    assert.equal(teamOutcome(null, "k", ["CUTS", "HOLDS"]), NO_RESULT);
    assert.equal(teamOutcome({ outcomes: { k: 0 } }, "k", ["CUTS", "HOLDS"]), NO_RESULT);
  });

  it("proposes every open event from its source", async () => {
    const f = fake(allOpen(), HOLDS);
    const run = await resolveOnce(resolverEvents(DEMO, "all"), f.deps, false);
    assert.deepEqual(f.reports.map(([id, o]) => [id, o]), [[9, HOLDS], [8, HOLDS], [7, 1]]);
    assert.match(f.reports[0]?.[2] ?? "", /^FRED DFEDTARU \+ DFEDTARL, 2026-10-27 vs 2026-10-29: HOLDS$/);
    assert.match(f.reports[2]?.[2] ?? "", /team-controlled outcomes file \(demo\), key spice-2027: DELAYED/);
    assert.deepEqual(run.proposed, [
      { eventId: 9, finalizableAt: 130 },
      { eventId: 8, finalizableAt: 130 },
      { eventId: 7, finalizableAt: 130 },
    ]);
  });

  it("skips finalized events and open proposals, and writes nothing without a result", async () => {
    const events = allOpen();
    events.set(9, event(9, ["CUTS", "HOLDS"], { finalized: true, outcome: HOLDS }));
    events.set(8, event(8, ["CUTS", "HOLDS"], { proposal_open: true, finalizable_at_sec: 120 }));
    const f = fake(events, CUTS, 100, { outcomes: {} });
    const run = await resolveOnce(resolverEvents(DEMO, "all"), f.deps, true);
    assert.deepEqual(f.reports, []);
    assert.deepEqual(f.finalized, []);
    assert.deepEqual(run.proposed, []);
    assert.match(f.lines[0] ?? "", /already resolved \(HOLDS\), skipping/);
    assert.match(f.lines[1] ?? "", /already in its dispute window, skipping \(finalizable at 120\)/);
    assert.match(f.lines[2] ?? "", /no result yet; writing nothing/);
  });

  it("finalizes an open proposal whose window is over, only when asked", async () => {
    const events = allOpen();
    events.set(8, event(8, ["CUTS", "HOLDS"], { proposal_open: true, proposed_outcome: HOLDS, finalizable_at_sec: 90 }));
    const keep = fake(new Map(events), NO_RESULT);
    await resolveOnce(resolverEvents(DEMO, "team").slice(0, 1), keep.deps, false);
    assert.deepEqual(keep.finalized, []);
    const close = fake(new Map(events), NO_RESULT);
    const run = await resolveOnce(resolverEvents(DEMO, "team").slice(0, 1), close.deps, true);
    assert.deepEqual(close.finalized, [8]);
    assert.deepEqual(run.finalized, [8]);
  });

  it("a FRED disagreement writes nothing; a fetch error stops the pass", async () => {
    const f = fake(allOpen(), NO_RESULT);
    await resolveOnce(resolverEvents(DEMO, "fomc"), f.deps, false);
    assert.deepEqual(f.reports, []);
    const broken = fake(allOpen(), new Error("GET answered HTTP 503"));
    await assert.rejects(resolveOnce(resolverEvents(DEMO, "all"), broken.deps, false), /HTTP 503/);
    assert.deepEqual(broken.reports, []);
  });
  it("maps a source's answer by outcome name, so a reordered event cannot flip it", async () => {
    const events = new Map([
      [7, event(7, ["DELAYED", "SHIPS"])],
      [8, event(8, ["HOLDS", "CUTS"])],
      [9, event(9, ["HOLDS", "CUTS"])],
    ]);
    const f = fake(events, CUTS);
    await resolveOnce(resolverEvents(DEMO, "all"), f.deps, false);
    const named = f.reports.map(([id, o]) => [id, events.get(id)!.outcome_names[o]]);
    assert.deepEqual(named, [[9, "CUTS"], [8, "HOLDS"], [7, "DELAYED"]]);
  });

  it("writes nothing for an event that asks another question or lacks the outcome", async () => {
    const events = new Map([
      [7, event(7, ["SHIPS", "DELAYED"], { question: DEMO_EVENTS[1]!.question })],
      [8, event(8, ["YES", "NO"])],
      [9, event(9, ["CUTS", "HOLDS"])],
    ]);
    const f = fake(events, HOLDS);
    await resolveOnce(resolverEvents(DEMO, "all"), f.deps, false);
    assert.deepEqual(f.reports.map(([id, o]) => [id, o]), [[9, HOLDS]]);
    assert.ok(f.lines.some((l) => l.includes("not an outcome of this event")));
    assert.ok(f.lines.some((l) => l.includes("the event on chain asks")));
  });
});
