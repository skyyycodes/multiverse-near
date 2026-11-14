// Chain time. Dispute windows and the TWAP window are measured in block time, so the scripts wait
// for blocks, not for the wall clock. Sandbox chains (the sandbox and the rehearsal node) can skip
// ahead instead of waiting.

import { CHAIN, provider, RPC_URL } from "./near.ts";
import { errorText } from "./rpc.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface BlockInfo {
  height: number;
  hash: string;
  /** Block time in whole seconds, the way the contract reads `block_timestamp`. */
  timestampSec: number;
}

const toInfo = (header: { height: number; hash: string; timestamp_nanosec: string | number }): BlockInfo => ({
  height: header.height,
  hash: header.hash,
  timestampSec: Number(BigInt(header.timestamp_nanosec) / 1_000_000_000n),
});

/** Seconds of the latest final block, the way the contract reads `block_timestamp`. */
export async function chainNowSec(): Promise<number> {
  const block = await provider.viewBlock({ finality: "final" });
  return Number(BigInt(block.header.timestamp_nanosec) / 1_000_000_000n);
}

/** The block at `height` (its hash and time): the clock a pinned check reads. */
export async function blockAt(height: number): Promise<BlockInfo> {
  return toInfo((await provider.viewBlock({ blockId: height })).header);
}

/** The latest final block. */
export async function finalBlock(): Promise<BlockInfo> {
  return toInfo((await provider.viewBlock({ finality: "final" })).header);
}

/**
 * `chainNowSec` for long waits. The pool already waits out rate limits for up to 15 minutes; a
 * half-hour wait should survive even a longer outage of every endpoint.
 */
async function chainNowSecPatient(): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await chainNowSec();
    } catch (err) {
      if (attempt >= 5) throw err;
      console.log(`    reading the latest block failed (${errorText(err).slice(0, 120)}); retrying in 30 s`);
      await sleep(30_000);
    }
  }
}

export async function chainHeight(): Promise<number> {
  return (await provider.viewBlock({ finality: "final" })).header.height;
}

/** Waits until the final block is at or past `height` (a pinned read of `height` then succeeds everywhere). */
export async function waitForFinalHeight(height: number, timeoutMs = 120_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const h = await chainHeight();
    if (h >= height) return h;
    if (Date.now() > deadline) throw new Error(`no final block at height ${height} after ${timeoutMs / 1000} s (final is ${h})`);
    await sleep(CHAIN === "sandbox" ? 100 : 1_000);
  }
}

/**
 * Sandbox chains only: produces `blocks` blocks at once, each moving block time forward. Returns
 * once the final block is past the jump. The node answers before it has made the jump, and a
 * transaction that references a block from before it is already older than the validity period
 * (100 blocks) when it arrives: "Transaction expired".
 */
export async function fastForward(blocks: number): Promise<void> {
  if (CHAIN !== "sandbox") throw new Error("fast-forward exists only on a sandbox chain (sandbox, rehearsal)");
  const target = (await provider.viewBlock({ finality: "optimistic" })).header.height + blocks;
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "ff", method: "sandbox_fast_forward", params: { delta_height: blocks } }),
  });
  const body = (await res.json()) as { error?: unknown };
  if (body.error) throw new Error(`sandbox_fast_forward failed: ${JSON.stringify(body.error)}`);
  await waitForFinalHeight(target, 60_000);
}

/**
 * Returns once a final block is at or past `targetSec`. On a sandbox chain it skips blocks,
 * measuring how far each batch moved the clock; elsewhere it sleeps.
 */
export async function waitForChainTime(targetSec: number, label = "chain time"): Promise<number> {
  let now = await chainNowSecPatient();
  if (now >= targetSec) return now;
  console.log(`  waiting for ${label}: ${targetSec - now} s of block time`);
  let secPerBlock = 0.5;
  while (now < targetSec) {
    if (CHAIN === "sandbox") {
      const blocks = Math.min(2_000, Math.max(2, Math.ceil((targetSec - now) / secPerBlock) + 2));
      const before = now;
      await fastForward(blocks);
      now = await chainNowSec();
      if (now > before) secPerBlock = Math.max(0.05, (now - before) / blocks);
    } else {
      await sleep(Math.min(30_000, (targetSec - now) * 1_000 + 1_500));
      now = await chainNowSecPatient();
    }
  }
  return now;
}
