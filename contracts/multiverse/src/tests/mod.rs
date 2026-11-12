//! Unit tests, run natively against near-sdk's mocked runtime.
//!
//! `core` and `oracle` cover the core and the event oracle test by test
//! (error names and argument order included); `probes` pins edge cases;
//! `invariants` runs the core invariants as property tests. The rest covers
//! NEP-245, NEP-145, the `ft_on_transfer` receiver and payouts, the pools,
//! the order book, the router, lending and the Root LP.

mod harness;

mod amm;
mod amm_lens;
mod core;
mod events;
mod invariants;
mod lending;
mod lending_invariants;
mod liquidation;
mod masks;
mod nep145;
mod nep245;
mod oracle;
mod order_invariants;
mod orders;
mod outlayer;
mod payout;
mod probes;
mod receiver;
mod rootlp;
mod router;
mod security;
mod views;
