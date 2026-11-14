// The staging deployment on the public testnet, driven through the real UI with real transactions, each result checked
// against the contract's own views. Run with `pnpm e2e:staging` after `pnpm build:staging` (BASE_URL=<site> points it
// at a deployed one). Keys: NEAR_KEYS_DIR (or the repo's gitignored .keys/staging); the judge account it creates gets
// its key written there too. It leaves the seeded demo state alone: no resolution, no persona's open loan or standing
// order is touched, and the on-camera combination proposal (events 2 + 5) is cancelled again so it stays free.
//
// Each test reads what it needs from the chain, so one can run alone (-g). Every signed transaction and the outcome of
// each test go to playwright-report/staging/staging-results.jsonl.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import {
  CONTRACT,
  deployment,
  demoWallet,
  ensureSubAccount,
  nearBalance,
  patient,
  persona,
  ROOT,
  signer,
  topUp,
  view,
  walletIdle,
  type Signed,
} from "./staging/chain";
import { actions } from "near-api-js";

// Outside test-results/, which Playwright empties at the start of every run (both are gitignored).
const OUT = join(__dirname, "..", "playwright-report", "staging");
const SHOTS = process.env.SHOTS_DIR || join(OUT, "staging-shots");
mkdirSync(SHOTS, { recursive: true });
mkdirSync(OUT, { recursive: true });
const RESULTS = join(OUT, "staging-results.jsonl");

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const SID = 1;
const JUDGE = `${process.env.JUDGE || "judge-smoke1"}.${ROOT}`;
const NEAR = 10n ** 24n;
const E18 = 10n ** 18n;
const TIERS = ["safe", "normal", "bold"] as const;

// ---- bookkeeping: every signed transaction and every console error of the current test ----

let signed: Signed[] = [];
let errors: string[] = [];

/** The public RPCs answer a burst with 429 and no CORS header; the browser logs that, the app retries elsewhere. */
const RPC_NOISE = /blocked by CORS policy|net::ERR_FAILED|status of 429/;

/** The keeper ping posts to the hosted function; the local static server has none and answers 404. */
const LOCAL_ONLY = /\/api\/keeper/;

