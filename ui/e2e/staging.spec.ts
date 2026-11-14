// The whole site against staging, as a first-time visitor would use it, through the ui with real transactions: the
// landing, Markets in the navbar, market pages for 2, 4 and 8 worlds, connect, test tokens, split, hedge, an order
// placed and cancelled, supply and withdraw, borrow and repay, the portfolio, at-risk loans, a combination proposed,
// pledged to and withdrawn, resolve, and the owner's console (one flag paused and lifted in a finally). Then a phone
// pass at 390×844. No console error may appear anywhere.
//
// The visitor is a fresh account, judge-ui1.<root>, made with 0.3 NEAR from the root on the first run (a re-run reuses
// it). It never reports or finalizes an event; every order, loan, pledge and proposal it makes is cancelled, repaid or
// withdrawn before its test ends.
//   pnpm build:staging && NEAR_KEYS_DIR=/path/to/.keys/staging STAGING=1 pnpm e2e:staging -g staging
import { writeFileSync } from 'node:fs'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { actions } from 'near-api-js'
import { CONTRACT, demoWallet, ensureSubAccount, nearBalance, patient, persona, signer, topUp, view, walletIdle, type Signed } from './staging/chain'

const BASE = process.env.BASE_URL || 'http://localhost:3045'
const LOCAL = !process.env.BASE_URL || /localhost|127\.0\.0\.1/.test(BASE)
const ROOT = persona('owner')
const JUDGE = `judge-ui1.${ROOT}`
const NEAR = 10n ** 24n
/** The lendable anchor market (SPICE × Fed): the money flows run here. */
const ANCHOR = 1

const txs: { step: string; account: string; hash: string; ok: boolean; error?: string }[] = []
test.describe.configure({ mode: 'serial', timeout: 900_000 })
test.afterAll(() => {
  try {
    writeFileSync('test-results/staging-txs.json', JSON.stringify(txs, null, 1))
  } catch {}
  console.log(['TXS', ...txs.map((t) => `${t.ok ? 'ok' : 'FAILED'} ${t.account.split('.')[0]} ${t.step}: ${t.hash}${t.error ? ` ${t.error}` : ''}`)].join('\n  '))
})

type Visit = { account: string; context: BrowserContext; page: Page; signed: Signed[]; errors: string[]; close: () => Promise<void> }

/**
 * A browser for `account` (the demo-wallet bridge signs as it; null: a visitor without a wallet). Every console error and page error is collected;
 * the one exception is the keeper ping's 404 on a local static server, which has no /api/keeper/ (the host does).
 */
async function visit(browser: Browser, account: string | null, o: { autoConnect?: boolean; phone?: boolean } = {}): Promise<Visit> {
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: o.phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(o.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    reducedMotion: 'reduce',
  })
  const signed: Signed[] = []
  if (account) await demoWallet(context, account, signed, { autoConnect: o.autoConnect })
  else await context.addInitScript(() => { try { localStorage.setItem('ov-intro-seen', '1') } catch {} })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror ${page.url()}: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    if (LOCAL && /\/api\/keeper\/?$/.test(m.location().url)) return
    errors.push(`console ${page.url()}: ${m.text().slice(0, 300)}`)
  })
  return { account: account ?? '', context, page, signed, errors, close: () => context.close() }
}

async function connected(page: Page, account: string) {
  await expect(page.locator('.topbar__wallet')).toContainText(account.slice(0, 8), { timeout: 60_000 })
}

/** Runs `click`, then waits for the action's toast: done (with `done` in it) or failed (which fails the step). */
async function tx(v: Visit, step: string, click: () => Promise<void>, done: RegExp) {
  const before = v.signed.length
  const failedBefore = await v.page.locator('.toast.is-failed').count()
  await click()
  const ok = v.page.locator('.toast.is-done', { hasText: done })
  const failed = v.page.locator('.toast.is-failed')
  await expect(ok.or(failed.nth(failedBefore)).first()).toBeVisible({ timeout: 180_000 })
  await walletIdle()
  for (const s of v.signed.slice(before)) txs.push({ step, account: v.account, hash: s.hash, ok: s.ok, error: s.error })
  if ((await failed.count()) > failedBefore) throw new Error(`${step}: ${await failed.nth(failedBefore).innerText()}`)
  expect(v.signed.slice(before).every((s) => s.ok)).toBe(true)
}

