//! Lending prices of a world pool and the outside reference factor.

use crate::fixed::{mul_div_u256, Rounding, Q96, U256};
use crate::tick::get_sqrt_ratio_at_tick;

/// USDC-if-w a full-range pool of `liquidity` holds at `tick`:
/// `floor(liquidity * get_sqrt_ratio_at_tick(tick) / 2^96)`, saturating at
/// `u128::MAX`. Read at the TWAP tick it is a depth that no swap inside the
/// block can move. Panics with `InvalidTick` outside the tick range.
#[track_caller]
pub fn depth_at_tick(liquidity: u128, tick: i32) -> u128 {
    let depth = mul_div_u256(
        U256::from(liquidity),
        get_sqrt_ratio_at_tick(tick),
        Q96,
        Rounding::Down,
    );
    if depth > U256::from(u128::MAX) {
        u128::MAX
    } else {
        depth.low_u128()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::WAD;

    #[test]
    fn depth_at_the_unit_price_is_the_liquidity() {
        assert_eq!(depth_at_tick(1_000 * WAD, 0), 1_000 * WAD);
        assert_eq!(depth_at_tick(0, 100), 0);
    }

    #[test]
    fn depth_grows_with_the_tick_and_saturates() {
        let l = 10_000 * WAD;
        assert!(depth_at_tick(l, 10) > depth_at_tick(l, 0));
        assert!(depth_at_tick(l, -10) < depth_at_tick(l, 0));
        assert_eq!(depth_at_tick(u128::MAX, crate::tick::MAX_TICK), u128::MAX);
    }
}
