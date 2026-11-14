"use client";

import { useState } from "react";
import { TierPicker } from "@/components/lending/TierPicker";
import { HeroNumber, Screen } from "@/components/shell/Screen";
import { ConfigGuard } from "@/components/trade/Guard";
import { InlineButton } from "@/components/ui/Button";
import { Chip, Segmented, SectionLabel } from "@/components/ui/Bits";
import { AmountField } from "@/components/ui/Field";
import { ChainWait } from "@/components/ui/Notice";
import { Block, Sheet, SheetTitle } from "@/components/ui/Surface";
import { TxButton } from "@/components/ui/TxButton";
import { WorldGlyph } from "@/components/world/WorldBits";
import { alpha, hueOf } from "@/components/world/hues";
import { CONTRACT_ID } from "@/lib/data/client";
import type { Account, AppConfig, LendingMarket, Scenario, Tier, WorldStatus } from "@/lib/domain";
import { humanError } from "@/lib/errors";
import { countdown, fmt, fmtAsset, fmtCompactUsd, fmtHf, fmtUsd, hfTone, inputText, parseAmount, pct, type Tone } from "@/lib/format";
import { useNowSeconds } from "@/lib/hooks/useClock";
import { useBalances, useBorrow, useScenarioId } from "@/lib/hooks/useData";
import { useLendingTiers, usePriceCheck, useReference, useReferenceConfig } from "@/lib/hooks/useLending";
import { usePauseState } from "@/lib/hooks/useOps";
import { useScreenTier } from "@/lib/hooks/useTier";
import { useSubmit } from "@/lib/hooks/useTx";
import {
  annualRate,
  barWidth,
  borrowBanner,
  borrowBlocker,
  borrowMath,
  linePosition,
  liquidationOf,
  neededValue,
  repayAllSend,
  repayBlocker,
  WAD,
  type BorrowBanner,
} from "@/lib/lending";
import { borrowHref } from "@/lib/links";
import { borrow, depositCollateral, GAS_CALL, GAS_MAX, repay, requestReference } from "@/lib/near/tx";
import { useWallet } from "@/lib/near/wallet";
import { graceLeft } from "@/lib/pause";
import { TIER_LABEL } from "@/lib/tiers";
import { toTokenCeil, toTokenFloor } from "@/lib/units";

const DARK: Record<Tone, string> = { ok: "text-pos-dark", warn: "text-warn-dark", bad: "text-neg-dark" };
const LIGHT: Record<Tone, string> = { ok: "text-pos", warn: "text-warn", bad: "text-neg" };

export function BorrowScreen() {
  return <ConfigGuard>{(config) => <BorrowMarket config={config} />}</ConfigGuard>;
}

function BorrowMarket({ config }: { config: AppConfig }) {
  const sid = useScenarioId(config);
  return sid === undefined ? null : <Borrow key={sid} config={config} sid={sid} />;
}