function watch(page: Page): void {
  page.on("pageerror", (e) => errors.push(`pageerror ${page.url()}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error" || RPC_NOISE.test(m.text()) || LOCAL_ONLY.test(m.location().url)) return;
    errors.push(`console ${page.url()}: ${m.text()}${m.location().url ? ` (${m.location().url})` : ""}`);
  });
}

test.beforeEach(() => {
  signed = [];
  errors = [];
});

test.afterEach(async ({}, info) => {
  await walletIdle();
  appendFileSync(
    RESULTS,
    JSON.stringify({
      at: new Date().toISOString(),
      test: info.title,
      status: info.status,
      error: info.error?.message?.slice(0, 600),
      txs: signed.map((s) => `${s.tx.actions[0]?.params.methodName ?? "?"}@${s.tx.receiverId} ${s.hash}${s.ok ? "" : ` FAILED ${s.error}`}`),
      consoleErrors: errors,
    }) + "\n",
  );
  expect.soft(errors, "uncaught errors").toEqual([]);
});

async function as(browser: Browser, accountId: string | null, o: { viewport?: { width: number; height: number }; welcomed?: boolean } = {}): Promise<Page> {
  const context = await browser.newContext({ viewport: o.viewport ?? DESKTOP, reducedMotion: "reduce" });
  if (accountId) await demoWallet(context, accountId, signed, { welcomed: o.welcomed ?? true });
  else await context.addInitScript(() => localStorage.setItem("multiverse.welcomed", "1"));
  const page = await context.newPage();
  watch(page);
  return page;
}

const demo = (page: Page | Locator, name: string) => page.locator(`[data-demo="${name}"]`);

/**
 * Clicks a TxButton once it is enabled and waits for its result line: "Done · …", or fails with the contract's words.
 * Some buttons leave the screen once their transaction lands (a cancelled order's row, a withdrawn pledge): for those,
 * `landed` reads the chain instead.
 */
async function confirm(scope: Page | Locator, name: string, landed?: () => Promise<boolean>, timeout = 180_000): Promise<void> {
  const button = demo(scope, name).first();
  await expect(button).toBeVisible();
  try {
    await expect(button).toBeEnabled({ timeout: 45_000 });
  } catch {
    throw new Error(`${name} stays disabled: "${await button.innerText()}"`);
  }
  await button.click();
  const result = demo(scope, `${name}-result`).first();
  const end = Date.now() + timeout;
  for (;;) {
    if (await result.isVisible()) {
      const text = await result.innerText();
      expect(text, `${name}: ${text}`).toContain("Done");
      return;
    }
    if (landed && (await landed().catch(() => false))) return;
    if (Date.now() > end) throw new Error(`${name}: no result after ${timeout / 1000} s`);
    await new Promise((r) => setTimeout(r, 1_500));
  }
}

/** Cancels one of the account's orders from "Your orders here"; the row leaves the list once the cancel lands. */
async function cancelOrder(page: Page, id: string, side: "bid" | "ask"): Promise<void> {
  const row = demo(page, "my-orders").locator("> div").filter({ hasText: `#${id} ${side}` });
  const button = demo(row, "cancel-order");
  await expect(button).toBeEnabled({ timeout: 45_000 });
  await button.click();
  await expect(row.or(demo(row, "cancel-order-result").filter({ hasNotText: "Done" }))).toHaveCount(0, { timeout: 180_000 });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

const connected = async (page: Page, accountId: string) => expect(demo(page, "account").first()).toHaveAttribute("aria-label", `Account ${accountId}`);

/** "12.3456" from a WAD price, truncated. */
const price4 = (wad: bigint): string => {
  const u = wad / 10n ** 14n;
  return `${u / 10_000n}.${(u % 10_000n).toString().padStart(4, "0")}`;
};

type World = { index: number; mask: number; label: string; wnear_price: string; user_wnear: string; user_usdc: string; collateral_wnear: string; collateral_usdc: string };
type Order = { id: string; maker: string; mask: number; side: "bid" | "ask"; price: string; remaining: string };
type TradeView = { scenario: { worlds: World[] }; orders: Order[] };
type AccountView = { debt: string; supplied: string; collateral: { token_id: string; amount: string; is_real?: boolean }[] };

const trade = (account?: string) => view<TradeView>("trade_view", { scenario_id: SID, account_id: account ?? null });
const borrowAccount = async (account: string, tier: string) => (await view<{ account: AccountView }>("borrow_view", { scenario_id: SID, account_id: account, tier })).account;
const lendAccount = async (account: string, tier: string) => (await view<{ account: AccountView }>("lend_view", { scenario_id: SID, account_id: account, tier })).account;
const ftBalance = async (token: string, account: string) => BigInt(await view<string>("ft_balance_of", { account_id: account }, token));

/** Waits for a chain view to satisfy a check (views run on optimistic finality; the UI may lead by a block). */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  let last: T = await read();
  while (!ok(last)) {
    if (Date.now() > end) throw new Error(`${what}: ${JSON.stringify(last, (_, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 2_500));
    last = await read().catch(() => last);
  }
  return last;
}

// ---- b. the list, every market page, related markets, worlds, split ----

test("markets list: search, filter, sort; markets 1-8, related, world, split navigation", async ({ browser }) => {
  const page = await as(browser, null);
  const cards = demo(page, "market-card");
  await page.goto("/");
  await expect(cards).toHaveCount(8);
  await shot(page, "b-list");

  await demo(page, "market-search").fill("Fed");
  await expect(page).toHaveURL(/q=Fed/);
  // fed-dec and fed-oct, plus the combinations that contain the Fed event: 1 and 8
  await expect(cards).toHaveCount(4);
  await demo(page, "market-search-clear").click();
  await expect(cards).toHaveCount(8);

  await demo(page, "market-filter-combo").click();
  await expect(page).toHaveURL(/f=combo/);
  await expect(cards).toHaveCount(3);
  await demo(page, "market-filter-all").click();
  await expect(cards).toHaveCount(8);

  await demo(page, "market-sort").locator("button", { hasText: "Ending soon" }).click();
  await expect(page).toHaveURL(/sort=deadline/);
  // the earliest deadline first: fed-oct (#2, 28 Oct)
  await expect(cards.first()).toContainText("#2");
  await shot(page, "b-list-sorted");

  for (let id = 1; id <= 8; id++) {
    await page.goto(`/market/?id=${id}`);
    const worlds = id === 8 ? 8 : [1, 7].includes(id) ? 4 : 2;
    await expect(demo(page, "world-card")).toHaveCount(worlds);
    await expect(demo(page, "market-header")).toBeVisible();
    await expect(page.getByText("Application error")).toHaveCount(0);
    if (id === 1 || id === 8) await shot(page, `b-market-${id}`);
  }
  // related markets of spice (#5): 1, 7 and 8 share its event
  await page.goto("/market/?id=5");
  for (const sid of [1, 7, 8]) await expect(demo(page, "related-row").filter({ hasText: `#${sid}` }).first()).toBeVisible();

  await page.goto("/world/?id=1&w=0");
  await expect(demo(page, "world-detail-card").or(demo(page, "world-details")).first()).toBeVisible();
  await page.goto("/world/?id=8&w=7");
  await expect(demo(page, "world-detail-card").or(demo(page, "world-details")).first()).toBeVisible();

  // the desktop market tabs reach /split/, and the split page carries the tabs back
  await page.goto("/market/?id=1");
  await demo(page, "nav-split").click();
  await expect(page).toHaveURL(/\/split\/\?id=1/);
  await expect(demo(page, "split-panel")).toBeVisible();
  await expect(demo(page, "nav-split")).toHaveAttribute("aria-current", "page");
  await demo(page, "nav-trade").click();
  await expect(page).toHaveURL(/\/market\/\?id=1/);
  await page.context().close();
});

// ---- a. a judge's first visit ----

test("a judge's first visit: a brand-new account gets test tokens, splits and sells from the UI alone", async ({ browser }) => {
  const created = await ensureSubAccount(JUDGE.split(".")[0], 6n * NEAR / 10n);
  if (created.hash) signed.push({ tx: { receiverId: JUDGE, actions: [] }, hash: created.hash, ok: true });
  const fresh = (await view<unknown>("storage_balance_of", { account_id: JUDGE })) === null;

  const page = await as(browser, JUDGE, { welcomed: false });
  await page.goto("/");
  await connected(page, JUDGE);
  await shot(page, "a-first-visit");
  if (fresh) {
    if ((await ftBalance(deployment.wnear, JUDGE)) === 0n) {
      // no wNEAR, no USDC, no registration anywhere: the list offers the faucet
      await expect(demo(page, "empty-wallet-hint")).toBeVisible();
      await confirm(page, "hint-test-tokens");
    } else {
      // a re-run after the mints landed but not the registration: the account sheet still offers it
      await demo(page, "account").first().click();
      await confirm(page, "get-test-tokens");
    }
    await expect(demo(page, "faucet-progress")).toContainText("Registered with");
    expect(await ftBalance(deployment.wnear, JUDGE)).toBe(2_000n * NEAR);
    expect(await ftBalance(deployment.usdc, JUDGE)).toBe(5_000n * 10n ** 6n);
    expect(await view("storage_balance_of", { account_id: JUDGE })).not.toBeNull();
    await shot(page, "a-tokens");
  }

  // split 10 wNEAR into every world of the anchor market
  const before = await trade(JUDGE);
  await page.goto(`/split/?id=${SID}`);
  await demo(page, "split-amount").fill("10");
  await confirm(page, "split-confirm");
  await until(
    () => trade(JUDGE),
    (t) => t.scenario.worlds.every((w, i) => BigInt(w.user_wnear) - BigInt(before.scenario.worlds[i].user_wnear) === 10n * E18),
    "split: 10 NEAR in every world",
  );

  // sell 10 NEAR in DELAYED·CUTS (no standing orders there) to the wallet
  const wBefore = await ftBalance(deployment.wnear, JUDGE);
  await page.goto(`/market/?id=${SID}`);
  await page.locator('[data-demo="world-card"][data-world="DELAYED·CUTS"]').first().click();
  await demo(page, "sell-amount").fill("10");
  const keep = demo(page, "sell-to-lending");
  if (await keep.isChecked()) await keep.uncheck();
  await expect(demo(page, "sell-confirm")).toHaveText("Sell in 1 world");
  await confirm(page, "sell-confirm");
  const after = await until(
    () => trade(JUDGE),
    (t) => BigInt(t.scenario.worlds[1].user_usdc) > BigInt(before.scenario.worlds[1].user_usdc),
    "sell: USDC-if-DELAYED·CUTS lands",
  );
  expect(await ftBalance(deployment.wnear, JUDGE)).toBe(wBefore - 10n * NEAR);
  // every other world keeps the sold NEAR as NEAR there
  for (const i of [0, 2, 3]) expect(BigInt(after.scenario.worlds[i].user_wnear) - BigInt(before.scenario.worlds[i].user_wnear)).toBe(20n * E18);
  await shot(page, "a-after-sale");
  await page.context().close();
});

// ---- c. orders ----

const BOOK_WORLD = 2; // SHIPS·HOLDS: no standing order of Ravi's

test("orders: bob gets test tokens, posts an ask, posts and cancels a bid", async ({ browser }) => {
  const bob = persona("bob");
  const page = await as(browser, bob);
  if ((await ftBalance(deployment.wnear, bob)) < 100n * NEAR || (await ftBalance(deployment.usdc, bob)) < 100n * 10n ** 6n) {
    await page.goto("/");
    await connected(page, bob);
    await confirm(page, "hint-test-tokens");
  }
  const pool = BigInt((await trade()).scenario.worlds[BOOK_WORLD].wnear_price);
  await page.goto(`/orders/?id=${SID}&w=${BOOK_WORLD}`);
  await connected(page, bob);
  const panel = demo(page, "order-panel");
  await expect(panel).toContainText("SHIPS·HOLDS");

  // an ask 3% over the pool for 5 NEAR
  await demo(page, "post-ask-tab").click();
  await demo(page, "post-price").fill(price4((pool * 103n) / 100n));
  await demo(page, "post-amount").fill("5");
  await confirm(page, "post-ask");
  const asks = await until(
    () => view<Order[]>("orders_by_maker", { account_id: bob, scenario_id: SID }),
    (os) => os.some((o) => o.side === "ask" && o.mask === 1 << BOOK_WORLD && BigInt(o.remaining) === 5n * E18),
    "the ask rests in the book",
  );
  const ask = asks.find((o) => o.side === "ask" && o.mask === 1 << BOOK_WORLD)!;
  await expect(demo(page, "my-orders")).toContainText(`#${ask.id}`);

  // a bid 10% under the pool for 3 NEAR, then cancelled
  await demo(page, "post-bid-tab").click();
  await demo(page, "post-price").fill(price4((pool * 90n) / 100n));
  await demo(page, "post-amount").fill("3");
  await confirm(page, "post-bid");
  const bids = await until(
    () => view<Order[]>("orders_by_maker", { account_id: bob, scenario_id: SID }),
    (os) => os.some((o) => o.side === "bid" && o.mask === 1 << BOOK_WORLD),
    "the bid rests in the book",
  );
  const bid = bids.find((o) => o.side === "bid" && o.mask === 1 << BOOK_WORLD)!;
  await cancelOrder(page, bid.id, "bid");
  await until(
    () => view<Order[]>("orders_by_maker", { account_id: bob, scenario_id: SID }),
    (os) => !os.some((o) => o.id === bid.id),
    "the bid is cancelled",
  );
  await shot(page, "c-orders");
  await page.context().close();
});

test("buy: the judge takes 2 NEAR of bob's ask (a fill); bob cancels the rest", async ({ browser }) => {
  const bob = persona("bob");
  const open = (await view<Order[]>("orders_by_maker", { account_id: bob, scenario_id: SID })).find((o) => o.side === "ask" && o.mask === 1 << BOOK_WORLD);
  test.skip(!open, "no ask of bob's to take: run the orders test first");
  const before = await trade(JUDGE);
  const page = await as(browser, JUDGE);
  await page.goto(`/orders/?id=${SID}&w=${BOOK_WORLD}&buy=1`);
  await connected(page, JUDGE);
  const box = demo(page, "accept-box");
  await expect(box).toContainText(`ask #${open!.id}`);
  await demo(page, "accept-amount").fill("2");
  await confirm(page, "accept-confirm");
  await until(
    () => view<Order[]>("orders_by_maker", { account_id: bob, scenario_id: SID }),
    (os) => BigInt(os.find((o) => o.id === open!.id)?.remaining ?? "0") === BigInt(open!.remaining) - 2n * E18,
    "bob's ask is 2 NEAR smaller",
  );
  const after = await trade(JUDGE);
  expect(BigInt(after.scenario.worlds[BOOK_WORLD].user_wnear) - BigInt(before.scenario.worlds[BOOK_WORLD].user_wnear)).toBe(2n * E18);
  await page.context().close();

  const bobPage = await as(browser, bob);
  await bobPage.goto(`/orders/?id=${SID}&w=${BOOK_WORLD}`);
  await cancelOrder(bobPage, open!.id, "ask");
  await until(
    () => view<Order[]>("orders_by_maker", { account_id: bob, scenario_id: SID }),
    (os) => !os.some((o) => o.id === open!.id),
    "the rest of the ask is cancelled",
  );
  await bobPage.context().close();
});

// ---- d. lend and borrow in every tier ----

test("lend: supply and withdraw 100 USDC in Safe, Normal and Bold", async ({ browser }) => {
  const page = await as(browser, JUDGE);
  for (const tier of TIERS) {
    const base = BigInt((await lendAccount(JUDGE, tier)).supplied);
    await page.goto(`/lend/?id=${SID}&tier=${tier}`);
    await connected(page, JUDGE);
    await expect(demo(page, `tier-${tier}`)).toHaveAttribute("aria-pressed", "true");
    await demo(page, "supply-amount").fill("100");
    await confirm(page, "supply-confirm");
    await until(() => lendAccount(JUDGE, tier), (a) => BigInt(a.supplied) >= base + 100n * E18 - 1n, `${tier}: supplied`);
    await expect(demo(page, "stat-supplied")).toContainText("100.");
    await demo(page, "withdraw-all").click();
    await confirm(page, "withdraw-confirm");
    await until(() => lendAccount(JUDGE, tier), (a) => BigInt(a.supplied) === 0n, `${tier}: withdrawn`);
  }
  await shot(page, "d-lend");
  await page.context().close();
});

/** Takes every posted piece of a tier back through the borrow screen's withdraw card. */
async function takeCollateralBack(page: Page, tier: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const a = await borrowAccount(JUDGE, tier);
    if (a.collateral.length === 0) return;
    await page.reload();
    // the piece's row (and the card with the last one) leaves once the withdrawal lands
    const row = demo(page, "withdraw-collateral-row").first();
    const piece = await row.getAttribute("data-piece");
    const button = demo(row, "withdraw-collateral-confirm");
    await expect(button).toBeEnabled({ timeout: 45_000 });
    await button.click();
    await until(() => borrowAccount(JUDGE, tier), (b) => !b.collateral.some((c) => c.token_id === piece), `${tier}: ${piece} comes back`, 120_000);
    await expect(page.locator(`[data-demo="withdraw-collateral-row"][data-piece="${piece}"]`)).toHaveCount(0);
  }
  throw new Error(`${tier}: collateral still posted`);
}

test("borrow: post wNEAR, borrow 100 USDC, repay all and take the collateral back in each tier", async ({ browser }) => {
  const page = await as(browser, JUDGE);
  for (const tier of TIERS) {
    const start = await borrowAccount(JUDGE, tier);
    test.skip(BigInt(start.debt) > 0n, `${tier}: the judge already owes`);
    await page.goto(`/borrow/?id=${SID}&tier=${tier}`);
    await connected(page, JUDGE);
    await demo(page, "collateral-asset-wnear").click();
    await demo(page, "collateral-amount").fill("200");
    await confirm(page, "collateral-confirm");
    await until(() => borrowAccount(JUDGE, tier), (a) => a.collateral.some((c) => c.token_id === "wnear" && BigInt(c.amount) === 200n * E18), `${tier}: 200 wNEAR posted`);
    // holdings per tier: the piece shows in this tier only
    await expect(demo(page, "posted-collateral")).toContainText("200.00");
    for (const other of TIERS.filter((t) => t !== tier)) expect((await borrowAccount(JUDGE, other)).collateral.some((c) => c.token_id === "wnear"), `${other} has no wNEAR`).toBe(false);

    await demo(page, "borrow-amount").fill("100");
    await confirm(page, "borrow-confirm");
    await until(() => borrowAccount(JUDGE, tier), (a) => BigInt(a.debt) >= 100n * E18, `${tier}: debt 100`);
    await expect(demo(page, "borrow-stats")).toContainText("100.");
    await shot(page, `d-borrow-${tier}`);

    await demo(page, "repay-all").click();
    await confirm(page, "repay-confirm");
    await until(() => borrowAccount(JUDGE, tier), (a) => BigInt(a.debt) === 0n, `${tier}: repaid`);
    await takeCollateralBack(page, tier);
  }
  await page.context().close();
});

test("sell and borrow: sell 100 NEAR in one world into Normal collateral, borrow, repay, take it back", async ({ browser }) => {
  test.skip(BigInt((await borrowAccount(JUDGE, "normal")).debt) > 0n, "the judge already owes in Normal");
  const page = await as(browser, JUDGE);
  await page.goto(`/market/?id=${SID}`);
  await connected(page, JUDGE);
  await page.locator('[data-demo="world-card"][data-world="DELAYED·CUTS"]').first().click();
  await demo(page, "sell-amount").fill("100");
  await expect(demo(page, "sell-to-lending")).toBeChecked();
  await demo(page, "sell-tier-normal").click();
  await confirm(page, "sell-confirm");
  await until(() => borrowAccount(JUDGE, "normal"), (a) => a.collateral.length > 0, "the sale lands as Normal collateral");

  await page.goto(`/borrow/?id=${SID}`);
  await expect(demo(page, "posted-collateral")).not.toContainText("None yet");
  await demo(page, "borrow-amount").fill("100");
  await confirm(page, "borrow-confirm");
  await until(() => borrowAccount(JUDGE, "normal"), (a) => BigInt(a.debt) >= 100n * E18, "debt 100");
  await shot(page, "d-sell-and-borrow");
  await demo(page, "repay-all").click();
  await confirm(page, "repay-confirm");
  await until(() => borrowAccount(JUDGE, "normal"), (a) => BigInt(a.debt) === 0n, "repaid");
  await takeCollateralBack(page, "normal");
  await page.context().close();
});

// ---- e. liquidation screen (read only) ----

test("liquidate: every open loan listed with its health factor; healthy ones cannot be liquidated (nothing is)", async ({ browser }) => {
  const page = await as(browser, persona("bob"));
  await page.goto("/liquidate/");
  // the default view shows loans under HF 1.1: none of the seeded ones
  await expect(demo(page, "atrisk-empty").or(demo(page, "atrisk-row")).first()).toBeVisible({ timeout: 60_000 });
  await demo(page, "atrisk-filter-all").click();
  await expect(page).toHaveURL(/hf=all/);
  const rows = demo(page, "atrisk-row");
  for (const name of ["alice", "sam", "carl", "leo"]) {
    const row = page.locator(`[data-demo="atrisk-row"][data-account="${persona(name)}"]`).first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row).toContainText("HF");
    await expect(row.locator('[data-demo="liquidate"]')).toBeDisabled();
  }
  expect(await rows.count()).toBeGreaterThanOrEqual(4);
  await shot(page, "e-liquidate");
  await page.context().close();
});

// ---- f. proposals, pledges, admin ----

const COMBO = [2, 5];

/** The proposals below attach 0.2 + 0.3 + 0.3 NEAR; the judge needs that plus the wallet's 0.31 NEAR gas float. */
async function fundJudgeFor(near: bigint): Promise<void> {
  const have = await nearBalance(JUDGE);
  if (have < near) signed.push({ tx: { receiverId: JUDGE, actions: [] }, hash: await topUp(JUDGE, near - have), ok: true });
}

type Summary = { proposal_id: number; kind: "market" | "new_event"; proposer: string; status: string };
const proposalsOf = async (who: string, filter: string): Promise<Summary[]> =>
  (await view<{ proposals: Summary[] }>("list_proposals", { limit: 50, filter })).proposals.filter((p) => p.proposer === who);

/** Proposing redirects to the new proposal's page as soon as the contract logs it. */
async function propose(page: Page): Promise<number> {
  const button = demo(page, "propose-confirm");
  try {
    await expect(button).toBeEnabled({ timeout: 45_000 });
  } catch {
    throw new Error(`propose-confirm stays disabled: "${await button.innerText()}"`);
  }
  await button.click();
  await expect(page.locator('[data-demo="proposal-header"]').or(demo(page, "propose-confirm-result").filter({ hasNotText: "Done" })).first()).toBeVisible({ timeout: 180_000 });
  const err = demo(page, "propose-confirm-result");
  if ((await err.count()) > 0) throw new Error(`propose: ${await err.first().innerText()}`);
  await expect(page).toHaveURL(/\/proposal\/\?p=\d+/);
  return Number(new URL(page.url()).searchParams.get("p"));
}

test("Kind B: propose fed-dec × NEAR Dec 31, pledge, see progress, withdraw, cancel (the combination stays free)", async ({ browser }) => {
  const check = await view<{ blocker: string | null; listed_market: number | null; live_proposal: number | null }>("market_check", { event_ids: COMBO });
  const mine = (await proposalsOf(JUDGE, "live")).find((p) => p.kind === "market");
  test.skip(check.listed_market !== null || (check.live_proposal !== null && check.live_proposal !== mine?.proposal_id), `events ${COMBO} already proposed or listed`);
  await fundJudgeFor(85n * NEAR / 100n);
  const page = await as(browser, JUDGE);
  let pid = mine?.proposal_id;
  if (pid === undefined) {
    await page.goto(`/propose/?kind=market&events=${COMBO.join(",")}`);
    await connected(page, JUDGE);
    await expect(demo(page, "propose-check")).toBeVisible();
    await shot(page, "f-propose-b");
    pid = await propose(page);
  } else {
    await page.goto(`/proposal/?p=${pid}`);
    await connected(page, JUDGE);
  }

  await demo(page, "pledge-asset-usdc").click();
  await demo(page, "pledge-amount").fill("10");
  await confirm(page, "pledge-confirm");
  await until(() => view<{ usdc: string } | null>("pledge_of", { proposal_id: pid, account_id: JUDGE }), (p) => p !== null && BigInt(p.usdc) === 10n * E18, "pledged 10 USDC");
  await expect(demo(page, "pledge-progress")).toBeVisible();
  await expect(demo(page, "my-pledge")).toContainText("10.00");
  await shot(page, "f-proposal-pledged");

  const pledgeGone = async () => {
    const p = await view<{ usdc: string } | null>("pledge_of", { proposal_id: pid, account_id: JUDGE });
    return p === null || BigInt(p.usdc) === 0n;
  };
  await confirm(page, "pledge-withdraw", pledgeGone);
  await until(() => view<{ usdc: string } | null>("pledge_of", { proposal_id: pid, account_id: JUDGE }), (p) => p === null || BigInt(p.usdc) === 0n, "pledge withdrawn");
  await page.reload();
  await confirm(page, "cancel-proposal", async () => (await view<{ status: string }>("get_proposal", { proposal_id: pid })).status === "cancelled");
  await until(() => view<{ status: string }>("get_proposal", { proposal_id: pid }), (x) => x.status === "cancelled", "proposal cancelled");
  const after = await view<{ blocker: string | null; live_proposal: number | null }>("market_check", { event_ids: COMBO });
  expect(after.live_proposal).toBeNull();
  await page.context().close();
});

const deadlineInput = (daysAhead: number): string => new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 11) + "12:00";

