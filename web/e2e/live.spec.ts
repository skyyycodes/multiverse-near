// The acceptance flow against a freshly seeded local sandbox node, signed with the personas' test keys through the
// demo wallet. Each step checks the screen against the contract's own views, and every screen is captured on a
// desktop and a phone. Run with `pnpm e2e:live` after `pnpm build:live` (see README).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { chainNowSec, demoWallet, fastForwardTo, fund, persona, price4, ratio, report, usd, view } from "./live/chain";

test.describe.configure({ mode: "serial" });

const SHOTS = process.env.SHOTS_DIR || join(__dirname, "..", "test-results", "live-shots");
mkdirSync(SHOTS, { recursive: true });

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const S = 1;

type Snap = { scenario: { worlds: { label: string; wnear_price: string }[] }; account: Record<string, unknown> };
type World = { label: string; user_wnear: string; user_usdc: string; collateral_wnear: string; collateral_usdc: string; wnear_price: string };

async function as(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext({ viewport: DESKTOP, reducedMotion: "reduce" });
  await demoWallet(context, persona(name));
  const page = await context.newPage();
  return page;
}

/** The current screen at 1440 × 900, then at 390 × 844 (optionally another route there), then back. */
async function shoot(page: Page, name: string, phoneRoute?: string, phonePrep?: (p: Page) => Promise<void>) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}-1440.png`), fullPage: true });
  const back = page.url();
  await page.setViewportSize(PHONE);
  if (phoneRoute) await page.goto(phoneRoute);
  if (phonePrep) await phonePrep(page);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, `${name}-390.png`), fullPage: true });
  await page.setViewportSize(DESKTOP);
  if (phoneRoute) await page.goto(back);
}

const connected = async (page: Page, name: string) =>
  expect(page.locator('[data-demo="account"]')).toHaveAttribute("aria-label", `Account ${persona(name)}`);

test("the grid, signed out: four backed worlds, prices and spot as the contract has them", async ({ browser }) => {
  const page = await browser.newPage({ viewport: DESKTOP });
  await page.goto("/welcome/");
  await expect(page.locator('[data-demo="landing-headline"]')).toBeVisible();
  await shoot(page, "01-landing");
  await page.goto("/?welcome=0");
  const t = await view<{ scenario: { worlds: World[]; spot_price: string; implied_spot: string } }>("trade_view", { scenario_id: S });
  const cards = page.locator('[data-demo="world-card"]');
  await expect(cards).toHaveCount(4);
  for (const w of t.scenario.worlds) {
    await expect(page.locator(`[data-demo="world-card"][data-world="${w.label}"]`)).toContainText(`$${usd(w.wnear_price)}`);
  }
  await expect(page.locator('[data-demo="stat-backing"]')).toContainText("✓ all backed");
  await expect(page.locator('[data-demo="stat-actual-spot"]')).toContainText(`$${price4(t.scenario.spot_price)}`);
  await expect(page.locator('[data-demo="stat-implied-spot"]')).toContainText(`$${price4(t.scenario.implied_spot)}`);
  await shoot(page, "02-grid", "/?welcome=0");
  await page.locator('[data-demo="scenario-switch"]').click();
  await page.locator('[data-demo="scenario-binary"]').click();
  await expect(cards).toHaveCount(2);
  await shoot(page, "03-binary");
  await page.locator('[data-demo="scenario-switch"]').click();
  await page.locator('[data-demo="scenario-2x2"]').click();
  await expect(cards).toHaveCount(4);
  await page.context().close();
});

test("Alice sells 2,000 NEAR in the L-shape: Ravi's bid in the preview, one transaction, collateral lands", async ({ browser }) => {
  const page = await as(browser, "alice");
  await page.goto("/");
  await connected(page, "alice");
  await expect(page.locator('[data-demo="sell-wallet"]')).toHaveText("wallet: 2,000.00 wNEAR");
  for (const label of ["DELAYED·CUTS", "SHIPS·HOLDS", "DELAYED·HOLDS"]) await page.locator(`[data-demo="world-card"][data-world="${label}"]`).click();
  const confirm = page.locator('[data-demo="sell-confirm"]');
  await expect(confirm).toHaveText("Sell in 3 worlds");

  // the pool quotes from the chain, and Ravi's bid at 2.45 for the first 1,000 NEAR in DELAYED·HOLDS
  const pool = await view<string[]>("quote_sell", { scenario_id: S, wnear_amount: (2_000n * 10n ** 18n).toString(), sell_mask: 14 });
  const [dhPool] = await view<string[]>("quote_sell_parts", { scenario_id: S, parts: [{ world: 3, wnear_amount: (1_000n * 10n ** 18n).toString() }] });
  const dh = 2450n * 10n ** 18n + BigInt(dhPool);
  expect(usd(pool[1])).toBe("5,865.05");
  expect(usd(pool[2])).toBe("6,451.55");
  expect(usd(dh)).toBe("4,881.88");
  await expect(page.locator('[data-demo="sell-row"][data-world="DELAYED·CUTS"]')).toContainText(`${usd(pool[1])} USDC`);
  await expect(page.locator('[data-demo="sell-row"][data-world="SHIPS·HOLDS"]')).toContainText(`${usd(pool[2])} USDC`);
  const dhRow = page.locator('[data-demo="sell-row"][data-world="DELAYED·HOLDS"]');
  await expect(dhRow).toContainText(`sell via a bid + pool → ${usd(dh)} USDC`);
  await expect(dhRow.locator('[data-demo="plan-legs"]')).toContainText("bid #1 · 1,000.00 NEAR @ $2.4500");
  await expect(dhRow.locator('[data-demo="plan-legs"]')).toContainText("pool · 1,000.00 NEAR");
  await expect(dhRow.locator('[data-demo="plan-legs"]')).toContainText(`${usd(dhPool)} USDC`);
  await expect(page.locator('[data-demo="sell-row"][data-world="SHIPS·CUTS"]')).toContainText("keep → 2,000.00 NEAR");
  await shoot(page, "04-sell-preview", "/sell/?sel=14");

  await page.goto("/?sel=14");
  await expect(confirm).toHaveText("Sell in 3 worlds");
  await confirm.click();
  await expect(page.locator('[data-demo="sell-confirm-result"]')).toContainText("Done · ", { timeout: 60_000 });
  const t = await view<{ scenario: { worlds: World[] }; orders: unknown[] }>("trade_view", { scenario_id: S, account_id: persona("alice") });
  expect(t.orders).toHaveLength(0);
  expect(usd(t.scenario.worlds[3].collateral_usdc)).toBe("4,881.88");
  await expect(page.locator('[data-demo="world-card"][data-world="SHIPS·CUTS"]')).toContainText("You hold 2,000.00 NEAR here · loan collateral");
  for (const w of t.scenario.worlds.slice(1)) {
    await expect(page.locator(`[data-demo="world-card"][data-world="${w.label}"]`)).toContainText(`You hold ${usd(w.collateral_usdc)} USDC here · loan collateral`);
  }
  await shoot(page, "05-after-sale", "/?welcome=0");
  await page.goto("/world/?w=3");
  await expect(page.locator('[data-demo="world-info"]')).toBeVisible();
  await shoot(page, "05b-world");
  await page.context().close();
});

test("Alice borrows 3,000 USDC against the worst world: health factor 1.22", async ({ browser }) => {
  // lending prices worlds by TWAP: let a full window pass after the sale
  const cfg = await view<{ twap_window_sec: number }>("get_app_config");
  await fastForwardTo((await chainNowSec()) + cfg.twap_window_sec + 2);
  const page = await as(browser, "alice");
  await page.goto("/borrow/");
  await connected(page, "alice");
  const hero = page.locator('[data-demo="hero-hf"]');
  await expect(hero).toContainText("∞");
  await expect(hero).toContainText("worst world: DELAYED·HOLDS");
  await expect(page.locator('[data-demo="posted-collateral"] li')).toHaveCount(4);
  await page.locator('[data-demo="borrow-amount"]').fill("3000");
  await expect(page.locator('[data-demo="hf-after"]')).toHaveText("1.22");
  await shoot(page, "06-borrow-before", undefined, async (p) => p.locator('[data-demo="borrow-amount"]').fill("3000"));
  await expect(async () => {
    await page.locator('[data-demo="borrow-amount"]').fill("3000");
    await expect(page.locator('[data-demo="borrow-confirm"]')).toHaveText("Borrow", { timeout: 3_000 });
    await page.locator('[data-demo="borrow-confirm"]').click({ timeout: 2_000 });
  }).toPass();
  await expect(page.locator('[data-demo="borrow-confirm-result"]')).toContainText("Done · ", { timeout: 60_000 });
  const b = await view<Snap & { account: { health_factor: string; debt: string } }>("borrow_view", { scenario_id: S, account_id: persona("alice") });
  expect(ratio(b.account.health_factor)).toBe("1.22");
  await expect(hero).toContainText(ratio(b.account.health_factor));
  await expect(page.locator('[data-demo="borrow-stats"]')).toContainText(usd(b.account.debt).slice(0, 5));
  await shoot(page, "07-borrow-after");
  await page.context().close();
});

test("Bob's lending screen matches the market", async ({ browser }) => {
  const page = await as(browser, "bob");
  await page.goto("/lend/");
  await connected(page, "bob");
  const l = await view<{ account: { supplied: string; utilization: string } }>("lend_view", { scenario_id: S, account_id: persona("bob") });
  await expect(page.locator('[data-demo="stat-supplied"]')).toContainText(`$${usd(l.account.supplied).slice(0, 7)}`);
  const util = (Number((BigInt(l.account.utilization) * 10000n) / 10n ** 18n) / 100).toFixed(1);
  await expect(page.locator('[data-demo="stat-utilization"]')).toContainText(`${util}%`);
  await shoot(page, "08-lend");
  await page.context().close();
});

/** Token units: wNEAR has 24 decimals, USDC 6. */
const NEAR = 10n ** 24n;
const USDC = 10n ** 6n;

test("Ravi quotes SHIPS·CUTS, Sam accepts the ask", async ({ browser }) => {
  await fund(persona("ravi"), { wnear: 2_000n * NEAR, usdc: 5_000n * USDC });
  await fund(persona("sam"), { usdc: 5_000n * USDC });
  const ravi = await as(browser, "ravi");
  await ravi.goto("/orders/?w=0");
  await connected(ravi, "ravi");
  await expect(ravi.locator("main")).toContainText("Order book · SHIPS·CUTS");
  await ravi.locator('[data-demo="post-ask-tab"]').click();
  await ravi.locator('[data-demo="post-price"]').fill("3.75");
  await ravi.locator('[data-demo="post-amount"]').fill("1000");
  await ravi.locator('[data-demo="post-ask"]').click();
  await expect(ravi.locator('[data-demo="post-ask-result"]')).toContainText("Done · ", { timeout: 60_000 });
  await ravi.locator('[data-demo="post-bid-tab"]').click();
  await ravi.locator('[data-demo="post-price"]').fill("3.60");
  await ravi.locator('[data-demo="post-amount"]').fill("1000");
  await ravi.locator('[data-demo="post-bid"]').click();
  await expect(ravi.locator('[data-demo="post-bid-result"]')).toContainText("Done · ", { timeout: 60_000 });
  const ladder = ravi.locator('[data-demo="ladder"]');
  await expect(ladder.locator('[data-demo="ladder-row"][data-side="ask"]')).toContainText("$3.7500");
  await expect(ladder.locator('[data-demo="ladder-row"][data-side="bid"]')).toContainText("$3.6000");
  await expect(ravi.locator('[data-demo="my-orders"]')).toContainText("$3.7500");
  await shoot(ravi, "09-book-ravi", "/orders/?w=0");
  await ravi.context().close();

  const orders = (await view<{ orders: { id: string; side: string; price: string; maker: string }[] }>("trade_view", { scenario_id: S })).orders;
  const ask = orders.find((o) => o.side === "ask" && o.price === (375n * 10n ** 16n).toString())!;
  expect(ask.maker).toBe(persona("ravi"));

  const sam = await as(browser, "sam");
  await sam.goto("/orders/?w=0");
  await connected(sam, "sam");
  const row = sam.locator('[data-demo="ladder-row"][data-side="ask"]', { hasText: "$3.7500" });
  await expect(row).toContainText(persona("ravi"));
  await row.locator('[data-demo="accept"]').click();
  const box = sam.locator('[data-demo="accept-box"]');
  await expect(box).toContainText(`Buy from ask #${ask.id} at $3.7500`);
  await expect(box).toContainText("Pay 3,750.00 USDC; get 1,000.00 NEAR-if-SHIPS·CUTS");
  await sam.locator('[data-demo="post-price"]').fill("3.80");
  await sam.locator('[data-demo="post-amount"]').fill("100");
  await expect(sam.locator('[data-demo="post-form"]')).toContainText(`This bid crosses ask #${ask.id} at $3.7500, which is already there.`);
  await shoot(sam, "10-accept-ask", "/orders/?w=0&buy=1");
  await sam.locator('[data-demo="ladder-row"][data-side="ask"]', { hasText: "$3.7500" }).locator('[data-demo="accept"]').click();
  await expect(box).toContainText(`Buy from ask #${ask.id} at $3.7500`);
  await sam.locator('[data-demo="accept-confirm"]').click();
  await expect(sam.locator('[data-demo="accept-confirm-result"]')).toContainText("Done · ", { timeout: 60_000 });
  const after = await view<{ scenario: { worlds: World[] }; orders: { id: string }[] }>("trade_view", { scenario_id: S, account_id: persona("sam") });
  expect(after.orders.some((o) => o.id === ask.id)).toBe(false);
  expect(after.scenario.worlds[0].user_wnear).toBe((1_000n * 10n ** 18n).toString());
  await expect(sam.locator('[data-demo="ladder-row"][data-side="ask"]', { hasText: "$3.7500" })).toHaveCount(0);
  await shoot(sam, "11-after-accept");
  await sam.context().close();
});

