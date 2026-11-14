//! The interest rate model of the lending tiers: utilization, a kinked borrow
//! rate per second and the supply rate after the reserve factor.
//!
//! Rates are WAD per second. Below the kink the borrow rate climbs from `base` by `slope1` over `[0, kink]`; above
//! it, `slope2` more over `[kink, 1]`. Every division rounds down, so a borrower is never charged a rate the curve does
//! not reach and a lender is never promised more than borrowers pay.

use crate::fixed::{mul_div_down, WAD};

/// 365 days.
pub const SECONDS_PER_YEAR: u128 = 31_536_000;

/// The highest borrow rate a config may reach: 1,000% APR, `floor(10e18 / SECONDS_PER_YEAR)`.
pub const MAX_RATE_PER_SEC: u128 = 317_097_919_837;

/// Borrowed over supplied (WAD), capped at 1: `0` without borrows, `1e18` once borrows reach the supply.
pub fn utilization(tba: u128, tsa: u128) -> u128 {
    if tba == 0 {
        0
    } else if tba >= tsa {
        WAD
    } else {
        mul_div_down(tba, WAD, tsa)
    }
}

/// The kinked borrow rate per second at utilization `u` (capped at 1).
///
/// `kink` must be in `(0, 1e18)`; the tier validation keeps it in `[0.50e18, 0.95e18]`. The sum
/// `base + slope1 + slope2` is the rate at full utilization and must not overflow.
pub fn borrow_rate(u: u128, base: u128, slope1: u128, slope2: u128, kink: u128) -> u128 {
    let u = u.min(WAD);
    if u <= kink {
        base + mul_div_down(slope1, u, kink)
    } else {
        base + slope1 + mul_div_down(slope2, u - kink, WAD - kink)
    }
}

/// What a supplied unit earns per second: the borrow rate on the borrowed part, less the reserve factor,
/// `floor(floor(rate * (1 - rf)) * tba / tsa)`.
pub fn supply_rate(rate: u128, tsa: u128, tba: u128, rf: u128) -> u128 {
    if tsa == 0 {
        0
    } else {
        mul_div_down(mul_div_down(rate, WAD - rf, WAD), tba, tsa)
    }
}

/// A per-second rate from an APR in hundredths of a percent, rounded down: `floor(bps * 1e14 / SECONDS_PER_YEAR)`.
pub const fn rate_per_sec(apr_bps: u128) -> u128 {
    apr_bps * (WAD / 10_000) / SECONDS_PER_YEAR
}

/// Interest on `borrowed` over `elapsed` seconds at `rate`, simple within the interval: `floor(B * rate * dt / 1e18)`
/// (the v1 formula). Panics with `MulDivOverflow` past `u128::MAX`.
#[track_caller]
pub fn interest(borrowed: u128, rate: u128, elapsed: u64) -> u128 {
    let factor = rate
        .checked_mul(u128::from(elapsed))
        .unwrap_or_else(|| panic!("MulDivOverflow"));
    mul_div_down(borrowed, factor, WAD)
}

/// A kinked rate curve, per second (WAD); `kink` is a utilization (WAD).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Curve {
    pub base: u128,
    pub slope1: u128,
    pub slope2: u128,
    pub kink: u128,
}

impl Curve {
    /// The borrow rate at utilization `u`.
    pub fn rate(&self, u: u128) -> u128 {
        borrow_rate(u, self.base, self.slope1, self.slope2, self.kink)
    }
}

/// One accrual of a market: the rate it ran at, the interest borrowers owe and the insurance's cut of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Accrual {
    pub rate: u128,
    pub interest: u128,
    pub cut: u128,
}

