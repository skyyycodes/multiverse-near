import { Suspense } from "react";
import { MarketGuard } from "@/components/markets/MarketGuard";
import { ResolveScreen } from "@/components/resolve/ResolveScreen";

export default function Page() {
  return (
    <Suspense>
      <MarketGuard>
        <ResolveScreen />
      </MarketGuard>
    </Suspense>
  );
}
