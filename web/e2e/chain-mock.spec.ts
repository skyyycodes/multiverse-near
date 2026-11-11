// The real build end to end with the chain stood in for: RPC view calls are answered from the seeded-demo fixtures
// (same account ids as the testnet deploy), and the demo wallet bridge records what the app asks it to sign. This
// checks the parts the fixture build skips: near-api-js decoding, NEAR Connect, the ft_transfer_call encoding, and
// reading a refund as a failure.
import { expect, test, type Page, type Route } from "@playwright/test";
import type { Stage } from "../src/lib/fixtures/golden";
import { createFixtureSource } from "../src/lib/fixtures/source";

const ALICE = "alice.multiverse-lending.testnet";
const CONTRACT = "app.multiverse-lending.testnet";
const b64 = (s: string) => Buffer.from(s).toString("base64");

type Signed = { receiverId: string; actions: { type: string; params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string } }[] };

async function serveChain(page: Page, stage?: Stage) {
  const fixtures = createFixtureSource(stage);
  await page.route(/test\.rpc\.fastnear\.com|rpc\.testnet\.fastnear\.com|near-testnet\.drpc\.org/, async (route: Route) => {
    const body = route.request().postDataJSON() as { id: string; method: string; params: Record<string, string> };
    if (body.method === "query" && body.params.request_type === "call_function") {
      const args = JSON.parse(Buffer.from(body.params.args_base64, "base64").toString() || "{}");
      try {
        const value = await fixtures.view(body.params.account_id, body.params.method_name, args);
        const bytes = Array.from(Buffer.from(JSON.stringify(value)));
        await route.fulfill({ json: { jsonrpc: "2.0", id: body.id, result: { result: bytes, logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" } } });
      } catch (e) {
        const error = `wasm execution failed with error: HostError(GuestPanic { panic_msg: "${(e as Error).message}" })`;
        await route.fulfill({ json: { jsonrpc: "2.0", id: body.id, result: { error, logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" } } });
      }
      return;
    }
    await route.fulfill({ status: 500, json: { error: "not mocked" } });
  });
}

/** The recorder's signer, scripted: every transaction is recorded; `outcome` decides what the chain answers. */
async function demoWallet(page: Page, signed: Signed[], outcome: (tx: Signed) => unknown) {
  await page.exposeFunction("__nearDemo", (method: string, json: string) => {
    if (method === "signIn" || method === "getAccounts") return JSON.stringify([{ accountId: ALICE }]);
    if (method === "signAndSendTransaction") {
      const tx = JSON.parse(json) as Signed;
      signed.push(tx);
      return JSON.stringify(outcome(tx));
    }
    return "";
  });
  await page.addInitScript(() => {
    (window as unknown as { __nearDemoAutoConnect: boolean }).__nearDemoAutoConnect = true;
  });
}

/** What the RPC reports for an ft_transfer_call whose ft_on_transfer used everything, or panicked and was refunded. */
function ftOutcome(tx: Signed, panic?: string) {
  const amount = String(tx.actions[0].params.args.amount);
  const used = panic ? "0" : amount;
  return {
    status: { SuccessValue: b64(JSON.stringify(used)) },
    transaction: { hash: "8jTEMa2VgouhRVoAzpfrbfrXVdA4UXBDs62VFoEyg4Tn" },
    transaction_outcome: { id: "8jTEMa2VgouhRVoAzpfrbfrXVdA4UXBDs62VFoEyg4Tn" },
    receipts_outcome: [
      { id: "r1", outcome: { executor_id: tx.receiverId, status: { SuccessReceiptId: "r2" }, logs: [] } },
      {
        id: "r2",
        outcome: {
          executor_id: CONTRACT,
          status: panic ? { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${panic}` } } } } } : { SuccessValue: b64('"0"') },
          logs: [],
        },
      },
      { id: "r3", outcome: { executor_id: tx.receiverId, status: { SuccessValue: b64(JSON.stringify(used)) }, logs: [] } },
    ],
  };
}

test("the sale is one ft_transfer_call of 2 WETH carrying the plan, and the app reports it done", async ({ page }) => {
  const signed: Signed[] = [];
  await serveChain(page);
  await demoWallet(page, signed, (tx) => ftOutcome(tx));
  await page.goto("/");
  await expect(page.locator('[data-demo="account"]')).toHaveAttribute("aria-label", `Account ${ALICE}`);
  await expect(page.locator('[data-demo="sell-wallet"]')).toHaveText("wallet: 2.0000 WETH");
  for (const w of ["DELAYED·CUTS", "SHIPS·HOLDS", "DELAYED·HOLDS"]) await page.locator(`[data-demo="world-card"][data-world="${w}"]`).click();
  await expect(page.locator('[data-demo="sell-confirm"]')).toHaveText("Sell in 3 worlds");
  await page.locator('[data-demo="sell-confirm"]').click();
  await expect(page.locator('[data-demo="sell-confirm-result"]')).toContainText("Done · 8jTEMa2Vgo…");

  expect(signed).toHaveLength(1);
  const tx = signed[0];
  expect(tx.receiverId).toBe("weth.multiverse-lending.testnet");
  const call = tx.actions[0].params;
  expect(call).toMatchObject({ methodName: "ft_transfer_call", deposit: "1", gas: "300000000000000" });
  expect(call.args).toMatchObject({ receiver_id: CONTRACT, amount: "2000000000000000000", memo: null });
  const msg = JSON.parse(call.args.msg as string);
  expect(msg).toMatchObject({ action: "conditional_sell", scenario_id: 1, sell_mask: 14, to_lending: true });
  expect(msg.plans).toEqual([[], [], [], [{ order_id: "1", amount: "1000000000000000000" }]]);
  // Each sold world must pay at least its plan less 0.5% of its pool part; the unsold world asks for nothing.
  expect(msg.min_out[0]).toBe("0");
  expect(BigInt(msg.min_out[3])).toBeGreaterThan(4_850n * 10n ** 18n);
  expect(BigInt(msg.min_out[3])).toBeLessThan(4_881_885_259_897_065_638_949n);
});

test("a refunded transfer is shown as the contract's error, not as done", async ({ page }) => {
  const signed: Signed[] = [];
  await serveChain(page);
  await demoWallet(page, signed, (tx) => ftOutcome(tx, "StaleOrder(1, 0, 1)"));
  await page.goto("/sell/?sel=8");
  await expect(page.locator('[data-demo="sell-confirm"]')).toHaveText("Sell in 1 world");
  await page.locator('[data-demo="sell-confirm"]').click();
  await expect(page.locator('[data-demo="sell-confirm-result"]')).toHaveText("StaleOrder(1, 0, 1)");
  expect(signed).toHaveLength(1);
});

test("borrowing is a direct call with one yoctoNEAR, after the USDC registration check", async ({ page }) => {
  const signed: Signed[] = [];
  await serveChain(page, "sold");
  await demoWallet(page, signed, () => ({
    status: { SuccessValue: "" },
    transaction: { hash: "5Cxh1AWSoPb2xTwPkfa9tJzZtRqmmkpVSvjJT6gN4wqT" },
    receipts_outcome: [{ id: "r1", outcome: { executor_id: CONTRACT, status: { SuccessValue: "" }, logs: [] } }],
  }));
  await page.goto("/borrow/");
  await expect(page.locator('[data-demo="hero-hf"]')).toContainText("∞");
  await expect(page.locator('[data-demo="hero-hf"]')).toContainText("worst world: DELAYED·HOLDS");
  await page.locator('[data-demo="borrow-amount"]').fill("100");
  await expect(page.locator('[data-demo="hf-after"]')).toHaveText("36.61");
  await page.locator('[data-demo="borrow-confirm"]').click();
  await expect(page.locator('[data-demo="borrow-confirm-result"]')).toContainText("Done · 5Cxh1AWSoP…");
  expect(signed).toHaveLength(1);
  expect(signed[0].receiverId).toBe(CONTRACT);
  expect(signed[0].actions[0].params).toMatchObject({
    methodName: "borrow",
    deposit: "1",
    args: { scenario_id: 1, amount: "100000000000000000000" },
  });
});
