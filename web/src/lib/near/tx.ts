// Transactions the app asks the wallet to sign. Real tokens move with ft_transfer_call and a JSON `msg` naming the
// action (the contract's ft_on_transfer runs it and refunds what it did not use), so there is no approval step.
// Everything else is a direct call with 1 yoctoNEAR attached, the NEAR convention for value-moving methods.
import type { WorldPlan } from "../orders";
import { minOutOf } from "../orders";
import type { Side } from "../orders";
import type { Asset } from "../types";

export const ONE_YOCTO = "1";
/** Worst case is a four-world sale that fills five orders per world; 300 Tgas is the per-transaction maximum. */
export const GAS_FT_CALL = "300000000000000";
/** Direct calls that may pay out (borrow, redeem, close) schedule an ft_transfer plus its callback. */
export const GAS_CALL = "150000000000000";
export const GAS_LIGHT = "30000000000000";

export type FunctionCall = {
  type: "FunctionCall";
  params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
};
export type Tx = { receiverId: string; actions: FunctionCall[] };

export type PlanFill = { order_id: string; amount: string };

export type FtAction =
  | { action: "deposit" }
  | {
      action: "conditional_sell";
      scenario_id: number;
      sell_mask: number;
      plans: PlanFill[][];
      min_out: string[];
      to_lending: boolean;
    }
  | {
      action: "conditional_buy";
      scenario_id: number;
      buy_mask: number;
      plans: PlanFill[][];
      min_out: string[];
      to_lending: boolean;
    }
  | { action: "post_order"; scenario_id: number; mask: number; side: Side; price: string; amount: string; expiry_sec: number }
  | { action: "supply"; scenario_id: number }
  | { action: "repay"; scenario_id: number; all: boolean }
  | { action: "close_after_resolution"; scenario_id: number }
  | { action: "lp_deposit"; scenario_id: number; wnear_amount: string; min_shares: string };

export function call(receiverId: string, methodName: string, args: Record<string, unknown>, deposit = ONE_YOCTO, gas = GAS_CALL): Tx {
  return { receiverId, actions: [{ type: "FunctionCall", params: { methodName, args, gas, deposit } }] };
}

/** `amount` is in the token's own units; the msg is a JSON string inside the JSON args. */
export function ftTransferCall(tokenId: string, receiverId: string, amount: bigint, msg: FtAction): Tx {
  return call(tokenId, "ft_transfer_call", { receiver_id: receiverId, amount: amount.toString(), memo: null, msg: JSON.stringify(msg) }, ONE_YOCTO, GAS_FT_CALL);
}

/** Per-world fills for a sale or buy: one array per world index, empty where nothing is traded. */
export const planFills = (plans: readonly (WorldPlan | undefined)[]): PlanFill[][] =>
  plans.map((p) => (p?.fills ?? []).map((f) => ({ order_id: f.order.id.toString(), amount: f.amount.toString() })));

/** Per-world minimums: the plan less 0.5% of its pool part; "0" where nothing is traded. */
export const planMinOut = (plans: readonly (WorldPlan | undefined)[]): string[] => plans.map((p) => minOutOf(p).toString());

/** One world traded against one order (accepting a bid or an ask), every other world untouched. */
export function singleOrderPlan(worldCount: number, index: number, orderId: bigint, amount: bigint, minOut: bigint) {
  return {
    plans: Array.from({ length: worldCount }, (_, i) => (i === index ? [{ order_id: orderId.toString(), amount: amount.toString() }] : [])),
    min_out: Array.from({ length: worldCount }, (_, i) => (i === index ? minOut.toString() : "0")),
  };
}

export const storageDeposit = (contractId: string, deposit: bigint, registrationOnly: boolean, accountId?: string): Tx =>
  call(contractId, "storage_deposit", { account_id: accountId ?? null, registration_only: registrationOnly }, deposit.toString(), GAS_LIGHT);

export const assetSymbol = (a: Asset) => (a === "wnear" ? "wNEAR" : "USDC");
