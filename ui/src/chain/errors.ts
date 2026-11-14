// Contract errors in plain words (web design 5.5, 6.9; SPEC.md K3). The contract's own text always stays visible after
// the plain words ("{text} ({raw})"), for support and for the recorder; anything this table does not know passes
// through unchanged.
import { fmt, fmtHf, fmtNear, fmtPrice, fmtUsd, pct, utcDate } from "./format";
import { marketHref, proposalHref } from "./links";
import { FLAG_LABEL, type PauseFlag } from "./pause";
import { BRAND } from "./brand";
import type { Asset } from "./types";

const WAD = 10n ** 18n;

/** "BelowMinLoan(99, 100)" → { name: "BelowMinLoan", args: ["99", "100"] }; args split at the top level only. */
export function parseContractError(raw: string): { name: string; args: string[] } | undefined {
  const m = /^(\w+)(?:\((.*)\))?$/s.exec(raw.trim());
  if (!m) return undefined;
  const args: string[] = [];
  if (m[2] !== undefined && m[2] !== "") {
    let depth = 0;
    let cur = "";
    for (let i = 0; i < m[2].length; i++) {
      const ch = m[2][i];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      if (ch === ")" || ch === "]" || ch === "}") depth--;
      if (depth === 0 && ch === "," && m[2][i + 1] === " ") {
        args.push(cur);
        cur = "";
        i++;
        continue;
      }
      cur += ch;
    }
    args.push(cur);
  }
  return { name: m[1], args };
}

/** What a message needs to name things the error only numbers. */
export type ErrorContext = {
  /** A world's label ("SHIPS·CUTS") from its index. */
  worldLabel?: (world: number) => string;
  /** The asset of the amount the error is about (pledges). */
  asset?: Asset;
};

const int = (s: string | undefined): bigint | undefined => (s !== undefined && /^-?\d+$/.test(s.trim()) ? BigInt(s.trim()) : undefined);
const usd = (s: string | undefined) => {
  const v = int(s);
  return v === undefined ? (s ?? "") : fmtUsd(v);
};
const price = (s: string | undefined) => {
  const v = int(s);
  return v === undefined ? (s ?? "") : fmtPrice(v);
};
const tierName = (s: string | undefined) => {
  const t = (s ?? "").trim().toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
};
const world = (s: string | undefined, ctx: ErrorContext) => {
  const w = Number(s);
  return Number.isInteger(w) && ctx.worldLabel ? ctx.worldLabel(w) : `#${s ?? "?"}`;
};
const when = (s: string | undefined) => {
  const v = int(s);
  return v === undefined ? (s ?? "") : utcDate(v);
};
/** yoctoNEAR as NEAR, rounded up to 0.001 (a shortfall is never understated). */
const yoctoNear = (v: bigint) => {
  const milli = 10n ** 21n;
  return fmt((((v + milli - 1n) / milli) * milli) / 10n ** 6n, 3);
};

/** An opening blocker (`open_check`, SPEC-contract 3.7.5) in words, for the proposal page; undefined if unknown. */
export function blockerText(raw: string, ctx: ErrorContext = {}): string | undefined {
  const e = parseContractError(raw);
  if (!e) return undefined;
  const [a, b, c] = e.args;
  switch (e.name) {
    case "Paused":
      return a === "mint" ? "Openings are paused for maintenance" : undefined;
    case "NotApproved":
      return "Waiting for the admin's check";
    case "NoticePeriod":
      return `The admin changed the opening terms; it can open after ${when(b)}`;
    case "EventDeciding":
      return `Event #${a} has a result in its dispute window`;
    case "OutrankedForSlot":
      return `Event #${a} has room for fewer markets than funded proposals; #${b} has more pledged`;
    case "NoSpotReference":
      return "No reliable NEAR price to open at right now";
    case "AnchorsDisagree":
      return "The anchor markets disagree on NEAR's price";
    case "ExternalDisagrees":
      return "The markets' NEAR price is too far from the outside feed";
    case "ReferenceMissing":
      return "Openings wait for a fresh NEAR/USD price";
    case "ReferenceStale":
      return `Openings wait for a fresh NEAR/USD price (last one ${a} s old)`;
    case "NoReferenceMarket":
      return `Event #${a} has no reference market`;
    case "ReferenceUnavailable":
      return `Market #${a} cannot price the opening yet (${b})`;
    case "ReferenceDiverges":
      return `Market #${a}'s prices are too far from the anchors`;
    case "PriceOutOfRange":
      return `The opening price for world ${world(a, ctx)} would be out of range`;
    case "GoalNotReached":
      return `${usd(a)} of ${usd(b)} can be put to work; more pledges would help`;
    case "TooThin":
      return `World ${world(a, ctx)}'s pool would hold only ${usd(b)}; it needs ${usd(c)}`;
    case "PlanFailed":
      return `The opening plan failed (${a})`;
    case "OpenStorageShort": {
      const need = int(a);
      const have = int(b);
      return need !== undefined && have !== undefined ? `The reserve is ${yoctoNear(need > have ? need - have : 0n)} NEAR short for the new market's storage` : undefined;
    }
  }
  return undefined;
}

