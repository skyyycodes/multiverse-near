"use client";

import Link from "next/link";
import { useState } from "react";
import { IconBell, IconHelp, IconWallet } from "@/components/brand/Icons";
import { shortAccount } from "@/lib/format";
import { useHalted } from "@/lib/hooks/useData";
import { useCurrentMarketId } from "@/lib/hooks/useMarket";
import { resolveHref } from "@/lib/links";
import { useWallet } from "@/lib/near/wallet";
import { AccountSheet } from "./AccountSheet";

const iconButton =
  "focus-ring relative grid size-10 shrink-0 place-items-center rounded-full border border-white/12 bg-white/8 text-white/85 backdrop-blur-sm transition-colors hover:bg-white/14 hover:text-white";

export function HelpLink() {
  return (
    <Link href="/welcome/" aria-label="How it works" title="How it works" className={iconButton} data-demo="help">
      <IconHelp size={20} />
    </Link>
  );
}

/** Resolution status of the current market (the URL's or the last one opened): pulses during a dispute window. */
export function StatusBell() {
  const sid = useCurrentMarketId();
  const halted = useHalted(sid).data;
  return (
    <Link
      href={sid === undefined ? "/resolve/" : resolveHref(sid)}
      aria-label={halted ? "A result is proposed and in its dispute window" : "Resolution status"}
      title={halted ? "A result is proposed and in its dispute window" : "Resolution status"}
      className={iconButton}
      data-demo="status-bell"
    >
      <IconBell size={20} />
      {halted && <span className="pulse-ring absolute top-2 right-2 size-2.5 rounded-full bg-warn-dark" />}
    </Link>
  );
}

/** Connect, or the connected account (opens the account sheet). */
export function AccountButton({ compact }: { compact?: boolean }) {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  if (!wallet.accountId) {
    return compact ? (
      <button
        type="button"
        onClick={() => void wallet.connect()}
        aria-label="Connect NEAR wallet"
        className={iconButton}
        data-demo="connect"
      >
        <IconWallet size={20} />
      </button>
    ) : (
      <button
        type="button"
        onClick={() => void wallet.connect()}
        disabled={!wallet.ready || wallet.connecting}
        className="focus-ring h-10 rounded-full bg-white px-4 text-[14px] font-semibold text-ink transition-colors hover:bg-ice disabled:opacity-60"
        data-demo="connect"
      >
        {wallet.connecting ? "Connecting…" : "Connect NEAR wallet"}
      </button>
    );
  }
  const initial = wallet.accountId[0]?.toUpperCase() ?? "?";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Account ${wallet.accountId}`}
        data-demo="account"
        className={
          compact
            ? "focus-ring grid size-10 shrink-0 place-items-center rounded-full bg-white font-display text-[15px] font-medium text-ink"
            : "focus-ring flex h-10 max-w-60 items-center gap-2 rounded-full border border-white/12 bg-white/8 pr-4 pl-1 text-[13px] text-white hover:bg-white/14"
        }
      >
        {compact ? (
          initial
        ) : (
          <>
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-white font-display text-[14px] font-medium text-ink">
              {initial}
            </span>
            <span className="truncate font-mono">{shortAccount(wallet.accountId)}</span>
          </>
        )}
      </button>
      <AccountSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
