import { Suspense } from "react";
import { TradeScreen } from "@/components/trade/TradeScreen";

export default function Page() {
  return (
    <Suspense>
      <TradeScreen focus="book" />
    </Suspense>
  );
}
