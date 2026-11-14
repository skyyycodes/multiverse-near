import { describe, expect, it } from "vitest";
import { blockerText, errorHref, errorLine, humanError, parseContractError } from "./errors";

const E18 = 10n ** 18n;
const ctx = { worldLabel: (w: number) => ["SHIPS·CUTS", "DELAYED·CUTS", "SHIPS·HOLDS", "DELAYED·HOLDS"][w] };

describe("contract errors", () => {
  it("parses a name with and without arguments, nesting kept whole", () => {
    expect(parseContractError("BelowMinLoan(99000000000000000000, 100000000000000000000)")).toEqual({
      name: "BelowMinLoan",
      args: ["99000000000000000000", "100000000000000000000"],
    });
    expect(parseContractError("NoDebt")).toEqual({ name: "NoDebt", args: [] });
    expect(parseContractError("ReferenceUnavailable(5, ImpliedSpotUnknown(5))")).toEqual({ name: "ReferenceUnavailable", args: ["5", "ImpliedSpotUnknown(5)"] });
    expect(parseContractError("The contract refused the transfer and the tokens were refunded.")).toBeUndefined();
  });

  it("words every mapped error", () => {
    const cases: [string, string][] = [
      ["Paused(trade)", "Paused for maintenance: trading"],
      ["Paused(exit)", "Paused for maintenance: withdrawals"],
      ["LiquidationGrace(1800000000)", "Liquidations resume at 2027-01-15 08:00 UTC"],
      [`BelowMinLoan(${99n * E18}, ${100n * E18})`, "The minimum loan is $100.00"],
      [`DustDebtLeft(${50n * E18}, ${100n * E18})`, "That would leave $50.00 owed, under the $100.00 minimum: repay all of it or leave at least $100.00"],
      [`UtilizationCap(${(95n * E18) / 100n}, ${(9n * E18) / 10n})`, "This tier lends at most 90% of its cash; try a smaller amount or another tier"],
      [`BorrowCapExceeded(${10n * E18}, ${5n * E18})`, "This tier's borrowing cap is $5.00"],
      ["MarketFrozen(5, Bold)", "The Bold tier of this market takes no new loans or deposits"],
      ["MarketWipedOut(5, safe)", "The Safe tier lost all its lent cash to bad debt and is closed to deposits"],
      ["ReferenceMissing", "New borrowing waits for a fresh NEAR/USD price"],
      ["ReferenceStale(4000, 3600)", "New borrowing waits for a fresh NEAR/USD price (last one 4000 s old, limit 3600 s)"],
      [`ReferenceDeviation(${37n * E18 / 10n}, ${32n * E18 / 10n})`, "This market prices NEAR at $3.7000, the outside feed at $3.2000: more than 10% apart, so new borrowing waits"],
      ["ImpliedSpotUnknown(5)", "This market's implied NEAR price is not known yet (a pool is too young or thin)"],
      ["ReferenceGuard(1, 2)", "Liquidation waits: the market's prices are more than 10% above the outside feed"],
      [`NotLiquidatable(${(122n * E18) / 100n})`, "Not liquidatable: health factor 1.22"],
      ["PriceUnavailable(3)", "World DELAYED·HOLDS has no price for liquidation yet"],
      [`CashOutBelowMin(${445n * E18}, ${446n * E18})`, "Cash-out would pay $445.00, under your minimum $446.00; nothing happened"],
      ["CashOutUnpricesWorld(1)", "Selling into DELAYED·CUTS would leave it without a valid price; use tokens mode"],
      [`InsufficientRepayment(${446n * E18}, ${447n * E18})`, "The repayment grew to $447.00; try again"],
      ["NoDebt(x.testnet)", "Nothing to write off"],
      [`StillCollateralized(${12n * E18})`, "Still has collateral worth $12.00: liquidate instead"],
      ["TooManyFills(22, 20)", "Too many orders in one trade (22, limit 20); the app re-plans with fewer"],
      ["ProposalExists(4)", "Already proposed: proposal #4"],
      ["MarketExists(1)", "This market already exists: #1"],
      ["EventResolved(3)", "Event #3 has resolved"],
      ["EventDeciding(3)", "Event #3 has a result in its dispute window"],
      ["TooManyScenarios(2)", "Event #2 already has 16 markets"],
      ["TooManyProposals(2)", "16 proposals use event #2"],
      ["NoReferenceMarket(7)", "Event #7 has no reference market to price from"],
      ["DeadlineTooSoon(0, 1800000000)", "The deadline is too soon to collect pledges and trade"],
      ["TooManyActiveProposals(4)", "You have 4 live proposals; wait for one to end"],
      [`PledgeTooSmall(${5n * E18}, ${10n * E18})`, "The smallest pledge is 10.00 USDC"],
      ["TooManyPledges(32)", "You already pledge to 32 proposals"],
      ["ProposalClosed(4, Expired)", "Proposal #4 is expired"],
      ["SeedLocked(1, 1800000000)", "Locked until 2027-01-15 08:00 UTC"],
      [`SeedDepthFloor(2, ${150n * E18})`, "Lenders depend on this pool: withdraw at most 150.00 shares now"],
    ];
    for (const [raw, text] of cases) expect(humanError(raw, ctx), raw).toBe(text);
    expect(humanError(`PledgeTooSmall(${E18}, ${3n * E18})`, { asset: "wnear" })).toBe("The smallest pledge is 3.00 wNEAR");
    expect(humanError("PriceUnavailable(3)")).toBe("World #3 has no price for liquidation yet");
  });

  it("words the wallet's own refusals", () => {
    expect(humanError('{"InvalidTxError":{"NotEnoughBalance":{"signer_id":"a.testnet","balance":"1","cost":"2"}}}')).toBe(
      "Not enough NEAR in your wallet for this transaction's gas",
    );
    expect(humanError("Not enough balance for judge-ui1.ifverse-staging.testnet (balance: 199191738947645300000000, cost: 300920140233601000000001)")).toBe(
      "Not enough NEAR in your wallet for this transaction's gas",
    );
    expect(humanError("LackBalanceForState { account_id: a.testnet, amount: 1 }")).toBe("Not enough NEAR in your wallet to keep its storage after this transaction");
    expect(humanError('{"jsonrpc": "2.0", "error": {"code": -429, "message": "Rate limits exceeded. For higher rate limits get a subscription"}, "id": "1"}')).toBe(
      "The NEAR RPC is busy right now and sent nothing: try again in a few seconds",
    );
  });

  it("words the opening blockers, K3's stale reference included", () => {
    expect(blockerText("NotApproved(2)")).toBe("Waiting for the admin's check");
    expect(blockerText("Paused(mint)")).toBe("Openings are paused for maintenance");
    expect(blockerText("ReferenceStale(4000, 3600)")).toBe("Openings wait for a fresh NEAR/USD price (last one 4000 s old)");
    expect(blockerText("OutrankedForSlot(2, 9)")).toBe("Event #2 has room for fewer markets than funded proposals; #9 has more pledged");
    expect(blockerText(`GoalNotReached(${29_113n * E18}, ${42_000n * E18})`)).toBe("$29,113.00 of $42,000.00 can be put to work; more pledges would help");
    expect(blockerText(`TooThin(1, ${500n * E18}, ${1_000n * E18})`, ctx)).toBe("World DELAYED·CUTS's pool would hold only $500.00; it needs $1,000.00");
    expect(blockerText("OpenStorageShort(150000000000000000000000, 100000000000000000000000)")).toBe("The reserve is 0.050 NEAR short for the new market's storage");
    expect(blockerText("OpenStorageShort(100000000000000000000001, 0)")).toBe("The reserve is 0.101 NEAR short for the new market's storage");
    expect(blockerText("ReferenceUnavailable(5, ImpliedSpotUnknown(5))")).toBe("Market #5 cannot price the opening yet (ImpliedSpotUnknown(5))");
    expect(blockerText("ReferenceUnavailable(9, thin_odds)")).toBe("Market #9 cannot price the opening yet: the pools that set its chances are too thin");
    expect(blockerText("SomethingElse")).toBeUndefined();
    // an action error that is a wait-class blocker reads the same
    expect(humanError("NotApproved(2)")).toBe("Waiting for the admin's check");
  });

  it("passes anything unknown through, raw", () => {
    expect(humanError("SeedCoverage")).toBe("SeedCoverage");
    expect(humanError("The contract used only part of the transfer; the rest was refunded.")).toBe("The contract used only part of the transfer; the rest was refunded.");
    expect(errorLine("LengthMismatch")).toBe("LengthMismatch");
  });

  it("words the order book's, the pools' and storage's refusals", () => {
    expect(humanError("StaleOrder(1, 0, 1)")).toBe("Order #1 went stale after a resolution");
    expect(errorLine("OrderNotOpen(7)")).toBe("Order #7 was filled or cancelled a moment ago; the book has been refreshed (OrderNotOpen(7))");
    expect(humanError(`OrderTooSmall(1, ${10n ** 15n})`)).toBe("An order needs at least 0.001 NEAR");
    expect(humanError("TooManyOpenOrders(64)")).toBe("You have 64 open orders, the most allowed; cancel one first");
    expect(humanError(`TooLittleReceived(${99n * E18}, ${100n * E18})`)).toBe("The pool would pay 99.0000, under your minimum of 100.0000: the price moved, so nothing happened");
    expect(humanError("InsufficientOutput(2, 5, 6)", { worldLabel: (w) => ["A", "B", "C"][w] })).toBe("World C would pay less than the 0.5% the quote allows: the price moved, so nothing happened");
    expect(humanError("InsufficientStorage(3000000000000000000000, 1000000000000000000000)")).toBe("Your storage deposit with IfVerse is 0.002 NEAR short for this; the next try adds to it first");
    // a gap the automatic top-up does not cover (attached deposit, or a free part above the floor)
    expect(humanError(`InsufficientStorage(${3n * 10n ** 23n}, ${5n * 10n ** 22n})`)).toBe("Your storage deposit with IfVerse is 0.250 NEAR short for this: add a little NEAR to it and try again");
    expect(humanError("InsufficientBalance(uma.testnet, 1, 2)")).toBe("You hold less than that in this world now; refresh and try a smaller amount");
    expect(humanError("ScenarioHalted(1)")).toBe("Trading in this market pauses while a result is in its dispute window");
  });

  it("keeps the contract's exact text after the words", () => {
    expect(errorLine(`BelowMinLoan(${99n * E18}, ${100n * E18})`)).toBe(`The minimum loan is $100.00 (BelowMinLoan(${99n * E18}, ${100n * E18}))`);
    expect(errorHref("ProposalExists(4)")).toBe("/proposal/?p=4");
    expect(errorHref("MarketExists(1)")).toBe("/market/?id=1");
    expect(errorHref("NoDebt")).toBeUndefined();
  });
});
