//! Prices (`PriceMath`): Q64.96 square-root prices, WAD prices and the wNEAR/USDC orientation.
//!
//! Within-world pools put wNEAR-if-w on the token0 side, so a pool's "token1 per token0" is already USDC per wNEAR and
//! a price read from the mean tick rounds down, in the protocol's favour. The orientation helpers are kept for the
//! other order (and to reproduce the reference vectors, where the order varies).
//!
//! Both sides are 18-decimal internal units, so a raw reserve ratio is the human price.

use crate::fixed::{checked_mul_div, isqrt_u512, mul_div_down, Rounding, U256, U512, WAD};
use crate::tick::{get_sqrt_ratio_at_tick, tick_at_sqrt_ratio_clamped};

/// `floor(sqrt(reserve1 / reserve0) * 2^96)`, the square-root price of a pool holding these reserves; `None` when
/// `reserve0` is 0.
pub fn sqrt_price_x96_from_reserves(reserve0: u128, reserve1: u128) -> Option<U256> {
    if reserve0 == 0 {
        return None;
    }
    // reserve1 * 2^192 < 2^320, and its square root < 2^160.
    let ratio_x192 = (U512::from(reserve1) << 192) / U512::from(reserve0);
    let root = isqrt_u512(ratio_x192);
    Some(U256::try_from(root).expect("square root of a 320-bit value fits 160 bits"))
}

/// `floor(sqrt(price) * 2^96)` for a WAD price (token1 per token0): `isqrt(floor(price * 2^192 / 1e18))`.
pub fn to_sqrt_price_x96(price: u128) -> U256 {
    sqrt_price_x96_from_reserves(WAD, price).expect("WAD is not zero")
}

/// Token1 per token0 (WAD) at a square-root price: `floor(floor(s * s / 2^96) * 1e18 / 2^96)`. `None` if the price
/// does not fit a `u128` (above ~3.4e20 per unit, beyond any real pool).
pub fn from_sqrt_price_x96(sqrt_price_x96: U256) -> Option<u128> {
    let s = U512::from(sqrt_price_x96);
    // Dividing by 2^96 is a right shift; both floors match the two mul-divs of the reference maths.
    let price_x96 = (s * s) >> 96;
    let price = (price_x96 * U512::from(WAD)) >> 96;
    u128::try_from(price).ok()
}

/// Token1 per token0 (WAD) at `tick`, rounded down. Panics with `InvalidTick` outside the tick range; `None` if the
/// price does not fit a `u128` (ticks above about 472,000).
#[track_caller]
pub fn from_tick(tick: i32) -> Option<u128> {
    from_sqrt_price_x96(get_sqrt_ratio_at_tick(tick))
}

/// USDC per wNEAR from a token1-per-token0 price: unchanged when wNEAR is token0, else `floor(1e36 / p)` (0 stays 0).
pub fn wnear_price(token1_per_token0: u128, wnear_is_token0: bool) -> u128 {
    if wnear_is_token0 || token1_per_token0 == 0 {
        return token1_per_token0;
    }
    mul_div_down(WAD, WAD, token1_per_token0)
}

/// USDC per wNEAR at a square-root price, for either orientation: [`wnear_price`] of [`from_sqrt_price_x96`]. `None`
/// if the token1-per-token0 price does not fit a `u128`.
pub fn wnear_price_at_sqrt(sqrt_price_x96: U256, wnear_is_token0: bool) -> Option<u128> {
    from_sqrt_price_x96(sqrt_price_x96).map(|p| wnear_price(p, wnear_is_token0))
}

/// USDC per wNEAR at a (mean) tick, for either orientation: what lending reads from a pool's TWAP. With wNEAR as
/// token0 it rounds down by up to one tick; with wNEAR as token1 the inversion rounds it up by up to one tick, as in
/// the reference maths. Panics with `InvalidTick` outside the tick range.
#[track_caller]
pub fn wnear_price_at_tick(tick: i32, wnear_is_token0: bool) -> Option<u128> {
    wnear_price_at_sqrt(get_sqrt_ratio_at_tick(tick), wnear_is_token0)
}

/// Token1 per token0 for a USDC-per-wNEAR `price`, the inverse of [`wnear_price`] (used to seed or move a pool).
/// Panics with `DivisionByZero` for a zero price when wNEAR is token1.
#[track_caller]
pub fn pool_price(price: u128, wnear_is_token0: bool) -> u128 {
    if wnear_is_token0 {
        return price;
    }
    mul_div_down(WAD, WAD, price)
}

