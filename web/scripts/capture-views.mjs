// Captures the view answers src/lib/decode.live.test.ts decodes, from a node right after
// `pnpm -C scripts sandbox start --fresh` and `NEAR_NETWORK=sandbox pnpm -C scripts seed` (scenario 1, events 1-3):
//
//   node web/scripts/capture-views.mjs [rpc] [contract] > web/src/lib/testdata/sandbox-views.json
//
// Amounts are internal 18-decimal units, as the views take them.

const RPC = process.argv[2] ?? "http://127.0.0.1:3030";
const CONTRACT = process.argv[3] ?? "app.test.near";
const ALICE = "alice.test.near";
const BOB = "bob.test.near";
const E18 = 10n ** 18n;

async function view(method, args) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: method,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: CONTRACT,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const body = await res.json();
  if (body.error || body.result?.error) throw new Error(`${method}: ${JSON.stringify(body.error ?? body.result.error)}`);
  return JSON.parse(Buffer.from(body.result.result).toString());
}

const views = {
  get_app_config: await view("get_app_config", {}),
  trade_view: await view("trade_view", { scenario_id: 1, account_id: ALICE }),
  borrow_view: await view("borrow_view", { scenario_id: 1, account_id: ALICE }),
  lend_view: await view("lend_view", { scenario_id: 1, account_id: BOB }),
  resolve_view: await view("resolve_view", { scenario_id: 1, account_id: ALICE }),
  admin_view: await view("admin_view", { scenario_id: 1, account_id: ALICE }),
  preview_lp_deposit: await view("preview_lp_deposit", {
    scenario_id: 1,
    wnear_amount: (5_000n * E18).toString(),
    usdc_amount: (20_000n * E18).toString(),
  }),
  quote_sell: await view("quote_sell", { scenario_id: 1, wnear_amount: (2_000n * E18).toString(), sell_mask: 14 }),
  get_pool: await view("get_pool", { pool_id: 1 }),
  storage_balance_of: await view("storage_balance_of", { account_id: ALICE }),
  storage_balance_bounds: await view("storage_balance_bounds", {}),
};
process.stdout.write(`${JSON.stringify(views, null, 1)}\n`);
