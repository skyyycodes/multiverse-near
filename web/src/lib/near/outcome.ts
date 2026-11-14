import { fmt, fmtNear, fmtUsd, pct } from "../format";

const WAD = 10n ** 18n;

// Reading a transaction's result. On NEAR a failed ft_on_transfer does not fail the transaction: the token contract
// refunds and the transaction still ends in SuccessValue("0"). So "did it work" means: no receipt failed, and an
// ft_transfer_call that should use everything it sent used all of it.

export type ReceiptOutcome = {
  id?: string;
  outcome: { logs?: string[]; status?: unknown; executor_id?: string };
};

export type TxOutcome = {
  status?: unknown;
  transaction?: { hash?: string; signer_id?: string };
  transaction_outcome?: { id?: string };
  receipts_outcome?: ReceiptOutcome[];
};

export function txHash(o: TxOutcome | undefined): string | undefined {
  return o?.transaction?.hash ?? o?.transaction_outcome?.id;
}

const PANIC_PREFIXES = ["Smart contract panicked: ", "wasm execution failed with error: "];

/** The contract's own words: the panic string without the runtime's prefix. */
export function cleanError(message: string): string {
  let m = message.trim();
  for (let again = true; again; ) {
    again = false;
    for (const p of PANIC_PREFIXES) {
      if (m.startsWith(p)) {
        m = m.slice(p.length);
        again = true;
      }
    }
    const inner = /FunctionCallError\((?:ExecutionError|HostError)\("?(.*?)"?\)\)$/.exec(m);
    if (inner) {
      m = inner[1];
      again = true;
    }
    // View panics come back as HostError(GuestPanic { panic_msg: "..." }).
    const guest = /GuestPanic \{ panic_msg: "(.*)" \}\)?$/.exec(m);
    if (guest) {
      m = guest[1].replace(/\\"/g, '"');
      again = true;
    }
  }
  return m;
}

function findMessage(x: unknown): string | undefined {
  if (typeof x === "string") return x;
  if (!x || typeof x !== "object") return undefined;
  const obj = x as Record<string, unknown>;
  for (const key of ["ExecutionError", "error_message", "message"]) {
    if (typeof obj[key] === "string") return obj[key] as string;
  }
  for (const v of Object.values(obj)) {
    const m = findMessage(v);
    if (m) return m;
  }
  return undefined;
}

function failureIn(status: unknown): string | undefined {
  if (!status || typeof status !== "object") return status === "Failure" ? "transaction failed" : undefined;
  const f = (status as Record<string, unknown>).Failure;
  if (f === undefined) return undefined;
  return cleanError(findMessage(f) ?? JSON.stringify(f));
}

/**
 * The first failure, as the contract worded it: the transaction's own status, or a receipt executed by `contractId`
 * (where ft_on_transfer runs). A token receipt that fails after the action succeeded is a failed payout, which the
 * contract parks in the user's internal balance and reports as `payout_failed`; that is not a failed action.
 */
export function failureOf(o: TxOutcome, contractId?: string): string | undefined {
  const top = failureIn(o.status);
  if (top) return top;
  for (const r of o.receipts_outcome ?? []) {
    if (contractId && r.outcome.executor_id && r.outcome.executor_id !== contractId) continue;
    const f = failureIn(r.outcome.status);
    if (f) return f;
  }
  return undefined;
}

