// The order book, the Split page and eight-world markets against staging, with real transactions signed by the trading
// track's two personas (ravi and uma) through the demo-wallet bridge. Never reports or finalizes an event, pauses
// nothing, and cancels in a `finally` any order it posted that is still resting.
//   pnpm build:staging && NEAR_KEYS_DIR=/path/to/.keys/staging STAGING=1 pnpm e2e:staging -g trading
import { expect, test, type Browser, type Page } from '@playwright/test'
import { actions } from 'near-api-js'
import { CONTRACT, demoWallet, patient, persona, signer, view, walletIdle, type Signed } from './staging/chain'

const RAVI = persona('ravi')
const UMA = persona('uma')
/** Market 1 (SPICE × Fed), world 1 (DELAYED·CUTS): both personas hold pieces there. */
const SID = 1
const W = 1

type OrderView = { id: string; mask: number; side: string; price: string; remaining: string }

async function open(browser: Browser, account: string, path: string): Promise<{ page: Page; log: Signed[] }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const log = await demoWallet(context, account)
  const page = await context.newPage()
  await page.goto(path)
  await expect(page.locator('.topbar__wallet')).toContainText(account.slice(0, 4))
  return { page, log }
}

const toast = (page: Page, text: RegExp) => expect(page.locator('.toast', { hasText: text }).first()).toBeVisible({ timeout: 180_000 })
const signed = (logs: Signed[][]) => logs.flat().map((s) => `${s.hash} ${s.tx.actions.map((a) => a.params.methodName).join('+')} ${s.ok ? 'ok' : `FAILED ${s.error}`}`)

test('trading: a resting ask, a crossing limit that rests the rest, cancel, market orders through the pool', async ({ browser }) => {
  const errors: string[] = []
  const logs: Signed[][] = []
  let askPrice: bigint | undefined
  try {
    // ravi rests an ask 2% above the pool, from the NEAR he holds in the world
    const ravi = await open(browser, RAVI, `/orders/?id=${SID}&w=${W}`)
    logs.push(ravi.log)
    ravi.page.on('pageerror', (e) => errors.push(e.message))
    const pool = await ravi.page.locator('.tr__quote b').textContent()
    askPrice = (BigInt(Math.round(Number(pool) * 10_000)) * 102n) / 100n * 10n ** 14n
    const askText = (Number(askPrice / 10n ** 14n) / 10_000).toFixed(4)
    await ravi.page.locator('.tr__life select').selectOption({ label: '1 hour' })
    await ravi.page.getByLabel('sell price').fill(askText)
    await ravi.page.getByLabel('sell amount').fill('2')
    await expect(ravi.page.locator('.tk--sell .tk__line--muted').first()).toContainText('2.00 NEAR rests as your order')
    await ravi.page.locator('.tk--sell button.btn').click()
    await toast(ravi.page, new RegExp(`Your ask rests at ${askText.replace('.', '\\.')}`))
    await walletIdle()

    // uma clicks that level, which prices her buy, and buys 3: 2 fill now, 1 rests as her bid, in one transaction
    const uma = await open(browser, UMA, `/orders/?id=${SID}&w=${W}`)
    logs.push(uma.log)
    uma.page.on('pageerror', (e) => errors.push(e.message))
    await uma.page.locator('.tr__bookctl select').nth(1).selectOption({ label: '0.0001' })
    const level = uma.page.locator('.obx__side--ask .obx__row', { hasText: askText }).first()
    await level.click()
    await expect(uma.page.getByLabel('buy price')).toHaveValue(askText)
    await uma.page.getByLabel('buy amount').fill('3')
    await expect(uma.page.locator('.tk--buy .tk__line--muted').first()).toContainText('Fills 2.00 NEAR now')
    await uma.page.locator('.tk--buy button.btn').click()
    await toast(uma.page, /Filled 2\.00 NEAR; the rest rests at/)
    await walletIdle()
    expect(uma.log.at(-1)?.tx.actions.map((a) => a.params.methodName)).toEqual(['fill_order', 'post_order'])

    // her open orders list the resting bid; cancel gives the escrow back
    const mine = uma.page.locator('.tr__row6', { hasText: 'Buy' })
    await expect(mine.first()).toContainText('1.00 of 1.00 NEAR')
    await mine.first().locator('button.ob__act').click()
    await toast(uma.page, /Order cancelled/)
    await walletIdle()

    // market orders: through the pool (and any bid that beats it), each one transaction
    await uma.page.locator('.tr__formhead .pc__tabs button', { hasText: 'Market' }).click()
    await uma.page.getByLabel('buy amount').fill('0.5')
    await expect(uma.page.locator('.tk--buy .tk__line--muted').first()).toContainText('The pool part must give at least')
    await uma.page.locator('.tk--buy button.btn').click()
    await toast(uma.page, /Bought 0\.50 NEAR/)
    await walletIdle()
    await uma.page.getByLabel('sell amount').fill('0.5')
    await uma.page.locator('.tk--sell button.btn').click()
    await toast(uma.page, /Sold 0\.50 NEAR/)
    await walletIdle()
    expect(uma.log.at(-1)?.tx.actions.map((a) => a.params.methodName)).toContain('swap')
  } finally {
    // nothing this test posted keeps resting: ravi's ask (if uma did not take it all) and any bid of uma's
    for (const who of [RAVI, UMA]) {
      const left = (await view<OrderView[]>('orders_by_maker', { account_id: who, scenario_id: SID })).filter(
        (o) => o.mask === 1 << W && BigInt(o.remaining) > 0n && (who === UMA ? o.side === 'bid' : BigInt(o.price) === askPrice),
      )
      for (const o of left) {
        await patient(() => signer(who).signAndSendTransaction({ receiverId: CONTRACT, actions: [actions.functionCall('cancel_order', { order_id: o.id }, 30_000_000_000_000n, 1n)], waitUntil: 'FINAL' }))
      }
    }
    console.log(['signed:', ...signed(logs)].join('\n  '))
  }
  expect(logs.flat().every((s) => s.ok)).toBe(true)
  expect(errors).toEqual([])
})

