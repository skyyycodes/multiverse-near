//! Worst-world health factor and liquidation sizing (lending amendments 8 and 9).
//!
//! Collateral is valued in every possible world and the loan is judged by the worst one: `HF = floor(C_min * LLTV /
//! debt)`. A liquidation repays `r` (at most half the debt) and takes the same fraction `f = min(1, target / C_min)`
//! of every collateral piece, where `target = floor(r * (1 + bonus))`. Cutting every piece by one fraction keeps the
//! worst world worst, so the slice is worth at least `target` in every world, minus rounding dust that the
//! `LiquidationTooSmall` allowance covers.

use crate::fixed::{checked_mul_div, mul_div_down, mul_div_u256, mul_div_up, Rounding, U256, WAD};

/// Most of the debt one liquidation may repay: 50%.
pub const CLOSE_FACTOR: u128 = WAD / 2;

/// Most one liquidation may repay: all of a small (`debt < small_loan`) or very unhealthy (`hf < full_hf`, when
/// `full_hf` is set) loan, else the close factor's half. `small_loan = 0` and `full_hf = 0` switch the full mode off.
pub fn liquidation_cap(debt: u128, hf: u128, full_hf: u128, small_loan: u128) -> u128 {
    if debt < small_loan || (full_hf != 0 && hf < full_hf) {
        debt
    } else {
        max_repay(debt)
    }
}

/// The smallest repayment whose target `floor(r * (1 + bonus))` reaches `c_min`, so it seizes every piece: `ceil(c_min
/// * 1e18 / (1e18 + bonus))`, at least 1. Panics with `MulDivOverflow` past `u128::MAX`.
#[track_caller]
pub fn full_seize_repay(c_min: u128, bonus: u128) -> u128 {
    let denominator = WAD
        .checked_add(bonus)
        .unwrap_or_else(|| panic!("MulDivOverflow"));
    mul_div_up(c_min, WAD, denominator).max(1)
}