function decodeBase64(s: string): string {
  if (typeof atob === "function") {
    const bin = atob(s);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(s, "base64").toString("utf8");
}

/** The transaction's final return value, decoded from base64 (JSON text). */
export function successValue(o: TxOutcome): string | undefined {
  const s = o.status as { SuccessValue?: string } | undefined;
  if (!s || typeof s !== "object" || typeof s.SuccessValue !== "string") return undefined;
  return s.SuccessValue === "" ? "" : decodeBase64(s.SuccessValue);
}

/** ft_transfer_call returns the amount the receiver kept (ft_resolve_transfer's value), in token units. */
export function usedAmount(o: TxOutcome): bigint | undefined {
  const v = successValue(o);
  if (v === undefined || v === "") return undefined;
  try {
    const parsed = JSON.parse(v) as unknown;
    if (typeof parsed === "string" || typeof parsed === "number") return BigInt(parsed);
  } catch {
    return undefined;
  }
  return undefined;
}

export type NepEvent = { standard: string; version?: string; event: string; data: Record<string, unknown>[] };

/** NEP-297 events in every receipt's logs, optionally only those of one standard. */
export function eventsOf(o: TxOutcome, standard?: string): NepEvent[] {
  const out: NepEvent[] = [];
  for (const r of o.receipts_outcome ?? []) {
    for (const line of r.outcome.logs ?? []) {
      if (!line.startsWith("EVENT_JSON:")) continue;
      try {
        const e = JSON.parse(line.slice("EVENT_JSON:".length)) as NepEvent;
        if (!standard || e.standard === standard) out.push({ ...e, data: Array.isArray(e.data) ? e.data : [] });
      } catch {
        // a malformed log line is someone else's problem; skip it
      }
    }
  }
  return out;
}

export class TxError extends Error {
  hash?: string;
  constructor(message: string, hash?: string) {
    super(message);
    this.name = "TxError";
    this.hash = hash;
  }
}

/**
 * Throws unless the transaction did what was asked. `expectUsed` is set for ft_transfer_call actions: a bigint for
 * actions that consume the whole transfer (anything less means the contract refused and the tokens came back), or
 * "nonzero" for actions that may hand part of it back (repay, close, a Root LP deposit) but must have used some.
 * A used amount that cannot be read is not a success either: the tokens may well have come back.
 */
export function assertSuccess(o: TxOutcome, opts: { expectUsed?: bigint | "nonzero"; contractId?: string } = {}): string {
  const hash = txHash(o) ?? "";
  const failure = failureOf(o, opts.contractId);
  if (failure) throw new TxError(failure, hash);
  if (opts.expectUsed !== undefined) {
    const used = usedAmount(o);
    const want = opts.expectUsed === "nonzero" ? 1n : opts.expectUsed;
    if (used === undefined) {
      throw new TxError("Could not read how much of the transfer the contract used; check your balances before trying again.", hash);
    }
    if (used < want) {
      throw new TxError(
        used === 0n ? "The contract refused the transfer and the tokens were refunded." : "The contract used only part of the transfer; the rest was refunded.",
        hash,
      );
    }
  }
  return hash;
}

/** Payouts the contract could not deliver (receiver not registered on the token): credited to the internal balance. */
export const payoutFailures = (o: TxOutcome) => eventsOf(o, "multiverse").filter((e) => e.event === "payout_failed");

// ---- v2 outcome readers (web design 5.3) ----

/** The `multiverse` event versions this build reads: v1 contracts log 1.0.0, v2 contracts 2.0.0 (SPEC.md 3.4). */
export const MULTIVERSE_VERSIONS: readonly string[] = ["1.0.0", "2.0.0"];

/** Every data item of every `multiverse` line named `event`, across receipts and lines (one line may carry many). */
export function eventItems(o: TxOutcome, event: string): Record<string, unknown>[] {
  return eventsOf(o, "multiverse")
    .filter((e) => e.event === event && (e.version === undefined || MULTIVERSE_VERSIONS.includes(e.version)))
    .flatMap((e) => e.data);
}

const amountOf = (v: unknown): bigint => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : 0n);
const idOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
const sum = (items: Record<string, unknown>[], key: string) => items.reduce((s, d) => s + amountOf(d[key]), 0n);

/** T27, T28: the new proposal's id (`proposal_created`). */
export const createdProposalId = (o: TxOutcome): number | undefined => idOf(eventItems(o, "proposal_created")[0]?.proposal_id);

/** T29: a pledge counts only with its `pledged` event; `open_scheduled` means a detached opening follows. */
export function pledgeResult(o: TxOutcome): { pledged: boolean; openScheduled: boolean; openDeferred: string | undefined } {
  const deferred = eventItems(o, "open_deferred")[0]?.blocker;
  return {
    pledged: eventItems(o, "pledged").length > 0,
    openScheduled: eventItems(o, "open_scheduled").length > 0,
    openDeferred: typeof deferred === "string" ? deferred : undefined,
  };
}

