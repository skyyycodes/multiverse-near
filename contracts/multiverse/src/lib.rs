//! Multiverse Lending on NEAR.
//!
//! The whole protocol is one contract: the event oracle, the verse ledger
//! (exposed as NEP-245 multi tokens), the pools, the order book, the money
//! markets and the Root LP vault. Living in one account is what makes every
//! multi-step action atomic; only payouts of real tokens leave as promises.
//!
//! Units: every amount inside the contract is 18-decimal fixed point for both
//! assets. Token amounts are scaled at the NEP-141 boundary (`receiver` on the
//! way in, `payout` on the way out).

#[macro_use]
pub mod errors;
pub mod events;
pub mod masks;
pub mod types;