test('trading: split one wNEAR into every world of a market, then merge it back', async ({ browser }) => {
  const uma = await open(browser, UMA, `/split/?id=${SID}`)
  try {
    await expect(uma.page.locator('.sp__tr').nth(1)).toBeVisible()
    await uma.page.getByLabel('wNEAR to split').fill('1')
    await uma.page.locator('.mk__ticket button.btn').click()
    await toast(uma.page, /Split into 4 worlds/)
    await walletIdle()
    await uma.page.locator('.mk__ticket .pc__tabs button', { hasText: 'Merge' }).click()
    await expect(uma.page).toHaveURL(/mode=merge/)
    await uma.page.getByLabel('wNEAR to merge').fill('1')
    await uma.page.locator('.mk__ticket button.btn').click()
    await toast(uma.page, /Merged back into real wNEAR/)
    await walletIdle()
  } finally {
    console.log(['signed:', ...signed([uma.log])].join('\n  '))
  }
  expect(uma.log.map((s) => s.tx.actions[0].params.methodName)).toEqual(['ft_transfer_call', 'merge'])
  expect(uma.log.every((s) => s.ok)).toBe(true)
})

test('trading: eight-world and two-world books read the chain (read-only)', async ({ browser }) => {
  const uma = await open(browser, UMA, '/orders/?id=8&w=5')
  const errors: string[] = []
  uma.page.on('pageerror', (e) => errors.push(e.message))
  const market = await view<{ world_count: number; possible: number }>('get_market', { scenario_id: 8 })
  expect(market.world_count).toBe(8)
  await expect(uma.page.locator('.tr__world')).toHaveText(/ & .* & /)
  await expect(uma.page.locator('.tr__chip[aria-pressed="true"]')).toHaveCount(1)
  await uma.page.locator('.tr__bottom .pc__tabs button', { hasText: 'Holdings' }).click()
  await expect(uma.page.locator('.tr__hold')).toHaveCount(8)
  // the strip leads to a two-world market's book
  await uma.page.locator('.tr__find').fill('Yes')
  await uma.page.locator('.tr__chip b', { hasText: /^Yes$/ }).first().click()
  await expect(uma.page).toHaveURL(/id=\d+&w=\d/)
  await expect(uma.page.locator('.tr__hold')).toHaveCount(2)
  expect(uma.log).toEqual([])
  expect(errors).toEqual([])
})
