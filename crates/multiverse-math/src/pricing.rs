//! Lending prices of a world pool and the outside reference factor.
//!
//! A world pool prices the borrow side at `min(spot, TWAP)` and the
//! liquidation side at its TWAP. When a market checks the outside NEAR/USD
//! reference `R` against the TWAP-implied spot `I`, the ratio `rho = R / I`
//! scales both: the borrow side by `f_b = min(1, rho)`, the liquidation side
//! by `f_l = rho >= 1 ? 1 : max(rho, 1 - max_haircut)`. Every function here
//! is pure integer maths in WAD; results round down (in the protocol's
//! favour: collateral is never valued higher than the inputs say).
//!
//! Dominance, which lending relies on: for every input, the borrow price of a
//! world is at most its liquidation price whenever the borrow factor is at
//! most the liquidation factor, which `borrow_factor` and
//! `liquidation_factor` guarantee for the same ratio.

use crate::fixed::{checked_mul_div, mul_div_down, mul_div_u256, Rounding, Q96, U256, WAD};
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

/// `rho = floor(reference * 1e18 / implied)`: how the outside price compares
/// with the TWAP-implied spot. `None` when `implied` is 0; saturates at
/// `u128::MAX` (a reference that far above the pools trips every check).
pub fn ratio(reference: u128, implied: u128) -> Option<u128> {
    if implied == 0 {
        return None;
    }
    Some(checked_mul_div(reference, WAD, implied, Rounding::Down).unwrap_or(u128::MAX))
}

/// The borrow-side factor `min(1e18, rho)`: the reference only ever lowers
/// what collateral counts for when borrowing.
pub fn borrow_factor(ratio: u128) -> u128 {
    ratio.min(WAD)
}

/// The liquidation-side factor: `1e18` when `rho >= 1e18`, else
/// `max(rho, 1e18 - max_haircut)`. Never below `1e18 - max_haircut` (0 when
/// the haircut is 100% or more), never above `1e18`.
pub fn liquidation_factor(ratio: u128, max_haircut: u128) -> u128 {
    if ratio >= WAD {
        return WAD;
    }
    ratio.max(WAD.saturating_sub(max_haircut))
}

/// `|rho - 1e18| > max_deviation`: the reference and the pools disagree by
/// more than borrowing allows.
pub fn deviates(ratio: u128, max_deviation: u128) -> bool {
    ratio.abs_diff(WAD) > max_deviation
}

/// `rho > 1e18 + max_deviation`: the pools sit more than `max_deviation`
/// below the outside price, so liquidation waits (the guard).
pub fn guard(ratio: u128, max_deviation: u128) -> bool {
    ratio > WAD.saturating_add(max_deviation)
}

/// `floor(price * factor / 1e18)`.
pub fn scale(price: u128, factor: u128) -> u128 {
    mul_div_down(price, factor, WAD)
}

/// A trusted world's borrow price: `floor(min(spot, twap) * factor / 1e18)`.
pub fn borrow_price(spot: u128, twap: u128, factor: u128) -> u128 {
    scale(spot.min(twap), factor)
}

