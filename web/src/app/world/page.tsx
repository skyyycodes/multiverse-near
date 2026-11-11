import { Suspense } from "react";
import { WorldScreen } from "@/components/world/WorldScreen";

export default function Page() {
  return (
    <Suspense>
      <WorldScreen />
    </Suspense>
  );
}
