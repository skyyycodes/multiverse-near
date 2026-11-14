"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { MarketHeader } from "@/components/markets/MarketHeader";
import { RelatedMarkets } from "@/components/markets/RelatedMarkets";
import { Rules, SeedInfo } from "@/components/markets/Rules";
import { Screen } from "@/components/shell/Screen";
import { EmptyWalletHint } from "@/components/shell/TestTokens";
import { Segmented } from "@/components/ui/Bits";
import { ChainWait } from "@/components/ui/Notice";
import { Block, Sheet } from "@/components/ui/Surface";
import { WorldGrid } from "@/components/world/WorldGrid";
import { CONTRACT_ID } from "@/lib/data/client";
import type { AppConfig, Scenario } from "@/lib/domain";
import { useChainClock, useNowSeconds } from "@/lib/hooks/useClock";
import { useBalances, useScenarioId, useTrade } from "@/lib/hooks/useData";
import { useMarketCard } from "@/lib/hooks/useMarket";
import { useIsDesktop } from "@/lib/hooks/useMedia";
import { usePicks } from "@/lib/hooks/useScenario";
import { useWallet } from "@/lib/near/wallet";
import { cellQuotes } from "@/lib/orders";
import { ActionTiles, BalanceChips, FuturesList, FuturesStrip, SpotHero } from "./Home";
import { OrderPanel } from "./OrderPanel";
import { SellPanel } from "./SellPanel";
import { SpotStats } from "./SpotStats";
import { ConfigGuard } from "./Guard";

type Focus = "sell" | "book";

/**
 * A market's trade screens, inside MarketGuard. On a phone `/market/` is the home (spot, futures, actions, the list of
 * possible futures); `/sell/` and `/orders/` are the two forms. On a desktop all three show the grid of worlds with the
 * Sell / Order book sheet beside it, and the grid is the order form: tap the worlds you fear.
 */
export function TradeScreen({ focus }: { focus?: Focus }) {
  return <ConfigGuard>{(config) => <Trade config={config} focus={focus} />}</ConfigGuard>;
}