/// What `elapsed` seconds add to a market holding `tsa` supplied and `tba` borrowed: the rate is read at the
/// utilization of the market as it stood (the start of the interval), interest is the v1 formula and the cut is
/// `floor(interest * reserve_factor)`. Lenders get `interest - cut`. No interest without borrows or time.
#[track_caller]
pub fn accrue(tsa: u128, tba: u128, curve: &Curve, reserve_factor: u128, elapsed: u64) -> Accrual {
    let rate = curve.rate(utilization(tba, tsa));
    let interest = if elapsed == 0 || tba == 0 {
        0
    } else {
        interest(tba, rate, elapsed)
    };
    Accrual {
        rate,
        interest,
        cut: mul_div_down(interest, reserve_factor, WAD),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KINK: u128 = 800_000_000_000_000_000;

    /// (base, slope1, slope2) APRs in bps per tier: Safe 1/4/45, Normal 2/6/52, Bold 3/9/63.
    const CURVES: [(u128, u128, u128); 3] =
        [(100, 400, 4_500), (200, 600, 5_200), (300, 900, 6_300)];

    fn pct(p: u128) -> u128 {
        p * WAD / 100
    }

    #[test]
    fn per_second_rates_of_the_tiers() {
        let per_sec: Vec<(u128, u128, u128)> = CURVES
            .iter()
            .map(|&(b, s1, s2)| (rate_per_sec(b), rate_per_sec(s1), rate_per_sec(s2)))
            .collect();
        assert_eq!(
            per_sec,
            vec![
                (317_097_919, 1_268_391_679, 14_269_406_392),
                (634_195_839, 1_902_587_519, 16_489_091_831),
                (951_293_759, 2_853_881_278, 19_977_168_949),
            ]
        );
        assert_eq!(rate_per_sec(100_000), MAX_RATE_PER_SEC);
    }

    #[test]
    fn the_fifteen_golden_borrow_rates() {
        // Per tier at 0 / 50 / 80 / 90 / 100% utilization (spec 4.4).
        let golden: [[u128; 5]; 3] = [
            [
                317_097_919,
                1_109_842_718,
                1_585_489_598,
                8_720_192_794,
                15_854_895_990,
            ],
            [
                634_195_839,
                1_823_313_038,
                2_536_783_358,
                10_781_329_273,
                19_025_875_189,
            ],
            [
                951_293_759,
                2_734_969_557,
                3_805_175_037,
                13_793_759_511,
                23_782_343_986,
            ],
        ];
        for (curve, rates) in CURVES.iter().zip(golden) {
            let (b, s1, s2) = (
                rate_per_sec(curve.0),
                rate_per_sec(curve.1),
                rate_per_sec(curve.2),
            );
            for (u, rate) in [0, 50, 80, 90, 100].into_iter().zip(rates) {
                assert_eq!(
                    borrow_rate(pct(u), b, s1, s2, KINK),
                    rate,
                    "{curve:?} at {u}%"
                );
            }
        }
    }

    #[test]
    fn v1_flat_rate_is_a_curve_without_slopes() {
        let v1 = 1_585_489_599;
        for u in [0, 1, KINK, KINK + 1, WAD, 2 * WAD] {
            assert_eq!(borrow_rate(u, v1, 0, 0, KINK), v1);
        }
    }

    #[test]
    fn utilization_edges_and_the_cap() {
        assert_eq!(utilization(0, 0), 0);
        assert_eq!(utilization(0, 100), 0);
        assert_eq!(utilization(80, 100), pct(80));
        assert_eq!(utilization(100, 100), WAD);
        // Borrows above the supply (a reserve cut at full use) read as 100%.
        assert_eq!(utilization(101, 100), WAD);
        assert_eq!(utilization(1, 0), WAD);
        // The rate never reads past 100%.
        let (b, s1, s2) = (1, 2, 3);
        assert_eq!(borrow_rate(2 * WAD, b, s1, s2, KINK), b + s1 + s2);
        assert_eq!(borrow_rate(u128::MAX, b, s1, s2, KINK), b + s1 + s2);
    }

    #[test]
    fn kink_edges() {
        let (b, s1, s2) = (rate_per_sec(200), rate_per_sec(600), rate_per_sec(5_200));
        assert_eq!(borrow_rate(KINK, b, s1, s2, KINK), b + s1);
        assert_eq!(borrow_rate(KINK - 1, b, s1, s2, KINK), b + s1 - 1);
        assert!(borrow_rate(KINK + 1, b, s1, s2, KINK) >= b + s1);
        assert_eq!(borrow_rate(WAD, b, s1, s2, KINK), b + s1 + s2);
    }

    #[test]
    fn supply_rate_is_what_borrowers_pay_less_the_reserve() {
        // Normal at 80%: 8.00% borrow APR, 5.76% supply APR.
        let rate = borrow_rate(
            pct(80),
            rate_per_sec(200),
            rate_per_sec(600),
            rate_per_sec(5_200),
            KINK,
        );
        let tsa = 100_000 * WAD;
        let tba = 80_000 * WAD;
        let s = supply_rate(rate, tsa, tba, pct(10));
        assert_eq!(s, mul_div_down(mul_div_down(rate, pct(90), WAD), tba, tsa));
        assert_eq!(s * SECONDS_PER_YEAR / 10u128.pow(14), 575);
        assert_eq!(supply_rate(rate, 0, 0, 0), 0);
        // What one second of accrual pays the lenders, per supplied unit, is the supply rate within rounding.
        let i = interest(tba, rate, 1);
        let cut = mul_div_down(i, pct(10), WAD);
        let paid = mul_div_down(i - cut, WAD, tsa);
        assert!(paid.abs_diff(s) <= 1, "{paid} vs {s}");
    }

    #[test]
    fn one_year_of_normal_at_eighty_percent() {
        // TSA 100,000, TBA 80,000: I = 6,400, cut 640, TSA 105,760, TBA 86,400, INS 640 (within the floor).
        let rate = borrow_rate(
            pct(80),
            rate_per_sec(200),
            rate_per_sec(600),
            rate_per_sec(5_200),
            KINK,
        );
        let i = interest(80_000 * WAD, rate, SECONDS_PER_YEAR as u64);
        assert_eq!(i / WAD, 6_399);
        assert!(6_400 * WAD - i < WAD / 100_000);
        let cut = mul_div_down(i, pct(10), WAD);
        assert_eq!(cut / 10u128.pow(15), 639_999);
    }

    #[test]
    #[should_panic(expected = "MulDivOverflow")]
    fn oversized_interest_panics() {
        interest(1, u128::MAX, 2);
    }

    fn tier_curve(i: usize) -> Curve {
        let (b, s1, s2) = CURVES[i];
        Curve {
            base: rate_per_sec(b),
            slope1: rate_per_sec(s1),
            slope2: rate_per_sec(s2),
            kink: KINK,
        }
    }

    /// The golden vectors the scripts' `lib/irm.ts` mirror is tested against, as JSON (decimal strings).
    fn irm_vectors_json() -> String {
        use serde_json::json;
        let s = |x: u128| x.to_string();
        let names = ["safe", "normal", "bold"];
        let curve_json = |c: &Curve| json!({"base": s(c.base), "slope1": s(c.slope1), "slope2": s(c.slope2), "kink": s(c.kink)});
        let mut rates = Vec::new();
        for (i, name) in names.iter().enumerate() {
            let c = tier_curve(i);
            for u in [0, 50, 80, 90, 95, 100] {
                rates.push(
                    json!({"tier": name, "utilization": s(pct(u)), "rate": s(c.rate(pct(u)))}),
                );
            }
        }
        let v1 = Curve {
            base: 1_585_489_599,
            slope1: 0,
            slope2: 0,
            kink: KINK,
        };
        let mut accruals = Vec::new();
        let cases: [(u128, u128, Curve, u128, u64); 7] = [
            // the one-year Normal example
            (
                100_000 * WAD,
                80_000 * WAD,
                tier_curve(1),
                pct(10),
                SECONDS_PER_YEAR as u64,
            ),
            // v1 terms: flat 5%, no reserve
            (100_000 * WAD, 892_677_098 * 10u128.pow(12), v1, 0, 86_400),
            (50_000 * WAD, 3_000 * WAD, v1, 0, SECONDS_PER_YEAR as u64),
            // above the kink, and borrows above the supply
            (100_000 * WAD, 95_000 * WAD, tier_curve(2), pct(10), 3_600),
            (100 * WAD, 101 * WAD, tier_curve(0), pct(10), 60),
            // nothing borrowed, or no time
            (100_000 * WAD, 0, tier_curve(1), pct(10), 86_400),
            (100_000 * WAD, 80_000 * WAD, tier_curve(1), pct(10), 0),
        ];
        for (tsa, tba, c, rf, elapsed) in cases {
            let a = accrue(tsa, tba, &c, rf, elapsed);
            accruals.push(json!({
                "tsa": s(tsa), "tba": s(tba), "curve": curve_json(&c), "reserve_factor": s(rf), "elapsed": elapsed,
                "utilization": s(utilization(tba, tsa)), "rate": s(a.rate), "interest": s(a.interest), "cut": s(a.cut),
                "supply_rate": s(supply_rate(a.rate, tsa, tba, rf)),
            }));
        }
        let doc = json!({
            "seconds_per_year": s(SECONDS_PER_YEAR),
            "max_rate_per_sec": s(MAX_RATE_PER_SEC),
            "curves": {
                "safe": curve_json(&tier_curve(0)),
                "normal": curve_json(&tier_curve(1)),
                "bold": curve_json(&tier_curve(2)),
                "v1": curve_json(&v1),
            },
            "borrow_rate": rates,
            "accrue": accruals,
        });
        serde_json::to_string_pretty(&doc).unwrap() + "\n"
    }

    #[test]
    fn irm_vectors_golden_file() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/irm-vectors.json");
        let expected = irm_vectors_json();
        if std::env::var_os("UPDATE_GOLDEN").is_some() || !std::path::Path::new(path).exists() {
            std::fs::create_dir_all(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data")).unwrap();
            std::fs::write(path, &expected).unwrap();
        }
        let stored = std::fs::read_to_string(path).unwrap();
        assert_eq!(stored, expected, "{path} differs from irm.rs");
        // The one-year Normal example as the spec states it, within the floors.
        let parsed: serde_json::Value = serde_json::from_str(&stored).unwrap();
        let first = &parsed["accrue"][0];
        let interest: u128 = first["interest"].as_str().unwrap().parse().unwrap();
        let cut: u128 = first["cut"].as_str().unwrap().parse().unwrap();
        assert_eq!(
            ((interest + WAD / 2) / WAD, (cut + WAD / 2) / WAD),
            (6_400, 640)
        );
        assert_eq!(parsed["borrow_rate"][8]["rate"], "2536783358");
    }

    use proptest::prelude::*;

    /// A curve the tier validation accepts: kink in [0.50, 0.95], base + slope1 + slope2 <= MAX_RATE_PER_SEC.
    fn curve() -> impl Strategy<Value = (u128, u128, u128, u128)> {
        (
            0..=MAX_RATE_PER_SEC,
            0..=MAX_RATE_PER_SEC,
            0..=MAX_RATE_PER_SEC,
            WAD / 2..=95 * WAD / 100,
        )
            .prop_map(|(b, s1, s2, kink)| {
                let b = b / 3;
                let s1 = s1 / 3;
                let s2 = s2.min(MAX_RATE_PER_SEC - b - s1);
                (b, s1, s2, kink)
            })
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 1024, failure_persistence: None, ..ProptestConfig::default() })]

        #[test]
        fn borrow_rate_is_monotone_and_bounded((b, s1, s2, kink) in curve(), u0 in 0..=WAD + WAD / 10, du in 0..=WAD) {
            let u1 = u0.saturating_add(du);
            let r0 = borrow_rate(u0, b, s1, s2, kink);
            let r1 = borrow_rate(u1, b, s1, s2, kink);
            prop_assert!(r0 <= r1);
            prop_assert!(r1 <= b + s1 + s2);
            prop_assert!(r1 <= MAX_RATE_PER_SEC);
            prop_assert!(r0 >= b);
        }

        #[test]
        fn supply_rate_never_exceeds_the_borrow_rate(rate in 0..=MAX_RATE_PER_SEC, tsa in 1u128..=10u128.pow(30), tba in 0u128..=10u128.pow(30), rf in 0..=WAD / 2) {
            let tba = tba.min(tsa);
            prop_assert!(supply_rate(rate, tsa, tba, rf) <= rate);
            prop_assert!(utilization(tba, tsa) <= WAD);
        }
    }
}
