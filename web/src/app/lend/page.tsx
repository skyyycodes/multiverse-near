import { Suspense } from "react";
import { LendScreen } from "@/components/lend/LendScreen";
import { MarketGuard } from "@/components/markets/MarketGuard";

export default function Page() {
  return (
    <Suspense>
      <MarketGuard>
        <LendScreen />
      </MarketGuard>
    </Suspense>
  );
}
