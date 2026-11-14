// Propose, proposals, resolve and admin against staging, through the UI with real transactions (track UI-D). Personas:
// leo proposes, judge-smoke1 pledges, the owner reviews and pauses. Every proposal it makes is rejected or cancelled
// before the test ends, every pause is lifted (in a finally), and no event is ever reported or finalized.
//   pnpm build:staging && NEAR_KEYS_DIR=/path/to/.keys/staging STAGING=1 pnpm e2e:staging -g governance
import { writeFileSync } from 'node:fs'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { actions } from 'near-api-js'
import { CONTRACT, demoWallet, patient, persona, signer, view, type Signed } from './staging/chain'

const BASE = process.env.BASE_URL || 'http://localhost:3045'
const LEO = persona('leo')
const JUDGE = `judge-smoke1.${persona('owner')}`
const OWNER = persona('owner')
const log: { step: string; account: string; hash: string; ok: boolean; error?: string }[] = []
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')

type ProposalRow = { proposal_id: number; proposer: string; status: string; new_event: { question: string } | null; pledgers: number }
/** Leo's test proposals still live (a re-run picks up where an interrupted one stopped). */
async function leosLive(status: string): Promise<number | undefined> {
  const list = await view<{ proposals: ProposalRow[] }>('list_proposals', { from_id: null, limit: 50, filter: 'live' })
  return list.proposals.find((p) => p.proposer === LEO && p.status === status && /^UI test /.test(p.new_event?.question ?? ''))?.proposal_id
}

test.describe.configure({ mode: 'serial', timeout: 900_000 })
test.afterAll(() => {
  writeFileSync('test-results/governance-txs.json', JSON.stringify(log, null, 1))
  console.log('TXS', JSON.stringify(log, null, 1))
})

async function open(browser: Browser, account: string) {
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const signed: Signed[] = []
  await demoWallet(context, account, signed)
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  return { page, signed, errors, close: () => context.close() }
}

/** Clicks, then waits for the action's toast to end: done (with `done` in it) or failed (which fails the step). */
async function tx(page: Page, signed: Signed[], account: string, step: string, click: () => Promise<void>, done: RegExp) {
  const before = signed.length
  await click()
  const ok = page.locator('.toast.is-done', { hasText: done })
  const failed = page.locator('.toast.is-failed')
  await expect(ok.or(failed).first()).toBeVisible({ timeout: 120_000 })
  for (const s of signed.slice(before)) log.push({ step, account, hash: s.hash, ok: s.ok, error: s.error })
  if (await failed.count()) throw new Error(`${step}: ${await failed.first().innerText()}`)
}

async function connected(page: Page, account: string) {
  await expect(page.locator('.topbar__wallet')).toContainText(account.slice(0, 8), { timeout: 60_000 })
}

/** Leo writes a new event through the five steps and lands on its page; returns the proposal id. */
async function proposeEvent(page: Page, signed: Signed[], question: string): Promise<number> {
  await page.goto('/propose/')
  await connected(page, LEO)
  await page.getByRole('button', { name: /A new event/ }).click()
  await page.getByRole('button', { name: 'Next: Question' }).click()
  await page.locator('.create__field', { hasText: 'Question' }).locator('input').fill(question)
  await page.getByRole('button', { name: 'Next: Rule and source' }).click()
  await page.locator('textarea').fill('YES if the staging proposal this question belongs to is rejected or cancelled on app.ifverse-staging.testnet before the deadline, as shown by list_proposals; otherwise NO. A UI test question.')
  await page.locator('.create__field', { hasText: 'Public data source' }).locator('input').fill('https://testnet.nearblocks.io/address/app.ifverse-staging.testnet')
  const deadline = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 11) + '12:00'
  await page.locator('input[type="datetime-local"]').fill(deadline)
  await page.getByRole('button', { name: 'Next: Checks' }).click()
  await page.locator('.wiz__confirm input').check()
  await expect(page.locator('.wiz__checks li.is-ok')).toHaveCount(7, { timeout: 30_000 })
  await page.getByRole('button', { name: 'Next: Funding' }).click()
  await expect(page.locator('.tk__line', { hasText: 'Pledge goal' })).toBeVisible({ timeout: 30_000 })
  const submit = page.getByRole('button', { name: /^Propose · [\d.]+ NEAR$/ })
  await expect(submit).toBeEnabled({ timeout: 30_000 })
  await tx(page, signed, LEO, `propose "${question}"`, () => submit.click(), /Proposed/)
  await page.waitForURL(/\/proposal\/\?p=\d+/, { timeout: 60_000 })
  return Number(new URL(page.url()).searchParams.get('p'))
}

