import { Suspense } from "react";
import { MarketGuard } from "@/components/markets/MarketGuard";
import { SplitScreen } from "@/components/trade/SplitPanel";

export default function Page() {
  return (
    <Suspense>
      <MarketGuard>
        <SplitScreen />
      </MarketGuard>
    </Suspense>
  );
}
