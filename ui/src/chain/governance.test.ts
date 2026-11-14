import { describe, expect, it } from "vitest";
import type { EventState, ProposalStatus } from "./domain";
import {
  boardFilter,
  boardStats,
  disputeBlocker,
  eventChip,
  eventStatusLine,
  finalizeBlocker,
  parseGrace,
  pausePlan,
  pledgeBar,
  PROPOSE_CATEGORIES,
  resolutionHistory,
  resolveStats,
  resolveStep,
  roleOf,
  timeLeft,
  windowWords,
} from "./governance";

const WAD = 10n ** 18n;

const event = (o: Partial<EventState> = {}): EventState => ({
  id: 1,
  question: "Will SPICE ship?",
  rule: "r",
  outcomeNames: ["SHIPS", "DELAYED"],
  deadline: 0n,
  proposedAt: 0n,
  proposedOutcome: 0,
  proposalOpen: false,
  finalized: false,
  outcome: 0,
  finalizableAt: 0n,
  proposedBy: null,
  ...o,
});

const prop = (status: ProposalStatus, usdc = 0n, wnear = 0n) => ({ status, pledgedUsdc: usdc * WAD, pledgedWnear: wnear * WAD, sHint: 3n * WAD });

describe("the proposals board", () => {
  const ps = (["review", "pledging", "ready", "waiting", "opened", "rejected", "cancelled", "expired", "void"] as ProposalStatus[]).map((s) => prop(s, 10n));

  it("files each status under one filter, and All keeps every proposal", () => {
    expect(boardFilter(ps, "all")).toHaveLength(9);
    expect(boardFilter(ps, "live").map((p) => p.status)).toEqual(["pledging", "ready", "waiting"]);
    expect(boardFilter(ps, "review").map((p) => p.status)).toEqual(["review"]);
    expect(boardFilter(ps, "opened").map((p) => p.status)).toEqual(["opened"]);
    expect(boardFilter(ps, "closed").map((p) => p.status)).toEqual(["rejected", "cancelled", "expired", "void"]);
  });

  it("counts live proposals (review included) and what is pledged to them, wNEAR at the price hint", () => {
    const s = boardStats([prop("pledging", 100n, 10n), prop("review", 5n), prop("opened", 1_000n), prop("cancelled", 7n)]);
    expect(s).toEqual({ total: 4, live: 2, opened: 1, pledged: 135n * WAD });
  });

  it("draws USDC then wNEAR as shares of the goal, never past a full bar", () => {
    expect(pledgeBar({ pledgedUsdc: 100n * WAD, pledgedWnear: 100n * WAD, sHint: 3n * WAD, goal: 1_000n * WAD })).toEqual({ usdc: 10, wnear: 30 });
    expect(pledgeBar({ pledgedUsdc: 900n * WAD, pledgedWnear: 100n * WAD, sHint: 3n * WAD, goal: 1_000n * WAD })).toEqual({ usdc: 90, wnear: 10 });
    expect(pledgeBar({ pledgedUsdc: 0n, pledgedWnear: 0n, sHint: 3n * WAD, goal: 0n })).toEqual({ usdc: 0, wnear: 0 });
  });

  it("says how long pledging stays open", () => {
    expect(timeLeft(0, 100)).toBeUndefined();
    expect(timeLeft(100 + 3 * 86_400 + 5, 100)).toBe("3 d left");
    expect(timeLeft(100 + 5 * 3_600, 100)).toBe("5 h left");
    expect(timeLeft(100 + 30, 100)).toBe("1 min left");
    expect(timeLeft(50, 100)).toBe("pledging closed");
  });

  it("offers the categories the board names, NEAR ecosystem first", () => {
    expect(PROPOSE_CATEGORIES).toEqual([
      { id: 1, label: "NEAR ecosystem" },
      { id: 2, label: "Macro" },
      { id: 3, label: "Crypto" },
      { id: 0, label: "Other" },
    ]);
  });
});

