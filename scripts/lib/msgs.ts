// Typed `ft_transfer_call` messages (SPEC-C 3.8). One encoder writes every msg in its declared field
// order, so the bytes are stable (golden tests) and every v1 msg encodes byte for byte as v1 did.
//
// Rules: Normal tier is omitted (the same bytes parse on v1 and v2, and events omit it too);
// `receive` is written only as "cash", which then needs `min_out`; tokens mode never carries
// `min_out`. Nothing v2-only goes to a contract whose state version is below 2 (S-2): a v1 contract
// rejects an unknown msg field with BadMessage, but silently ignores unknown call arguments.

export type Tier = "normal" | "safe" | "bold";
export type Receive = "tokens" | "cash";
export type AssetName = "wnear" | "usdc";

export const TIERS: readonly Tier[] = ["safe", "normal", "bold"];

export interface PlanEntry {
  order_id: string;
  amount: string;
}

export type Msg =
  | { action: "deposit" }
  | { action: "split"; scenario_id: number; to_masks: number[] }
  | { action: "conditional_sell"; scenario_id: number; sell_mask: number; plans: PlanEntry[][]; min_out: string[]; to_lending: boolean; tier?: Tier }
  | { action: "conditional_buy"; scenario_id: number; buy_mask: number; plans: PlanEntry[][]; min_out: string[]; to_lending: boolean; tier?: Tier }
  | { action: "sell_and_borrow"; scenario_id: number; sell_mask: number; plans: PlanEntry[][]; min_out: string[]; borrow_amount: string; tier?: Tier }
  | { action: "post_order"; scenario_id: number; mask: number; side: "bid" | "ask"; price: string; amount: string; expiry_sec: number }
  | { action: "supply"; scenario_id: number; tier?: Tier }
  | { action: "repay"; scenario_id: number; all: boolean; tier?: Tier }
  | { action: "deposit_collateral"; scenario_id: number; tier?: Tier }
  | { action: "liquidate"; scenario_id: number; account_id: string; repay_amount: "max" | string; tier?: Tier; receive?: Receive; min_out?: string }
  | { action: "close_after_resolution"; scenario_id: number; tier?: Tier }
  | { action: "lp_deposit"; scenario_id: number; wnear_amount: string; min_shares: string }
  | { action: "spot_swap"; min_out: string }
  | { action: "fund_insurance"; scenario_id: number; tier?: Tier }
  | { action: "pledge"; proposal_id: number };

export type MsgAction = Msg["action"];

/** v2-only content sent to a v1 contract (S-2): nothing was sent. */
export class V2OnlyOnV1Contract extends Error {
  readonly what: string;
  constructor(what: string) {
    super(`V2OnlyOnV1Contract(${what})`);
    this.name = "V2OnlyOnV1Contract";
    this.what = what;
  }
}

/** A msg the contract would refuse, caught before sending (same names as the contract's errors). */
export class MsgCheckError extends Error {
  constructor(code: "MinOutRequired" | "MinOutWithoutCash" | `BadMsg(${string})`) {
    super(code);
    this.name = "MsgCheckError";
  }
}

const U128 = /^\d+$/;

function checkU128(value: string, field: string): string {
  if (!U128.test(value) || BigInt(value) >= 1n << 128n) throw new MsgCheckError(`BadMsg(${field} is not a U128 string: ${JSON.stringify(value)})`);
  return value;
}

function checkId(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new MsgCheckError(`BadMsg(${field} is not a u64: ${value})`);
  return value;
}

function checkMask(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new MsgCheckError(`BadMsg(${field} is not a u8 mask: ${value})`);
  return value;
}

/** A tier as it goes into a msg or call: omitted when Normal. Throws for a non-Normal tier on v1. */
export function tierField(tier: Tier | undefined, stateVersion: number): { tier?: Tier } {
  if (tier === undefined || tier === "normal") return {};
  if (tier !== "safe" && tier !== "bold") throw new MsgCheckError(`BadMsg(unknown tier ${JSON.stringify(tier)})`);
  if (stateVersion < 2) throw new V2OnlyOnV1Contract(`tier ${tier}`);
  return { tier };
}

/** Call arguments with the tier appended when it is not Normal (SPEC-C 3.1: v1 ignores unknown args). */
export function withTier<T extends Record<string, unknown>>(args: T, tier: Tier | undefined, stateVersion: number): T & { tier?: Tier } {
  return { ...args, ...tierField(tier, stateVersion) };
}

const plansOf = (plans: PlanEntry[][]): PlanEntry[][] =>
  plans.map((world, w) => world.map((p, i) => ({ order_id: checkU128(p.order_id, `plans[${w}][${i}].order_id`), amount: checkU128(p.amount, `plans[${w}][${i}].amount`) })));

