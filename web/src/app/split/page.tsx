import { Suspense } from "react";
import { MarketGuard } from "@/components/markets/MarketGuard";
import { PendingScreen } from "@/components/shell/PendingScreen";

export default function Page() {
  return (
    <Suspense>
      <MarketGuard>
        <PendingScreen title="Split and merge" demo="split" />
      </MarketGuard>
    </Suspense>
  );
}
