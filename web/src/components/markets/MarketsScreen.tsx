"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Landing, useLandingVisible } from "@/components/landing/Landing";
import { Screen } from "@/components/shell/Screen";
import { EmptyWalletHint } from "@/components/shell/TestTokens";
import { BalanceChips } from "@/components/trade/Home";
import { ConfigGuard } from "@/components/trade/Guard";
import { Chip, Segmented } from "@/components/ui/Bits";
import { PillLink } from "@/components/ui/Button";
import { ChipScroller, type ChipOption } from "@/components/ui/ChipScroller";
import { ChainWait } from "@/components/ui/Notice";
import { SearchField } from "@/components/ui/SearchField";
import { Block } from "@/components/ui/Surface";
import { BRAND } from "@/lib/brand";
import type { AppConfig } from "@/lib/domain";
import { fmtPrice, relTime } from "@/lib/format";
import { proposeHref } from "@/lib/links";
import {
  CATEGORY_NAMES,
  cardMatches,
  eventIdsOf,
  filterMarkets,
  filterProposals,
  type ListFilter,
  type ListSort,
  NO_YOURS,
  parseFilter,
  parseSort,
  proposalMatches,
  SORT_LABEL,
  SORTS,
  sortMarkets,
  sortProposals,
  yoursOf,
} from "@/lib/market";
import { useNowSeconds } from "@/lib/hooks/useClock";
import { useBalances, usePool } from "@/lib/hooks/useData";
import { useDebounced } from "@/lib/hooks/useDebounced";
import { useLastMarket } from "@/lib/hooks/useMarket";
import { useAccountPledges, useEventTexts, useLiveProposals, useMarketList, useMarketsOf, useReference } from "@/lib/hooks/useMarkets";
import { useIsDesktop } from "@/lib/hooks/useMedia";
import { useWallet } from "@/lib/near/wallet";
import { MarketCard } from "./MarketCard";
import { ProposalCard } from "./ProposalCard";

const ONE = 10n ** 18n;

/** `/`: the landing on a first, signed-out visit, else every listed market (web 6.2). */
export function MarketsScreen() {
  const firstVisit = useLandingVisible();
  if (firstVisit) return <Landing embedded />;
  return <ConfigGuard>{(config) => <Markets config={config} />}</ConfigGuard>;
}

/** The list's URL state: `q`, `f` and `sort`, defaults left out, every other param kept. */
function useListParams() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const set = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const qs = p.toString();
    router.replace(qs ? `${path}?${qs}` : path, { scroll: false });
  };
  return { q: params.get("q") ?? "", filter: parseFilter(params.get("f")), sort: parseSort(params.get("sort")), set };
}