function Borrow({ config, sid }: { config: AppConfig; sid: number }) {
  const wallet = useWallet();
  const tiers = useLendingTiers(sid, wallet.accountId);
  const { tier, pick, ready } = useScreenTier(sid, tiers.data, "borrow", borrowHref);
  const view = useBorrow(ready ? sid : undefined, wallet.accountId, tier);
  const balances = useBalances(wallet.accountId, config.wnear, config.usdc);
  const pause = usePauseState();
  const now = useNowSeconds();
  const market = tiers.data?.find((t) => t.tier === tier)?.market;
  const v = view.data?.account;
  const s = view.data?.scenario;
  const name = TIER_LABEL[tier];
  const worst = v && s && v.collateral.length > 0 && v.worstWorld !== null ? s.worlds[v.worstWorld] : undefined;
  const banner = v ? borrowBanner(v, graceLeft(pause.data, now)) : undefined;
  const error = view.error ?? tiers.error;

  return (
    <Screen
      demo="borrow"
      hero={
        <div className="flex flex-col gap-5">
          <TierPicker tiers={tiers.data} value={tier} onChange={pick} mode="borrow" />
          <HeroNumber
            demo="hero-hf"
            label={`Health factor (worst world) · ${name}`}
            loading={!v}
            value={v ? fmtHf(v.healthFactor) : "—"}
            tone={v ? DARK[hfTone(v.healthFactor)] : undefined}
            sub={
              v && s ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span>{worst ? `worst world: ${worst.label}` : v.collateral.length === 0 ? "no collateral posted" : "worst world: —"}</span>
                  {banner === "liquidatable" && (
                    <Chip tone="neg" onDark>
                      <span data-demo="badge-liquidatable">Liquidatable</span>
                    </Chip>
                  )}
                  {(banner === "grace" || banner?.startsWith("paused")) && (
                    <Chip tone="warn" onDark>
                      <span data-demo="badge-paused">Liquidation paused</span>
                    </Chip>
                  )}
                  {v.writeOffReady && (
                    <Chip tone="neg" onDark>
                      <span data-demo="badge-write-off">Can be written off</span>
                    </Chip>
                  )}
                </span>
              ) : undefined
            }
          />
          {v && (
            <div className="grid grid-cols-2 gap-2 xl:grid-cols-4" data-demo="borrow-stats">
              <HeroStat label="debt" value={fmtUsd(v.debt)} />
              <HeroStat demo="stat-limit" label={`limit ${fmtUsd(v.borrowLimit)}`} value={v.borrowLimit > 0n ? `${pct(v.debt, v.borrowLimit, 1)} used` : "—"} />
              <HeroStat demo="stat-borrow-apr" label="borrow APR (variable)" value={pct(annualRate(v.borrowRatePerSecond), WAD, 2)} />
              <HeroStat demo="stat-bonus" label="bonus to liquidators" value={pct(v.liquidationBonus, WAD, 1)} />
            </div>
          )}
        </div>
      }
      aside={
        v && s && market ? <Actions config={config} tier={tier} v={v} s={s} market={market} walletUsdc={balances.data?.usdc ?? 0n} walletWnear={balances.data?.wnear ?? 0n} /> : undefined
      }
    >
      {v && s ? (
        <>
          <Banners config={config} v={v} s={s} banner={banner} grace={graceLeft(pause.data, now)} tier={tier} frozen={Boolean(market?.frozen || v.frozen)} />
          <PriceCheckBanner sid={sid} v={v} />
          <WorldsPanel v={v} s={s} sid={sid} />
        </>
      ) : (
        <Block>
          <ChainWait error={error?.message} onRetry={() => void (view.error ? view.refetch() : tiers.refetch())} />
        </Block>
      )}
    </Screen>
  );
}

function HeroStat({ label, value, demo }: { label: string; value: string; demo?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[16px] border border-white/10 bg-white/6 px-3 py-2.5 backdrop-blur-sm" data-demo={demo}>
      <span className="truncate text-[11px] leading-tight text-white/60">{label}</span>
      <span className="num truncate text-[15px] text-white">{value}</span>
    </div>
  );
}

function Alert({ tone, demo, children }: { tone: "neg" | "warn"; demo?: string; children: React.ReactNode }) {
  const cls = tone === "neg" ? "border-neg/40 bg-neg-bright/8 text-neg" : "border-warn-bright/50 bg-warn-bright/12 text-warn";
  return (
    <p role={tone === "neg" ? "alert" : "status"} data-demo={demo} className={`rounded-[16px] border px-4 py-3 text-[13px] leading-relaxed ${cls}`}>
      {children}
    </p>
  );
}

function Banners({ config, v, s, banner, grace, tier, frozen }: { config: AppConfig; v: Account; s: Scenario; banner: BorrowBanner | undefined; grace: bigint; tier: Tier; frozen: boolean }) {
  const liq = liquidationOf(v, s);
  const l = config.lending;
  return (
    <>
      {frozen && (
        <Alert tone="warn" demo="frozen-banner">
          The {TIER_LABEL[tier]} tier is frozen: no new loans. Repay, add collateral and close still work.
        </Alert>
      )}
      {banner === "liquidatable" && (
        <Alert tone="neg" demo="liquidatable-banner">
          Health factor below 1: anyone may repay up to half of the debt (all of it when the loan is under {fmtUsd(l.smallLoan)} or the health factor is
          under {fmt(l.fullLiquidationHf, 2)}) and take the same share of every piece, worth the repayment plus {pct(v.liquidationBonus, WAD, 1)} in your
          worst world. Repay or add collateral to lift it back above 1.
        </Alert>
      )}
      {banner === "grace" && <Alert tone="warn">Liquidations resume in {countdown(grace)}: repay or add collateral now.</Alert>}
      {banner === "paused" && <Alert tone="warn">Liquidations are paused for maintenance.</Alert>}
      {banner === "paused_halted" && (
        <Alert tone="warn">Health factor below 1, but liquidations wait while a result is in its dispute window: resolution can only raise it.</Alert>
      )}
      {banner === "paused_reference" && <Alert tone="warn">Liquidation waits: this market&apos;s prices are too far above the outside NEAR/USD price.</Alert>}
      {banner === "paused_no_price" && (
        <Alert tone="warn">
          Health factor below 1 because {liq.unpricedLabel ?? "a world"} has no valid price yet. Liquidations wait for one: a missing price counts as zero for
          borrowing, never for liquidation.
        </Alert>
      )}
      {banner === "write_off" && (
        <Alert tone="neg" demo="write-off-banner">
          Your collateral is worth nothing in a possible world: what is left of this loan can be written off by anyone.
        </Alert>
      )}
    </>
  );
}

