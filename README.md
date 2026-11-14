# Origami Verse

**What if your what-ifs became worlds?** A multiverse for the real world: hold NEAR in the futures you like
and dollars in the ones you fear.

Origami Verse was formerly IfVerse / Multiverse Lending. The testnet accounts (`*.ifverse-staging.testnet`), the web address and the repository keep earlier working names.

Demo video: (link)

Origami Verse lets you sell NEAR only in the futures you fear. Take two real-world events with two outcomes
each, for example "Will SPICE ship on NEAR mainnet by Mar 31, 2027?" and "Will the Fed cut at its December
meeting?". Each combination of outcomes is a world, so there are four: SHIPS·CUTS, DELAYED·CUTS, SHIPS·HOLDS and
DELAYED·HOLDS. One NEAR splits into one NEAR-if-world per world, each paying out only if that world comes true. You
trade each world in its own pool or order book, keep NEAR in the worlds you like and sell it for USDC-if-world in the
ones you fear, and borrow real USDC against your worst world. When the events resolve, the worlds that did not
happen die, and what you hold in the surviving world redeems 1:1 for real wNEAR or USDC.

Everything runs in one NEAR contract on NEAR testnet with mock tokens. Version 2 is live: the contract is
`app.ifverse-staging.testnet` and the web app is hosted at https://multiverse-lending.vercel.app. The first
version's contract, `app.multiverse-near.testnet`, is still on chain and unchanged.

- How it works: https://multiverse-lending.vercel.app/docs/
- Whitepaper: https://multiverse-lending.vercel.app/origami-verse-whitepaper.pdf
- New to this? [docs/LEARN.md](docs/LEARN.md) explains the project from zero.

## The problem

Someone holding NEAR who fears one specific future (the upgrade slips and the Fed holds) usually has two tools:
sell NEAR outright, or buy a put. Both pay for protection in every future, including the ones they expect to go
well. A prediction market prices an event, but it does not let you keep NEAR in some combinations of outcomes and
USDC in others, and a lending market does not take a position like "NEAR if the upgrade ships, USDC if it does
not" as collateral.

Origami Verse splits an asset by world, so protection is bought only where it is wanted, and a loan against
such a position is sized by the borrower's worst still-possible world: at the prices lending reads, the collateral
covers the debt in whichever world comes true.

## Try it on NEAR testnet

### Accounts

| Role | Account |
|---|---|
| Owner (approves new events, pause flags, admin resolve) | `ifverse-staging.testnet` |
| Protocol contract (v2.0.0) | `app.ifverse-staging.testnet` |
| Mock wNEAR (NEP-141, 24 decimals) | `wnear.ifverse-staging.testnet` |
| Mock USDC (NEP-141, 6 decimals) | `usdc.ifverse-staging.testnet` |
| Reporter (proposes outcomes, posts the NEAR/USD reference) | `resolver.ifverse-staging.testnet` |
| Keeper (liquidates loans below health factor 1) | `keeper.ifverse-staging.testnet` |
| Maker (keeps the lendable market near the real NEAR price) | `maker.ifverse-staging.testnet` |
| Personas (lenders, borrowers, order book, proposers) | `alice`, `bob`, `ravi`, `sam`, `uma`, `carl`, `leo` `.ifverse-staging.testnet` |

Explorer: `https://testnet.nearblocks.io/address/<account>`. The same ids are in `deployments/staging.json`. The
contract's code hash is `9K62NFX7gQiGajRuLTFcPy7F9n5nADSrFgESttUSFcRR`; both tokens run
`8afCVgFKDom2fYt5BZatMXPLXMiJ1vWHBiUTpN6AyggY`. "The wasm build" below shows how to rebuild them and where a build
can differ.

### What is live

