"use client";

import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { UnlistedBanner } from "@/components/shell/UnlistedBanner";
import { Frame, ConfigGuard } from "@/components/trade/Guard";
import { ChainWait, Notice } from "@/components/ui/Notice";
import type { AppConfig } from "@/lib/domain";
import { useIsDesktop } from "@/lib/hooks/useMedia";
import {
  forgetMarket,
  MarketIdContext,
  rememberMarket,
  UnlistedContext,
  useFirstMarkets,
  useMarketCard,
  useMarketRef,
  useMarketUrlRewrite,
  useScenarioInfo,
} from "@/lib/hooks/useMarket";
import { marketHref, marketsHref } from "@/lib/links";

type Children = ReactNode | ((sid: number, config: AppConfig) => ReactNode);

/**
 * Every market-scoped screen sits inside this guard (inside ConfigGuard): it resolves the market from the URL (or the
 * last market, or the demo record, written back into the URL), checks it exists, remembers it, and flags an unlisted
 * one. The screen renders only for a market that exists (web design 3.3).
 */
export function MarketGuard({ children, rewrite = true }: { children: Children; rewrite?: boolean }) {
  return (
    <ConfigGuard>
      {(config) => (
        <MarketCheck config={config} rewrite={rewrite}>
          {children}
        </MarketCheck>
      )}
    </ConfigGuard>
  );
}

const UNKNOWN = /UnknownScenario/;

function MarketCheck({ config, rewrite, children }: { config: AppConfig; rewrite: boolean; children: Children }) {
  const ref = useMarketRef(config);
  const sid = ref.sid;
  const info = useScenarioInfo(sid);
  const card = useMarketCard(info.data ? sid : undefined);
  const desktop = useIsDesktop();
  const exists = info.data !== undefined;
  const unknown = Boolean(info.error && UNKNOWN.test(info.error.message));
  useMarketUrlRewrite(ref, rewrite && exists);

  useEffect(() => {
    if (sid === undefined) return;
    if (exists) rememberMarket(sid);
    // a remembered market that no longer exists stops being the fallback
    else if (unknown && ref.source === "last") forgetMarket(sid);
  }, [sid, exists, unknown, ref.source]);

  if (ref.invalid !== undefined) {
    return (
      <Frame>
        <Notice title="Not a market id">
          <span className="font-mono text-ink">{ref.invalid || "(empty)"}</span> is not a market number. <ListLink />
        </Notice>
      </Frame>
    );
  }
  if (sid === undefined) {
    return (
      <Frame>
        <PickMarket />
      </Frame>
    );
  }
  if (unknown) {
    return (
      <Frame>
        <Notice title={`No market #${sid} on this deployment`}>
          This contract has no market with that number. <ListLink />
        </Notice>
      </Frame>
    );
  }
  if (!info.data) {
    return (
      <Frame loading={!info.error}>
        <ChainWait error={info.error?.message} onRetry={() => void info.refetch()} />
      </Frame>
    );
  }
  // The registry's word on listing; until it answers (or where it cannot), the screen shows without the banner.
  const unlisted = card.data && !card.data.listed ? sid : undefined;
  return (
    <MarketIdContext.Provider value={sid}>
      <UnlistedContext.Provider value={unlisted}>
        {desktop && unlisted !== undefined && (
          <div className="mx-auto max-w-[1240px] px-6 pt-2 xl:px-8">
            <UnlistedBanner sid={unlisted} />
          </div>
        )}
        {typeof children === "function" ? children(sid, config) : children}
      </UnlistedContext.Provider>
    </MarketIdContext.Provider>
  );
}

function ListLink() {
  return (
    <Link href={marketsHref} className="font-medium text-cobalt-ink underline-offset-2 hover:underline">
      See the markets
    </Link>
  );
}

/** No market in the URL, none remembered, no demo record: offer the first open markets of the list. */
function PickMarket() {
  const first = useFirstMarkets(3);
  return (
    <Notice title="Pick a market">
      <span>Choose a market to trade, borrow or lend in.</span>
      {first.data && first.data.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2" data-demo="pick-market">
          {first.data.map((m) => (
            <li key={m.scenarioId}>
              <Link href={marketHref(m.scenarioId)} className="font-medium text-cobalt-ink underline-offset-2 hover:underline" data-demo="pick-market-link">
                Market #{m.scenarioId} · {m.worldCount} worlds
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3">
        <ListLink />
      </div>
    </Notice>
  );
}
