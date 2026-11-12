"use client";

import { useState } from "react";
import { HeroNumber, Screen } from "@/components/shell/Screen";
import { ConfigGuard } from "@/components/trade/Guard";
import { InlineButton } from "@/components/ui/Button";
import { StatTile } from "@/components/ui/Bits";
import { AmountField } from "@/components/ui/Field";
import { ChainWait } from "@/components/ui/Notice";
import { Block, Sheet, SheetTitle } from "@/components/ui/Surface";
import { TxButton } from "@/components/ui/TxButton";
import { CONTRACT_ID } from "@/lib/data/client";
import type { Account, AppConfig } from "@/lib/domain";
import { fmtUsd, inputText, parseAmount, pct } from "@/lib/format";
import { useBalances, useLend, useScenarioId } from "@/lib/hooks/useData";
import { useIsDesktop } from "@/lib/hooks/useMedia";
import { useSubmit } from "@/lib/hooks/useTx";
import { annualRate, earnedOf, marketLiquidity, WAD } from "@/lib/lending";
import { call, ftTransferCall } from "@/lib/near/tx";
import { useWallet } from "@/lib/near/wallet";
import { toTokenCeil } from "@/lib/units";
import { RootLpPanel } from "./RootLpPanel";

/** Lend real USDC to a scenario's market: safe in every world because every loan is limited by its worst world. */
export function LendScreen() {
  return <ConfigGuard>{(config) => <Lend config={config} />}</ConfigGuard>;
}

function Lend({ config }: { config: AppConfig }) {
  const wallet = useWallet();
  const desktop = useIsDesktop();
  const sid = useScenarioId(config);
  const view = useLend(sid, wallet.accountId);
  const balances = useBalances(wallet.accountId, config.wnear, config.usdc);
  const v = view.data?.account;

  const stats = v ? (
    <Block demo="lend-stats">
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
        <StatTile label="Supply APR" value={pct(annualRate(v.supplyRatePerSecond), WAD, 2)} note="borrow APR × utilization" />
        <StatTile label="Borrow APR" value={pct(annualRate(v.borrowRatePerSecond), WAD, 2)} note="fixed" />
        <StatTile demo="stat-utilization" label="Utilization" value={pct(v.utilization, WAD, 1)} note={`${fmtUsd(v.marketBorrow)} of ${fmtUsd(v.marketSupply)}`} />
        <StatTile demo="stat-supplied" label="You supplied" value={fmtUsd(v.supplied)} note="including interest" />
        <StatTile demo="stat-earned" label="You earned" value={fmtUsd(earnedOf(v))} note="since your first deposit" />
        <StatTile label="Available to withdraw" value={fmtUsd(marketLiquidity(v))} note="USDC not lent out" />
      </div>
      <p className="text-[13px] leading-relaxed text-mute">
        Every borrower here is limited by the world where their collateral is worth least, so the debt is covered in every
        world that can still happen. Lenders are paid the fixed borrow rate on the share that is lent out.
      </p>
    </Block>
  ) : (
    <Block>
      <ChainWait error={view.error?.message} onRetry={() => void view.refetch()} />
    </Block>
  );

  const forms = v ? <Forms config={config} sid={sid!} v={v} walletUsdc={balances.data?.usdc ?? 0n} /> : null;
  const rootLp = sid !== undefined && view.data ? <RootLpPanel config={config} sid={sid} view={view.data} balances={balances.data} /> : null;

  return (
    <Screen
      demo="lend"
      hero={
        <HeroNumber
          demo="hero-supply-apr"
          label="Supply APR"
          loading={!v}
          value={v ? pct(annualRate(v.supplyRatePerSecond), WAD, 2) : "—"}
          sub={v ? `${fmtUsd(v.marketBorrow)} of ${fmtUsd(v.marketSupply)} lent out, at a fixed ${pct(annualRate(v.borrowRatePerSecond), WAD, 2)} borrow APR` : undefined}
        />
      }
      aside={desktop ? forms : undefined}
    >
      {stats}
      {!desktop && forms}
      {rootLp}
    </Screen>
  );
}

function Forms({ config, sid, v, walletUsdc }: { config: AppConfig; sid: number; v: Account; walletUsdc: bigint }) {
  const submit = useSubmit();
  const [supplyInput, setSupplyInput] = useState("");
  const [withdrawInput, setWithdrawInput] = useState("");
  const supplyAmount = parseAmount(supplyInput, config.usdc.decimals);
  const withdrawAll = withdrawInput.trim().toLowerCase() === "all";
  const withdrawAmount = withdrawAll ? v.supplied : parseAmount(withdrawInput, config.usdc.decimals);
  const liquidity = marketLiquidity(v);

  return (
    <>
      <Sheet demo="supply-card">
        <SheetTitle>Supply USDC</SheetTitle>
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
          label="Supply"
          busyLabel="Supplying…"
          blocker={!supplyAmount ? "Enter an amount" : supplyAmount > walletUsdc ? "Not enough USDC" : undefined}
          needs={{ contract: true }}
          run={() => {
            const tokens = toTokenCeil(supplyAmount!, config.usdc.decimals);
            return submit(ftTransferCall(config.usdc.tokenId, CONTRACT_ID, tokens, { action: "supply", scenario_id: sid }), tokens);
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
          tone="secondary"
          label="Withdraw"
          busyLabel="Withdrawing…"
          blocker={!v.supplied ? "Nothing supplied" : !withdrawAmount ? "Enter an amount" : withdrawAmount > liquidity ? "Lent out right now" : undefined}
          needs={{ contract: true, tokens: ["usdc"] }}
          run={() =>
            submit(call(CONTRACT_ID, "withdraw_supply", { scenario_id: sid, amount: withdrawAll ? null : withdrawAmount!.toString() }))
          }
          onDone={() => setWithdrawInput("")}
        />
      </Sheet>
    </>
  );
}