- **Ten markets on six real events**, each with a written rule and a public source: SPICE on NEAR mainnet by
  Mar 31 2027, a Fed cut at the December 2026 meeting, the October 2026 Fed decision, NEAR's close above $4.00 on
  Nov 1 2026, NEAR above $3.25 on Dec 31 2026, and more than 30 million NEAR mainnet transactions in December 2026.
  Markets have two, four or eight worlds (market 8 combines three events).
- **Two events already resolved:** the October Fed decision (HOLDS, from FRED through OutLayer) and NEAR's Nov 1
  close (YES, Coinbase closed at 4.284), each after a 10-minute dispute window. Their markets, 2 and 3, are settled;
  see "Real-data resolution".
- **Lending in three tiers** on market 1 (SPICE × Fed December): Safe, Normal and Bold borrow up to 50, 60 and 70%
  of the worst world's value and liquidate at 60, 70 and 80%. Each tier keeps 10% of the interest it earns as an
  insurance reserve, which is never lent and absorbs bad debt before lenders do. The other markets are
  trading-only.
- **Proposals and pledges:** anyone can propose a combination of up to three open events, which opens by itself
  when pledges reach its goal, or a brand-new event with a bond, which the owner approves or rejects. Markets 4 to
  10 were opened this way. Proposals #18 (SPICE × December transactions) and #20 (NEAR on Dec 31 × December
  transactions) are collecting pledges now.
- **An outside NEAR/USD check:** the reporter posts the median of Coinbase, Kraken, Gemini and CoinGecko. Borrowing
  and opening a market need a reference under an hour old, and borrowing stops if a market's implied price drifts
  more than 10% from it.
- **A hosted keeper** (`/api/keeper/` on the same Vercel project) posts that reference, keeps the lendable market
  within 4% of it and liquidates unhealthy loans. It runs on a daily Vercel cron, every 30 minutes from an outside
  scheduler, and whenever someone has the site open (each browser pings it at most once a minute), so nothing
  depends on a laptop.

The testnet demo is shared: what you see is the state that trades, loans and proposals so far have left.

### What you need

- A NEAR testnet account in a wallet that NEAR Connect lists on testnet: Meteor, Intear or Nightly work.
- Some testnet NEAR: about 0.27 NEAR covers the 0.1 NEAR storage registration and the everyday actions. Testnet
  buys a transaction's gas up front and refunds what it does not burn, so an everyday action needs about 0.17 NEAR
  free while signing (a pledge, a liquidation or a price check about 0.31) but costs about 0.001. Need testnet NEAR?
  https://near-faucet.io tops up a top-level `.testnet` account that already holds about 0.03 NEAR (a request is a
  transaction you sign). With no NEAR at all, NEAR CLI creates a new account holding 10 NEAR from the faucet service
  (`print-to-terminal` in place of `save-to-keychain` shows the key to import into your wallet):

```bash
near account create-account sponsor-by-faucet-service <you>.testnet \
  autogenerate-new-keypair save-to-keychain network-config testnet create
```

- Test wNEAR and USDC: once your wallet is connected, click your account name (top right), then "Get test
  tokens" (Portfolio has the same button under Wallet). It mints 2,000 wNEAR and 5,000 USDC to your own account and
  pays the 0.1 NEAR Origami Verse storage deposit if you have none, in up to three wallet approvals. The mock tokens have
  an open `mint`; without the app, NEAR CLI does the same:

```bash
near contract call-function as-transaction wnear.ifverse-staging.testnet mint \
  json-args '{"account_id":"<you>.testnet","amount":"2000000000000000000000000000"}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
  sign-as <you>.testnet network-config testnet sign-with-keychain send

near contract call-function as-transaction usdc.ifverse-staging.testnet mint \
  json-args '{"account_id":"<you>.testnet","amount":"5000000000"}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
  sign-as <you>.testnet network-config testnet sign-with-keychain send
```

- Node 22 and pnpm 10, only to run the app locally or the checks in "Verify it yourself".

### Open the app

The hosted app is https://multiverse-lending.vercel.app: a static Next.js export of `ui/` plus the keeper function,
reading `app.ifverse-staging.testnet`. Its paths end in a slash. To run the same app locally:

