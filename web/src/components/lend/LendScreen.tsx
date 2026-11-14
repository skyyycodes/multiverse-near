"use client";

import { useState } from "react";
import { RateCurve } from "@/components/lending/RateCurve";
import { TierPicker } from "@/components/lending/TierPicker";
import { MarketHeader } from "@/components/markets/MarketHeader";
import { HeroNumber, Screen } from "@/components/shell/Screen";
import { ConfigGuard } from "@/components/trade/Guard";
import { InlineButton } from "@/components/ui/Button";
import { StatTile } from "@/components/ui/Bits";
import { AmountField } from "@/components/ui/Field";
import { ChainWait } from "@/components/ui/Notice";
import { Block, Sheet, SheetTitle } from "@/components/ui/Surface";
import { TxButton } from "@/components/ui/TxButton";
import { CONTRACT_ID } from "@/lib/data/client";
import type { Account, AppConfig, LendingMarket, Tier } from "@/lib/domain";
import { fmtUsd, inputText, parseAmount, pct } from "@/lib/format";
import { useBalances, useLend, useScenarioId } from "@/lib/hooks/useData";
import { useLendingTiers } from "@/lib/hooks/useLending";
import { useIsDesktop } from "@/lib/hooks/useMedia";
import { useScreenTier } from "@/lib/hooks/useTier";
import { useSubmit } from "@/lib/hooks/useTx";
import { annualRate, badDebtNotice, badDebtOf, earnedOf, supplyBlocker, WAD, withdrawBlocker, type SupplySeen } from "@/lib/lending";
import { lendHref } from "@/lib/links";
import { fundInsurance, supply, withdrawSupply } from "@/lib/near/tx";
import { useWallet } from "@/lib/near/wallet";
import { TIER_LABEL } from "@/lib/tiers";
import { toTokenCeil } from "@/lib/units";
import { RootLpPanel } from "./RootLpPanel";

/** Lend real USDC to one tier of a market: safe in every world because every loan is limited by its worst world. */
export function LendScreen() {
  return <ConfigGuard>{(config) => <LendMarket config={config} />}</ConfigGuard>;
}

function LendMarket({ config }: { config: AppConfig }) {
  const sid = useScenarioId(config);
  return sid === undefined ? null : <Lend key={sid} config={config} sid={sid} />;
}

