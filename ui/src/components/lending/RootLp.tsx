'use client'
// Root liquidity for one market (web's Root LP, T12/T13, in the ticket's style): one deposit of real wNEAR and USDC
// becomes liquidity in every world's pool at its own price, so you take the other side of every conditional sale and
// earn the pools' fees. What a pool cannot take at its price comes back. Your shares and what withdrawing returns
// now are the contract's (`lend_view.root_lp`); the deposit is previewed by `preview_lp_deposit`.
import { useState } from 'react'
import { useActions, useWalletBalances, type ChainMarket } from '../../chain/adapter'
import { CONTRACT_ID } from '../../chain/data/client'
import { fmt, fmtNear, fmtUsd, inputText, parseAmount, pct } from '../../chain/format'
import { useAppConfig, useLend, useLpPreview } from '../../chain/hooks/useData'
import { depositToInner, lpDeposit, lpWithdraw } from '../../chain/near/tx'
import { useWallet } from '../../chain/near/wallet'
import { toTokenCeil, toTokenFloor } from '../../chain/units'
import { ActionButton } from '../ui/ActionButton'

/** Minimums sent with a deposit or withdrawal: the preview less 0.5%, so a pool that moves in between fails the call. */
const lessSlippage = (x: bigint) => (x * 9_950n) / 10_000n
const smallest = (xs: readonly bigint[]) => xs.reduce((m, x) => (x < m ? x : m), xs[0] ?? 0n)
/** Shares in the vault's own decimals, in the 18-decimal formatter's terms. */
const shares18 = (x: bigint, decimals: number) => (decimals <= 18 ? x * 10n ** BigInt(18 - decimals) : x / 10n ** BigInt(decimals - 18))

