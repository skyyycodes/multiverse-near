import { Suspense } from "react";
import { ProposeScreen } from "@/components/propose/ProposeScreen";

export default function Page() {
  return (
    <Suspense>
      <ProposeScreen />
    </Suspense>
  );
}
