//! Unit tests, run natively against near-sdk's mocked runtime.
//!
//! `core` and `oracle` port the EVM `MultiverseCore.t.sol` and
//! `EventOracle.t.sol` test by test (same names in snake_case, same
//! assertions, error names and argument order); `probes` pins edge cases probed
//! against the EVM code; `invariants` ports `CoreInvariants.t.sol` as
//! property tests. The rest covers what is new on NEAR: NEP-245, NEP-145,
//! the `ft_on_transfer` receiver and payouts.

mod harness;

mod core;
mod events;
mod invariants;
mod masks;
mod nep145;
mod nep245;
mod oracle;
mod order_invariants;
mod orders;
mod payout;
mod probes;
mod receiver;
