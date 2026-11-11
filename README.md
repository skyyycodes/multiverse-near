# Multiverse Lending on NEAR

Demo video: (link)

Multiverse Lending lets you sell ETH only in the futures you fear. Take two real-world events with two outcomes
each, for example "Will Glamsterdam ship on mainnet by Dec 31, 2026?" and "Will the Fed cut at its December
meeting?". Each combination of outcomes is a world, so there are four: SHIPS·CUTS, DELAYED·CUTS, SHIPS·HOLDS and
DELAYED·HOLDS. One ETH splits into one ETH-if-world per world, each paying out only if that world comes true. You
trade each world in its own pool or order book, keep ETH in the worlds you like and sell it for USDC-if-world in the
ones you fear, and borrow real USDC against your worst world. When the events resolve, the worlds that did not
happen die, and what you hold in the surviving world redeems 1:1 for real WETH or USDC.

Everything runs in one NEAR contract, `app.multiverse-lending.testnet`, on NEAR testnet with mock tokens.

## The problem

Someone holding ETH who fears one specific future (the upgrade slips and the Fed holds) usually has two tools:
sell ETH outright, or buy a put. Both pay for protection in every future, including the ones they expect to go
well. A prediction market prices an event, but it does not let you keep ETH in some combinations of outcomes and
USDC in others, and a lending market does not take a position like "ETH if the upgrade ships, USDC if it does
not" as collateral.

Multiverse Lending splits an asset by world, so protection is bought only where it is wanted, and a loan against
such a position is sized by the borrower's worst still-possible world: at the prices lending reads, the collateral
covers the debt in whichever world comes true.

## Try it on NEAR testnet

### Accounts

| Role | Account | Explorer |
|---|---|---|
| Owner (creates events, scenarios, pools; admin resolve and dispute) | `multiverse-lending.testnet` | https://testnet.nearblocks.io/address/multiverse-lending.testnet |
| Protocol contract | `app.multiverse-lending.testnet` | https://testnet.nearblocks.io/address/app.multiverse-lending.testnet |
| Mock WETH (NEP-141, 18 decimals) | `weth.multiverse-lending.testnet` | https://testnet.nearblocks.io/address/weth.multiverse-lending.testnet |
| Mock USDC (NEP-141, 6 decimals) | `usdc.multiverse-lending.testnet` | https://testnet.nearblocks.io/address/usdc.multiverse-lending.testnet |
| Reporter (proposes outcomes) | `resolver.multiverse-lending.testnet` | https://testnet.nearblocks.io/address/resolver.multiverse-lending.testnet |
| Alice (sells and borrows) | `alice.multiverse-lending.testnet` | https://testnet.nearblocks.io/address/alice.multiverse-lending.testnet |
| Bob (lender) | `bob.multiverse-lending.testnet` | https://testnet.nearblocks.io/address/bob.multiverse-lending.testnet |
| Ravi (order book maker) | `ravi.multiverse-lending.testnet` | https://testnet.nearblocks.io/address/ravi.multiverse-lending.testnet |
| Sam (order book taker) | `sam.multiverse-lending.testnet` | https://testnet.nearblocks.io/address/sam.multiverse-lending.testnet |
| Uma (Root LP) | `uma.multiverse-lending.testnet` | https://testnet.nearblocks.io/address/uma.multiverse-lending.testnet |
| Carl (unhedged borrower) | `carl.multiverse-lending.testnet` | https://testnet.nearblocks.io/address/carl.multiverse-lending.testnet |
| Leo (lender, liquidator) | `leo.multiverse-lending.testnet` | https://testnet.nearblocks.io/address/leo.multiverse-lending.testnet |

The same ids are in `deployments/testnet.json`. The contract's code hash on testnet is
`E5z5z6Q47fku8A5GM23BkXH8hxwuPvexQWoi3rA7BvXA`; both tokens run `8afCVgFKDom2fYt5BZatMXPLXMiJ1vWHBiUTpN6AyggY`
(the mock token built by `scripts/build-wasm.sh`, see "Verify it yourself").

