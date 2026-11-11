//! Integer maths for Multiverse Lending on NEAR.
//!
//! The protocol contract calls into this crate for every number it computes, so the same code runs in the wasm and in
//! native tests. There are no floats and no NEAR dependencies. Amounts are `u128` in 18-decimal units, prices are
//! WAD-scaled (`1e18` = 1.0), fees are in pips (`1_000_000` = 100%) and time is whole seconds.
//!
//! Every formula is a port of the Solidity version in the EVM project (OpenZeppelin `mulDiv`, the protocol's
//! `SharesMath`). Rounding always favours the protocol: what users receive rounds down, what they pay rounds up.
//!
//! Failure model. Functions that mirror a Solidity revert panic with the Solidity error name (`MulDivOverflow`), the
//! same way checked arithmetic reverts on the EVM; near-sdk turns the panic into a readable failure that rolls the
//! receipt back. Where a caller has to carry on instead (quotes and views), there is a `checked_*` variant returning
//! `Option`.
//!
//! Storage. [`U256`] derives borsh 1.x, the version near-sdk 5.14 uses, so it can live inside `near_sdk::store`
//! collections. On non-wasm builds it also derives `BorshSchema`, which near-sdk needs when it builds the ABI of a
//! `#[near(serializers = [borsh])]` type that holds it.

#![forbid(unsafe_code)]

pub mod fixed;
pub mod shares;

pub use fixed::{
    checked_mul_div, checked_mul_div_u256, isqrt_u256, isqrt_u512, mul_div, mul_div_down,
    mul_div_u256, mul_div_up, Rounding, Q128, Q96, U256, U512, WAD,
};
