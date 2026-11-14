import { Suspense } from "react";
import { MarketGuard } from "@/components/markets/MarketGuard";
import { WorldScreen } from "@/components/world/WorldScreen";

export default function Page() {
  return (
    <Suspense>
      <MarketGuard>
        <WorldScreen />
      </MarketGuard>
    </Suspense>
  );
}
