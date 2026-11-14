import { Suspense } from "react";
import { PendingScreen } from "@/components/shell/PendingScreen";

export default function Page() {
  return (
    <Suspense>
      <PendingScreen title="At-risk loans" demo="liquidate" />
    </Suspense>
  );
}
