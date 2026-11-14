// NEP-297 event lines out of transaction logs. The contract's `multiverse` events are version 2.0.0
// from v2 (1.0.0 before); a v2 line may carry several items in `data` (LogScope groups them), and
// fills inside a trade come as one `orders_filled` line instead of one `order_filled` per fill.
// Both versions parse; an unknown version of the standard is refused rather than misread.

import type { Receive, Tier } from "./msgs.ts";
import type { U128 } from "./views.ts";
import { u128 } from "./units.ts";

export const EVENT_PREFIX = "EVENT_JSON:";
export const MULTIVERSE_VERSIONS: readonly string[] = ["1.0.0", "2.0.0"];

export interface NepEvent {
  standard: "multiverse" | "nep245" | string;
  version: string;
  event: string;
  data: unknown[];
}

export class EventFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventFormatError";
  }
}

/** Every NEP-297 line of `logs`, in order. Lines that are not `EVENT_JSON:` are skipped. */
export function parseEventLines(logs: readonly string[]): NepEvent[] {
  const out: NepEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith(EVENT_PREFIX)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(EVENT_PREFIX.length));
    } catch {
      continue;
    }
    const e = parsed as Partial<NepEvent> | null;
    if (typeof e !== "object" || e === null || typeof e.standard !== "string" || typeof e.event !== "string") continue;
    const data = e.data === undefined ? [] : Array.isArray(e.data) ? (e.data as unknown[]) : [e.data];
    out.push({ standard: e.standard, version: typeof e.version === "string" ? e.version : "", event: e.event, data });
  }
  return out;
}

/** Every item of every `multiverse` line named `name`, flattened in log order. */
export function multiverseItems<T = unknown>(logs: readonly string[], name: string): T[] {
  const out: T[] = [];
  for (const e of parseEventLines(logs)) {
    if (e.standard !== "multiverse") continue;
    if (!MULTIVERSE_VERSIONS.includes(e.version)) {
      throw new EventFormatError(`multiverse event "${e.event}" has version ${JSON.stringify(e.version)}; this tooling reads ${MULTIVERSE_VERSIONS.join(" and ")}`);
    }
    if (e.event === name) out.push(...(e.data as T[]));
  }
  return out;
}

/** The `data` entries of every NEP-297 "multiverse" event named `name` in `logs` (v1 name, kept). */
export const multiverseEvents = (logs: readonly string[], name: string): unknown[] => multiverseItems<unknown>(logs, name);

/** The one item of a kind, or an error naming how many there were. */
export function onlyOne<T>(items: readonly T[], what: string): T {
  if (items.length !== 1) throw new EventFormatError(`expected one ${what}, found ${items.length}`);
  return items[0] as T;
}

export interface Fill {
  scenarioId: number;
  taker: string;
  orderId: string;
  amount: bigint;
  usdcAmount: bigint;
  remaining: bigint;
}

interface OrderFilledItem {
  order_id: string;
  scenario_id: number;
  taker: string;
  amount: U128;
  usdc_amount: U128;
  remaining: U128;
}

interface OrdersFilledItem {
  scenario_id: number;
  taker: string;
  fills: [string, U128, U128, U128][];
}

