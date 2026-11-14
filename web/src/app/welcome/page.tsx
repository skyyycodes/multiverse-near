import { Suspense } from "react";
import { Landing } from "@/components/landing/Landing";

export default function Page() {
  return (
    <Suspense>
      <Landing />
    </Suspense>
  );
}