/** A failed action's error in plain words; the raw text when the table does not know it. */
export function humanError(raw: string, ctx: ErrorContext = {}): string {
  const text = raw.trim();
  // Wallet and RPC refusals before the contract runs (InvalidTxError), worded by the node, not the contract.
  if (/NotEnoughBalance/.test(text)) return "Not enough NEAR in your wallet for this transaction's gas";
  if (/LackBalanceForState/.test(text)) return "Not enough NEAR in your wallet to keep its storage after this transaction";
  // A public RPC turning the wallet's broadcast away: nothing was sent.
  if (/Rate limits exceeded|"code":\s*-429|HTTP 429/.test(text)) return "The NEAR RPC is busy right now and sent nothing: try again in a few seconds";
  const e = parseContractError(text);
  if (!e) return text;
  const [a, b] = e.args;
  switch (e.name) {
    case "Paused":
      return `Paused for maintenance: ${FLAG_LABEL[a as PauseFlag] ?? a}`;
    case "LiquidationGrace":
      return `Liquidations resume at ${when(a)}`;
    case "BelowMinLoan":
      return `The minimum loan is ${usd(b)}`;
    case "DustDebtLeft":
      return `That would leave ${usd(a)} owed, under the ${usd(b)} minimum: repay all of it or leave at least ${usd(b)}`;
    case "UtilizationCap": {
      const max = int(b);
      return `This tier lends at most ${max === undefined ? b : pct(max, WAD, 0)} of its cash; try a smaller amount or another tier`;
    }
    case "BorrowCapExceeded":
      return `This tier's borrowing cap is ${usd(b)}`;
    case "MarketFrozen":
      return `The ${tierName(b)} tier of this market takes no new loans or deposits`;
    case "MarketWipedOut":
      return `The ${tierName(b)} tier lost all its lent cash to bad debt and is closed to deposits`;
    case "ReferenceMissing":
      return "New borrowing waits for a fresh NEAR/USD price";
    case "ReferenceStale":
      return `New borrowing waits for a fresh NEAR/USD price (last one ${a} s old, limit ${b} s)`;
    case "ReferenceDeviation":
      return `This market prices NEAR at ${price(a)}, the outside feed at ${price(b)}: more than 10% apart, so new borrowing waits`;
    case "ImpliedSpotUnknown":
      return "This market's implied NEAR price is not known yet (a pool is too young or thin)";
    case "ReferenceGuard":
      return "Liquidation waits: the market's prices are more than 10% above the outside feed";
    case "NotLiquidatable": {
      const hf = int(a);
      return `Not liquidatable: health factor ${hf === undefined ? a : fmtHf(hf)}`;
    }
    case "PriceUnavailable":
      return `World ${world(a, ctx)} has no price for liquidation yet`;
    case "CashOutBelowMin":
      return `Cash-out would pay ${usd(a)}, under your minimum ${usd(b)}; nothing happened`;
    case "CashOutUnpricesWorld":
      return `Selling into ${world(a, ctx)} would leave it without a valid price; use tokens mode`;
    case "InsufficientRepayment":
      return `The repayment grew to ${usd(b)}; try again`;
    case "NoDebt":
      return "Nothing to write off";
    case "StillCollateralized":
      return `Still has collateral worth ${usd(a)}: liquidate instead`;
    case "TooManyFills":
      return `Too many orders in one trade (${a}, limit ${b}); the app re-plans with fewer`;
    // trading: the order book, the pools and the account's storage (UI-C)
    case "InsufficientBalance":
      return "You hold less than that in this world now; refresh and try a smaller amount";
    case "InsufficientStorage": {
      const need = int(a);
      const have = int(b);
      const short = need !== undefined && have !== undefined && need > have ? ` ${yoctoNear(need - have)} NEAR` : "";
      return `Your storage deposit with ${BRAND.name} is${short} short for this; the next try adds to it first`;
    }
    case "NotRegistered":
      return `Your account is not registered with ${BRAND.name} yet; the next action registers it`;
    case "OrderTooSmall":
      return "An order needs at least 0.001 NEAR";
    case "OrderValueTooSmall":
      return "An order must be worth at least 0.0001 USDC";
    case "TooManyOpenOrders":
      return `You have ${a} open orders, the most allowed; cancel one first`;
    case "ExpiryInPast":
      return "That expiry has already passed; pick a later one";
    case "OrderNotOpen":
      return `Order #${a} was filled or cancelled a moment ago; the book has been refreshed`;
    case "OrderExpired":
      return `Order #${a} expired before your trade landed`;
    case "StaleOrder":
      return `Order #${a} went stale after a resolution`;
    case "AmountExceedsRemaining":
      return `Order #${a} has less left than that now; the book has been refreshed`;
    case "PriceBeyondLimit":
      return `Order #${a} no longer has the price you saw`;
    case "PlanOrderMismatch":
      return `Order #${b} is no longer in that world's book; the app re-plans`;
    case "TooLittleReceived":
      return `The pool would pay ${a === undefined ? "less" : fmt(int(a) ?? 0n, 4)}, under your minimum of ${b === undefined ? "the quote" : fmt(int(b) ?? 0n, 4)}: the price moved, so nothing happened`;
    case "InsufficientOutput":
      return `World ${world(a, ctx)} would pay less than the 0.5% the quote allows: the price moved, so nothing happened`;
    case "ScenarioHalted":
      return "Trading in this market pauses while a result is in its dispute window";
    case "DeadVerse":
      return "That world can no longer happen, so it does not trade";
    case "PoolNotInitialized":
      return `World ${world(a, ctx)} has no pool yet`;
    case "NotMaker":
      return `Order #${a} is not yours`;
    case "ProposalExists":
      return `Already proposed: proposal #${a}`;
    case "MarketExists":
      return `This market already exists: #${a}`;
    case "EventResolved":
      return `Event #${a} has resolved`;
    case "EventDeciding":
      return `Event #${a} has a result in its dispute window`;
    case "TooManyScenarios":
      return `Event #${a} already has 16 markets`;
    case "TooManyProposals":
      return `16 proposals use event #${a}`;
    case "NoReferenceMarket":
      return `Event #${a} has no reference market to price from`;
    case "DeadlineTooSoon":
      return "The deadline is too soon to collect pledges and trade";
    case "TooManyActiveProposals":
      return `You have ${a} live proposals; wait for one to end`;
    case "PledgeTooSmall": {
      const min = int(b);
      const shown = min === undefined ? b : ctx.asset === "wnear" ? `${fmtNear(min)} wNEAR` : `${fmt(min)} USDC`;
      return `The smallest pledge is ${shown}`;
    }
    case "TooManyPledges":
      return `You already pledge to ${a} proposals`;
    case "ProposalClosed":
      return `Proposal #${a} is ${(b ?? "").toLowerCase()}`;
    case "SeedLocked":
      return `Locked until ${when(b)}`;
    case "SeedDepthFloor": {
      const max = int(b);
      return `Lenders depend on this pool: withdraw at most ${max === undefined ? b : fmt(max)} shares now`;
    }
  }
  return blockerText(text, ctx) ?? text;
}

/** The result line of a failed action: plain words, then the contract's exact text. */
export function errorLine(raw: string, ctx: ErrorContext = {}): string {
  const text = humanError(raw, ctx);
  return text === raw.trim() ? text : `${text} (${raw.trim()})`;
}

/** Where an error points to, when it names a proposal or market that already exists. */
export function errorHref(raw: string): string | undefined {
  const e = parseContractError(raw);
  if (!e) return undefined;
  if (e.name === "ProposalExists" && /^\d+$/.test(e.args[0] ?? "")) return proposalHref(Number(e.args[0]));
  if (e.name === "MarketExists" && /^\d+$/.test(e.args[0] ?? "")) return marketHref(Number(e.args[0]));
  return undefined;
}