/// How a write-off of `bad` splits: the insurance covers first, the lenders take the rest. Returns `(cover, loss)`.
pub fn write_off_split(bad: u128, insurance: u128) -> (u128, u128) {
    let cover = bad.min(insurance);
    (cover, bad - cover)
}

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

    const FULL_HF: u128 = 900_000_000_000_000_000;
    const SMALL: u128 = 200 * WAD;

    #[test]
    fn liquidation_cap_thresholds() {
        let debt = 1_000 * WAD;
        // HF exactly at the full-liquidation line is still partial; one unit below is full.
        assert_eq!(liquidation_cap(debt, FULL_HF, FULL_HF, SMALL), debt / 2);
        assert_eq!(liquidation_cap(debt, FULL_HF - 1, FULL_HF, SMALL), debt);
        // A debt exactly at the small-loan line is partial; one unit below is full.
        assert_eq!(liquidation_cap(SMALL, WAD - 1, FULL_HF, SMALL), SMALL / 2);
        assert_eq!(
            liquidation_cap(SMALL - 1, WAD - 1, FULL_HF, SMALL),
            SMALL - 1
        );
        // Both rules off: the v1 close factor whatever the HF.
        assert_eq!(liquidation_cap(debt, 0, 0, 0), debt / 2);
        assert_eq!(liquidation_cap(1, 0, 0, 0), 0);
        // A debt of one unit under the production rules can be repaid in full.
        assert_eq!(liquidation_cap(1, 0, FULL_HF, SMALL), 1);
    }

    #[test]
    fn full_seize_repay_is_the_smallest_repayment_that_seizes_everything() {
        for (c_min, bonus) in [
            (0, BONUS),
            (1, BONUS),
            (2, BONUS),
            (21, BONUS),
            (1_300 * WAD, BONUS),
            (8_000 * WAD, 80_000_000_000_000_000),
            (12_345_678_901_234_567_890, 60_000_000_000_000_000),
            (u128::MAX / 2, 10_000_000_000_000_000),
        ] {
            let r = full_seize_repay(c_min, bonus);
            assert!(r >= 1);
            assert!(liquidation_target(r, bonus) >= c_min, "{c_min} {bonus}");
            if r > 1 {
                assert!(liquidation_target(r - 1, bonus) < c_min, "{c_min} {bonus}");
            }
        }
        // Brute force on small numbers.
        for c_min in 0..300u128 {
            for bonus in [WAD / 100, WAD / 20, WAD * 8 / 100, WAD * 15 / 100] {
                let smallest = (1..)
                    .find(|r| liquidation_target(*r, bonus) >= c_min)
                    .unwrap();
                assert_eq!(full_seize_repay(c_min, bonus), smallest, "{c_min} {bonus}");
            }
        }
    }

    #[test]
    fn write_off_split_covers_with_insurance_first() {
        assert_eq!(write_off_split(400, 640), (400, 0));
        assert_eq!(write_off_split(400, 100), (100, 300));
        assert_eq!(write_off_split(0, 100), (0, 0));
        assert_eq!(write_off_split(7, 0), (0, 7));
        let (c, l) = write_off_split(u128::MAX, u128::MAX - 1);
        assert_eq!(c + l, u128::MAX);
    }

    #[test]
    fn carl_after_the_upgrade() {
        // Production's market 1 (legacy Normal, 0.75 / 0.05): debt 892.822257, C_min 1,133.134240.
        let debt = 892_822_257_272_781_333_774;
        let c_min = 1_133_134_240_133_792_851_806;
        let hf = health_factor(c_min, debt, LLTV).unwrap();
        assert_eq!(hf / 1_000_000_000_000, 951_869);
        let cap = liquidation_cap(debt, hf, FULL_HF, SMALL);
        assert_eq!(cap, 446_411_128_636_390_666_887);
        let fsr = full_seize_repay(c_min, BONUS);
        assert_eq!(fsr, 1_079_175_466_794_088_430_292);
        let r = cap.min(fsr);
        let target = liquidation_target(r, BONUS);
        assert_eq!(target, 468_731_685_068_210_200_231);
        assert!(target < c_min);
    }

    #[test]
    fn the_design_examples() {
        let normal = (700_000_000_000_000_000, 60_000_000_000_000_000);
        // Normal, debt 1,000 at HF 0.85: full mode, "max" repays the whole debt as a cut.
        let debt = 1_000 * WAD;
        let c_min = mul_div_down(850_000_000_000_000_000, debt, normal.0);
        let hf = health_factor(c_min, debt, normal.0).unwrap();
        let cap = liquidation_cap(debt, hf, FULL_HF, SMALL);
        let fsr = full_seize_repay(c_min, normal.1);
        assert_eq!(cap, debt);
        assert!(fsr > debt);
        let target = liquidation_target(cap.min(fsr), normal.1);
        assert_eq!(target, 1_060 * WAD);
        assert_eq!((c_min - target) / 10u128.pow(16), 15_428);
        // Small loan: 150 at HF 0.95 repays all 150.
        let debt = 150 * WAD;
        let c_min = mul_div_down(950_000_000_000_000_000, debt, normal.0);
        let hf = health_factor(c_min, debt, normal.0).unwrap();
        assert_eq!(liquidation_cap(debt, hf, FULL_HF, SMALL), debt);
        assert_eq!(liquidation_target(debt, normal.1), 159 * WAD);
        // Bold underwater: debt 10,000, C_min 8,000: "max" repays fsr and 2,592.59 is written off.
        let bold_bonus = 80_000_000_000_000_000;
        let (debt, c_min) = (10_000 * WAD, 8_000 * WAD);
        let hf = health_factor(c_min, debt, 800_000_000_000_000_000).unwrap();
        let cap = liquidation_cap(debt, hf, FULL_HF, SMALL);
        let fsr = full_seize_repay(c_min, bold_bonus);
        assert_eq!(cap, debt);
        assert_eq!(fsr / 10u128.pow(16), 740_740);
        let (cover, loss) = write_off_split(debt - fsr, 1_000 * WAD);
        assert_eq!(cover, 1_000 * WAD);
        assert_eq!(loss / 10u128.pow(16), 159_259);
    }

    /// The golden vectors the scripts' `lib/risk.ts` mirror is tested against, as JSON (decimal strings).
    fn risk_vectors_json() -> String {
        use serde_json::json;
        let s = |x: u128| x.to_string();
        let caps: Vec<_> = [
            (1_000 * WAD, FULL_HF, FULL_HF, SMALL),
            (1_000 * WAD, FULL_HF - 1, FULL_HF, SMALL),
            (SMALL, WAD - 1, FULL_HF, SMALL),
            (SMALL - 1, WAD - 1, FULL_HF, SMALL),
            (1, 0, FULL_HF, SMALL),
            (1_000 * WAD + 1, 0, 0, 0),
            (
                892_822_257_272_781_333_774,
                951_869_954_545_614_142,
                FULL_HF,
                SMALL,
            ),
        ]
        .into_iter()
        .map(|(debt, hf, full_hf, small)| {
            json!({"debt": s(debt), "hf": s(hf), "full_hf": s(full_hf), "small_loan": s(small),
                   "cap": s(liquidation_cap(debt, hf, full_hf, small))})
        })
        .collect();
        let fsr: Vec<_> = [
            (0, BONUS),
            (1, BONUS),
            (1_300 * WAD, BONUS),
            (1_133_134_240_133_792_851_806, BONUS),
            (8_000 * WAD, 80_000_000_000_000_000),
            (1_214_285_714_285_714_285_714, 60_000_000_000_000_000),
        ]
        .into_iter()
        .map(|(c_min, bonus)| json!({"c_min": s(c_min), "bonus": s(bonus), "repay": s(full_seize_repay(c_min, bonus))}))
        .collect();
        let splits: Vec<_> = [
            (400 * WAD, 640 * WAD),
            (400 * WAD, 100 * WAD),
            (2_592 * WAD, 1_000 * WAD),
            (5, 0),
        ]
        .into_iter()
        .map(|(bad, ins)| {
            let (cover, loss) = write_off_split(bad, ins);
            json!({"bad": s(bad), "insurance": s(ins), "cover": s(cover), "loss": s(loss)})
        })
        .collect();
        let targets: Vec<_> = [
            (500 * WAD, BONUS),
            (446_411_128_636_390_666_887, BONUS),
            (1_000 * WAD, 60_000_000_000_000_000),
            (7, 80_000_000_000_000_000),
        ]
        .into_iter()
        .map(|(r, bonus)| json!({"repaid": s(r), "bonus": s(bonus), "target": s(liquidation_target(r, bonus))}))
        .collect();
        let (debt, c_min) = (
            892_822_257_272_781_333_774u128,
            1_133_134_240_133_792_851_806u128,
        );
        let hf = health_factor(c_min, debt, LLTV).unwrap();
        let cap = liquidation_cap(debt, hf, FULL_HF, SMALL);
        let fsr_carl = full_seize_repay(c_min, BONUS);
        let doc = json!({
            "close_factor": s(CLOSE_FACTOR),
            "liquidation_cap": caps,
            "full_seize_repay": fsr,
            "write_off_split": splits,
            "liquidation_target": targets,
            "carl": {
                "lltv": s(LLTV), "bonus": s(BONUS), "debt": s(debt), "c_min": s(c_min), "health_factor": s(hf),
                "cap": s(cap), "full_seize_repay": s(fsr_carl), "repay": s(cap.min(fsr_carl)),
                "target": s(liquidation_target(cap.min(fsr_carl), BONUS)),
            },
        });
        serde_json::to_string_pretty(&doc).unwrap() + "\n"
    }

    #[test]
    fn risk_vectors_golden_file() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/risk-vectors.json");
        let expected = risk_vectors_json();
        if std::env::var_os("UPDATE_GOLDEN").is_some() || !std::path::Path::new(path).exists() {
            std::fs::create_dir_all(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data")).unwrap();
            std::fs::write(path, &expected).unwrap();
        }
        let stored = std::fs::read_to_string(path).unwrap();
        assert_eq!(stored, expected, "{path} differs from risk.rs");
        let parsed: serde_json::Value = serde_json::from_str(&stored).unwrap();
        assert_eq!(parsed["carl"]["cap"], "446411128636390666887");
        assert_eq!(parsed["carl"]["full_seize_repay"], "1079175466794088430292");
    }

    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig { cases: 1024, failure_persistence: None, ..ProptestConfig::default() })]

        /// L-13: `"max"` = min(cap, fsr) never repays more than the debt and never leaves a remainder below the
        /// minimum loan (a full seizure writes the rest off).
        #[test]
        fn max_never_leaves_dust(debt in 1u128..=10u128.pow(30), hf in 0u128..=2 * WAD, c_min in 0u128..=10u128.pow(31),
                                 min_loan in 0u128..=10_000 * WAD, bonus in WAD / 100..=WAD * 15 / 100, full in any::<bool>()) {
            let small = min_loan * 2;
            let full_hf = if full { FULL_HF } else { 0 };
            let cap = liquidation_cap(debt, hf, full_hf, small);
            let r = cap.min(full_seize_repay(c_min, bonus));
            prop_assert!(r <= debt);
            let seize_all = liquidation_target(r, bonus) >= c_min;
            let left = debt - r;
            if !seize_all && left > 0 {
                prop_assert!(left >= min_loan, "left {} < min {}", left, min_loan);
            }
        }

        #[test]
        fn write_off_split_sums_to_bad(bad in any::<u128>(), insurance in any::<u128>()) {
            let (cover, loss) = write_off_split(bad, insurance);
            prop_assert_eq!(cover + loss, bad);
            prop_assert!(cover <= insurance);
        }
    }
}
