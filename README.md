# IfVerse

**What if your what-ifs became worlds?** A multiverse for the real world: hold NEAR in the futures you like
and dollars in the ones you fear.

IfVerse was first called Multiverse Lending; the testnet account ids and the web address still use that name.

Demo video: (link)

IfVerse lets you sell NEAR only in the futures you fear. Take two real-world events with two outcomes
each, for example "Will SPICE ship on NEAR mainnet by Mar 31, 2027?" and "Will the Fed cut at its December
meeting?". Each combination of outcomes is a world, so there are four: SHIPS·CUTS, DELAYED·CUTS, SHIPS·HOLDS and
DELAYED·HOLDS. One NEAR splits into one NEAR-if-world per world, each paying out only if that world comes true. You
trade each world in its own pool or order book, keep NEAR in the worlds you like and sell it for USDC-if-world in the
ones you fear, and borrow real USDC against your worst world. When the events resolve, the worlds that did not
happen die, and what you hold in the surviving world redeems 1:1 for real wNEAR or USDC.

Everything runs in one NEAR contract on NEAR testnet with mock tokens. Version 2 is live: the contract is
`app.ifverse-staging.testnet` and the web app is hosted at https://multiverse-lending.vercel.app. The first
version's contract, `app.multiverse-near.testnet`, is still on chain and unchanged.

New to this? [docs/LEARN.md](docs/LEARN.md) explains the project from zero.

## The problem

Someone holding NEAR who fears one specific future (the upgrade slips and the Fed holds) usually has two tools:
sell NEAR outright, or buy a put. Both pay for protection in every future, including the ones they expect to go
well. A prediction market prices an event, but it does not let you keep NEAR in some combinations of outcomes and
USDC in others, and a lending market does not take a position like "NEAR if the upgrade ships, USDC if it does
not" as collateral.

IfVerse splits an asset by world, so protection is bought only where it is wanted, and a loan against
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
`8afCVgFKDom2fYt5BZatMXPLXMiJ1vWHBiUTpN6AyggY`. Both are what `scripts/build-wasm.sh` builds.

### What is live

- **Eight markets on five real events**, each with a written rule and a public source: SPICE on NEAR mainnet by
  Mar 31 2027, a Fed cut at the December 2026 meeting, the October 2026 Fed decision, NEAR's close on Nov 1 2026, and
  NEAR above $3.25 on Dec 31 2026. Markets have two, four or eight worlds (market 8 combines three events).
- **Lending in three tiers** on market 1 (SPICE × Fed December): Safe, Normal and Bold borrow up to 50, 60 and 70%
  of the worst world's value and liquidate at 60, 70 and 80%. Bold has an insurance fund. The other markets are
  trading-only.
- **Proposals and pledges:** anyone can propose a combination of up to three open events, which opens by itself
  when pledges reach its goal, or a brand-new event with a bond, which the owner approves or rejects. Markets 4 to
  8 were opened this way.
- **An outside NEAR/USD check:** the reporter posts the median of Coinbase, Kraken, Gemini and CoinGecko. Borrowing
  and opening a market need a reference under an hour old, and borrowing stops if a market's implied price drifts
  more than 10% from it.
- **A hosted keeper** (`/api/keeper/` on the same Vercel project) posts that reference, keeps the lendable market
  within 4% of it and liquidates unhealthy loans. It runs when anyone has the site open (at most once a minute)
  and on a daily cron, so nothing depends on a laptop.
- The October Fed decision and NEAR's Nov 1 close were left open at launch so the demo video resolves them on
  camera from their public sources (10-minute dispute window).

The testnet demo is shared: what you see is the state that trades, loans and proposals so far have left.

### What you need

