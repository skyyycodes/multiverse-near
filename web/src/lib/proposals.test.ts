import { describe, expect, it } from "vitest";
import type { MarketParamsView } from "./domain";
import {
  deadlineSpreadNote,
  eventFormErrors,
  nearText,
  normaliseTerms,
  parseEventsParam,
  parseProposalParam,
  pledgeActions,
  pledgeValue,
  progressLine,
  progressPct,
  proposalDeposit,
  proposalStage,
  seedMinimums,
  spanWords,
  termsProblem,
  togglePick,
  worldLabels,
  type EventForm,
} from "./proposals";

const E18 = 10n ** 18n;
const NEAR = 10n ** 24n;
const near = (s: string) => {
  const [w, f = ""] = s.split(".");
  return BigInt(w) * NEAR + BigInt((f + "0".repeat(24)).slice(0, 24));
};

/** The testnet MarketParams of web 7.8 (only the fields these functions read are meaningful). */
const params = {
  bondNewEvent: near("0.2"),
  bondMarket: near("0.05"),
  reserveBase: near("0.05"),
  reservePerWorld: near("0.025"),
  oddsClampBps: 100,
  multABps: [5_000, 20_000] as [number, number],
  minPledgeWindowSec: 3 * 86_400,
  minMarketLifeSec: 7 * 86_400,
};
const mp = {
  params,
  reserveW2: near("0.1"),
  reserveW4: near("0.15"),
  reserveW8: near("0.25"),
  storageFund: 0n,
} as unknown as MarketParamsView;

describe("pledge progress (web 7.5)", () => {
  it("counts wNEAR at the price hint, like the auto-open trigger", () => {
    const sHint = 3_037_693_300_000_000_000n; // 3.0376933
    const v = pledgeValue(20_000n * E18, 3_000n * E18, sHint);
    expect(v).toBe(29_113_079_900_000_000_000_000n);
  });

  it("words the bps unclamped with one decimal", () => {
    expect(progressPct(6_931)).toBe("69.3%");
    expect(progressPct(12_100)).toBe("121%");
    expect(progressPct(0)).toBe("0%");
  });

  it("says value of goal and the price wNEAR is counted at", () => {
    const line = progressLine({ pledgedUsdc: 20_000n * E18, pledgedWnear: 3_000n * E18, sHint: 3_037_693_300_000_000_000n, goal: 42_000n * E18, progressBps: 6_931 });
    expect(line).toBe("29,113 of 42,000 USDC (69.3%; wNEAR counted at $3.0376)");
  });
});

describe("Kind A terms (web 7.7)", () => {
  it("keeps terms that already imply today's price", () => {
    expect(normaliseTerms(4_000, [11_500, 9_000])).toEqual([11_500, 9_000]);
  });

  it("scales terms so the implied price is today's", () => {
    expect(normaliseTerms(5_000, [15_000, 10_000])).toEqual([12_000, 8_000]);
  });

  it("has no terms while a price field is empty, instead of throwing", () => {
    expect(normaliseTerms(5_000, [Number.NaN, 9_000])).toEqual([0, 0]);
    expect(termsProblem(5_000, [Number.NaN, 9_000], params)).toMatch(/Each NEAR price/);
  });

  it("refuses odds outside the clamp and multipliers outside mult_a", () => {
    expect(termsProblem(50, [10_000, 10_000], params)).toMatch(/between 1% and 99%/);
    expect(termsProblem(5_000, [25_000, 10_000], params)).toMatch(/between 50% and 200%/);
    // raw within range, normalised out of range: 99% YES at 200% / 50% → k ≈ 1.985 → NO at ≈ 25%
    expect(termsProblem(9_900, [20_000, 5_000], params)).toMatch(/After balancing/);
    expect(termsProblem(4_000, [11_500, 9_000], params)).toBeUndefined();
  });
});

describe("deposits (web 7.8)", () => {
  it("attaches bond plus reserve for each kind", () => {
    expect(proposalDeposit("market", 2, mp).total).toBe(near("0.15"));
    expect(proposalDeposit("market", 4, mp).total).toBe(near("0.2"));
    expect(proposalDeposit("market", 8, mp).total).toBe(near("0.3"));
    expect(proposalDeposit("new_event", 2, mp)).toEqual({ bond: near("0.2"), reserve: near("0.1"), total: near("0.3") });
  });

  it("shows NEAR rounded up to 0.001", () => {
    expect(nearText(near("0.15"))).toBe("0.150");
    expect(nearText(near("0.1500001"))).toBe("0.151");
  });
});

describe("seed withdrawal minimums (web 7.6)", () => {
  it("takes 99.5% per live world and 0 for a dead one", () => {
    const m = seedMinimums({ wnear: [100n * E18, 102_500_000_000_000_000_000n], usdc: [10n * E18, 10n * E18] }, 2, 0b11);
    expect(m.wnear).toEqual([99_500_000_000_000_000_000n, 101_987_500_000_000_000_000n]);
    const dead = seedMinimums({ wnear: [100n * E18, 100n * E18], usdc: [1n, 1n] }, 2, 0b10);
    expect(dead.wnear[0]).toBe(0n);
    expect(dead.usdc).toEqual([0n, 0n]);
  });
});

