"use client";

import { useState } from "react";
import { ENV, networkLabel } from "@/lib/env";
import { useContractVersion } from "@/lib/hooks/useOps";
import { AboutDialog } from "./AboutDialog";

/**
 * Where this page runs (W-D8): "staging · testnet v2.0.0"; on a phone the network name only. Anything but production
 * testnet is outlined in the warning tone. Tapping it opens the About dialog.
 */
export function NetworkBadge({ compact, onLight }: { compact?: boolean; onLight?: boolean }) {
  const version = useContractVersion();
  const [open, setOpen] = useState(false);
  const code = version.data?.codeVersion;
  const prod = ENV.network === "testnet";
  const tone = onLight
    ? prod
      ? "border-line-strong bg-sheet text-mute hover:bg-tile"
      : "border-warn bg-sheet text-warn hover:bg-tile"
    : prod
      ? "border-white/15 bg-white/5 text-white/75 hover:bg-white/10"
      : "border-warn-dark/60 bg-white/5 text-warn-dark hover:bg-white/10";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-demo="network-badge"
        title="About this deployment"
        className={`focus-ring num inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-[12px] whitespace-nowrap ${tone}`}
      >
        {compact ? ENV.network : `${networkLabel()}${code ? ` v${code}` : ""}`}
      </button>
      <AboutDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