async function proposeEvent(page: Page, tag: string): Promise<number> {
  await page.goto("/propose/?kind=event");
  await connected(page, JUDGE);
  const form = demo(page, "propose-event-form");
  await expect(form).toBeVisible();
  await demo(page, "propose-question").fill(`Smoke ${tag}: will the staging smoke test pass on ${deadlineInput(30).slice(0, 10)}?`);
  await demo(page, "propose-outcome-0").fill("PASS");
  await demo(page, "propose-outcome-1").fill("FAIL");
  await demo(page, "propose-rule").fill(`PASS if the IfVerse staging smoke run ${tag} is green at the deadline, otherwise FAIL. [ifverse:smoke:${tag}]`);
  await demo(page, "propose-source").fill("github.com/near/nearcore releases");
  await demo(page, "propose-deadline").fill(deadlineInput(30));
  await demo(page, "propose-category-0").click();
  return propose(page);
}

test("Kind A ×2 and the admin: approve one, reject one, pause and unpause a flag", async ({ browser }) => {
  // a re-run picks up the judge's new events still in review
  const waiting = (await proposalsOf(JUDGE, "review")).filter((p) => p.kind === "new_event").map((p) => p.proposal_id);
  await fundJudgeFor(NEAR);
  const page = await as(browser, JUDGE);
  const stamp = Date.now().toString(36);
  const approveId = waiting[0] ?? (await proposeEvent(page, `${stamp}a`));
  await page.goto(`/proposal/?p=${approveId}`);
  await expect(demo(page, "proposal-status")).toContainText(/review/i);
  await shot(page, "f-kind-a");
  const rejectId = waiting[1] ?? (await proposeEvent(page, `${stamp}r`));
  const owner = await as(browser, ROOT);
  await owner.goto("/admin/");
  await connected(owner, ROOT);
  await expect(demo(owner, "ops")).toBeVisible();
  await expect(demo(owner, "ops-version").first()).toContainText("2.0.0");
  for (const id of [approveId, rejectId]) await expect(demo(owner, "admin-proposal").filter({ hasText: `#${id}` }).first()).toBeVisible();
  await shot(owner, "f-admin");

  await owner.goto(`/proposal/?p=${approveId}`);
  for (const check of ["binary", "source", "uncausable"]) await demo(owner, `check-${check}`).check();
  const status = async (id: number) => (await view<{ status: string }>("get_proposal", { proposal_id: id })).status;
  await confirm(owner, "approve-confirm", async () => (await status(approveId)) === "pledging");
  await until(() => view<{ status: string }>("get_proposal", { proposal_id: approveId }), (x) => x.status === "pledging", "approved");
  await owner.goto(`/proposal/?p=${rejectId}`);
  await expect(demo(owner, "reject-forfeit")).not.toBeChecked();
  await confirm(owner, "reject-confirm", async () => (await status(rejectId)) === "rejected");
  await until(() => view<{ status: string }>("get_proposal", { proposal_id: rejectId }), (x) => x.status === "rejected", "rejected");

  // pause `pledge`, then unpause it
  await owner.goto("/admin/");
  await owner.locator('[data-demo="pause-flag-pledge"]').check();
  await demo(owner, "pause-reason").fill("staging smoke: pause and unpause");
  const paused = async () => (await view<{ paused: string[] }>("pause_state")).paused.includes("pledge");
  try {
    await confirm(owner, "pause-confirm", paused);
    await until(() => view<{ paused: string[] }>("pause_state"), (s) => s.paused.includes("pledge"), "pledge paused");
    await expect(demo(owner, "ops-pause")).toContainText(/pledge/i);
    await owner.reload();
    await owner.locator('[data-demo="pause-flag-pledge"]').check();
    await confirm(owner, "unpause-confirm", async () => !(await paused()));
    await until(() => view<{ paused: string[] }>("pause_state"), (s) => !s.paused.includes("pledge"), "pledge running again");
  } finally {
    // never leave the live contract paused because a test step failed
    if (await patient(paused)) {
      const r = await patient(() => signer(ROOT).signAndSendTransaction({ receiverId: CONTRACT, actions: [actions.functionCall("unpause", { flags: ["pledge"], liquidation_grace_sec: null }, 30_000_000_000_000n, 1n)], waitUntil: "FINAL" }));
      signed.push({ tx: { receiverId: CONTRACT, actions: [] }, hash: `${r.transaction.hash} (unpause after a failure)`, ok: true });
    }
  }
  await owner.context().close();

  // the approved one goes away again, with any an earlier run left: its proposer cancels it (a new event's bond is
  // never forfeit)
  const approved = new Set([approveId, ...(await proposalsOf(JUDGE, "pledging")).filter((p) => p.kind === "new_event").map((p) => p.proposal_id)]);
  for (const id of approved) {
    await page.goto(`/proposal/?p=${id}`);
    await confirm(page, "cancel-proposal", async () => (await status(id)) === "cancelled");
    await until(() => status(id), (x) => x === "cancelled", `#${id} cancelled`);
  }
  await page.context().close();
});

