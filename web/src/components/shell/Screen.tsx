"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { BranchLines } from "@/components/brand/BranchLines";
import { IconChevronLeft } from "@/components/brand/Icons";
import { useIsDesktop } from "@/lib/hooks/useMedia";
import { Banners } from "./Banners";
import { MobileTopBar } from "./TopBar";

/**
 * Every screen's frame. Phone: a deep gradient header (scenario, status, account, then the screen's hero) and one white
 * sheet that rises over it. Desktop: two columns on the navy stage, the hero and content on the left, the action sheet
 * on the right.
 */
export function Screen({
  hero,
  children,
  aside,
  asideFirst,
  back,
  demo,
  layout,
}: {
  hero: ReactNode;
  children?: ReactNode;
  aside?: ReactNode;
  /** On a phone, show the aside before the main content (the action matters more than the context). */
  asideFirst?: boolean;
  /** A back link above the hero, for screens one step below a tab (sell, order book, world). */
  back?: { href: string; label: string };
  demo?: string;
  /** wide: one column on a desktop, no aside (the market list). */
  layout?: "wide";
}) {
  const desktop = useIsDesktop();
  if (desktop && layout === "wide") {
    return (
      <main data-demo={demo} className="mx-auto flex max-w-[1240px] flex-col gap-6 px-8 pt-6 pb-24">
        {back && <BackLink {...back} dark />}
        <div className="text-white">{hero}</div>
        {children}
      </main>
    );
  }
  if (desktop) {
    return (
      <main data-demo={demo} className="mx-auto grid max-w-[1240px] grid-cols-[minmax(0,1fr)_440px] gap-8 px-8 pt-6 pb-24">
        <section className="flex min-w-0 flex-col gap-6">
          {back && <BackLink {...back} dark />}
          <div className="text-white">{hero}</div>
          {children}
        </section>
        <aside className="flex min-w-0 flex-col gap-5">{aside}</aside>
      </main>
    );
  }
  return (
    <main data-demo={demo} className="min-h-dvh">
      <header className="grain bg-header relative overflow-hidden px-4 pt-[max(14px,env(safe-area-inset-top))] pb-12 text-white">
        <BranchLines opacity={0.12} />
        <div className="relative flex flex-col gap-5">
          <MobileTopBar />
          <Banners compact />
          {back && <BackLink {...back} dark />}
          {hero}
        </div>
      </header>
      <div className="relative -mt-7 flex min-h-[60dvh] flex-col gap-7 rounded-t-[28px] bg-sheet px-4 pt-6 pb-32 shadow-sheet">
        {asideFirst ? (
          <>
            {aside}
            {children}
          </>
        ) : (
          <>
            {children}
            {aside}
          </>
        )}
      </div>
    </main>
  );
}

function BackLink({ href, label, dark }: { href: string; label: string; dark?: boolean }) {
  return (
    <Link
      href={href}
      className={`focus-ring -ml-1 inline-flex min-h-10 items-center gap-1 self-start rounded-full pr-3 text-[14px] ${
        dark ? "text-white/75 hover:text-white" : "text-mute hover:text-ink"
      }`}
    >
      <IconChevronLeft size={20} />
      {label}
    </Link>
  );
}

/** The one big light numeral of a screen, with its quiet label above and a line under it. */
export function HeroNumber({
  label,
  value,
  sub,
  tone,
  demo,
  loading,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: string;
  demo?: string;
  loading?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2" data-demo={demo}>
      <span className="label text-white/65">{label}</span>
      {loading ? (
        <span className="skeleton-dark h-12 w-56 rounded-[14px]" />
      ) : (
        <span className={`numeral text-[48px] sm:text-[56px] ${tone ?? "text-white"}`}>{value}</span>
      )}
      {sub && <div className="text-[13px] leading-snug text-white/75">{sub}</div>}
    </div>
  );
}
