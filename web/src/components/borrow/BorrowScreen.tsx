"use client";

import { useState } from "react";
import { HeroNumber, Screen } from "@/components/shell/Screen";
import { ConfigGuard } from "@/components/trade/Guard";
import { InlineButton } from "@/components/ui/Button";
import { SectionLabel } from "@/components/ui/Bits";
import { AmountField } from "@/components/ui/Field";
import { ChainWait } from "@/components/ui/Notice";
import { Block, Sheet, SheetTitle } from "@/components/ui/Surface";
import { TxButton } from "@/components/ui/TxButton";
import { WorldGlyph } from "@/components/world/WorldBits";
import { alpha, hueOf } from "@/components/world/hues";
import { CONTRACT_ID } from "@/lib/data/client";
import type { Account, AppConfig, Scenario } from "@/lib/domain";
import { fmt, fmtHf, fmtUsd, hfTone, inputText, parseAmount, pct, type Tone } from "@/lib/format";
import { useBalances, useBorrow, useScenarioId } from "@/lib/hooks/useData";
import { useSubmit } from "@/lib/hooks/useTx";
import { annualRate, barWidth, borrowMath, linePosition, liquidationOf, neededValue, WAD } from "@/lib/lending";
import { call, ftTransferCall } from "@/lib/near/tx";
import { useWallet } from "@/lib/near/wallet";
import { toTokenCeil } from "@/lib/units";

const DARK: Record<Tone, string> = { ok: "text-pos-dark", warn: "text-warn-dark", bad: "text-neg-dark" };
const LIGHT: Record<Tone, string> = { ok: "text-pos", warn: "text-warn", bad: "text-neg" };

export function BorrowScreen() {
  return <ConfigGuard>{(config) => <Borrow config={config} />}</ConfigGuard>;
}

function Borrow({ config }: { config: AppConfig }) {
  const wallet = useWallet();
  const sid = useScenarioId(config);
  const view = useBorrow(sid, wallet.accountId);
  const balances = useBalances(wallet.accountId, config.wnear, config.usdc);
  const v = view.data?.account;
  const s = view.data?.scenario;
  const liq = v && s ? liquidationOf(v, s) : undefined;
  const worst = v && s && v.collateral.length > 0 && v.worstWorld !== null ? s.worlds[v.worstWorld] : undefined;

  return (
    <Screen
      demo="borrow"
      hero={
        <div className="flex flex-col gap-5">
          <HeroNumber
            demo="hero-hf"
            label="Health factor (worst world)"
            loading={!v}
            value={v ? fmtHf(v.healthFactor) : "—"}
            tone={v ? DARK[hfTone(v.healthFactor)] : undefined}
            sub={
              v && s ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span>{worst ? `worst world: ${worst.label}` : v.collateral.length === 0 ? "no collateral posted" : "worst world: —"}</span>
                  {liq?.state === "liquidatable" && (
                    <span className="rounded-full border border-neg-dark px-2 py-0.5 text-[11px] font-semibold tracking-[0.08em] text-neg-dark uppercase" data-demo="badge-liquidatable">
                      Liquidatable
                    </span>
                  )}
                  {(liq?.state === "paused_halted" || liq?.state === "paused_no_price") && (
                    <span className="rounded-full border border-warn-dark px-2 py-0.5 text-[11px] font-semibold tracking-[0.08em] text-warn-dark uppercase" data-demo="badge-paused">
                      Liquidation paused
                    </span>
                  )}
                </span>
              ) : undefined
            }
          />
          {v && (
            <div className="grid grid-cols-3 gap-2" data-demo="borrow-stats">
              <HeroStat label="debt" value={fmtUsd(v.debt)} />
              <HeroStat label="LLTV" value={pct(v.lltv, WAD, 0)} />
              <HeroStat label="borrow APR (fixed)" value={pct(annualRate(v.borrowRatePerSecond), WAD, 2)} />
            </div>
          )}
        </div>
      }
      aside={v && s ? <Actions config={config} v={v} s={s} walletUsdc={balances.data?.usdc ?? 0n} /> : undefined}
    >
      {v && s ? (
        <WorldsPanel v={v} s={s} liq={liq!} />
      ) : (
        <Block>
          <ChainWait error={view.error?.message} onRetry={() => void view.refetch()} />
        </Block>
      )}
    </Screen>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[16px] border border-white/10 bg-white/6 px-3 py-2.5 backdrop-blur-sm">
      <span className="text-[11px] leading-tight text-white/60">{label}</span>
      <span className="num truncate text-[15px] text-white">{value}</span>
    </div>
  );
}

