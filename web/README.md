# Multiverse web app

The browser app for Multiverse Lending on NEAR: pick the futures you fear, sell NEAR only there, borrow real USDC
against your worst one, lend, underwrite every world, and close out when the events resolve.

Next.js (App Router, static export) · React 19 · TypeScript strict · Tailwind 4 · framer-motion · TanStack Query ·
NEAR Connect (`@hot-labs/near-connect` 0.12.0) · `near-api-js` 7.4.0. No server, no API routes: every read goes from
the browser to a NEAR RPC, every write is signed by the user's wallet.

## Run it

Node 22 and pnpm 10.

```bash
pnpm install
pnpm dev               # http://localhost:3040, reads app.multiverse-near.testnet on testnet
pnpm dev:sandbox       # the same app against the local sandbox node (pnpm -C scripts sandbox start), demo wallet on
pnpm dev:fixtures      # same app on design data: the seeded demo replayed in the browser, no chain needed
```

With the fixtures you can open any stage of the demo story as any of its people, e.g.
`http://localhost:3040/sell/?fx=seeded&as=alice&sel=14` (Alice about to sell in the L-shape) or
`/resolve/?fx=collapsed&as=alice`. Stages: `seeded`, `sold`, `borrowed`, `book`, `lp`, `pushed`, `proposed`, `fed`,
`collapsed`; people: `alice`, `bob`, `ravi`, `sam`, `uma`, `carl`, `dana`, `owner`. Design data is labelled as such
and signs nothing.

Static build (any static host serves `out/`):

```bash
pnpm build && pnpm serve                       # out/ on http://localhost:3040
pnpm build:fixtures && pnpm serve:fixtures     # out-fixtures/ on http://localhost:3041
```

## Configuration

The network decides everything else. `next.config.ts` reads `deployments/<network>.json` (written by the scripts
package; `scripts/network.mjs` does the reading, `pnpm network sandbox` prints the result) on every dev start and
build, and inlines the values. A variable set in the environment wins over the file. The dev server runs on 3040
because the sandbox node's RPC takes 3030.

| Variable | Default | |
|---|---|---|
| `NEXT_PUBLIC_NETWORK` | `testnet` | `testnet` or `sandbox`: which deployment file to read. Wallets always sign on testnet (NEAR Connect knows no other); the RPC decides where reads go |
| `NEXT_PUBLIC_RPC_URL` | the file's `rpcUrl` | Reads go here; on testnet two public RPCs follow it as fallbacks |
| `NEXT_PUBLIC_RPC_URLS` | unset | Comma-separated list replacing the above, tried in order on transport errors |
| `NEXT_PUBLIC_CONTRACT_ID` | the file's `contractId` | The Multiverse contract; the demo scenario ids come from its `get_app_config` |
| `NEXT_PUBLIC_WNEAR_ID`, `NEXT_PUBLIC_USDC_ID` | the file's `wnear`, `usdc` | Checked against `get_app_config`: a build made for another deployment says so instead of reading the wrong balances |
| `NEXT_PUBLIC_EXPLORER` | the file's `explorer` | Transaction links; none on the sandbox |
| `NEXT_PUBLIC_RESET_COMMAND` | `RUN_SALE=false pnpm -C scripts reset` | What the Admin screen tells the operator to run |
| `NEXT_PUBLIC_FIXTURES` | `0` | `1` serves design data instead of the chain |
| `NEXT_PUBLIC_DEMO_WALLET` | `0` | `1` accepts the test-key wallet of the recorder and the end-to-end runs (`DEMO-SELECTORS.md`) |

Fixtures and the demo wallet are loaded through dynamic imports behind those two flags, which are always defined at
build time, so a plain `pnpm build` contains neither.

## Checks

```bash
pnpm typecheck     # next typegen + tsc --noEmit
pnpm lint          # eslint (next core-web-vitals + typescript)
pnpm test          # vitest: formatting, units, order book and sale planner, settlement, lending, spot maths,
                   # transaction encoding, outcome parsing, the testnet faucet, and the seeded demo's golden numbers
pnpm build:fixtures && pnpm build:demo && pnpm build && pnpm e2e
                   # Playwright: the acceptance flow on a phone and a desktop (design data), the real build
                   # against testnet, and the demo-wallet build signing against a stand-in RPC
```

