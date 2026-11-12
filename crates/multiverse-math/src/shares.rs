//! Share/asset conversions with virtual offsets (`SharesMath`), used by the money markets for supply and debt.
//!
//! One million virtual shares and one virtual asset stop a first depositor from inflating the share price. Callers
//! pick the direction that favours the protocol: lenders get shares rounded down and burn them rounded up, borrowers
//! owe debt rounded up. From an empty market the round trip is exact: `a` assets mint `a * 1e6` shares, worth `a`.
//!
//! All four panic with `MulDivOverflow` if the result does not fit a `u128` (the 256-bit intermediate only
//! overflows past 2^256, but no amount the contract stores can exceed `u128`).

use crate::fixed::{mul_div_u256, Rounding, U256};

/// Virtual shares added to the share supply.
pub const VIRTUAL_SHARES: u128 = 1_000_000;
/// Virtual assets added to the asset total.
pub const VIRTUAL_ASSETS: u128 = 1;

/// Shares for `assets`, rounded down.
#[track_caller]
pub fn to_shares_down(assets: u128, total_assets: u128, total_shares: u128) -> u128 {
    to_shares(assets, total_assets, total_shares, Rounding::Down)
}

/// Shares for `assets`, rounded up.
#[track_caller]
pub fn to_shares_up(assets: u128, total_assets: u128, total_shares: u128) -> u128 {
    to_shares(assets, total_assets, total_shares, Rounding::Up)
}

/// Assets for `shares`, rounded down.
#[track_caller]
pub fn to_assets_down(shares: u128, total_assets: u128, total_shares: u128) -> u128 {
    to_assets(shares, total_assets, total_shares, Rounding::Down)
}

/// Assets for `shares`, rounded up.
#[track_caller]
pub fn to_assets_up(shares: u128, total_assets: u128, total_shares: u128) -> u128 {
    to_assets(shares, total_assets, total_shares, Rounding::Up)
}

#[track_caller]
fn to_shares(assets: u128, total_assets: u128, total_shares: u128, rounding: Rounding) -> u128 {
    // The offsets can push a total past u128::MAX, so the sums are formed in 256 bits.
    let shares = U256::from(total_shares) + U256::from(VIRTUAL_SHARES);
    let assets_total = U256::from(total_assets) + U256::from(VIRTUAL_ASSETS);
    narrow(mul_div_u256(
        U256::from(assets),
        shares,
        assets_total,
        rounding,
    ))
}

#[track_caller]
fn to_assets(shares: u128, total_assets: u128, total_shares: u128, rounding: Rounding) -> u128 {
    let assets_total = U256::from(total_assets) + U256::from(VIRTUAL_ASSETS);
    let shares_total = U256::from(total_shares) + U256::from(VIRTUAL_SHARES);
    narrow(mul_div_u256(
        U256::from(shares),
        assets_total,
        shares_total,
        rounding,
    ))
}

#[track_caller]
fn narrow(value: U256) -> u128 {
    u128::try_from(value).unwrap_or_else(|_| panic!("MulDivOverflow"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixed::WAD;

    #[test]
    fn empty_market_round_trip_is_exact() {
        // 50,000e18 supplied mints 5e28 shares worth exactly 50,000e18.
        let supplied = 50_000 * WAD;
        let shares = to_shares_down(supplied, 0, 0);
        assert_eq!(shares, supplied * VIRTUAL_SHARES);
        assert_eq!(to_assets_down(shares, supplied, shares), supplied);
        // A first borrow of 3,000e18 owes exactly 3,000e18.
        let borrowed = 3_000 * WAD;
        let debt_shares = to_shares_up(borrowed, 0, 0);
        assert_eq!(to_assets_up(debt_shares, borrowed, debt_shares), borrowed);
    }

    #[test]
    fn debt_after_a_year_at_the_deployed_rate() {
        // 3,000e18 untouched for 365 days at 1,585,489,599 per second (5% APR, floored) owes
        // 3,149.999999982e18. Interest is floor(B * rate * dt / 1e18); the debt reads back rounded up.
        let borrowed = 3_000 * WAD;
        let debt_shares = to_shares_up(borrowed, 0, 0);
        let interest = crate::fixed::mul_div_down(borrowed, 1_585_489_599 * 31_536_000, WAD);
        assert_eq!(interest, 149_999_999_982_192_000_000);
        let debt = to_assets_up(debt_shares, borrowed + interest, debt_shares);
        assert_eq!(debt / 1_000_000, 3_149_999_999_982_192);
        // The lender's 50,000 supplied beside it earns that same interest, rounded down.
        let supplied = 50_000 * WAD;
        let supply_shares = to_shares_down(supplied, 0, 0);
        let balance = to_assets_down(supply_shares, supplied + interest, supply_shares);
        assert!(balance <= supplied + interest && supplied + interest - balance <= 1);
    }

    #[test]
    fn rounding_directions() {
        // 10 assets into a market of 3 assets and 2e6 shares: 10 * (2e6 + 1e6) / 4 = 7.5e6 exactly.
        assert_eq!(to_shares_down(10, 3, 2_000_000), 7_500_000);
        assert_eq!(to_shares_up(10, 3, 2_000_000), 7_500_000);
        assert_eq!(to_shares_down(1, 2, 0), 333_333);
        assert_eq!(to_shares_up(1, 2, 0), 333_334);
        assert_eq!(to_assets_down(1, 2, 0), 0);
        assert_eq!(to_assets_up(1, 2, 0), 1);
    }

    #[test]
    fn totals_near_u128_max_do_not_wrap() {
        assert_eq!(to_assets_down(0, u128::MAX, u128::MAX), 0);
        assert_eq!(to_shares_down(1, u128::MAX, u128::MAX), 1);
    }

    #[test]
    #[should_panic(expected = "MulDivOverflow")]
    fn oversized_result_panics() {
        to_shares_up(u128::MAX, 0, 0);
    }
}