const REFRESHABLE = /^Reference(Missing|Stale)/;

/** Why new borrowing waits for the outside NEAR/USD check, and the refresh when OutLayer can fetch it. */
function PriceCheckBanner({ sid, v }: { sid: number; v: Account }) {
  const submit = useSubmit();
  const check = usePriceCheck(v.borrowBlock ? sid : undefined);
  const refreshable = Boolean(v.borrowBlock && REFRESHABLE.test(v.borrowBlock));
  const ref = useReference(refreshable);
  const cfg = useReferenceConfig(refreshable);
  if (!v.borrowBlock) return null;
  const guest = cfg.data?.guest;
  return (
    <div className="flex flex-col gap-3 rounded-[16px] border border-warn-bright/50 bg-warn-bright/12 px-4 py-3" data-demo="price-check-banner">
      <p className="text-[13px] leading-relaxed text-warn">{humanError(check.data?.borrowBlock ?? v.borrowBlock)}</p>
      {ref.data?.pending ? (
        <p className="text-[13px] text-warn">Fetching NEAR/USD in OutLayer…</p>
      ) : (
        refreshable &&
        guest && (
          <TxButton
            demo="refresh-reference"
            action="request_reference"
            tone="secondary"
            size="md"
            label={`Refresh price check (about ${fmt(guest.deposit / 10n ** 6n, 2)} NEAR, about 15 s)`}
            busyLabel="Asking OutLayer…"
            gas={GAS_MAX}
            deposit={guest.deposit}
            run={() => submit(requestReference(CONTRACT_ID, guest.deposit))}
          />
        )
      )}
    </div>
  );
}

const STATUS_CHIP: Record<Exclude<WorldStatus, "trusted">, string> = {
  young: "No price yet",
  shallow: "Thin pool",
  out_of_band: "Moving fast",
  no_pool: "No pool",
};

function statusTitle(st: Exclude<WorldStatus, "trusted">, minAgeSec: number | undefined, minDepth: bigint | undefined): string {
  switch (st) {
    case "young":
      return `The pool is younger than ${minAgeSec !== undefined ? Math.round(minAgeSec / 60) : 30} min; it counts zero for borrowing`;
    case "shallow":
      return `Less than ${minDepth !== undefined ? fmtCompactUsd(minDepth) : "the minimum"} deep at its average price`;
    case "out_of_band":
      return "Its price moved more than 10% from the 30-minute average; borrowing values it at zero, liquidation at the average";
    case "no_pool":
      return "No pool in this world yet";
  }
}