/// A liquidation-priced world's price: `floor(twap * factor / 1e18)`.
pub fn liquidation_price(twap: u128, factor: u128) -> u128 {
    scale(twap, factor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cpmm;
    use crate::tick::{MAX_TICK, MIN_TICK};
    use proptest::prelude::*;

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
        assert_eq!(depth_at_tick(u128::MAX, MAX_TICK), u128::MAX);
    }

    /// At the pool's own tick the depth is its USDC reserve, to within the
    /// tick's rounding: a demo pool of 100,000 wNEAR at 3.40.
    #[test]
    fn depth_is_reserve1_when_spot_is_the_twap() {
        let mut pool = cpmm::Pool::new();
        let mut position = cpmm::Position::new();
        pool.mint_initial(&mut position, 100_000 * WAD, 340_000 * WAD)
            .unwrap();
        let tick = pool.tick().unwrap();
        let depth = depth_at_tick(pool.liquidity(), tick);
        let reserve1 = pool.reserve1();
        assert!(depth <= reserve1, "{depth} > {reserve1}");
        // One tick is 1 bp of price, half a bp of sqrt price.
        assert!(
            reserve1 - depth <= reserve1 / 20_000,
            "{depth} vs {reserve1}"
        );
        // The next tick up is above the reserve.
        assert!(depth_at_tick(pool.liquidity(), tick + 1) > reserve1);
    }

    #[test]
    fn ratio_floors_and_needs_an_implied_spot() {
        assert_eq!(ratio(WAD, 0), None);
        assert_eq!(ratio(0, WAD), Some(0));
        assert_eq!(ratio(3 * WAD, 2 * WAD), Some(1_500_000_000_000_000_000));
        // 1 / 3 rounds down.
        assert_eq!(ratio(WAD, 3 * WAD), Some(333_333_333_333_333_333));
        assert_eq!(ratio(u128::MAX, 1), Some(u128::MAX));
    }

    #[test]
    fn factors_follow_the_ratio_within_their_bounds() {
        let h = WAD / 5;
        // R = 0.5 I: the haircut is capped at 20%, borrowing takes all of it.
        assert_eq!(liquidation_factor(WAD / 2, h), 800_000_000_000_000_000);
        assert_eq!(borrow_factor(WAD / 2), WAD / 2);
        // R = 0.95 I: 5% on both sides.
        let r = 950_000_000_000_000_000;
        assert_eq!(liquidation_factor(r, h), r);
        assert_eq!(borrow_factor(r), r);
        // R above I never raises a price.
        assert_eq!(liquidation_factor(2 * WAD, h), WAD);
        assert_eq!(borrow_factor(2 * WAD), WAD);
        assert_eq!(liquidation_factor(WAD, h), WAD);
        // No haircut allowed: the liquidation side ignores the reference.
        assert_eq!(liquidation_factor(WAD / 2, 0), WAD);
        // A haircut of 100% or more floors at the ratio itself.
        assert_eq!(liquidation_factor(WAD / 2, 2 * WAD), WAD / 2);
        assert_eq!(liquidation_factor(0, 2 * WAD), 0);
    }

    #[test]
    fn deviation_and_guard_are_strict() {
        let d = WAD / 10;
        assert!(!deviates(WAD + d, d));
        assert!(deviates(WAD + d + 1, d));
        assert!(!deviates(WAD - d, d));
        assert!(deviates(WAD - d - 1, d));
        assert!(!guard(WAD + d, d));
        assert!(guard(WAD + d + 1, d));
        // Pools above the reference never guard.
        assert!(!guard(WAD - d - 1, d));
        assert!(!guard(u128::MAX - 1, u128::MAX));
    }

    #[test]
    fn prices_scale_down() {
        assert_eq!(scale(3 * WAD, WAD), 3 * WAD);
        assert_eq!(scale(3, WAD / 2), 1);
        assert_eq!(borrow_price(2 * WAD, 3 * WAD, WAD), 2 * WAD);
        assert_eq!(borrow_price(4 * WAD, 3 * WAD, WAD), 3 * WAD);
        assert_eq!(liquidation_price(3 * WAD, WAD / 2), 3 * WAD / 2);
        assert_eq!(scale(u128::MAX, WAD), u128::MAX);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1_024))]

        /// P-2 and P-5: for any spot, TWAP, ratio and haircut, the borrow
        /// price is at most the liquidation price, `1 - h <= f_l <= 1` and
        /// `f_b <= f_l`; a reference too old for liquidation but fresh enough
        /// for borrowing (factor 1 on the liquidation side) keeps it.
        #[test]
        fn dominance(
            spot in 0u128..=1_000_000 * WAD,
            twap in 0u128..=1_000_000 * WAD,
            rho in 0u128..=4 * WAD,
            haircut in 0u128..=WAD / 2,
            liquidation_fresh in any::<bool>(),
        ) {
            let f_b = borrow_factor(rho);
            let f_l = if liquidation_fresh { liquidation_factor(rho, haircut) } else { WAD };
            prop_assert!(f_b <= WAD);
            prop_assert!(f_l <= WAD);
            prop_assert!(f_b <= f_l);
            if liquidation_fresh {
                prop_assert!(f_l >= WAD - haircut);
            }
            prop_assert!(borrow_price(spot, twap, f_b) <= liquidation_price(twap, f_l));
        }

        /// The depth at a tick is monotone in both the liquidity and the tick.
        #[test]
        fn depth_is_monotone(
            liquidity in 0u128..=u128::MAX / 2,
            tick in (MIN_TICK + 1)..MAX_TICK,
        ) {
            prop_assert!(depth_at_tick(liquidity, tick) <= depth_at_tick(liquidity, tick + 1));
            prop_assert!(depth_at_tick(liquidity, tick) <= depth_at_tick(liquidity + 1, tick));
        }
    }
}
