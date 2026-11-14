'use client'
// A transaction from a table row, as the desk's small buttons (mk__btn): the row's version of ActionButton. It names
// what stops the action (a pause, too little NEAR for gas) in its tooltip and shows the step while the wallet works;
// the toast tells the result.
import { useState } from 'react'
import type { ActionResult } from '../../chain/adapter'
import { useBlocker } from '../../chain/adapter'
import { useWallet } from '../../chain/near/wallet'
import type { AppAction } from '../../chain/pause'

type Props = {
  label: string
  busyLabel?: string
  action: AppAction
  gas?: string
  deposit?: bigint | string
  tone?: 'buy' | 'sell'
  /** The row's own reason it cannot run (tooltip), which also disables it. */
  blocker?: string
  run: () => Promise<ActionResult>
}

export function RowAction({ label, busyLabel, action, gas, deposit, tone = 'buy', blocker, run }: Props) {
  const { accountId, connect } = useWallet()
  const chain = useBlocker(action, { gas, deposit })
  const [busy, setBusy] = useState(false)
  const reason = accountId ? (blocker ?? chain) : undefined
  return (
    <button
      type="button"
      className={`mk__btn mk__btn--${tone}`}
      disabled={busy || Boolean(reason)}
      title={reason}
      onClick={async () => {
        if (!accountId) { await connect(); return }
        setBusy(true)
        try { await run() } finally { setBusy(false) }
      }}
    >
      {busy ? (busyLabel ?? 'Confirm…') : label}
    </button>
  )
}
