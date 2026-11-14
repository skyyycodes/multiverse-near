"use client";

import { useState } from "react";
import { Chip, InfoRows, Segmented } from "@/components/ui/Bits";
import { AmountField } from "@/components/ui/Field";
import { Dialog } from "@/components/ui/Dialog";
import { TxButton } from "@/components/ui/TxButton";
import { CONTRACT_ID } from "@/lib/data/client";
import { parseVerseTokenId } from "@/lib/decode";
import type { AppConfig } from "@/lib/domain";
import { humanError } from "@/lib/errors";
import { accountLabel, fmt, fmtAsset, fmtHf, fmtUsd, parseAmount, pct } from "@/lib/format";
import { useBalances } from "@/lib/hooks/useData";
import { useDebounced } from "@/lib/hooks/useDebounced";
import { useLiquidationQuote, useVerseLabel } from "@/lib/hooks/useLiquidation";
import { useSubmit } from "@/lib/hooks/useTx";
import { cashMinOut, liquidateBlocker, liquidationBudget, maxRepaysAll, realPiece, type AtRiskRow } from "@/lib/liquidation";
import { liquidate } from "@/lib/near/tx";
import { useWallet } from "@/lib/near/wallet";
import { TIER_LABEL } from "@/lib/tiers";
import { toInternal } from "@/lib/units";

const WAD = 10n ** 18n;

/** "wNEAR-if-SHIPS·CUTS" for a verse token, "real wNEAR" for a real piece. */
export function PieceName({ piece }: { piece: string }) {
  const real = realPiece(piece);
  const parsed = real ? undefined : parseVerseTokenId(piece);
  const label = useVerseLabel(parsed?.scenarioId ?? 0, parsed?.mask ?? 0, Boolean(parsed));
  if (real) return <>real {real === "wnear" ? "wNEAR" : "USDC"}</>;
  if (!parsed) return <>{piece}</>;
  return (
    <>
      {parsed.asset === "wnear" ? "wNEAR" : "USDC"}-if-{label.data ?? "…"}
    </>
  );
}

const assetOf = (piece: string) => realPiece(piece) ?? parseVerseTokenId(piece)?.asset ?? "usdc";

function WorldName({ sid, world }: { sid: number; world: number }) {
  const label = useVerseLabel(sid, 1 << world);
  return <>{label.data ?? `world ${world + 1}`}</>;
}

/**
 * Repay part of an unhealthy loan and take its collateral plus the bonus (web 6.10): "max" and cash by default, the
 * quote from `liquidation_quote`, the budget the quoted repayment plus 0.1%, and in cash mode `min_out` 1% under the
 * cash, never under the repayment.
 */
export function LiquidateDialog({ config, row, onClose }: { config: AppConfig; row: AtRiskRow | undefined; onClose: () => void }) {
  return (
    <Dialog open={Boolean(row)} onClose={onClose} title="Liquidate" demo="liquidate-dialog">
      {row && <Body key={`${row.scenarioId}:${row.tier}:${row.accountId}`} config={config} row={row} />}
    </Dialog>
  );
}

function Body({ config, row }: { config: AppConfig; row: AtRiskRow }) {
  const wallet = useWallet();
  const submit = useSubmit();
  const balances = useBalances(wallet.accountId, config.wnear, config.usdc);
  const [mode, setMode] = useState<"max" | "amount">("max");
  const [receive, setReceive] = useState<"cash" | "tokens">("cash");
  const [input, setInput] = useState("");
  const amount = mode === "amount" ? parseAmount(input, config.usdc.decimals) : undefined;
  const debounced = useDebounced(amount, 350);
  const repayArg = mode === "max" ? ("max" as const) : debounced;
  const quote = useLiquidationQuote({ sid: row.scenarioId, account: row.accountId, tier: row.tier, repay: repayArg, receive });
  const q = quote.data;
  const fresh = mode === "max" || debounced === amount;
  const budgetTokens = q ? liquidationBudget(q.repay, config.usdc.decimals) : 0n;
  const budgetInternal = toInternal(budgetTokens, config.usdc.decimals);
  const minOut = q?.cash ? cashMinOut(q.cash.cash, q.repay) : undefined;
  const walletUsdc = balances.data?.usdc ?? 0n;
  const blocker = !fresh
    ? "Getting a quote…"
    : liquidateBlocker({ quote: q, receive, walletUsdc, budgetInternal, amount: mode === "amount" ? (amount ?? 0n) : undefined, quoteError: quote.error?.message });

  return (
    <div className="flex flex-col gap-4">
      <InfoRows
        rows={[
          { label: "Borrower", value: accountLabel(row.accountId, 28) },
          { label: "Market", value: `#${row.scenarioId} · ${TIER_LABEL[row.tier]}` },
          { label: "Debt · health factor", value: `${fmtUsd(q?.debt ?? row.debt)} · ${fmtHf(q?.healthFactor ?? row.healthFactor)}` },
        ]}
      />

      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium text-ink">Repay</span>
        <Segmented
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "max", label: q ? `Max · ${fmtUsd(q.cap)}` : "Max", demo: "liquidate-max" },
            { value: "amount", label: "An amount" },
          ]}
        />
        {mode === "amount" && <AmountField label="Repay (USDC)" value={input} onChange={setInput} unit="USDC" demo="liquidate-amount" />}
        {q && maxRepaysAll(q) && <p className="text-[12px] text-mute">Max repays all of it: the loan is small or far under 1.</p>}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium text-ink">Receive</span>
        <Segmented
          size="sm"
          value={receive}
          onChange={setReceive}
          options={[
            { value: "cash", label: "Cash (USDC)", demo: "liquidate-receive-cash" },
            { value: "tokens", label: "Tokens", demo: "liquidate-receive-tokens" },
          ]}
        />
      </div>

      <Quote row={row} receive={receive} quote={q} minOut={minOut} error={quote.error?.message} />

      <p className="num text-[12px] text-mute" data-demo="liquidate-budget">
        {q && q.repay > 0n
          ? `Attaches ${fmt(budgetInternal, 2)} USDC; the unused part comes back. Wallet ${fmtUsd(walletUsdc)}.`
          : `Wallet ${fmtUsd(walletUsdc)}.`}
      </p>

      <TxButton
        demo="liquidate-confirm"
        action={receive === "cash" ? "liquidate_cash" : "liquidate_tokens"}
        label={receive === "cash" ? "Liquidate for cash" : "Liquidate for tokens"}
        busyLabel="Liquidating…"
        blocker={blocker}
        needs={{ contract: true, tokens: receive === "cash" ? ["usdc"] : [] }}
        connectText="Connect a wallet to liquidate"
        run={() =>
          submit(
            liquidate(config.usdc.tokenId, CONTRACT_ID, budgetTokens, {
              scenarioId: row.scenarioId,
              accountId: row.accountId,
              repayAmount: mode === "max" ? "max" : amount!,
              tier: row.tier,
              receive,
              minOut: receive === "cash" ? minOut : undefined,
            }),
            "nonzero",
          )
        }
      />
    </div>
  );
}

