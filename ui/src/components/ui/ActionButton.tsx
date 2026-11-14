'use client'
// The button every transaction goes through, in the site's Button style. It says what stops the action before it is
// pressed (no wallet, the screen's own reason, a pause of that action, too little NEAR for gas), shows the step while
// the wallet works, and leaves the result to the toast. `run` is an adapter action (useActions()); anything it
// returns is passed to `onDone` when it succeeded.
import { useState } from 'react'
import type { ActionResult } from '../../chain/adapter'
import { useBlocker } from '../../chain/adapter'
import { useWallet } from '../../chain/near/wallet'
import type { AppAction } from '../../chain/pause'

type Props = {
  label: string
  busyLabel?: string
  /** The screen's own reason the action cannot run yet ("Enter an amount"), shown instead of the label. */
  blocker?: string
  /** What the action is, for the pause flags and the gas check (pause.ts). */
  action?: AppAction
  gas?: string
  deposit?: bigint | string
  variant?: 'primary' | 'ghost'
  run: () => Promise<ActionResult>
  onDone?: (r: Extract<ActionResult, { ok: true }>) => void
}

export function ActionButton({ label, busyLabel, blocker, action, gas, deposit, variant = 'primary', run, onDone }: Props) {
  const { accountId, connect, ready, connecting } = useWallet()
  const chainBlock = useBlocker(action ?? 'register', { gas, deposit })
  const [busy, setBusy] = useState(false)
  const reason = accountId ? (blocker ?? (action ? chainBlock : undefined)) : undefined
  const text = !accountId ? (connecting ? 'Connecting…' : 'Connect NEAR wallet') : busy ? (busyLabel ?? 'Confirm in your wallet…') : (reason ?? label)

  return (
    <button
      type="button"
      className={`btn btn--${variant}`}
      disabled={busy || (!accountId && (!ready || connecting)) || Boolean(accountId && reason)}
      onClick={async () => {
        if (!accountId) { await connect(); return }
        setBusy(true)
        try {
          const r = await run()
          if (r.ok) onDone?.(r)
        } finally {
          setBusy(false)
        }
      }}
    >
      {text}
    </button>
  )
}
