'use client'
// The split and merge ticket, in the market ticket's style: real wNEAR or USDC from the wallet becomes the same amount
// in every world still possible (split), and a full set of pieces goes back into the real token (merge). The Split page
// shows it with both modes; the market page's Fund tab shows the split alone.
import { useState } from 'react'
import Link from 'next/link'
import { useActions, usePosition, useWalletBalances, type ChainMarket } from '../chain/adapter'
import { fmt, inputText, parseAmount } from '../chain/format'
import { splitHref } from '../chain/links'
import { useWallet } from '../chain/near/wallet'
import { mergeable } from '../chain/merge'
import { canSplit } from '../chain/split'
import type { Asset } from '../chain/types'
import { ActionButton } from './ui/ActionButton'

export type SplitMode = 'split' | 'merge'

const SYM: Record<Asset, string> = { wnear: 'wNEAR', usdc: 'USDC' }
// USDC has 6 decimals; an amount it cannot represent is refused rather than rounded
const DECIMALS: Record<Asset, number> = { wnear: 18, usdc: 6 }
const num = (v: string) => v.replace(/[^0-9.]/g, '')

export function SplitTicket({ market, mode, asset, onMode, onAsset, onDone }: {
  market: ChainMarket
  mode: SplitMode
  asset: Asset
  /** Without it the ticket only splits (the market page's Fund tab). */
  onMode?: (m: SplitMode) => void
  onAsset: (a: Asset) => void
  onDone?: () => void
}) {
  const { accountId } = useWallet()
  const actions = useActions()
  const wallet = useWalletBalances()
  const { position } = usePosition(market.sid)
  const [text, setText] = useState('')
  const sym = SYM[asset]
  const worlds = market.worlds.filter((w) => w.possible)
  const amount = parseAmount(text, DECIMALS[asset])
  const inWallet = wallet ? (asset === 'wnear' ? wallet.nearWad : wallet.usdcWad) : undefined
  const max = mode === 'split' ? inWallet : mergeable(position?.worlds, market.possible, asset)
  const open = canSplit(market.possible) && !market.settled

  let blocker: string | undefined
  if (!open) blocker = 'One world is left: redeem it on Resolve'
  else if (!amount) blocker = 'Enter an amount'
  else if (max !== undefined && amount > max) blocker = mode === 'split' ? `Your wallet holds ${fmt(max)} ${sym}` : `You can merge at most ${fmt(max)} ${sym}`

  const share = (k: bigint) => { if (max) setText(inputText((max * k) / 100n, asset === 'usdc' ? 6 : 4)) }

  return (
    <>
      {onMode && (
        <div className="pc__tabs" role="group" aria-label="Split or merge">
          {(['split', 'merge'] as const).map((m) => <button key={m} type="button" aria-pressed={mode === m} onClick={() => { setText(''); onMode(m) }}>{m === 'split' ? 'Split' : 'Merge'}</button>)}
        </div>
      )}
      <p className="ticket__help">
        {mode === 'split'
          ? <>Real {sym} from your wallet becomes {sym === 'wNEAR' ? 'NEAR' : 'USDC'} in each of the {worlds.length} worlds still possible. Together the pieces are worth exactly what you put in.</>
          : <>A full set, the same amount in each of the {worlds.length} worlds still possible, goes back into real {sym} in your wallet.</>}
      </p>
      <div className="sc__seg" role="group" aria-label="Asset">
        {(['wnear', 'usdc'] as const).map((a) => <button key={a} type="button" aria-pressed={asset === a} onClick={() => { setText(''); onAsset(a) }}>{SYM[a]}</button>)}
      </div>
      <label className="tk__field"><span>Amount</span>
        <input aria-label={`${sym} to ${mode}`} inputMode="decimal" placeholder="0" value={text} onChange={(e) => setText(num(e.target.value))} />
        <em>{sym}</em>
      </label>
      <div className="tk__pcts" role="group" aria-label={mode === 'split' ? 'Share of your wallet' : 'Share of what merges'}>
        {[25n, 50n, 75n, 100n].map((k) => <button key={String(k)} type="button" disabled={!max} onClick={() => share(k)}>{k === 100n ? 'Max' : `${k}%`}</button>)}
      </div>
      <div className="ov">
        <p className="ov__title">Transaction overview</p>
        {mode === 'split' ? (
          <>
            <p className="tk__line"><span>From your wallet</span><b className="num">{amount ? fmt(amount) : '–'} {sym}</b></p>
            <p className="tk__line"><span>You get in each world</span><b className="num">{amount ? fmt(amount) : '–'} × {worlds.length}</b></p>
          </>
        ) : (
          <>
            <p className="tk__line"><span>From each world</span><b className="num">{amount ? fmt(amount) : '–'} × {worlds.length}</b></p>
            <p className="tk__line"><span>Back in your wallet</span><b className="num">{amount ? fmt(amount) : '–'} {sym}</b></p>
          </>
        )}
        <p className="tk__line"><span>{mode === 'split' ? 'In your wallet' : 'Merges at most'}</span><b className="num">{max !== undefined && accountId ? `${fmt(max)} ${sym}` : '–'}</b></p>
      </div>
      <div className={`tk ${mode === 'split' ? 'tk--buy' : 'tk--sell'}`}>
        <ActionButton
          label={mode === 'split' ? `Split into ${worlds.length} worlds` : `Merge back into ${sym}`}
          blocker={blocker}
          action={mode}
          run={() => (mode === 'split' ? actions.split(market, asset, amount!) : actions.merge(market, asset, amount!))}
          onDone={() => { setText(''); onDone?.() }}
        />
      </div>
      {!onMode && <Link className="ticket__switch tr__link" href={splitHref(market.sid, { mode: 'merge', asset })}>Merge a full set back</Link>}
    </>
  )
}