function Lend({ config, sid }: { config: AppConfig; sid: number }) {
  const wallet = useWallet();
  const desktop = useIsDesktop();
  const tiers = useLendingTiers(sid, wallet.accountId);
  const { tier, pick, ready } = useScreenTier(sid, tiers.data, "lend", lendHref);
  const view = useLend(ready ? sid : undefined, wallet.accountId, tier);
  const balances = useBalances(wallet.accountId, config.wnear, config.usdc);
  const v = view.data?.account;
  const market = tiers.data?.find((t) => t.tier === tier)?.market;
  const name = TIER_LABEL[tier];
  const notice = useBadDebtNotice(`${sid}:${tier}:${wallet.accountId ?? ""}`, market, v);

  const stats =
    v && market ? (
      <Block demo="lend-stats">
        {notice && (
          <p role="status" data-demo="bad-debt-notice" className="rounded-[16px] border border-warn-bright/50 bg-warn-bright/12 px-4 py-3 text-[13px] leading-relaxed text-warn">
            Lenders absorbed {fmtUsd(notice.socialized)} of bad debt; your supply went from {fmtUsd(notice.before)} to {fmtUsd(notice.after)}.
          </p>
        )}
        <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
          <StatTile label="Supply APR" value={pct(annualRate(market.supplyRatePerSec), WAD, 2)} note={`borrow APR × utilization × ${pct(WAD - market.config.reserveFactor, WAD, 0)}`} />
          <StatTile label="Borrow APR" value={pct(annualRate(market.borrowRatePerSec), WAD, 2)} note="variable: rises with utilization" />
          <StatTile demo="stat-utilization" label="Utilization" value={pct(market.utilization, WAD, 1)} note={`${fmtUsd(market.totalBorrow)} of ${fmtUsd(market.totalSupply)}`} />
          <StatTile demo="stat-liquid" label="Available to withdraw" value={fmtUsd(market.liquid)} note="USDC not lent out" />
          <StatTile demo="stat-supplied" label="You supplied" value={fmtUsd(v.supplied)} note="including interest" />
          <StatTile demo="stat-earned" label="You earned" value={fmtUsd(earnedOf(v))} note="since your first deposit" />
          <StatTile demo="stat-insurance" label="Insurance fund" value={fmtUsd(market.insurance)} note={`${pct(market.config.reserveFactor, WAD, 0)} of interest; pays bad debt first`} />
          <StatTile
            demo="stat-bad-debt"
            label="Bad debt"
            value={fmtUsd(badDebtOf(market))}
            tone={market.badDebtSocialized > 0n ? "warn" : undefined}
            note={`insurance ${fmtUsd(market.badDebtCovered)} · lenders ${fmtUsd(market.badDebtSocialized)}`}
          />
        </div>
        <RateCurve config={market.config} utilization={market.utilization} />
        <p className="text-[13px] leading-relaxed text-mute">
          Every borrower in the {name} tier is limited to {pct(market.config.borrowLtv, WAD, 0)} of the world where their collateral is worth least, so
          the debt is covered in every world that can still happen. The rate rises with utilization: steeply past {pct(market.config.rateKink, WAD, 0)}.
        </p>
      </Block>
    ) : (
      <Block>
        <ChainWait error={(view.error ?? tiers.error)?.message} onRetry={() => void (view.error ? view.refetch() : tiers.refetch())} />
      </Block>
    );

  const forms = v && market ? <Forms config={config} sid={sid} tier={tier} v={v} market={market} walletUsdc={balances.data?.usdc ?? 0n} /> : null;
  const rootLp = view.data ? <RootLpPanel config={config} sid={sid} view={view.data} balances={balances.data} /> : null;

  return (
    <Screen
      demo="lend"
      hero={
        <div className="flex flex-col gap-5">
          <MarketHeader sid={sid} compact />
          <TierPicker tiers={tiers.data} value={tier} onChange={pick} mode="lend" />
          <HeroNumber
            demo="hero-supply-apr"
            label={`Supply APR · ${name}`}
            loading={!market}
            value={market ? pct(annualRate(market.supplyRatePerSec), WAD, 2) : "—"}
            sub={
              market
                ? `${fmtUsd(market.totalBorrow)} of ${fmtUsd(market.totalSupply)} lent out at ${pct(annualRate(market.borrowRatePerSec), WAD, 2)} (variable)`
                : undefined
            }
          />
        </div>
      }
      aside={desktop ? forms : undefined}
    >
      {stats}
      {!desktop && forms}
      {rootLp}
    </Screen>
  );
}

/** The supply and bad-debt totals this screen first saw for a tier (in memory only), for `badDebtNotice`. */
function useBadDebtNotice(key: string, market: LendingMarket | undefined, v: Account | undefined) {
  const [first, setFirst] = useState<{ key: string; seen: SupplySeen } | undefined>(undefined);
  const now = market && v ? { socialized: market.badDebtSocialized, supplied: v.supplied } : undefined;
  if (now && first?.key !== key) setFirst({ key, seen: now });
  if (!now || first?.key !== key) return undefined;
  return badDebtNotice(first.seen, now);
}

type FormsProps = { config: AppConfig; sid: number; tier: Tier; v: Account; market: LendingMarket; walletUsdc: bigint };

