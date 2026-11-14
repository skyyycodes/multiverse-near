'use client'
// Liquidate one loan (web 6.10, in the ticket's style): repay Max (the contract's cap) or an amount, and receive the
// seized pieces as tokens or sold for cash. The quote is the contract's own (`liquidation_quote`, every 6 s); the
// budget attached is the quoted repayment plus 0.1% (the unused part comes back), and in cash mode `min_out` is 1%
// under the quoted cash, never under the repayment.
import { useState } from 'react'
import { useActions, useWalletBalances, type ChainMarket } from '../../chain/adapter'
import { CONTRACT_ID } from '../../chain/data/client'
import { parseVerseTokenId } from '../../chain/decode'
import type { AppConfig } from '../../chain/domain'
import { humanError } from '../../chain/errors'
import { accountLabel, fmt, fmtAsset, fmtHf, fmtUsd, parseAmount, pct } from '../../chain/format'
import { useDebounced } from '../../chain/hooks/useDebounced'
import { useLiquidationQuote, useVerseLabel } from '../../chain/hooks/useLiquidation'
import { cashMinOut, liquidateBlocker, liquidationBudget, maxRepaysAll, realPiece, type AtRiskRow } from '../../chain/liquidation'
import { GAS_MAX, liquidate } from '../../chain/near/tx'
import { TIER_LABEL } from '../../chain/tiers'
import { toInternal } from '../../chain/units'
import { ActionButton } from '../ui/ActionButton'

const WAD = 10n ** 18n

/** "wNEAR if Ships & cuts" for a world's piece (names from the market when it is known), "real wNEAR" for a real one. */
export function PieceName({ piece, market }: { piece: string; market?: ChainMarket }) {
  const real = realPiece(piece)
  const parsed = real ? undefined : parseVerseTokenId(piece)
  const fromMarket = parsed && market ? market.worlds.filter((w) => (parsed.mask & w.mask) !== 0) : undefined
  const named = fromMarket && fromMarket.length > 0 ? (fromMarket.length === market!.worlds.length ? 'every world' : fromMarket.map((w) => w.outcome).join(', ')) : undefined
  const label = useVerseLabel(parsed?.scenarioId ?? 0, parsed?.mask ?? 0, Boolean(parsed) && !named)
  if (real) return <>real {real === 'wnear' ? 'wNEAR' : 'USDC'}</>
  if (!parsed) return <>{piece}</>
  return <>{parsed.asset === 'wnear' ? 'wNEAR' : 'USDC'} if {named ?? label.data ?? '…'}</>
}

const assetOf = (piece: string) => realPiece(piece) ?? parseVerseTokenId(piece)?.asset ?? 'usdc'

