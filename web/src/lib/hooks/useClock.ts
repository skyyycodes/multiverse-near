"use client";

import { useSyncExternalStore } from "react";

// One shared one-second ticker for every countdown and open/closed check, read through useSyncExternalStore so render
// stays pure.
let wall = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(fn: () => void) {
  listeners.add(fn);
  if (!timer) {
    wall = Date.now();
    timer = setInterval(() => {
      wall = Date.now();
      listeners.forEach((l) => l());
    }, 1_000);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const snapshot = () => wall;

/** Wall-clock milliseconds, refreshed every second. */
export function useWallClock(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Wall-clock unix seconds as bigint: what the UI uses to decide whether an order has expired. */
export function useNowSeconds(): bigint {
  return BigInt(Math.floor(useWallClock() / 1000));
}

type Reading = { sec: bigint; at: number };

/**
 * The newest chain reading any screen has seen, projected forward by wall time. Kept per session so that one screen's
 * older snapshot (or a node a block behind) cannot pull the clock back.
 */
let latest: Reading | undefined;
const projected = (r: Reading, wallMs: number): bigint => r.sec + BigInt(Math.max(0, Math.floor((wallMs - r.at) / 1000)));

/** Keeps whichever reading puts the chain later now. Returns the reading in charge. */
export function noteChainTime(r: Reading, wallMs: number): Reading {
  if (!latest || projected(r, wallMs) > projected(latest, wallMs)) latest = r;
  return latest;
}

export function resetChainTime(): void {
  latest = undefined;
}

/**
 * Chain time for countdowns. `blockTime` is the newest block timestamp seen (a transaction is checked against chain
 * time, so buttons that must wait for a window gate on it). `now` ticks every second from the moment that block was
 * read and never steps back. A snapshot that is still placeholder data (`readAt` 0) does not move the clock.
 */
export function useChainClock(nowSec: bigint | undefined, readAt: number): { blockTime?: bigint; now?: bigint } {
  const w = useWallClock();
  const best = nowSec !== undefined && readAt > 0 ? noteChainTime({ sec: nowSec, at: readAt }, w) : latest;
  if (!best) return nowSec === undefined ? {} : { blockTime: nowSec, now: nowSec };
  return { blockTime: best.sec, now: projected(best, w) };
}
