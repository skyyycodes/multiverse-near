import { describe, expect, it } from "vitest";
import { assertSuccess, cleanError, eventsOf, failureOf, payoutFailures, successValue, usedAmount, type TxOutcome } from "./outcome";

const CONTRACT = "app.multiverse-lending.testnet";
const b64 = (s: string) => Buffer.from(s).toString("base64");

/** An ft_transfer_call the way the RPC reports it: token receipt, ft_on_transfer, ft_resolve_transfer. */
function ftCall(used: string, onTransfer: unknown = { SuccessValue: b64('"0"') }, logs: string[] = []): TxOutcome {
  return {
    status: { SuccessValue: b64(JSON.stringify(used)) },
    transaction: { hash: "7RkrZxguPMJ3Sdgv8aJbFhFsHbUxeLzntrXX98LQ4rTy" },
    receipts_outcome: [
      { outcome: { executor_id: "weth.multiverse-lending.testnet", status: { SuccessReceiptId: "a" }, logs: [] } },
      { outcome: { executor_id: CONTRACT, status: onTransfer, logs } },
      { outcome: { executor_id: "weth.multiverse-lending.testnet", status: { SuccessValue: b64(JSON.stringify(used)) }, logs: [] } },
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
