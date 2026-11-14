// The RPC endpoint pool every script talks through. Public testnet RPCs answer 429 within seconds
// under a soak or a bot, and near-api-js throws a 429 or a 502 at once, so the pool shapes the
// traffic itself: a token bucket per endpoint, jittered exponential cooling after a rate limit,
// failover to the next endpoint, and an optional API key for fastnear hosts.
//
// Reads are retried here. Sends are not (`retry: false`): the send loop in near.ts decides, from
// the transaction's status, whether to re-broadcast the same signed bytes (S-5).

import { JsonRpcProvider, type Provider } from "near-api-js";
import {
  GarbageCollectedBlockError,
  InternalRpcError,
  InvalidNonceError,
  LackBalanceForStateActionError,
  NoSyncedBlocksError,
  NodeIsSyncingError,
  NotEnoughBalanceError,
  NotSyncedYetError,
  ShardNotAppliedError,
  TransactionExpiredError,
  TransactionTimeoutError,
  UnknownBlockError,
  UnknownTransactionError,
  UnknownTransactionOrReceiptError,
} from "near-api-js/rpc-errors";

export interface Endpoint {
  url: string;
  headers: Record<string, string>;
  /** Requests per second this endpoint takes from us; the bucket holds two seconds of them. */
  rps: number;
}

