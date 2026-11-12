// Builds reading testnet: whatever state the deployment is in, the app says so instead of failing. In the demo-wallet
// build ("demo" project) the wallet the walkthrough recorder injects through `window.__nearDemo` connects through NEAR
// Connect; the real build ("chain" project) ignores it.
import { expect, test, type Page } from "@playwright/test";

const ALICE = "alice.multiverse-near.testnet";

/** Stands in for the recorder's signer: answers NEAR Connect's wallet methods with Alice's account. */
async function exposeDemoWallet(page: Page, calls: string[]) {
  await page.exposeFunction("__nearDemo", (method: string, paramsJson: string) => {
    calls.push(method);
    JSON.parse(paramsJson);
    if (method === "signIn" || method === "getAccounts") return JSON.stringify([{ accountId: ALICE, publicKey: "ed25519:11111111111111111111111111111111" }]);
    if (method === "signOut") return "";
    throw new Error(`demo wallet: ${method} not scripted in this test`);
  });
}

test("reads the chain and says where the deployment stands", async ({ page }) => {
  await page.goto("/borrow/");
  await expect(
    page.getByText(/is not deployed on testnet yet|has not been seeded there yet|Health factor \(worst world\)/i).first(),
  ).toBeVisible({ timeout: 30_000 });
});

const demoOnly = () => test.skip(test.info().project.name !== "demo", "the demo-wallet build only");

test("a real build offers no demo wallet, even when the page has the bridge", async ({ page }) => {
  test.skip(test.info().project.name !== "chain", "the real build only");
  const calls: string[] = [];
  await exposeDemoWallet(page, calls);
  await page.addInitScript(() => {
    (window as unknown as { __nearDemoAutoConnect: boolean }).__nearDemoAutoConnect = true;
  });
  await page.goto("/lend/");
  await expect(page.locator('[data-demo="connect"]').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_500);
  await expect(page.locator('[data-demo="account"]')).toHaveCount(0);
  expect(calls).toEqual([]);
});

test("the injected demo wallet appears in NEAR Connect's picker and signs in", async ({ page }) => {
  demoOnly();
  const calls: string[] = [];
  await exposeDemoWallet(page, calls);
  await page.goto("/borrow/");
  await page.locator('[data-demo="connect"]').click();
  const entry = page.locator('.connect-item[data-type="multiverse-demo"]');
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.locator('[data-demo="account"]')).toHaveAttribute("aria-label", `Account ${ALICE}`);
  expect(calls).toContain("signIn");
  // a reload restores the session from the same bridge, without the picker
  await page.reload();
  await expect(page.locator('[data-demo="account"]')).toHaveAttribute("aria-label", `Account ${ALICE}`);
});

test("the recorder can connect without the picker", async ({ page }) => {
  demoOnly();
  await exposeDemoWallet(page, []);
  await page.addInitScript(() => {
    (window as unknown as { __nearDemoAutoConnect: boolean }).__nearDemoAutoConnect = true;
  });
  await page.goto("/lend/");
  await expect(page.locator('[data-demo="account"]')).toHaveAttribute("aria-label", `Account ${ALICE}`);
});
