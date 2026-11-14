'use client'
// The ticket's Hedge tab: sell NEAR in the worlds you fear and keep it everywhere else, in one transaction (T1). Your
// wNEAR is split into every world still possible; in each picked world the piece is sold for dollars of that world,
// resting bids first where they pay more than the pool, then the pool. Each world must pay at least its plan, less
// 0.5% on the pool part, or nothing happens. On a market that lends, the result can stay as loan collateral.
import { useState } from 'react'
import { useActions, usePosition, useWalletBalances } from '../../chain/adapter'
import { CONTRACT_ID } from '../../chain/data/client'
import { fmt, inputText, parseAmount } from '../../chain/format'
import { useNowSeconds } from '../../chain/hooks/useClock'
import { useQuoteSell, useTrade } from '../../chain/hooks/useData'
import { useDebounced } from '../../chain/hooks/useDebounced'
import { useLendingTiers } from '../../chain/hooks/useLending'
import { useSalePlan } from '../../chain/hooks/useSalePlan'
import { useCollateralTier } from '../../chain/hooks/useScenario'
import { useWallet } from '../../chain/near/wallet'
import { minOutOf } from '../../chain/orders'
import { sellTier, TIER_LABEL, TIERS } from '../../chain/tiers'
import { BRAND } from '../../chain/brand'
import { WORLD_COLORS } from '../Grand'
import { ActionButton } from '../ui/ActionButton'
import type { PaneProps } from './types'

const ONE = 10n ** 18n
const num = (v: string) => v.replace(/[^0-9.]/g, '')

