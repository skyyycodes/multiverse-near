// Transactions the app asks the wallet to sign. Real tokens move with ft_transfer_call and a JSON `msg` naming the
// action (the contract's ft_on_transfer runs it and refunds what it did not use), so there is no approval step.
// Everything else is a direct call with 1 yoctoNEAR attached, the NEAR convention for value-moving methods.
//
// Each builder below is one row of the transaction table (web design 5.2, T1-T48): exact args and msg, deposit and
// gas. Amounts in args and msgs are internal 18-decimal U128 strings; the ft_transfer_call `amount` is in token units.
import type { OpeningTerms, PauseFlag, Tier } from "../domain";
import type { WorldPlan } from "../orders";
import { minOutOf } from "../orders";
import type { Side } from "../orders";
import type { Asset } from "../types";

export const ONE_YOCTO = "1";
/**
 * Gas for the everyday ft_transfer_calls (split, sell, buy, post_order, supply, repay, collateral, close, deposits)
 * and the direct trades from the inner balance. The token keeps 30 Tgas and hands ft_on_transfer the other 120
 * (NEP-141, near-contract-standards 5.14); only a close with debt schedules anything from there (a payout, 10 + 5 Tgas
 * per asset). The heaviest accepted 8-world trade needs about 38 Tgas (SPEC-contract 7, gate 55); live receipts burn
 * 4-9. Testnet buys all prepaid gas up front at 1e9 yocto per gas (GAS_PRICE_YOCTO) and refunds the unused part, so
 * this needs 0.15 NEAR free when signing, not 0.3.
 */
export const GAS_FT_ROUTINE = "150000000000000";
/**
 * The per-transaction maximum, for calls that need it: a goal-reaching pledge and approve_proposal schedule the
 * opening (215 Tgas must be left), request_reference / request_resolution need 240 Tgas prepaid, a cash-out
 * liquidation sells and merges before its payout (both liquidation modes keep it), and open_market / seed_withdraw
 * build or take apart the pools of every world (SPEC-contract 7 gates: 150 and 120 Tgas). Proposals keep it too.
 */
export const GAS_FT_CALL = "300000000000000";
export const GAS_MAX = GAS_FT_CALL;
/** Direct calls that may pay out (borrow, redeem, close) schedule an ft_transfer plus its callback. */
export const GAS_CALL = "150000000000000";
export const GAS_LIGHT = "30000000000000";

export type FunctionCall = {
  type: "FunctionCall";
  params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
};
export type Tx = { receiverId: string; actions: FunctionCall[] };

export type PlanFill = { order_id: string; amount: string };

/** `"max"` (lowercase) or an internal U128 string. */
export type RepayAmount = "max" | string;

export type FtAction =
  | { action: "deposit" }
  | { action: "split"; scenario_id: number; to_masks: number[] }
  | { action: "conditional_sell"; scenario_id: number; sell_mask: number; plans: PlanFill[][]; min_out: string[]; to_lending: boolean; tier?: Tier }
  | { action: "conditional_buy"; scenario_id: number; buy_mask: number; plans: PlanFill[][]; min_out: string[]; to_lending: boolean; tier?: Tier }
  | { action: "post_order"; scenario_id: number; mask: number; side: Side; price: string; amount: string; expiry_sec: number }
  | { action: "supply"; scenario_id: number; tier?: Tier }
  | { action: "repay"; scenario_id: number; all: boolean; tier?: Tier }
  | { action: "deposit_collateral"; scenario_id: number; tier?: Tier }
  | { action: "close_after_resolution"; scenario_id: number; tier?: Tier }
  | { action: "lp_deposit"; scenario_id: number; wnear_amount: string; min_shares: string }
  | { action: "liquidate"; scenario_id: number; account_id: string; repay_amount: RepayAmount; tier?: Tier; receive?: "cash"; min_out?: string }
  | { action: "fund_insurance"; scenario_id: number; tier?: Tier }
  | { action: "pledge"; proposal_id: number };

/**
 * SPEC-contract 3.8: an omitted tier is Normal. Sending only the non-Normal names keeps every Normal msg and call
 * byte-identical to v1 (WI-5).
 */
export function withTier<T extends object>(o: T, tier: Tier | undefined): T & { tier?: Tier } {
  return tier && tier !== "normal" ? { ...o, tier } : o;
}