function Markets({ config }: { config: AppConfig }) {
  const desktop = useIsDesktop();
  const wallet = useWallet();
  const account = wallet.accountId;
  const url = useListParams();
  const [query, setQuery] = useState(url.q);
  const debounced = useDebounced(query, 150);
  const { q: urlQ, set: setUrl } = url;
  useEffect(() => {
    if (debounced.trim() !== urlQ.trim()) setUrl({ q: debounced.trim() || undefined });
    // only a settled query writes the URL
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const list = useMarketList();
  const proposals = useLiveProposals();
  const cards = useMemo(() => list.data ?? [], [list.data]);
  const live = useMemo(() => proposals.data ?? [], [proposals.data]);
  const texts = useEventTexts(eventIdsOf([...cards, ...live.filter((p) => p.kind === "market")]));
  const textMap = useMemo(() => texts.data ?? new Map(), [texts.data]);
  const held = useMarketsOf(account);
  const pledges = useAccountPledges(account);
  const balances = useBalances(account, config.wnear, config.usdc);
  const last = useLastMarket();
  const nowSec = Number(useNowSeconds());

  const yours = useMemo(
    () => (account ? yoursOf(held.data ?? [], pledges.data ?? [], cards) : NO_YOURS),
    [account, held.data, pledges.data, cards],
  );
  const filter: ListFilter = url.filter === "yours" && !account ? "all" : url.filter;
  const search = debounced.trim();
  const shownCards = useMemo(
    () => sortMarkets(filterMarkets(cards, filter, yours), url.sort).filter((c) => cardMatches(c, textMap, search)),
    [cards, filter, yours, url.sort, textMap, search],
  );
  const shownProposals = useMemo(
    () => sortProposals(filterProposals(live, filter, yours)).filter((p) => proposalMatches(p, textMap, search)),
    [live, filter, yours, textMap, search],
  );

  // Category chips only for the codes some market or proposal carries.
  const present = new Set([...cards.flatMap((c) => c.categories), ...live.map((p) => p.newEvent?.category ?? p.category)]);
  const base: Omit<ChipOption<ListFilter>, "demo">[] = [
    { value: "all", label: "All" },
    { value: "single", label: "Single event" },
    { value: "combo", label: "Combinations" },
    ...[1, 2, 3, 0].filter((c) => present.has(c)).map((c) => ({ value: `cat-${c}` as ListFilter, label: CATEGORY_NAMES[c] })),
    { value: "pledging", label: "Collecting pledges" },
    { value: "yours", label: "Yours", disabled: !account },
    { value: "resolved", label: "Resolved" },
  ];
  const filters: ChipOption<ListFilter>[] = base.map((o) => ({ ...o, demo: `market-filter-${o.value}` }));

  const hero = (
    <div className="flex flex-col gap-4" data-demo="list-hero">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="label text-white/65">{BRAND.name}</span>
          <h1 className="font-display text-[34px] leading-[1.05] font-medium tracking-[-0.015em] lg:text-[40px]">Markets</h1>
          <p className="text-[14px] leading-snug text-white/75">{BRAND.short}</p>
        </div>
        {desktop && (
          <PillLink href={proposeHref()} tone="light" size="md" className="shrink-0">
            + Propose a new market
          </PillLink>
        )}
      </div>
      <PriceChips config={config} />
      {account && <BalanceChips balances={balances.data} loading={balances.isLoading} hideConnect />}
      <EmptyWalletHint balances={balances.data} />
    </div>
  );

  const toolbar = (
    <div className="flex flex-col gap-3" data-demo="market-toolbar">
      <SearchField value={query} onChange={setQuery} placeholder="Search markets" demo="market-search" />
      <div className={desktop ? "flex items-start justify-between gap-4" : "flex flex-col gap-3"}>
        <ChipScroller options={filters} value={filter} onChange={(f) => url.set({ f: f === "all" ? undefined : f })} demo="market-filters" label="Filter markets" />
        <SortControl value={url.sort} onChange={(s) => url.set({ sort: s === "pool" ? undefined : s })} desktop={desktop} />
      </div>
    </div>
  );

  const clear = () => {
    setQuery("");
    url.set({ q: undefined, f: undefined });
  };

  let body;
  if (!list.data) {
    body = list.error ? (
      <Block>
        <ChainWait error={list.error.message} onRetry={() => void list.refetch()} />
      </Block>
    ) : (
      <CardGrid desktop={desktop}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton h-[220px] rounded-[22px]" aria-hidden="true" />
        ))}
      </CardGrid>
    );
  } else if (cards.length === 0 && live.length === 0) {
    body = (
      <Block>
        <div className="flex flex-col items-start gap-3" data-demo="list-empty">
          <p className="text-[15px] text-ink">No markets yet. Propose the first one.</p>
          <PillLink href={proposeHref()} tone="primary" size="md">
            Propose a market
          </PillLink>
        </div>
      </Block>
    );
  } else if (shownCards.length === 0 && shownProposals.length === 0) {
    body = (
      <Block>
        <div className="flex flex-col items-start gap-3" data-demo="list-no-match">
          <p className="text-[15px] text-ink">{search ? `No market matches “${search}”.` : "No market in this filter."}</p>
          <button type="button" onClick={clear} className="focus-ring rounded-full text-[14px] font-medium text-cobalt-ink underline-offset-2 hover:underline">
            {search ? "Clear the search" : "Show all markets"}
          </button>
        </div>
      </Block>
    );
  } else {
    body = (
      <>
        {shownCards.length > 0 && (
          <CardGrid desktop={desktop}>
            {shownCards.map((c) => (
              <MarketCard key={c.scenarioId} card={c} texts={textMap} last={c.scenarioId === last} />
            ))}
          </CardGrid>
        )}
        {shownProposals.length > 0 && (
          <section className="flex flex-col gap-3" data-demo="proposal-section">
            <h2 className={`font-display text-[20px] font-medium tracking-[-0.01em] ${desktop ? "text-white" : "text-ink"}`}>Collecting pledges</h2>
            <CardGrid desktop={desktop}>
              {shownProposals.map((p) => (
                <ProposalCard key={p.proposalId} proposal={p} texts={textMap} nowSec={nowSec} />
              ))}
            </CardGrid>
          </section>
        )}
      </>
    );
  }

  return (
    <Screen demo="markets" layout="wide" hero={hero}>
      {desktop ? <Block>{toolbar}</Block> : toolbar}
      {body}
      <div className={desktop ? "flex" : "flex justify-center"}>
        <PillLink href={proposeHref()} tone={desktop ? "light" : "secondary"} size="md" demo="propose-new">
          + Propose a new market
        </PillLink>
      </div>
    </Screen>
  );
}