function Trade({ config, focus }: { config: AppConfig; focus?: Focus }) {
  const desktop = useIsDesktop();
  const wallet = useWallet();
  const params = useSearchParams();
  const sid = useScenarioId(config);
  const trade = useTrade(sid, wallet.accountId);
  const card = useMarketCard(sid).data ?? undefined;
  const balances = useBalances(wallet.accountId, config.wnear, config.usdc);
  const wallNow = useNowSeconds();
  const clock = useChainClock(trade.data?.nowSec, trade.dataUpdatedAt);
  const s = trade.data?.scenario;
  const key = `${CONTRACT_ID}:${sid}`;
  const picks = usePicks(key, s?.possible ?? 0);
  const [tab, setTab] = useState<Focus>(focus ?? "sell");

  // Links can preselect: /sell/?sel=14 (a mask), /sell/?w=3 and /orders/?w=0 (a world index).
  const applied = useRef(false);
  const { setSellMask, openBook } = picks;
  useEffect(() => {
    if (applied.current || !s) return;
    applied.current = true;
    const w = params.get("w");
    const sel = params.get("sel");
    const world = w !== null ? s.worlds[Number(w)] : undefined;
    if (focus === "book" && world?.possible) openBook(world.mask);
    else if (sel !== null && /^\d+$/.test(sel)) setSellMask(Number(sel) & s.possible);
    else if (world?.possible) setSellMask(world.mask);
  }, [s, params, focus, setSellMask, openBook]);

  const quotes = trade.data && config.orderBook ? cellQuotes(trade.data.orders, trade.data.scenario, wallNow) : undefined;

  const header = sid !== undefined && <MarketHeader sid={sid} />;
  // The market page's foot: how it was opened, then the markets that share its events.
  const foot = !focus && card && (
    <>
      <SeedInfo card={card} onDark={desktop} />
      <RelatedMarkets card={card} />
    </>
  );

  const sellPanel = (picker: boolean, heading: boolean) =>
    s &&
    trade.data && (
      <SellPanel
        config={config}
        scenario={s}
        events={trade.data.events}
        orders={trade.data.orders}
        nowSec={wallNow}
        balances={balances.data}
        selected={picks.sellMask}
        onToggle={picks.toggleSell}
        onClear={() => picks.setSellMask(0)}
        picker={picker}
        heading={heading}
        lendable={card?.lendable}
      />
    );

  const orderPanel = (picker: boolean, heading: boolean) =>
    s &&
    trade.data && (
      <OrderPanel
        config={config}
        scenario={s}
        events={trade.data.events}
        orders={trade.data.orders}
        chainNow={clock.blockTime ?? wallNow}
        wallNow={wallNow}
        balances={balances.data}
        mask={picks.bookMask}
        onOpen={picks.openBook}
        picker={picker}
        heading={heading}
        intent={params.get("buy") ? "buy" : undefined}
      />
    );

  const wait = <ChainWait error={trade.error?.message} onRetry={() => void trade.refetch()} />;

  if (desktop) {
    const active: Focus = tab;
    return (
      <Screen
        demo="trade"
        hero={
          <div className="flex flex-col gap-5">
            {header}
            <BalanceChips balances={balances.data} loading={balances.isLoading} hideConnect />
            <EmptyWalletHint balances={balances.data} />
            <SpotHero scenario={s} />
          </div>
        }
        aside={
          <Sheet demo="trade-aside">
            <Segmented
              tabs
              value={active}
              onChange={setTab}
              options={[
                { value: "sell", label: "Sell", demo: "tab-sell" },
                { value: "book", label: "Order book", demo: "tab-book" },
              ]}
            />
            {!trade.data ? wait : active === "sell" ? sellPanel(false, true) : orderPanel(false, true)}
          </Sheet>
        }
      >
        {s && trade.data ? (
          <>
            <WorldGrid
              scenario={s}
              events={trade.data.events}
              selected={active === "sell" ? picks.sellMask : picks.bookMask}
              onToggle={active === "sell" ? picks.toggleSell : picks.openBook}
              quotes={quotes}
              badge={active === "sell" ? "SELL" : "BOOK"}
            />
            <Block>
              <SpotStats scenario={s} impact={trade.data.impact} />
            </Block>
            <Rules events={trade.data.events} onDark />
            {foot}
          </>
        ) : (
          <Block>{wait}</Block>
        )}
      </Screen>
    );
  }

  if (focus) {
    const world = s?.worlds.find((w) => w.mask === picks.bookMask);
    return (
      <Screen
        demo={focus === "sell" ? "sell" : "orders"}
        hero={
          <div className="flex flex-col gap-5">
            {sid !== undefined && <MarketHeader sid={sid} compact />}
            <FocusTitle focus={focus} label={world?.label} scenario={s} />
          </div>
        }
      >
        {trade.data ? (focus === "sell" ? sellPanel(true, false) : orderPanel(true, false)) : wait}
      </Screen>
    );
  }

  return (
    <Screen
      demo="trade"
      hero={
        <div className="flex flex-col gap-6">
          {header}
          <BalanceChips balances={balances.data} loading={balances.isLoading} />
          <EmptyWalletHint balances={balances.data} />
          <SpotHero scenario={s} />
          {s && <FuturesStrip scenario={s} />}
          {s && <ActionTiles scenario={s} sellMask={picks.sellMask} />}
        </div>
      }
    >
      {s && trade.data ? (
        <>
          <FuturesList scenario={s} quotes={quotes} />
          <SpotStats scenario={s} impact={trade.data.impact} />
          <Rules events={trade.data.events} />
          {foot}
        </>
      ) : (
        wait
      )}
    </Screen>
  );
}

function FocusTitle({ focus, label, scenario }: { focus: Focus; label?: string; scenario?: Scenario }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="font-display text-[30px] leading-[1.08] font-medium tracking-[-0.015em]">
        {focus === "sell" ? (
          <>
            Sell in the worlds you <span className="font-serif text-[36px] font-normal tracking-normal italic">fear</span>
          </>
        ) : label ? (
          `Order book · ${label}`
        ) : (
          "Order book"
        )}
      </h1>
      {scenario?.halted && <p className="text-[13px] text-warn-dark">paused: resolution pending</p>}
    </div>
  );
}