```bash
pnpm -C ui install
pnpm -C ui dev:staging   # http://localhost:5173, reads app.ifverse-staging.testnet
```

`web/` is the earlier interface; it stays in the repository but is not deployed.

### Do X - see Y

1. Open the site. It starts on a landing page. Click Markets in the top bar (under Menu on a phone). The first
   page after the landing opens a three-step intro once per browser: click Next through it or close it with ×.
   Markets has search (also Ctrl/⌘+K), category chips and Sort (Money in pools, Ending soon, Newest). Click a
   card: `/market/?id=1` shows one row per world, the rules and resolution, the ticket (Fund, Hedge, Borrow, Lend,
   Liquidity) and related markets; `/market/?id=8` has eight worlds.
2. Click "Connect wallet" ("Connect" on a phone) and pick a wallet, then click your account name and "Get test
   tokens".
3. Fund tab: split wNEAR or USDC into every world still possible (the split page, `/split/?id=1`, also merges a
   full set back). Hedge tab, or Hedge on a world's row: pick the worlds you fear and sell NEAR there for
   USDC-if-world in one transaction.
4. Lend and Borrow (top bar, or the tabs on market 1): supply USDC in Safe, Normal or Bold and withdraw it; post
   collateral in a tier, borrow USDC, and see the health factor in your worst world; repay and take the collateral
   back.
5. Order book (top bar, `/orders/`): post a bid or an ask in a world, or take a resting one.
6. Portfolio (top bar): the futures you hold, your loans and supply by tier, positions and open orders.
7. At-risk loans (footer, `/liquidate/`): every borrower with a health factor; a loan below 1 can be liquidated
   for tokens or for cash.
8. Propose (top bar, `/propose/`): a combination of open events, or a new event with its rule and source.
   Proposals (footer, `/proposals/`) lists them; pledge on a proposal's page, for example `/proposal/?p=18`. A
   combination opens by itself at its goal; a pledge can be taken back until then, and all of it if the proposal
   ends without opening.
9. Resolve (top bar, `/resolve/`): each event's question, rule and source, the proposed outcome and its 10-minute
   dispute window. Events 3 and 4 are final: in markets 2 and 3 the worlds that did not happen are dead and the
   surviving world redeems 1:1 for real tokens.
10. Admin (footer, `/admin/`) is the owner's screen: approve or reject new events, pause flags, contract version.

## Verify it yourself

All commands run from the repository root. Rust 1.86.0 is pinned by `rust-toolchain.toml`.

### Contract and maths tests

```bash
cargo test --workspace
```

Measured on 2026-11-14 on `main` (`d46de5e`): 856 tests pass, 0 fail, 0 ignored.

