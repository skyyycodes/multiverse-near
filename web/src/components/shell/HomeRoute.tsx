"use client";

import { MarketGuard } from "@/components/markets/MarketGuard";
import { useLandingVisible } from "@/components/landing/Landing";
import { TradeScreen } from "@/components/trade/TradeScreen";

/**
 * `/`: the landing on a first, signed-out visit, else the trade home of the last market opened here (or the demo
 * market). `/` keeps its address: the market list takes this route, so no id is written into it.
 */
export function HomeRoute() {
  const firstVisit = useLandingVisible();
  if (firstVisit) return <TradeScreen />;
  return (
    <MarketGuard rewrite={false}>
      <TradeScreen />
    </MarketGuard>
  );
}
