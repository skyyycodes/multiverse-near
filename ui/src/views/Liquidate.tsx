'use client'
// At-risk loans (web 6.10, in the desk's style): every open loan close to liquidation, across markets and tiers
// (`borrowers` of each tier that has any), filtered by health, liquidatable first. Pick a loan to see the contract's
// quote in the ticket and liquidate it; a loan whose collateral is worth nothing somewhere can be written off. Below:
// the world tokens in your wallet, which is where pieces taken as tokens land. `?id=N` narrows to one market.
import { useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { marketId, useActions, useMarkets, type ChainMarket } from '../chain/adapter'
import { CONTRACT_ID } from '../chain/data/client'
import { errorLine } from '../chain/errors'
import { accountLabel, fmtAsset, fmtHf, fmtUsd, hfTone } from '../chain/format'
import { useNowSeconds } from '../chain/hooks/useClock'
import { useAppConfig } from '../chain/hooks/useData'
import { useAtRisk, useHoldings } from '../chain/hooks/useLiquidation'
import { usePauseState } from '../chain/hooks/useOps'
import { HF_FILTERS, maxHfArg, parseHfFilter, statusLabel, type AtRiskRow, type HfFilter } from '../chain/liquidation'
import { borrowHref, liquidateHref, marketHref, q } from '../chain/links'
import { writeOffBadDebt } from '../chain/near/tx'
import { useWallet } from '../chain/near/wallet'
import { graceLeft } from '../chain/pause'
import { TIER_LABEL } from '../chain/tiers'
import { LiquidateTicket, PieceName } from '../components/lending/LiquidateTicket'
import { RowAction } from '../components/lending/RowAction'

const TONE = { ok: 'safe', warn: 'watch', bad: 'risk' } as const
const FILTER_LABEL: Record<HfFilter, string> = { '1': 'Health under 1', '1.1': 'Under 1.1', '1.5': 'Under 1.5', all: 'All loans' }
const rowKey = (r: AtRiskRow) => `${r.scenarioId}:${r.tier}:${r.accountId}`

export default function Liquidate({ id }: { id: string }) {
  const params = useSearchParams()
  const router = useRouter()
  const { accountId } = useWallet()
  const cfg = useAppConfig().data
  const pause = usePauseState()
  const now = useNowSeconds()
  const sid = marketId(id)
  const filter = parseHfFilter(params.get('hf'))
  const data = useAtRisk(sid, maxHfArg(filter))
  const { markets } = useMarkets({ listedOnly: false })
  const bySid = new Map((markets ?? []).map((m) => [m.sid, m]))
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const grace = graceLeft(pause.data, now)
  const rows = data.data?.rows
  const liquidatable = rows?.filter((r) => r.liquidation === 'liquidatable') ?? []
  const pick = rows?.find((r) => rowKey(r) === picked) ?? liquidatable[0]
  const setFilter = (f: HfFilter) => router.replace(q('/liquidate/', { id: sid, hf: f === '1.1' ? undefined : f }), { scroll: false })
  const here = sid !== undefined ? bySid.get(sid) : undefined

  return (
    <div className="page tr desk">
      <header className="tr__pair">
        <div className="tr__id">
          <h1 className="mk__title">At-risk loans</h1>
          <p className="tr__means">{here ? <>{here.question}. </> : null}Loans whose worst world no longer covers the debt can be repaid by anyone, for a share of the collateral plus a bonus. A keeper watches every market; you can act too.</p>
        </div>
        <div className="tr__quote">
          <b className={`num${liquidatable.length ? ' is-down' : ''}`}>{rows ? liquidatable.length : '–'}</b>
          <span className="pc__note">liquidatable now</span>
        </div>
        <dl className="tr__stats">
          <div><dt>Loans shown</dt><dd className="num">{rows ? rows.length : '–'}</dd></div>
          <div><dt>Markets checked</dt><dd className="num">{data.data ? data.data.markets : '–'}</dd></div>
          <div><dt>Tiers with loans</dt><dd className="num">{data.data ? data.data.tiersWithLoans : '–'}</dd></div>
        </dl>
      </header>

      <div className="pc__tabs desk__filter" role="group" aria-label="Health">
        {HF_FILTERS.map((f) => <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{FILTER_LABEL[f]}</button>)}
        {sid !== undefined && <Link className="tr__link" href={liquidateHref()}>Show every market</Link>}
      </div>

      <div className="mk__grid">
        <div className="mk__main">
          <section className="tr__panel">
            {!rows ? (
              <p className="obx__empty" role="status">{data.error ? errorLine(data.error.message) : 'Reading every tier’s borrowers…'}</p>
            ) : rows.length === 0 ? (
              <div className="desk__empty"><p><b>{filter === 'all' ? 'No open loans.' : `No loan under health ${filter}.`}</b> {filter === 'all' ? 'Loans show up here as soon as someone borrows.' : 'Every loan here has room before it can be liquidated.'}</p>{filter !== 'all' && <button type="button" className="mk__btn mk__btn--buy" onClick={() => setFilter('all')}>Show all loans</button>}</div>
            ) : (
              <div className="desk__table">
                <div className="desk__tr desk__tr--head ar__tr"><span>Borrower</span><span>Market</span><span>Loan</span><span>Health</span><span>Worst world</span><span /></div>
                {rows.map((r) => <Row key={rowKey(r)} r={r} m={bySid.get(r.scenarioId)} grace={grace} picked={pick !== undefined && rowKey(pick) === rowKey(r)} me={accountId} onPick={() => setPicked(rowKey(r))} />)}
              </div>
            )}
            {data.data && data.data.unreadable.length > 0 && <p className="pc__note tone--watch">Could not read market{data.data.unreadable.length === 1 ? '' : 's'} #{data.data.unreadable.join(', #')}.</p>}
          </section>
          {accountId && <Seized account={accountId} bySid={bySid} />}
        </div>

        <aside className="mk__side">
          {pick && cfg ? (
            <LiquidateTicket key={rowKey(pick)} cfg={cfg} row={pick} market={bySid.get(pick.scenarioId)} />
          ) : (
            <section className="tr__panel mk__ticket">
              <h2 className="obx__boxtitle">Liquidate</h2>
              <p className="ticket__help">Pick a loan from the list to see what liquidating it would repay and pay you. Only a loan under health 1, outside a pause, can be liquidated.</p>
            </section>
          )}
          <section className="tr__panel">
            <h2 className="obx__boxtitle">How it works</h2>
            <ol className="steps steps--col">
              <li><span className="steps__n">1</span><b>Health falls below 1</b><p>The loan is more than its tier’s liquidation share of the worst world.</p></li>
              <li><span className="steps__n">2</span><b>You repay part of it</b><p>Up to half (all of a small or far-gone loan), in USDC from your wallet.</p></li>
              <li><span className="steps__n">3</span><b>You take collateral</b><p>The same share of every piece plus the tier’s bonus, as world tokens or sold for cash.</p></li>
            </ol>
          </section>
        </aside>
      </div>
    </div>
  )
}

function worldName(m: ChainMarket | undefined, w: number | null): string {
  if (w === null) return '–'
  return m?.worlds[w]?.outcome ?? `World ${w + 1}`
}

function Row({ r, m, grace, picked, me, onPick }: { r: AtRiskRow; m: ChainMarket | undefined; grace: bigint; picked: boolean; me: string | null; onPick: () => void }) {
  const actions = useActions()
  const status = statusLabel(r, grace)
  const can = r.liquidation === 'liquidatable'
  const st = can ? 'risk' : status === 'Healthy' ? 'final' : 'live'
  return (
    <div className={`desk__tr ar__tr${picked ? ' is-picked' : ''}`}>
      <span className="ar__who"><b title={r.accountId}>{accountLabel(r.accountId)}{r.accountId === me ? ' (you)' : ''}</b><small><span className={`rs__state rs__state--${st}`}>{status}</span></small></span>
      <span className="ar__mk"><Link href={marketHref(r.scenarioId)} title={m?.question}>{m?.question ?? `Market #${r.scenarioId}`}</Link><small><Link href={borrowHref(r.scenarioId, r.tier)}>{TIER_LABEL[r.tier]} tier</Link></small></span>
      <span className="num">{fmtUsd(r.debt)}</span>
      <span className={`num tone--${TONE[hfTone(r.healthFactor)]}`}>{fmtHf(r.healthFactor)}</span>
      <span>{worldName(m, r.worstWorld)}</span>
      <span className="ar__acts">
        {r.writeOffReady && (
          <RowAction label="Write off" busyLabel="Writing off…" action="write_off" tone="sell"
            run={() => actions.send(writeOffBadDebt(CONTRACT_ID, { scenarioId: r.scenarioId, accountId: r.accountId, tier: r.tier }), { kind: 'loan', title: 'Bad debt', pending: 'Writing off…', done: 'Written off: insurance first, then lenders', market: r.scenarioId }, { needs: { contract: true } })} />
        )}
        <button type="button" className={`mk__btn mk__btn--${can ? 'sell' : 'buy'}`} aria-pressed={picked} onClick={onPick}>{can ? 'Liquidate' : 'Quote'}</button>
      </span>
    </div>
  )
}

/** The world tokens in the wallet: where liquidations in tokens mode (and sales) leave their pieces. */
function Seized({ account, bySid }: { account: string; bySid: ReadonlyMap<number, ChainMarket> }) {
  const holdings = useHoldings(account)
  return (
    <section className="tr__panel">
      <div className="desk__head"><h2 className="obx__boxtitle">Your world tokens</h2><span className="pc__note">Pieces taken as tokens land here</span></div>
      {!holdings.data ? <p className="obx__empty">{holdings.error ? errorLine(holdings.error.message) : 'Reading your tokens…'}</p> : holdings.data.length === 0 ? <p className="obx__empty">No world tokens in this wallet.</p> : (
        <div className="desk__table">
          <div className="desk__tr desk__tr--head lc__tr"><span>Token</span><span>Amount</span><span>Market</span><span /></div>
          {holdings.data.map((h) => {
            const m = bySid.get(h.scenarioId)
            return (
              <div key={h.tokenId} className="desk__tr lc__tr">
                <span><PieceName piece={h.tokenId} market={m} /></span>
                <span className="num">{fmtAsset(h.asset, h.amount)}</span>
                <span className="ar__mk"><Link href={marketHref(h.scenarioId)}>{m?.question ?? `Market #${h.scenarioId}`}</Link></span>
                <span />
              </div>
            )
          })}
        </div>
      )}
      <p className="pc__note lc__note">Tokens of worlds still possible pay out at resolution; cash mode sells and merges them for you.</p>
    </section>
  )
}
