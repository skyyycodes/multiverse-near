"use client";

import { useState } from "react";
import { InlineButton } from "@/components/ui/Button";
import { SectionLabel } from "@/components/ui/Bits";
import { AmountField } from "@/components/ui/Field";
import { Block } from "@/components/ui/Surface";
import { TxButton } from "@/components/ui/TxButton";
import { WorldGlyph } from "@/components/world/WorldBits";
import { CONTRACT_ID } from "@/lib/data/client";
import type { AppConfig, LendSnapshot } from "@/lib/domain";
import { fmt, fmtUsd, fmtWeth, inputText, parseAmount, pct } from "@/lib/format";
import { useLpPreview, type Balances } from "@/lib/hooks/useData";
import { useSubmit } from "@/lib/hooks/useTx";
import { call, ftTransferCall } from "@/lib/near/tx";
import { scaleOf, toTokenCeil } from "@/lib/units";

/** Minimums sent with a deposit or withdrawal: the preview less 0.5%, so a pool that moves in between reverts it. */
const lessSlippage = (x: bigint) => (x * 9_950n) / 10_000n;
const smallest = (xs: readonly bigint[]) => xs.reduce((m, x) => (x < m ? x : m), xs[0] ?? 0n);
/** Shares in the vault's own decimals, shown with the 18-decimal formatter. */
const shares18 = (x: bigint, decimals: number) => (decimals <= 18 ? x * 10n ** BigInt(18 - decimals) : x / 10n ** BigInt(decimals - 18));

/**
 * Root LP: one deposit of real WETH and USDC becomes liquidity in every world's pool, so the LP takes the other side
 * of every conditional sale and earns the pools' swap fees in every world at once.
 */
