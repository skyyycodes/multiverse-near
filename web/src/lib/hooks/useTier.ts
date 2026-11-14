"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { CONTRACT_ID } from "../data/client";
import type { LendingTier, Tier } from "../domain";
import { parseTier, resolveTier } from "../tiers";
import { useCollateralTier } from "./useScenario";

/**
 * The tier a Borrow or Lend screen shows (URL `tier`, else the market's remembered tier, else the account's position,
 * else Normal) and the picker's setter: the URL follows (`href(tier)`, Normal never in it) and the market remembers.
 */
export function useScreenTier(sid: number, tiers: readonly LendingTier[] | undefined, mode: "borrow" | "lend", href: (sid: number, tier: Tier) => string) {
  const params = useSearchParams();
  const router = useRouter();
  const { tier: remembered, setTier } = useCollateralTier(`${CONTRACT_ID}:${sid}`);
  const url = params.get("tier");
  const tier = resolveTier(url, remembered, tiers, mode);
  // Without a URL tier or a remembered one the position decides, so wait for the tiers before reading a tier's view.
  const ready = Boolean(parseTier(url) || remembered || tiers);
  const pick = useCallback(
    (t: Tier) => {
      setTier(t);
      router.replace(href(sid, t), { scroll: false });
    },
    [setTier, router, href, sid],
  );
  return { tier, pick, ready };
}
