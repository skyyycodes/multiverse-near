"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { Mark } from "@/components/brand/Mark";
import { Prelaunch } from "./Prelaunch";

// The wallet connector and every chain read live in the browser, so the app shell is never rendered on the server.
// The static export ships this loading state as the page's HTML.
const AppShell = dynamic(() => import("./AppShell"), {
  ssr: false,
  loading: () => (
    <div className="grid min-h-dvh place-items-center bg-navy-900">
      <div className="flex flex-col items-center gap-3 text-[13px] text-white/60">
        <Mark size={40} bright={0} />
        <span>Loading…</span>
      </div>
    </div>
  ),
});

export function ClientShell({ children }: { children: ReactNode }) {
  // Tested literally: the pre-launch build renders the notice on every route (into the static HTML) and never mounts
  // the app, so no screen reads the chain.
  if (process.env.NEXT_PUBLIC_PRELAUNCH === "1") return <Prelaunch />;
  return <AppShell>{children}</AppShell>;
}
