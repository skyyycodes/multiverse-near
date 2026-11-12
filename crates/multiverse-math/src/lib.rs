//! Integer maths for Multiverse Lending on NEAR.
//!
//! The protocol contract calls into this crate for every number it computes, so the same code runs in the wasm and in
//! native tests. There are no floats and no NEAR dependencies. Amounts are `u128` in 18-decimal units, prices are
//! WAD-scaled (`1e18` = 1.0), fees are in pips (`1_000_000` = 100%) and time is whole seconds.
//!
//! Every formula follows the protocol's reference maths (full-width `mul_div`, the `TickMath` port, `SharesMath`,
//! `OrderMath`, `PriceMath`, `SwapFlow`, `TwapOracle` and `OddsTree`) or, for the pools, the constant-product
//! equivalent of a full-range concentrated-liquidity position. Rounding always favours the protocol: what users
//! receive rounds down, what they pay rounds up.
//!
//! Failure model. Functions that cannot carry on panic with a short error name (`InvalidTick(-887273)`,
//! `MulDivOverflow`); near-sdk turns the panic into a readable
//! failure that rolls the receipt back. Where a caller has to carry on instead (quotes and views), there is a
//! `checked_*` variant returning `Option`, and pool operations return [`cpmm::CpmmError`].
//!
//! Storage. The stateful types ([`cpmm::Pool`], [`cpmm::Position`], [`flow::SwapFlow`], [`twap::TwapOracle`] and
//! [`U256`]) derive borsh 1.x, the version near-sdk 5.14 uses, so they can live inside `near_sdk::store`
//! collections. On non-wasm builds they also derive `BorshSchema`, which near-sdk needs when it builds the ABI of a
//! `#[near(serializers = [borsh])]` type that holds them. With the `serde` feature they also serialize to JSON, with
//! big integers as decimal strings.

#![forbid(unsafe_code)]

pub mod cpmm;
pub mod fixed;
pub mod flow;
pub mod odds;
pub mod orders;
pub mod price;
pub mod risk;
#[cfg(feature = "serde")]
mod serde_impls;
pub mod shares;
pub mod tick;
pub mod twap;

pub use fixed::{
    checked_mul_div, checked_mul_div_u256, isqrt_u256, isqrt_u512, mul_div, mul_div_down,
    mul_div_u256, mul_div_up, Rounding, Q128, Q96, U256, U512, WAD,
};
