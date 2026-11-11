"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { IconBorrow, IconFutures, IconHelp, IconLend, IconMore, IconOrders } from "@/components/brand/Icons";
import { Mark } from "@/components/brand/Mark";
import { Dialog } from "@/components/ui/Dialog";
import { samePath } from "./nav";

const MORE = [
  { href: "/orders/", title: "Order book", sub: "Bids and asks in each world", icon: <IconOrders />, demo: "more-orders" },
  { href: "/lend/", title: "Lend", sub: "Supply USDC; underwrite every world", icon: <IconLend />, demo: "more-lend" },
  { href: "/welcome/", title: "How it works", sub: "Futures, splits and redemption in one page", icon: <IconHelp />, demo: "more-help" },
];

/** The phone's floating navigation pill: Trade, Sell, Borrow, More. */
export function BottomNav() {
  const path = usePathname();
  const [more, setMore] = useState(false);
  const moreActive = MORE.some((m) => samePath(path, m.href));
  return (
    <>
      <nav
        aria-label="Screens"
        className="fixed bottom-[max(14px,env(safe-area-inset-bottom))] left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full bg-white/95 p-1.5 shadow-float ring-1 ring-ink/5 backdrop-blur"
      >
        <Item href="/" label="Trade" active={samePath(path, "/")} demo="nav-trade">
          <IconFutures size={21} />
        </Item>
        <Item href="/sell/" label="Sell" active={samePath(path, "/sell/")} demo="nav-sell">
          <Mark size={22} bright={samePath(path, "/sell/") ? 3 : undefined} />
        </Item>
        <Item href="/borrow/" label="Borrow" active={samePath(path, "/borrow/")} demo="nav-borrow">
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
          {MORE.map((m) => (
            <li key={m.href}>
              <Link
                href={m.href}
                onClick={() => setMore(false)}
                data-demo={m.demo}
                className="focus-ring flex min-h-14 items-center gap-3 rounded-[16px] px-2 hover:bg-tile"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-tile text-ink">{m.icon}</span>
                <span className="min-w-0">
                  <span className="block text-[14px] font-semibold text-ink">{m.title}</span>
                  <span className="block truncate text-[12px] text-mute">{m.sub}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Dialog>
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
