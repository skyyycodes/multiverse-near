//! Fixed-point basics: `WAD`, 256- and 512-bit integers, `mul_div` with explicit rounding and integer square roots.
//!
//! `mul_div` is the classic full-width multiply-divide: the product is formed at full width, so only the final quotient
//! has to fit. The plain functions panic with an error name (`DivisionByZero`, `MulDivOverflow`); the
//! `checked_*` ones return `None` instead.

pub use wide::{U256, U512};

/// 1.0 in 18-decimal fixed point.
pub const WAD: u128 = 1_000_000_000_000_000_000;

// uint 0.10: no_std, MSRV 1.56, builds for wasm32 on the pinned 1.86, and gives fixed-width U256/U512 with the
// div_mod and integer_sqrt used here. primitive-types would only add Ethereum hash types on top of the same macro;
// ruint's current releases need a newer compiler than 1.86.
mod wide {
    // The arithmetic in here comes from the uint macro, which predates these clippy lints.
    #![allow(clippy::manual_div_ceil, clippy::assign_op_pattern)]

    use borsh::{BorshDeserialize, BorshSerialize};
    use uint::construct_uint;

    construct_uint! {
        /// Unsigned 256-bit integer, four little-endian 64-bit words (borsh: 32 bytes).
        #[derive(BorshSerialize, BorshDeserialize)]
        #[cfg_attr(not(target_arch = "wasm32"), derive(borsh::BorshSchema))]
        pub struct U256(4);
    }

    construct_uint! {
        /// Unsigned 512-bit integer, used for intermediate products only.
        pub struct U512(8);
    }
}

/// 2^96, the scale of a Q64.96 square-root price.
pub const Q96: U256 = U256([0, 1 << 32, 0, 0]);
/// 2^128, the scale of Q128 fee growth.
pub const Q128: U256 = U256([0, 0, 1, 0]);

impl From<U256> for U512 {
    fn from(value: U256) -> Self {
        let mut words = [0u64; 8];
        words[..4].copy_from_slice(&value.0);
        U512(words)
    }
}

impl TryFrom<U512> for U256 {
    type Error = &'static str;

    fn try_from(value: U512) -> Result<Self, Self::Error> {
        if value.0[4..].iter().any(|word| *word != 0) {
            return Err("integer overflow when casting to U256");
        }
        let mut words = [0u64; 4];
        words.copy_from_slice(&value.0[..4]);
        Ok(U256(words))
    }
}

/// Rounding direction of a division.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rounding {
    /// Toward zero (floor, for non-negative values).
    Down,
    /// Away from zero (ceiling).
    Up,
}

/// `a * b / d` rounded as asked, or `None` if `d == 0` or the quotient does not fit a `u128`.
///
/// The product is exact (it always fits 256 bits), so this never loses precision before the final division.
pub fn checked_mul_div(a: u128, b: u128, d: u128, rounding: Rounding) -> Option<u128> {
    if d == 0 {
        return None;
    }
    // Most products in the protocol fit 128 bits; native arithmetic is much cheaper in the wasm.
    if let Some(product) = a.checked_mul(b) {
        let quotient = product / d;
        let round_up = rounding == Rounding::Up && product % d != 0;
        // A remainder means d >= 2, so quotient <= u128::MAX / 2 and the +1 cannot overflow.
        return Some(quotient + u128::from(round_up));
    }
    let (quotient, remainder) = (U256::from(a) * U256::from(b)).div_mod(U256::from(d));
    let quotient = if rounding == Rounding::Up && !remainder.is_zero() {
        quotient + U256::one()
    } else {
        quotient
    };
    u128::try_from(quotient).ok()
}

/// `a * b / d` rounded as asked. Panics with `DivisionByZero` or `MulDivOverflow` (result above `u128::MAX`).
#[track_caller]
pub fn mul_div(a: u128, b: u128, d: u128, rounding: Rounding) -> u128 {
    match checked_mul_div(a, b, d, rounding) {
        Some(value) => value,
        None => mul_div_failed(d == 0),
    }
}

/// `floor(a * b / d)`; panics like [`mul_div`].
#[track_caller]
pub fn mul_div_down(a: u128, b: u128, d: u128) -> u128 {
    mul_div(a, b, d, Rounding::Down)
}

/// `ceil(a * b / d)`; panics like [`mul_div`].
#[track_caller]
pub fn mul_div_up(a: u128, b: u128, d: u128) -> u128 {
    mul_div(a, b, d, Rounding::Up)
}

/// `a * b / d` over 256-bit operands with a 512-bit product, or `None` if `d == 0` or the quotient overflows.
pub fn checked_mul_div_u256(a: U256, b: U256, d: U256, rounding: Rounding) -> Option<U256> {
    if d.is_zero() {
        return None;
    }
    let (quotient, remainder) = (U512::from(a) * U512::from(b)).div_mod(U512::from(d));
    let quotient = if rounding == Rounding::Up && !remainder.is_zero() {
        quotient + U512::one()
    } else {
        quotient
    };
    U256::try_from(quotient).ok()
}