- A NEAR testnet account in a wallet that NEAR Connect lists on testnet: Meteor, Intear or Nightly work.
- Some testnet NEAR for gas and the 0.1 NEAR storage registration (https://near-faucet.io).
- Test wNEAR and USDC: once your wallet is connected, click "Get test tokens" on the market list (or in the
  account sheet). It mints 2,000 wNEAR and 5,000 USDC to your own account and pays the 0.1 NEAR IfVerse storage
  deposit if you have none. The mock tokens have an open `mint`; without the app, NEAR CLI does the same:

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

The hosted app is https://multiverse-lending.vercel.app: a static Next.js export plus the keeper function, reading
`app.ifverse-staging.testnet`. Its paths end in a slash. To run the same app locally:

```bash
pnpm -C web install
pnpm -C web dev:staging   # http://localhost:3040, reads app.ifverse-staging.testnet
```

### Do X - see Y

1. Open the site. See the market list: search, filter and sort; each card shows its worlds and prices. Open a
   market (`/market/?id=1`) to see its worlds, prices, actions and related markets; `/market/?id=8` shows eight
   worlds.
2. Click "Connect NEAR wallet", then "Get test tokens".
3. Split (`/split/`): one wNEAR becomes one NEAR-if-world in every world of the market. Sell (`/sell/`): pick the
   worlds you fear and sell NEAR there for USDC-if-world.
4. Lend (`/lend/?id=1`): supply USDC in Safe, Normal or Bold and withdraw it. Borrow (`/borrow/?id=1`): post
   collateral in a tier, borrow USDC, and see the health factor in your worst world; repay and take the collateral
   back.
5. Order book (More, then Order book): post a bid or an ask in a world, or take a resting one.
6. At-risk loans (`/liquidate/`): every borrower with a health factor; a loan below 1 can be liquidated for tokens
   or for cash.
7. Propose a market (`/propose/`): a combination of open events, or a new event with its rule and source. Pledge
   on its page (`/proposal/?p=N`); a combination opens by itself at its goal, and pledges are refunded if it does
   not.
8. Resolve (`/resolve/`): each event's question, rule and source, the proposed outcome and its dispute window.
   Once final, the worlds that did not happen die and the surviving world redeems 1:1 for real tokens.
9. Admin (`/admin/`) is the owner's screen: approve or reject new events, pause flags, contract version.

## Verify it yourself

All commands run from the repository root. Rust 1.86.0 is pinned by `rust-toolchain.toml`.

### Contract and maths tests

```bash
cargo test --workspace
```

Measured on 2026-11-12 on `main`: 551 tests pass, 0 fail, 0 ignored.

| Test binary | Passed |
|---|---|
| `multiverse-contract` unit tests | 413 |
| `multiverse-math` unit tests | 64 |
| `multiverse-math` `tests/pools.rs` | 23 |
| `multiverse-math` `tests/properties.rs` | 14 |
| `multiverse-math` `tests/libraries.rs` | 10 |
| `multiverse-math` `tests/reference_vectors.rs` (4,188 reference vector lines generated from the prototype's maths) | 2 |
| `mock-ft` unit tests | 25 |

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
NEAR_NETWORK=sandbox pnpm -C scripts demo-sale    # Alice sells 2,000 NEAR and borrows 3,000 USDC in both scenarios
NEAR_NETWORK=sandbox pnpm -C scripts e2e          # seeds a fresh demo and runs the acceptance flow
pnpm -C scripts sandbox stop
```

Expected lines (from a run on 2026-11-12 from `main`; the TWAP prices, and the SHIPS·CUTS and SHIPS
collateral values priced from them, depend on how many blocks the sandbox skips and can differ slightly between
runs; the proceeds, health factors and max borrows do not):

```
seed:
2,000 NEAR sale, pool alone: 4748.29 USDC, average 2.3741
2,000 NEAR sale, Ravi's bid then the pool: 4881.88 USDC, average 2.4409

demo-sale:
world 0 SHIPS·CUTS: wNEAR-if-w 2000.00, USDC-if-w 0.00 | collateral value 7399.27 | TWAP price 3.6996
world 1 DELAYED·CUTS: wNEAR-if-w 0.00, USDC-if-w 5865.05 | collateral value 5865.05 | TWAP price 2.9973
world 2 SHIPS·HOLDS: wNEAR-if-w 0.00, USDC-if-w 6451.55 | collateral value 6451.55 | TWAP price 3.2970
world 3 DELAYED·HOLDS: wNEAR-if-w 0.00, USDC-if-w 4881.88 | collateral value 4881.88 | TWAP price 2.4971
worst world: DELAYED·HOLDS | HF 1.22 | max borrow at HF 1: 3661.41
worst world: DELAYED | HF 1.36 | max borrow at HF 1: 4105.53

e2e (last lines):
== summary
  ok      1. grid, disconnected
  ok      2. register and connect Alice
  ok      3-4. sell in DELAYED·CUTS, SHIPS·HOLDS and DELAYED·HOLDS
  ok      5. borrow 3000
  ok      6. lend (Leo supplies and withdraws all)
  ok      7. order book in SHIPS·CUTS (Ravi asks 3.75, bids 3.60 for 1,000 NEAR each; Sam takes the ask)
  ok      8. Root LP (Uma deposits 5,000 NEAR + 20,000 USDC, withdraws all)
  ok      9. admin pushes DELAYED·HOLDS down with 3,000 NEAR; Carl's unhedged loan
  ok      9b. Leo liquidates Carl (repay max, half the debt at most)
  ok      10. resolution: the reporter proposes Fed HOLDS, SPICE resolves DELAYED
  ok      11a. Alice closes her loan and redeems
  ok      11b. Ravi redeems his DELAYED·HOLDS position
  ok      12. failure paths
```

In the binary scenario Alice's DELAYED proceeds are 5474.04 USDC-if-w. The sandbox skips blocks instead of waiting
for the TWAP window. After every step that moves tokens `e2e` checks the contract's views and that every world of both scenarios is
still fully backed; Leo's liquidation took Carl from HF 0.86 to 0.93. Transaction hashes differ on every run.

The same flow runs on testnet with `NEAR_NETWORK=testnet pnpm -C scripts e2e` (it needs the owner and persona keys
in `.keys/testnet/`, so only the team can run it). It prints every transaction with its nearblocks link and waits in
real time where the sandbox skips blocks, including the 30-minute TWAP window. Against the deployed code
`G6GtUs6A...` it ran on 2026-11-12 from 12:08 to 12:47 UTC and printed the same 13 `ok` lines, with 88 transactions
and real waits (56 s for the new pools, 30 minutes for the TWAP to take the pushed-down DELAYED·HOLDS price, 12 s of
dispute window). Alice's DELAYED·HOLDS proceeds were 4881.88 and her HF 1.22, as on the sandbox; Leo's liquidation
took Carl from HF 0.86 to 0.95. The testnet demo was seeded again afterwards, at 12:56 UTC (scenarios 5 and 6).

### Script and web tests

```bash
pnpm -C scripts test       # 105 tests: 104 pass, 1 skipped (the live FRED query)
pnpm -C scripts test:live  # the 18 FRED tests, including the live query
pnpm -C web install && pnpm -C web test   # vitest: 107 tests in 17 files
```

The browser acceptance flow (Playwright, against fixtures, testnet and the sandbox) is described in `web/README.md`.

### The wasm build

```bash
pnpm -C scripts build:wasm
```

It builds both contracts with `cargo near build non-reproducible-wasm --locked`, rewrites local paths out of the
binaries, checks that none is left and prints the sha256 of each. Three builds at different paths (two clean clones
of commit `04a3d42` and the main checkout) printed the same contract hash:

```
e0392c0eb7fe7a1af0d1f733f0dcc05aa94a33d320dd4d2ff576a83265da6311  multiverse_contract.wasm
```

The mock token's sha256 is `70a12a7f3432df1f59f176cb756ff4431c59f382ed7f10923bcd831542b3c0a1`.

In base58 these are the code hashes on testnet: `G6GtUs6AqHfxRb8YCdBx5dv1bgiQ3c1gDhPE9ygQTkEt` on
`app.multiverse-near.testnet` (deployed on 2026-11-12 at 12:08 UTC by `pnpm -C scripts deploy:contract`, deploy and
init transaction [`F5X2U1CS...`](https://testnet.nearblocks.io/txns/F5X2U1CSpptsNUEUeeeixcw79ERvfGLFEpREwpnMvWc3)) and
`8afCVgFKDom2fYt5BZatMXPLXMiJ1vWHBiUTpN6AyggY` on both token accounts. To read one:

```bash
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"app.multiverse-near.testnet"}}' \
  | grep -o '"code_hash":"[^"]*"'
