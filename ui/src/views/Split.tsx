'use client'
// Split and merge, in the desk pages' style. A market's split turns real wNEAR or USDC into the same amount in every
// world still possible, and a full set of those pieces merges back into the real token. Reached from a market's Fund
// tab and from "Add funds" on the order book; /split/?id=N&asset=wnear|usdc&mode=split|merge.
//   header       what splitting is, and what your wallet holds
//   market cards every open market (the one you split into is picked)
//   holdings     what you hold in each world of it, and what this split or merge would change
//   ticket       split or merge, wNEAR or USDC, the amount, the overview and the button
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { MarketArt, WorldIcon } from '../components/Grand'
import { PageLoading } from '../components/layout/PageLoading'
import { SplitTicket, type SplitMode } from '../components/SplitTicket'
import { mergeable } from '../chain/merge'
import { marketId, useMarket, useMarkets, usePosition, useWalletBalances } from '../chain/adapter'
import { errorLine } from '../chain/errors'
import { fmt } from '../chain/format'
import { marketsHref, ordersHref, resolveHref, splitHref } from '../chain/links'
import { useWallet } from '../chain/near/wallet'
import type { Asset } from '../chain/types'
import { chain } from '../config'

export default function Split({ id }: { id: string }) {
  const params = useSearchParams()
  const router = useRouter()
  const { accountId } = useWallet()
  const sid = marketId(id) ?? chain.anchorMarket
  const mode: SplitMode = params.get('mode') === 'merge' ? 'merge' : 'split'
  const asset: Asset = params.get('asset') === 'usdc' ? 'usdc' : 'wnear'
  const { markets } = useMarkets()
  const { market: m, isLoading, notFound, error } = useMarket(sid)
  const { position } = usePosition(sid)
  const wallet = useWalletBalances()
  const go = (o: { sid?: number; mode?: SplitMode; asset?: Asset }) =>
    router.replace(splitHref(o.sid ?? sid, { mode: o.mode ?? mode, asset: o.asset ?? asset }), { scroll: false })

  if (notFound && !isLoading) {
    return (
      <div className="page tr desk">
        <header className="tr__pair"><div className="tr__id"><h1 className="mk__title">Split and merge</h1><p className="tr__means">Turn real wNEAR or USDC into one piece in every world of a market, or merge a full set back.</p></div></header>
        <div className="tr__panel desk__empty"><p><b>No market #{id}.</b> The link may be wrong, or the market is on another deployment.</p><Link className="mk__btn mk__btn--buy" href={marketsHref}>See the markets</Link></div>
      </div>
    )
  }
  if (!m) return error ? <PageLoading label={errorLine(error.message)} /> : <PageLoading />

  const open = (markets ?? []).filter((x) => !x.settled)
  const cards = open.some((x) => x.sid === m.sid) ? open : [m, ...open]
  const live = m.worlds.filter((w) => w.possible)
  const sym = asset === 'wnear' ? 'wNEAR' : 'USDC'
  const held = (w: number) => {
    const h = position?.worlds[w]
    return h ? (asset === 'wnear' ? h.walletNearWad : h.walletUsdcWad) : 0n
  }
  const canMerge = mergeable(position?.worlds, m.possible, asset)

  return (
    <div className="page tr desk">
      {/* ---------- header ---------- */}
      <header className="tr__pair">
        <div className="tr__id">
          <h1 className="mk__title">Split and merge</h1>
          <p className="tr__means">1 NEAR becomes 1 NEAR in every world still possible. Together the pieces are worth exactly your NEAR, and a full set merges back any time.</p>
        </div>
        <dl className="tr__stats">
          <div><dt>wNEAR in your wallet</dt><dd className="num">{wallet ? fmt(wallet.nearWad) : '–'}</dd></div>
          <div><dt>USDC in your wallet</dt><dd className="num">{wallet ? fmt(wallet.usdcWad) : '–'}</dd></div>
          <div><dt>Worlds still possible</dt><dd className="num">{live.length} of {m.worldCount}</dd></div>
        </dl>
      </header>

      {/* ---------- markets ---------- */}
      <div className="desk__cards" role="group" aria-label="Market">
        {cards.map((x) => (
          <button key={x.sid} type="button" aria-pressed={x.sid === m.sid} className="desk__card" onClick={() => go({ sid: x.sid })}>
            <MarketArt m={x} size={40} />
            <span className="desk__cardtext"><b>{x.question}</b><small>{x.kind} · {x.resolves}</small></span>
          </button>
        ))}
      </div>

      <div className="mk__grid">
        <div className="mk__main">
          {/* ---------- holdings per world ---------- */}
          <section className="tr__panel">
            <div className="desk__head"><h2 className="obx__boxtitle">What you hold in each world</h2><Link href={m.href} className="tr__link">Open the market</Link></div>
            {!accountId ? (
              <p className="obx__empty">Connect a wallet to see what you hold in each world.</p>
            ) : (
              <div className="desk__table">
                <div className="desk__tr desk__tr--head sp__tr"><span>World</span><span>NEAR</span><span>USDC</span><span>Trade</span></div>
                {m.worlds.map((w) => {
                  const h = position?.worlds[w.index]
                  return (
                    <div key={w.index} className={`desk__tr sp__tr${w.possible ? '' : ' is-dead'}`}>
                      <span className="desk__mk"><WorldIcon m={m} w={w.index} size={22} possible={m.possible} />{w.outcome}</span>
                      <span className="num">{h ? fmt(h.walletNearWad) : '–'}</span>
                      <span className="num">{h ? fmt(h.walletUsdcWad) : '–'}</span>
                      <span>{w.possible ? <Link className="mk__btn mk__btn--buy" href={ordersHref(m.sid, { w: w.index })}>Order book</Link> : <small className="muted">ruled out</small>}</span>
                    </div>
                  )
                })}
              </div>
            )}
            {accountId && (
              <p className="pc__note sp__note">
                {mode === 'merge'
                  ? canMerge > 0n ? `A full set of ${sym} is ${fmt(canMerge)}: the least you hold in any world still possible.` : `Merging needs ${sym} in every world still possible; ${live.filter((w) => held(w.index) === 0n).map((w) => w.outcome).join(', ') || 'one'} holds none.`
                  : 'Pieces posted as loan collateral are not listed here; they come back on Borrow.'}
              </p>
            )}
          </section>

          {/* ---------- how it works ---------- */}
          <section className="tr__panel">
            <div className="desk__head"><h2 className="obx__boxtitle">How a split works</h2></div>
            <ol className="steps">
              <li><span className="steps__n">1</span><b>Split</b><p>Your wNEAR or USDC becomes the same amount in each world still possible, in one transaction.</p></li>
              <li><span className="steps__n">2</span><b>Trade a world</b><p>Sell NEAR for dollars in the worlds you fear, on the order book or in one go from the market’s Hedge tab.</p></li>
              <li><span className="steps__n">3</span><b>Merge or redeem</b><p>A full set merges back any time. Once one world is left, its pieces redeem 1:1 on Resolve.</p></li>
            </ol>
          </section>
        </div>

        {/* ---------- the ticket ---------- */}
        <aside className="mk__side">
          <section className="tr__panel mk__ticket">
            {m.settled || live.length < 2 ? (
              <div className="desk__empty"><p><b>One world is left.</b> Splitting needs two; what you hold in the world that happened redeems 1:1.</p><Link className="mk__btn mk__btn--buy" href={resolveHref(m.sid)}>Redeem</Link></div>
            ) : (
              <SplitTicket key={`${m.sid}-${mode}-${asset}`} market={m} mode={mode} asset={asset} onMode={(x) => go({ mode: x })} onAsset={(a) => go({ asset: a })} />
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}
