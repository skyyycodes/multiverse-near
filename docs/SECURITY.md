# Security

This is an internal security review of Multiverse Lending on NEAR, done by the people who build it. It is not an
audit, and no third party has reviewed the code. The deployment it describes runs on NEAR testnet with mock tokens.
Do not put real funds into it.

## Scope

| Area | Path |
|---|---|
| Protocol contract: verse algebra, oracle, pools and TWAP, order book, router, lending, Root LP vault, NEP-141 receiver and payouts, NEP-245, NEP-145 storage, admin and views | `contracts/multiverse` |
| Fixed-point maths, CPMM, tick maths, TWAP ring, order and share maths | `crates/multiverse-math` |
| Mock NEP-141 token with an open faucet (testnet only) | `contracts/mock-ft` |
| Deploy, seed, demo sale, reset, e2e and the resolver that proposes outcomes | `scripts` |

The web app is out of scope except where it relies on a contract view (`trade_view` in RT-2).

## Method

1. **Threat model by area.** For each module we listed who can call what, which state it moves, what a caller
   controls (amounts, masks, prices, timing, account ids, `msg`), and what has to hold afterwards. The areas were:
   access control and key types; storage staking; cross-contract calls and callbacks; NEP-141, NEP-145 and NEP-245
   conformance; the oracle state machine and the resolver; pool pricing and the TWAP that lending reads; the order
   book; liquidation sizing; gas and log limits on anything that iterates.
2. **Manual review** of every module, in three passes: NEAR runtime and access control, protocol economics, and
   standards and integration.
3. **Property tests.** The six invariants below run as stateful property tests, 256 cases of 50 to 200 random
   actions each, after every action. Bad-debt liquidations are counted and printed, never filtered out. The maths
   crate has its own property tests and EVM test vectors.
4. **A reproducing test for every finding.** Each finding was first shown by a failing test against the unfixed
   code. After the fix, that test stays in the suite as a regression test (`contracts/multiverse/src/tests/security.rs`
   unless the table says otherwise).

## Findings

| ID | Severity | Title | Status | Regression test |
|---|---|---|---|---|
| ECON-1 | High | One root USDC split pumps every world pool; held for one 60 s TWAP window, it over-borrows the whole USDC market | Mitigated; residual risk accepted (see below) | `pumping_every_world_for_a_minute_does_not_unlock_borrowing` |
| ECON-2 | High | Dumping one world pool for one TWAP window makes a healthy borrower liquidatable at the dumped price | Mitigated; residual risk accepted (see below) | `dumping_one_world_for_a_minute_does_not_liquidate_a_healthy_borrower` |
| RT-1 | Medium | Owner pool creation with no deposit lets a function-call key move the owner's balances into a mispriced pool | Fixed | `owner_creation_methods_need_an_attached_deposit` |
| RT-2 | Medium | Orders are never removed from the scans; dust bids hide real orders from `trade_view`, and closed orders slow `trade_view` and `storage_unregister` without limit | Fixed | `dust_orders_cannot_hide_the_book_from_trade_view`, `closed_orders_do_not_grow_unregister_or_trade_view_gas` |
| RT-3 | Medium | With about 97 or more scenarios on one event, finalize and `admin_resolve` exceed the 100-log limit and the event can never resolve | Fixed | `scenarios_per_event_are_capped_so_resolution_always_fits` |
| STD-1 | Medium | The `mt_resolve_transfer` refund re-creates the sender's entry unpaid; looping it drives `used_bytes` to zero | Fixed | `resolve_refund_is_charged_to_the_sender` |
| RT-4 | Low | A failed payout re-creates the real-balance entry unpaid; looping withdraw-and-fail drives `used_bytes` to zero | Fixed | `failed_payout_recredit_is_charged_to_the_account` |
| STD-2 | Low | `storage_unregister` and `orders_by_maker` read every order ever posted | Fixed (same change as RT-2) | `closed_orders_do_not_grow_unregister_or_trade_view_gas` |
| STD-3 | Low | The resolver maps answers to outcomes by a fixed index, so a misconfigured demo record proposes the opposite outcome | Fixed | `scripts/lib/resolver.test.ts`: "maps a source's answer by outcome name" |
| STD-4 | Low | The faucet registers any number of fresh accounts at the token contract's expense | Fixed | `mint_does_not_sponsor_accounts_for_strangers` in `contracts/mock-ft/src/lib.rs` |