function Forms({ config, sid, tier, v, market, walletUsdc }: FormsProps) {
  const submit = useSubmit();
  const [supplyInput, setSupplyInput] = useState("");
  const [withdrawInput, setWithdrawInput] = useState("");
  const supplyAmount = parseAmount(supplyInput, config.usdc.decimals);
  const withdrawAll = withdrawInput.trim().toLowerCase() === "all";
  const withdrawAmount = withdrawAll ? v.supplied : parseAmount(withdrawInput, config.usdc.decimals);
  const name = TIER_LABEL[tier];

  return (
    <>
      <Sheet demo="supply-card">
        <SheetTitle sub={`Earn the ${name} tier's supply rate; withdraw whatever is not lent out at any time.`}>Supply USDC · {name}</SheetTitle>
        <AmountField
          label="Amount (USDC)"
          value={supplyInput}
          onChange={setSupplyInput}
          unit="USDC"
          demo="supply-amount"
          right={<InlineButton onClick={() => setSupplyInput(inputText(walletUsdc, 2))}>wallet {fmtUsd(walletUsdc)}</InlineButton>}
        />
        <TxButton
          demo="supply-confirm"
          action="supply"
          label={`Supply to ${name}`}
          busyLabel="Supplying…"
          blocker={supplyBlocker(market, supplyAmount, walletUsdc, name)}
          needs={{ contract: true }}
          run={() => {
            const tokens = toTokenCeil(supplyAmount!, config.usdc.decimals);
            return submit(supply(config.usdc.tokenId, CONTRACT_ID, tokens, { scenarioId: sid, tier }), tokens);
          }}
          onDone={() => setSupplyInput("")}
        />
      </Sheet>

      <Sheet demo="withdraw-card">
        <SheetTitle>Withdraw</SheetTitle>
        <AmountField
          label="Amount (USDC), or “all”"
          value={withdrawInput}
          onChange={setWithdrawInput}
          unit="USDC"
          allowWords
          demo="withdraw-amount"
          right={
            <InlineButton onClick={() => setWithdrawInput("all")} data-demo="withdraw-all">
              supplied {fmtUsd(v.supplied)}
            </InlineButton>
          }
        />
        <TxButton
          demo="withdraw-confirm"
          action="withdraw_supply"
          tone="secondary"
          label="Withdraw"
          busyLabel="Withdrawing…"
          blocker={withdrawBlocker(v.supplied, withdrawAmount, market.liquid)}
          needs={{ contract: true, tokens: ["usdc"] }}
          run={() => submit(withdrawSupply(CONTRACT_ID, { scenarioId: sid, amount: withdrawAll ? null : withdrawAmount!, tier }))}
          onDone={() => setWithdrawInput("")}
        />
      </Sheet>

      <InsuranceCard config={config} sid={sid} tier={tier} walletUsdc={walletUsdc} />
    </>
  );
}

function InsuranceCard({ config, sid, tier, walletUsdc }: { config: AppConfig; sid: number; tier: Tier; walletUsdc: bigint }) {
  const submit = useSubmit();
  const [input, setInput] = useState("");
  const amount = parseAmount(input, config.usdc.decimals);
  const name = TIER_LABEL[tier];
  return (
    <Sheet demo="insurance-card">
      <SheetTitle sub={`Add USDC to the ${name} tier's insurance fund. It covers bad debt before lenders lose anything. A donation: it cannot be taken back.`}>
        Fund insurance
      </SheetTitle>
      <AmountField label="Amount (USDC)" value={input} onChange={setInput} unit="USDC" demo="insurance-amount" />
      <TxButton
        demo="insurance-confirm"
        action="fund_insurance"
        tone="secondary"
        label={`Donate to ${name} insurance`}
        busyLabel="Donating…"
        blocker={!amount ? "Enter an amount" : amount > walletUsdc ? "Not enough USDC" : undefined}
        needs={{ contract: true }}
        run={() => {
          const tokens = toTokenCeil(amount!, config.usdc.decimals);
          return submit(fundInsurance(config.usdc.tokenId, CONTRACT_ID, tokens, { scenarioId: sid, tier }), tokens);
        }}
        onDone={() => setInput("")}
      />
    </Sheet>
  );
}