/** Collateral value in every world (liquidation side) against the line where the loan reaches HF 1, and what is posted. */
function WorldsPanel({ v, s, sid }: { v: Account; s: Scenario; sid: number }) {
  const check = usePriceCheck(v.worldStatus.some((x) => x !== "trusted") ? sid : undefined);
  const max = v.collateralValues.reduce((m, x) => (x > m ? x : m), 0n);
  const needed = neededValue(v.debt, v.lltv);
  return (
    <Block title="Collateral by world" demo="borrow-worlds">
      <ul className="flex flex-col gap-3" data-demo="collateral-bars">
        {s.worlds.map((w) => {
          const value = v.collateralValues[w.index] ?? 0n;
          const dead = !w.possible;
          const isWorst = v.collateral.length > 0 && w.index === v.worstWorld;
          const hue = hueOf(w.index, !dead);
          const st = v.worldStatus[w.index] ?? "trusted";
          return (
            <li key={w.mask} className={`flex flex-col gap-1.5 ${dead ? "opacity-35" : ""}`} data-world={w.label}>
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2.5">
                  <WorldGlyph world={w} size={28} />
                  <span className={`truncate text-[13px] ${isWorst ? "font-semibold" : ""} text-ink ${dead ? "line-through" : ""}`}>{w.label}</span>
                  {isWorst && <span className="rounded-full bg-ink px-2 py-0.5 text-[10px] font-bold tracking-[0.08em] text-white uppercase">worst</span>}
                  {!dead && st !== "trusted" && (
                    <span data-demo="world-status" data-world={w.index} data-status={st}>
                      <Chip tone="warn" title={statusTitle(st, check.data?.config.minAgeSec, check.data?.config.minDepth)}>
                        {STATUS_CHIP[st]}
                      </Chip>
                    </span>
                  )}
                </span>
                <span className="num shrink-0 text-[13px] text-ink">{dead ? "resolved away" : fmtUsd(value)}</span>
              </div>
              <div className="relative h-3 overflow-hidden rounded-full bg-tile">
                <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${barWidth(value, max)}%`, background: isWorst ? hue : alpha(hue, 0.5) }} />
                {needed > 0n && max > 0n && (
                  <div
                    className="absolute top-0 h-full border-l-2 border-dashed border-neg"
                    style={{ left: `${linePosition(needed, max)}%` }}
                    title="collateral value at which this world's HF reaches 1"
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-[12px] leading-relaxed text-mute">
        Collateral value in each world at the 30-minute average price, the price liquidation uses. Borrowing counts the lower of the current and average
        price, times {pct(v.borrowLtv, WAD, 0)}. The dashed line is where this world&apos;s health factor reaches 1.
      </p>
      <div className="flex flex-col gap-2" data-demo="posted-collateral">
        <SectionLabel>Posted collateral</SectionLabel>
        {v.collateral.length === 0 ? (
          <p className="text-[13px] text-mute">None yet. Sell with “keep as loan collateral” on the Sell screen, or add real USDC or wNEAR here.</p>
        ) : (
          <ul className="flex flex-col">
            {v.collateral.map((c) => (
              <li key={c.tokenId} className="flex justify-between gap-3 border-b border-line py-2 text-[13px] last:border-b-0">
                <span className="truncate text-ink">{c.label}</span>
                <span className="num text-ink">{fmtAsset(c.asset, c.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Block>
  );
}

type ActionsProps = { config: AppConfig; tier: Tier; v: Account; s: Scenario; market: LendingMarket; walletUsdc: bigint; walletWnear: bigint };

function Actions(p: ActionsProps) {
  return (
    <>
      <BorrowCard {...p} />
      <RepayCard {...p} />
      <CollateralCard {...p} />
    </>
  );
}

function BorrowCard({ config, tier, v, s, market }: ActionsProps) {
  const submit = useSubmit();
  const [input, setInput] = useState("");
  const amount = parseAmount(input, config.usdc.decimals);
  const m = borrowMath(v, s.possible, amount, market);
  const name = TIER_LABEL[tier];
  const blocker = borrowBlocker({ halted: s.halted, account: v, market, amount, tierLabel: name });
  return (
    <Sheet demo="borrow-card">
      <SheetTitle sub={`Lenders are safe in every world: the ${name} tier lends up to ${pct(v.borrowLtv, WAD, 0)} of your worst world's collateral value.`}>
        Borrow real USDC · {name}
      </SheetTitle>
      <AmountField
        label="Amount (USDC)"
        value={input}
        onChange={setInput}
        unit="USDC"
        demo="borrow-amount"
        right={
          <InlineButton onClick={() => setInput(inputText(m.room, 2))} data-demo="borrow-max">
            max {fmtUsd(m.room)}
          </InlineButton>
        }
      />
      <div className="flex flex-col gap-1.5 text-[13px]">
        <Row label="health factor after" demo="hf-after" value={m.hfAfter !== undefined ? fmtHf(m.hfAfter) : "—"} tone={m.hfAfter !== undefined ? LIGHT[hfTone(m.hfAfter)] : undefined} />
        <Row label="limit used after" demo="limit-after" value={m.limitUsedAfter !== undefined ? pct(m.limitUsedAfter, WAD, 1) : "—"} />
        <Row label="APR after" demo="apr-after" value={m.aprAfter !== undefined ? pct(m.aprAfter, WAD, 2) : pct(annualRate(v.borrowRatePerSecond), WAD, 2)} />
      </div>
      <TxButton
        demo="borrow-confirm"
        action="borrow"
        label={`Borrow in ${name}`}
        busyLabel="Borrowing…"
        blocker={blocker}
        gas={GAS_CALL}
        needs={{ contract: true, tokens: ["usdc"] }}
        run={() => submit(borrow(CONTRACT_ID, { scenarioId: s.scenarioId, amount: amount!, tier }))}
        onDone={() => setInput("")}
      />
      <p className="num text-[12px] text-mute">
        {fmtUsd(market.liquid)} to lend in {name} · minimum loan {fmtUsd(v.minLoan)}
      </p>
    </Sheet>
  );
}

function RepayCard({ config, tier, v, s, walletUsdc }: ActionsProps) {
  const submit = useSubmit();
  const [input, setInput] = useState("");
  const all = input.trim().toLowerCase() === "all";
  const amount = all ? v.debt : parseAmount(input, config.usdc.decimals);
  const blocker = repayBlocker(v.debt, amount, all, walletUsdc, v.minLoan);
  return (
    <Sheet demo="repay-card">
      <SheetTitle>Repay</SheetTitle>
      <AmountField
        label="Amount (USDC), or “all”"
        value={input}
        onChange={setInput}
        unit="USDC"
        allowWords
        demo="repay-amount"
        right={
          <InlineButton onClick={() => setInput("all")} data-demo="repay-all">
            debt {fmtUsd(v.debt)}
          </InlineButton>
        }
      />
      <TxButton
        demo="repay-confirm"
        action="repay"
        tone="secondary"
        label="Repay"
        busyLabel="Repaying…"
        blocker={blocker}
        needs={{ contract: true }}
        run={() => {
          // Repay-all sends the debt plus 0.1%: interest accrues before it lands and the contract refunds the rest.
          const send = all ? repayAllSend(v.debt, walletUsdc) : amount!;
          const tokens = toTokenCeil(send, config.usdc.decimals);
          return submit(repay(config.usdc.tokenId, CONTRACT_ID, tokens, { scenarioId: s.scenarioId, all, tier }), "nonzero");
        }}
        onDone={() => setInput("")}
      />
      <p className="num text-[12px] text-mute">wallet {fmtUsd(walletUsdc)}</p>
    </Sheet>
  );
}

function CollateralCard({ config, tier, v, s, walletUsdc, walletWnear }: ActionsProps) {
  const submit = useSubmit();
  const [asset, setAsset] = useState<"usdc" | "wnear">("usdc");
  const [input, setInput] = useState("");
  const token = asset === "usdc" ? config.usdc : config.wnear;
  const wallet = asset === "usdc" ? walletUsdc : walletWnear;
  const amount = parseAmount(input, token.decimals);
  const full = v.collateral.length >= config.lending.maxCollateralPieces && !v.collateral.some((c) => c.isReal && c.asset === asset);
  const blocker = full ? `${config.lending.maxCollateralPieces} pieces is the most one loan can hold` : !amount ? "Enter an amount" : amount > wallet ? `Not enough ${token.symbol}` : undefined;
  return (
    <Sheet demo="collateral-card">
      <SheetTitle sub="Real USDC counts 1:1 in every world; real wNEAR at each world's price. Adding collateral raises your worst world.">Add collateral</SheetTitle>
      <Segmented
        size="sm"
        value={asset}
        onChange={(a) => {
          setAsset(a);
          setInput("");
        }}
        options={[
          { value: "usdc", label: "USDC", demo: "collateral-asset-usdc" },
          { value: "wnear", label: "wNEAR", demo: "collateral-asset-wnear" },
        ]}
      />
      <AmountField
        label={`Amount (${token.symbol})`}
        value={input}
        onChange={setInput}
        unit={token.symbol}
        demo="collateral-amount"
        right={<InlineButton onClick={() => setInput(inputText(wallet, 2))}>wallet {fmt(wallet, 2)}</InlineButton>}
      />
      <TxButton
        demo="collateral-confirm"
        action="add_collateral"
        tone="secondary"
        label={`Add to ${TIER_LABEL[tier]}`}
        busyLabel="Adding…"
        blocker={blocker}
        needs={{ contract: true }}
        run={() => {
          const tokens = toTokenFloor(amount!, token.decimals);
          return submit(depositCollateral(token.tokenId, CONTRACT_ID, tokens, { scenarioId: s.scenarioId, tier }), tokens);
        }}
        onDone={() => setInput("")}
      />
    </Sheet>
  );
}

function Row({ label, value, tone, demo }: { label: string; value: string; tone?: string; demo?: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-mute">{label}</span>
      <span className={`num text-[15px] ${tone ?? "text-ink"}`} data-demo={demo}>
        {value}
      </span>
    </div>
  );
}
