import { Suspense } from "react";
import { BorrowScreen } from "@/components/borrow/BorrowScreen";
import { MarketGuard } from "@/components/markets/MarketGuard";

export default function Page() {
  return (
    <Suspense>
      <MarketGuard>
        <BorrowScreen />
      </MarketGuard>
    </Suspense>
  );
}
