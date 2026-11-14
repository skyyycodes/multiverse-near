import { Suspense } from "react";
import { PendingScreen } from "@/components/shell/PendingScreen";

export default function Page() {
  return (
    <Suspense>
      <PendingScreen title="Proposal" demo="proposal" />
    </Suspense>
  );
}
