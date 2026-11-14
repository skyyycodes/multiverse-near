"use client";

import { useState } from "react";
import { InfoRows } from "@/components/ui/Bits";
import { Sheet, SheetTitle } from "@/components/ui/Surface";
import { TxButton } from "@/components/ui/TxButton";
import { CONTRACT_ID } from "@/lib/data/client";
import type { Account, AppConfig, Scenario, Tier } from "@/lib/domain";
import { fmt, fmtAsset, fmtNear, fmtUsd } from "@/lib/format";
import { useLendingTiers } from "@/lib/hooks/useLending";
import { useSubmit } from "@/lib/hooks/useTx";
import { eventsOf } from "@/lib/near/outcome";
import { closeAfterResolution, closeWithDebt } from "@/lib/near/tx";
import { useWallet } from "@/lib/near/wallet";
import { fateText, planClose, summarizeClose, type CloseSummary } from "@/lib/settlement";
import { TIER_LABEL } from "@/lib/tiers";
import { toTokenCeil } from "@/lib/units";

// What a close paid out, per account, scenario and tier, for the rest of the session: the panel is rebuilt when the
// layout switches between phone and desktop, and the position it describes is gone once the close lands.
const closes = new Map<string, CloseSummary>();
const closeKey = (sid: number, account: string | null, tier: Tier) => `${CONTRACT_ID}:${sid}:${account ?? ""}:${tier}`;
const hasPosition = (v: Account) => v.debt > 0n || v.collateral.length > 0;

/**
 * One "Close and redeem" sheet per tier with a position (or one that closed this session), from `lending_tiers`
 * (web 6.7). Without a position anywhere: one sheet for Normal (`normal`, the resolve view's account) saying so.
 */
export function ClosePanels({ config, s, normal, walletUsdc }: { config: AppConfig; s: Scenario; normal: Account; walletUsdc: bigint }) {
  const wallet = useWallet();
  const tiers = useLendingTiers(wallet.accountId ? s.scenarioId : undefined, wallet.accountId);
  const shown = (tiers.data ?? []).filter((t) => t.account && (hasPosition(t.account) || closes.has(closeKey(s.scenarioId, wallet.accountId, t.tier))));
  if (shown.length === 0) return <ClosePanel config={config} s={s} tier="normal" v={normal} walletUsdc={walletUsdc} labelled={false} />;
  return (
    <>
      {shown.map((t) => (
        <ClosePanel key={t.tier} config={config} s={s} tier={t.tier} v={t.account!} walletUsdc={walletUsdc} labelled />
      ))}
    </>
  );
}

/** Repay, withdraw and redeem one tier's position in one transaction, with what the account gets shown first. */
function ClosePanel({
  config,
  s,
  tier,
  v,
  walletUsdc,
  labelled,
}: {
  config: AppConfig;
  s: Scenario;
  tier: Tier;
  v: Account;
  walletUsdc: bigint;
  labelled: boolean;
}) {
  const wallet = useWallet();
  const submit = useSubmit();
  const key = closeKey(s.scenarioId, wallet.accountId, tier);
  const [closed, setClosedState] = useState<CloseSummary | undefined>(() => closes.get(key));
  const setClosed = (c: CloseSummary | undefined) => {
    if (c) closes.set(key, c);
    setClosedState(c);
  };
  const plan = planClose(v.collateral, s.possible);
  const open = hasPosition(v);

  let blocker: string | undefined;
  if (!open) blocker = "Nothing to close";
  else if (s.resolutionCount === 0) blocker = "Opens once an event resolves";
  else if (v.debt > walletUsdc) blocker = `Needs ${fmt(v.debt)} USDC in your wallet to repay`;

  async function run(step: (s: string) => void): Promise<string> {
    step("Closing…");
    const record = (o: Parameters<typeof eventsOf>[0]) => {
      const summary = summarizeClose(eventsOf(o));
      // Design data has no logs; it reports the plan it showed.
      setClosed(summary ?? (wallet.fixtures ? { repaid: v.debt, usdc: plan.realUsdc, wnear: plan.realWnear } : undefined));
    };
    if (v.debt > 0n) {
      // The debt grows by a few seconds of interest before this lands: send 0.1% more, bounded by the wallet; the
      // contract returns what it does not use.
      const cap = v.debt + v.debt / 1000n;
      const tokens = toTokenCeil(cap > walletUsdc ? walletUsdc : cap, config.usdc.decimals);
      return submit(
        closeWithDebt(config.usdc.tokenId, CONTRACT_ID, tokens, {
          scenarioId: s.scenarioId,
          tier,
        }),
        "nonzero",
        record,
      );
    }
    return submit(closeAfterResolution(CONTRACT_ID, { scenarioId: s.scenarioId, tier }), undefined, record);
  }

  return (
    <Sheet demo="close-panel" tier={tier}>
      <SheetTitle sub="One transaction: repay the whole loan from your wallet, withdraw every piece of collateral, and redeem each piece that has collapsed (it covers every world still possible) for the real asset 1:1. Live pieces come back as they are; dead pieces too, worth nothing.">
        {labelled ? `Close and redeem · ${TIER_LABEL[tier]}` : "Close and redeem"}
      </SheetTitle>

      {open && (
        <>
          <div className="flex flex-col" data-demo="close-pieces">
            <div className="flex items-baseline justify-between border-b border-line pb-2">
              <span className="label text-mute">Collateral</span>
              <span className="label text-mute">Amount</span>
            </div>
            {plan.pieces.map((p) => (
              <div
                key={p.tokenId}
                className={`flex items-start justify-between gap-3 border-b border-line py-2.5 last:border-b-0 ${p.fate === "dead" ? "opacity-60" : ""}`}
              >
                <div className="min-w-0">
                  <div className={`truncate text-[13px] font-semibold text-ink ${p.fate === "dead" ? "line-through" : ""}`}>{p.label}</div>
                  <div className={`text-[12px] ${p.fate === "redeems" ? "text-pos" : "text-mute"}`}>{fateText(p)}</div>
                </div>
                <span className="num shrink-0 text-[13px] text-ink">{fmtAsset(p.asset, p.amount)}</span>
              </div>
            ))}
          </div>
          <InfoRows
            rows={[
              {
                label: "You repay (loan plus interest)",
                value: fmtUsd(v.debt),
              },
              {
                label: "You receive, real",
                value: `${fmt(plan.realUsdc)} USDC${plan.realWnear > 0n ? ` + ${fmtNear(plan.realWnear)} wNEAR` : ""}`,
                tone: "text-pos",
                demo: "close-receive",
              },
              {
                label: "Wallet USDC now → after",
                value: `${fmtUsd(walletUsdc)} → ${fmtUsd(walletUsdc - v.debt + plan.realUsdc)}`,
              },
            ]}
          />
        </>
      )}
      {wallet.accountId && !open && !closed && <p className="text-[13px] text-mute">Nothing to close: this wallet has no loan or collateral in this market.</p>}

      <TxButton
        demo="close-confirm"
        action="close"
        label={labelled ? `Close ${TIER_LABEL[tier]} and redeem` : "Close and redeem"}
        busyLabel="Closing…"
        blocker={blocker}
        needs={{ contract: true, tokens: ["usdc", "wnear"] }}
        run={run}
      />
      {closed && (
        <p className="num text-[13px] text-pos" data-demo="close-result">
          Repaid {fmtUsd(closed.repaid)}; redeemed {fmt(closed.usdc)} real USDC
          {closed.wnear > 0n ? ` and ${fmtNear(closed.wnear)} real wNEAR` : ""}.
        </p>
      )}
    </Sheet>
  );
}