export interface EndpointStats {
  url: string;
  calls: number;
  rateLimited: number;
  errors: number;
  /** Epoch ms until which the endpoint is skipped (0 = available). */
  coolingUntil: number;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** What `run` does with a failure: retry elsewhere, or hand it to the caller. */
export type RpcErrorClass = "rate_limited" | "transient" | "invalid_nonce" | "expired" | "timeout" | "unknown_tx" | "fatal";

export class RpcExhausted extends Error {
  constructor(label: string, waitedMs: number, last: unknown) {
    super(`RpcExhausted(${label}): every endpoint kept failing for ${Math.round(waitedMs / 1000)} s; last error: ${errorText(last)}`);
    this.name = "RpcExhausted";
  }
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

function causeOf(err: unknown): unknown {
  return typeof err === "object" && err !== null && "cause" in err ? (err as { cause: unknown }).cause : undefined;
}

function nameOf(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const named = err as { name?: unknown; type?: unknown };
  return `${typeof named.name === "string" ? named.name : ""} ${typeof named.type === "string" ? named.type : ""}`;
}

const FETCH_FAILURE = /fetch failed|failed to fetch|FetchError|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|UND_ERR|network error|other side closed/i;

/**
 * Sorts an RPC failure into what the pool and the send loop do with it. The two balance errors
 * are fatal and keep their own text: no retry or other endpoint can fix a signer that cannot pay.
 */
export function classifyRpcError(err: unknown): RpcErrorClass {
  const text = `${nameOf(err)} ${errorText(err)}`;
  const cause = causeOf(err);
  if (err instanceof NotEnoughBalanceError || err instanceof LackBalanceForStateActionError) return "fatal";
  if (/NotEnoughBalance|LackBalanceForState/.test(text)) return "fatal";
  if (cause === 429 || /too many requests|rate.?limit/i.test(text)) return "rate_limited";
  if (err instanceof InvalidNonceError || /InvalidNonce/.test(text)) return "invalid_nonce";
  if (err instanceof TransactionExpiredError || /TransactionExpired|\bExpired\b/.test(text)) return "expired";
  if (err instanceof TransactionTimeoutError || /TIMEOUT_ERROR|TransactionTimeout/.test(text)) return "timeout";
  if (err instanceof UnknownTransactionError || err instanceof UnknownTransactionOrReceiptError || /UNKNOWN_TRANSACTION|UnknownTransaction/.test(text)) {
    return "unknown_tx";
  }
  if (cause === 500 || cause === 502 || cause === 503 || cause === 504 || cause === 408) return "transient";
  if (
    err instanceof UnknownBlockError ||
    err instanceof NodeIsSyncingError ||
    err instanceof NoSyncedBlocksError ||
    err instanceof NotSyncedYetError ||
    err instanceof ShardNotAppliedError ||
    err instanceof InternalRpcError
  ) {
    return "transient";
  }
  if (/UNKNOWN_BLOCK|UnknownBlock|NodeIsSyncing|NO_SYNCED_BLOCKS|NOT_SYNCED_YET|RetriesExceeded/.test(text)) return "transient";
  if (FETCH_FAILURE.test(text)) return "transient";
  return "fatal";
}

/** A block the node no longer has (garbage collected) or never had: the archival pool may. */
export function isMissingBlock(err: unknown): boolean {
  if (err instanceof UnknownBlockError || err instanceof GarbageCollectedBlockError) return true;
  return /UNKNOWN_BLOCK|UnknownBlock|GARBAGE_COLLECTED_BLOCK|GarbageCollectedBlock/.test(`${nameOf(err)} ${errorText(err)}`);
}

/** A transaction hash the node does not know (never seen, or older than its history). */
export function isUnknownTransaction(err: unknown): boolean {
  return classifyRpcError(err) === "unknown_tx";
}

/** Cooling after the k-th consecutive rate limit: min(600 s, 2 s × 2^(k−1)) × (0.5 + rand). */
export function backoffMs(attempt: number, rand: () => number): number {
  const k = Math.max(1, Math.floor(attempt));
  const base = Math.min(600_000, 2_000 * 2 ** Math.min(30, k - 1));
  return Math.round(base * (0.5 + rand()));
}

const FASTNEAR_HOST = /(^|\.)fastnear\.com$/i;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Default budget per endpoint: fastnear 4 rps, drpc 2, a local sandbox 50, anything else 2. */
export function defaultRps(url: string): number {
  const host = hostOf(url);
  if (host === "127.0.0.1" || host === "localhost") return 50;
  if (FASTNEAR_HOST.test(host)) return 4;
  return 2;
}

/** `Authorization: Bearer <key>` for fastnear hosts only, so the key never leaks to another provider. */
export function headersFor(url: string, apiKey: string | undefined): Record<string, string> {
  return apiKey && FASTNEAR_HOST.test(hostOf(url)) ? { Authorization: `Bearer ${apiKey}` } : {};
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface EndpointSource {
  /** The network's own list, first = primary. */
  rpcUrls: readonly string[];
}

/**
 * The endpoints for a network: `NEAR_RPC_URLS` (comma list) or the older single `NEAR_RPC_URL`
 * override the network's list; `NEAR_RPC_RPS` sets every endpoint's budget.
 */
export function endpointsFromEnv(cfg: EndpointSource, env: NodeJS.ProcessEnv = process.env): Endpoint[] {
  const listed = parseList(env.NEAR_RPC_URLS);
  const urls = listed.length > 0 ? listed : env.NEAR_RPC_URL ? [env.NEAR_RPC_URL] : [...cfg.rpcUrls];
  return endpointsFor(urls, env);
}

/** Endpoints for an explicit url list (used for the archival pool too). */
export function endpointsFor(urls: readonly string[], env: NodeJS.ProcessEnv = process.env): Endpoint[] {
  if (urls.length === 0) throw new Error("no RPC endpoint configured");
  const rps = env.NEAR_RPC_RPS ? Number(env.NEAR_RPC_RPS) : undefined;
  if (rps !== undefined && !(Number.isFinite(rps) && rps > 0)) throw new Error(`NEAR_RPC_RPS must be a positive number, not "${env.NEAR_RPC_RPS}"`);
  return urls.map((url) => ({ url, headers: headersFor(url, env.FASTNEAR_API_KEY), rps: rps ?? defaultRps(url) }));
}

interface Slot<P> {
  endpoint: Endpoint;
  provider: P;
  tokens: number;
  refilledAt: number;
  coolingUntil: number;
  consecutive429: number;
  stats: EndpointStats;
}

export interface RunOptions {
  label?: string;
  /** How long to wait while every endpoint is cooling before giving up. Default 15 min. */
  maxWaitMs?: number;
  /** Retry rate limits and transient failures on the next endpoint. False for sends. Default true. */
  retry?: boolean;
}

const DEFAULT_MAX_WAIT_MS = 15 * 60_000;
const TRANSIENT_COOL_MS = 1_000;

/** Every provider is built with `retries: 1`, so the pool, not the library, decides retries. */
export const makeJsonRpcProvider = (e: Endpoint): JsonRpcProvider =>
  new JsonRpcProvider({ url: e.url, headers: e.headers }, { retries: 1, wait: 0, backoff: 1 });

export class RpcPool<P = JsonRpcProvider> {
  private readonly slots: Slot<P>[];
  private readonly clock: Clock;
  private readonly rand: () => number;

  constructor(
    endpoints: Endpoint[],
    clock: Clock = systemClock,
    rand: () => number = Math.random,
    makeProvider: (e: Endpoint) => P = makeJsonRpcProvider as unknown as (e: Endpoint) => P,
  ) {
    if (endpoints.length === 0) throw new Error("RpcPool needs at least one endpoint");
    this.clock = clock;
    this.rand = rand;
    const now = clock.now();
    this.slots = endpoints.map((endpoint) => {
      if (!(endpoint.rps > 0)) throw new Error(`endpoint ${endpoint.url}: rps must be positive`);
      return {
        endpoint,
        provider: makeProvider(endpoint),
        tokens: 2 * endpoint.rps,
        refilledAt: now,
        coolingUntil: 0,
        consecutive429: 0,
        stats: { url: endpoint.url, calls: 0, rateLimited: 0, errors: 0, coolingUntil: 0 },
      };
    });
  }

  get size(): number {
    return this.slots.length;
  }

  stats(): EndpointStats[] {
    return this.slots.map((s) => ({ ...s.stats, coolingUntil: s.coolingUntil }));
  }

  private refill(slot: Slot<P>, now: number): void {
    const capacity = 2 * slot.endpoint.rps;
    const elapsed = Math.max(0, now - slot.refilledAt);
    slot.tokens = Math.min(capacity, slot.tokens + (elapsed * slot.endpoint.rps) / 1000);
    slot.refilledAt = now;
  }

  /**
   * The first endpoint (in order) that is not cooling and has a token, preferring those that have
   * not failed during this run; otherwise how long until one has.
   */
  private pick(now: number, failedHere: Set<Slot<P>>): { slot: Slot<P> } | { waitMs: number } {
    let wait = Number.POSITIVE_INFINITY;
    for (const preferFresh of [true, false]) {
      for (const slot of this.slots) {
        if (preferFresh === failedHere.has(slot)) continue;
        if (slot.coolingUntil > now) {
          wait = Math.min(wait, slot.coolingUntil - now);
          continue;
        }
        this.refill(slot, now);
        if (slot.tokens >= 1) {
          slot.tokens -= 1;
          return { slot };
        }
        wait = Math.min(wait, Math.ceil(((1 - slot.tokens) * 1000) / slot.endpoint.rps));
      }
    }
    return { waitMs: Math.max(1, wait) };
  }

  /**
   * Runs `task` on the healthiest endpoint. A rate limit cools that endpoint (jittered exponential)
   * and a transient failure cools it for a second; with `retry` the task then moves to the next
   * endpoint. Every other failure goes straight to the caller.
   */
  async run<T>(task: (p: P) => Promise<T>, opts: RunOptions = {}): Promise<T> {
    const label = opts.label ?? "rpc";
    const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const retry = opts.retry ?? true;
    const started = this.clock.now();
    const maxTransient = 2 * this.slots.length + 2;
    let transientFailures = 0;
    let last: unknown;
    // endpoints that just failed this run are tried last
    const failedHere = new Set<Slot<P>>();
    for (;;) {
      const now = this.clock.now();
      const picked = this.pick(now, failedHere);
      if ("waitMs" in picked) {
        if (now - started + picked.waitMs > maxWaitMs) throw new RpcExhausted(label, now - started, last ?? "every endpoint is cooling");
        await this.clock.sleep(picked.waitMs);
        continue;
      }
      const slot = picked.slot;
      slot.stats.calls += 1;
      try {
        const value = await task(slot.provider);
        slot.consecutive429 = 0;
        return value;
      } catch (err) {
        last = err;
        const kind = classifyRpcError(err);
        const at = this.clock.now();
        if (kind === "rate_limited") {
          slot.stats.rateLimited += 1;
          slot.consecutive429 += 1;
          slot.coolingUntil = at + backoffMs(slot.consecutive429, this.rand);
        } else if (kind === "transient" || (kind === "timeout" && retry)) {
          slot.stats.errors += 1;
          slot.coolingUntil = Math.max(slot.coolingUntil, at + TRANSIENT_COOL_MS);
          transientFailures += 1;
        } else {
          slot.stats.errors += 1;
          throw err;
        }
        if (!retry) throw err;
        if (kind !== "rate_limited" && transientFailures > maxTransient) throw err;
        if (at - started > maxWaitMs) throw new RpcExhausted(label, at - started, err);
        failedHere.add(slot);
        if (failedHere.size >= this.slots.length) failedHere.clear();
      }
    }
  }
}

/**
 * A `Provider` whose every method runs through `pool.run`, so code written against one provider
 * (near-api-js `Account`, the existing helpers) gets the pool's shaping and failover unchanged.
 */
export function pooledProvider<P extends object>(pool: RpcPool<P>, label = "provider"): Provider {
  return new Proxy({} as Provider, {
    get(_target, prop) {
      // not a thenable: `await provider` must not turn into an RPC call
      if (typeof prop !== "string" || prop === "then") return undefined;
      return (...args: unknown[]) =>
        pool.run((p) => {
          const fn = (p as unknown as Record<string, unknown>)[prop];
          if (typeof fn !== "function") throw new Error(`the RPC provider has no method ${prop}`);
          return (fn as (...a: unknown[]) => Promise<unknown>).apply(p, args);
        }, { label: `${label}.${prop}` });
    },
  });
}
