import { Suspense } from "react";
import { ProposalScreen } from "@/components/proposal/ProposalScreen";

export default function Page() {
  return (
    <Suspense>
      <ProposalScreen />
    </Suspense>
  );
}
