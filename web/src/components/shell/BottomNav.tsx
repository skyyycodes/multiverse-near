"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { IconAdmin, IconBorrow, IconFutures, IconHelp, IconLend, IconMore, IconOrders, IconProtect, IconResolve, IconSplit } from "@/components/brand/Icons";
import { Mark } from "@/components/brand/Mark";
import { Dialog } from "@/components/ui/Dialog";
import { adminHref, borrowHref, lendHref, liquidateHref, ordersHref, proposeHref, resolveHref, sellHref, splitHref, welcomeHref } from "@/lib/links";
import { useCurrentMarketId } from "@/lib/hooks/useMarket";
import { AboutDialog } from "./AboutDialog";
import { isCurrent, NAV, samePath } from "./nav";

type MoreItem = { href?: string; title: string; sub: string; icon: ReactNode; demo: string; path?: string };

/** The More menu; market entries carry the current market (or lead to the list without one). */
function moreItems(sid: number | undefined): MoreItem[] {
  const m = <T,>(f: (sid: number) => T, fallback: T) => (sid === undefined ? fallback : f(sid));
  return [
    { href: m(ordersHref, "/"), path: "/orders/", title: "Order book", sub: "Bids and asks in each world", icon: <IconOrders />, demo: "more-orders" },
    { href: m(splitHref, "/"), path: "/split/", title: "Split and merge", sub: "Turn tokens into one piece per world and back", icon: <IconSplit />, demo: "more-split" },
    { href: m(lendHref, "/"), path: "/lend/", title: "Lend", sub: "Supply USDC; underwrite every world", icon: <IconLend />, demo: "more-lend" },
    { href: m(resolveHref, "/"), path: "/resolve/", title: "Resolve", sub: "Results, dispute windows, close and redeem", icon: <IconResolve />, demo: "more-resolve" },
    { href: liquidateHref(), path: "/liquidate/", title: "At-risk loans", sub: "Loans near or past their limit", icon: <IconProtect />, demo: "more-liquidate" },
    { href: proposeHref(), path: "/propose/", title: "Propose a market", sub: "A new event, or a combination of open ones", icon: <IconFutures />, demo: "more-propose" },
    { href: adminHref(sid), path: "/admin/", title: "Admin", sub: "Operations, resolution, price push", icon: <IconAdmin />, demo: "more-admin" },
    { href: welcomeHref, path: "/welcome/", title: "How it works", sub: "Futures, splits and redemption in one page", icon: <IconHelp />, demo: "more-help" },
    { title: "About this deployment", sub: "Network, contract and versions", icon: <IconMore />, demo: "more-about" },
  ];
}

/** The phone's floating navigation pill: Markets, Sell, Borrow, More (market links follow the current market). */
export function BottomNav() {
  const path = usePathname();
  const sid = useCurrentMarketId();
  const [more, setMore] = useState(false);
  const [about, setAbout] = useState(false);
  const items = moreItems(sid);
  const moreActive = items.some((m) => m.path && samePath(path, m.path));
  const marketsActive = isCurrent(path, NAV[0]) && !samePath(path, "/sell/") && !samePath(path, "/borrow/") && !moreActive;
  return (
    <>
      <nav
        aria-label="Screens"
        className="fixed bottom-[max(14px,env(safe-area-inset-bottom))] left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full bg-white/95 p-1.5 shadow-float ring-1 ring-ink/5 backdrop-blur"
      >
        <Item href="/" label="Markets" active={marketsActive} demo="nav-markets">
          <IconFutures size={21} />
        </Item>
        <Item href={sid === undefined ? "/" : sellHref(sid)} label="Sell" active={samePath(path, "/sell/")} demo="nav-sell">
          <Mark size={22} bright={samePath(path, "/sell/") ? 3 : undefined} />
        </Item>
        <Item href={sid === undefined ? "/" : borrowHref(sid)} label="Borrow" active={samePath(path, "/borrow/")} demo="nav-borrow">
          <IconBorrow size={21} />
        </Item>
        <button
          type="button"
          onClick={() => setMore(true)}
          aria-haspopup="dialog"
          data-demo="nav-more"
          className={`focus-ring flex h-12 w-16 flex-col items-center justify-center gap-0.5 rounded-full text-[10px] font-medium transition-colors ${
            moreActive ? "bg-ink text-white" : "text-mute hover:text-ink"
          }`}
        >
          <IconMore size={21} />
          <span>More</span>
        </button>
      </nav>
      <Dialog open={more} onClose={() => setMore(false)} title="More" demo="more-menu">
        <ul className="flex flex-col gap-1">
          {items.map((m) => {
            const body = (
              <>
                <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-tile text-ink">{m.icon}</span>
                <span className="min-w-0">
                  <span className="block text-[14px] font-semibold text-ink">{m.title}</span>
                  <span className="block truncate text-[12px] text-mute">{m.sub}</span>
                </span>
              </>
            );
            const cls = "focus-ring flex min-h-14 w-full items-center gap-3 rounded-[16px] px-2 text-left hover:bg-tile";
            return (
              <li key={m.demo}>
                {m.href ? (
                  <Link href={m.href} onClick={() => setMore(false)} data-demo={m.demo} className={cls}>
                    {body}
                  </Link>
                ) : (
                  <button
                    type="button"
                    data-demo={m.demo}
                    className={cls}
                    onClick={() => {
                      setMore(false);
                      setAbout(true);
                    }}
                  >
                    {body}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </Dialog>
      <AboutDialog open={about} onClose={() => setAbout(false)} />
    </>
  );
}

function Item({ href, label, active, children, demo }: { href: string; label: string; active: boolean; children: ReactNode; demo: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      data-demo={demo}
      className={`focus-ring flex h-12 w-16 flex-col items-center justify-center gap-0.5 rounded-full text-[10px] font-medium transition-colors ${
        active ? "bg-ink text-white" : "text-mute hover:text-ink"
      }`}
    >
      {children}
      <span>{label}</span>
    </Link>
  );
}
