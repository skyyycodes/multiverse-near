# Testing

Every layer below runs from the repository root. The counts were measured on 2026-11-12 on `main`. The property
tests draw new random cases on every run, so the statistics they print change from run to run; the pass/fail
result should not.

## Quick reference

| Layer | Command | Result measured |
|---|---|---|
| Rust: maths, contract, mock token | `cargo test --workspace` | 551 passed, 0 failed |
| Formatting and lints | `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| The six invariants, with their statistics | `cargo test -p multiverse-contract invariant_ -- --nocapture` | 7 passed (invariant 1 runs twice, once with a 24-decimal wNEAR) |
| OutLayer guest | `cd oracle/fred-guest && cargo test --locked` | 12 passed |
| Scripts | `pnpm -C scripts test` | 105 tests: 104 passed, 1 skipped (live FRED) |
| Scripts with live FRED | `pnpm -C scripts test:live` | the 18 FRED tests, including the live query |
| Web unit tests | `pnpm -C web test` | 107 passed in 17 files |
| Web typecheck and lint | `pnpm -C web typecheck` and `pnpm -C web lint` | clean |
| End-to-end on a sandbox node | see "Sandbox end to end" below | all 13 steps ok |
| Browser flows (Playwright) | see `web/README.md` | not re-run for this document |

## Maths crate (`crates/multiverse-math`)

The integer maths the contract calls for every number: fixed point and `mul_div`, tick maths, constant-product
pools, the dynamic fee, the TWAP ring, odds, shares, order maths and worst-world risk.

| Binary | Tests | What it covers |
|---|---|---|
| unit tests in `src/` | 64 | Each module's own cases: rounding directions, overflow panics, fee window, TWAP spacing, serde forms |
| `tests/reference_vectors.rs` | 2 | A differential test. `tests/vectors/reference-vectors.txt` (4,188 lines) holds reference vectors generated from the prototype's maths (`TickMath`, the full-width `mulDiv`, `PriceMath`, `OddsTree`, `SharesMath`, `OrderMath`, `SwapFlow` and `TwapOracle`) from a fixed pseudo-random input chain. Every line must come out the same here, bit for bit |
| `tests/libraries.rs` | 10 | The TWAP oracle and the price conversions against the reference test suite, same inputs and assertions; its fuzz tests run as proptests with 512 cases |
| `tests/pools.rs` | 23 | The pool layer: the dynamic fee and the TWAP, the spot pool's price moves, the odds, and the demo's golden numbers at NEAR scale (a few USDC per NEAR, pools 100,000 NEAR deep), on the constant-product pool |
| `tests/properties.rs` | 14 | Proptests (512 to 1,024 cases each): integer maths agrees with wide references, pools never lose value to rounding, fees stay within base and cap, share and order maths never favour the user, odds always add up to 1, a liquidation slice covers its repayment |

## Contract unit tests (`contracts/multiverse/src/tests`)

413 tests that run natively against near-sdk's mocked runtime, one file per area. `harness.rs` drives the contract
like a chain would: it runs `ft_on_transfer` the way a token contract calls it, resolves payout promises (with an
option to fail them), moves block time, and checks conservation: for every verse token, supply equals what accounts,
pools, order escrow, collateral and the Root LP vault hold.

| File | What it covers |
|---|---|
| `core.rs`, `oracle.rs` | The core (events, scenarios, splits, merges, redemptions, resolution) and the event oracle, test by test |
| `probes.rs` | Edge cases probed against the reference behaviour, pinned here |
| `masks.rs` | World masks, partitions, live, dead and collapsed |
| `receiver.rs` | `ft_on_transfer`: every action, refunds of the unused part, dust, rejection of other tokens and malformed `msg` |
| `payout.rs` | Payouts after state changes, failed `ft_transfer` re-credited by `on_payout` |
| `nep245.rs` | NEP-245 transfers, batch transfers, `mt_transfer_call` and its refund, views, enumeration, metadata, events |
| `nep145.rs` | Registration, charging per call, withdraw and unregister |
| `events.rs` | NEP-297 and NEP-245 log shapes for split, merge, redeem, oracle and config changes |
| `amm.rs`, `amm_lens.rs` | Pools, the dynamic fee, TWAP, depth gate, halts, quotes equal to execution, odds, implied spot, and the demo's numbers (4,748.29 pool alone; 4,881.88 through Ravi's bid) |
| `orders.rs` | Posting, filling, cancelling, escrow rounding, epochs, expiry, halts, minimum sizes, the open-order indexes |
| `router.rs` | Conditional sell and buy, sell-and-borrow, posting from real assets, close after resolution, strict plans, and `golden_demo_sale` |
| `lending.rs`, `liquidation.rs` | Supply, collateral, borrow, repay, interest, worst-world health, liquidation sizing and its pauses |
| `rootlp.rs` | Root LP deposits, joins, withdrawals, fees, behaviour across resolution |
| `views.rs` | The per-screen snapshot views |
| `outlayer.rs` | 16 tests: configuration, the request, and a callback that never panics on a failed, `null` or malformed result |
| `security.rs` | One regression test per finding of `docs/SECURITY.md`, each first written as a failing test against the unfixed code |

`golden_demo_sale` runs the demo end to end at NEAR scale: the seeded pools, Bob's supply, Ravi's bid, Alice's
2,000 NEAR sale in the L-shape and her 3,000 USDC loan. It checks the per-world proceeds (5,865.05, 6,451.55,
4,881.88) against the prototype's raw demo values within 1e-12 USDC, the health factor 1.22 against the prototype's
within 1e-15, the binary market's proceeds (5,474.04) and HF 1.36, and the fee each pool charges next.

## The six invariants

Each is a stateful property test: 256 cases, each a random sequence of 50 to 200 actions, with the invariant
checked after every action. Each test prints what it did (how many calls of each kind succeeded, resolutions,
liquidations); run with `--nocapture` to see it.

| # | Test | What must hold |
|---|---|---|
| 1 | `invariant_1_backing`, `invariant_1_backing_with_24_decimal_wnear` (`tests/invariants.rs`) | For every scenario, asset and possible world, the supply of tokens covering that world equals the scenario's reserves; no root token exists; every token's supply is what its holders, pools, escrow, collateral and the vault hold; the contract's token balance is reserves plus internal balances, also with a 24-decimal wNEAR, where a deposit's remainder below one internal unit must go straight back |
| 2 | `invariant_2_dead_stays_dead` (`tests/invariants.rs`) | Nothing on a dead verse succeeds, and a dead token's supply never changes after its verse dies |
| 3 | `invariant_3_resolution_never_lowers_hf` (`tests/lending_invariants.rs`) | Resolving an event never lowers any borrower's health factor |
| 4 | `invariant_4_liquidation_covers_repayment` (`tests/lending_invariants.rs`) | When the worst-world collateral covers the repayment plus the bonus, the seized slice is worth at least the repayment in every possible world at the same block's prices; liquidations without that cover are counted and printed as bad debt, never filtered out |
| 5 | `invariant_5_order_book_escrow` (`tests/order_invariants.rs`) | Every open bid holds at least the cost of its remaining amount, every open ask exactly its remaining amount, closed orders hold nothing, and per token the supply is what actors hold plus open escrow |
| 6 | `invariant_6_no_fill_after_resolution` (`tests/order_invariants.rs`) | No fill after a resolution or after expiry, and only the maker can cancel |

One run of `invariant_4` on 2026-11-12 made 1,089 liquidations; in 1,028 the precondition held and none failed
coverage; 61 were printed as bad-debt cases. Invariants 3 and 4 price worlds from a constant-product model of each
pool rather than the contract's TWAP, so they check the lending maths, not the price source (see ECON-1 and ECON-2
in `docs/SECURITY.md`).

## Mock token (`contracts/mock-ft`)

25 unit tests: metadata and the faucet configuration, a 24-decimal token minting up to its cap, transfers,
`ft_transfer_call` refunds, storage registration and unregistering, the capped `mint` and the owner's cap changes,
and the rule that `mint` registers a new account only for the caller itself or the owner.

## OutLayer guest (`oracle/fred-guest`)

12 tests of the program OutLayer runs: CUTS and HOLDS by both limits, `null` when they disagree, when a row is missing
or when a request fails, and whole-basis-point parsing. It is a separate crate for `wasm32-wasip2`. `./build.sh`
produces the wasm the contract pins (408,875 bytes, sha256 `8c809e11...`, the file served at
https://multiverse-lending.vercel.app/outlayer/fred-guest.wasm). Running it locally with `wasmtime run -S http`
against live FRED is described in `oracle/fred-guest/README.md`.

## Scripts (`scripts/lib/*.test.ts`)

Node's test runner over the TypeScript the scripts share: units and amount parsing, the demo constants, the
deployments file, the RPC client, Polymarket odds parsing, FRED parsing and the HOLDS/CUTS rule on recorded CSVs,
the OutLayer configuration and result checks, and the resolver (it maps an answer to an outcome by name, and writes
nothing for an event that asks another question). `test:live` adds one query against fred.stlouisfed.org.

## Web (`web/src/**/*.test.ts`)

Vitest: number formatting, units, the order book and sale planner, settlement, lending maths, spot maths,
transaction encoding, reading a refunded `ft_transfer_call` as a failure, the RPC fallbacks, the testnet faucet
(which mints it sends, within the cap, and when the home screen offers it), when the home screen shows an "In
Multiverse" balance, and the design fixtures' golden numbers. `decode.live.test.ts` decodes view answers captured
from a freshly seeded sandbox node, so a renamed field fails here instead of as a blank screen.

Playwright (`web/e2e`) covers the browser: the acceptance flow on a phone and a desktop against design fixtures, the
real build against testnet, the demo-wallet build signing against a stand-in RPC, and (`pnpm e2e:live`) the full
flow against a seeded sandbox node. Commands are in `web/README.md`.

## Sandbox end to end (`scripts/e2e.ts`)

The acceptance flow as transactions, against the compiled wasm on a local nearcore 2.6.5 sandbox node: the grid,
registration, Alice's 2,000 NEAR sale through Ravi's bid, the 3,000 USDC loan at HF 1.22, Leo lending and
withdrawing, Ravi's quotes and Sam taking the ask, Uma's Root LP deposit and withdrawal, the owner pushing
DELAYED·HOLDS down with 3,000 NEAR until Carl's unhedged loan is liquidatable, Leo liquidating half of it, the
reporter's proposal through its dispute window (with trading and liquidation refused meanwhile), the owner's
override, Alice's close and redeem, Ravi's redeem, and the failure paths (a stale order after resolution, an amount
above the wallet, a malformed `msg` whose tokens come back). After every step it checks the contract's views and
that every world of both scenarios is fully backed.

```bash
pnpm -C scripts install
pnpm -C scripts build:wasm
pnpm -C scripts sandbox start --fresh
NEAR_NETWORK=sandbox pnpm -C scripts seed
NEAR_NETWORK=sandbox pnpm -C scripts demo-sale
NEAR_NETWORK=sandbox pnpm -C scripts e2e
pnpm -C scripts sandbox stop
```

The README lists the expected output and how to get the sandbox binary. The run on 2026-11-12 from `main` ended with
all 13 steps `ok`, and Leo's liquidation took Carl from HF 0.86 to 0.93; the sandbox skips blocks where testnet would
wait for the TWAP window. `NEAR_NETWORK=testnet pnpm -C scripts e2e` runs the same flow on testnet; it needs the keys
of the deployment's accounts and waits out the 30-minute TWAP window in real time.
