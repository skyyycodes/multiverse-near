import { Suspense } from "react";
import { AdminScreen } from "@/components/admin/AdminScreen";
import { MarketGuard } from "@/components/markets/MarketGuard";

export default function Page() {
  return (
    <Suspense>
      <MarketGuard>
        <AdminScreen />
      </MarketGuard>
    </Suspense>
  );
}