The testnet demo is shared. What you see is the state the last seeding, sale or test run left. The Trade screen
shows `scenario {id} · {n} resolved`; if the demo's events are already resolved there, the full story is easiest to
follow on the local sandbox (see "Verify it yourself").

### What you need

- Node 22 and pnpm 10.
- A NEAR testnet account in a wallet that NEAR Connect lists on testnet: Meteor, Intear or Nightly. NEAR Connect
  shows only wallets that declare testnet support.
- Some testnet NEAR for gas and the 0.1 NEAR storage registration (https://near-faucet.io).
- Test WETH and USDC. Once your wallet is connected, click "Get test tokens" in the account sheet (or under the
  balances on the Trade screen while your wallet is empty). It mints 2 WETH and 5,000 USDC to your own account, then
  adds the 0.1 NEAR Multiverse storage deposit if you have none; each is one wallet prompt. The mock tokens have an
  open `mint` capped at 1,000 WETH and 10,000,000 USDC per call, and an account that is not registered with the
  token yet can only mint to itself, which registers it. Without the app, NEAR CLI (`near-cli-rs`) does the same:

```bash
near contract call-function as-transaction weth.multiverse-lending.testnet mint \
  json-args '{"account_id":"<you>.testnet","amount":"5000000000000000000"}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
  sign-as <you>.testnet network-config testnet sign-with-keychain send

near contract call-function as-transaction usdc.multiverse-lending.testnet mint \
  json-args '{"account_id":"<you>.testnet","amount":"10000000000"}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
  sign-as <you>.testnet network-config testnet sign-with-keychain send
```

That is 5 WETH (18 decimals) and 10,000 USDC (6 decimals). The Admin screen's "Mint test WETH to my wallet" button
is a separate tool for the owner account's price pushes.

### Run the app

```bash
pnpm -C web install
pnpm -C web dev        # http://localhost:3040, reads app.multiverse-lending.testnet
```

There is no hosted copy. `pnpm -C web dev:fixtures` runs the same app on recorded demo data with no chain and no
wallet (see `web/README.md`).

### Do X - see Y

1. Open http://localhost:3040. See the landing page. Click "Look around first". See the Trade screen: one card per
   world (on a phone, a strip of small cards) with its pool price, "Actual spot" and "Implied spot" (odds times world prices), and "Every world
   balances: ✓ all backed".
2. Click "Connect NEAR wallet" and pick Meteor, Intear or Nightly. See your wallet's WETH and USDC on the Trade
   screen; if both are zero, click "Get test tokens" there. Before the first action that stores something, the app
   asks for a one-time NEP-145 storage deposit.
3. Select the worlds DELAYED·CUTS, SHIPS·HOLDS and DELAYED·HOLDS (or open http://localhost:3040/sell/?sel=14).
   Enter an amount of ETH. See, per world, the fair price, what you get and the cost per ETH; resting bids that pay
   more than the pool are filled first. Leave "Keep the result as loan collateral" ticked and click "Sell in 3
   worlds". See one wallet prompt (an `ft_transfer_call` on the WETH token, no approval), then "Done · <hash>",
   which links to nearblocks.
4. Open Borrow. See "Health factor (worst world)" and the name of your worst world: the world where your collateral
   is worth least. Enter an amount in USDC and click "Borrow". See real USDC arrive in your wallet and the health
   factor drop.
5. Open Lend. Supply USDC, see "You supplied" and the utilization move; withdraw it again with "all".
6. Open the order book (More, then Order book on a phone). Pick a world, post a bid or an ask, or accept a resting
   order. See your order in the ladder and under "Your orders here".
7. Open Resolve. See each event's question and rule, a proposed outcome with "Dispute window" and its countdown,
   and the worlds that died once it is final. After resolution, "Close and redeem" is one transaction: it repays the
   loan with USDC from your wallet, takes every collateral piece back and redeems the collapsed ones for real
   tokens.

## Verify it yourself

All commands run from the repository root. Rust 1.86.0 is pinned by `rust-toolchain.toml`.

### Contract and maths tests

```bash
cargo test --workspace
```

Measured on 2026-11-11 at commit `1ad9891`: 542 tests pass, 0 fail, 0 ignored.

| Test binary | Passed |
|---|---|
| `multiverse-contract` unit tests | 406 |
| `multiverse-math` unit tests | 64 |
| `multiverse-math` `tests/pools.rs` | 23 |
| `multiverse-math` `tests/properties.rs` | 14 |
| `multiverse-math` `tests/libraries.rs` | 10 |
| `multiverse-math` `tests/evm_vectors.rs` (4,188 vector lines from the Solidity code) | 2 |
| `mock-ft` unit tests | 23 |

`cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` pass. `docs/TESTING.md`
describes every layer and the six invariants.

### The whole flow on a local sandbox node

Needs `cargo-near` 0.17.0 (`cargo install cargo-near --version 0.17.0 --locked`) and the nearcore 2.6.5 sandbox
binary, the version these scripts were run with (the download below was checked on macOS arm64). The node listens
on 127.0.0.1:3030; to use another port, set `SANDBOX_RPC_PORT` for `sandbox` and
`NEAR_RPC_URL=http://127.0.0.1:<port>` for the other scripts.

```bash
curl -sSL "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/$(uname -s)-$(uname -m)/2.6.5/near-sandbox.tar.gz" | tar -xz -C /tmp
export NEAR_SANDBOX_BIN="/tmp/$(uname -s)-$(uname -m)/near-sandbox"

pnpm -C scripts install
pnpm -C scripts build:wasm                        # contract + mock token into target/deploy/
pnpm -C scripts sandbox start --fresh             # node, accounts, tokens, contract, reporter key
NEAR_NETWORK=sandbox pnpm -C scripts seed         # events, scenarios, pools, Bob's supply, Ravi's bid
NEAR_NETWORK=sandbox pnpm -C scripts demo-sale    # Alice sells 2 ETH and borrows 3,000 USDC in both scenarios
NEAR_NETWORK=sandbox pnpm -C scripts e2e          # seeds a fresh demo and runs the acceptance flow
pnpm -C scripts sandbox stop
```

Expected lines (from a run on 2026-11-11 against a clean clone of `1ad9891`; the TWAP prices depend on how many
blocks the sandbox skips and can differ by a few dollars between runs, the other numbers do not):

```
seed:
2 ETH sale, pool alone: 4748.29 USDC, average 2374.14
2 ETH sale, Ravi's bid then the pool: 4881.88 USDC, average 2440.94

demo-sale:
world 1 DELAYED·CUTS: WETH-if-w 0.00, USDC-if-w 5865.05 | collateral value 5865.05 | TWAP price 2998.59
world 2 SHIPS·HOLDS: WETH-if-w 0.00, USDC-if-w 6451.55 | collateral value 6451.55 | TWAP price 3298.07
world 3 DELAYED·HOLDS: WETH-if-w 0.00, USDC-if-w 4881.88 | collateral value 4881.88 | TWAP price 2498.40
worst world: DELAYED·HOLDS | HF 1.22 | max borrow at HF 1: 3661.41
worst world: DELAYED | HF 1.36 | max borrow at HF 1: 4105.53

e2e (last lines):
== summary
  ok      1. grid, disconnected
  ok      2. register and connect Alice
  ok      3-4. sell in DELAYED·CUTS, SHIPS·HOLDS and DELAYED·HOLDS
  ok      5. borrow 3000
  ok      6. lend (Leo supplies and withdraws all)
  ok      7. order book in SHIPS·CUTS (Ravi asks 3750, bids 3600; Sam takes the ask)
  ok      8. Root LP (Uma deposits 5 WETH + 20000 USDC, withdraws all)
  ok      9. admin pushes DELAYED·HOLDS down with 3 WETH; Carl's unhedged loan
  ok      9b. Leo liquidates Carl (repay max, half the debt at most)
  ok      10. resolution: the reporter proposes Fed HOLDS, Glamsterdam resolves DELAYED
  ok      11a. Alice closes her loan and redeems
  ok      11b. Ravi redeems his DELAYED·HOLDS position
  ok      12. failure paths
```

The sandbox skips blocks instead of waiting for the TWAP window, so `e2e` took 1 min 54 s. After every step it
checks the contract's views and that every world of both scenarios is still fully backed. Transaction hashes differ
on every run.

### Script and web tests

```bash
pnpm -C scripts test       # 78 tests: 77 pass, 1 skipped (the live FRED query)
pnpm -C scripts test:live  # 18 tests including the live FRED query: all pass
pnpm -C web install && pnpm -C web test   # vitest: 95 tests in 15 files
```

The browser acceptance flow (Playwright, against fixtures, testnet and the sandbox) is described in `web/README.md`.

### The wasm build

```bash
pnpm -C scripts build:wasm
```

It builds both contracts with `cargo near build non-reproducible-wasm --locked`, rewrites local paths out of the
binaries, checks that none is left and prints the sha256 of each. Two builds from clean clones of `1ad9891` at
different paths printed:

```
e4cada8cdc1090b8c1688034c6b5e0f88dc34cf3e7c5349fcb8f165ed7f01f30  multiverse_contract.wasm
70a12a7f3432df1f59f176cb756ff4431c59f382ed7f10923bcd831542b3c0a1  mock_ft.wasm
```

The mock token's hash is the code hash of both token accounts on testnet (base58
`8afCVgFKDom2fYt5BZatMXPLXMiJ1vWHBiUTpN6AyggY`). The contract on testnet (`E5z5z6...`, sha256 `c26eccf1...`) was
built before `1ad9891`, when two view types were both named `RootLpHolding` and the near-sdk ABI embedded in the
wasm described whichever one the build picked. `1ad9891` renames the lend view's copy to `RootLpHoldingView` (the
JSON is unchanged), so clean builds now agree. Until the testnet contract is redeployed from this build, its hash
differs from the one above.

