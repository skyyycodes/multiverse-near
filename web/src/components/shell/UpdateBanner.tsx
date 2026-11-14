"use client";

import { useState } from "react";
import { BRAND } from "@/lib/brand";
import { ENV } from "@/lib/env";
import { useContractVersion, useWebUpdate } from "@/lib/hooks/useOps";
import { checkVersion } from "@/lib/version";

const DISMISSED = "ifverse.dismissed:";

function wasDismissed(banner: string): boolean {
  try {
    return window.sessionStorage.getItem(DISMISSED + banner) === "1";
  } catch {
    return false;
  }
}

function dismiss(banner: string) {
  try {
    window.sessionStorage.setItem(DISMISSED + banner, "1");
  } catch {
    // storage blocked: the banner shows again on the next page
  }
}

/** A dismissible strip with a Reload button; dismissal lasts for the tab (sessionStorage, a convenience only). */
function ReloadBanner({ banner, demo, reloadDemo, children, compact }: { banner: string; demo: string; reloadDemo?: string; children: string; compact?: boolean }) {
  const [hidden, setHidden] = useState(() => wasDismissed(banner));
  if (hidden) return null;
  return (
    <div
      role="status"
      data-demo={demo}
      className={`flex items-center gap-3 rounded-[18px] border border-sky/40 bg-sky/10 text-white ${compact ? "px-3.5 py-2 text-[12px]" : "px-5 py-2.5 text-[13px]"}`}
    >
      <span className="min-w-0 flex-1 leading-snug">{children}</span>
      <button
        type="button"
        data-demo={reloadDemo}
        onClick={() => window.location.reload()}
        className="focus-ring min-h-9 shrink-0 rounded-full bg-white px-3.5 text-[13px] font-semibold text-ink hover:bg-ice"
      >
        Reload
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => {
          dismiss(banner);
          setHidden(true);
        }}
        className="focus-ring min-h-9 shrink-0 rounded-full px-2 text-white/70 hover:text-white"
      >
        ✕
      </button>
    </div>
  );
}

/** W-D20: the deployed web changed since this tab loaded (version.json's git sha differs from this build's). */
export function UpdateBanner({ compact }: { compact?: boolean }) {
  const web = useWebUpdate();
  const sha = web.data?.gitSha;
  if (!sha || sha === ENV.gitSha) return null;
  return (
    <ReloadBanner banner={`update-${sha}`} demo="update-banner" reloadDemo="update-reload" compact={compact}>
      {`A new version of ${BRAND.name} is live.`}
    </ReloadBanner>
  );
}

/** The contract runs a newer state than this build speaks: the app works, a reload gets the matching one. */
export function NewerContractBanner({ compact }: { compact?: boolean }) {
  const version = useContractVersion();
  const v = version.data;
  if (!v || checkVersion(v, ENV.stateVersion) !== "newer") return null;
  return (
    <ReloadBanner banner={`newer-contract-${v.stateVersion}`} demo="newer-contract-banner" compact={compact}>
      {`A newer contract (state ${v.stateVersion}) is live. Reload to get the matching app.`}
    </ReloadBanner>
  );
}