/** Presses a transaction button (by its label) once it is enabled. */
async function press(v: Visit, step: string, name: string | RegExp, done: RegExp, scope?: ReturnType<Page['locator']>) {
  const b = (scope ?? v.page).getByRole('button', { name, exact: typeof name === 'string' })
  await expect(b).toBeEnabled({ timeout: 90_000 })
  await tx(v, step, () => b.click(), done)
}

test('staging: the landing, Markets in the navbar, market pages for 4, 2 and 8 worlds (read-only)', async ({ browser }) => {
  const v = await visit(browser, null)
  try {
    const list = (await view<{ markets: { scenario_id: number; status: string; world_count: number }[] }>('list_markets', { from_id: null, limit: 50, listed_only: true })).markets
    await v.page.goto('/')
    await expect(v.page).toHaveTitle('IfVerse')
    await expect(v.page.locator('.topbar__mark')).toHaveText('IfVerse')
    await expect(v.page.locator('.mtable__row:not(.mtable__row--head)')).toHaveCount(list.filter((m) => m.status !== 'resolved').length, { timeout: 60_000 })
    await v.page.locator('.topbar__nav a', { hasText: 'Markets' }).click()
    await expect(v.page).toHaveURL(/\/markets\/$/)
    await expect(v.page.locator('.mk-card')).toHaveCount(list.length, { timeout: 60_000 })
    for (const sid of [1, 4, 8]) {
      const m = list.find((x) => x.scenario_id === sid)!
      await v.page.goto(`/market/?id=${sid}`)
      await expect(v.page.locator('.mk__row')).toHaveCount(m.world_count, { timeout: 60_000 })
      await expect(v.page.locator('.mk__row .mk__chance b').first()).toHaveText(/%$/)
      await expect(v.page.locator('.mk__ticket')).toBeVisible()
    }
    expect(v.errors).toEqual([])
  } finally {
    await v.close()
  }
})

test('staging: a fresh account connects and gets test tokens', async ({ browser }) => {
  const made = await ensureSubAccount('judge-ui1', (3n * NEAR) / 10n)
  createdNow = made.created
  if (made.hash) txs.push({ step: 'create judge-ui1 with 0.3 NEAR (root)', account: ROOT, hash: made.hash, ok: true })
  const v = await visit(browser, JUDGE, { autoConnect: false })
  try {
    await v.page.goto('/')
    const wallet = v.page.locator('.topbar__wallet')
    await expect(wallet).toHaveText(/Connect/, { timeout: 60_000 })
    await expect(wallet).toBeEnabled({ timeout: 60_000 })
    await wallet.click()
    await v.page.getByText('Demo wallet (test keys)').first().click()
    await connected(v.page, JUDGE)
    await wallet.click()
    const panel = v.page.locator('.wm__panel')
    const get = panel.getByRole('button', { name: /Get test tokens|Test tokens in wallet/ })
    await expect(get).toBeVisible({ timeout: 60_000 })
    if ((await get.textContent())?.includes('Get test tokens')) {
      await expect(get).toBeEnabled({ timeout: 60_000 })
      await tx(v, 'get test tokens (mint wNEAR, USDC, register)', () => get.click(), /Test tokens are in your wallet/)
    }
    await expect(panel.locator('.wm__bal b').first()).not.toHaveText('–', { timeout: 60_000 })
    await expect(panel.getByRole('button', { name: 'Test tokens in wallet' })).toBeDisabled({ timeout: 60_000 })
    expect(v.errors).toEqual([])
  } finally {
    await v.close()
  }
})

/** A routine ft_transfer_call (split, sell, supply, repay: 150 Tgas) keeps 0.15 NEAR of gas bought up front, most of it
 *  refunded; the UI asks 0.16 free. 0.3 NEAR less the 0.1 NEAR storage registration covers that, so an account under
 *  0.18 NEAR is short: the account this run created gets 0.2 NEAR more from the root, once (the most a run may take). An
 *  older account under the floor stops the run instead. */
