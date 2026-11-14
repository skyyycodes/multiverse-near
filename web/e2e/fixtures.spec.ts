// UI behaviour against the design fixtures (the seeded demo replayed in the browser): the acceptance flow of the
// spec, screen by screen, on a phone and on a desktop. Nothing here talks to a chain.
import { expect, test, type Page } from "@playwright/test";

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 1024;

/** A world on the grid: the picker pill on a phone, the card on a desktop. */
const world = (page: Page, label: string) =>
  isPhone(page) ? page.locator(`[data-demo="world-pick"][data-world="${label}"]`) : page.locator(`[data-demo="world-card"][data-world="${label}"]`);

test("first visit shows the landing, and looking around opens the home", async ({ page }) => {
  await page.goto("/?fx=seeded");
  await expect(page.locator('[data-demo="landing-headline"]')).toHaveText("What if your what-ifs became worlds?");
  await page.locator('[data-demo="welcome-skip"]').click();
  await expect(page.locator('[data-demo="hero-spot"]')).toContainText("$3.0378");
});

test("the home shows every world backed, and the market in the URL changes the grid", async ({ page }) => {
  await page.goto("/?fx=seeded&welcome=0");
  const worlds = isPhone(page) ? page.locator('[data-demo="future-row"]') : page.locator('[data-demo="world-card"]');
  await expect(worlds).toHaveCount(4);
  await expect(page.locator('[data-demo="stat-backing"]')).toContainText("✓ all backed");
  await expect(page.locator('[data-demo="stat-actual-spot"]')).toContainText("$3.0378");
  await expect(page.locator('[data-demo="stat-implied-spot"]')).toContainText("equal to actual");
  await page.goto("/market/?id=2&welcome=0");
  await expect(worlds).toHaveCount(2);
  await page.goto("/market/?id=1&welcome=0");
  await expect(worlds).toHaveCount(4);
});

