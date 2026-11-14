//! Unit tests, run natively against near-sdk's mocked runtime.
//!
//! `core` and `oracle` cover the core and the event oracle test by test
//! (error names and argument order included); `probes` pins edge cases;
//! `invariants` runs the core invariants as property tests. The rest covers
//! NEP-245, NEP-145, the `ft_on_transfer` receiver and payouts, the pools,
//! the order book, the router, lending and the Root LP. `layout` pins the
//! stored layout, `migration` runs `migrate` on the production snapshot,
//! `ops` covers the pause, the owner and guardian, versions and the books,
//! and `profile` holds the v1 profile the fixture installs.

mod harness;
mod profile;

mod amm;
mod amm_lens;
mod bad_debt;
mod core;
mod eight;
mod events;
mod insurance;
mod invariants;
mod layout;
mod lending;
mod lending_invariants;
mod liquidation;
mod masks;
mod migration;
mod nep145;
mod nep245;
mod ops;
mod oracle;
mod order_invariants;
mod orders;
mod outlayer;
mod payout;
mod prices;
mod probes;
mod receiver;
mod reference;
mod rootlp;
mod router;
mod scaffold;
mod security;
mod tiers;
mod views;
