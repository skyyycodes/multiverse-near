"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { HeroNumber, Screen } from "@/components/shell/Screen";
import { ConfigGuard } from "@/components/trade/Guard";
import { Pill } from "@/components/ui/Button";
import { Chip, Segmented } from "@/components/ui/Bits";
import { ChainWait } from "@/components/ui/Notice";
import { Block } from "@/components/ui/Surface";
import { TxButton } from "@/components/ui/TxButton";
import { CONTRACT_ID } from "@/lib/data/client";
import type { AppConfig } from "@/lib/domain";
import { accountLabel, fmtAsset, fmtHf, fmtUsd, hfTone } from "@/lib/format";
import { useNowSeconds } from "@/lib/hooks/useClock";
import { parseMarketParam } from "@/lib/hooks/useMarket";
import { useAtRisk, useHoldings, useVerseLabel } from "@/lib/hooks/useLiquidation";
import { useMarketTitles } from "@/lib/hooks/useMarkets";
import { usePauseState } from "@/lib/hooks/useOps";
import { useSubmit } from "@/lib/hooks/useTx";
import { HF_FILTERS, maxHfArg, parseHfFilter, statusLabel, type AtRiskRow, type HfFilter } from "@/lib/liquidation";
import { borrowHref, liquidateHref, marketHref, q } from "@/lib/links";
import { writeOffBadDebt } from "@/lib/near/tx";
import { useWallet } from "@/lib/near/wallet";
import { graceLeft } from "@/lib/pause";
import { TIER_LABEL } from "@/lib/tiers";
import { LiquidateDialog } from "./LiquidateDialog";

const TONE = { ok: "text-pos", warn: "text-warn", bad: "text-neg" } as const;
const FILTER_LABEL: Record<HfFilter, string> = { "1": "HF < 1", "1.1": "< 1.1", "1.5": "< 1.5", all: "All" };

/** Every loan close to liquidation, across every market and tier (web 6.10); `?id=` narrows to one market. */
export function AtRiskScreen() {
  return <ConfigGuard>{(config) => <AtRisk config={config} />}</ConfigGuard>;
}

function AtRisk({ config }: { config: AppConfig }) {
  const params = useSearchParams();
  const router = useRouter();
  const wallet = useWallet();
  const pause = usePauseState();
  const now = useNowSeconds();
  const idParam = parseMarketParam(params.get("id"));
  const sid = typeof idParam === "number" ? idParam : undefined;
  const filter = parseHfFilter(params.get("hf"));
  const data = useAtRisk(sid, maxHfArg(filter));
  const [open, setOpen] = useState<AtRiskRow | undefined>(undefined);
  const grace = graceLeft(pause.data, now);
  const rows = data.data?.rows;
  const title = useMarketTitles(rows?.map((r) => r.scenarioId) ?? []);
  const liquidatable = rows?.filter((r) => r.liquidation === "liquidatable").length;

  const setFilter = (f: HfFilter) => router.replace(q("/liquidate/", { id: sid, hf: f === "1.1" ? undefined : f }), { scroll: false });

  return (
    <Screen
      demo="liquidate"
      hero={
        <div className="flex flex-col gap-4" data-demo="atrisk-hero">
          <h1 className="font-display text-[30px] leading-[1.08] font-medium tracking-[-0.015em]">
            At-risk loans{sid !== undefined ? ` · market #${sid}` : ""}
          </h1>
          <HeroNumber
            label="Liquidatable now"
            loading={!rows}
            value={rows ? String(liquidatable) : "—"}
            tone={liquidatable ? "text-neg-dark" : undefined}
            sub={
              rows
                ? `${rows.length} loan${rows.length === 1 ? "" : "s"} ${filter === "all" ? "in total" : `under ${filter}`} · ${data.data!.markets} market${data.data!.markets === 1 ? "" : "s"} checked`
                : undefined
            }
          />
          <div className="rounded-full bg-white/8 p-0.5 [&>div]:bg-transparent [&_button]:text-white/75 [&_button[aria-pressed=true]]:bg-white [&_button[aria-pressed=true]]:text-ink">
            <Segmented
              size="sm"
              value={filter}
              onChange={setFilter}
              options={HF_FILTERS.map((f) => ({ value: f, label: FILTER_LABEL[f], demo: `atrisk-filter-${f}` }))}
            />
          </div>
          <p className="text-[13px] leading-relaxed text-white/70">
            A keeper bot watches every market; anyone may liquidate. Liquidating repays part of a loan and pays you its collateral plus a bonus.
          </p>
          {sid !== undefined && (
            <Link href={liquidateHref()} className="self-start text-[13px] text-white/80 underline-offset-2 hover:underline">
              Show every market
            </Link>
          )}
        </div>
      }
    >
      <Block title="Loans" demo="atrisk-list">
        {!rows ? (
          <ChainWait error={data.error?.message} onRetry={() => void data.refetch()} />
        ) : rows.length === 0 ? (
          <p className="text-[13px] text-mute" data-demo="atrisk-empty">
            {filter === "all" ? "No open loans." : `No loan under a health factor of ${filter}.`}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((r) => (
              <Row key={`${r.scenarioId}:${r.tier}:${r.accountId}`} row={r} market={title(r.scenarioId)} grace={grace} onLiquidate={() => setOpen(r)} />
            ))}
          </ul>
        )}
        {data.data && data.data.unreadable.length > 0 && (
          <p className="text-[12px] text-warn">Could not read market{data.data.unreadable.length === 1 ? "" : "s"} #{data.data.unreadable.join(", #")}.</p>
        )}
      </Block>
      {wallet.accountId && <Holdings account={wallet.accountId} />}
      <LiquidateDialog config={config} row={open} onClose={() => setOpen(undefined)} />
    </Screen>
  );
}

