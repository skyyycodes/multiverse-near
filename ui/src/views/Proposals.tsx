'use client'
// The proposals board: every market someone proposed on the contract (`list_proposals`), newest first, as the browse
// tab of Propose was drawn: a card per proposal with its artwork, what it combines or asks, a two-part pledge bar
// (USDC and wNEAR towards the goal), the status, your pledge and the next step (pledge, withdraw, refund, claim, trade
// it once it opened). One proposal's full page is /proposal/?p=N.
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ProposalCard } from '../components/governance/Gov'
import { eventArt } from '../chain/adapter'
import type { ProposalSummary } from '../chain/domain'
import { errorLine } from '../chain/errors'
import { fmt } from '../chain/format'
import { BOARD_FILTERS, BOARD_LABEL, boardFilter, boardStats, type BoardFilter } from '../chain/governance'
import { useNowSeconds } from '../chain/hooks/useClock'
import { useEventTexts } from '../chain/hooks/useMarkets'
import { useMarketParams, usePledges, useProposalList } from '../chain/hooks/useProposal'
import { proposeHref } from '../chain/links'
import { useWallet } from '../chain/near/wallet'
import { isLive, nearText, proposalTitle } from '../chain/proposals'

const RANK = (p: ProposalSummary) => (isLive(p.status) ? 0 : p.status === 'opened' ? 1 : 2)

export default function Proposals() {
  const router = useRouter()
  const { accountId } = useWallet()
  const list = useProposalList('all', 50)
  const pledges = usePledges(accountId)
  const mp = useMarketParams().data
  const nowSec = Number(useNowSeconds())
  const [filter, setFilter] = useState<BoardFilter | 'yours'>('all')
  const ps = useMemo(() => [...(list.data?.proposals ?? [])].sort((a, b) => RANK(a) - RANK(b) || b.proposalId - a.proposalId), [list.data])
  const texts = useEventTexts(ps.flatMap((p) => p.eventIds))
  const mine = useMemo(() => new Map((pledges.data ?? []).map((pl) => [pl.proposalId, pl])), [pledges.data])
  const stats = boardStats(ps)
  const shown = filter === 'yours' ? ps.filter((p) => p.proposer === accountId || mine.has(p.proposalId)) : boardFilter(ps, filter)
  const question = (id: number) => texts.data?.get(id)?.question
  const art = (p: ProposalSummary) =>
    p.newEvent
      ? [{ image: eventArt({ rule: '', question: p.newEvent.question, finalized: false }) }]
      : p.eventIds.map((id) => {
        const e = texts.data?.get(id)
        return { image: e ? eventArt(e) : undefined }
      })

  return (
    <div className="page tr desk gv">
      <header className="tr__pair">
        <div className="tr__id">
          <p className="mk__crumb"><span className="mk__tag">Pledge-funded markets</span>On NEAR testnet, with test tokens</p>
          <h1 className="mk__title">Proposals</h1>
          <p className="tr__means">Markets people proposed. Pledges in USDC or wNEAR fund each one; when they reach the goal it opens with that money already inside. If it never opens, every pledge comes back in full.</p>
        </div>
        <dl className="tr__stats">
          <div><dt>Proposals</dt><dd className="num">{list.data ? stats.total : '–'}</dd></div>
          <div><dt>Collecting</dt><dd className="num">{list.data ? stats.live : '–'}</dd></div>
          <div><dt>Pledged</dt><dd className="num">{list.data ? `$${fmt(stats.pledged, 0)}` : '–'}</dd></div>
          <div><dt>Opened</dt><dd className="num">{list.data ? stats.opened : '–'}</dd></div>
        </dl>
      </header>

      <div className="pc__tabs desk__filter pp__tabs" role="group" aria-label="View">
        <button type="button" aria-pressed>Browse proposals</button>
        <button type="button" aria-pressed={false} onClick={() => router.push(proposeHref())}>New proposal</button>
      </div>

      <div className="mk__grid">
        <div className="mk__main">
          <div className="pc__tabs" role="group" aria-label="Filter">
            {BOARD_FILTERS.map((f) => <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{BOARD_LABEL[f]}</button>)}
            {accountId && <button type="button" aria-pressed={filter === 'yours'} onClick={() => setFilter('yours')}>Yours</button>}
          </div>
          {list.isPending ? (
            <div className="tr__panel"><p className="obx__empty" role="status">Reading the proposals…</p></div>
          ) : list.error && !list.data ? (
            <div className="tr__panel"><p className="pc__note">{errorLine(list.error.message)}</p></div>
          ) : shown.length === 0 ? (
            <div className="tr__panel desk__empty">
              <p><b>{filter === 'all' ? 'No proposals yet.' : 'Nothing here.'}</b> {filter === 'yours' ? 'Proposals you make or pledge to show up here.' : 'Propose a market and both sides can start pledging.'}</p>
              <Link href={proposeHref()} className="mk__btn mk__btn--buy">Propose a market</Link>
            </div>
          ) : (
            shown.map((p) => <ProposalCard key={p.proposalId} p={p} title={proposalTitle(p, question)} art={art(p)} nowSec={nowSec} mine={mine.get(p.proposalId)} />)
          )}
        </div>
        <aside className="mk__side">
          <section className="tr__panel">
            <h2 className="obx__boxtitle">From idea to market</h2>
            <ol className="steps steps--col">
              <li><span className="steps__n">1</span><b>Propose</b><p>A new yes/no event with its rule, source and deadline, or a mix of events that already trade.{mp ? ` A refundable bond of ${nearText(mp.params.bondNewEvent)} NEAR (${nearText(mp.params.bondMarket)} for a mix) plus a storage reserve.` : ''}</p></li>
              <li><span className="steps__n">2</span><b>Check</b><p>The owner checks a new event: a clear answer, public data, nothing a trader could cause. A mix of checked events skips this.</p></li>
              <li><span className="steps__n">3</span><b>Pledge</b><p>Anyone locks USDC or wNEAR. Until the market opens, you can take it all back.</p></li>
              <li><span className="steps__n">4</span><b>Open</b><p>At the goal, the market opens by itself. Pledges become its first liquidity, and pledgers get seed shares.</p></li>
              <li><span className="steps__n">5</span><b>Resolve</b><p>From the public data in the rule, with a dispute window, like every market.</p></li>
            </ol>
          </section>
          <Link href={proposeHref()} className="mk__btn mk__btn--buy pp__new">Start a proposal</Link>
        </aside>
      </div>
    </div>
  )
}
