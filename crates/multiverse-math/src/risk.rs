//! Worst-world health factor and liquidation sizing (lending amendments 8 and 9).
//!
//! Collateral is valued in every possible world and the loan is judged by the worst one: `HF = floor(C_min * LLTV /
//! debt)`. A liquidation repays `r` (at most half the debt) and takes the same fraction `f = min(1, target / C_min)`
//! of every collateral piece, where `target = floor(r * (1 + bonus))`. Cutting every piece by one fraction keeps the
//! worst world worst, so the slice is worth at least `target` in every world, minus rounding dust that the
//! `LiquidationTooSmall` allowance covers.

use crate::fixed::{checked_mul_div, mul_div_down, mul_div_u256, Rounding, U256, WAD};

/// Most of the debt one liquidation may repay: 50%.
pub const CLOSE_FACTOR: u128 = WAD / 2;

/// `floor(lowest * lltv / debt)` (WAD); `None` (infinitely healthy) without debt. Saturates at `u128::MAX` rather
/// than overflow (1 unit of debt against real collateral).
pub fn health_factor(lowest: u128, debt: u128, lltv: u128) -> Option<u128> {
    if debt == 0 {
        return None;
    }
    Some(checked_mul_div(lowest, lltv, debt, Rounding::Down).unwrap_or(u128::MAX))
}

/// Most debt the worst world's collateral carries at HF 1: `floor(lowest * lltv / 1e18)`.
pub fn borrow_capacity(lowest: u128, lltv: u128) -> u128 {
    // lltv is at most 1e18 in practice; a larger one could only overflow past u128::MAX, so saturate.
    checked_mul_div(lowest, lltv, WAD, Rounding::Down).unwrap_or(u128::MAX)
}

/// Healthy means `HF >= 1e18`; no debt is healthy.
pub fn is_healthy(health_factor: Option<u128>) -> bool {
    health_factor.is_none_or(|hf| hf >= WAD)
}

/// The possible world with the lowest collateral value, as `(world, value)`; ties go to the lowest index. `None`
/// when no world in `values` is possible.
pub fn worst_world(values: &[u128], possible: u8) -> Option<(u8, u128)> {
    let mut worst: Option<(u8, u128)> = None;
    for (w, &value) in values.iter().enumerate() {
        let world = u8::try_from(w).expect("at most 8 worlds");
        if possible & (1 << world) == 0 {
            continue;
        }
        if worst.is_none_or(|(_, lowest)| value < lowest) {
            worst = Some((world, value));
        }
    }
    worst
}

/// Value of a wNEAR-denominated piece in a world: `floor(amount * price / 1e18)`. Panics with `MulDivOverflow` past
/// `u128::MAX`.
#[track_caller]
pub fn wnear_value(amount: u128, price: u128) -> u128 {
    mul_div_down(amount, price, WAD)
}

/// Largest repayment one liquidation accepts: `floor(debt * 0.5e18 / 1e18)`.
pub fn max_repay(debt: u128) -> u128 {
    mul_div_down(debt, CLOSE_FACTOR, WAD)
}

/// What the liquidator's slice must be worth in the worst world: `floor(repaid * (1e18 + bonus) / 1e18)`. Panics
/// with `MulDivOverflow` past `u128::MAX`.
#[track_caller]
pub fn liquidation_target(repaid: u128, bonus: u128) -> u128 {
    let factor = U256::from(WAD) + U256::from(bonus);
    let target = mul_div_u256(U256::from(repaid), factor, U256::from(WAD), Rounding::Down);
    u128::try_from(target).unwrap_or_else(|_| panic!("MulDivOverflow"))
}

/// Amount of a piece holding `held` that the liquidator takes: everything once `target >= lowest` (the slice is the
/// whole account), otherwise `floor(held * target / lowest)`.
#[track_caller]
pub fn seize_amount(held: u128, target: u128, lowest: u128) -> u128 {
    if target >= lowest {
        held
    } else {
        // target < lowest, so lowest > 0.
        mul_div_down(held, target, lowest)
    }
}

/// Rounding allowance of a cut: `pieces * (floor(max_price / 1e18) + 2)`. Flooring one piece loses less than one
/// unit of it, worth at most `floor(max_price / 1e18) + 1` once valued, plus 1 for flooring that value. Panics with
/// `Overflow` past `u128::MAX`.
#[track_caller]
pub fn dust_allowance(pieces: u32, max_price: u128) -> u128 {
    (max_price / WAD)
        .checked_add(2)
        .and_then(|per_piece| per_piece.checked_mul(u128::from(pieces)))
        .unwrap_or_else(|| panic!("Overflow"))
}