describe("where an event stands", () => {
  const open = event({ proposalOpen: true, proposedOutcome: 1, finalizableAt: 1_000n, proposedBy: "outlayer", proposedAt: 400n });

  it("walks the four steps", () => {
    expect(resolveStep(event(), 900n)).toBe(0);
    expect(resolveStep(open, 900n)).toBe(2);
    expect(resolveStep(open, undefined)).toBe(2);
    expect(resolveStep(open, 1_000n)).toBe(3);
    expect(resolveStep(event({ finalized: true }), undefined)).toBe(4);
  });

  it("names the state in the chip, with the window's countdown", () => {
    expect(eventChip(event(), 0n)).toEqual({ tone: "open", text: "Open" });
    expect(eventChip(open, 940n)).toEqual({ tone: "live", text: "Proposed Delayed · 1:00" });
    expect(eventChip(open, 1_000n)).toEqual({ tone: "live", text: "Proposed Delayed · window closed" });
    expect(eventChip(event({ finalized: true, outcome: 1 }), 0n)).toEqual({ tone: "final", text: "Final: Delayed" });
  });

  it("says who proposed, and remembers a dispute", () => {
    expect(eventStatusLine(event({ finalized: true, outcome: 0, proposedBy: "reporter" }))).toBe("Resolved Ships by the reporter. Worlds without it are closed for good.");
    expect(eventStatusLine(open)).toMatch(/^Delayed proposed by OutLayer \(TEE\)\./);
    expect(eventStatusLine(event({ proposedAt: 5n, proposedOutcome: 1, proposedBy: "admin" }))).toBe("No result yet. The last proposal (Delayed by the owner) was disputed.");
    expect(eventStatusLine(event())).toBe("No result yet.");
  });

  it("lets anyone finalize only once the chain's own clock has passed the window", () => {
    expect(finalizeBlocker(event(), 0n, 0n)).toBe("No result proposed yet");
    expect(finalizeBlocker(open, undefined, undefined)).toBe("Reading chain time…");
    expect(finalizeBlocker(open, 990n, 990n)).toBe("Finalize in 0:10");
    expect(finalizeBlocker(open, 1_001n, 999n)).toBe("Finalize opens with the next block");
    expect(finalizeBlocker(open, 1_001n, 1_000n)).toBeUndefined();
    expect(finalizeBlocker(event({ finalized: true }), 0n, 0n)).toBe("Already final");
  });

  it("lets the owner dispute only inside the window", () => {
    expect(disputeBlocker(event(), 0n)).toBe("No proposal to dispute");
    expect(disputeBlocker(open, 999n)).toBeUndefined();
    expect(disputeBlocker(open, 1_000n)).toBe("Dispute window over");
  });

  it("lists each final result once, newest first", () => {
    const rows = resolutionHistory([
      event({ id: 3, question: "Fed?", finalized: true, outcome: 1, outcomeNames: ["CUTS", "HOLDS"], proposedAt: 100n, proposedBy: "outlayer" }),
      event({ id: 4, question: "NEAR?", finalized: true, outcome: 0, outcomeNames: ["YES", "NO"], proposedAt: 200n, proposedBy: "reporter" }),
      event({ id: 3, question: "Fed?", finalized: true, outcome: 1, outcomeNames: ["CUTS", "HOLDS"], proposedAt: 100n, proposedBy: "outlayer" }),
      event({ id: 1 }),
    ]);
    expect(rows).toEqual([
      { id: 4, question: "NEAR?", outcome: "Yes", by: "the reporter", atSec: 200 },
      { id: 3, question: "Fed?", outcome: "Holds", by: "OutLayer (TEE)", atSec: 100 },
    ]);
  });

  it("counts distinct events once", () => {
    expect(resolveStats([event({ id: 1 }), event({ id: 1 }), event({ id: 2, finalized: true }), event({ id: 3, proposalOpen: true })])).toEqual({ events: 3, final: 1, proposed: 1 });
  });

  it("reads the dispute window in words", () => {
    expect(windowWords(30)).toBe("30 s");
    expect(windowWords(600)).toBe("10 min");
    expect(windowWords(7_200)).toBe("2 h");
  });
});

describe("the owner console", () => {
  it("knows the owner and the guardian, case aside", () => {
    expect(roleOf("IfVerse-Staging.testnet", "ifverse-staging.testnet", null)).toEqual({ isOwner: true, isGuardian: false });
    expect(roleOf("g.testnet", "o.testnet", "g.testnet")).toEqual({ isOwner: false, isGuardian: true });
    expect(roleOf(null, "o.testnet", "g.testnet")).toEqual({ isOwner: false, isGuardian: false });
  });

  it("splits a selection into flags to pause and flags to unpause", () => {
    expect(pausePlan(["pledge", "trade"], ["trade"])).toEqual({ toPause: ["pledge"], toUnpause: ["trade"] });
    expect(pausePlan([], ["trade"])).toEqual({ toPause: [], toUnpause: [] });
  });

  it("takes a grace of 0 to 86,400 whole seconds", () => {
    expect(parseGrace("1800")).toBe(1800);
    expect(parseGrace(" 0 ")).toBe(0);
    expect(parseGrace("86400")).toBe(86_400);
    expect(parseGrace("86401")).toBeUndefined();
    expect(parseGrace("1.5")).toBeUndefined();
    expect(parseGrace("")).toBeUndefined();
  });
});

describe("the storage balance", () => {
  const NEAR = 10n ** 24n;
  it("tops the free part up to the margin, and keeps the margin when withdrawing", async () => {
    const { STORAGE_MARGIN, storageTopUp, storageToWithdraw } = await import("./governance");
    expect(STORAGE_MARGIN).toBe((2n * NEAR) / 100n);
    expect(storageTopUp(0n)).toBe(STORAGE_MARGIN);
    expect(storageTopUp(undefined)).toBe(STORAGE_MARGIN);
    expect(storageTopUp(NEAR / 100n)).toBe(NEAR / 100n);
    expect(storageTopUp(NEAR)).toBe(0n);
    expect(storageToWithdraw((3n * NEAR) / 10n)).toBe((28n * NEAR) / 100n);
    expect(storageToWithdraw(STORAGE_MARGIN)).toBe(0n);
    expect(storageToWithdraw(STORAGE_MARGIN + NEAR / 10_000n)).toBe(0n);
  });

  it("says a storage refusal in plain words", async () => {
    const { humanError } = await import("./errors");
    expect(humanError("InsufficientStorage(9190000000000000000000, 0)")).toBe(
      "Your storage balance on IfVerse is 0.010 NEAR short for this: add a little NEAR to it and try again",
    );
  });
});