const GAS_FLOOR = (18n * NEAR) / 100n
let createdNow = false
let toppedUp = false
async function enoughForGas() {
  const have = await nearBalance(JUDGE)
  if (have >= GAS_FLOOR) return
  if (!createdNow || toppedUp) {
    throw new Error(`${JUDGE} holds ${Number(have / 10n ** 21n) / 1000} NEAR; a 150 Tgas call needs ${Number(GAS_FLOOR / 10n ** 21n) / 1000}. Send it a little NEAR by hand.`)
  }
  const hash = await topUp(JUDGE, (2n * NEAR) / 10n)
  toppedUp = true
  txs.push({ step: 'top up judge-ui1 with 0.2 NEAR (root): a 150 Tgas call reserves 0.15 NEAR', account: ROOT, hash, ok: true })
}

type OrderView = { id: string; mask: number; side: string; price: string; remaining: string }

test('staging: split, hedge one world, an order placed and cancelled', async ({ browser }) => {
  await enoughForGas()
  const v = await visit(browser, JUDGE)
  try {
    // Fund: real wNEAR into every world of the anchor market
    await v.page.goto(`/market/?id=${ANCHOR}`)
    await connected(v.page, JUDGE)
    const ticket = v.page.locator('.mk__ticket')
    await ticket.getByRole('group', { name: 'Action' }).getByRole('button', { name: 'Fund' }).click()
    await ticket.getByLabel('wNEAR to split').fill('2')
    await press(v, 'split 2 wNEAR into market 1', 'Split into 4 worlds', /Split into 4 worlds/, ticket)
    await expect(v.page.locator('.mk__row').first()).toContainText(/\d NEAR/, { timeout: 60_000 })

    // Hedge: pick the world you fear in the list, sell NEAR there for its dollars, keep the result in the wallet
    const feared = v.page.locator('.mk__row', { hasText: 'Delayed & holds' })
    await feared.getByRole('button', { name: 'Hedge' }).click()
    await expect(ticket.getByRole('group', { name: 'Action' }).locator('button[aria-pressed="true"]')).toHaveText('Hedge')
    await ticket.getByLabel('wNEAR to hedge').fill('1')
    const keep = ticket.locator('.hp__keep input')
    if (await keep.isChecked()) await keep.uncheck()
    await expect(ticket.locator('.tk__line', { hasText: 'Least each sold world pays' })).toBeVisible({ timeout: 60_000 })
    await press(v, 'hedge: sell 1 NEAR in Delayed & holds (market 1)', 'Sell NEAR in 1 world', /Sold; the dollars are in your wallet/, ticket)

    // Order book: an ask well above the pool from the NEAR held in world 1, then cancel it
    await v.page.goto(`/orders/?id=${ANCHOR}&w=1`)
    const pool = Number(await v.page.locator('.tr__quote b').textContent())
    expect(pool).toBeGreaterThan(0)
    const ask = (Math.ceil(pool * 2 * 10_000) / 10_000).toFixed(4)
    await v.page.locator('.tr__life select').selectOption({ label: '1 hour' })
    await v.page.getByLabel('sell price').fill(ask)
    await v.page.getByLabel('sell amount').fill('1')
    await expect(v.page.locator('.tk--sell .tk__line--muted').first()).toContainText('1.00 NEAR rests as your order')
    await tx(v, `ask 1 NEAR at ${ask} in market 1 world 1`, () => v.page.locator('.tk--sell button.btn').click(), new RegExp(`Your ask rests at ${ask.replace('.', '\\.')}`))
    const mine = v.page.locator('.tr__row6', { hasText: 'Sell' })
    await expect(mine.first()).toContainText('1.00 of 1.00 NEAR', { timeout: 60_000 })
    await tx(v, 'cancel the ask', () => mine.first().locator('button.ob__act').click(), /Order cancelled/)
    await expect(v.page.locator('.tr__row6', { hasText: 'Sell' })).toHaveCount(0, { timeout: 60_000 })
    expect(v.errors).toEqual([])
  } finally {
    // nothing of judge's keeps resting
    const left = (await view<OrderView[]>('orders_by_maker', { account_id: JUDGE, scenario_id: ANCHOR })).filter((o) => BigInt(o.remaining) > 0n)
    for (const o of left) {
      const r = (await patient(() => signer(JUDGE).signAndSendTransaction({ receiverId: CONTRACT, actions: [actions.functionCall('cancel_order', { order_id: o.id }, 30_000_000_000_000n, 1n)], waitUntil: 'FINAL' }))) as unknown as { transaction: { hash: string } }
      txs.push({ step: `cancel order ${o.id} (finally, direct)`, account: JUDGE, hash: r.transaction.hash, ok: true })
    }
    await v.close()
  }
})