export function RootLpPanel({ config, sid, view, balances }: { config: AppConfig; sid: number; view: LendSnapshot; balances?: Balances }) {
  const submit = useSubmit();
  const [wethInput, setWethInput] = useState("");
  const [usdcInput, setUsdcInput] = useState("");
  const weth = parseAmount(wethInput, config.weth.decimals);
  const usdc = parseAmount(usdcInput, config.usdc.decimals);
  const preview = useLpPreview(sid, weth, usdc);
  const lp = view.rootLp;
  const walletWeth = balances?.weth ?? 0n;
  const walletUsdc = balances?.usdc ?? 0n;
  const innerWeth = balances?.innerWeth ?? 0n;

  if (!config.rootLp || !lp) {
    return (
      <Block title="Underwrite every world" demo="root-lp">
        <p className="text-[13px] text-mute">The Root LP is not live on this deployment yet.</p>
      </Block>
    );
  }

  const balance = lp.yourShares;
  const supply = lp.shareSupply;
  const live = view.worlds.filter((w) => w.possible);
  const kept = preview.data;
  const backWeth = kept && weth ? live.map((w) => weth - (kept.wethKept[w.index] ?? 0n)) : [];
  const backUsdc = kept && usdc ? live.map((w) => usdc - (kept.usdcKept[w.index] ?? 0n)) : [];
  const claim = lp.previewWithdraw;
  const claimWeth = claim ? live.map((w) => claim.weth[w.index] ?? 0n) : [];
  const claimUsdc = claim ? live.map((w) => claim.usdc[w.index] ?? 0n) : [];
  const feesOf = (world: number) => {
    const h = lp.holdings.find((x) => x.world === world);
    if (!h || supply === 0n) return { weth: 0n, usdc: 0n };
    return { weth: ((h.wethIdle + h.wethFees) * balance) / supply, usdc: ((h.usdcIdle + h.usdcFees) * balance) / supply };
  };

  // WETH needed beyond what already sits in the internal balance; it goes in first as a plain deposit.
  const wethShort = weth !== undefined && weth > innerWeth ? weth - innerWeth : 0n;
  let blocker: string | undefined;
  if (!weth || !usdc) blocker = "Enter both amounts";
  else if (wethShort > walletWeth) blocker = "Not enough WETH";
  else if (usdc > walletUsdc) blocker = "Not enough USDC";
  else if (!kept) blocker = "Previewing…";

  return (
    <Block title="Underwrite every world" demo="root-lp">
      <p className="text-[13px] leading-relaxed text-mute">
        One deposit of WETH and USDC is split into every world and added to each world&apos;s pool at its own price, so you
        take the other side of every conditional sale and earn the swap fees those pools charge. What a pool cannot take at
        its price comes back to you. At resolution the surviving world&apos;s share comes back as real WETH and USDC.
      </p>

      <div className="grid gap-6 xl:grid-cols-2">
        <div className="flex flex-col gap-4" data-demo="lp-deposit">
          <AmountField
            label="Amount (WETH)"
            size="md"
            value={wethInput}
            onChange={setWethInput}
            unit="WETH"
            demo="lp-weth"
            right={<InlineButton onClick={() => setWethInput(inputText(walletWeth + innerWeth, 4))}>wallet {fmtWeth(walletWeth)}</InlineButton>}
          />
          <AmountField
            label="Amount (USDC)"
            size="md"
            value={usdcInput}
            onChange={setUsdcInput}
            unit="USDC"
            demo="lp-usdc"
            right={<InlineButton onClick={() => setUsdcInput(inputText(walletUsdc, 2))}>wallet {fmtUsd(walletUsdc)}</InlineButton>}
          />
          {kept && (
            <div className="flex items-baseline justify-between text-[13px]">
              <span className="text-mute">shares you would get</span>
              <span className="num text-[15px] text-ink">{fmt(shares18(kept.shares, lp.shareDecimals))}</span>
            </div>
          )}
          {preview.error && weth && usdc && (
            <p className="text-[13px] text-neg">
              {/DepositTooSmall|ZeroAmount/.test(preview.error.message) ? "Too small to buy a share of every world’s pool." : preview.error.message}
            </p>
          )}
          <TxButton
            demo="lp-deposit-confirm"
            label="Underwrite every world"
            busyLabel="Depositing…"
            blocker={blocker}
            needs={{ contract: true }}
            run={async (step) => {
              if (wethShort > 0n) {
                step("Depositing WETH…");
                const tokens = wethShort / scaleOf(config.weth.decimals);
                await submit(ftTransferCall(config.weth.tokenId, CONTRACT_ID, tokens, { action: "deposit" }), tokens);
              }
              step("Depositing…");
              const tokens = toTokenCeil(usdc!, config.usdc.decimals);
              return submit(
                ftTransferCall(config.usdc.tokenId, CONTRACT_ID, tokens, {
                  action: "lp_deposit",
                  scenario_id: sid,
                  weth_amount: weth!.toString(),
                  min_shares: lessSlippage(kept!.shares).toString(),
                }),
                "nonzero",
              );
            }}
            onDone={() => {
              setWethInput("");
              setUsdcInput("");
            }}
          />
        </div>

        <div className="flex flex-col gap-4" data-demo="lp-position">
          <div className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="text-mute">your shares</span>
            <span className="num text-right text-ink">
              {fmt(shares18(balance, lp.shareDecimals))}{" "}
              {supply > 0n && <span className="text-mute">({pct(balance, supply, 2)} of the vault)</span>}
            </span>
          </div>
          {balance > 0n && claim ? (
            <p className="text-[13px] leading-relaxed text-mute">
              Withdrawing now returns <span className="num text-ink">{fmtWeth(smallest(claimWeth))} WETH</span> and{" "}
              <span className="num text-ink">{fmtUsd(smallest(claimUsdc))}</span> as real assets, and the rest as world tokens.
            </p>
          ) : (
            <p className="text-[13px] text-mute">No Root LP shares in this scenario yet.</p>
          )}
          <TxButton
            demo="lp-withdraw-all"
            tone="secondary"
            label="Withdraw all"
            busyLabel="Withdrawing…"
            blocker={balance === 0n ? "No shares" : !claim ? "Loading…" : undefined}
            needs={{ contract: true, tokens: ["weth", "usdc"] }}
            run={() =>
              submit(
                call(CONTRACT_ID, "lp_withdraw", {
                  scenario_id: sid,
                  shares: balance.toString(),
                  min_weth_out: claim!.weth.map((x) => lessSlippage(x).toString()),
                  min_usdc_out: claim!.usdc.map((x) => lessSlippage(x).toString()),
                }),
              )
            }
          />
        </div>
      </div>

      {kept && weth && usdc && (
        <WorldTable
          title="This deposit, by world"
          head={["the pool takes", "comes back"]}
          rows={live.map((w, k) => ({
            world: w,
            cells: [
              `${fmtWeth(kept.wethKept[w.index] ?? 0n)} WETH · ${fmtUsd(kept.usdcKept[w.index] ?? 0n)}`,
              `${fmtWeth(backWeth[k])} WETH · ${fmtUsd(backUsdc[k])}`,
            ],
          }))}
          note={`What every world has left over comes back as real assets (here ${fmtWeth(smallest(backWeth))} WETH and ${fmtUsd(smallest(backUsdc))}); the rest as that world's tokens.`}
        />
      )}
      {balance > 0n && claim && (
        <WorldTable
          title="Your part, by world"
          head={["in the vault", "fees earned"]}
          rows={live.map((w, k) => {
            const fees = feesOf(w.index);
            return {
              world: w,
              cells: [`${fmtWeth(claimWeth[k])} WETH · ${fmtUsd(claimUsdc[k])}`, `${fmtWeth(fees.weth)} WETH${fees.usdc > 0n ? ` · ${fmtUsd(fees.usdc)}` : ""}`],
            };
          })}
          note="Fees are your share of what each world's pool has paid the vault, included in the amounts above."
        />
      )}
    </Block>
  );
}

type Row = { world: { index: number; label: string; possible: boolean }; cells: [string, string] };

function WorldTable({ title, head, rows, note }: { title: string; head: [string, string]; rows: Row[]; note: string }) {
  return (
    <div className="flex flex-col gap-2" data-demo="lp-table">
      <SectionLabel>{title}</SectionLabel>
      <ul className="flex flex-col">
        {rows.map((r) => (
          <li key={r.world.index} className="flex items-center gap-3 border-b border-line py-2.5 last:border-b-0">
            <WorldGlyph world={r.world} size={32} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold text-ink">{r.world.label}</div>
              <div className="num flex flex-col text-[12px] text-mute sm:flex-row sm:gap-3">
                <span>
                  {head[0]} <span className="text-ink">{r.cells[0]}</span>
                </span>
                <span>
                  {head[1]} <span className="text-ink">{r.cells[1]}</span>
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <p className="text-[12px] leading-relaxed text-mute">{note}</p>
    </div>
  );
}