async function freeNear(page: Page, signed: Signed[], step: string) {
  const w = page.getByRole('button', { name: /^Withdraw [\d.]+ NEAR$/ })
  await expect(w).toBeEnabled({ timeout: 60_000 })
  await tx(page, signed, LEO, step, () => w.click(), /Free NEAR is back/)
}

test('governance: a new event, a pledge while in review, the owner rejects it', async ({ browser }) => {
  const leo = await open(browser, LEO)
  const judge = await open(browser, JUDGE)
  const owner = await open(browser, OWNER)
  try {
    const a = (await leosLive('review')) ?? (await proposeEvent(leo.page, leo.signed, `UI test ${stamp}: is this staging proposal rejected?`))
    await leo.page.goto(`/proposal/?p=${a}`)
    await expect(leo.page.locator('.tr__stats')).toContainText('In review', { timeout: 30_000 })

    await judge.page.goto(`/proposal/?p=${a}`)
    await connected(judge.page, JUDGE)
    const ticket = judge.page.locator('.mk__ticket', { hasText: 'Pledge' }).first()
    await ticket.getByLabel('USDC to pledge').fill('10')
    await tx(judge.page, judge.signed, JUDGE, `pledge 10 USDC to #${a}`, () => ticket.getByRole('button', { name: 'Pledge 10 USDC' }).click(), /Pledged/)
    // by its heading: hasText is case-insensitive, and the Pledge ticket's note says "seed shares worth your pledge"
    const mine = judge.page.locator('.mk__ticket', { has: judge.page.getByRole('heading', { name: 'Your pledge', exact: true }) })
    await expect(mine).toContainText('10.00 USDC', { timeout: 30_000 })
    await tx(judge.page, judge.signed, JUDGE, `withdraw pledge #${a}`, () => mine.getByRole('button', { name: 'Withdraw everything' }).click(), /Pledge withdrawn/)

    await owner.page.goto('/admin/')
    await connected(owner.page, OWNER)
    const row = owner.page.locator('.gv__review', { hasText: `#${a} ` })
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.getByRole('button', { name: 'Review' }).click()
    // the three checks; the fourth box (keep the bond as spam) stays unticked, so the bond goes back
    for (let i = 0; i < 3; i++) await row.locator('.gv__owner .wiz__confirm input').nth(i).check()
    await tx(owner.page, owner.signed, OWNER, `reject #${a}`, () => row.getByRole('button', { name: 'Reject', exact: true }).click(), /Rejected/)

    await leo.page.goto(`/proposal/?p=${a}`)
    await expect(leo.page.locator('.tr__stats')).toContainText('Rejected', { timeout: 30_000 })
    await freeNear(leo.page, leo.signed, `storage withdraw after #${a}`)
    expect([...leo.errors, ...judge.errors, ...owner.errors]).toEqual([])
  } finally {
    await Promise.all([leo.close(), judge.close(), owner.close()])
  }
})