```

Before `1ad9891`, two view types were both named `RootLpHolding` and the near-sdk ABI embedded in the wasm
described whichever one the build picked, so clean builds could differ. `1ad9891` renames the lend view's copy to
`RootLpHoldingView` (the JSON is unchanged).

## Real-data resolution

The demo has a third event that has already happened, resolved from real data:

- Question: "Did the Fed cut at its October 27-28, 2026 meeting?" (outcomes CUTS, HOLDS).
- Rule, stored on-chain with the event: "CUTS if and only if both limits of the federal funds target range (FRED
  DFEDTARU and DFEDTARL) are lower on 2026-10-29 than on 2026-10-27; HOLDS if neither is; if they disagree, nothing
  is reported."
- Data: FRED shows DFEDTARU 4.00 and DFEDTARL 3.75 on both dates, so the answer is HOLDS.

It resolves through OutLayer with `scripts/outlayer.ts`:

```bash
NEAR_NETWORK=testnet pnpm -C scripts outlayer configure --url <https url> --sha256 <hex>   # owner
NEAR_NETWORK=testnet pnpm -C scripts outlayer request [--event <id>] [--as <account>]     # anyone
```

`configure` pins the guest wasm URL and its sha256 on the contract and gives the event its two FRED dates.
`request` pays OutLayer's deposit; OutLayer runs `oracle/fred-guest` in a TEE worker and resumes the call, the
contract proposes the answer with source `outlayer` under the 30 s dispute window, and anyone then finalizes. The
pinned guest is https://multiverse-lending.vercel.app/outlayer/fred-guest.wasm (408,875 bytes, sha256
`8c809e11f5b4b37627baa5c0a65a8587ef5f3e4918d1e0bb42cb2f87a5ae1660`), the exact output of
`oracle/fred-guest/build.sh`.

On the current deployment the event is event 9, resolved on 2026-11-12 by these transactions:

- `set_outlayer_config` (owner): https://testnet.nearblocks.io/txns/FUZHqurtQEqXxGjLwDuWzjNZ8pYR8wdYJVX2kHsUNaJM
- `set_outlayer_dates(9, 2026-10-27, 2026-10-29)` (owner): https://testnet.nearblocks.io/txns/5XjagKSwJB2S9G3uyYtHJvLVSiyJtVRHowoeaNr7URHC
- `request_resolution(9)` (Leo, 0.005 NEAR and 300 Tgas): https://testnet.nearblocks.io/txns/5DKPy7JXgjs4UMP8Bpt2AEyepa4QVswQcBRtwu6p4rgk. The
  contract's callback ran 15 s later; OutLayer reported a 1,655 ms run and charged 0.0011655 NEAR, refunding the rest.
- `finalize(9)` (Leo, after the 30 s dispute window): https://testnet.nearblocks.io/txns/Aygmi1WCCzuEhxMADrQ3eTes1KAeFyyrRg3y7G4epgGE

Evidence logged with the proposal: `FRED DFEDTARU 2026-10-27=4.00 2026-10-29=4.00, DFEDTARL 2026-10-27=3.75 2026-10-29=3.75: HOLDS`.

To repeat the read without signing anything: `pnpm -C scripts test:live` queries FRED and checks the HOLDS answer.
The two grid events (SPICE, December Fed) have not happened yet. In the demo they resolve from
`deployments/demo-outcomes.json`, a file the team controls, and the app says so; `scripts/resolver.ts` proposes them
with the reporter's function-call key.

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
     +------------------> app.multiverse-near.testnet ------------------------------+
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
                                                    finalize       |         | (runs oracle/fred-guest)
                          resolver.multiverse-near.testnet --------+    outlayer.testnet
                          (function-call key; scripts/resolver.ts)
```