## Real-data resolution

The demo has a third event that has already happened, resolved from real data:

- Question: "Did the Fed cut at its October 27-28, 2026 meeting?" (outcomes CUTS, HOLDS).
- Rule, stored on-chain with the event: "CUTS if and only if both limits of the federal funds target range (FRED
  DFEDTARU and DFEDTARL) are lower on 2026-10-29 than on 2026-10-27; HOLDS if neither is; if they disagree, nothing
  is reported."
- Data: FRED shows DFEDTARU 4.00 and DFEDTARL 3.75 on both dates, so the answer is HOLDS.

`scripts/resolver.ts` read FRED, proposed HOLDS with `report_outcome`, waited out the 30 s dispute window and
called `finalize`, both signed with the reporter's function-call key:

- `report_outcome(3, 1)`: https://testnet.nearblocks.io/txns/JRWR51993b2dG5qY5oHT1gqq6i6mhv8jrrvpxcZA63S
- `finalize(3)`: https://testnet.nearblocks.io/txns/8eC85o4KmKtiKaa6QtjCSyh7nJ37evpTGukqLoBvWZbP

To repeat the read without signing anything: `pnpm -C scripts test:live` queries FRED and checks the HOLDS answer.
The two grid events (Glamsterdam, December Fed) have not happened yet. In the demo they resolve from
`deployments/demo-outcomes.json`, a file the team controls, and the app says so.