### ECON-1 and ECON-2: lending prices from in-protocol pools

Lending values WETH in each world at that world pool's tick TWAP. With a 60 s window, holding a pool at a false
price for one minute moved the TWAP all the way. A root split gives USDC-if-w in every world at once, so one split
pumps every world together (ECON-1, test `pumping_every_world_for_a_minute_does_not_unlock_borrowing`). Dumping only
the victim's worst world is enough to liquidate them (ECON-2, test
`dumping_one_world_for_a_minute_does_not_liquidate_a_healthy_borrower`).

Changes:

- The TWAP window is 30 minutes. Observations are spaced at `window / 64` seconds, so the 128 kept always span two
  windows however often a pool trades. Cumulatives are exact at every kept observation.
- A pool prices lending once it is 60 s old (`twap_min_age_sec` in `get_app_config`). Until it is a full window old,
  the mean runs over its whole history.
- Lending refuses a world's price while the pool's current tick is more than 953 ticks (a factor of about 1.1) from
  its TWAP. A world without a price counts zero for borrowing and pauses liquidation, the same way the depth gate
  already did. A pool that has been pushed and is still waiting for its TWAP to catch up cannot be used.

What is left: the only price source is the protocol's own pools. Someone who holds a pool at a false price for the
whole 30 minutes still moves its TWAP. On mainnet, arbitrage would make that expensive. On testnet nobody
arbitrages, so the attack still works there for anyone patient enough. The real fix is an independent price
reference (an external feed, or bounding world prices by the spot pool and the odds), together with borrow caps
sized to pool depth. Both change the design and are not done. The spot band also gives a griefer a lever: pushing a
pool out of the band pauses borrowing and liquidation in that world until its TWAP catches up, and keeping it
paused means paying swap fees again and again.

### RT-1: owner creation methods without a deposit

`create_within_pool`, `create_between_pool`, `create_spot_pool`, `create_event` and `create_scenario` now fail with
`DepositRequired` when nothing is attached. A function-call access key cannot attach a deposit, so these methods now
need a full-access key, like every other owner method that moves value. With exactly 1 yoctoNEAR attached, storage
comes from the owner's NEP-145 balance. With more attached, the deposit pays and the excess is refunded. The seed
script now attaches 1 yoctoNEAR. Test: `owner_creation_methods_need_an_attached_deposit`.

### RT-2 and STD-2: order book reads

- Each storage record now carries an open-order count. `has_open_orders`, which `storage_unregister` uses, and the
  per-maker cap read it in O(1).
- A per-scenario index of open order ids serves `open_orders` and `orders_by_maker`. Closed orders stay stored for
  `get_order`, but no read walks them.
- `trade_view` carries each world's best 25 fillable bids and asks, in the order `orders_for_world` uses (price, then
  age, with expired and stale orders skipped), plus every open order the viewer has in the scenario. Before, it was
  the first 200 open ids.
- Orders need a notional of at least 0.0001 USDC, which rules out bids that escrow a few wei. A maker may hold 64
  open orders.

Tests: `dust_orders_cannot_hide_the_book_from_trade_view` and `closed_orders_do_not_grow_unregister_or_trade_view_gas`.
The number of open orders across many accounts is still unbounded. Each one locks escrow and storage, and the
per-world book read grows with it.

### RT-3: scenarios per event

An event can back at most 16 scenarios (`TooManyScenarios`). Resolving such an event writes at most 18 logs (one
per scenario, the finalization, and the proposal when `admin_resolve` is used), far below the 100-log and 16 KB
limits. Test: `scenarios_per_event_are_capped_so_resolution_always_fits`.

### RT-4 and STD-1: storage written by callbacks

`on_payout` (re-credit after a failed `ft_transfer`) and `mt_resolve_transfer` (refund) now charge the bytes they
create to the account they credit. They never fail: if those bytes take an account past its deposit, the account
simply has nothing available to withdraw until it frees some. Accounts that are not registered do not get charged;
the contract absorbs those bytes, as before. Tests: `failed_payout_recredit_is_charged_to_the_account` and
`resolve_refund_is_charged_to_the_sender`.

### STD-3: resolver outcome mapping

