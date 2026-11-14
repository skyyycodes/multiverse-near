"use client";

import Link from "next/link";
import { Screen } from "@/components/shell/Screen";
import { ConfigGuard } from "@/components/trade/Guard";
import { Notice } from "@/components/ui/Notice";
import { marketsHref } from "@/lib/links";

/**
 * The shell of a route whose screen is not in this build yet (the v2 routes are created with the navigation; each
 * screen's package fills its page). Behind the config and version guard like every screen.
 */
export function PendingScreen({ title, demo }: { title: string; demo: string }) {
  return (
    <ConfigGuard>
      {() => (
        <Screen
          demo={demo}
          hero={<h1 className="font-display text-[30px] leading-[1.08] font-medium tracking-[-0.015em]">{title}</h1>}
        >
          <Notice title="Not in this build yet">
            This page is part of the next release.{" "}
            <Link href={marketsHref} className="font-medium text-cobalt-ink underline-offset-2 hover:underline">
              See the markets
            </Link>
          </Notice>
        </Screen>
      )}
    </ConfigGuard>
  );
}
