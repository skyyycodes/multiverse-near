// Borrow, Lend, At-risk loans and Portfolio against staging, with real transactions signed by the lending track's
// personas through the demo-wallet bridge (bob lends, carl borrows, sam sells into collateral and borrows). Small
// amounts that leave each position about where it was; no event is reported or finalized, nothing is paused.
//   pnpm build:staging && NEAR_KEYS_DIR=/path/to/.keys/staging STAGING=1 pnpm e2e:staging -g lending
import { expect, test, type Page } from '@playwright/test'
import { demoWallet, persona, type Signed } from './staging/chain'

const MARKET = 1

/** Press a transaction button and wait for its toast to say it is done (a failed toast fails the step). */
async function act(page: Page, button: string | RegExp, done: string) {
  const b = page.getByRole('button', { name: button })
  await expect(b).toBeEnabled({ timeout: 60_000 })
  await b.click()
  const toast = page.locator('.toast').filter({ hasText: done }).last()
  const failed = page.locator('.toast.is-failed').last()
  await expect(toast.or(failed)).toBeVisible({ timeout: 180_000 })
  if (await failed.isVisible()) throw new Error(`failed: ${await failed.innerText()}`)
  await expect(toast).toHaveClass(/is-done/)
}

function report(who: string, log: Signed[]) {
  for (const s of log) console.log(`${who} ${s.ok ? 'ok' : 'FAILED'} ${s.tx.receiverId} ${s.tx.actions.map((a) => a.params.methodName).join('+')} ${s.hash}${s.error ? ` ${s.error}` : ''}`)
  expect(log.every((s) => s.ok)).toBe(true)
}

test.describe('lending', () => {
  test('lend: withdraw, supply and insure in the Safe tier (bob)', async ({ page, context }) => {
    const log = await demoWallet(context, persona('bob'))
    await page.goto(`/lend/?id=${MARKET}&tier=safe`)
    await expect(page.locator('.tierpick__tier[data-tier="safe"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.tr__quote b')).toHaveText(/\d+\.\d\d%/)
    await expect(page.locator('.alloc__row').first()).toBeVisible()

    await page.getByRole('button', { name: 'Withdraw', exact: true }).click()
    await page.getByLabel('USDC to withdraw').fill('30')
    await act(page, 'Withdraw 30.00 USDC', 'Withdrawn to your wallet')

    await page.getByRole('button', { name: 'Supply', exact: true }).click()
    await page.getByLabel('USDC to supply').fill('20')
    await act(page, 'Supply 20.00 USDC', 'Supplied; it earns from now')

    await page.getByRole('button', { name: 'Insure', exact: true }).click()
    await page.getByLabel('USDC to donate').fill('1')
    await act(page, 'Donate to Safe insurance', 'Added to the insurance fund')
    report('bob', log)
  })

  test('borrow: repay, borrow, post and take back collateral in the Bold tier (carl)', async ({ page, context }) => {
    const log = await demoWallet(context, persona('carl'))
    await page.goto(`/borrow/?id=${MARKET}&tier=bold`)
    await expect(page.locator('.tierpick__tier[data-tier="bold"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.lq__row').nth(1)).toBeVisible()
    await expect(page.locator('.lq__row.is-binding')).toHaveCount(1)

    await page.getByRole('button', { name: 'Repay', exact: true }).click()
    await page.getByLabel('USDC to repay').fill('25')
    await act(page, 'Repay 25.00 USDC', 'Repaid')

    await page.getByRole('button', { name: 'Borrow', exact: true }).click()
    await page.getByLabel('USDC to borrow').fill('25')
    await expect(page.locator('.ov')).toContainText('First liquidation')
    await act(page, 'Borrow 25.00 USDC', 'Borrowed; the USDC is in your wallet')

    await page.getByRole('button', { name: 'Add collateral', exact: true }).click()
    await page.getByLabel('USDC to post').fill('5')
    await act(page, 'Post to Bold', 'Collateral posted')

    const row = page.locator('.lc__tr').filter({ hasText: 'Real USDC' })
    await expect(row).toBeVisible({ timeout: 60_000 })
    await row.getByRole('button', { name: 'Take back' }).click()
    await expect(page.locator('.toast').filter({ hasText: 'Collateral back in your wallet' }).last()).toHaveClass(/is-done/, { timeout: 180_000 })
    report('carl', log)
  })

  test('sell and borrow: sell NEAR in one world into Safe collateral, then borrow (sam)', async ({ page, context }) => {
    const log = await demoWallet(context, persona('sam'))
    await page.goto(`/borrow/?id=${MARKET}&tier=safe`)
    await expect(page.locator('.tierpick__tier[data-tier="safe"]')).toHaveAttribute('aria-pressed', 'true')
    const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Sell NEAR into collateral' }) })
    await panel.locator('.sellc__world').filter({ hasText: 'Delayed & holds' }).click()
    await panel.getByLabel('NEAR to split and sell').fill('5')
    await expect(panel.locator('.sellc__world[aria-pressed="true"]')).toContainText('USDC', { timeout: 60_000 })
    await act(page, 'Sell in 1 world, keep as collateral', 'Sold; the dollars are loan collateral')

    await page.getByLabel('USDC to borrow').fill('10')
    await act(page, 'Borrow 10.00 USDC', 'Borrowed; the USDC is in your wallet')
    report('sam', log)
  })

  test('at-risk loans and portfolio read the chain (sam, nothing signed)', async ({ page, context }) => {
    const log = await demoWallet(context, persona('sam'))
    await page.goto('/liquidate/?hf=all')
    const carl = page.locator('.ar__tr').filter({ hasText: 'carl.' })
    await expect(carl).toBeVisible({ timeout: 60_000 })
    await carl.getByRole('button', { name: /Quote|Liquidate/ }).click()
    await expect(page.locator('.mk__side .mk__ticket')).toContainText('The contract’s quote')
    await expect(page.locator('.mk__side .mk__ticket .btn')).toHaveText(/Not liquidatable|Liquidate for cash/, { timeout: 60_000 })

    await page.goto('/portfolio/')
    await expect(page.locator('.fut .orng__dot')).toHaveCount(4, { timeout: 60_000 })
    await expect(page.locator('.fw')).toHaveCount(4)
    await expect(page.locator('.pfl__tr').filter({ hasText: 'Safe' })).toBeVisible()
    await page.getByRole('button', { name: '−25%' }).click()
    await expect(page.locator('.orng__note')).toContainText('On average')
    expect(log).toEqual([])
  })
})