| Path | What |
|---|---|
| `contracts/multiverse` | The protocol contract: `receiver`, `router`, `core`, `masks`, `ledger`, `nep245`, `oracle`, `outlayer`, `amm`, `orders`, `lending`, `rootlp`, `storage`, `payout`, `views`, `admin`, `events` |
| `crates/multiverse-math` | Integer maths with no NEAR dependency: fixed point and `mul_div`, tick maths, constant-product pools, dynamic fee, TWAP, odds, shares, order maths, worst-world risk |
| `contracts/mock-ft` | The NEP-141 test token with an open mint capped per call |
| `oracle/fred-guest` | The program OutLayer runs to read FRED (WASI, built on its own) |
| `scripts` | Accounts, deploy, sandbox, seed, demo sale, reset, resolver, OutLayer, end-to-end flow (TypeScript, near-api-js) |
| `web` | The Next.js app (static export, no server) |

`docs/DESIGN.md` explains how each part works.

## NEAR features used

- **`ft_transfer_call` with an action.** Every action that takes real tokens is one `ft_transfer_call` whose `msg`
  names it: `deposit`, `split`, `conditional_sell`, `conditional_buy`, `sell_and_borrow`, `post_order`, `supply`,
  `repay`, `deposit_collateral`, `liquidate`, `close_after_resolution`, `lp_deposit`, `spot_swap`. No approval step.
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
- **A function-call key for the reporter.** `resolver.multiverse-near.testnet` holds a key that can call only
  `report_outcome` and `finalize` on the contract, with a 0.5 NEAR allowance. The resolver signs with it.