## Architecture

The protocol is one contract. On NEAR, a call into another contract is asynchronous: it runs as a separate receipt,
usually in a later block, and a failure there does not roll back the caller. A trade that splits ETH into four worlds, fills orders, swaps in three
pools, posts the result as collateral and borrows against it would need a callback and a rollback path at every
step if pools, order book and lending were separate contracts. In one contract it is one synchronous call that
either completes or panics and leaves nothing changed. The only promises that leave the contract are payouts of real
tokens with `ft_transfer` (sent after every state change), the receiver call of a NEP-245 `mt_transfer_call`,
NEAR refunds, and the OutLayer request.

```
  wallet (Meteor / Intear / Nightly, through NEAR Connect)
     |                                          |
     | ft_transfer_call(msg = {"action": ...})  | direct calls with 1 yoctoNEAR
     v                                          |
  weth / usdc (NEP-141 mock tokens)             |
     |  ft_on_transfer          refund of unused v
     +------------------> app.multiverse-lending.testnet ---------------------------+
                          |  receiver -> router (sell, buy, sell-and-borrow, close) |
                          |  core: split / merge / redeem      oracle: events,      |
                          |  ledger: NEP-245 verse tokens      proposals, disputes  |
                          |  amm: world, odds and spot pools   orders: order book   |
                          |  lending: worst-world loans        rootlp: vault        |
                          |  storage: NEP-145                  views: one per screen|
                          +---------------------------------------------------------+
                               |  ft_transfer + on_payout          ^         ^
                               v                                   |         |
                          your wallet               report_outcome |         | request_resolution
                                                    finalize       |         | (built, not configured)
                          resolver.multiverse-lending.testnet -----+    outlayer.testnet
                          (function-call key; scripts/resolver.ts reads FRED)
```