test('staging: supply and withdraw, then borrow, see it in the portfolio, repay, and the at-risk list', async ({ browser }) => {
  const v = await visit(browser, JUDGE)
  try {
    // Lend in the Normal tier, then take it all back
    await v.page.goto(`/lend/?id=${ANCHOR}&tier=normal`)
    await connected(v.page, JUDGE)
    await expect(v.page.locator('.tierpick__tier[data-tier="normal"]')).toHaveAttribute('aria-pressed', 'true')
    await v.page.getByRole('button', { name: 'Supply', exact: true }).click()
    await v.page.getByLabel('USDC to supply').fill('20')
    await press(v, 'supply 20 USDC (market 1, Normal)', 'Supply 20.00 USDC', /Supplied; it earns from now/)
    await v.page.getByRole('button', { name: 'Withdraw', exact: true }).click()
    await v.page.getByLabel('USDC to withdraw').fill('all')
    await press(v, 'withdraw all (market 1, Normal)', 'Withdraw all', /Withdrawn to your wallet/)

    // Borrow in the Normal tier against real USDC posted as collateral
    await v.page.goto(`/borrow/?id=${ANCHOR}&tier=normal`)
    await expect(v.page.locator('.tierpick__tier[data-tier="normal"]')).toHaveAttribute('aria-pressed', 'true')
    await v.page.getByRole('button', { name: 'Add collateral', exact: true }).click()
    await v.page.locator('.pc__tabs[aria-label="Asset"] button', { hasText: 'USDC' }).click()
    await v.page.getByLabel('USDC to post').fill('200')
    await press(v, 'post 200 USDC collateral (Normal)', 'Post to Normal', /Collateral posted/)
    await v.page.getByRole('button', { name: 'Borrow', exact: true }).click()
    await v.page.getByLabel('USDC to borrow').fill('100')
    await press(v, 'borrow 100 USDC (Normal)', 'Borrow 100.00 USDC', /Borrowed; the USDC is in your wallet/)

    // the portfolio shows the futures, the loan and the wallet
    await v.page.goto('/portfolio/')
    await expect(v.page.locator('.fut .orng__dot')).toHaveCount(4, { timeout: 60_000 })
    await expect(v.page.locator('.pfl__tr', { hasText: 'Normal' })).toContainText(/100\.\d\d/, { timeout: 60_000 })
    await expect(v.page.locator('.pos__wrap').first()).toBeVisible()

    // at-risk loans: every tier's borrowers, judge among them
    await v.page.goto('/liquidate/?hf=all')
    await expect(v.page.locator('.ar__tr', { hasText: 'judge-ui1' }).first()).toBeVisible({ timeout: 60_000 })

    // repay all, take the collateral back
    await v.page.goto(`/borrow/?id=${ANCHOR}&tier=normal`)
    await v.page.getByRole('button', { name: 'Repay', exact: true }).click()
    await v.page.locator('.tk__pcts button', { hasText: 'All' }).click()
    await press(v, 'repay all (Normal)', 'Repay all', /Loan repaid/)
    const row = v.page.locator('.lc__tr').filter({ hasText: 'Real USDC' })
    await expect(row).toBeVisible({ timeout: 60_000 })
    await tx(v, 'take back the USDC collateral (Normal)', () => row.getByRole('button', { name: 'Take back' }).click(), /Collateral back in your wallet/)
    expect(v.errors).toEqual([])
  } finally {
    await v.close()
  }
})

type ProposalRow = { proposal_id: number; proposer: string; status: string; event_ids: number[] }