function Quote({
  row,
  receive,
  quote: q,
  minOut,
  error,
}: {
  row: AtRiskRow;
  receive: "cash" | "tokens";
  quote: ReturnType<typeof useLiquidationQuote>["data"];
  minOut: bigint | undefined;
  error?: string;
}) {
  if (!q) return <div className="skeleton h-24 rounded-[16px]" data-demo="liquidation-quote" aria-busy="true" />;
  const share = !q.seizeAll && row.cMin > 0n ? pct(q.target, row.cMin, 2) : undefined;
  const cash = q.cash;
  const left = cash ? cash.leftUsdc.reduce((a, b) => a + b, 0n) : 0n;
  return (
    <div className="flex flex-col gap-3 rounded-[16px] bg-tile p-4 text-[13px] leading-relaxed text-ink" data-demo="liquidation-quote">
      {error && <p className="text-neg">{error}</p>}
      {q.error ? (
        <p className="text-neg">{humanError(q.error)}</p>
      ) : (
        <>
          <p className="num">
            You repay <strong>{fmtUsd(q.repay)}</strong>. {q.seizeAll ? "You take all the collateral" : `You take ${share ?? "a share"} of every piece`}, worth the
            repayment plus the bonus
            {q.priceFactor < WAD ? `, valued with a ${pct(WAD - q.priceFactor, WAD, 1)} haircut` : ""}.
            {q.writtenOff > 0n ? ` And ${fmtUsd(q.writtenOff)} of bad debt is written off (insurance first).` : ""}
          </p>
          {q.pieces.length > 0 && (
            <table className="num w-full text-[12px]" data-demo="quote-pieces">
              <thead>
                <tr className="text-mute">
                  <th className="pb-1 text-left font-medium">Piece</th>
                  <th className="pb-1 text-right font-medium">Held</th>
                  <th className="pb-1 text-right font-medium">Seized</th>
                </tr>
              </thead>
              <tbody>
                {q.pieces.map((p) => (
                  <tr key={p.piece} className="border-t border-line">
                    <td className="py-1 pr-2">
                      <PieceName piece={p.piece} />
                    </td>
                    <td className="py-1 text-right">{fmtAsset(assetOf(p.piece), p.held)}</td>
                    <td className="py-1 text-right">{fmtAsset(assetOf(p.piece), p.seized)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {receive === "cash" && cash && (
            <div className="flex flex-col gap-1.5 border-t border-line pt-2">
              {cash.sold.map((s, w) =>
                s > 0n ? (
                  <p key={w} className="num text-[12px] text-mute">
                    <WorldName sid={row.scenarioId} world={w} />: sells {fmtAsset("wnear", s)} wNEAR → {fmt(cash.received[w])} USDC
                  </p>
                ) : null,
              )}
              {!cash.guardOk ? (
                <Chip tone="neg">Cash-out would unprice a world: use tokens</Chip>
              ) : (
                <>
                  <p className="num">
                    You receive about{" "}
                    <strong data-demo="quote-cash" className="text-pos">
                      {fmt(cash.cash)} USDC
                    </strong>
                    , at least <span data-demo="quote-min-out">{minOut !== undefined ? fmt(minOut) : "—"}</span> USDC.
                  </p>
                  {cash.cash < q.repay && <p className="text-neg">Cash-out would return less than you repay; take tokens.</p>}
                </>
              )}
              {(left > 0n || cash.dead.length > 0) && (
                <p className="text-[12px] text-mute">
                  {left > 0n ? `${fmt(left)} USDC in single worlds` : ""}
                  {left > 0n && cash.dead.length > 0 ? " and " : ""}
                  {cash.dead.length > 0 ? `${cash.dead.length} resolved-away piece${cash.dead.length === 1 ? "" : "s"}` : ""} stay with you as tokens.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