export function HedgePane({ market: m, mask }: PaneProps) {
  const { accountId } = useWallet()
  const actions = useActions()
  const wallet = useWalletBalances()
  const now = useNowSeconds()
  const trade = useTrade(m.sid, accountId)
  const { position } = usePosition(m.sid)
  const [text, setText] = useState('')
  const [keep, setKeep] = useState(true)
  const [from, setFrom] = useState<'wallet' | 'inner'>('wallet')
  const toLending = m.lendable && keep
  const tiers = useLendingTiers(toLending ? m.sid : undefined, accountId)
  const remembered = useCollateralTier(`${CONTRACT_ID}:${m.sid}`)
  const tier = sellTier(remembered.tier, tiers.data)
  const frozen = (t: string) => Boolean(tiers.data?.find((x) => x.tier === t)?.market.frozen)

  const s = trade.data?.scenario
  const sold = m.worlds.filter((w) => w.possible && (mask & w.mask) !== 0)
  const live = m.worlds.filter((w) => w.possible)
  const amount = parseAmount(text, 18)
  const quoted = useDebounced(amount, 350)
  const quote = useQuoteSell(m.sid, quoted, mask & m.possible)
  const plan = useSalePlan(
    s ?? { scenarioId: m.sid, worldCount: m.worldCount, possible: m.possible, resolutionCount: 0, halted: false, eventIds: [], spotPrice: 0n, worlds: [], oddsKnown: false, impliedSpot: 0n },
    mask & m.possible,
    quoted,
    quote.data,
    trade.data?.orders ?? [],
    accountId,
    now,
  )
  const inner = wallet?.innerNearWad ?? 0n
  const source = from === 'inner' && inner > 0n ? 'inner' : 'wallet'
  const avbl = source === 'inner' ? inner : (wallet?.nearWad ?? 0n)
  const fresh = quote.data !== undefined && quoted === amount && plan.ready

  let blocker: string | undefined
  if (s?.halted) blocker = 'Paused while a result is in its dispute window'
  else if (sold.length === 0) blocker = 'Pick the worlds you fear in the list'
  else if (!amount) blocker = 'Enter an amount'
  else if (amount > avbl) blocker = `Not enough wNEAR ${source === 'inner' ? `in ${BRAND.name}` : 'in your wallet'}`
  else if (!fresh) blocker = 'Getting prices…'
  else if (sold.some((w) => !plan.plans[w.index]?.total)) blocker = 'No price in one of the worlds'
  else if (toLending && frozen(tier)) blocker = `The ${TIER_LABEL[tier]} tier is frozen: pick another`

  return (
    <>
      <p className="ticket__help">
        Your wNEAR is split into every world still possible. In the worlds you picked in the list
        {sold.length > 0 ? <>, <b>{sold.map((w) => w.outcome).join(', ')}</b>,</> : ''} it is sold for dollars of that world; everywhere else you keep the NEAR.
      </p>
      {inner > 0n && (
        <div className="sc__seg" role="group" aria-label="From">
          <button type="button" aria-pressed={source === 'wallet'} onClick={() => setFrom('wallet')}>Wallet</button>
          <button type="button" aria-pressed={source === 'inner'} onClick={() => setFrom('inner')}>{BRAND.innerBalance}</button>
        </div>
      )}
      <label className="tk__field"><span>Amount</span>
        <input aria-label="wNEAR to hedge" inputMode="decimal" placeholder="0" value={text} onChange={(e) => setText(num(e.target.value))} />
        <em>wNEAR</em>
      </label>
      <div className="tk__pcts" role="group" aria-label="Share of your wNEAR">
        {[25n, 50n, 75n, 100n].map((k) => <button key={String(k)} type="button" disabled={avbl === 0n} onClick={() => setText(inputText((avbl * k) / 100n, 4))}>{k === 100n ? 'Max' : `${k}%`}</button>)}
      </div>
      <table className="sc__preview">
        <thead><tr><th>World</th><th className="r">You get</th><th className="r">You hold after</th></tr></thead>
        <tbody>
          {live.map((w) => {
            const isSold = (mask & w.mask) !== 0
            const p = fresh ? plan.plans[w.index] : undefined
            const h = position?.worlds[w.index]
            const near = (h?.nearWad ?? 0n) + (!isSold && amount ? amount : 0n)
            const usdc = (h?.usdcWad ?? 0n) + (isSold && p ? p.total : 0n)
            const got = isSold && p && amount ? (p.total * ONE) / amount : undefined
            return (
              <tr key={w.index} className={isSold ? 'is-change' : ''}>
                <td><i className="mk__dot" style={{ background: WORLD_COLORS[w.index % WORLD_COLORS.length] }} />{w.outcome}</td>
                <td className="r num">
                  {isSold ? (p ? `${fmt(p.total)} USDC` : amount ? '…' : '–') : amount ? `${fmt(amount)} NEAR` : '–'}
                  {got !== undefined && <small className="hp__at">at {fmt(got, 4)}{p && p.fills.length > 0 ? `, ${p.fills.length} bid${p.fills.length === 1 ? '' : 's'}${p.poolAmount > 0n ? ' + pool' : ''}` : ''}</small>}
                </td>
                <td className="r num">{isSold ? `${fmt(usdc)} USDC` : `${fmt(near)} NEAR`}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {fresh && sold.length > 0 && (
        <p className="tk__line"><span>Least each sold world pays</span><b className="num">{sold.map((w) => fmt(minOutOf(plan.plans[w.index]))).join(' · ')} USDC</b></p>
      )}
      <p className="pc__note">A sale through a pool pays its fee and moves its price; a resting bid fills first where it pays more. Each world must pay at least its plan, less 0.5% on the pool part, or nothing happens.</p>
      {m.lendable && (
        <label className="hp__keep">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          <span>Keep the result as loan collateral, so you can borrow real USDC against it next. Off: it stays in your wallet.</span>
        </label>
      )}
      {toLending && (
        <div className="hp__tier">
          <span>Collateral tier</span>
          <div className="pc__tabs" role="group" aria-label="Lending tier">
            {TIERS.map((t) => <button key={t} type="button" aria-pressed={tier === t} disabled={frozen(t)} onClick={() => remembered.setTier(t)}>{TIER_LABEL[t]}</button>)}
          </div>
        </div>
      )}
      <div className="tk tk--sell">
        <ActionButton
          label={sold.length > 0 ? `Sell NEAR in ${sold.length} world${sold.length === 1 ? '' : 's'}` : 'Sell NEAR'}
          blocker={blocker}
          action={toLending ? 'sell_to_collateral' : 'sell'}
          run={() => actions.sell({ sid: m.sid, mask: mask & m.possible, amount: amount!, plans: plan.plans, toLending, tier, from: source })}
          onDone={() => setText('')}
        />
      </div>
    </>
  )
}
