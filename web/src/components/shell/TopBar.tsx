"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Wordmark } from "@/components/brand/Mark";
import { AccountButton, HelpLink, StatusBell } from "./HeaderActions";
import { NAV, samePath } from "./nav";
import { ScenarioSwitch } from "./ScenarioSwitch";

/** Desktop header on the navy stage: wordmark, the screens, scenario, status, account. */
export function TopBar() {
  const path = usePathname();
  return (
    <header className="mx-auto flex max-w-[1240px] items-center gap-6 px-8 pt-6 pb-2">
      <Link href="/" className="focus-ring shrink-0 rounded-full" aria-label="Multiverse Lending, home">
        <Wordmark />
      </Link>
      {/* Tested literally so a real build drops the chip, as it drops the fixtures themselves. */}
      {process.env.NEXT_PUBLIC_FIXTURES === "1" && (
        <span className="rounded-full border border-dashed border-white/25 px-2.5 py-1 text-[11px] whitespace-nowrap text-white/60" title="Screens read design fixtures, not the chain">
          design data
        </span>
      )}
      <nav className="flex items-center gap-1" aria-label="Screens">
        {NAV.map((n) => {
          const sub = n.href === "/" && /^\/(sell|world)/.test(path ?? "");
          const active = samePath(path, n.href) || sub;
          return (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active ? "page" : undefined}
              data-demo={n.demo}
              className={`focus-ring rounded-full px-3 py-2 text-[14px] whitespace-nowrap transition-colors xl:px-3.5 ${
                active ? "bg-white/12 font-medium text-white" : "text-white/65 hover:text-white"
              }`}
            >
              {n.label}
            </Link>
          );
        })}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <ScenarioSwitch />
        <HelpLink />
        <StatusBell />
        <AccountButton />
      </div>
    </header>
  );
}

/** Phone header row inside each screen's dark gradient. */
export function MobileTopBar() {
  return (
    <div className="flex items-center gap-2">
      <ScenarioSwitch />
      <div className="ml-auto flex items-center gap-2">
        <HelpLink />
        <StatusBell />
        <AccountButton compact />
      </div>
    </div>
  );
}
