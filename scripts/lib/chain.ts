// Chain time. Dispute windows and the TWAP window are measured in block time, so the scripts wait
// for blocks, not for the wall clock. The local sandbox can skip ahead instead of waiting.

import { NETWORK, provider, RPC_URL } from "./near.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Seconds of the latest final block, the way the contract reads `block_timestamp`. */
export async function chainNowSec(): Promise<number> {
  const block = await provider.viewBlock({ finality: "final" });
  return Number(BigInt(block.header.timestamp_nanosec) / 1_000_000_000n);
}

/**
 * `chainNowSec` for long waits. A public RPC can refuse an address for minutes (429), longer than
 * near-api-js keeps retrying one request, and a half-hour wait should not die of it.
 */
async function chainNowSecPatient(): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await chainNowSec();
    } catch (err) {
      if (attempt >= 20) throw err;
      console.log(`    reading the latest block failed (${String(err).slice(0, 120)}); retrying in 30 s`);
      await sleep(30_000);
    }
  }
}

export async function chainHeight(): Promise<number> {
  return (await provider.viewBlock({ finality: "final" })).header.height;
}

/**
 * Sandbox only: produces `blocks` blocks at once, each moving block time forward. Returns once the
 * final block is past the jump. The node answers before it has made the jump, and a transaction
 * that references a block from before it is already older than the validity period (100 blocks)
 * when it arrives: "Transaction expired".
 */
export async function fastForward(blocks: number): Promise<void> {
  if (NETWORK !== "sandbox") throw new Error("fast-forward exists only on the sandbox");
  const target = (await provider.viewBlock({ finality: "optimistic" })).header.height + blocks;
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "ff", method: "sandbox_fast_forward", params: { delta_height: blocks } }),
  });
  const body = (await res.json()) as { error?: unknown };
  if (body.error) throw new Error(`sandbox_fast_forward failed: ${JSON.stringify(body.error)}`);
  const deadline = Date.now() + 60_000;
  while ((await chainHeight()) < target) {
    if (Date.now() > deadline) throw new Error(`sandbox_fast_forward: no final block at height ${target} after 60 s`);
    await sleep(100);
  }
}

/**
 * Returns once a final block is at or past `targetSec`. On the sandbox it skips blocks, measuring
 * how far each batch moved the clock; elsewhere it sleeps.
 */
export async function waitForChainTime(targetSec: number, label = "chain time"): Promise<number> {
  let now = await chainNowSecPatient();
  if (now >= targetSec) return now;
  console.log(`  waiting for ${label}: ${targetSec - now} s of block time`);
  let secPerBlock = 0.5;
  while (now < targetSec) {
    if (NETWORK === "sandbox") {
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