The acceptance flow against a real chain, on a fresh local node (wasms built into `target/deploy/` by
`scripts/build-wasm.sh`; `MULTIVERSE_WASM` / `MOCK_FT_WASM` point elsewhere):

```bash
pnpm -C scripts build:wasm
pnpm -C scripts sandbox start --fresh && NEAR_NETWORK=sandbox pnpm -C scripts seed
pnpm build:live && pnpm e2e:live   # SHOTS_DIR=<dir> keeps a 1440 × 900 and a 390 × 844 capture of every step
pnpm -C scripts sandbox stop
```

It signs with the personas' keys in `.keys/sandbox/`: Alice's L-shape sale with Ravi's bid (5,865.05 / 6,451.55 /
4,881.88), the 3,000 USDC borrow (health factor 1.22), Ravi's quotes and Sam taking the ask, Uma's Root LP deposit and
withdrawal, the resolver's proposal through its dispute window, the owner's override, and Alice's close and redeem,
each checked against the contract's views. It changes the chain, so start from a fresh node for every run.

Screenshots of every screen and state at 390 × 844 and 1440 × 900: `pnpm serve:fixtures`, then
`node scripts/shots.mjs http://localhost:3041 <dir>`.

## How it fits together

- `src/lib/hooks/useData.ts`: one TanStack query per contract view (`trade_view`, `borrow_view`, `lend_view`,
  `resolve_view`, `admin_view`, `quote_sell`, `quote_sell_parts`, `preview_lp_deposit`, NEP-141/NEP-145 reads),
  polled every 4 s (quotes 6 s; 2 s while a result is in its dispute window). A query never shows another scenario's
  numbers while it reloads.
- `src/lib/near/rpc.ts`: view calls at optimistic finality over plain JSON-RPC, across several RPCs. It moves to the
  next RPC only on HTTP and network trouble or a node that is not ready; a contract's own answer ("does not exist", a
  view panic) comes straight back with its message.
- `src/lib/near/wallet.tsx`: NEAR Connect, loaded only in the browser. `demo-bridge.ts` adds the test-key wallet the
  walkthrough recorder and the end-to-end tests use (see `DEMO-SELECTORS.md`).
- `src/lib/near/tx.ts` and `src/lib/hooks/useTx.ts`: every real-token action is one `ft_transfer_call` with a JSON
  `msg` (no approvals; unused tokens are refunded by the token contract); everything else is a direct call with
  1 yoctoNEAR. A transfer the contract refused (`ft_on_transfer` panicked, tokens refunded, transaction still
  "successful") is reported as the contract's error, and one whose used amount cannot be read counts as failed, never
  "Done". Storage registration (NEP-145 on Multiverse, and on the payout
  token before a payout) runs first when needed.
- Amounts are bigint throughout. The contract keeps every amount in 18 decimals; wallet balances (`ft_balance_of`)
  arrive in token units and are scaled once (`lib/units.ts`). Formatting truncates and percentages round half up
  (`lib/format.ts`). A NEAR price never shows in whole dollars: two decimals by default, four where cents would hide
  a difference (spot against implied spot, fair price, cost per NEAR, order prices); NEAR amounts show with two.
- `src/lib/orders.ts`: the order book in the browser and the sale planner (best bids first while they beat the pool,
  the rest to the pool, at most 5 per world, your own orders skipped, 0.5% slippage on the pool part only).
- `src/lib/fixtures/`: the design data, built from the seeded demo with the pools' own constant-product maths, so
  the numbers on screen are the demo's (4,748.29 pool alone; 4,881.88 with Ravi's bid; health factor 1.22).
- `src/components/`: one folder per screen; `world/` holds the world cards, picker and hues; `shell/` the frame (top
  bar on desktop, floating navigation on a phone, from 1024 px the two-column layout).

Design: deep navy and ice with one hue per world (SHIPS·CUTS cyan, DELAYED·CUTS violet, SHIPS·HOLDS blue,
DELAYED·HOLDS magenta), white sheets over the dark header, Space Grotesk numerals, Inter text. Phone first at
390 px; every screen also has a desktop layout.
