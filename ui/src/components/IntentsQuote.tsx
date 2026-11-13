// A live dry-run quote from NEAR Intents (1Click) for landing NEAR or USDC on NEAR from another chain,
// and the stages a real swap would go through, including the two that end badly (refunded, failed).
import { useEffect, useState } from 'react'
import { dryQuote, DESTINATIONS, SOURCES, type DryQuote, type SourceId, type SwapStatus } from '../lib/intents'

const recipient = process.env.NEXT_PUBLIC_INTENTS_RECIPIENT ?? 'demo.near' // where a real deposit would land
const usd = (s: string) => `$${Number(s).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
const num = (s: string, d = 4) => Number(s).toLocaleString('en-US', { maximumFractionDigits: d })

// the happy path, then the two ways a swap can end without succeeding
const TRACK: { status: SwapStatus; label: string; note: string }[] = [
  { status: 'PENDING_DEPOSIT', label: 'Waiting for deposit', note: 'Send the quoted amount to the deposit address.' },
  { status: 'KNOWN_DEPOSIT_TX', label: 'Deposit seen', note: 'Your transfer is on its way to NEAR.' },
  { status: 'PROCESSING', label: 'Swapping', note: 'Solvers are filling the swap.' },
  { status: 'SUCCESS', label: 'Arrived on NEAR', note: 'It lands in your Origami account, ready to push into every world.' },
]
const ENDINGS: { status: SwapStatus; label: string; note: string }[] = [
  { status: 'REFUNDED', label: 'Refunded', note: 'The swap couldn’t complete in time, so your deposit went back to your refund address, minus the refund fee.' },
  { status: 'FAILED', label: 'Failed', note: 'Something went wrong on the way. Nothing was credited; check the swap on the Intents explorer.' },
]

export function IntentsQuote({ source, asset, amount }: { source: SourceId; asset: keyof typeof DESTINATIONS; amount: number }) {
  const [quote, setQuote] = useState<DryQuote | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // in a dry run there is no swap to follow, so the track can be stepped through to see each stage
  const [preview, setPreview] = useState<SwapStatus | null>(null)
  const src = SOURCES.find((s) => s.id === source)!

  useEffect(() => {
    if (!(amount > 0)) { setQuote(null); setError(''); return }
    const ctl = new AbortController()
    // wait for typing to settle before asking
    const t = setTimeout(() => {
      setLoading(true)
      setError('')
      dryQuote(source, asset, amount, recipient, ctl.signal)
        .then((q) => { setQuote(q); setLoading(false) })
        .catch((e: Error) => { if (e.name !== 'AbortError') { setError(e.message); setQuote(null); setLoading(false) } })
    }, 450)
    return () => { clearTimeout(t); ctl.abort() }
  }, [source, asset, amount])

  if (!(amount > 0)) return null
  const at = (s: SwapStatus) => TRACK.findIndex((x) => x.status === s)
  const ending = ENDINGS.find((e) => e.status === preview)
  // how far along the track the previewed stage is; a bad ending got as far as swapping, then stopped
  const reached = !preview ? -1 : ending ? 2 : at(preview)

  return (
    <div className="iq" aria-live="polite">
      <p className="iq__head">Quote from NEAR Intents <em>dry run</em></p>
      {error ? (
        <p className="iq__error">No quote: {error}</p>
      ) : !quote || loading ? (
        <p className="iq__wait">Asking 1Click for a price…</p>
      ) : (
        <>
          <dl className="iq__rows">
            <div><dt>You send</dt><dd>{num(quote.amountInFormatted)} {src.label.split(' on ')[0]} <small>{usd(quote.amountInUsd)} on {src.label.split(' on ')[1]}</small></dd></div>
            <div><dt>Lands on NEAR</dt><dd>{num(quote.amountOutFormatted)} {DESTINATIONS[asset].symbol} <small>{usd(quote.amountOutUsd)}</small></dd></div>
            <div><dt>Takes about</dt><dd>{quote.timeEstimate < 60 ? `${quote.timeEstimate} seconds` : `${Math.round(quote.timeEstimate / 60)} minutes`}</dd></div>
            {quote.refundFee && <div><dt>If it’s refunded</dt><dd>{num(String(Number(quote.refundFee) / 10 ** src.decimals))} {src.label.split(' on ')[0]} fee</dd></div>}
          </dl>
          <p className="iq__note">A dry run has no deposit address, so nothing can be sent. Contracts stay on testnet; Intents has no testnet, so these are mainnet prices.</p>
        </>
      )}

      <div className="iq__track">
        <p className="iq__track-head">What a real deposit goes through <button type="button" onClick={() => setPreview(null)} disabled={!preview}>Reset</button></p>
        <ol>
          {TRACK.map((s, i) => (
            <li key={s.status} className={i <= reached ? 'is-done' : ''}>
              <button type="button" onClick={() => setPreview(s.status)} aria-pressed={preview === s.status}>{s.label}</button>
            </li>
          ))}
        </ol>
        <div className="iq__endings">
          {ENDINGS.map((e) => (
            <button key={e.status} type="button" className={`iq__end iq__end--${e.status.toLowerCase()}`} aria-pressed={preview === e.status} onClick={() => setPreview(e.status)}>{e.label}</button>
          ))}
        </div>
        <p className="iq__state">
          {preview ? (ending ?? TRACK[at(preview)]).note : 'Tap a stage to see what you’d see at that point. The live status is read from 1Click once a real deposit exists.'}
        </p>
      </div>
    </div>
  )
}
