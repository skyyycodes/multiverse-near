// The shell against staging, read-only: the landing and the board load without errors, the header's world grid and
// the wallet menu show a persona's real holdings, and search finds the contract's markets. Signs nothing.
//   pnpm build:staging && NEAR_KEYS_DIR=/path/to/.keys/staging STAGING=1 pnpm e2e:staging -g shell
import { expect, test } from '@playwright/test'
import { demoWallet, persona } from './staging/chain'

test('shell: landing, wallet menu, your worlds and search on staging', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const alice = persona('alice')
  await demoWallet(context, alice)

  await page.goto('/')
  await expect(page).toHaveTitle('Origami Verse')
  await expect(page.locator('.topbar__mark')).toHaveText('Origami Verse')

  // the wallet connects through the bridge; the button shows the account
  const wallet = page.locator('.topbar__wallet')
  await expect(wallet).toContainText(alice.slice(0, 8))

  // the anchor market's grid: four worlds, laid out as the market's grid
  await expect(page.locator('.topbar__grid i')).toHaveCount(4)
  await expect(page.locator('.topbar__count')).toHaveText(/\d\/4/)

  // the menu: real balances and the links
  await wallet.click()
  const panel = page.locator('.wm__panel')
  await expect(panel.locator('.wm__bal b').first()).not.toHaveText('–')
  await expect(panel.locator('.wm__links')).toContainText('Portfolio')
  await expect(panel.locator('.wm__links')).toContainText(/lowest health \d\.\d\d|none/)
  await page.keyboard.press('Escape')

  // search over the contract's markets
  await page.keyboard.press('Control+k')
  await page.locator('.cmdk__input').fill('Fed')
  await expect(page.locator('.cmdk__item').first()).toContainText(/Fed/)
  await page.locator('.cmdk__input').fill('#1')
  await expect(page.locator('.cmdk__item').first()).toContainText('SPICE')
  await page.keyboard.press('Escape')

  // every route renders inside the shell
  for (const path of ['/markets/', '/market/?id=1', '/portfolio/', '/borrow/', '/lend/', '/orders/', '/propose/', '/resolve/', '/docs/', '/split/?id=1', '/liquidate/', '/proposal/?p=1', '/proposals/', '/admin/']) {
    await page.goto(path)
    await expect(page.locator('.topbar')).toBeVisible()
    await expect(page.locator('main')).not.toBeEmpty()
  }
  expect(errors).toEqual([])
})
