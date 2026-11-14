import { Suspense } from "react";
import { HomeRoute } from "@/components/shell/HomeRoute";

export default function Page() {
  return (
    <Suspense>
      <HomeRoute />
    </Suspense>
  );
}
