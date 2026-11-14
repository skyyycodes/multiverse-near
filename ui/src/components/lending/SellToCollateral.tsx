'use client'
// Sell and borrow (web's Sell with "keep as loan collateral"): real wNEAR is split into every world, the pieces in the
// worlds you fear are sold for dollars of those worlds, and the whole result stays as collateral in this tier, in one
// transaction. Resting bids fill first where they pay more than the pool. Then borrow against it in the ticket.
import { useState } from 'react'
import type { ChainMarket } from '../../chain/adapter'
import { useActions, useWalletBalances } from '../../chain/adapter'
import type { Tier } from '../../chain/domain'
import { fmt, fmtNear, fmtPrice, inputText, parseAmount } from '../../chain/format'
import { useAppConfig, useQuoteSell, useTrade } from '../../chain/hooks/useData'
import { useDebounced } from '../../chain/hooks/useDebounced'
import { useSalePlan } from '../../chain/hooks/useSalePlan'
import { useWallet } from '../../chain/near/wallet'
import { BRAND } from '../../chain/brand'
import { TIER_LABEL } from '../../chain/tiers'
import { ActionButton } from '../ui/ActionButton'
import { WorldIcon } from '../Grand'

const ONE = 10n ** 18n

export function SellToCollateral({ market, tier, frozen }: { market: ChainMarket; tier: Tier; frozen: boolean }) {
  const { accountId } = useWallet()
  const cfg = useAppConfig().data
  const trade = useTrade(market.sid, accountId)
  const balances = useWalletBalances()
  const actions = useActions()
  const [mask, setMask] = useState(0)
  const [input, setInput] = useState('')
  const [from, setFrom] = useState<'wallet' | 'inner'>('wallet')
  const amount = parseAmount(input, cfg?.wnear.decimals ?? 24)
  const quoted = useDebounced(amount, 350)
  const quote = useQuoteSell(market.sid, quoted, mask)
  const snap = trade.data
  const plan = useSalePlan(snap?.scenario ?? EMPTY, mask, quoted, quote.data, snap?.orders ?? [], accountId, snap?.nowSec ?? 0n)
  const inner = balances?.innerNearWad ?? 0n
  const source = from === 'inner' && inner > 0n ? 'inner' : 'wallet'
  const available = source === 'inner' ? inner : (balances?.nearWad ?? 0n)
  const live = market.worlds.filter((w) => w.possible)
  const sold = live.filter((w) => (mask & w.mask) !== 0)
  const fresh = quote.data !== undefined && quoted === amount && plan.ready

  let blocker: string | undefined
  if (!snap) blocker = 'Reading the worlds…'
  else if (snap.scenario.halted) blocker = 'Trading pauses while a result is pending'
  else if (frozen) blocker = `The ${TIER_LABEL[tier]} tier is frozen: pick another tier`
  else if (sold.length === 0) blocker = 'Pick the worlds you fear'
  else if (sold.length === live.length) blocker = 'Keep NEAR in at least one world'
  else if (!amount) blocker = 'Enter an amount of NEAR'
  else if (amount > available) blocker = 'Not enough wNEAR'
  else if (!fresh) blocker = 'Getting prices…'
  else if (sold.some((w) => !plan.plans[w.index]?.total)) blocker = 'No price in one of the worlds'

  const toggle = (m: number) => setMask((x) => x ^ m)

  return (
    <section className="tr__panel">
      <div className="desk__head"><h2 className="obx__boxtitle">Sell NEAR into collateral</h2><span className="pc__note">One transaction, into the {TIER_LABEL[tier]} tier</span></div>
      <p className="tr__means">Your NEAR is split into one piece per world. The pieces in the worlds you fear are sold for dollars there; you keep NEAR everywhere else. All of it stays as loan collateral, so you can borrow against it next.</p>
      <div className="sellc">
        <div className="sellc__worlds" role="group" aria-label="Worlds to sell in">
          {live.map((w) => {
            const on = (mask & w.mask) !== 0
            const p = on && fresh ? plan.plans[w.index] : undefined
            return (
              <button key={w.index} type="button" aria-pressed={on} className="sellc__world" onClick={() => toggle(w.mask)}>
                <span className="desk__mk"><WorldIcon m={market} w={w.index} size={22} />{w.outcome}</span>
                <span className="num">{on ? (p?.total !== undefined ? `${fmt(p.total)} USDC` : amount ? '…' : 'sell') : amount ? `keep ${fmtNear(amount)} NEAR` : 'keep'}</span>
                <small className="num">{on && p?.total !== undefined && amount ? `${fmtPrice((p.total * ONE) / amount)} a NEAR` : `pool ${fmtPrice(w.price)}`}</small>
              </button>
            )
          })}
        </div>
        <div className="sellc__form">
          {inner > 0n && (
            <div className="pc__tabs" role="group" aria-label="From">
              <button type="button" aria-pressed={source === 'wallet'} onClick={() => setFrom('wallet')}>Wallet</button>
              <button type="button" aria-pressed={source === 'inner'} onClick={() => setFrom('inner')}>{BRAND.innerBalance}</button>
            </div>
          )}
          <label className="tk__field"><span>NEAR</span>
            <input aria-label="NEAR to split and sell" inputMode="decimal" placeholder="0" value={input} onChange={(e) => setInput(e.target.value.replace(/[^0-9.]/g, ''))} />
            <em>wNEAR</em>
          </label>
          <div className="tk__pcts">
            {[0.25, 0.5, 0.75, 1].map((k) => <button key={k} type="button" onClick={() => setInput(inputText((available * BigInt(k * 100)) / 100n, 2))}>{k === 1 ? 'Max' : `${k * 100}%`}</button>)}
          </div>
          <p className="tk__line"><span>{source === 'inner' ? BRAND.innerBalance : 'In your wallet'}</span><b className="num">{accountId ? `${fmtNear(available)} wNEAR` : '–'}</b></p>
          <p className="ticket__help">Each world must pay at least its quote, less 0.5% on the pool part, or nothing happens.</p>
          <ActionButton
            label={`Sell in ${sold.length} world${sold.length === 1 ? '' : 's'}, keep as collateral`}
            busyLabel="Selling…"
            blocker={blocker}
            action="sell_to_collateral"
            run={() => actions.sell({ sid: market.sid, mask, amount: amount!, plans: plan.plans, toLending: true, tier, from: source })}
            onDone={() => { setInput(''); setMask(0) }}
          />
        </div>
      </div>
    </section>
  )
}

const EMPTY = { scenarioId: 0, worldCount: 0, possible: 0, resolutionCount: 0, halted: false, eventIds: [], spotPrice: 0n, worlds: [], oddsKnown: false, impliedSpot: 0n }