export function LiquidateTicket({ cfg, row, market }: { cfg: AppConfig; row: AtRiskRow; market?: ChainMarket }) {
  const actions = useActions()
  const balances = useWalletBalances()
  const [mode, setMode] = useState<'max' | 'amount'>('max')
  const [receive, setReceive] = useState<'cash' | 'tokens'>('cash')
  const [input, setInput] = useState('')
  const amount = mode === 'amount' ? parseAmount(input, cfg.usdc.decimals) : undefined
  const debounced = useDebounced(amount, 350)
  const quote = useLiquidationQuote({ sid: row.scenarioId, account: row.accountId, tier: row.tier, repay: mode === 'max' ? 'max' : debounced, receive })
  const q = quote.data
  const fresh = mode === 'max' || debounced === amount
  const budgetTokens = q ? liquidationBudget(q.repay, cfg.usdc.decimals) : 0n
  const budget = toInternal(budgetTokens, cfg.usdc.decimals)
  const minOut = q?.cash ? cashMinOut(q.cash.cash, q.repay) : undefined
  const wallet = balances?.usdcWad ?? 0n
  const blocker = !fresh ? 'Getting a quote…' : liquidateBlocker({ quote: q, receive, walletUsdc: wallet, budgetInternal: budget, amount: mode === 'amount' ? (amount ?? 0n) : undefined, quoteError: quote.error?.message })
  const share = q && !q.seizeAll && row.cMin > 0n ? pct(q.target, row.cMin, 2) : undefined
  const left = q?.cash ? q.cash.leftUsdc.reduce((a, b) => a + b, 0n) : 0n

  return (
    <section className="tr__panel mk__ticket">
      <div className="desk__head"><h2 className="obx__boxtitle">Liquidate</h2><span className="pc__note">{TIER_LABEL[row.tier]} tier</span></div>
      <p className="tk__line"><span>Borrower</span><b title={row.accountId}>{accountLabel(row.accountId, 26)}</b></p>
      <p className="tk__line"><span>Loan · health</span><b className="num">{fmtUsd(q?.debt ?? row.debt)} · {fmtHf(q?.healthFactor ?? row.healthFactor)}</b></p>

      <div className="pc__tabs" role="group" aria-label="Repay">
        <button type="button" aria-pressed={mode === 'max'} onClick={() => setMode('max')}>{q ? `Max · ${fmtUsd(q.cap)}` : 'Max'}</button>
        <button type="button" aria-pressed={mode === 'amount'} onClick={() => setMode('amount')}>An amount</button>
      </div>
      {mode === 'amount' && (
        <label className="tk__field"><span>Repay</span>
          <input aria-label="USDC to repay" inputMode="decimal" placeholder="0" value={input} onChange={(e) => setInput(e.target.value.replace(/[^0-9.]/g, ''))} />
          <em>USDC</em>
        </label>
      )}
      {q && maxRepaysAll(q) && <p className="pc__note">Max repays all of it: the loan is small or far under 1.</p>}

      <div className="pc__tabs" role="group" aria-label="Receive">
        <button type="button" aria-pressed={receive === 'cash'} onClick={() => setReceive('cash')}>Cash (USDC)</button>
        <button type="button" aria-pressed={receive === 'tokens'} onClick={() => setReceive('tokens')}>World tokens</button>
      </div>

      <div className="ov" aria-busy={!q}>
        <p className="ov__title">The contract’s quote</p>
        {quote.error && <p className="pc__note tone--risk">{quote.error.message}</p>}
        {!q ? <p className="pc__note">Getting a quote…</p> : q.error ? <p className="pc__note tone--risk">{humanError(q.error)}</p> : (
          <>
            <p className="tk__line"><span>You repay</span><b className="num">{fmtUsd(q.repay)}</b></p>
            <p className="tk__line"><span>You take</span><b>{q.seizeAll ? 'all the collateral' : `${share ?? 'a share'} of every piece`}</b></p>
            {q.priceFactor < WAD && <p className="tk__line"><span>Valued with a haircut of</span><b className="num">{pct(WAD - q.priceFactor, WAD, 1)}</b></p>}
            {q.writtenOff > 0n && <p className="tk__line"><span>Bad debt written off</span><b className="num">{fmtUsd(q.writtenOff)}</b></p>}
            {q.pieces.length > 0 && (
              <div className="ar__pieces">
                {q.pieces.map((p) => (
                  <div key={p.piece} className="ar__piece"><span><PieceName piece={p.piece} market={market} /></span><span className="num">{fmtAsset(assetOf(p.piece), p.held)}</span><b className="num">{fmtAsset(assetOf(p.piece), p.seized)}</b></div>
                ))}
              </div>
            )}
            {receive === 'cash' && q.cash && (
              q.cash.guardOk ? (
                <>
                  <p className="tk__line"><span>You receive about</span><b className="num is-up">{fmt(q.cash.cash)} USDC</b></p>
                  <p className="tk__line"><span>At least</span><b className="num">{minOut !== undefined ? `${fmt(minOut)} USDC` : '–'}</b></p>
                  {(left > 0n || q.cash.dead.length > 0) && <p className="pc__note">{left > 0n ? `${fmt(left)} USDC in single worlds` : ''}{left > 0n && q.cash.dead.length > 0 ? ' and ' : ''}{q.cash.dead.length > 0 ? `${q.cash.dead.length} resolved-away piece${q.cash.dead.length === 1 ? '' : 's'}` : ''} stay with you as tokens.</p>}
                </>
              ) : <p className="pc__note tone--risk">Selling for cash would leave a world without a price: take tokens.</p>
            )}
          </>
        )}
      </div>
      <p className="pc__note num">{q && q.repay > 0n ? `Attaches ${fmt(budget, 2)} USDC; the unused part comes back. ` : ''}Wallet {fmtUsd(wallet)}.</p>
      <div className="tk tk--sell">
        <ActionButton
          label={receive === 'cash' ? 'Liquidate for cash' : 'Liquidate for tokens'}
          busyLabel="Liquidating…"
          blocker={blocker}
          action={receive === 'cash' ? 'liquidate_cash' : 'liquidate_tokens'}
          gas={GAS_MAX}
          run={() =>
            actions.send(
              liquidate(cfg.usdc.tokenId, CONTRACT_ID, budgetTokens, { scenarioId: row.scenarioId, accountId: row.accountId, repayAmount: mode === 'max' ? 'max' : amount!, tier: row.tier, receive, minOut: receive === 'cash' ? minOut : undefined }),
              { kind: 'loan', title: 'Liquidation', pending: 'Liquidating…', done: receive === 'cash' ? 'Liquidated; the cash is in your wallet' : 'Liquidated; the pieces are in your holdings', market: row.scenarioId },
              { needs: { contract: true, tokens: receive === 'cash' ? ['usdc'] : [] }, expectUsed: 'nonzero' },
            )
          }
        />
      </div>
    </section>
  )
}
