// Resolution through OutLayer, the parts that need no chain: the argument checks the contract
// makes (so a bad value fails here, not in a transaction), whether the stored config and dates are
// already what was asked for, and reading the contract's OutLayer events back out of a
// transaction's logs.

import { createHash } from "node:crypto";

import { multiverseEvents } from "./events.ts";
import type { EventView } from "./protocol.ts";

/** `get_outlayer_config`, as the contract serializes it. */
export interface OutLayerConfig {
  outlayer_id: string;
  wasm_url: string;
  wasm_sha256: string;
  resource_limits: { max_instructions: number; max_memory_mb: number; max_execution_seconds: number };
  /** yoctoNEAR a request must attach at least. */
  deposit: string;
}

/** `get_outlayer_dates`: the event's two FRED dates and the number of its latest run. */
export interface FomcDates {
  before: string;
  after: string;
  pending: boolean;
  request: number;
}

/** The contract's `outlayer_result` event: what the guest answered and whether it became a proposal. */
export interface OutLayerResultLog {
  event_id: number;
  request: number;
  outcome: number | null;
  proposed: boolean;
  /** The guest's evidence, or why nothing was proposed. */
  note: string;
}

const MAX_WASM_URL_BYTES = 2048;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The URL checks OutLayer makes and set_outlayer_config repeats, in the same order. */
function wasmUrlError(url: string): string | undefined {
  if (!url.startsWith("https://") || url.length <= "https://".length) return "not https";
  if (Buffer.byteLength(url) > MAX_WASM_URL_BYTES) return "too long";
  if (/[\s\p{Cc}]/u.test(url)) return "whitespace";
  if (url.includes("EVENT_JSON")) return "EVENT_JSON";
  return undefined;
}

export function parseWasmUrl(url: string): string {
  const why = wasmUrlError(url);
  if (why) throw new Error(`--url ${JSON.stringify(url)} is unusable (${why})`);
  return url;
}

/** 64 lowercase hex characters, as OutLayer and the contract want them. */
export function parseSha256(value: string): string {
  if (!SHA256_HEX.test(value)) throw new Error(`--sha256 must be 64 lowercase hex characters, not "${value}"`);
  return value;
}

/** Two `YYYY-MM-DD` dates, `before` earlier than `after` (the contract compares them as strings). */
export function parseDates(before: string, after: string): { before: string; after: string } {
  for (const [name, value] of [["before", before], ["after", after]] as const) {
    if (!DATE.test(value)) throw new Error(`--${name} must be YYYY-MM-DD, not "${value}"`);
  }
  if (before >= after) throw new Error(`--before ${before} is not earlier than --after ${after}`);
  return { before, after };
}

/**
 * Why `e` cannot take these dates, or null when it can: it must be open, have two outcomes named
 * CUTS and HOLDS, and the rule stored with it must name both dates.
 */
export function datesMisfit(e: EventView, before: string, after: string): string | null {
  if (e.finalized) return `event ${e.id} is already finalized`;
  if (e.outcome_names.join(",") !== "CUTS,HOLDS") return `event ${e.id} has outcomes ${e.outcome_names.join("/")}, not CUTS/HOLDS`;
  const missing = [before, after].filter((d) => !e.rule.includes(d));
  if (missing.length > 0) return `the rule of event ${e.id} does not mention ${missing.join(" or ")}: "${e.rule}"`;
  return null;
}

export const configMatches = (current: OutLayerConfig | null, url: string, sha256: string): boolean =>
  current !== null && current.wasm_url === url && current.wasm_sha256 === sha256;

/** Setting the same dates again would only make a run in flight stale, so equal dates are left alone. */
export const datesMatch = (current: FomcDates | null, before: string, after: string): boolean =>
  current !== null && current.before === before && current.after === after;

/** The `data` entries of every NEP-297 "multiverse" event named `name` in `logs` (events.ts, versions 1.0.0 and 2.0.0). */
export { multiverseEvents };

/** The `outlayer_result` of one run, if the logs hold it. */
export function outlayerResult(logs: readonly string[], eventId: number, request: number): OutLayerResultLog | undefined {
  return multiverseEvents(logs, "outlayer_result")
    .map((d) => d as OutLayerResultLog)
    .find((d) => d.event_id === eventId && d.request === request);
}
