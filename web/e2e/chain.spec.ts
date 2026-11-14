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

const CONTRACT = "app.multiverse-near.testnet";

/** The contract's state version as the chain says (read-only RPC): 1 when `contract_version` does not exist (v1). */
async function stateVersion(): Promise<number> {
  const res = await fetch("https://test.rpc.fastnear.com", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "e2e",
      method: "query",
      params: { request_type: "call_function", finality: "optimistic", account_id: CONTRACT, method_name: "contract_version", args_base64: "e30=" },
    }),
  });
  const body = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: unknown };
  const bytes = body.result?.result;
  if (!bytes || body.error || body.result?.error) return 1;
  return (JSON.parse(Buffer.from(bytes).toString()) as { state_version: number }).state_version;
}

// W-0: the version gate on the production contract. Against state 1 (no `contract_version`) no screen renders, so no
// transaction can be built (WI-2); W-7 adds the v2 branch for when production runs v2.
test("a v1 contract gets the upgrade notice and no transaction button", async ({ page }) => {
  test.skip((await stateVersion()) >= 2, "production runs v2: the v2 branch of this project covers it");
  for (const route of ["/borrow/", "/sell/", "/lend/"]) {
    await page.goto(route);
    await expect(page.locator('[data-demo="upgrade-notice"]')).toContainText("IfVerse is being upgraded", { timeout: 30_000 });
    await expect(page.locator('[data-demo="upgrade-notice"]')).toContainText("still runs version 1.0.0");
    await expect(page.locator("button[data-tx]")).toHaveCount(0);
  }
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
