import { describe, expect, it } from "vitest";
import {
  assertSuccess,
  badDebtLine,
  cleanError,
  createdProposalId,
  eventItems,
  eventsOf,
  failureOf,
  liquidationLine,
  liquidationResult,
  openedMarketId,
  payoutFailures,
  pledgeResult,
  pledgeReturnedLine,
  seedWithdrawnLine,
  successValue,
  usedAmount,
  type TxOutcome,
} from "./outcome";

const CONTRACT = "app.multiverse-lending.testnet";
const b64 = (s: string) => Buffer.from(s).toString("base64");

/** An ft_transfer_call the way the RPC reports it: token receipt, ft_on_transfer, ft_resolve_transfer. */
function ftCall(used: string, onTransfer: unknown = { SuccessValue: b64('"0"') }, logs: string[] = []): TxOutcome {
  return {
    status: { SuccessValue: b64(JSON.stringify(used)) },
    transaction: { hash: "7RkrZxguPMJ3Sdgv8aJbFhFsHbUxeLzntrXX98LQ4rTy" },
    receipts_outcome: [
      { outcome: { executor_id: "wnear.multiverse-lending.testnet", status: { SuccessReceiptId: "a" }, logs: [] } },
      { outcome: { executor_id: CONTRACT, status: onTransfer, logs } },
      { outcome: { executor_id: "wnear.multiverse-lending.testnet", status: { SuccessValue: b64(JSON.stringify(used)) }, logs: [] } },
    ],
  };
}