test("Alice sells in three worlds: Ravi's bid fills first, one transaction, collateral lands", async ({ page }) => {
  await page.goto(isPhone(page) ? "/sell/?fx=seeded&as=alice" : "/?fx=seeded&as=alice");
  await expect(page.locator('[data-demo="sell-wallet"]')).toHaveText("wallet: 2,000.00 wNEAR");
  const confirm = page.locator('[data-demo="sell-confirm"]');
  await expect(confirm).toHaveText("Tap the worlds you fear on the grid");
  for (const label of ["DELAYED·CUTS", "SHIPS·HOLDS", "DELAYED·HOLDS"]) await world(page, label).click();
  await expect(world(page, "DELAYED·HOLDS")).toHaveAttribute("aria-pressed", "true");
  await expect(confirm).toHaveText("Sell in 3 worlds");
  const dh = page.locator('[data-demo="sell-row"][data-world="DELAYED·HOLDS"]');
  await expect(dh).toContainText("sell via a bid + pool → 4,881.88 USDC");
  await expect(dh.locator('[data-demo="plan-legs"]')).toContainText("bid #1 · 1,000.00 NEAR @ $2.4500");
  await expect(dh.locator('[data-demo="plan-legs"]')).toContainText("pool · 1,000.00 NEAR");
  // the bid leg fits its row, at 390 px too: nothing is cut off
  const legs = dh.locator('[data-demo="plan-legs"] li');
  for (let i = 0; i < (await legs.count()); i++) {
    expect(await legs.nth(i).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await expect(page.locator('[data-demo="sell-row"][data-world="SHIPS·CUTS"]')).toContainText("keep → 2,000.00 NEAR");
  await expect(page.locator('[data-demo="sell-row"][data-world="DELAYED·CUTS"]')).toContainText("5,865.05 USDC");
  await confirm.click();
  await expect(page.locator('[data-demo="sell-confirm-result"]')).toContainText("Done · ");
  if (isPhone(page)) {
    await page.goto("/?fx=sold&as=alice");
    await expect(page.locator('[data-demo="future-row"][data-world="DELAYED·HOLDS"]')).toContainText("you: 4,881.88 USDC");
  } else {
    await expect(page.locator('[data-demo="world-card"][data-world="SHIPS·CUTS"]')).toContainText("You hold 2,000.00 NEAR here · loan collateral");
    await expect(page.locator('[data-demo="world-card"][data-world="DELAYED·HOLDS"]')).toContainText("You hold 4,881.88 USDC here · loan collateral");
  }
});

test("blockers come in the spec's order", async ({ page }) => {
  await page.goto("/sell/?fx=seeded&as=alice&sel=8");
  const confirm = page.locator('[data-demo="sell-confirm"]');
  await expect(confirm).toHaveText("Sell in 1 world");
  await page.locator('[data-demo="sell-amount"]').fill("2500");
  await expect(confirm).toHaveText("Not enough wNEAR in this wallet");
  await page.locator('[data-demo="sell-amount"]').fill("");
  await expect(confirm).toHaveText("Enter an amount of NEAR");
  await page.goto("/sell/?fx=proposed&as=alice&sel=8");
  await expect(page.locator('[data-demo="sell-confirm"]')).toHaveText("Trading pauses while a resolution is pending");
});

test("borrowing 3,000 against the worst world gives a health factor of 1.22", async ({ page }) => {
  await page.goto("/borrow/?fx=sold&as=alice");
  await expect(page.locator('[data-demo="hero-hf"]')).toContainText("∞");
  await expect(page.locator('[data-demo="hero-hf"]')).toContainText("worst world: DELAYED·HOLDS");
  await expect(page.locator('[data-demo="posted-collateral"] li')).toHaveCount(4);
  await page.locator('[data-demo="borrow-amount"]').fill("3000");
  await expect(page.locator('[data-demo="hf-after"]')).toHaveText("1.22");
  await page.locator('[data-demo="borrow-confirm"]').click();
  await expect(page.locator('[data-demo="borrow-confirm-result"]')).toContainText("Done · ");
  await expect(page.locator('[data-demo="hero-hf"]')).toContainText("1.22");
});

test("an unhedged loan shows as liquidatable, then paused while a result is pending", async ({ page }) => {
  await page.goto("/borrow/?fx=pushed&as=carl");
  await expect(page.locator('[data-demo="badge-liquidatable"]')).toHaveText("Liquidatable");
  await expect(page.locator('[data-demo="liquidatable-banner"]')).toContainText("Health factor below 1");
  await page.goto("/borrow/?fx=proposed&as=carl");
  await expect(page.locator('[data-demo="badge-paused"]')).toHaveText("Liquidation paused");
});

test("the order book: accept an ask, and a crossing bid points at it", async ({ page }) => {
  await page.goto("/orders/?w=0&fx=book&as=sam");
  if (!isPhone(page)) await expect(page.getByRole("tab", { name: "Order book" })).toHaveAttribute("aria-selected", "true");
  // the title sits in the phone's header and at the top of the desktop sheet
  await expect(page.locator("main")).toContainText("Order book · SHIPS·CUTS");
  const ladder = page.locator('[data-demo="ladder"]');
  await expect(ladder).toContainText("$3.7500");
  await expect(ladder).toContainText("pool price");
  await ladder.locator('[data-demo="ladder-row"][data-side="ask"]', { hasText: "$3.7500" }).locator('[data-demo="accept"]').click();
  await expect(page.locator('[data-demo="accept-box"]')).toContainText("Buy from ask #2 at $3.7500");
  await expect(page.locator('[data-demo="accept-box"]')).toContainText("Pay 1,875.00 USDC; get 500.00 NEAR-if-SHIPS·CUTS");
  await expect(page.locator('[data-demo="accept-confirm"]')).toHaveText("Confirm");
  await page.locator('[data-demo="post-price"]').fill("3.80");
  await page.locator('[data-demo="post-amount"]').fill("100");
  await expect(page.locator('[data-demo="post-form"]')).toContainText("This bid crosses ask #2 at $3.7500, which is already there.");
  await expect(page.locator('[data-demo="my-orders"]')).toContainText("#4 bid $3.5250");
});

test("resolution: the dispute window counts down, and after both events Alice closes and redeems", async ({ page }) => {
  await page.goto("/resolve/?fx=proposed&as=alice");
  await expect(page.locator('[data-demo="scenario-status"]')).toContainText("paused: resolution pending");
  await expect(page.locator('[data-demo="event-badge"]', { hasText: "Proposed: HOLDS" })).toBeVisible();
  await expect(page.locator('[data-demo="finalize"]')).toHaveText(/Finalize in 0:\d\d/);
  await page.goto("/resolve/?fx=collapsed&as=alice");
  await expect(page.locator('[data-demo="survivors"]')).toContainText("Only DELAYED·HOLDS is still possible");
  await expect(page.locator('[data-demo="close-pieces"]')).toContainText("collapsed: redeemed 1:1 for real USDC");
  await expect(page.locator('[data-demo="close-receive"]')).toContainText("4,881.88 USDC");
  await page.locator('[data-demo="close-confirm"]').click();
  await expect(page.locator('[data-demo="close-result"]')).toHaveText("Repaid $3,000.41; redeemed 4,881.88 real USDC.");
});

test("the admin sees owner controls and the price push quote", async ({ page }) => {
  await page.goto("/admin/?fx=lp&as=owner");
  await expect(page.locator('[data-demo="owner-status"]')).toHaveText("✓ Connected as the oracle owner");
  const pick = isPhone(page) ? '[data-demo="push-pick"][data-world="DELAYED·HOLDS"]' : '[data-demo="world-card"][data-world="DELAYED·HOLDS"]';
  await page.locator(pick).click();
  await page.locator('[data-demo="push-amount"]').fill("3000");
  await expect(page.locator('[data-demo="push-confirm"]')).toHaveText("Push DELAYED·HOLDS down");
  await expect(page.locator('[data-demo="mint-wnear"]')).toHaveText("Mint 3,000.00 test wNEAR to my wallet");
  await expect(page.locator('[data-demo="reset-command"]')).toContainText("reset");
});

test("every screen shows Ravi's bid as DELAYED·HOLDS's best bid, Resolve and Admin included", async ({ page }) => {
  for (const route of ["/?fx=seeded&welcome=0", "/resolve/?fx=seeded", "/admin/?fx=seeded&as=owner"]) {
    await page.goto(route);
    if (isPhone(page)) {
      if (route.startsWith("/admin")) continue; // the phone's admin screen has no world list
      await expect(page.locator('[data-demo="future-row"][data-world="DELAYED·HOLDS"]')).toContainText("best bid $2.45");
    } else {
      const card = page.locator('[data-demo="world-card"][data-world="DELAYED·HOLDS"]');
      await expect(card).toContainText("best bid");
      await expect(card).toContainText("$2.45");
      await expect(card).not.toContainText("best bid—");
    }
  }
});

test("the grid names each axis's question once, in full", async ({ page }) => {
  test.skip(isPhone(page), "the big grid is desktop only");
  await page.goto("/?fx=seeded&welcome=0");
  const axes = page.locator('[data-demo="grid-axes"]');
  await expect(axes).toContainText("Will SPICE ship on NEAR mainnet by Mar 31, 2027?");
  await expect(axes).toContainText("Will the Fed cut at its December meeting?");
  await expect(page.locator('[data-demo="world-grid"]').getByText("Will the Fed cut at its December meeting?")).toHaveCount(1);
  await expect(axes.locator('[title="Will SPICE ship on NEAR mainnet by Mar 31, 2027?"]')).toHaveCount(1);
});

test("the past Fed decision, outside the grid, says nothing about worlds once resolved", async ({ page }) => {
  await page.goto("/resolve/?fx=sold&as=alice");
  const past = page.locator('[data-demo="past-fed"]');
  await expect(past).toContainText("finalizing it removes no worlds");
  await expect(past.locator('[data-demo="event-status"]')).toContainText("Resolved HOLDS by the resolver.");
  await expect(past).not.toContainText("gone for good");
});

test("the desktop top bar links the global screens, the trade sheet the order book", async ({ page }) => {
  test.skip(isPhone(page), "the phone has its own navigation");
  await page.goto("/market/?id=1&fx=seeded&welcome=0");
  await expect(page.locator('[data-demo="nav-markets"]')).toHaveAttribute("aria-current", "page");
  await page.getByRole("tab", { name: "Order book" }).click();
  await expect(page.getByRole("tab", { name: "Order book" })).toHaveAttribute("aria-selected", "true");
  await page.locator('[data-demo="nav-admin"]').click();
  // the admin link carries no market; the last one opened here comes back into the URL
  await expect(page).toHaveURL(/\/admin\/\?id=1$/);
  await expect(page.locator('[data-demo="nav-admin"]')).toHaveAttribute("aria-current", "page");
  for (const hook of ["nav-liquidate", "nav-propose"]) await expect(page.locator(`[data-demo="${hook}"]`)).toBeVisible();
});

// W-0: every market screen sits behind the market guard; the v1 screens still render there for market 1.
test.describe("the market guard", () => {
  test("renders the v1 screens for id=1", async ({ page }) => {
    await page.goto("/market/?id=1&fx=seeded&welcome=0");
    await expect(page.locator('[data-demo="hero-spot"]')).toContainText("$3.0378");
    await page.goto("/sell/?id=1&fx=seeded&as=alice");
    await expect(page.locator('[data-demo="sell-wallet"]')).toHaveText("wallet: 2,000.00 wNEAR");
    await page.goto("/borrow/?id=1&fx=sold&as=alice");
    await expect(page.locator('[data-demo="hero-hf"]')).toContainText("worst world: DELAYED·HOLDS");
    await page.goto("/lend/?id=1&fx=seeded&as=bob");
    await expect(page.locator('[data-demo="lend"]')).toBeVisible();
    await page.goto("/resolve/?id=1&fx=proposed&as=alice");
    await expect(page.locator('[data-demo="scenario-status"]')).toContainText("paused: resolution pending");
    await page.goto("/orders/?id=1&w=0&fx=book&as=sam");
    await expect(page.locator("main")).toContainText("Order book · SHIPS·CUTS");
    await page.goto("/world/?id=1&w=3&fx=seeded");
    await expect(page.locator("main")).toContainText("DELAYED·HOLDS");
    await page.goto("/admin/?id=1&fx=lp&as=owner");
    await expect(page.locator('[data-demo="owner-status"]')).toHaveText("✓ Connected as the oracle owner");
  });

  test("adds the market to an old link and keeps its params", async ({ page }) => {
    await page.goto("/sell/?sel=14&fx=seeded&as=alice");
    await expect(page).toHaveURL(/\/sell\/\?sel=14&fx=seeded&as=alice&id=1$/);
    await expect(page.locator('[data-demo="sell-confirm"]')).toHaveText("Sell in 3 worlds");
  });

  test("says when the id is not a market", async ({ page }) => {
    await page.goto("/market/?id=99&fx=seeded&welcome=0");
    await expect(page.locator("main")).toContainText("No market #99 on this deployment");
    await page.goto("/borrow/?id=05&fx=seeded");
    await expect(page.locator("main")).toContainText("Not a market id");
    await expect(page.locator("button[data-tx]")).toHaveCount(0);
  });

  test("names the network and the versions", async ({ page }) => {
    await page.goto("/market/?id=1&fx=seeded&welcome=0");
    // the screen first, so the badge clicked is the screen's own (not the loading frame's)
    await expect(page.locator('[data-demo="hero-spot"]')).toContainText("$3.0378");
    const badge = page.locator('[data-demo="network-badge"]').first();
    await expect(badge).toContainText(isPhone(page) ? "testnet" : "testnet v2.0.0");
    await badge.click();
    await expect(page.locator('[data-demo="about-version"]')).toContainText("2.0.0 · state 2");
    await expect(page.locator('[data-demo="about-web"]')).toContainText("2.0.0");
    await expect(page.locator('[data-demo="about-contract"]')).toContainText("app.multiverse-near.testnet");
    await expect(page.locator('[data-demo="about-code-hash"]')).toContainText("G6GtUs6AqHfxRb8YCdBx5dv1bgiQ3c1gDhPE9ygQTkEt");
  });
});