- **OutLayer.** `request_resolution` calls `request_execution` on `outlayer.testnet` with a pinned wasm URL and
  sha256; OutLayer runs `oracle/fred-guest` in a TEE (Intel TDX) worker and resumes the call (NEP-519 yield) with
  the result, which `on_outlayer_result` turns into an ordinary proposal under the same dispute window. It has 16
  contract unit tests and 12 guest tests. On testnet it resolved the past Fed event (event 9) HOLDS on 2026-11-12 (see "Real-data resolution").
- **Named accounts.** The contract, tokens, reporter and personas are sub-accounts of `multiverse-near.testnet`.
- **NEP-297 events** under the standard `multiverse` for every protocol action.

## Demo numbers

The demo seeds four world pools at 3.70 (SHIPS·CUTS), 3.00 (DELAYED·CUTS), 3.30 (SHIPS·HOLDS) and 2.50
(DELAYED·HOLDS) USDC per NEAR, and the binary SPICE market at 3.40 (SHIPS) and 2.80 (DELAYED). With SHIPS at 66.67%
and the Fed's CUTS at a 1% fallback (the Polymarket API was unreachable from the seeding machine; the app labels the
odds source), the implied spot is 3.0376. DELAYED·HOLDS is the thin pool, with Ravi's standing bid there of 2.4500
USDC per NEAR for 1,000 NEAR. Alice sells 2,000 NEAR in DELAYED·CUTS, SHIPS·HOLDS and DELAYED·HOLDS, keeps it in
SHIPS·CUTS, and borrows 3,000 USDC:

| | |
|---|---|
| 2,000 NEAR into the DELAYED·HOLDS pool alone | 4,748.29 USDC |
| Ravi's bid for 1,000 NEAR, then the pool | 4,881.88 USDC |
| Proceeds in DELAYED·CUTS / SHIPS·HOLDS | 5,865.05 / 6,451.55 USDC |
| Health factor after borrowing 3,000 (worst world DELAYED·HOLDS) | 1.22 (4,881.88 × 0.75 / 3,000) |
| Binary market: 2,000 NEAR-if-DELAYED sold, 3,000 borrowed | HF 1.36 |

These are the prototype's demo numbers in USD; the NEAR version runs them at NEAR prices. The contract test
`golden_demo_sale` (`contracts/multiverse/src/tests/router.rs`) checks the per-world proceeds against the
prototype's raw values (within 1e-12 USDC) and the health factor against the prototype's (within 1e-15). The
sandbox run above prints the same numbers.

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
- wNEAR and USDC are mock tokens that anyone can mint, up to 1,000,000 wNEAR or 10,000,000 USDC per call. They have
  no value.
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
- Testnet only; nothing has been deployed or tested on mainnet.
- The contract has no state migration; a change to its layout needs a fresh deployment.
- The grid events (SPICE, December Fed) resolve from a file the team controls.
- The testnet demo is shared: its state is whatever the last seeding, sale or test run left.

## History and disclosure

The market design of IfVerse (then called Multiverse Lending) first existed as a hackathon prototype on an EVM chain
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
- Scripts: `near-api-js` 7.4.0, `tsx`, TypeScript.
- Web: Next.js, React, Tailwind CSS, framer-motion, TanStack Query, `@hot-labs/near-connect` 0.12.0,
  `near-api-js` 7.4.0; tests with Vitest and Playwright.
- Build: `cargo-near` 0.17.0.
- Data: FRED (Federal Reserve Bank of St. Louis), series DFEDTARU and DFEDTARL.

## License

MIT, see `LICENSE`.
