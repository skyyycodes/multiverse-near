import { Suspense } from "react";
import { AdminScreen } from "@/components/admin/AdminScreen";

// Not behind MarketGuard: the owner opens Admin right after a fresh deploy, before any market exists; the screen
// shows its market blocks only for a market the contract confirms.
export default function Page() {
  return (
    <Suspense>
      <AdminScreen />
    </Suspense>
  );
}
