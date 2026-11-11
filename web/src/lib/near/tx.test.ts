import { describe, expect, it } from "vitest";
import type { Order, WorldPlan } from "../orders";
import { call, ftTransferCall, GAS_FT_CALL, ONE_YOCTO, planFills, planMinOut, singleOrderPlan, storageDeposit } from "./tx";

const E18 = 10n ** 18n;

describe("transactions the wallet signs", () => {
  it("sends real tokens with ft_transfer_call: token units outside, a JSON action inside, 1 yocto", () => {
    const tx = ftTransferCall("weth.multiverse-lending.testnet", "app.multiverse-lending.testnet", 2n * E18, {
      action: "conditional_sell",
      scenario_id: 1,
      sell_mask: 14,
      plans: [[], [], [], [{ order_id: "1", amount: E18.toString() }]],
      min_out: ["0", "1", "2", "3"],
      to_lending: true,
    });
    expect(tx.receiverId).toBe("weth.multiverse-lending.testnet");
    const p = tx.actions[0].params;
    expect(p.methodName).toBe("ft_transfer_call");
    expect(p.deposit).toBe(ONE_YOCTO);
    expect(p.gas).toBe(GAS_FT_CALL);
    expect(p.args.receiver_id).toBe("app.multiverse-lending.testnet");
    expect(p.args.amount).toBe("2000000000000000000");
    expect(typeof p.args.msg).toBe("string");
    expect(JSON.parse(p.args.msg as string)).toEqual({
      action: "conditional_sell",
      scenario_id: 1,
      sell_mask: 14,
      plans: [[], [], [], [{ order_id: "1", amount: "1000000000000000000" }]],
      min_out: ["0", "1", "2", "3"],
      to_lending: true,
    });
  });

  it("turns plans into per-world fills and minimums, discounting only the pool part", () => {
    const order = { id: 7n, price: 2450n * E18 } as Order;
    const plan: WorldPlan = { fills: [{ order, amount: E18, out: 2450n * E18 }], poolAmount: E18, poolOut: 2431n * E18, total: 4881n * E18 };
    expect(planFills([undefined, plan])).toEqual([[], [{ order_id: "7", amount: "1000000000000000000" }]]);
    expect(planMinOut([undefined, plan])).toEqual(["0", (4881n * E18 - (2431n * E18 * 50n) / 10_000n).toString()]);
  });

  it("builds one-order plans for accepting a bid or an ask", () => {
    expect(singleOrderPlan(4, 2, 9n, 5n, 3n)).toEqual({
      plans: [[], [], [{ order_id: "9", amount: "5" }], []],
      min_out: ["0", "0", "3", "0"],
    });
  });

  it("registers storage with an attached deposit and calls methods with 1 yocto by default", () => {
    const s = storageDeposit("app.multiverse-lending.testnet", 10n ** 23n, false);
    expect(s.actions[0].params).toMatchObject({ methodName: "storage_deposit", deposit: "100000000000000000000000", args: { account_id: null, registration_only: false } });
    expect(call("x", "borrow", { scenario_id: 1, amount: "1" }).actions[0].params.deposit).toBe("1");
    expect(call("x", "finalize", { event_id: 2 }, "0").actions[0].params.deposit).toBe("0");
  });
});