test('governance: the owner approves on the page, a pledge from the board, the proposer cancels', async ({ browser }) => {
  const leo = await open(browser, LEO)
  const judge = await open(browser, JUDGE)
  const owner = await open(browser, OWNER)
  try {
    let b = await leosLive('pledging')
    if (b === undefined) {
      b = (await leosLive('review')) ?? (await proposeEvent(leo.page, leo.signed, `UI test ${stamp}: is this staging proposal cancelled?`))
      await owner.page.goto(`/proposal/?p=${b}`)
      await connected(owner.page, OWNER)
      const check = owner.page.locator('.mk__ticket', { hasText: 'Owner check' })
      await expect(check).toBeVisible({ timeout: 30_000 })
      const boxes = check.locator('.wiz__confirm input')
      for (let i = 0; i < 3; i++) await boxes.nth(i).check()
      await tx(owner.page, owner.signed, OWNER, `approve #${b}`, () => check.getByRole('button', { name: 'Approve', exact: true }).click(), /Approved/)
    }

    await judge.page.goto('/proposals/')
    await connected(judge.page, JUDGE)
    const card = judge.page.locator('article.pp', { hasText: `#${b}` })
    await expect(card).toContainText('Collecting pledges', { timeout: 30_000 })
    // (a re-run after an interrupted one finds the pledge already there)
    if (!(await card.locator('.tk__line', { hasText: 'Your pledge' }).count())) {
      await card.getByRole('button', { name: 'Pledge', exact: true }).click()
      await card.getByLabel('USDC to pledge').fill('10')
      await tx(judge.page, judge.signed, JUDGE, `pledge 10 USDC to #${b} (board)`, () => card.getByRole('button', { name: 'Pledge 10 USDC' }).click(), /Pledged/)
    }
    await expect(card.getByRole('button', { name: 'Withdraw pledge' })).toBeEnabled({ timeout: 30_000 })
    await tx(judge.page, judge.signed, JUDGE, `withdraw pledge #${b} (board)`, () => card.getByRole('button', { name: 'Withdraw pledge' }).click(), /Pledge withdrawn/)

    await leo.page.goto(`/proposal/?p=${b}`)
    await connected(leo.page, LEO)
    const yours = leo.page.locator('.mk__ticket', { hasText: 'Your proposal' })
    await expect(yours.getByRole('button', { name: 'Cancel the proposal' })).toBeEnabled({ timeout: 60_000 })
    await tx(leo.page, leo.signed, LEO, `cancel #${b}`, () => yours.getByRole('button', { name: 'Cancel the proposal' }).click(), /Cancelled/)
    await freeNear(leo.page, leo.signed, `storage withdraw after #${b}`)
    expect([...leo.errors, ...judge.errors, ...owner.errors]).toEqual([])
  } finally {
    await Promise.all([leo.close(), judge.close(), owner.close()])
  }
})

test('governance: the owner pauses proposals and pledges with a reason, then lifts it', async ({ browser }) => {
  const owner = await open(browser, OWNER)
  try {
    await owner.page.goto('/admin/')
    await connected(owner.page, OWNER)
    const flag = owner.page.locator('.gv__flag', { hasText: 'proposals and pledges' }).locator('input')
    await flag.check()
    await owner.page.getByLabel('Reason for the pause').fill('UI test of the owner console; lifted at once')
    try {
      await tx(owner.page, owner.signed, OWNER, 'pause pledge', () => owner.page.getByRole('button', { name: 'Pause pledge' }).click(), /Paused pledge/)
      await expect(owner.page.locator('.gv__flag.is-paused')).toHaveCount(1, { timeout: 30_000 })
      await flag.check()
      await tx(owner.page, owner.signed, OWNER, 'unpause pledge', () => owner.page.getByRole('button', { name: 'Unpause pledge' }).click(), /Running again/)
    } finally {
      const state = await view<{ paused: string[] }>('pause_state')
      if (state.paused.includes('pledge')) {
        const r = (await patient(() => signer(OWNER).signAndSendTransaction({ receiverId: CONTRACT, actions: [actions.functionCall('unpause', { flags: ['pledge'], liquidation_grace_sec: null }, 30_000_000_000_000n, 1n)], waitUntil: 'FINAL' }))) as unknown as { transaction: { hash: string } }
        log.push({ step: 'unpause pledge (finally, direct)', account: OWNER, hash: r.transaction.hash, ok: true })
      }
    }
    await expect(owner.page.locator('.gv__flag.is-paused')).toHaveCount(0, { timeout: 30_000 })
    expect(owner.errors).toEqual([])
  } finally {
    await owner.close()
  }
})

test('governance: an existing combination, resolve and the roadmap page, read-only', async ({ browser }) => {
  const judge = await open(browser, JUDGE)
  try {
    await judge.page.goto('/propose/?kind=market&events=1,2')
    await connected(judge.page, JUDGE)
    await judge.page.getByRole('button', { name: 'Next: Rules' }).click()
    await judge.page.getByRole('button', { name: 'Next: Checks' }).click()
    await expect(judge.page.locator('.wiz__checks')).toContainText('Market #1 is this combination', { timeout: 30_000 })
    await judge.page.goto('/resolve/')
    await expect(judge.page.locator('.rs').first()).toBeVisible({ timeout: 60_000 })
    await expect(judge.page.locator('.feed__item').first()).toBeVisible()
    await expect(judge.page.getByRole('button', { name: 'Finalize' })).toHaveCount(0)
    await judge.page.goto('/decision-markets/')
    await expect(judge.page.locator('.mk__title')).toHaveText('Decision markets')
    await expect(judge.page.locator('main .num')).toHaveCount(0)
    expect(judge.errors).toEqual([])
  } finally {
    await judge.close()
  }
})