/// `floor(reserve1 * 1e18 / reserve0)`: the exact reserve ratio as a WAD price; `None` for an empty token0 side or a
/// price above `u128::MAX`.
pub fn price_from_reserves(reserve0: u128, reserve1: u128) -> Option<u128> {
    checked_mul_div(reserve1, WAD, reserve0, Rounding::Down)
}

/// Tick of a pool holding these reserves: the tick at its square-root price, clamped to the tick range. `None` for
/// an empty token0 side.
pub fn tick_from_reserves(reserve0: u128, reserve1: u128) -> Option<i32> {
    sqrt_price_x96_from_reserves(reserve0, reserve1).map(tick_at_sqrt_ratio_clamped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixed::Q96;
    use crate::tick::{MAX_TICK, MIN_TICK};

    #[test]
    fn one_price_is_q96() {
        assert_eq!(to_sqrt_price_x96(WAD), Q96);
        assert_eq!(from_sqrt_price_x96(Q96), Some(WAD));
    }

    #[test]
    fn seeding_at_3_70_reads_back_one_unit_low() {
        // Both conversions floor, so 3.70 comes back as 3.699999999999999999.
        let price = 3_700 * WAD / 1_000;
        assert_eq!(
            from_sqrt_price_x96(to_sqrt_price_x96(price)),
            Some(price - 1)
        );
        // The same pool seeded from reserves has the identical square-root price.
        assert_eq!(
            sqrt_price_x96_from_reserves(100_000 * WAD, 370_000 * WAD),
            Some(to_sqrt_price_x96(price))
        );
        assert_eq!(
            price_from_reserves(100_000 * WAD, 370_000 * WAD),
            Some(price)
        );
    }

    #[test]
    fn orientation() {
        assert_eq!(wnear_price(3_000 * WAD, true), 3_000 * WAD);
        assert_eq!(wnear_price(0, false), 0);
        let inverse = pool_price(3_000 * WAD, false);
        assert_eq!(inverse, 333_333_333_333_333);
        assert_eq!(wnear_price(inverse, false), 3_000_000_000_000_003_000_000);
    }

    #[test]
    fn twap_prices_of_the_demo_pools() {
        // With wNEAR-if-w as token0, a pool seeded at 3.70 reads 3.69963 from its TWAP, which is one
        // tick's worth below; with wNEAR as token1 the same pool reads 3.70000.
        let price = 3_700 * WAD / 1_000;
        let tick = tick_from_reserves(100_000 * WAD, 370_000 * WAD).unwrap();
        let down = wnear_price_at_tick(tick, true).unwrap();
        assert_eq!(down / 10u128.pow(13), 369_963);
        let flipped = tick_from_reserves(370_000 * WAD, 100_000 * WAD).unwrap();
        let up = wnear_price_at_tick(flipped, false).unwrap();
        assert_eq!(up / 10u128.pow(13), 370_000);
        assert!(down < price && up >= price);
        assert_eq!(
            wnear_price_at_sqrt(to_sqrt_price_x96(price), true),
            Some(price - 1)
        );
        assert_eq!(wnear_price_at_sqrt(U256::MAX, true), None);
    }

    #[test]
    #[should_panic(expected = "DivisionByZero")]
    fn zero_pool_price_with_wnear_as_token1_panics() {
        pool_price(0, false);
    }

    #[test]
    fn extremes() {
        assert_eq!(from_tick(0), Some(WAD));
        assert_eq!(from_tick(MAX_TICK), None);
        assert_eq!(from_tick(MIN_TICK), Some(0));
        assert_eq!(from_sqrt_price_x96(U256::MAX), None);
        assert_eq!(sqrt_price_x96_from_reserves(0, 5), None);
        assert_eq!(price_from_reserves(0, 5), None);
        assert_eq!(price_from_reserves(1, u128::MAX), None);
        assert_eq!(tick_from_reserves(1, u128::MAX), Some(MAX_TICK));
        assert_eq!(tick_from_reserves(u128::MAX, 1), Some(MIN_TICK));
        assert_eq!(tick_from_reserves(5, 0), Some(MIN_TICK));
        assert_eq!(tick_from_reserves(7, 7), Some(0));
    }
}
