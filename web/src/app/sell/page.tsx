import { Suspense } from "react";
import { MarketGuard } from "@/components/markets/MarketGuard";
import { TradeScreen } from "@/components/trade/TradeScreen";

export default function Page() {
  return (
    <Suspense>
      <MarketGuard>
        <TradeScreen focus="sell" />
      </MarketGuard>
    </Suspense>
  );
}