// ---- g. resolve (view only) ----

test("resolve: events with their sources (nothing reported)", async ({ browser }) => {
  const page = await as(browser, persona("bob"));
  await page.goto(`/resolve/?id=${SID}`);
  await expect(demo(page, "event-card").first()).toBeVisible();
  await expect(demo(page, "event-source").first()).toBeVisible();
  await shot(page, "g-resolve");
  await page.context().close();
});

// ---- h. the phone ----

test("phone 390 × 844: list, market, borrow, lend, propose fit the screen", async ({ browser }) => {
  const page = await as(browser, JUDGE, { viewport: PHONE });
  for (const [name, route] of [
    ["list", "/"],
    ["market-1", "/market/?id=1"],
    ["market-8", "/market/?id=8"],
    ["borrow", "/borrow/?id=1"],
    ["lend", "/lend/?id=1"],
    ["propose", "/propose/"],
    ["propose-event", "/propose/?kind=event"],
    ["split", "/split/?id=1"],
  ] as const) {
    await page.goto(route);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1_500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await shot(page, `h-phone-${name}`);
    expect.soft(overflow, `${route} overflows sideways by ${overflow}px`).toBeLessThanOrEqual(0);
  }
  await page.context().close();
});

// ---- cleanup: the judge's NEAR goes back to the root ----