/// [`checked_mul_div_u256`] that panics with `DivisionByZero` or `MulDivOverflow`.
#[track_caller]
pub fn mul_div_u256(a: U256, b: U256, d: U256, rounding: Rounding) -> U256 {
    match checked_mul_div_u256(a, b, d, rounding) {
        Some(value) => value,
        None => mul_div_failed(d.is_zero()),
    }
}

#[track_caller]
fn mul_div_failed(division_by_zero: bool) -> ! {
    if division_by_zero {
        panic!("DivisionByZero")
    }
    panic!("MulDivOverflow")
}

/// Largest `r` with `r * r <= x`.
pub fn isqrt_u256(x: U256) -> U256 {
    x.integer_sqrt()
}

/// Largest `r` with `r * r <= x`.
pub fn isqrt_u512(x: U512) -> U512 {
    x.integer_sqrt()
}

/// Checked `u128` addition that panics with `Overflow`.
#[track_caller]
pub(crate) fn add(a: u128, b: u128) -> u128 {
    a.checked_add(b).unwrap_or_else(|| panic!("Overflow"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants() {
        assert_eq!(Q96, U256::one() << 96);
        assert_eq!(Q128, U256::one() << 128);
        assert_eq!(WAD, 10u128.pow(18));
    }

    #[test]
    fn widening_and_narrowing() {
        let x = U256::MAX;
        assert_eq!(U256::try_from(U512::from(x)), Ok(x));
        assert!(U256::try_from(U512::from(x) + U512::one()).is_err());
    }

    #[test]
    fn mul_div_rounding() {
        assert_eq!(mul_div_down(7, 3, 2), 10);
        assert_eq!(mul_div_up(7, 3, 2), 11);
        assert_eq!(mul_div_up(6, 3, 2), 9);
        assert_eq!(mul_div_down(0, 5, 3), 0);
        assert_eq!(mul_div_up(0, 5, 3), 0);
        // The product overflows 128 bits but the quotient does not.
        assert_eq!(mul_div_down(u128::MAX, u128::MAX, u128::MAX), u128::MAX);
        assert_eq!(
            mul_div_up(u128::MAX, u128::MAX - 1, u128::MAX),
            u128::MAX - 1
        );
        assert_eq!(mul_div_down(1 << 127, 4, 8), 1 << 126);
        assert_eq!(checked_mul_div(u128::MAX, 2, 1, Rounding::Down), None);
        assert_eq!(
            checked_mul_div(u128::MAX, u128::MAX, u128::MAX - 1, Rounding::Down),
            None
        );
        assert_eq!(checked_mul_div(1, 1, 0, Rounding::Up), None);
        // Exact quotients of u128::MAX survive rounding up.
        assert_eq!(
            checked_mul_div(u128::MAX, 3, 3, Rounding::Up),
            Some(u128::MAX)
        );
        assert_eq!(
            checked_mul_div(u128::MAX - 1, u128::MAX, u128::MAX - 1, Rounding::Up),
            Some(u128::MAX)
        );
        // (2^43 - 1)(2^86 + 2^43 + 1) = 2^129 - 1: halved, the floor is u128::MAX and only the ceiling overflows.
        let (a, b) = ((1u128 << 43) - 1, (1u128 << 86) + (1 << 43) + 1);
        assert_eq!(checked_mul_div(a, b, 2, Rounding::Down), Some(u128::MAX));
        assert_eq!(checked_mul_div(a, b, 2, Rounding::Up), None);
    }

    #[test]
    #[should_panic(expected = "DivisionByZero")]
    fn mul_div_by_zero_panics() {
        mul_div_down(1, 1, 0);
    }

    #[test]
    #[should_panic(expected = "MulDivOverflow")]
    fn mul_div_overflow_panics() {
        mul_div_up(u128::MAX, u128::MAX, 1);
    }

    #[test]
    fn mul_div_u256_edges() {
        let max = U256::MAX;
        assert_eq!(mul_div_u256(max, max, max, Rounding::Down), max);
        assert_eq!(mul_div_u256(max, max - 1, max, Rounding::Up), max - 1);
        assert_eq!(
            checked_mul_div_u256(max, max, U256::one(), Rounding::Down),
            None
        );
        assert_eq!(
            checked_mul_div_u256(max, U256::from(3), U256::from(2), Rounding::Down),
            None
        );
        assert_eq!(
            checked_mul_div_u256(U256::from(5), U256::from(5), U256::zero(), Rounding::Down),
            None
        );
        assert_eq!(
            mul_div_u256(U256::from(5), U256::from(5), U256::from(2), Rounding::Up),
            U256::from(13)
        );
    }

    #[test]
    fn square_roots() {
        assert_eq!(isqrt_u256(U256::zero()), U256::zero());
        assert_eq!(isqrt_u256(U256::one()), U256::one());
        assert_eq!(isqrt_u256(U256::from(15)), U256::from(3));
        assert_eq!(isqrt_u256(U256::from(16)), U256::from(4));
        assert_eq!(isqrt_u256(U256::MAX), U256::from(u128::MAX));
        assert_eq!(isqrt_u512(U512::MAX), U512::from(U256::MAX));
        let square = U512::from(U256::MAX) * U512::from(U256::MAX);
        assert_eq!(isqrt_u512(square), U512::from(U256::MAX));
        assert_eq!(isqrt_u512(square - U512::one()), U512::from(U256::MAX - 1));
    }
}