export function call(receiverId: string, methodName: string, args: Record<string, unknown>, deposit = ONE_YOCTO, gas = GAS_CALL): Tx {
  return { receiverId, actions: [{ type: "FunctionCall", params: { methodName, args, gas, deposit } }] };
}

/** `amount` is in the token's own units; the msg is a JSON string inside the JSON args. */
export function ftTransferCall(tokenId: string, receiverId: string, amount: bigint, msg: FtAction, gas: string = GAS_FT_ROUTINE): Tx {
  return call(tokenId, "ft_transfer_call", { receiver_id: receiverId, amount: amount.toString(), memo: null, msg: JSON.stringify(msg) }, ONE_YOCTO, gas);
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

/** NEP-145: sends the free part of the storage deposit (returned bonds and reserves land there) back to the wallet. */
export const storageWithdraw = (contractId: string): Tx => call(contractId, "storage_withdraw", {}, ONE_YOCTO, GAS_LIGHT);
export const storageDeposit = (contractId: string, deposit: bigint, registrationOnly: boolean, accountId?: string): Tx =>
  call(contractId, "storage_deposit", { account_id: accountId ?? null, registration_only: registrationOnly }, deposit.toString(), GAS_LIGHT);

export const assetSymbol = (a: Asset) => (a === "wnear" ? "wNEAR" : "USDC");

const u128 = (x: bigint): string => {
  if (x < 0n) throw new Error(`negative amount ${x}`);
  return x.toString();
};

// ---- trading (T1-T7, T20, T44, T45) ----

export type TradePlan = { scenarioId: number; plans: PlanFill[][]; minOut: string[]; toLending: boolean; tier?: Tier };

/** T1: sell NEAR from the wallet in `sellMask`'s worlds; with `toLending` the proceeds stay as collateral in `tier`. */
export const sellFromWallet = (wnearId: string, contractId: string, tokens: bigint, p: TradePlan & { sellMask: number }): Tx =>
  ftTransferCall(
    wnearId,
    contractId,
    tokens,
    withTier(
      { action: "conditional_sell" as const, scenario_id: p.scenarioId, sell_mask: p.sellMask, plans: p.plans, min_out: p.minOut, to_lending: p.toLending },
      p.toLending ? p.tier : undefined,
    ),
  );

/** T2: the same sale from the inner balance, a direct call. */
export const sellFromInner = (contractId: string, p: TradePlan & { sellMask: number; amount: bigint }): Tx =>
  call(
    contractId,
    "conditional_sell",
    withTier(
      { scenario_id: p.scenarioId, amount: u128(p.amount), sell_mask: p.sellMask, plans: p.plans, min_out: p.minOut, to_lending: p.toLending },
      p.toLending ? p.tier : undefined,
    ),
    ONE_YOCTO,
    GAS_FT_ROUTINE,
  );

/** T4 (and a buy kept as collateral): USDC for NEAR in `buyMask`'s worlds; `minOut` is NEAR per world. */
export const buyFromWallet = (usdcId: string, contractId: string, tokens: bigint, p: TradePlan & { buyMask: number }): Tx =>
  ftTransferCall(
    usdcId,
    contractId,
    tokens,
    withTier(
      { action: "conditional_buy" as const, scenario_id: p.scenarioId, buy_mask: p.buyMask, plans: p.plans, min_out: p.minOut, to_lending: p.toLending },
      p.toLending ? p.tier : undefined,
    ),
  );

/** The buy from the inner balance, a direct call. */
export const buyFromInner = (contractId: string, p: TradePlan & { buyMask: number; amount: bigint }): Tx =>
  call(
    contractId,
    "conditional_buy",
    withTier(
      { scenario_id: p.scenarioId, amount: u128(p.amount), buy_mask: p.buyMask, plans: p.plans, min_out: p.minOut, to_lending: p.toLending },
      p.toLending ? p.tier : undefined,
    ),
    ONE_YOCTO,
    GAS_FT_ROUTINE,
  );

/** T3: accept one bid (sell into it, nothing kept as collateral). */
export const acceptBid = (wnearId: string, contractId: string, tokens: bigint, p: { scenarioId: number; sellMask: number; plans: PlanFill[][]; minOut: string[] }): Tx =>
  sellFromWallet(wnearId, contractId, tokens, { ...p, toLending: false });

/** T4: accept one ask. */
export const acceptAsk = (usdcId: string, contractId: string, tokens: bigint, p: { scenarioId: number; buyMask: number; plans: PlanFill[][]; minOut: string[] }): Tx =>
  buyFromWallet(usdcId, contractId, tokens, { ...p, toLending: false });

/** T5 (bid, USDC) / T6 (ask, wNEAR): rest an order on the book. */
export const postOrder = (
  tokenId: string,
  contractId: string,
  tokens: bigint,
  p: { scenarioId: number; mask: number; side: Side; price: bigint; amount: bigint; expirySec: number },
): Tx =>
  ftTransferCall(tokenId, contractId, tokens, {
    action: "post_order",
    scenario_id: p.scenarioId,
    mask: p.mask,
    side: p.side,
    price: u128(p.price),
    amount: u128(p.amount),
    expiry_sec: p.expirySec,
  });

/** T7 */
export const cancelOrder = (contractId: string, orderId: bigint): Tx => call(contractId, "cancel_order", { order_id: orderId.toString() });

/** T20: the owner's price push, a pool-only sale in one world with a minimum per sold world. */
export const pricePush = (wnearId: string, contractId: string, tokens: bigint, p: { scenarioId: number; sellMask: number; worldCount: number; minOut: string[] }): Tx =>
  sellFromWallet(wnearId, contractId, tokens, {
    scenarioId: p.scenarioId,
    sellMask: p.sellMask,
    plans: Array.from({ length: p.worldCount }, () => []),
    minOut: p.minOut,
    toLending: false,
  });

/** T44: split real wNEAR or USDC into the singles `toMasks` (the possible worlds). */
export const split = (tokenId: string, contractId: string, tokens: bigint, p: { scenarioId: number; toMasks: number[] }): Tx =>
  ftTransferCall(tokenId, contractId, tokens, { action: "split", scenario_id: p.scenarioId, to_masks: p.toMasks });

/** T45: merge the parts `fromMasks` back into `toMask` (the root merges to real tokens). */
export const merge = (contractId: string, p: { scenarioId: number; asset: Asset; fromMasks: number[]; toMask: number; amount: bigint }): Tx =>
  call(contractId, "merge", { scenario_id: p.scenarioId, asset: p.asset, from_masks: p.fromMasks, to_mask: p.toMask, amount: u128(p.amount) });

// ---- lending (T8-T11, T15, T16, T38-T41) ----

/** T8 */
export const borrow = (contractId: string, p: { scenarioId: number; amount: bigint; tier?: Tier }): Tx =>
  call(contractId, "borrow", withTier({ scenario_id: p.scenarioId, amount: u128(p.amount) }, p.tier));

/** T9: `all` repays the whole debt (attach `min(debt × 1.001, wallet)`); the contract refunds the rest. */
export const repay = (usdcId: string, contractId: string, tokens: bigint, p: { scenarioId: number; all: boolean; tier?: Tier }): Tx =>
  ftTransferCall(usdcId, contractId, tokens, withTier({ action: "repay" as const, scenario_id: p.scenarioId, all: p.all }, p.tier));

/** Takes a posted piece back ("usdc" / "wnear" for real collateral, the token id for a world's piece), `amount` internal. */
export const withdrawCollateral = (contractId: string, p: { scenarioId: number; piece: string; amount: bigint; tier?: Tier }): Tx =>
  call(contractId, "withdraw_collateral", withTier({ scenario_id: p.scenarioId, piece: p.piece, amount: u128(p.amount) }, p.tier));

/** T10 */
export const supply = (usdcId: string, contractId: string, tokens: bigint, p: { scenarioId: number; tier?: Tier }): Tx =>
  ftTransferCall(usdcId, contractId, tokens, withTier({ action: "supply" as const, scenario_id: p.scenarioId }, p.tier));

/** T11: `amount` null withdraws everything. */
export const withdrawSupply = (contractId: string, p: { scenarioId: number; amount: bigint | null; tier?: Tier }): Tx =>
  call(contractId, "withdraw_supply", withTier({ scenario_id: p.scenarioId, amount: p.amount === null ? null : u128(p.amount) }, p.tier));

/** T15: close a resolved position that still owes, paying the debt from the attached USDC. */
export const closeWithDebt = (usdcId: string, contractId: string, tokens: bigint, p: { scenarioId: number; tier?: Tier }): Tx =>
  ftTransferCall(usdcId, contractId, tokens, withTier({ action: "close_after_resolution" as const, scenario_id: p.scenarioId }, p.tier));

/** T16 */
export const closeAfterResolution = (contractId: string, p: { scenarioId: number; tier?: Tier }): Tx =>
  call(contractId, "close_after_resolution", withTier({ scenario_id: p.scenarioId }, p.tier));

/**
 * T38: liquidate with a USDC budget (token units). Cash mode sells the seized pieces and must name `minOut`; tokens
 * mode sends neither `receive` nor `min_out` (the contract refuses `MinOutRequired` / `MinOutWithoutCash`). Both
 * attach the full 300 Tgas: a cash-out sells in up to 8 worlds, merges and pays out (gate 80 Tgas, an estimate).
 */
export function liquidate(
  usdcId: string,
  contractId: string,
  budgetTokens: bigint,
  p: { scenarioId: number; accountId: string; repayAmount: "max" | bigint; tier?: Tier; receive: "cash" | "tokens"; minOut?: bigint },
): Tx {
  const base = withTier(
    {
      action: "liquidate" as const,
      scenario_id: p.scenarioId,
      account_id: p.accountId,
      repay_amount: p.repayAmount === "max" ? ("max" as const) : u128(p.repayAmount),
    },
    p.tier,
  );
  if (p.receive === "cash") {
    if (p.minOut === undefined) throw new Error("a cash-out liquidation needs min_out");
    return ftTransferCall(usdcId, contractId, budgetTokens, { ...base, receive: "cash", min_out: u128(p.minOut) }, GAS_MAX);
  }
  if (p.minOut !== undefined) throw new Error("a tokens-mode liquidation never sends min_out");
  return ftTransferCall(usdcId, contractId, budgetTokens, base, GAS_MAX);
}

/** T39 */
export const writeOffBadDebt = (contractId: string, p: { scenarioId: number; accountId: string; tier?: Tier }): Tx =>
  call(contractId, "write_off_bad_debt", withTier({ scenario_id: p.scenarioId, account_id: p.accountId }, p.tier));

/** T40: a donation to the tier's insurance fund (never paused, cannot be taken back). */
export const fundInsurance = (usdcId: string, contractId: string, tokens: bigint, p: { scenarioId: number; tier?: Tier }): Tx =>
  ftTransferCall(usdcId, contractId, tokens, withTier({ action: "fund_insurance" as const, scenario_id: p.scenarioId }, p.tier));

/** T41: add real wNEAR or USDC as collateral (never paused). */
export const depositCollateral = (tokenId: string, contractId: string, tokens: bigint, p: { scenarioId: number; tier?: Tier }): Tx =>
  ftTransferCall(tokenId, contractId, tokens, withTier({ action: "deposit_collateral" as const, scenario_id: p.scenarioId }, p.tier));

// ---- Root LP, redemption, inner balance (T12-T13, T17, T26) ----

/** T12a: wNEAR into the inner balance (empty-action deposit). */
export const depositToInner = (tokenId: string, contractId: string, tokens: bigint): Tx => ftTransferCall(tokenId, contractId, tokens, { action: "deposit" });

/** T12b */
export const lpDeposit = (usdcId: string, contractId: string, tokens: bigint, p: { scenarioId: number; wnearAmount: bigint; minShares: bigint }): Tx =>
  ftTransferCall(usdcId, contractId, tokens, { action: "lp_deposit", scenario_id: p.scenarioId, wnear_amount: u128(p.wnearAmount), min_shares: u128(p.minShares) });

/** T13 */
export const lpWithdraw = (contractId: string, p: { scenarioId: number; shares: bigint; minWnearOut: bigint[]; minUsdcOut: bigint[] }): Tx =>
  call(contractId, "lp_withdraw", {
    scenario_id: p.scenarioId,
    shares: u128(p.shares),
    min_wnear_out: p.minWnearOut.map(u128),
    min_usdc_out: p.minUsdcOut.map(u128),
  });

/** T17 */
export const redeem = (contractId: string, p: { scenarioId: number; asset: Asset; mask: number; amount: bigint }): Tx =>
  call(contractId, "redeem", { scenario_id: p.scenarioId, asset: p.asset, mask: p.mask, amount: u128(p.amount) });

/** T26: whole token units only (the rest cannot leave the contract). */
export const withdrawInner = (contractId: string, asset: Asset, amount: bigint): Tx => call(contractId, "withdraw", { asset, amount: u128(amount) });

// ---- resolution (T14, T18, T19, T42, T43) ----

/** T14 (not payable). */
export const finalize = (contractId: string, eventId: number): Tx => call(contractId, "finalize", { event_id: eventId }, "0");
/** T18 */
export const adminResolve = (contractId: string, eventId: number, outcome: number): Tx => call(contractId, "admin_resolve", { event_id: eventId, outcome });
/** T19 */
export const dispute = (contractId: string, eventId: number): Tx => call(contractId, "dispute", { event_id: eventId });
/** T42: ask the OutLayer guest for a fresh NEAR/USD price; attach `get_reference_config().guest.deposit`. */
export const requestReference = (contractId: string, deposit: bigint): Tx => call(contractId, "request_reference", {}, u128(deposit), GAS_MAX);
/** T43: resolve a FOMC event from FRED through OutLayer; attach `get_outlayer_config().deposit`. */
export const requestResolution = (contractId: string, eventId: number, deposit: bigint): Tx =>
  call(contractId, "request_resolution", { event_id: eventId }, u128(deposit), GAS_MAX);

// ---- test tokens (T21) ----

/** T21: the owner mints test wNEAR (token units) to an account. */
export const ownerMint = (tokenId: string, accountId: string, tokens: bigint): Tx => call(tokenId, "mint", { account_id: accountId, amount: u128(tokens) }, "0");

// ---- proposals and pledges (T27-T37) ----

/** Event ids ascending, without repeats: the contract's canonical key for a combination. */
export const canonicalEvents = (ids: readonly number[]): number[] => [...new Set(ids)].sort((a, b) => a - b);

/** T27: attach `bond_market + reserve_w{W}` (yocto). */
export const proposeMarket = (contractId: string, eventIds: readonly number[], deposit: bigint): Tx =>
  call(contractId, "propose_market", { event_ids: canonicalEvents(eventIds) }, u128(deposit), GAS_MAX);

export type NewEventArgs = {
  question: string;
  outcomeNames: [string, string];
  rule: string;
  source: string;
  deadlineSec: number;
  category: number;
  terms: OpeningTerms;
};

/** T28: attach `bond_new_event + reserve_w2` (yocto). */
export const proposeEvent = (contractId: string, e: NewEventArgs, deposit: bigint): Tx =>
  call(
    contractId,
    "propose_event",
    {
      question: e.question,
      outcome_names: e.outcomeNames,
      rule: e.rule,
      source: e.source,
      deadline_sec: e.deadlineSec,
      category: e.category,
      terms: { odds0_bps: e.terms.odds0Bps, mult_bps: e.terms.multBps },
    },
    u128(deposit),
    GAS_MAX,
  );

/** T29: 300 Tgas, because a pledge that reaches the goal schedules the opening (it needs 215 Tgas left). */
export const pledge = (tokenId: string, contractId: string, tokens: bigint, proposalId: number): Tx =>
  ftTransferCall(tokenId, contractId, tokens, { action: "pledge", proposal_id: proposalId }, GAS_MAX);

/** T30: null takes all of that asset; an amount takes exactly that (0 = none of it). A refund passes both null. */
export const withdrawPledge = (contractId: string, proposalId: number, amounts: { wnear: bigint | null; usdc: bigint | null } = { wnear: null, usdc: null }): Tx =>
  call(contractId, "withdraw_pledge", {
    proposal_id: proposalId,
    wnear: amounts.wnear === null ? null : u128(amounts.wnear),
    usdc: amounts.usdc === null ? null : u128(amounts.usdc),
  });

/** T31 */
export const claimUnused = (contractId: string, proposalId: number): Tx => call(contractId, "claim_unused", { proposal_id: proposalId });

/** T32: `shares` null withdraws all; minimums per world, checked before the merge. */
export const seedWithdraw = (contractId: string, p: { proposalId: number; shares: bigint | null; minWnearOut: bigint[]; minUsdcOut: bigint[] }): Tx =>
  call(
    contractId,
    "seed_withdraw",
    { proposal_id: p.proposalId, shares: p.shares === null ? null : u128(p.shares), min_wnear_out: p.minWnearOut.map(u128), min_usdc_out: p.minUsdcOut.map(u128) },
    ONE_YOCTO,
    GAS_MAX,
  );

/** T33: anyone may open a ready proposal; no deposit, no registration. */
export const openMarket = (contractId: string, proposalId: number): Tx => call(contractId, "open_market", { proposal_id: proposalId }, "0", GAS_MAX);

/** T34 */
export const cancelProposal = (contractId: string, proposalId: number): Tx => call(contractId, "cancel_proposal", { proposal_id: proposalId });

/** What T35 attaches: the shortfall plus 10%, rounded up (yocto). */
export const topUpDeposit = (needed: bigint, available: bigint): bigint => {
  const short = needed > available ? needed - available : 0n;
  return (short * 11n + 9n) / 10n;
};

/** T35: top up the opening reserve after `OpenStorageShort(needed, available)`. */
export const topUpProposal = (contractId: string, proposalId: number, needed: bigint, available: bigint): Tx =>
  call(contractId, "top_up_proposal", { proposal_id: proposalId }, u128(topUpDeposit(needed, available)), GAS_LIGHT);

/** T36: `terms` null keeps the proposer's terms. */
export const approveProposal = (contractId: string, proposalId: number, terms: OpeningTerms | null): Tx =>
  call(contractId, "approve_proposal", { proposal_id: proposalId, terms: terms ? { odds0_bps: terms.odds0Bps, mult_bps: terms.multBps } : null }, ONE_YOCTO, GAS_MAX);

/** T37 */
export const rejectProposal = (contractId: string, proposalId: number, forfeitBond: boolean): Tx =>
  call(contractId, "reject_proposal", { proposal_id: proposalId, forfeit_bond: forfeitBond });

// ---- operations (T46-T48) ----

/** T46: owner or guardian; no deposit. */
export const pauseTx = (contractId: string, flags: readonly PauseFlag[], reason: string): Tx => call(contractId, "pause", { flags: [...flags], reason }, "0", GAS_LIGHT);

/** T47: owner; a liquidation grace delays liquidations after the unpause. */
export const unpauseTx = (contractId: string, flags: readonly PauseFlag[], liquidationGraceSec?: number): Tx =>
  call(contractId, "unpause", { flags: [...flags], liquidation_grace_sec: liquidationGraceSec ?? null }, ONE_YOCTO, GAS_LIGHT);

/** T48: 1 yocto charges the owner's NEP-145 balance for the registry record. */
export const setMarketListing = (contractId: string, scenarioId: number, listed: boolean): Tx =>
  call(contractId, "set_market_listing", { scenario_id: scenarioId, listed }, ONE_YOCTO, GAS_LIGHT);

// ---- the gas float (WI-10) ----

/**
 * Testnet sells prepaid gas at `min_gas_purchase_price`: 1e9 yoctoNEAR per gas unit, so 150 Tgas must be free as
 * 0.15 NEAR and 300 Tgas as 0.3 NEAR when the transaction is signed; the unburnt part comes back a few blocks later.
 */
export const GAS_PRICE_YOCTO = 1_000_000_000n;
/** NEAR's storage price: 1e19 yoctoNEAR per byte (10 kB per NEAR). */
export const STORAGE_PRICE_YOCTO = 10n ** 19n;
/** Kept free on top, so the account can still pay for its own storage after the transaction. */
export const GAS_FLOAT_MARGIN_YOCTO = 10n ** 22n;

/**
 * Whether the signer can buy a transaction's prepaid gas and attach its deposit: free = balance − storage stake,
 * need = gas × price + deposit + 0.01 NEAR. `needText` is the need in NEAR, rounded up to the cent.
 */
export function gasFloat(account: { amount: string; storageUsage: number }, gas: string, deposit: bigint | string): { free: bigint; need: bigint; short: boolean; needText: string } {
  const free = BigInt(account.amount) - BigInt(account.storageUsage) * STORAGE_PRICE_YOCTO;
  const need = BigInt(gas) * GAS_PRICE_YOCTO + BigInt(deposit) + GAS_FLOAT_MARGIN_YOCTO;
  const cent = 10n ** 22n;
  const cents = (need + cent - 1n) / cent;
  return { free, need, short: free < need, needText: `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}` };
}