test('staging: propose a combination, pledge and withdraw (as far as the chain allows)', async ({ browser }, info) => {
  const v = await visit(browser, JUDGE)
  try {
    // a pair of open events that is not a market yet: SPICE (event 1) × NEAR transactions (event 6)
    const events = [1, 6]
    const check = await view<{ blocker: string | null; listed_market: number | null; live_proposal: number | null }>('market_check', { event_ids: events })
    await v.page.goto('/propose/')
    await connected(v.page, JUDGE)
    await v.page.getByRole('button', { name: /Combine events/ }).click()
    await v.page.getByRole('button', { name: 'Next: Events' }).click()
    for (const q of [/Will SPICE ship on NEAR mainnet/, /30 million transactions/]) await v.page.locator('.wiz__events button', { hasText: q }).click()
    await v.page.getByRole('button', { name: 'Next: Rules' }).click()
    await expect(v.page.locator('.mk__rule')).toHaveCount(2)
    await v.page.getByRole('button', { name: 'Next: Checks' }).click()
    const checks = v.page.locator('.wiz__checks')
    if (check.blocker) {
      // the contract refuses this combination today: the checks say why, in words, and nothing can be sent
      await expect(checks.locator('li:not(.is-ok)').first()).toBeVisible({ timeout: 30_000 })
      if (/ReferenceUnavailable/.test(check.blocker)) await expect(checks).toContainText('cannot price the opening yet', { timeout: 30_000 })
      info.annotations.push({ type: 'not sent', description: `propose ${events.join(' × ')}: the contract says ${check.blocker}` })
    } else if ((await nearBalance(JUDGE)) < (55n * NEAR) / 100n) {
      info.annotations.push({ type: 'not sent', description: 'propose: 0.2 NEAR of bond and reserve plus 0.3 NEAR of gas is more than judge-ui1 holds' })
    } else {
      await expect(checks.locator('li.is-ok')).toHaveCount(await checks.locator('li').count(), { timeout: 30_000 })
      await v.page.getByRole('button', { name: 'Next: Funding' }).click()
      const submit = v.page.getByRole('button', { name: /^Propose · [\d.]+ NEAR$/ })
      await expect(submit).toBeEnabled({ timeout: 30_000 })
      await tx(v, `propose ${events.join(' × ')}`, () => submit.click(), /Proposed/)
      await v.page.waitForURL(/\/proposal\/\?p=\d+/, { timeout: 60_000 })
      const p = Number(new URL(v.page.url()).searchParams.get('p'))
      try {
        const ticket = v.page.locator('.mk__ticket', { hasText: 'Pledge' }).first()
        await ticket.getByLabel('USDC to pledge').fill('10')
        await tx(v, `pledge 10 USDC to #${p}`, () => ticket.getByRole('button', { name: 'Pledge 10 USDC' }).click(), /Pledged/)
        const mine = v.page.locator('.mk__ticket', { hasText: 'Your pledge' })
        await tx(v, `withdraw the pledge to #${p}`, () => mine.getByRole('button', { name: 'Withdraw everything' }).click(), /Pledge withdrawn/)
      } finally {
        const yours = v.page.locator('.mk__ticket', { hasText: 'Your proposal' })
        await tx(v, `cancel #${p}`, () => yours.getByRole('button', { name: 'Cancel the proposal' }).click(), /Cancelled/)
        await press(v, `storage withdraw after #${p}`, /^Withdraw [\d.]+ NEAR$/, /Free NEAR is back/)
      }
    }

    // pledging needs a proposal collecting pledges; pledge 10 USDC to one from the board and take it back
    const live = (await view<{ proposals: ProposalRow[] }>('list_proposals', { from_id: null, limit: 50, filter: 'pledging' })).proposals
    await v.page.goto('/proposals/')
    await expect(v.page.locator('article.pp').first()).toBeVisible({ timeout: 60_000 })
    if (live.length === 0) {
      info.annotations.push({ type: 'not sent', description: 'pledge and withdraw: no proposal is collecting pledges on staging' })
    } else if ((await nearBalance(JUDGE)) < (33n * NEAR) / 100n) {
      // a pledge attaches 300 Tgas (the auto-open needs it), so the UI asks 0.31 NEAR free
      info.annotations.push({ type: 'not sent', description: 'pledge: 0.3 NEAR of gas bought up front is more than judge-ui1 holds' })
    } else {
      const card = v.page.locator('article.pp', { hasText: `#${live[0].proposal_id}` })
      await card.getByRole('button', { name: 'Pledge', exact: true }).click()
      await card.getByLabel('USDC to pledge').fill('10')
      await tx(v, `pledge 10 USDC to #${live[0].proposal_id} (board)`, () => card.getByRole('button', { name: 'Pledge 10 USDC' }).click(), /Pledged/)
      await expect(card.getByRole('button', { name: 'Withdraw pledge' })).toBeEnabled({ timeout: 60_000 })
      await tx(v, `withdraw the pledge to #${live[0].proposal_id} (board)`, () => card.getByRole('button', { name: 'Withdraw pledge' }).click(), /Pledge withdrawn/)
    }
    await v.page.goto('/decision-markets/')
    await expect(v.page.locator('.mk__title')).toHaveText('Decision markets')
    await expect(v.page.locator('main .num')).toHaveCount(0)
    expect(v.errors).toEqual([])
  } finally {
    await v.close()
  }
})

