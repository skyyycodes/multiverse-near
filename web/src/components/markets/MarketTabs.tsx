"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { CONTRACT_ID } from "@/lib/data/client";
import { useIsDesktop } from "@/lib/hooks/useMedia";
import { useCollateralTier } from "@/lib/hooks/useScenario";
import { borrowHref, lendHref, marketHref, ordersHref, resolveHref, sellHref, splitHref } from "@/lib/links";
import { type MarketTab, tabOf } from "@/lib/market";

type Tab = { tab: MarketTab; label: string; href: string; desk?: string; phone: string };

/**
 * A market's own screens (web 3.4). Desktop: five links (Sell and Split are tabs of the trade sheet there); phone: all
 * seven as a sideways chip row, the current one scrolled into view.
 */
export function MarketTabs({ sid }: { sid: number }) {
  const desktop = useIsDesktop();
  const path = usePathname();
  const { tier } = useCollateralTier(`${CONTRACT_ID}:${sid}`);
  const current = tabOf(path);
  const tabs: Tab[] = [
    { tab: "trade", label: "Trade", href: marketHref(sid), desk: "nav-trade", phone: "mtab-trade" },
    { tab: "sell", label: "Sell", href: sellHref(sid), phone: "mtab-sell" },
    { tab: "orders", label: "Order book", href: ordersHref(sid), desk: "nav-orders", phone: "mtab-orders" },
    { tab: "split", label: "Split", href: splitHref(sid), phone: "mtab-split" },
    { tab: "borrow", label: "Borrow", href: borrowHref(sid, tier), desk: "nav-borrow", phone: "mtab-borrow" },
    { tab: "lend", label: "Lend", href: lendHref(sid, tier), desk: "nav-lend", phone: "mtab-lend" },
    { tab: "resolve", label: "Resolve", href: resolveHref(sid), desk: "nav-resolve", phone: "mtab-resolve" },
  ];
  const active = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (!desktop) active.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [desktop, current]);

  if (desktop) {
    // On a desktop /sell/ is the trade screen with its Sell tab open.
    const on = current === "sell" || current === "split" ? "trade" : current;
    return (
      <nav aria-label="Market" className="flex flex-wrap gap-1 rounded-full bg-white/8 p-1 self-start" data-demo="market-tabs">
        {tabs
          .filter((t) => t.desk)
          .map((t) => (
            <Link
              key={t.tab}
              href={t.href}
              data-demo={t.desk}
              aria-current={on === t.tab ? "page" : undefined}
              className={`focus-ring rounded-full px-4 py-2 text-[14px] font-medium transition-colors ${
                on === t.tab ? "bg-white text-ink" : "text-white/75 hover:bg-white/10 hover:text-white"
              }`}
            >
              {t.label}
            </Link>
          ))}
      </nav>
    );
  }
  return (
    <nav aria-label="Market" className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4" data-demo="market-tabs">
      {tabs.map((t) => (
        <Link
          key={t.tab}
          ref={current === t.tab ? active : undefined}
          href={t.href}
          data-demo={t.phone}
          aria-current={current === t.tab ? "page" : undefined}
          className={`focus-ring inline-flex min-h-9 shrink-0 items-center rounded-full border px-3.5 text-[13px] font-medium whitespace-nowrap ${
            current === t.tab ? "border-white bg-white text-ink" : "border-white/20 text-white/85 hover:border-white/50"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