function CardGrid({ desktop, children }: { desktop: boolean; children: ReactNode }) {
  return <div className={desktop ? "grid grid-cols-2 gap-5 xl:grid-cols-3" : "flex flex-col gap-3"}>{children}</div>;
}

/** Sort: a segmented control on a desktop, a native select on a phone. */
function SortControl({ value, onChange, desktop }: { value: ListSort; onChange: (s: ListSort) => void; desktop: boolean }) {
  if (desktop) {
    return (
      <div className="shrink-0">
        <Segmented size="sm" value={value} onChange={onChange} demo="market-sort" options={SORTS.map((s) => ({ value: s, label: SORT_LABEL[s] }))} />
      </div>
    );
  }
  return (
    <label className="flex items-center gap-2 text-[13px] text-mute">
      Sort
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ListSort)}
        data-demo="market-sort"
        className="focus-ring min-h-9 rounded-full border border-line-strong bg-sheet px-3 text-[14px] font-medium text-ink"
      >
        {SORTS.map((s) => (
          <option key={s} value={s}>
            {SORT_LABEL[s]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** NEAR's price in the contract's own spot pool, and the outside NEAR/USD reference when there is one. */
function PriceChips({ config }: { config: AppConfig }) {
  const pool = usePool(config.spotPoolId);
  const ref = useReference();
  const p = pool.data;
  const spot = p?.wnearReserve && p.usdcReserve !== undefined ? (p.usdcReserve * ONE) / p.wnearReserve : undefined;
  const r = ref.data;
  if (spot === undefined && !r) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {spot !== undefined && (
        <span data-demo="list-spot">
          <Chip onDark className="px-3 py-1.5 text-[12px]">
            NEAR spot {fmtPrice(spot)}
          </Chip>
        </span>
      )}
      {r && (
        <span data-demo="list-reference">
          <Chip onDark className="px-3 py-1.5 text-[12px]" title="The outside NEAR/USD median the contract checks its markets against">
            NEAR/USD {fmtPrice(r.price)} · {r.sourcesUsed} {r.sourcesUsed === 1 ? "source" : "sources"} · {relTime(-r.ageSec)}
          </Chip>
        </span>
      )}
    </div>
  );
}