/// True when a liquidation must fail `LiquidationTooSmall(repaid)`: it is a cut (`target < lowest`) and the bonus
/// margin `target - repaid` is below the rounding allowance. Equality passes. A full seizure is never too small.
#[track_caller]
pub fn is_too_small(
    repaid: u128,
    target: u128,
    lowest: u128,
    pieces: u32,
    max_price: u128,
) -> bool {
    target < lowest && target.saturating_sub(repaid) < dust_allowance(pieces, max_price)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LLTV: u128 = 750_000_000_000_000_000;
    const BONUS: u128 = 50_000_000_000_000_000;

    #[test]
    fn health_factor_edges() {
        assert_eq!(health_factor(5 * WAD, 0, LLTV), None);
        assert_eq!(health_factor(0, 1, LLTV), Some(0));
        // 1e30 of collateral against 1 unit of debt is 7.5e47, far above u128: saturate.
        assert_eq!(health_factor(10u128.pow(30), 1, LLTV), Some(u128::MAX));
        assert!(is_healthy(None));
        assert!(is_healthy(Some(WAD)));
        assert!(!is_healthy(Some(WAD - 1)));
        assert!(is_healthy(Some(u128::MAX)));
    }

    #[test]
    fn worst_world_ties_go_to_the_lowest_index() {
        assert_eq!(worst_world(&[5, 3, 3, 9], 0b1111), Some((1, 3)));
        assert_eq!(worst_world(&[5, 3, 3, 9], 0b1101), Some((2, 3)));
        assert_eq!(worst_world(&[0, 0], 0b11), Some((0, 0)));
        assert_eq!(worst_world(&[1, 2], 0), None);
    }

    #[test]
    fn amendment_8_example() {
        // C = 1,700 / 1,500 / 1,600 / 1,300, D = 1,000: MAX repays 500, target 525, and the account
        // ends at HF 775 * 0.75 / 500 = 1.1625.
        let debt = 1_000 * WAD;
        let repaid = max_repay(debt);
        assert_eq!(repaid, 500 * WAD);
        let target = liquidation_target(repaid, BONUS);
        assert_eq!(target, 525 * WAD);
        let values = [1_700 * WAD, 1_500 * WAD, 1_600 * WAD, 1_300 * WAD];
        let (worst, lowest) = worst_world(&values, 0b1111).unwrap();
        assert_eq!((worst, lowest), (3, 1_300 * WAD));
        assert_eq!(
            health_factor(lowest, debt, LLTV),
            Some(975_000_000_000_000_000)
        );
        assert!(!is_too_small(repaid, target, lowest, 4, 0));
        // Collateral held as USDC exactly worth c[w]: one real USDC piece of 1,300 plus USDC-if-w top-ups.
        let pieces = [1_300 * WAD, 400 * WAD, 200 * WAD, 300 * WAD];
        let left_in_world = |w: usize| -> u128 {
            let held = [
                pieces[0],
                if w == 0 { pieces[1] } else { 0 },
                if w == 1 { pieces[2] } else { 0 },
                if w == 2 { pieces[3] } else { 0 },
            ];
            held.iter()
                .map(|&h| h - seize_amount(h, target, lowest))
                .sum()
        };
        let after: Vec<u128> = (0..4).map(left_in_world).collect();
        let (_, lowest_after) = worst_world(&after, 0b1111).unwrap();
        assert_eq!(lowest_after, 775 * WAD);
        assert_eq!(
            health_factor(lowest_after, debt - repaid, LLTV),
            Some(1_162_500_000_000_000_000)
        );
    }

    #[test]
    fn dust_threshold_matches_the_spec() {
        // 7 pieces at a max price of 3.70 (3 whole USDC per unit, plus 2) need a repayment of at least
        // 20 * 7 * 5 = 700 units.
        let max_price = 3_700 * WAD / 1_000;
        assert_eq!(dust_allowance(7, max_price), 7 * 5);
        let lowest = 10_000 * WAD;
        let check = |repaid: u128| {
            is_too_small(
                repaid,
                liquidation_target(repaid, BONUS),
                lowest,
                7,
                max_price,
            )
        };
        assert!(check(1));
        assert!(check(680));
        assert!(check(699));
        assert!(!check(700));
        // 16 pieces at $4.00: allowance 96 units, smallest cut 1,920 units.
        assert_eq!(dust_allowance(16, 4 * WAD), 96);
        let check16 = |repaid: u128| {
            is_too_small(
                repaid,
                liquidation_target(repaid, BONUS),
                lowest,
                16,
                4 * WAD,
            )
        };
        assert!(check16(1_919));
        assert!(!check16(1_920));
        // A full seizure is never too small.
        assert!(!is_too_small(1, 2, 2, 16, 4 * WAD));
    }

    #[test]
    fn seizure() {
        assert_eq!(seize_amount(2 * WAD, 525, 1_300), 2 * WAD * 525 / 1_300);
        assert_eq!(seize_amount(7, 1_300, 1_300), 7);
        assert_eq!(seize_amount(7, 0, 0), 7);
        assert_eq!(seize_amount(0, 5, 10), 0);
        // One unit of debt cannot be liquidated: the close factor rounds the repayment to zero.
        assert_eq!(max_repay(1), 0);
        assert_eq!(max_repay(u128::MAX), u128::MAX / 2);
    }

    #[test]
    fn golden_health_factors() {
        // The demo sale: Alice's worst world holds 4,881.88 USDC after a 3,000 borrow (HF 1.22); binary 5,474.04
        // (HF 1.36). Max borrow at HF 1: 3,661.41 and 4,105.53.
        assert_eq!(
            health_factor(4_881_885_259_897_065_638_949, 3_000 * WAD, LLTV),
            Some(1_220_471_314_974_266_409)
        );
        assert_eq!(
            health_factor(5_474_047_492_989_783_712_767, 3_000 * WAD, LLTV),
            Some(1_368_511_873_247_445_928)
        );
        assert_eq!(
            borrow_capacity(4_881_885_259_897_065_638_949, LLTV) / 10u128.pow(16),
            366_141
        );
        assert_eq!(
            borrow_capacity(5_474_047_492_989_783_712_767, LLTV) / 10u128.pow(16),
            410_553
        );
        assert_eq!(borrow_capacity(u128::MAX, 2 * WAD), u128::MAX);
    }
}