test('staging: resolve reads the chain; the owner pauses one flag and lifts it', async ({ browser }) => {
  const v = await visit(browser, JUDGE)
  try {
    await v.page.goto('/resolve/')
    await expect(v.page.locator('.rs').first()).toBeVisible({ timeout: 60_000 })
    await expect(v.page.locator('.feed__item').first()).toBeVisible({ timeout: 60_000 })
    // a visitor gets no owner console
    await v.page.goto('/admin/')
    await expect(v.page.locator('main')).toContainText(/read-only|owner/i, { timeout: 60_000 })
    expect(v.errors).toEqual([])
  } finally {
    await v.close()
  }

  const o = await visit(browser, ROOT)
  try {
    await o.page.goto('/admin/')
    await connected(o.page, ROOT)
    const flag = o.page.locator('.gv__flag', { hasText: 'proposals and pledges' }).locator('input')
    await flag.check()
    await o.page.getByLabel('Reason for the pause').fill('UI smoke test of the owner console; lifted at once')
    try {
      await tx(o, 'pause pledge (owner)', () => o.page.getByRole('button', { name: 'Pause pledge' }).click(), /Paused pledge/)
      await expect(o.page.locator('.gv__flag.is-paused')).toHaveCount(1, { timeout: 30_000 })
      await flag.check()
      await tx(o, 'unpause pledge (owner)', () => o.page.getByRole('button', { name: 'Unpause pledge' }).click(), /Running again/)
    } finally {
      const state = await view<{ paused: string[] }>('pause_state')
      if (state.paused.includes('pledge')) {
        const r = (await patient(() => signer(ROOT).signAndSendTransaction({ receiverId: CONTRACT, actions: [actions.functionCall('unpause', { flags: ['pledge'], liquidation_grace_sec: null }, 30_000_000_000_000n, 1n)], waitUntil: 'FINAL' }))) as unknown as { transaction: { hash: string } }
        txs.push({ step: 'unpause pledge (finally, direct)', account: ROOT, hash: r.transaction.hash, ok: true })
      }
    }
    await expect(o.page.locator('.gv__flag.is-paused')).toHaveCount(0, { timeout: 30_000 })
    expect((await view<{ paused: string[] }>('pause_state')).paused).toEqual([])
    expect(o.errors).toEqual([])
  } finally {
    await o.close()
  }
})

test('staging: a phone at 390×844, landing, markets, a market, borrow and portfolio', async ({ browser }) => {
  const v = await visit(browser, JUDGE, { phone: true })
  try {
    for (const path of ['/', '/markets/', `/market/?id=${ANCHOR}`, `/borrow/?id=${ANCHOR}&tier=normal`, '/portfolio/']) {
      await v.page.goto(path)
      await connected(v.page, JUDGE)
      await expect(v.page.locator('main')).not.toBeEmpty()
      await v.page.waitForTimeout(2_000)
      // nothing wider than the screen, and the header's controls inside it
      expect(await v.page.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(390)
      for (const sel of ['.topbar__mark', '.topbar__wallet', '.topbar__menu']) {
        const box = await v.page.locator(sel).boundingBox()
        expect(box, `${path} ${sel}`).not.toBeNull()
        expect(box!.x, `${path} ${sel}`).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width, `${path} ${sel}`).toBeLessThanOrEqual(390)
      }
      await v.page.screenshot({ path: `test-results/phone${path.replace(/[^a-z0-9]+/gi, '-')}.png`, fullPage: true })
    }
    // the menu opens the navbar, and Markets leads into the app
    await v.page.goto('/')
    await v.page.locator('.topbar__menu').click()
    await v.page.locator('.topbar__nav a', { hasText: 'Markets' }).click()
    await expect(v.page).toHaveURL(/\/markets\/$/)
    expect(v.errors).toEqual([])
  } finally {
    await v.close()
  }
})