test("cleanup: the judge withdraws its returned bonds (account sheet), spare NEAR goes back to the root", async ({ browser }) => {
  const sb = await view<{ total: string; available: string } | null>("storage_balance_of", { account_id: JUDGE });
  if (sb && BigInt(sb.available) >= 10n ** 22n) {
    const page = await as(browser, JUDGE);
    await page.goto("/");
    await connected(page, JUDGE);
    await demo(page, "account").first().click();
    await expect(demo(page, "storage-withdraw")).toContainText("free NEAR");
    await confirm(page, "storage-withdraw", async () => {
      const now = await view<{ available: string } | null>("storage_balance_of", { account_id: JUDGE });
      return now !== null && BigInt(now.available) < 10n ** 22n;
    });
    await page.context().close();
  }
  await walletIdle();
  // enough for a re-run's heaviest call by default; JUDGE_KEEP_MILLINEAR=50 leaves a one-off account almost empty
  const keep = (BigInt(process.env.JUDGE_KEEP_MILLINEAR || "400") * NEAR) / 1_000n;
  const spare = (await nearBalance(JUDGE)) - keep;
  if (spare > NEAR / 20n) {
    const r = await patient(() => signer(JUDGE).signAndSendTransaction({ receiverId: ROOT, actions: [actions.transfer(spare)], waitUntil: "FINAL" }));
    signed.push({ tx: { receiverId: ROOT, actions: [] }, hash: r.transaction.hash, ok: true });
  }
});
