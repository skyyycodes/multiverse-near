import { Suspense } from "react";
import { AtRiskScreen } from "@/components/liquidate/AtRiskScreen";

export default function Page() {
  return (
    <Suspense>
      <AtRiskScreen />
    </Suspense>
  );
}