/** The msg object with its fields in the declared order, ready for JSON.stringify. */
function ordered(m: Msg, v: number): Record<string, unknown> | null {
  switch (m.action) {
    case "deposit":
      return null;
    case "split":
      return { action: m.action, scenario_id: checkId(m.scenario_id, "scenario_id"), to_masks: m.to_masks.map((x, i) => checkMask(x, `to_masks[${i}]`)) };
    case "conditional_sell":
      return {
        action: m.action,
        scenario_id: checkId(m.scenario_id, "scenario_id"),
        sell_mask: checkMask(m.sell_mask, "sell_mask"),
        plans: plansOf(m.plans),
        min_out: m.min_out.map((x, i) => checkU128(x, `min_out[${i}]`)),
        to_lending: m.to_lending,
        ...(m.to_lending ? tierField(m.tier, v) : {}),
      };
    case "conditional_buy":
      return {
        action: m.action,
        scenario_id: checkId(m.scenario_id, "scenario_id"),
        buy_mask: checkMask(m.buy_mask, "buy_mask"),
        plans: plansOf(m.plans),
        min_out: m.min_out.map((x, i) => checkU128(x, `min_out[${i}]`)),
        to_lending: m.to_lending,
        ...(m.to_lending ? tierField(m.tier, v) : {}),
      };
    case "sell_and_borrow":
      return {
        action: m.action,
        scenario_id: checkId(m.scenario_id, "scenario_id"),
        sell_mask: checkMask(m.sell_mask, "sell_mask"),
        plans: plansOf(m.plans),
        min_out: m.min_out.map((x, i) => checkU128(x, `min_out[${i}]`)),
        borrow_amount: checkU128(m.borrow_amount, "borrow_amount"),
        ...tierField(m.tier, v),
      };
    case "post_order":
      return {
        action: m.action,
        scenario_id: checkId(m.scenario_id, "scenario_id"),
        mask: checkMask(m.mask, "mask"),
        side: m.side,
        price: checkU128(m.price, "price"),
        amount: checkU128(m.amount, "amount"),
        expiry_sec: checkId(m.expiry_sec, "expiry_sec"),
      };
    case "supply":
    case "deposit_collateral":
    case "close_after_resolution":
      return { action: m.action, scenario_id: checkId(m.scenario_id, "scenario_id"), ...tierField(m.tier, v) };
    case "repay":
      return { action: m.action, scenario_id: checkId(m.scenario_id, "scenario_id"), all: m.all, ...tierField(m.tier, v) };
    case "liquidate": {
      const cash = m.receive === "cash";
      if (m.receive !== undefined && m.receive !== "cash" && m.receive !== "tokens") throw new MsgCheckError(`BadMsg(unknown receive ${JSON.stringify(m.receive)})`);
      if (cash && m.min_out === undefined) throw new MsgCheckError("MinOutRequired");
      if (!cash && m.min_out !== undefined) throw new MsgCheckError("MinOutWithoutCash");
      if (cash && v < 2) throw new V2OnlyOnV1Contract("receive cash");
      const repay = m.repay_amount === "max" ? "max" : checkU128(m.repay_amount, "repay_amount");
      return {
        action: m.action,
        scenario_id: checkId(m.scenario_id, "scenario_id"),
        account_id: m.account_id,
        repay_amount: repay,
        ...tierField(m.tier, v),
        ...(cash ? { receive: "cash", min_out: checkU128(m.min_out ?? "", "min_out") } : {}),
      };
    }
    case "lp_deposit":
      return {
        action: m.action,
        scenario_id: checkId(m.scenario_id, "scenario_id"),
        wnear_amount: checkU128(m.wnear_amount, "wnear_amount"),
        min_shares: checkU128(m.min_shares, "min_shares"),
      };
    case "spot_swap":
      return { action: m.action, min_out: checkU128(m.min_out, "min_out") };
    case "fund_insurance":
      if (v < 2) throw new V2OnlyOnV1Contract("fund_insurance");
      return { action: m.action, scenario_id: checkId(m.scenario_id, "scenario_id"), ...tierField(m.tier, v) };
    case "pledge":
      if (v < 2) throw new V2OnlyOnV1Contract("pledge");
      return { action: m.action, proposal_id: checkId(m.proposal_id, "proposal_id") };
  }
}

/** The `msg` string of an `ft_transfer_call`: "" for a plain deposit, else compact JSON. */
export function encodeMsg(m: Msg, stateVersion: number): string {
  const o = ordered(m, stateVersion);
  return o === null ? "" : JSON.stringify(o);
}

/** The flags the contract checks for a msg (SPEC-C 3.2 / 3.8), for pause-aware callers. */
export function msgFlags(m: Msg): string[] {
  switch (m.action) {
    case "deposit":
    case "repay":
    case "deposit_collateral":
    case "fund_insurance":
      return [];
    case "split":
    case "lp_deposit":
      return ["mint"];
    case "conditional_sell":
    case "conditional_buy":
      return m.to_lending ? ["trade", "lend"] : ["trade"];
    case "sell_and_borrow":
      return ["trade", "lend"];
    case "post_order":
    case "spot_swap":
      return ["trade"];
    case "supply":
      return ["lend"];
    case "liquidate":
      return m.receive === "cash" ? ["liquidate", "trade"] : ["liquidate"];
    case "close_after_resolution":
      return ["exit"];
    case "pledge":
      return ["pledge"];
  }
}