test("Uma underwrites every world as Root LP, then withdraws it all", async ({ browser }) => {
  await fund(persona("uma"), { wnear: 5_000n * NEAR, usdc: 20_000n * USDC });
  const page = await as(browser, "uma");
  await page.goto("/lend/");
  await connected(page, "uma");
  await page.locator('[data-demo="lp-wnear"]').fill("5000");
  await page.locator('[data-demo="lp-usdc"]').fill("20000");
  const preview = await view<{ shares: string }>("preview_lp_deposit", {
    scenario_id: S,
    wnear_amount: (5_000n * 10n ** 18n).toString(),
    usdc_amount: (20000n * 10n ** 18n).toString(),
  });
  await expect(page.locator('[data-demo="lp-deposit"]')).toContainText(usd(preview.shares));
  await shoot(page, "12-lp-preview", undefined, async (p) => {
    await p.locator('[data-demo="lp-wnear"]').fill("5000");
    await p.locator('[data-demo="lp-usdc"]').fill("20000");
  });
  await expect(async () => {
    await page.locator('[data-demo="lp-wnear"]').fill("5000");
    await page.locator('[data-demo="lp-usdc"]').fill("20000");
    await expect(page.locator('[data-demo="lp-deposit-confirm"]')).toHaveText("Underwrite every world", { timeout: 3_000 });
    await page.locator('[data-demo="lp-deposit-confirm"]').click({ timeout: 2_000 });
  }).toPass();
  await expect(page.locator('[data-demo="lp-deposit-confirm-result"]')).toContainText("Done · ", { timeout: 90_000 });
  const l = await view<{ root_lp: { your_shares: string } }>("lend_view", { scenario_id: S, account_id: persona("uma") });
  expect(BigInt(l.root_lp.your_shares)).toBeGreaterThan(0n);
  await expect(page.locator('[data-demo="lp-position"]')).toContainText(usd(l.root_lp.your_shares));
  await expect(page.locator('[data-demo="lp-table"]')).toBeVisible();
  await shoot(page, "13-lp-position");
  await page.locator('[data-demo="lp-withdraw-all"]').click();
  await expect(page.locator('[data-demo="lp-withdraw-all-result"]')).toContainText("Done · ", { timeout: 60_000 });
  const gone = await view<{ root_lp: { your_shares: string } }>("lend_view", { scenario_id: S, account_id: persona("uma") });
  expect(gone.root_lp.your_shares).toBe("0");
  await shoot(page, "14-lp-withdrawn");
  await page.context().close();
});