describe("reading a transaction's result", () => {
  it("decodes the used amount ft_transfer_call returns", () => {
    expect(usedAmount(ftCall("2000000000000000000"))).toBe(2n * 10n ** 18n);
    expect(successValue({ status: { SuccessValue: "" } })).toBe("");
    expect(usedAmount({ status: { SuccessValue: "" } })).toBeUndefined();
  });

  it("strips the runtime's prefixes from a panic", () => {
    expect(cleanError("Smart contract panicked: ScenarioHalted(1)")).toBe("ScenarioHalted(1)");
    expect(cleanError('FunctionCallError(ExecutionError("Smart contract panicked: InsufficientOutput(3, 4748, 4800)"))')).toBe(
      "InsufficientOutput(3, 4748, 4800)",
    );
  });

  it("finds the contract's failure even though the transaction ends in SuccessValue", () => {
    const refunded = ftCall("0", { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: StaleOrder(1, 0, 1)" } } } } });
    expect(failureOf(refunded, CONTRACT)).toBe("StaleOrder(1, 0, 1)");
    expect(() => assertSuccess(refunded, { expectUsed: 2n, contractId: CONTRACT })).toThrow("StaleOrder(1, 0, 1)");
  });

  it("treats a short refund as a failed action", () => {
    expect(() => assertSuccess(ftCall("0"), { expectUsed: 5n, contractId: CONTRACT })).toThrow(/refused the transfer/);
    expect(() => assertSuccess(ftCall("3"), { expectUsed: 5n, contractId: CONTRACT })).toThrow(/only part/);
    expect(assertSuccess(ftCall("5"), { expectUsed: 5n, contractId: CONTRACT })).toBe("7RkrZxguPMJ3Sdgv8aJbFhFsHbUxeLzntrXX98LQ4rTy");
    // repay and close may hand some back; they only have to use something
    expect(assertSuccess(ftCall("1"), { expectUsed: "nonzero", contractId: CONTRACT })).toBeTruthy();
    expect(() => assertSuccess(ftCall("0"), { expectUsed: "nonzero", contractId: CONTRACT })).toThrow();
    expect(() => assertSuccess({ ...ftCall("5"), status: { SuccessValue: "" } }, { expectUsed: 5n, contractId: CONTRACT })).toThrow(/Could not read/);
    expect(() => assertSuccess({ ...ftCall("5"), status: { SuccessValue: "bm90IGpzb24=" } }, { expectUsed: "nonzero", contractId: CONTRACT })).toThrow(/Could not read/);
  });

  it("does not blame the action for a payout the token refused afterwards", () => {
    const o: TxOutcome = {
      status: { SuccessValue: "" },
      transaction: { hash: "h" },
      receipts_outcome: [
        { outcome: { executor_id: CONTRACT, status: { SuccessValue: "" }, logs: [] } },
        { outcome: { executor_id: "usdc.multiverse-lending.testnet", status: { Failure: { ActionError: {} } }, logs: [] } },
        {
          outcome: {
            executor_id: CONTRACT,
            status: { SuccessValue: b64("false") },
            logs: ['EVENT_JSON:{"standard":"multiverse","version":"1.0.0","event":"payout_failed","data":[{"account_id":"bob","asset":"usdc"}]}'],
          },
        },
      ],
    };
    expect(failureOf(o, CONTRACT)).toBeUndefined();
    expect(payoutFailures(o)).toHaveLength(1);
  });

  it("parses NEP-297 logs and skips anything else", () => {
    const o = ftCall("1", { SuccessValue: "" }, [
      "plain text",
      'EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_mint","data":[{"owner_id":"alice","token_ids":["1:usdc:8"],"amounts":["5"]}]}',
      'EVENT_JSON:{"standard":"multiverse","version":"1.0.0","event":"conditional_sale","data":[{"account_id":"alice"}]}',
      "EVENT_JSON:{broken",
    ]);
    expect(eventsOf(o).map((e) => e.event)).toEqual(["mt_mint", "conditional_sale"]);
    expect(eventsOf(o, "multiverse")).toHaveLength(1);
  });
});

/** A transaction whose contract receipt logged these NEP-297 lines. */
const logged = (...lines: { event: string; version?: string; data: Record<string, unknown>[] }[]): TxOutcome => ({
  status: { SuccessValue: "" },
  receipts_outcome: [
    {
      outcome: {
        executor_id: CONTRACT,
        status: { SuccessValue: "" },
        logs: lines.map((l) => `EVENT_JSON:${JSON.stringify({ standard: "multiverse", version: l.version ?? "2.0.0", event: l.event, data: l.data })}`),
      },
    },
  ],
});
const E18 = 10n ** 18n;

describe("v2 outcomes (web design 5.3)", () => {
  it("reads v1 and v2 lines, every item of every line, and nothing of another version", () => {
    const o = logged(
      { event: "redeemed", version: "1.0.0", data: [{ amount: "1" }] },
      { event: "redeemed", data: [{ amount: "2" }, { amount: "3" }] },
      { event: "redeemed", version: "3.0.0", data: [{ amount: "4" }] },
    );
    expect(eventItems(o, "redeemed").map((d) => d.amount)).toEqual(["1", "2", "3"]);
  });

  it("finds a new proposal, a pledge and an opening", () => {
    expect(createdProposalId(logged({ event: "proposal_created", data: [{ proposal_id: 5, kind: "market" }] }))).toBe(5);
    expect(createdProposalId(logged())).toBeUndefined();
    expect(pledgeResult(logged({ event: "pledged", data: [{ proposal_id: 3 }] }, { event: "open_scheduled", data: [{ proposal_id: 3 }] }))).toEqual({
      pledged: true,
      openScheduled: true,
      openDeferred: undefined,
    });
    expect(pledgeResult(logged({ event: "open_deferred", data: [{ proposal_id: 3, blocker: "Paused(mint)" }] }))).toEqual({
      pledged: false,
      openScheduled: false,
      openDeferred: "Paused(mint)",
    });
    expect(openedMarketId(logged({ event: "market_opened", data: [{ proposal_id: 3, scenario_id: 7 }] }))).toBe(7);
  });

  it("words a liquidation in cash, in tokens and with bad debt", () => {
    const cash = liquidationResult(
      logged(
        { event: "liquidate", data: [{ repaid: "446411128000000000000", pieces: ["1:wnear:1"], seized: ["5"], seize_all: false, written_off: "0" }] },
        { event: "cash_out", data: [{ cash: "464980000000000000000", left_usdc: ["0", "1"], min_out: "460329761843022353409" }] },
      ),
    )!;
    expect(cash.cash).toEqual({ cash: 464_980_000_000_000_000_000n, leftUsdc: [0n, 1n], minOut: 460_329_761_843_022_353_409n });
    expect(liquidationLine(cash)).toBe("Repaid $446.41; received $464.98 in cash");
    const tokens = liquidationResult(logged({ event: "liquidate", data: [{ repaid: "446411128000000000000", pieces: ["1:wnear:1", "1:usdc:2"], seized: ["5", "0"] }] }))!;
    expect(liquidationLine(tokens, 413_659_000_000_000_000n)).toBe("Repaid $446.41; seized 41.37% of every piece");
    expect(liquidationLine(tokens)).toBe("Repaid $446.41; seized 1 pieces");
    const all = liquidationResult(
      logged(
        { event: "liquidate", data: [{ repaid: s(100n), seize_all: true, written_off: s(20n) }] },
        { event: "bad_debt", data: [{ debt: s(20n), covered: s(15n), socialized: s(5n) }] },
      ),
    )!;
    expect(liquidationLine(all)).toBe("Repaid $100.00; seized every piece; wrote off $20.00 (insurance covered $15.00)");
    expect(liquidationResult(logged())).toBeUndefined();
  });

  it("words a write-off, a returned pledge and a seed withdrawal", () => {
    expect(badDebtLine(logged({ event: "bad_debt", data: [{ debt: s(20n), covered: s(15n), socialized: s(5n) }] }))).toBe("Wrote off $20.00: insurance $15.00, lenders $5.00");
    expect(pledgeReturnedLine(logged({ event: "pledge_returned", data: [{ usdc: s(100n), wnear: s(3n), reason: "refund" }] }))).toBe("Returned 100.00 USDC + 3.00 wNEAR");
    expect(pledgeReturnedLine(logged({ event: "pledge_returned", data: [{ usdc: "0", wnear: "0" }] }))).toBe("Nothing was left to return");
    expect(pledgeReturnedLine(logged())).toBeUndefined();
    expect(seedWithdrawnLine(logged({ event: "seed_withdrawn", data: [{ usdc_out: s(250n), wnear_out: s(10n) }] }))).toBe(
      "Received $250.00 and 10.00 wNEAR; leftover world tokens are in your holdings",
    );
  });
});

function s(x: bigint) {
  return (x * E18).toString();
}