describe("combinations", () => {
  it("picks up to three events and refuses a fourth", () => {
    expect(togglePick([1, 2], 3)).toEqual({ next: [1, 2, 3], refused: false });
    expect(togglePick([1, 2, 3], 4)).toEqual({ next: [1, 2, 3], refused: true });
    expect(togglePick([1, 2, 3], 2)).toEqual({ next: [1, 3], refused: false });
  });

  it("reads events= from the URL", () => {
    expect(parseEventsParam("7,8")).toEqual([7, 8]);
    expect(parseEventsParam("7,7,x,9,10")).toEqual([7, 9, 10]);
    expect(parseEventsParam(null)).toEqual([]);
  });

  it("notes a deadline spread over 30 days only", () => {
    const a = { question: "A?", deadline: 1_800_000_000n };
    expect(deadlineSpreadNote([a, { question: "B?", deadline: a.deadline + 10n * 86_400n }])).toBeUndefined();
    expect(deadlineSpreadNote([a, { question: "B?", deadline: a.deadline + 40n * 86_400n }])).toMatch(/^From 2027-01-15 08:00 UTC .*“B\?”/);
  });
});

describe("the new-event form", () => {
  const now = 1_800_000_000;
  const good: EventForm = {
    question: "Will X ship by June?",
    outcomes: ["YES", "NO"],
    rule: "YES if the release is on the public changelog by 2027-06-30 UTC; otherwise NO.",
    source: "https://example.org/changelog",
    deadlineSec: now + 30 * 86_400,
    category: 2,
    odds0Bps: 4_000,
    multBps: [11_500, 9_000],
  };

  it("accepts a complete form", () => {
    expect(eventFormErrors(good, now, params)).toEqual({});
  });

  it("mirrors the contract's checks", () => {
    const e = eventFormErrors(
      { ...good, question: "x".repeat(281), outcomes: ["YES", "YES"], rule: "", deadlineSec: now + 86_400, odds0Bps: 50 },
      now,
      params,
    );
    expect(e.question).toBe("At most 280 bytes");
    expect(e.outcome1).toMatch(/different names/);
    expect(e.rule).toBe("Write the rule");
    expect(e.deadline).toMatch(/^At least/);
    expect(e.terms).toMatch(/chance/);
    expect(eventFormErrors({ ...good, outcomes: ["A·B", "C"] }, now, params).outcome0).toMatch(/·/);
  });

  it("counts bytes, not characters", () => {
    expect(eventFormErrors({ ...good, question: "é".repeat(141) }, now, params).question).toBe("At most 280 bytes");
  });
});

describe("stages (web 6.9)", () => {
  it("names a waiting proposal's blocker in words", () => {
    const s = proposalStage({ status: "waiting", blocker: "NotApproved(3)", voidReason: null, opened: null });
    expect(s).toEqual({ title: "Goal reached, waiting", detail: "Waiting for the admin's check", tone: "warn" });
  });

  it("names the void reason and the opened market", () => {
    expect(proposalStage({ status: "void", blocker: null, voidReason: "event_resolved", opened: null }).title).toBe(
      "Void: an event resolved before the market opened",
    );
    expect(proposalStage({ status: "opened", blocker: null, voidReason: null, opened: { scenarioId: 9, openedAtSec: 0, sRef: 0n, shares: 0n, unlockAtSec: 0 } }).title).toBe(
      "Open: market #9",
    );
  });

  it("words spans", () => {
    expect(spanWords(900)).toBe("15 min");
    expect(spanWords(7_200)).toBe("2 h");
    expect(spanWords(3 * 86_400)).toBe("3 d");
  });
});

describe("the proposal page (web 6.9)", () => {
  it("reads p= from the URL", () => {
    expect(parseProposalParam("12")).toBe(12);
    expect(parseProposalParam(" 0 ")).toBe(0);
    expect(parseProposalParam("-1")).toBeUndefined();
    expect(parseProposalParam("1.5")).toBeUndefined();
    expect(parseProposalParam(null)).toBeUndefined();
  });

  it("labels worlds as the contract does: event k's outcome is bit k of the world", () => {
    expect(worldLabels([{ outcomeNames: ["YES", "NO"] }])).toEqual(["YES", "NO"]);
    expect(worldLabels([{ outcomeNames: ["SHIPS", "DELAYED"] }, { outcomeNames: ["CUTS", "HOLDS"] }])).toEqual([
      "SHIPS·CUTS",
      "DELAYED·CUTS",
      "SHIPS·HOLDS",
      "DELAYED·HOLDS",
    ]);
    expect(worldLabels([{ outcomeNames: ["A", "a"] }, { outcomeNames: ["B", "b"] }, { outcomeNames: ["C", "c"] }])[5]).toBe("a·B·c");
  });

  const pl = { wnear: 0n, usdc: 100n, state: "pledged" as const, unusedWnear: 0n, unusedUsdc: 0n, unusedPaid: false };
  it("offers pledge and withdraw while live, a refund once it ends", () => {
    expect(pledgeActions("pledging", pl)).toEqual({ pledge: true, withdraw: true, refund: false, claim: false, seed: false });
    expect(pledgeActions("review", null)).toEqual({ pledge: true, withdraw: false, refund: false, claim: false, seed: false });
    expect(pledgeActions("expired", { ...pl, state: "refundable" })).toMatchObject({ pledge: false, refund: true });
    expect(pledgeActions("void", { ...pl, usdc: 0n, state: "refundable" }).refund).toBe(false);
  });

  it("offers the unused part once and seed withdrawal after opening", () => {
    const seed = { ...pl, state: "seed" as const, unusedUsdc: 5n };
    expect(pledgeActions("opened", seed)).toMatchObject({ pledge: false, withdraw: false, claim: true, seed: true });
    expect(pledgeActions("opened", { ...seed, unusedPaid: true }).claim).toBe(false);
    expect(pledgeActions("opened", { ...seed, unusedUsdc: 0n }).claim).toBe(false);
  });
});