| Path | What |
|---|---|
| `contracts/multiverse` | The protocol contract: `receiver`, `router`, `core`, `masks`, `ledger`, `nep245`, `oracle`, `outlayer`, `amm`, `orders`, `lending`, `rootlp`, `storage`, `payout`, `views`, `admin`, `events` |
| `crates/multiverse-math` | Integer maths with no NEAR dependency: fixed point and `mul_div`, Uniswap v4 `TickMath`, constant-product pools, dynamic fee, TWAP, odds, shares, order maths, worst-world risk |
| `contracts/mock-ft` | The NEP-141 test token with a capped open mint |
| `oracle/fred-guest` | The program OutLayer runs to read FRED (WASI, built on its own) |
| `scripts` | Accounts, deploy, sandbox, seed, demo sale, reset, resolver, end-to-end flow (TypeScript, near-api-js) |
| `web` | The Next.js app (static export, no server) |

`docs/DESIGN.md` explains how each part works.

## NEAR features used

- **`ft_transfer_call` with an action.** Every action that takes real tokens is one `ft_transfer_call` whose `msg`
  names it: `deposit`, `split`, `conditional_sell`, `conditional_buy`, `sell_and_borrow`, `post_order`, `supply`,
  `repay`, `deposit_collateral`, `liquidate`, `close_after_resolution`, `lp_deposit`, `spot_swap`. No approval step.
  `ft_on_transfer` returns what the action did not use and the token contract refunds it; any failed check panics
  and the token contract refunds everything (the e2e failure step checks this with a malformed `msg`).
- **NEP-245 multi-token positions.** Every world position is a NEP-245 token with id `{scenario}:{asset}:{mask}`,
  e.g. `1:weth:14`. The contract implements `mt_transfer`, `mt_batch_transfer`, `mt_transfer_call`,
  `mt_batch_transfer_call`, the balance, supply, enumeration and metadata views, and logs `mt_mint`, `mt_burn` and
  `mt_transfer` events for every balance change.
- **NEP-145 storage management.** `storage_deposit`, `storage_withdraw`, `storage_unregister`,
  `storage_balance_of`, `storage_balance_bounds` (minimum 0.1 NEAR). Every state-changing call charges the bytes it
  adds to the payer's deposit (the caller, or the sender of an `ft_transfer_call`) and credits the bytes it frees.
- **A function-call key for the reporter.** `resolver.multiverse-lending.testnet` holds a key that can call only
  `report_outcome` and `finalize` on the contract, with a 0.5 NEAR allowance. The resolver signs with it.
- **OutLayer path (built and tested, not live).** `request_resolution` calls `request_execution` on
  `outlayer.testnet` with a pinned wasm URL and sha256; OutLayer runs `oracle/fred-guest` in an Intel TDX worker
  and resumes the call (NEP-519 yield) with the result, which `on_outlayer_result` turns into an ordinary proposal
  under the same dispute window. It has 16 contract unit tests and 12 guest tests, and the guest was run locally
  against live FRED. It becomes usable on testnet once the guest wasm is hosted at a pinned URL and the owner sets
  it with `set_outlayer_config`; on testnet `get_outlayer_config` currently returns `null`, so no OutLayer run has
  happened there. Steps: `oracle/fred-guest/README.md`.
- **Named accounts.** The contract, tokens, reporter and personas are sub-accounts of `multiverse-lending.testnet`.
- **NEP-297 events** under the standard `multiverse` for every protocol action.

