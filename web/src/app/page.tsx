import { Suspense } from "react";
import { MarketsScreen } from "@/components/markets/MarketsScreen";

export default function Page() {
  return (
    <Suspense>
      <MarketsScreen />
    </Suspense>
  );
}