test("resolution: the resolver proposes Fed HOLDS, the window runs out, Alice finalizes; the owner resolves SPICE DELAYED; Alice closes", async ({ browser }) => {
  const owner = await as(browser, "owner");
  await owner.goto("/admin/");
  await connected(owner, "owner");
  await expect(owner.locator('[data-demo="owner-status"]')).toHaveText("✓ Connected as the oracle owner");
  await shoot(owner, "15-admin");

  await report(2, 1);
  const alice = await as(browser, "alice");
  await alice.goto("/resolve/");
  await connected(alice, "alice");
  const fed = alice.locator('[data-demo="event-card"][data-event="2"]');
  await expect(alice.locator('[data-demo="scenario-status"]')).toContainText("paused: resolution pending");
  await expect(fed.locator('[data-demo="event-badge"]')).toHaveText("Proposed: HOLDS");
  await expect(fed.locator('[data-demo="finalize"]')).toHaveText(/Finalize in 0:\d\d/);
  await shoot(alice, "16-proposed");

  const ev = await view<{ finalizable_at_sec: number }>("get_event", { event_id: 2 });
  await fastForwardTo(ev.finalizable_at_sec + 1);
  await expect(fed.locator('[data-demo="finalize"]')).toHaveText("Finalize", { timeout: 20_000 });
  await fed.locator('[data-demo="finalize"]').click();
  await expect(fed.locator('[data-demo="event-badge"]')).toHaveText("Resolved: HOLDS", { timeout: 60_000 });
  expect((await view<{ finalized: boolean; outcome: number }>("get_event", { event_id: 2 })).finalized).toBe(true);
  await expect(alice.locator('[data-demo="survivors"]')).toContainText("SHIPS·HOLDS");
  await shoot(alice, "17-fed-final");

  await owner.reload();
  const spice = owner.locator('[data-demo="event-card"][data-event="1"]');
  await spice.locator('[data-demo="resolve-outcome"]', { hasText: "DELAYED" }).click();
  await expect(spice.locator('[data-demo="resolve-now"]')).toHaveText("Resolve now: DELAYED");
  await spice.locator('[data-demo="resolve-now"]').click();
  await expect(spice.locator('[data-demo="event-badge"]')).toHaveText("Resolved: DELAYED", { timeout: 60_000 });
  await shoot(owner, "18-admin-resolved");
  await owner.context().close();

  await expect(alice.locator('[data-demo="survivors"]')).toContainText("Only DELAYED·HOLDS is still possible", { timeout: 30_000 });
  await shoot(alice, "19-collapsed");

  const r = await view<{ account: { debt: string } }>("resolve_view", { scenario_id: S, account_id: persona("alice") });
  await expect(alice.locator('[data-demo="close-pieces"]')).toContainText("collapsed: redeemed 1:1 for real USDC");
  await expect(alice.locator('[data-demo="close-receive"]')).toContainText("4,881.88 USDC");
  await alice.locator('[data-demo="close-confirm"]').click();
  await expect(alice.locator('[data-demo="close-result"]')).toContainText("redeemed 4,881.88 real USDC.", { timeout: 60_000 });
  await expect(alice.locator('[data-demo="close-result"]')).toContainText(`Repaid $${usd(r.account.debt).slice(0, 5)}`);
  const after = await view<{ account: { debt: string; collateral: unknown[] } }>("resolve_view", { scenario_id: S, account_id: persona("alice") });
  expect(after.account.debt).toBe("0");
  expect(after.account.collateral).toHaveLength(0);
  await shoot(alice, "20-closed");
  await alice.locator('[data-demo="account"]').click();
  await expect(alice.locator('[data-demo="account-sheet"]')).toContainText(persona("alice"));
  await shoot(alice, "21-account", undefined, async (p) => {
    if (!(await p.locator('[data-demo="account-sheet"]').isVisible())) await p.locator('[data-demo="account"]').click();
  });
  await alice.context().close();
});
