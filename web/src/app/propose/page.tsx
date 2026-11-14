import { Suspense } from "react";
import { PendingScreen } from "@/components/shell/PendingScreen";

export default function Page() {
  return (
    <Suspense>
      <PendingScreen title="Propose a new market" demo="propose" />
    </Suspense>
  );
}