/** T29 (auto-open), T33: the market an opening created (`market_opened`). */
export const openedMarketId = (o: TxOutcome): number | undefined => idOf(eventItems(o, "market_opened")[0]?.scenario_id);

export type LiquidationResult = {
  repaid: bigint;
  pieces: string[];
  seized: bigint[];
  seizeAll: boolean;
  writtenOff: bigint;
  cash: { cash: bigint; leftUsdc: bigint[]; minOut: bigint } | null;
  badDebt: { debt: bigint; covered: bigint; socialized: bigint } | null;
};

/** T38: what a liquidation did (`liquidate`, optional `cash_out` and `bad_debt`); undefined without a `liquidate` line. */
export function liquidationResult(o: TxOutcome): LiquidationResult | undefined {
  const l = eventItems(o, "liquidate")[0];
  if (!l) return undefined;
  const c = eventItems(o, "cash_out")[0];
  const b = eventItems(o, "bad_debt")[0];
  return {
    repaid: amountOf(l.repaid),
    pieces: Array.isArray(l.pieces) ? l.pieces.map(String) : [],
    seized: Array.isArray(l.seized) ? l.seized.map(amountOf) : [],
    seizeAll: l.seize_all === true,
    writtenOff: amountOf(l.written_off),
    cash: c ? { cash: amountOf(c.cash), leftUsdc: Array.isArray(c.left_usdc) ? c.left_usdc.map(amountOf) : [], minOut: amountOf(c.min_out) } : null,
    badDebt: b ? { debt: amountOf(b.debt), covered: amountOf(b.covered), socialized: amountOf(b.socialized) } : null,
  };
}

/** T38's result line; `seizedFraction` (WAD, from the quote) words a partial tokens-mode seizure. */
export function liquidationLine(r: LiquidationResult, seizedFraction?: bigint): string {
  const repaid = `Repaid ${fmtUsd(r.repaid)}`;
  const got = r.cash
    ? `received ${fmtUsd(r.cash.cash)} in cash`
    : r.seizeAll
      ? "seized every piece"
      : seizedFraction !== undefined
        ? `seized ${pct(seizedFraction, WAD, 2)} of every piece`
        : `seized ${r.seized.filter((s) => s > 0n).length} pieces`;
  const bad = r.badDebt ? `; wrote off ${fmtUsd(r.badDebt.debt)} (insurance covered ${fmtUsd(r.badDebt.covered)})` : "";
  return `${repaid}; ${got}${bad}`;
}

/** T39: "Wrote off $x: insurance $y, lenders $z"; undefined without a `bad_debt` line. */
export function badDebtLine(o: TxOutcome): string | undefined {
  const b = eventItems(o, "bad_debt")[0];
  if (!b) return undefined;
  return `Wrote off ${fmtUsd(amountOf(b.debt))}: insurance ${fmtUsd(amountOf(b.covered))}, lenders ${fmtUsd(amountOf(b.socialized))}`;
}

/** T30, T31: "Returned 100.00 USDC + 3.00 wNEAR" (`pledge_returned`, every item summed). */
export function pledgeReturnedLine(o: TxOutcome): string | undefined {
  const items = eventItems(o, "pledge_returned");
  if (items.length === 0) return undefined;
  const usdc = sum(items, "usdc");
  const wnear = sum(items, "wnear");
  const parts = [usdc > 0n ? `${fmt(usdc)} USDC` : undefined, wnear > 0n ? `${fmtNear(wnear)} wNEAR` : undefined].filter(Boolean);
  return parts.length ? `Returned ${parts.join(" + ")}` : "Nothing was left to return";
}

/** T32: "Received $… and … wNEAR; leftover world tokens are in your holdings" (`seed_withdrawn`). */
export function seedWithdrawnLine(o: TxOutcome): string | undefined {
  const items = eventItems(o, "seed_withdrawn");
  if (items.length === 0) return undefined;
  return `Received ${fmtUsd(sum(items, "usdc_out"))} and ${fmtNear(sum(items, "wnear_out"))} wNEAR; leftover world tokens are in your holdings`;
}
