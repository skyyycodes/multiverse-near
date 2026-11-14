// The markets track against staging: the landing, the board, market pages for 2, 4 and 8 worlds, a settled market and
// How it works, each checked against the contract's own views; then one real flow, redeeming a settled market's piece.
//   pnpm build:staging && NEAR_KEYS_DIR=/path/to/.keys/staging STAGING=1 BASE_URL=http://localhost:5191 pnpm e2e:staging -g markets
// Signs only as alice (this track's persona). The redeem flow first splits 1 USDC into the settled market 3, so alice
// holds a piece of its surviving world; it reports nothing and finalizes nothing.
import { expect, test } from '@playwright/test'
import { actions } from 'near-api-js'
import { CONTRACT, deployment, demoWallet, patient, persona, signer, view, walletIdle, type Signed } from './staging/chain'

type Card = { scenario_id: number; status: string; created_at_sec: number; world_count: number; event_ids: number[]; odds: string[]; possible: number }
const pctText = (odds: string) => {
  const c = Number(BigInt(odds) / 10n ** 12n) / 1e6
  return !(c > 0) ? '0%' : c < 0.005 ? '<1%' : `${Math.round(c * 100)}%`
}

test('markets: the landing, the board, market pages and the docs read the chain', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await demoWallet(context, persona('alice'))
  const list = (await view<{ markets: Card[] }>('list_markets', { from_id: null, limit: 12, listed_only: true })).markets
  const open = list.filter((m) => m.status !== 'resolved')

  // landing: the open markets table, one row per open market, and the anchor's worlds in the story
  await page.goto('/')
  await expect(page.locator('.mtable__row:not(.mtable__row--head)')).toHaveCount(open.length)
  await expect(page.locator('.ring-tag').first()).toContainText(/chance, NEAR at \$\d/)
  await expect(page.locator('.sheets__read b').first()).toHaveText(/^\$[\d,]+$/)
  const borrow = page.locator('.faq__item', { hasText: 'How much can I borrow?' })
  await borrow.locator('.faq__q').click()
  await expect(borrow.locator('.faq__a')).toContainText(/Safe, \d+% in Normal/)

  // the board: one card per listed market, the anchor featured with its map, search and sort
  await page.goto('/markets/')
  await expect(page.locator('.mk-card')).toHaveCount(list.length)
  await expect(page.locator('.feat .xgrid__cell')).toHaveCount(4)
  await page.locator('.tr__find').fill('#8')
  await expect(page.locator('.mk-card')).toHaveCount(1)
  await expect(page.locator('.mk-card')).toContainText('and 4 more worlds')
  await page.locator('.tr__find').fill('')
  await page.locator('.mk-sort select').selectOption('new')
  const newest = [...open].sort((a, b) => b.created_at_sec - a.created_at_sec || b.scenario_id - a.scenario_id)[0]
  await expect(page.locator('.mk-cardwrap').first().locator('a')).toHaveAttribute('href', `/market/?id=${newest.scenario_id}`)

  // the anchor: four rows with the contract's chances, the map, a world's book, a pick, alice's loan, the checks
  const anchor = list.find((m) => m.scenario_id === 1)!
  await page.goto('/market/?id=1')
  await expect(page.locator('.mk__row')).toHaveCount(4)
  for (let w = 0; w < 4; w++) await expect(page.locator('.mk__row').nth(w).locator('.mk__chance b')).toHaveText(pctText(anchor.odds[w]))
  await expect(page.locator('.mk__map .xgrid__cell')).toHaveCount(4)
  await page.locator('.mk__chev').first().click()
  await expect(page.locator('.mk__book')).toContainText(/pool \$\d/)
  await page.locator('.mk__shape button', { hasText: 'Delayed' }).click()
  await expect(page.locator('.mk__shape')).toContainText('every “Delayed” world')
  await expect(page.locator('.mk__ticket .pc__tabs[aria-label="Action"] button[aria-pressed="true"]')).toHaveText('Hedge')
  await expect(page.locator('.mk__pos')).toContainText(/Safe|Normal|Bold/)
  await page.locator('.mk__lowertabs button', { hasText: 'Checks' }).click()
  await expect(page.locator('.sc__checks')).toContainText('Every world balances')
  await expect(page.locator('.mk__pc')).toContainText('Outside NEAR/USD')

  // eight worlds, and a settled market
  await page.goto('/market/?id=8')
  await expect(page.locator('.mk__row')).toHaveCount(8)
  await expect(page.locator('.mk__map .xgrid__cell')).toHaveCount(8)
  await expect(page.locator('.mk__ticket .pc__tabs')).not.toContainText('Borrow') // trading only
  await page.goto('/market/?id=2')
  await expect(page.locator('.rs__state--final')).toContainText('Final: Holds, by OutLayer')

  // how it works: the tiers from lending_tiers, two live loans
  await page.goto('/docs/')
  await expect(page.locator('.docs__table--tiers .docs__tr:not(.docs__tr--head)')).toHaveCount(3)
  await expect(page.locator('.docs__table--tiers')).toContainText('60%')
  await expect(page.locator('.docs__compare figcaption').first()).toContainText(/health \d\.\d\d/)
  expect(errors).toEqual([])
})

test('markets: redeem a settled market’s piece from the market page', async ({ page, context }) => {
  const alice = persona('alice')
  const log: Signed[] = await demoWallet(context, alice)
  const mid = 3 // settled: only world 0 (YES) is left

  // setup: a piece of the surviving world to redeem (1 USDC split into it), unless alice already holds one
  const before = await view<{ scenario: { possible: number; worlds: { mask: number; user_usdc: string }[] } }>('borrow_view', { scenario_id: mid, account_id: alice })
  const left = before.scenario.worlds.find((w) => w.mask === before.scenario.possible)!
  if (BigInt(left.user_usdc) === 0n) {
    const r = await patient(() =>
      signer(alice).signAndSendTransaction({
        receiverId: deployment.usdc,
        actions: [actions.functionCall('ft_transfer_call', { receiver_id: CONTRACT, amount: '1000000', memo: null, msg: JSON.stringify({ action: 'split', scenario_id: mid, to_masks: [left.mask] }) }, 300_000_000_000_000n, 1n)],
        waitUntil: 'FINAL',
      }),
    )
    console.log(`setup split: ${(r as unknown as { transaction: { hash: string } }).transaction.hash}`)
  }

  await page.goto(`/market/?id=${mid}`)
  const row = page.locator('.mk__redeemrow').first()
  await expect(row).toContainText('USDC-if-YES')
  await row.locator('button').click()
  await expect(page.locator('.toast').filter({ hasText: 'Redeemed for real USDC' })).toBeVisible({ timeout: 120_000 })
  await walletIdle()
  const sent = log.filter((s) => s.tx.actions.some((a) => a.params.methodName === 'redeem'))
  expect(sent.length).toBe(1)
  expect(sent[0].ok).toBe(true)
  console.log(`redeem: ${sent[0].hash}`)
  await expect(page.locator('.mk__redeem')).toContainText('Nothing of yours to redeem here.', { timeout: 60_000 })
})
