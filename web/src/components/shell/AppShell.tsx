"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { startKeeperPings } from "@/lib/keeper-ping";
import { ScenarioProvider } from "@/lib/hooks/useScenario";
import { useLandingVisible } from "@/components/landing/Landing";
import { useIsDesktop } from "@/lib/hooks/useMedia";
import { WalletProvider } from "@/lib/near/wallet";
import { Banners } from "./Banners";
import { BottomNav } from "./BottomNav";
import { TopBar } from "./TopBar";

const FixturePicker =
  process.env.NEXT_PUBLIC_FIXTURES === "1" ? lazy(() => import("./FixturePicker").then((m) => ({ default: m.FixturePicker }))) : null;

export default function AppShell({ children }: { children: ReactNode }) {
  // One client per session; snapshots count as fresh for 2 s so screens sharing a view do not refetch on mount.
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 2_000 } } }));
  useEffect(() => startKeeperPings(), []);
  return (
    <QueryClientProvider client={client}>
      <WalletProvider>
        <ScenarioProvider>
          <Chrome>{children}</Chrome>
          {FixturePicker && (
            <Suspense fallback={null}>
              <FixturePicker />
            </Suspense>
          )}
        </ScenarioProvider>
      </WalletProvider>
    </QueryClientProvider>
  );
}

function Chrome({ children }: { children: ReactNode }) {
  const desktop = useIsDesktop();
  const path = usePathname();
  const firstVisit = useLandingVisible();
  const landing = path?.startsWith("/welcome") || ((path === "/" || path === "") && firstVisit);
  return (
    <div className={`relative min-h-dvh ${desktop ? "bg-stage" : "bg-sheet"}`}>
      {desktop && !landing && <TopBar />}
      {desktop && !landing && <Banners />}
      {children}
      {!desktop && !landing && <BottomNav />}
    </div>
  );
}