function Row({ row, market, grace, onLiquidate }: { row: AtRiskRow; market: string; grace: bigint; onLiquidate: () => void }) {
  const submit = useSubmit();
  const worst = useVerseLabel(row.scenarioId, row.worstWorld === null ? 0 : 1 << row.worstWorld, row.worstWorld !== null);
  const status = statusLabel(row, grace);
  const can = row.liquidation === "liquidatable";
  return (
    <li
      className="flex flex-col gap-3 rounded-[18px] border border-line bg-sheet p-4 sm:flex-row sm:items-center sm:justify-between"
      data-demo="atrisk-row"
      data-account={row.accountId}
      data-market={row.scenarioId}
      data-tier={row.tier}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-ink" title={row.accountId}>
            {accountLabel(row.accountId)}
          </span>
          <Chip tone={can ? "neg" : status === "Healthy" ? "neutral" : "warn"}>{status}</Chip>
        </div>
        <div className="num flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-mute">
          <Link href={marketHref(row.scenarioId)} title={market} className="max-w-full truncate font-sans text-cobalt-ink hover:underline">
            {market}
          </Link>
          <Link href={borrowHref(row.scenarioId, row.tier)} className="hover:underline">
            {TIER_LABEL[row.tier]} tier
          </Link>
          <span>debt {fmtUsd(row.debt)}</span>
          <span>
            HF <span className={TONE[hfTone(row.healthFactor)]}>{fmtHf(row.healthFactor)}</span>
          </span>
          {row.worstWorld !== null && <span>worst {worst.data ?? "…"}</span>}
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-2 sm:w-40">
        <Pill size="md" disabled={!can} onClick={onLiquidate} data-demo="liquidate" className="w-full">
          Liquidate
        </Pill>
        {row.writeOffReady && (
          <TxButton
            demo="write-off"
            action="write_off"
            tone="secondary"
            size="md"
            label="Write off"
            busyLabel="Writing off…"
            needs={{ contract: true }}
            run={() => submit(writeOffBadDebt(CONTRACT_ID, { scenarioId: row.scenarioId, accountId: row.accountId, tier: row.tier }))}
          />
        )}
      </div>
    </li>
  );
}

/** The verse tokens the account holds: what liquidations in tokens mode (and sales) left with it. */
function Holdings({ account }: { account: string }) {
  const holdings = useHoldings(account);
  const title = useMarketTitles(holdings.data?.map((h) => h.scenarioId) ?? []);
  return (
    <Block title="Your seized pieces" demo="holdings">
      {!holdings.data ? (
        <ChainWait error={holdings.error?.message} onRetry={() => void holdings.refetch()} />
      ) : holdings.data.length === 0 ? (
        <p className="text-[13px] text-mute">No verse tokens in this wallet.</p>
      ) : (
        <ul className="flex flex-col">
          {holdings.data.map((h) => (
            <HoldingRow key={h.tokenId} sid={h.scenarioId} market={title(h.scenarioId)} asset={h.asset} mask={h.mask} amount={h.amount} />
          ))}
        </ul>
      )}
      <p className="text-[12px] leading-relaxed text-mute">
        Tokens of worlds still possible pay out at resolution; the cash option sells and merges them for you.
      </p>
    </Block>
  );
}

function HoldingRow({ sid, market, asset, mask, amount }: { sid: number; market: string; asset: "wnear" | "usdc"; mask: number; amount: bigint }) {
  const label = useVerseLabel(sid, mask);
  return (
    <li className="flex items-baseline justify-between gap-3 border-b border-line py-2 text-[13px] last:border-b-0" data-demo="holding-row">
      <span className="min-w-0 truncate text-ink">
        {asset === "wnear" ? "wNEAR" : "USDC"}-if-{label.data ?? "…"}{" "}
        <Link href={marketHref(sid)} title={market} className="text-[12px] text-cobalt-ink hover:underline">
          {market}
        </Link>
      </span>
      <span className="num shrink-0 text-ink">{fmtAsset(asset, amount)}</span>
    </li>
  );
}