## Demo numbers

The demo seeds DELAYED·HOLDS as a thin pool and Ravi's standing bid of 2,450 USDC for 1 ETH there. Alice sells 2
ETH in DELAYED·CUTS, SHIPS·HOLDS and DELAYED·HOLDS, keeps it in SHIPS·CUTS, and borrows 3,000 USDC:

| | |
|---|---|
| 2 ETH into the DELAYED·HOLDS pool alone | 4,748.29 USDC |
| Ravi's bid for 1 ETH, then the pool | 4,881.88 USDC |
| Proceeds in DELAYED·CUTS / SHIPS·HOLDS | 5,865.05 / 6,451.55 USDC |
| Health factor after borrowing 3,000 (worst world DELAYED·HOLDS) | 1.22 (4,881.88 × 0.75 / 3,000) |
| Binary market: 2 ETH-if-DELAYED sold, 3,000 borrowed | HF 1.36 |

These are the numbers of the EVM version's demo. The contract test `golden_demo_sale`
(`contracts/multiverse/src/tests/router.rs`) checks the per-world proceeds against the EVM run's raw values (within
1e-12 USDC) and the health factor against the EVM's (within 1e-15). The sandbox run above prints the same numbers,
and the testnet seeding printed 4,748.29 and 4,881.88.

## Security

`docs/SECURITY.md` is an internal review by the people who built it, not an audit. It lists ten findings (two high,
four medium, four low), each reproduced by a failing test first and kept as a regression test, and the six
invariants checked as property tests.

Trust assumptions:

- The owner is trusted. `admin_resolve` resolves an event at once; `dispute` cancels an open proposal within its
  window. There is no timelock and no multisig.
- One reporter key proposes outcomes. If the owner does not dispute a wrong proposal within its 30 s window,
  anyone can finalize it.
- The grid events resolve from a file the team controls; only the past FOMC event resolves from FRED.
- All liquidity, Bob's supply and Ravi's order come from the seed script.
- WETH and USDC are mock tokens with an open, capped mint. They have no value.
- Testnet only. Nothing has been deployed or tested on mainnet.

Accepted residual risks (ECON-1 and ECON-2 in `docs/SECURITY.md`): lending prices come only from the protocol's own
pools, through a 30-minute TWAP with a spot band. Someone who holds a pool at a false price for the whole window
still moves it, and on testnet nobody arbitrages it back. The spot band can pause borrowing and liquidation in a
world while a pool sits far from its TWAP.

## Limitations

- Two binary events per scenario at most (four worlds).
- Lending has one fixed borrow rate and prices only from in-protocol pools.
- Lending reads a 30-minute TWAP, so on testnet a price move reaches borrowing limits and liquidations gradually,
  over up to 30 minutes.
- The OutLayer path is not configured on testnet.
- The testnet contract was built before the ABI fix in `1ad9891`, so its code hash does not match a clean build
  until it is redeployed (see "The wasm build").
- No hosted web app; run it locally.
- The contract has no state migration; a change to its layout needs a fresh deployment.

## History and disclosure

Multiverse Lending first existed as an EVM prototype built at ETHGlobal Mumbai (6-7 Nov 2026); that repository is
private. This repository is the NEAR implementation, written from scratch during NEAR HACKATHON: the Rust
contract, the NEAR integration, a new web app and the scripts. The market design and the demo scenario come from
the EVM version.

## Built with

- Contract: `near-sdk` 5.14, `near-contract-standards` 5.14 (mock token), `uint` (256- and 512-bit integers),
  `borsh`, `serde`; tests with `proptest`.
- OutLayer guest: `wasi-http-client`, `serde_json`.
- Scripts: `near-api-js` 7.4.0, `tsx`, TypeScript.
- Web: Next.js, React, Tailwind CSS, framer-motion, TanStack Query, `@hot-labs/near-connect` 0.12.0,
  `near-api-js` 7.4.0; tests with Vitest and Playwright.
- Build: `cargo-near` 0.17.0.
- Data: FRED (Federal Reserve Bank of St. Louis), series DFEDTARU and DFEDTARL.

## License

MIT, see `LICENSE`.