/** Collateral value in every world against the line where the loan reaches HF 1, and what is posted. */
function WorldsPanel({ v, s, liq }: { v: Account; s: Scenario; liq: ReturnType<typeof liquidationOf> }) {
  const max = v.collateralValues.reduce((m, x) => (x > m ? x : m), 0n);
  const needed = neededValue(v.debt, v.lltv);
  return (
    <Block title="Collateral by world" demo="borrow-worlds">
      {(liq.state === "paused_halted" || liq.state === "paused_no_price") && (
        <p role="status" className="rounded-[16px] border border-warn-bright/50 bg-warn-bright/12 px-4 py-3 text-[13px] leading-relaxed text-warn">
          {liq.state === "paused_halted"
            ? "Health factor below 1, but liquidations wait while a result is in its dispute window: resolution can only raise it."
            : `Health factor below 1 because ${liq.unpricedLabel ?? "a world"} has no valid price yet. Liquidations wait for one: a missing price counts as zero for borrowing, never for liquidation.`}
        </p>
      )}
      {liq.state === "liquidatable" && (
        <p role="alert" className="rounded-[16px] border border-neg/40 bg-neg-bright/8 px-4 py-3 text-[13px] leading-relaxed text-neg" data-demo="liquidatable-banner">
          Health factor below 1: this loan can be liquidated. Anyone may repay up to half of the debt and take the same share
          of every piece of collateral, worth the repayment plus a bonus in your worst world. Repay or add collateral to lift
          it back above 1.
        </p>
      )}
      <ul className="flex flex-col gap-3" data-demo="collateral-bars">
        {s.worlds.map((w) => {
          const value = v.collateralValues[w.index] ?? 0n;
          const dead = !w.possible;
          const worst = v.collateral.length > 0 && w.index === v.worstWorld;
          const hue = hueOf(w.index, !dead);
          return (
            <li key={w.mask} className={`flex flex-col gap-1.5 ${dead ? "opacity-35" : ""}`} data-world={w.label}>
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2.5">
                  <WorldGlyph world={w} size={28} />
                  <span className={`truncate text-[13px] ${worst ? "font-semibold text-ink" : "text-ink"} ${dead ? "line-through" : ""}`}>{w.label}</span>
                  {worst && <span className="rounded-full bg-ink px-2 py-0.5 text-[10px] font-bold tracking-[0.08em] text-white uppercase">worst</span>}
                </span>
                <span className="num shrink-0 text-[13px] text-ink">{dead ? "resolved away" : fmtUsd(value)}</span>
              </div>
              <div className="relative h-3 overflow-hidden rounded-full bg-tile">
                <div
                  className="h-full rounded-full transition-[width] duration-500"
                  style={{ width: `${barWidth(value, max)}%`, background: worst ? hue : alpha(hue, 0.5) }}
                />
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
        Collateral value in each world. The dashed line is where the loan would reach HF 1; the worst world sets the limit.
        USDC-if-w counts 1:1 in its world; WETH-if-w at that world&apos;s TWAP price
        {v.worldPriceOk.every(Boolean) ? "." : " (worlds without enough TWAP history or liquidity count zero)."}
      </p>
      <div className="flex flex-col gap-2" data-demo="posted-collateral">
        <SectionLabel>Posted collateral</SectionLabel>
        {v.collateral.length === 0 ? (
          <p className="text-[13px] text-mute">None yet. Sell with “keep as loan collateral” on the Trade screen.</p>
        ) : (
          <ul className="flex flex-col">
            {v.collateral.map((c) => (
              <li key={c.tokenId} className="flex justify-between gap-3 border-b border-line py-2 text-[13px] last:border-b-0">
                <span className="truncate text-ink">{c.label}</span>
                <span className="num text-ink">{fmt(c.amount, 4)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Block>
  );
}

function Actions({ config, v, s, walletUsdc }: { config: AppConfig; v: Account; s: Scenario; walletUsdc: bigint }) {
  const submit = useSubmit();
  const [borrowInput, setBorrowInput] = useState("");
  const [repayInput, setRepayInput] = useState("");
  const borrowAmount = parseAmount(borrowInput, config.usdc.decimals);
  const m = borrowMath(v, s.possible, borrowAmount);
  const repayAll = repayInput.trim().toLowerCase() === "all";
  const repayAmount = repayAll ? v.debt : parseAmount(repayInput, config.usdc.decimals);

  let borrowBlocker: string | undefined;
  if (s.halted) borrowBlocker = "Paused while a resolution is pending";
  else if (!borrowAmount) borrowBlocker = "Enter an amount";
  else if (borrowAmount > m.liquidity) borrowBlocker = "Not enough USDC in the market";
  else if (m.hfAfter !== undefined && m.hfAfter < WAD) borrowBlocker = "Health factor would fall below 1";

  const repayBlocker = !v.debt ? "No debt" : !repayAmount ? "Enter an amount" : repayAmount > walletUsdc ? "Not enough USDC" : undefined;

  return (
    <>
      <Sheet demo="borrow-card">
        <SheetTitle sub="Lenders are safe in every world: you can borrow up to your worst world's collateral value times LLTV.">Borrow real USDC</SheetTitle>
        <AmountField
          label="Amount (USDC)"
          value={borrowInput}
          onChange={setBorrowInput}
          unit="USDC"
          demo="borrow-amount"
          right={
            <InlineButton onClick={() => setBorrowInput(inputText(m.room, 2))} data-demo="borrow-max">
              max {fmtUsd(m.room)}
            </InlineButton>
          }
        />
        <div className="flex items-baseline justify-between text-[13px]">
          <span className="text-mute">health factor after</span>
          <span className={`num text-[15px] ${m.hfAfter !== undefined ? LIGHT[hfTone(m.hfAfter)] : "text-ink"}`} data-demo="hf-after">
            {m.hfAfter !== undefined ? fmtHf(m.hfAfter) : "—"}
          </span>
        </div>
        <TxButton
          demo="borrow-confirm"
          label="Borrow"
          busyLabel="Borrowing…"
          blocker={borrowBlocker}
          needs={{ contract: true, tokens: ["usdc"] }}
          run={() => submit(call(CONTRACT_ID, "borrow", { scenario_id: s.scenarioId, amount: borrowAmount!.toString() }))}
          onDone={() => setBorrowInput("")}
        />
        <p className="num text-[12px] text-mute">
          market liquidity {fmtUsd(m.liquidity)} · wallet {fmtUsd(walletUsdc)}
        </p>
      </Sheet>

      <Sheet demo="repay-card">
        <SheetTitle>Repay</SheetTitle>
        <AmountField
          label="Amount (USDC), or “all”"
          value={repayInput}
          onChange={setRepayInput}
          unit="USDC"
          allowWords
          demo="repay-amount"
          right={
            <InlineButton onClick={() => setRepayInput("all")} data-demo="repay-all">
              debt {fmtUsd(v.debt)}
            </InlineButton>
          }
        />
        <TxButton
          demo="repay-confirm"
          tone="secondary"
          label="Repay"
          busyLabel="Repaying…"
          blocker={repayBlocker}
          needs={{ contract: true }}
          run={() => {
            // Repay-all sends the debt plus 0.1%: interest accrues between this read and the transaction, and the
            // contract hands back whatever it did not need. Never more than the wallet holds.
            const needed = repayAll ? v.debt + v.debt / 1000n : repayAmount!;
            const send = needed > walletUsdc && repayAll ? walletUsdc : needed;
            const tokens = toTokenCeil(send, config.usdc.decimals);
            return submit(
              ftTransferCall(config.usdc.tokenId, CONTRACT_ID, tokens, { action: "repay", scenario_id: s.scenarioId, all: repayAll }),
              "nonzero",
            );
          }}
          onDone={() => setRepayInput("")}
        />
      </Sheet>
    </>
  );
}