| Test binary | Passed |
|---|---|
| `multiverse-contract` unit tests | 675 |
| `multiverse-math` unit tests | 103 |
| `multiverse-math` `tests/pools.rs` | 26 |
| `multiverse-math` `tests/properties.rs` | 15 |
| `multiverse-math` `tests/libraries.rs` | 10 |
| `multiverse-math` `tests/reference_vectors.rs` (4,188 reference vector lines computed from the prototype's maths) | 2 |
| `mock-ft` unit tests | 25 |

`cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` pass. `docs/TESTING.md`
describes every layer and the six invariants.

### Script and app tests

```bash
pnpm -C scripts test       # 464 tests: 463 pass, 1 skipped (the live FRED query)
pnpm -C scripts test:live  # the 18 FRED tests, including the live query
pnpm -C ui install && pnpm -C ui test   # vitest: 386 tests in 37 files
```

`pnpm -C ui typecheck` and `pnpm -C ui lint` pass (lint prints warnings only). The browser flows (Playwright,
`ui/e2e`) run against the staging deployment with the team's test keys; `ui/INTEGRATION.md` has the commands.

### The whole flow on a local sandbox node (first version)

These scripts drive the first version's acceptance flow on a local nearcore 2.6.5 sandbox node. The run below is
from 2026-11-12 and has not been repeated on v2. It needs `cargo-near` 0.17.0
(`cargo install cargo-near --version 0.17.0 --locked`) and the sandbox binary (the download below was checked on
macOS arm64). The node listens on 127.0.0.1:3030; to use another port, set `SANDBOX_RPC_PORT` for `sandbox` and
`NEAR_RPC_URL=http://127.0.0.1:<port>` for the other scripts.

```bash
curl -sSL "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/$(uname -s)-$(uname -m)/2.6.5/near-sandbox.tar.gz" | tar -xz -C /tmp
export NEAR_SANDBOX_BIN="/tmp/$(uname -s)-$(uname -m)/near-sandbox"

pnpm -C scripts install
pnpm -C scripts build:wasm                        # contract + mock token into target/deploy/
pnpm -C scripts sandbox start --fresh             # node, accounts, tokens, contract, reporter key
NEAR_NETWORK=sandbox pnpm -C scripts seed         # events, scenarios, pools, Bob's supply, Ravi's bid
NEAR_NETWORK=sandbox pnpm -C scripts demo-sale    # Alice sells 2,000 NEAR and borrows 3,000 USDC in both scenarios
NEAR_NETWORK=sandbox pnpm -C scripts e2e          # seeds a fresh demo and runs the acceptance flow
pnpm -C scripts sandbox stop
```

On that run `demo-sale` printed the numbers in "Demo numbers" below (worst world DELAYED·HOLDS, HF 1.22, max borrow
at HF 1: 3661.41; the TWAP prices depend on how many blocks the sandbox skips), and `e2e` ended with 13 `ok` steps,
which `docs/TESTING.md` lists. After every step that moves tokens `e2e` checks the contract's views and that every
world is still fully backed. The same flow ran on testnet against the first version's contract (code `G6GtUs6A...`)
on 2026-11-12 from 12:08 to 12:47 UTC: 88 transactions, the same 13 `ok` lines, with real waits for the 30-minute
TWAP window.

### The wasm build

```bash
pnpm -C scripts build:wasm
```

It builds both contracts with `cargo near build non-reproducible-wasm --locked`, rewrites local paths out of the
binaries, checks that none is left and prints the sha256 of each. On 2026-11-14 most builds of `main` (`d46de5e`)
printed:

```
7b7fa1502e66cb6467ce9a0823d5277bd248fda2c61e073a5241d26286a9eb54  multiverse_contract.wasm
70a12a7f3432df1f59f176cb756ff4431c59f382ed7f10923bcd831542b3c0a1  mock_ft.wasm
```

In base58 these are the code hashes on testnet: `9K62NFX7gQiGajRuLTFcPy7F9n5nADSrFgESttUSFcRR` on
`app.ifverse-staging.testnet` (deployed with `new()` in one transaction on 2026-11-14 at 04:22 UTC,
[`C3KthRtF...`](https://testnet.nearblocks.io/txns/C3KthRtFPyJa68XRXNqBjvE6LpTqZfPgKsAo2U73bcpU)) and
`8afCVgFKDom2fYt5BZatMXPLXMiJ1vWHBiUTpN6AyggY` on both token accounts. To read one:

```bash
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"app.ifverse-staging.testnet"}}' \
  | grep -o '"code_hash":"[^"]*"'
```

The contract build is not yet deterministic. Two view types are both named `ReferenceView`
(`contracts/multiverse/src/reference.rs` and `contracts/multiverse/src/catalog/mod.rs`; the JSON each view returns
is not affected), and the ABI that near-sdk embeds in the wasm describes whichever one the build picks, which can
change from one build to the next. Five builds of `d46de5e` in the same checkout printed the hash above three times
and `7ce7b6bcc24d1cf6ef308e6b0ade40ae71b0ebc3af958d8343ea0c1846d0fb27` (base58 `9QaV39eE...`) twice, and a build
from a clean clone printed the second one too. That wasm's embedded ABI differs from the deployed one only in that
definition (all 199 functions are the same) and is 28 bytes shorter. We believe the other differing bytes come from
the same cause: the ABI sits in the wasm's data, so a shorter one moves the data after it, and the 1,043 constants
that differ in the code each differ by 27 to 32. Renaming one of the two types fixes this, as `1ad9891` did for
`RootLpHolding` in the first version, but it changes the wasm and needs a redeploy.

The first version, `app.multiverse-near.testnet`, runs code `G6GtUs6AqHfxRb8YCdBx5dv1bgiQ3c1gDhPE9ygQTkEt`, built
from commit `04a3d42` (sha256 `e0392c0e...`) and deployed on 2026-11-12 at 12:08 UTC
([`F5X2U1CS...`](https://testnet.nearblocks.io/txns/F5X2U1CSpptsNUEUeeeixcw79ERvfGLFEpREwpnMvWc3)).

## Real-data resolution

Two v2 events have already happened and were resolved from real data on 2026-11-14:

| Event | Rule (stored on-chain with the event) | Data | Transactions |
|---|---|---|---|
| 3: "Did the Fed cut at its October 27-28, 2026 meeting?" | CUTS if both limits of the federal funds target range (FRED DFEDTARU and DFEDTARL) are lower on 2026-10-29 than on 2026-10-27; HOLDS if neither is lower | DFEDTARU 4.00 and DFEDTARL 3.75 on both dates: HOLDS | `request_resolution(3)` [`GH1fftYY...`](https://testnet.nearblocks.io/txns/GH1fftYYX8RU56GsgyAadCM1yfHHFdmzcvhDdUQrijqy), `finalize(3)` [`5C1dsLUL...`](https://testnet.nearblocks.io/txns/5C1dsLULtK2cnLCneEHwCWtUM86AsBKiWSHdvBLkjYfW) |
| 4: "Did NEAR close above $4.00 on Nov 1, 2026?" | YES if the Coinbase Exchange NEAR-USD daily candle for 2026-11-01 (UTC) closes strictly above 4.00 USD | Coinbase close 4.284, Kraken 4.2827: YES | `report_outcome(4)` [`4JUNNwUA...`](https://testnet.nearblocks.io/txns/4JUNNwUAZzHArvY6TwBtiZftuztFAxiqsQs59rmpyK9R), `finalize(4)` [`C6et7nkC...`](https://testnet.nearblocks.io/txns/C6et7nkCPb6tdLyqZZqw7dnDGHHZfwXpDVvtmZn6vvYw) |

Event 3 went through OutLayer, which `scripts/outlayer.ts` drives:

```bash
NEAR_NETWORK=testnet pnpm -C scripts outlayer configure --url <https url> --sha256 <hex>   # owner
NEAR_NETWORK=testnet pnpm -C scripts outlayer request [--event <id>] [--as <account>]     # anyone
```

`configure` pins the guest wasm URL and its sha256 on the contract and gives the event its two FRED dates.
`request` pays OutLayer's deposit (0.005 NEAR); OutLayer runs `oracle/fred-guest` in a TEE worker and resumes the
call, the contract proposes the answer with source `outlayer` under the 10-minute dispute window, and anyone then
finalizes. The pinned guest is https://multiverse-lending.vercel.app/outlayer/fred-guest.wasm (408,875 bytes,
sha256 `8c809e11f5b4b37627baa5c0a65a8587ef5f3e4918d1e0bb42cb2f87a5ae1660`), the exact output of
`oracle/fred-guest/build.sh`. For event 3 OutLayer reported a 1,572 ms run and charged 0.0011572 NEAR, refunding the
rest. Event 4 was proposed by the reporter's function-call key with the evidence
`Coinbase NEAR-USD 2026-11-01 close 4.284; Kraken 4.2827; threshold 4.00: YES`.

To repeat the FRED read without signing anything: `pnpm -C scripts test:live` queries FRED and checks the HOLDS
answer. On the first version the same Fed event was event 9, resolved through OutLayer on 2026-11-12
([`5DKPy7JX...`](https://testnet.nearblocks.io/txns/5DKPy7JXgjs4UMP8Bpt2AEyepa4QVswQcBRtwu6p4rgk)).

The other four events have not happened yet. They resolve the same way: an outcome proposed from the event's
stated source with its evidence, a 10-minute dispute window, then `finalize`.

## Architecture

The protocol is one contract. On NEAR, a call into another contract is asynchronous: it runs as a separate receipt,
usually in a later block, and a failure there does not roll back the caller. A trade that splits NEAR into four
worlds, fills orders, swaps in three pools, posts the result as collateral and borrows against it would need a
callback and a rollback path at every step if pools, order book and lending were separate contracts. In one contract
it is one synchronous call that either completes or panics and leaves nothing changed. The only promises that leave
the contract are payouts of real tokens with `ft_transfer` (sent after every state change), the receiver call of a
NEP-245 `mt_transfer_call`, NEAR refunds, and the OutLayer request.

```
  wallet (Meteor / Intear / Nightly, through NEAR Connect)
     |                                          |
     | ft_transfer_call(msg = {"action": ...})  | direct calls with 1 yoctoNEAR
     v                                          |
  wnear / usdc (NEP-141 mock tokens)            |
     |  ft_on_transfer          refund of unused v
     +------------------> app.ifverse-staging.testnet ------------------------------+
                          |  receiver -> router (sell, buy, sell-and-borrow, close) |
                          |  core: split / merge / redeem      oracle: events,      |
                          |  ledger: NEP-245 verse tokens      disputes, reference  |
                          |  amm: world, odds and spot pools   orders: order book   |
                          |  lending: tiers, worst-world loans catalog: proposals,  |
                          |  rootlp: vault   storage: NEP-145    pledges, markets   |
                          +---------------------------------------------------------+
                               |  ft_transfer + on_payout          ^         ^
                               v                                   |         |
                          your wallet               report_outcome |         | request_resolution
                                                    finalize       |         | (runs oracle/fred-guest)
                                                  report_reference |    outlayer.testnet
                          resolver.ifverse-staging.testnet --------+
                          (function-call keys; scripts/resolver.ts and the hosted keeper)
                          keeper. / maker.ifverse-staging.testnet: liquidations, market upkeep
```

| Path | What |
|---|---|
| `contracts/multiverse` | The protocol contract: `receiver`, `router`, `core`, `masks`, `ledger`, `nep245`, `oracle`, `outlayer`, `reference`, `amm`, `orders`, `lending`, `catalog`, `rootlp`, `storage`, `payout`, `views`, `admin`, `ops`, `migrate`, `events` |
| `crates/multiverse-math` | Integer maths with no NEAR dependency: fixed point and `mul_div`, tick maths, constant-product pools, dynamic fee, TWAP, odds, shares, order maths, worst-world risk |
| `contracts/mock-ft` | The NEP-141 test token with an open mint capped per call |
| `oracle/fred-guest` | The program OutLayer runs to read FRED (WASI, built on its own) |
| `scripts` | Accounts, deploy, sandbox, seed, demo sale, reset, resolver, OutLayer, keeper (`scripts/api/keeper.ts` is the hosted function), end-to-end flow (TypeScript, near-api-js) |
| `ui` | The live app (Next.js static export, no server) |
| `deploy` | The Vercel project settings for the app and the keeper function |
| `web` | The earlier interface, kept in the repository, not deployed |

`docs/DESIGN.md` explains how each part works.

## NEAR features used

- **`ft_transfer_call` with an action.** Every action that takes real tokens is one `ft_transfer_call` whose `msg`
  names it: `deposit`, `split`, `conditional_sell`, `conditional_buy`, `sell_and_borrow`, `post_order`, `supply`,
  `repay`, `deposit_collateral`, `liquidate`, `close_after_resolution`, `lp_deposit`, `spot_swap`, `fund_insurance`,
  `pledge`. No approval step.
  `ft_on_transfer` returns what the action did not use and the token contract refunds it; any failed check panics
  and the token contract refunds everything (the e2e failure step checks this with a malformed `msg`). The contract
  keeps 18-decimal internal units; for the 24-decimal wNEAR the part of a deposit below one internal unit is
  returned as unused.
- **NEP-245 multi-token positions.** Every world position is a NEP-245 token with id `{scenario}:{asset}:{mask}`,
  e.g. `1:wnear:14`. The contract implements `mt_transfer`, `mt_batch_transfer`, `mt_transfer_call`,
  `mt_batch_transfer_call`, the balance, supply, enumeration and metadata views, and logs `mt_mint`, `mt_burn` and
  `mt_transfer` events for every balance change.
- **NEP-145 storage management.** `storage_deposit`, `storage_withdraw`, `storage_unregister`,
  `storage_balance_of`, `storage_balance_bounds` (minimum 0.1 NEAR). Every state-changing call charges the bytes it
  adds to the payer's deposit (the caller, or the sender of an `ft_transfer_call`) and credits the bytes it frees.
- **Function-call keys for the reporter.** `resolver.ifverse-staging.testnet` holds one key that can call only
  `report_outcome` and `finalize` on the contract and another that can call only `report_reference`, each with its
  own NEAR allowance for gas.
- **OutLayer.** `request_resolution` calls `request_execution` on `outlayer.testnet` with a pinned wasm URL and
  sha256; OutLayer runs `oracle/fred-guest` in a TEE (Intel TDX) worker and resumes the call (NEP-519 yield) with
  the result, which `on_outlayer_result` turns into an ordinary proposal under the same dispute window. On testnet
  it resolved the October Fed event (event 3) HOLDS on 2026-11-14 (see "Real-data resolution").
- **Named accounts.** The contract, tokens, reporter, keeper, maker and personas are sub-accounts of
  `ifverse-staging.testnet`.
- **NEP-297 events** under the standard `multiverse` for every protocol action.

## Demo numbers

These are the prototype's golden numbers, which the first version's seed reproduced; live prices on testnet have
moved since. The seed set four world pools at 3.70 (SHIPS·CUTS), 3.00 (DELAYED·CUTS), 3.30 (SHIPS·HOLDS) and 2.50
(DELAYED·HOLDS) USDC per NEAR, and the binary SPICE market at 3.40 (SHIPS) and 2.80 (DELAYED). DELAYED·HOLDS is the
thin pool, with Ravi's standing bid there of 2.4500 USDC per NEAR for 1,000 NEAR. Alice sells 2,000 NEAR in
DELAYED·CUTS, SHIPS·HOLDS and DELAYED·HOLDS, keeps it in SHIPS·CUTS, and borrows 3,000 USDC:

| | |
|---|---|
| 2,000 NEAR into the DELAYED·HOLDS pool alone | 4,748.29 USDC |
| Ravi's bid for 1,000 NEAR, then the pool | 4,881.88 USDC |
| Proceeds in DELAYED·CUTS / SHIPS·HOLDS | 5,865.05 / 6,451.55 USDC |
| Health factor after borrowing 3,000 (worst world DELAYED·HOLDS) | 1.22 (4,881.88 × 0.75 / 3,000) |
| Binary market: 2,000 NEAR-if-DELAYED sold, 3,000 borrowed | HF 1.36 |

The contract test `golden_demo_sale` (`contracts/multiverse/src/tests/router.rs`) checks the per-world proceeds
against the prototype's raw values (within 1e-12 USDC) and the health factor against the prototype's (within
1e-15).

## Security

`docs/SECURITY.md` is an internal review of the first version's contract by the people who built it, not an audit.
It lists ten findings (two high, four medium, four low), each reproduced by a failing test first and kept as a
regression test, and the six invariants checked as property tests. The v2 additions (tiers, proposals and pledges,
the NEAR/USD reference, the keeper, the migration code) have their own tests but are not in that review.

Trust assumptions:

- The owner is trusted. `admin_resolve` resolves an event at once; `dispute` cancels an open proposal within its
  window. There is no timelock and no multisig.
- One reporter key proposes outcomes, and OutLayer proposes the FRED event it is configured for. If the owner does
  not dispute a wrong proposal within its 10-minute window, anyone can finalize it.
- Most liquidity came from the team: the seed script and, for markets 4 to 10, the pledges that opened them. The
  maker keeps the lendable market near the reference.
- wNEAR and USDC are mock tokens that anyone can mint, up to 1,000,000 wNEAR or 10,000,000 USDC per call. They have
  no value.
- Testnet only. Nothing has been deployed or tested on mainnet.

Accepted residual risks (ECON-1 and ECON-2 in `docs/SECURITY.md`): lending prices come from the protocol's own
pools, through a 30-minute TWAP with a spot band; v2 adds the outside NEAR/USD reference, which stops borrowing when
a market drifts more than 10% from it. Someone who holds a pool at a false price for the whole window still moves
the TWAP. The spot band can pause borrowing and liquidation in a world while a pool sits far from its TWAP.

## Limitations

- Three events and eight worlds per market at most.
- Only market 1 lends; each tier's borrow rate follows a fixed kinked curve of utilization.
- Lending reads a 30-minute TWAP, so on testnet a price move reaches borrowing limits and liquidations gradually,
  over up to 30 minutes.
- Testnet only; nothing has been deployed or tested on mainnet.
- The contract has a v1 to v2 state migration (`contracts/multiverse/src/migrate`), but the staging deployment was
  made fresh with `new()`, so the migration has not run on testnet.
- The testnet demo is shared: its state is whatever the trades, loans, proposals and tests so far have left.

## History and disclosure

The market design of Origami Verse (then called Multiverse Lending) first existed as a hackathon prototype on an EVM chain
(6-7 Nov 2026); that repository is private. This repository is the NEAR implementation, written from scratch during NEAR HACKATHON: the
Rust contract, the NEAR integration, a new web app and the scripts. The market design and the demo story come from
the prototype.

The idea of splitting an asset into verses, one per possible outcome, and moving tokens down into a verse or back up
comes from Paradigm's essay [Multiverse Finance](https://www.paradigm.xyz/2025/05/multiverse-finance) (Dave White,
May 2025).

## Built with

- Contract: `near-sdk` 5.14, `near-contract-standards` 5.14 (mock token), `uint` (256- and 512-bit integers),
  `borsh`, `serde`; tests with `proptest`.
- Tick maths: a Rust port of Uniswap v4's TickMath (MIT).
- OutLayer guest: `wasi-http-client`, `serde_json`.
- Scripts and keeper: `near-api-js` 7.4.0, `tsx`, TypeScript.
- App (`ui/`): Next.js 16, React 19, three.js 0.187 with `@react-three/fiber`, `lightweight-charts` 5.2.1,
  TanStack Query, `@hot-labs/near-connect` 0.12.0, `near-api-js` 7.4.0; tests with Vitest and Playwright, lint
  with oxlint.
- Earlier interface (`web/`): Next.js, React, Tailwind CSS, framer-motion, TanStack Query,
  `@hot-labs/near-connect` 0.12.0, `near-api-js` 7.4.0.
- Hosting: Vercel (static site, keeper function and cron).
- Build: `cargo-near` 0.17.0.
- Data: FRED (Federal Reserve Bank of St. Louis), series DFEDTARU and DFEDTARL; Coinbase, Kraken, Gemini and
  CoinGecko for NEAR/USD.

## License

MIT, see `LICENSE`.
