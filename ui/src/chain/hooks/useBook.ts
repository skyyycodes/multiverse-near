"use client";

// Reads of the order book screen beyond the trade view: the world pool's reserves and fee, which the screen prices its
// pool legs with (book.ts runs the contract's own maths on them, so a quote equals execution).
import { useMemo } from "react";
import type { PoolState } from "../book";
import { usePool } from "./useData";

/** One world pool as book.ts prices it; null without a pool (or an empty one), undefined while loading. */
export function usePoolState(poolId: number | null | undefined): PoolState | null | undefined {
  const q = usePool(poolId);
  const p = q.data;
  return useMemo(() => {
    if (poolId === null) return null;
    if (p === undefined) return undefined;
    if (p === null || !p.wnearReserve || !p.usdcReserve || p.feePips === undefined) return null;
    return { wnear: p.wnearReserve, usdc: p.usdcReserve, feePips: p.feePips };
  }, [p, poolId]);
}