export function RootLp({ market }: { market: ChainMarket }) {
  const { accountId } = useWallet()
  const cfg = useAppConfig().data
  const lend = useLend(market.sid, accountId)
  const balances = useWalletBalances()
  const actions = useActions()
  const [wIn, setW] = useState('')
  const [uIn, setU] = useState('')
  const wnear = parseAmount(wIn, cfg?.wnear.decimals ?? 24)
  const usdc = parseAmount(uIn, cfg?.usdc.decimals ?? 6)
  const preview = useLpPreview(market.sid, wnear, usdc)
  const lp = lend.data?.rootLp
  if (!cfg || !lend.data) return <p className="obx__empty">{lend.error ? lend.error.message : 'Reading the vault…'}</p>
  if (!cfg.rootLp || !lp) return <p className="ticket__help">Root liquidity isn’t open on this deployment yet.</p>

  const live = market.worlds.filter((w) => w.possible)
  const kept = preview.data
  const inner = balances?.innerNearWad ?? 0n
  const walletNear = balances?.nearWad ?? 0n
  const walletUsdc = balances?.usdcWad ?? 0n
  const short = wnear !== undefined && wnear > inner ? wnear - inner : 0n
  const back = kept && wnear && usdc ? { near: smallest(live.map((w) => wnear - (kept.wnearKept[w.index] ?? 0n))), usdc: smallest(live.map((w) => usdc - (kept.usdcKept[w.index] ?? 0n))) } : undefined
  const claim = lp.previewWithdraw
  let blocker: string | undefined
  if (!wnear || !usdc) blocker = 'Enter both amounts'
  else if (short > walletNear) blocker = 'Not enough wNEAR'
  else if (usdc > walletUsdc) blocker = 'Not enough USDC'
  else if (preview.error) blocker = /DepositTooSmall|ZeroAmount/.test(preview.error.message) ? 'Too small for a share of every pool' : 'No preview for this deposit'
  else if (!kept) blocker = 'Previewing…'

  return (
    <div className="rootlp">
      <div className="rootlp__form">
        <label className="tk__field"><span>NEAR</span>
          <input aria-label="wNEAR to add" inputMode="decimal" placeholder="0" value={wIn} onChange={(e) => setW(e.target.value.replace(/[^0-9.]/g, ''))} />
          <em>wNEAR</em>
        </label>
        <label className="tk__field"><span>USDC</span>
          <input aria-label="USDC to add" inputMode="decimal" placeholder="0" value={uIn} onChange={(e) => setU(e.target.value.replace(/[^0-9.]/g, ''))} />
          <em>USDC</em>
        </label>
        <p className="tk__line"><span>In your wallet</span><b className="num">{accountId ? `${fmtNear(walletNear + inner)} wNEAR · ${fmtUsd(walletUsdc)}` : '–'}</b></p>
        {accountId && <div className="tk__pcts">{[0.25, 0.5].map((k) => <button key={k} type="button" onClick={() => { setW(inputText(((walletNear + inner) * BigInt(k * 100)) / 100n, 2)); setU(inputText((walletUsdc * BigInt(k * 100)) / 100n, 2)) }}>{k * 100}% of both</button>)}</div>}
        <p className="tk__line"><span>Shares you would get</span><b className="num">{kept ? fmt(shares18(kept.shares, lp.shareDecimals)) : '–'}</b></p>
        {back && <p className="tk__line"><span>Comes back as real tokens</span><b className="num">{fmtNear(back.near)} wNEAR · {fmtUsd(back.usdc)}</b></p>}
        <div className="tk tk--buy">
          <ActionButton
            label="Add liquidity in every world"
            busyLabel="Adding…"
            blocker={blocker}
            action="lp_deposit"
            run={async () => {
              if (short > 0n) {
                const tokens = toTokenFloor(short, cfg.wnear.decimals)
                const r = await actions.send(depositToInner(cfg.wnear.tokenId, CONTRACT_ID, tokens), { kind: 'lend', title: 'Root liquidity', pending: 'Moving wNEAR in…', done: 'wNEAR is in; adding the liquidity next', market: market.sid }, { needs: { contract: true }, expectUsed: tokens })
                if (!r.ok) return r
              }
              const tokens = toTokenCeil(usdc!, cfg.usdc.decimals)
              return actions.send(lpDeposit(cfg.usdc.tokenId, CONTRACT_ID, tokens, { scenarioId: market.sid, wnearAmount: wnear!, minShares: lessSlippage(kept!.shares) }), { kind: 'lend', title: 'Root liquidity', pending: 'Adding liquidity in every world…', done: 'Liquidity added in every world', market: market.sid }, { needs: { contract: true }, expectUsed: 'nonzero' })
            }}
            onDone={() => { setW(''); setU('') }}
          />
        </div>
      </div>
      <div className="ov">
        <p className="ov__title">Your part of the vault</p>
        <p className="tk__line"><span>Shares</span><b className="num">{fmt(shares18(lp.yourShares, lp.shareDecimals))}{lp.shareSupply > 0n && lp.yourShares > 0n ? ` (${pct(lp.yourShares, lp.shareSupply, 2)})` : ''}</b></p>
        {lp.yourShares > 0n && claim ? (
          <>
            <p className="tk__line"><span>Withdrawing now returns</span><b className="num">{fmtNear(smallest(live.map((w) => claim.wnear[w.index] ?? 0n)))} wNEAR · {fmtUsd(smallest(live.map((w) => claim.usdc[w.index] ?? 0n)))}</b></p>
            <p className="pc__note">as real tokens; the rest as each world’s tokens.</p>
            <ActionButton
              variant="ghost"
              label="Withdraw all"
              busyLabel="Withdrawing…"
              action="lp_withdraw"
              run={() => actions.send(lpWithdraw(CONTRACT_ID, { scenarioId: market.sid, shares: lp.yourShares, minWnearOut: claim.wnear.map(lessSlippage), minUsdcOut: claim.usdc.map(lessSlippage) }), { kind: 'lend', title: 'Root liquidity', pending: 'Withdrawing your liquidity…', done: 'Liquidity withdrawn', market: market.sid }, { needs: { contract: true, tokens: ['wnear', 'usdc'] } })}
            />
          </>
        ) : <p className="pc__note">No shares in this market yet.</p>}
      </div>
    </div>
  )
}
