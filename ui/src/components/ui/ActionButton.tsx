'use client'
// The button every transaction goes through, in the site's Button style. It says what stops the action before it is
// pressed (no wallet, the screen's own reason, a pause of that action, too little NEAR for gas), shows the step while
// the wallet works, and leaves the result to the toast. `run` is an adapter action (useActions()); anything it
// returns is passed to `onDone` when it succeeded. When the contract refused for want of storage, the button offers
// to add that NEAR to the account's storage deposit first, then goes back to the action.
import { useState } from 'react'
import type { ActionResult } from '../../chain/adapter'
import { useActions, useBlocker } from '../../chain/adapter'
import { BRAND } from '../../chain/brand'
import { CONTRACT_ID } from '../../chain/data/client'
import { storageDeposit } from '../../chain/near/tx'
import { useWallet } from '../../chain/near/wallet'
import type { AppAction } from '../../chain/pause'
import { storageShortfall } from '../../chain/storage-floor'
import { fmtYocto } from '../../chain/units'

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
  const actions = useActions()
  const [busy, setBusy] = useState(false)
  // NEAR to add to the storage deposit before the action can fit, after an InsufficientStorage refusal
  const [short, setShort] = useState<bigint | undefined>(undefined)
  const reason = accountId ? (blocker ?? (action ? chainBlock : undefined)) : undefined
  const topUp = short !== undefined && !reason
  const text = !accountId ? (connecting ? 'Connecting…' : 'Connect NEAR wallet') : busy ? (busyLabel ?? 'Confirm in your wallet…') : topUp ? `Add ${fmtYocto(short)} NEAR to storage` : (reason ?? label)

  return (
    <button
      type="button"
      className={`btn btn--${variant}`}
      disabled={busy || (!accountId && (!ready || connecting)) || Boolean(accountId && reason)}
      onClick={async () => {
        if (!accountId) { await connect(); return }
        setBusy(true)
        try {
          if (topUp && short !== undefined) {
            const r = await actions.send(storageDeposit(CONTRACT_ID, short, false), { kind: 'wallet', title: 'Storage', pending: `Adding ${fmtYocto(short)} NEAR to your ${BRAND.name} storage…`, done: 'Storage topped up; try again' })
            if (r.ok) setShort(undefined)
            return
          }
          const r = await run()
          if (r.ok) onDone?.(r)
          else setShort(storageShortfall(r.error))
        } finally {
          setBusy(false)
        }
      }}
    >
      {text}
    </button>
  )
}