/** Every order fill in the logs: direct `order_filled` lines and the `orders_filled` groups of trades, in order. */
export function orderFills(logs: readonly string[]): Fill[] {
  const out: Fill[] = [];
  for (const e of parseEventLines(logs)) {
    if (e.standard !== "multiverse") continue;
    if (!MULTIVERSE_VERSIONS.includes(e.version)) throw new EventFormatError(`multiverse event "${e.event}" has version ${JSON.stringify(e.version)}`);
    if (e.event === "order_filled") {
      for (const raw of e.data as OrderFilledItem[]) {
        out.push({
          scenarioId: raw.scenario_id,
          taker: raw.taker,
          orderId: String(raw.order_id),
          amount: u128(raw.amount, "order_filled.amount"),
          usdcAmount: u128(raw.usdc_amount, "order_filled.usdc_amount"),
          remaining: u128(raw.remaining, "order_filled.remaining"),
        });
      }
    } else if (e.event === "orders_filled") {
      for (const item of e.data as OrdersFilledItem[]) {
        if (!Array.isArray(item.fills)) throw new EventFormatError("orders_filled item without fills");
        for (const [orderId, amount, usdc, remaining] of item.fills) {
          out.push({
            scenarioId: item.scenario_id,
            taker: item.taker,
            orderId: String(orderId),
            amount: u128(amount, "orders_filled.amount"),
            usdcAmount: u128(usdc, "orders_filled.usdc_amount"),
            remaining: u128(remaining, "orders_filled.remaining"),
          });
        }
      }
    }
  }
  return out;
}

// Payloads the scripts read (SPEC-C 3.10). Absent `tier` = Normal.

export const tierOf = (item: { tier?: Tier }): Tier => item.tier ?? "normal";

export interface LiquidateEvent {
  scenario_id: number;
  account_id: string;
  liquidator_id: string;
  repaid: U128;
  shares: U128;
  pieces: string[];
  seized: U128[];
  c_min: U128;
  worst_world: number;
  tier?: Tier;
  receive?: Receive;
  seize_all?: boolean;
  written_off?: U128;
  price_factor?: U128;
}

export interface CashOutEvent {
  scenario_id: number;
  tier?: Tier;
  liquidator_id: string;
  account_id: string;
  sold: U128[];
  received: U128[];
  merged: U128;
  real_usdc: U128;
  redeemed: U128;
  cash: U128;
  min_out: U128;
  left_usdc: U128[];
  dead: string[];
}

export interface BadDebtEvent {
  scenario_id: number;
  tier?: Tier;
  account_id: string;
  caller_id: string;
  debt: U128;
  covered: U128;
  socialized: U128;
  insurance_after: U128;
  total_supply_after: U128;
}

export interface AccrueEvent {
  scenario_id: number;
  tier?: Tier;
  interest: U128;
  to_insurance?: U128;
}

export interface PledgedEvent {
  proposal_id: number;
  account_id: string;
  asset: "wnear" | "usdc";
  amount: U128;
  escrow_wnear: U128;
  escrow_usdc: U128;
}

export interface MarketOpenedEvent {
  proposal_id: number;
  scenario_id: number;
  event_id: number | null;
  opener: string;
  s_ref: U128;
  pledged_wnear: U128;
  pledged_usdc: U128;
  used_wnear: U128;
  used_usdc: U128;
  shares: U128;
  pool_ids: number[];
  unlock_at_sec: number;
  storage_bytes: number;
  storage_cost: U128;
}

export interface ProposalCreatedEvent {
  proposal_id: number;
  kind: "new_event" | "market";
  proposer: string;
  event_ids: number[];
  world_count: number;
  goal: U128;
  ideal_wnear: U128;
  ideal_usdc: U128;
  s_hint: U128;
  expires_at_sec: number;
  bond: U128;
  reserve: U128;
}

export interface ContractUpgradedEvent {
  from_state_version: number;
  to_state_version: number;
  from_code_version: string;
  code_version: string;
  accounts_upgraded: number;
  scenarios: number;
  pools: number;
  orders: number;
  paused: string[];
  legacy_scenario_count: number;
  lending: { legacy_markets: number; borrowers: number; v1_terms: number[]; frozen: number[]; unindexed: [number, U128][] } | null;
  catalog: { listed: number[]; references: number } | null;
}

export interface ReferenceUpdatedEvent {
  price: U128;
  observed_at: number;
  source: "outlayer" | "reporter";
  request: number;
  sources_used: number;
  spread_bps: number;
}

export interface ReferenceRejectedEvent {
  request: number;
  note: string;
}