The resolver now gets an outcome name from each source (`CUTS`/`HOLDS` from FRED, the name in the team file) and
proposes that name's index in the event's own `outcome_names`. It writes nothing if the name is missing or if the
event's question is not the one it expects. Tests: `scripts/lib/resolver.test.ts`, "maps a source's answer by
outcome name" and "writes nothing for an event that asks another question".

### STD-4: faucet registrations

`mint` registers a new receiver only when the caller mints to itself or the caller is the token's owner. Anyone can
still top up an account that is already registered. Tests in `contracts/mock-ft/src/lib.rs`:
`mint_does_not_sponsor_accounts_for_strangers` and `mint_sponsors_the_caller_itself_and_the_owners_recipients`.

## Invariants

| # | Invariant | Test |
|---|---|---|
| 1 | Backing: for every scenario, asset and possible world, the supply of tokens covering that world equals the scenario's reserves; no root token exists; every token's supply is what its holders, pools, escrow, collateral and the vault hold; the contract's token balance is reserves plus internal balances | `invariant_1_backing` in `contracts/multiverse/src/tests/invariants.rs` |
| 2 | Dead stays dead: nothing on a dead verse succeeds, and a dead token's supply never changes after its verse dies | `invariant_2_dead_stays_dead` in `tests/invariants.rs` |
| 3 | Resolution never lowers a borrower's health factor | `invariant_3_resolution_never_lowers_hf` in `tests/lending_invariants.rs` |
| 4 | When the account's worst-world collateral covers the repayment plus the bonus, the seized slice is worth at least the repayment in every possible world, at the same block's prices; liquidations without that cover are counted and printed as bad-debt cases | `invariant_4_liquidation_covers_repayment` in `tests/lending_invariants.rs` |
| 5 | Order escrow: every open bid holds at least `cost(remaining)`, every open ask exactly `remaining`, closed orders hold nothing, and per token the supply is what actors hold plus open escrow | `invariant_5_order_book_escrow` in `tests/order_invariants.rs` |
| 6 | No fill after a resolution or after expiry, and only the maker can cancel | `invariant_6_no_fill_after_resolution` in `tests/order_invariants.rs` |

Invariants 3 and 4 price worlds from a constant-product model of each pool instead of the contract's TWAP, so they
check the lending maths and not the price source. ECON-1 and ECON-2 are about the price source.

## Trust assumptions

- **The owner is trusted.** The owner can resolve any event at once with `admin_resolve` and can dispute any open
  proposal during its window. The owner creates events, scenarios and pools, and sets the reporter, the dispute
  window and the demo record. There is no timelock and no multisig.
- **One reporter key proposes outcomes.** `report_outcome` accepts only the configured reporter account. The
  resolver signs with a function-call key limited to `report_outcome` and `finalize`. A proposal becomes final after
  a 30 s dispute window unless the owner disputes it, so a wrong proposal that nobody watches becomes final.
- **The demo's grid events resolve from a file in the repository** (`deployments/demo-outcomes.json`) that the team
  controls. Only the past FOMC event resolves from real FRED data.
- **The tokens are mocks.** WETH and USDC are `mock-ft` deployments with an open, capped faucet. They have no value.
- **Liquidity is seeded by the team.** All pool liquidity, Bob's supply and Ravi's order come from the seed script.
  Prices are only as good as that seeding and whatever trading follows.
- **Testnet only.** Nothing here has been deployed or tested on mainnet.

## Known limitations

- Lending prices come from the protocol's own pools (see ECON-1 and ECON-2). With no arbitrage, a patient attacker
  can still move them.
- The spot band can pause borrowing and liquidation in a world while a pool sits far from its TWAP. A real crash
  delays liquidations by up to one window, and in that time bad debt can build up.
- The TWAP window is 30 minutes. The e2e step that waits for the TWAP to take a new price now takes that long on
  testnet. The sandbox skips blocks instead.
- Closed orders stay in storage, paid for by their maker. Open orders across many accounts are not capped overall.
- `trade_view` shows other makers' orders only on single-world masks. Orders on multi-world masks show up through
  `open_orders` and to their own maker.
- Storage is charged to whoever's call creates or frees the bytes. When one account's call removes an entry another
  account paid for, the caller gets the credit.
- This review changed the layout of the storage record and the contract state, so it needs a fresh deployment. The
  contract has no migration.
- This review was done by the people who wrote the code. It does not replace an independent audit.
