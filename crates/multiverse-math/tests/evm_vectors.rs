//! Differential test against the EVM libraries this crate ports.
//!
//! `vectors/evm-vectors.txt` was written by `vectors/Vectors.t.sol` running the Solidity code itself (Uniswap v4
//! `TickMath`, OpenZeppelin `Math.mulDiv`, and the protocol's `PriceMath`, `OddsTree`, `SharesMath`, `OrderMath`,
//! `SwapFlow` and `TwapOracle`) under Foundry. Every line must come out the same here, bit for bit.

use std::collections::BTreeMap;
use std::panic::{self, AssertUnwindSafe};

use multiverse_math::flow::SwapFlow;
use multiverse_math::twap::TwapOracle;
use multiverse_math::{fixed, odds, orders, price, shares, tick, Rounding, U256, WAD};

const VECTORS: &str = include_str!("vectors/evm-vectors.txt");

fn u128_of(text: &str) -> u128 {
    text.parse()
        .unwrap_or_else(|_| panic!("not a u128: {text}"))
}

fn u256_of(text: &str) -> U256 {
    U256::from_dec_str(text).unwrap_or_else(|_| panic!("not a u256: {text}"))
}

fn i32_of(text: &str) -> i32 {
    text.parse()
        .unwrap_or_else(|_| panic!("not an i32: {text}"))
}

fn u64_of(text: &str) -> u64 {
    text.parse().unwrap_or_else(|_| panic!("not a u64: {text}"))
}

fn ok_of(text: &str) -> bool {
    match text {
        "1" => true,
        "0" => false,
        other => panic!("not a flag: {other}"),
    }
}

/// `Some(value)` when the EVM result fits a `u128`, which is when the port returns it rather than refusing.
fn fits_u128(text: &str) -> Option<u128> {
    if text == "overflow" {
        return None;
    }
    let value = u256_of(text);
    (value <= U256::from(u128::MAX)).then(|| value.low_u128())
}

/// A signed decimal of up to 256 bits as (negative, magnitude).
fn signed_u256(text: &str) -> (bool, U256) {
    match text.strip_prefix('-') {
        Some(magnitude) => (true, u256_of(magnitude)),
        None => (false, u256_of(text)),
    }
}

fn panic_message(f: impl FnOnce() -> u128) -> String {
    let payload = panic::catch_unwind(AssertUnwindSafe(f)).expect_err("expected a panic");
    payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_default()
}

#[test]
fn every_vector_matches_the_evm() {
    let mut checked: BTreeMap<&str, usize> = BTreeMap::new();
    let mut flow = SwapFlow::new();
    let mut oracle = TwapOracle::default();

    for (number, line) in VECTORS.lines().enumerate() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let Some((&kind, args)) = fields.split_first() else {
            continue;
        };
        let at = format!("line {}: {line}", number + 1);
        match (kind, args) {
            ("sqrt_at_tick", [t, s]) => {
                assert_eq!(tick::get_sqrt_ratio_at_tick(i32_of(t)), u256_of(s), "{at}");
            }
            ("tick_at_sqrt", [s, t]) => {
                assert_eq!(tick::get_tick_at_sqrt_ratio(u256_of(s)), i32_of(t), "{at}");
            }
            ("to_sqrt", [p, s]) => {
                assert_eq!(price::to_sqrt_price_x96(u128_of(p)), u256_of(s), "{at}");
                // A pool holding 1 wNEAR against p USDC has the same square-root price.
                assert_eq!(
                    price::sqrt_price_x96_from_reserves(WAD, u128_of(p)),
                    Some(u256_of(s)),
                    "{at}"
                );
            }
            ("from_sqrt", [s, p]) => {
                assert_eq!(
                    price::from_sqrt_price_x96(u256_of(s)),
                    Some(u128_of(p)),
                    "{at}"
                );
            }
            ("seed_tick", [p, t]) => {
                assert_eq!(
                    tick::get_tick_at_sqrt_ratio(price::to_sqrt_price_x96(u128_of(p))),
                    i32_of(t),
                    "{at}"
                );
                assert_eq!(
                    price::tick_from_reserves(WAD, u128_of(p)),
                    Some(i32_of(t)),
                    "{at}"
                );
            }
            ("from_tick", [t, p]) => {
                assert_eq!(price::from_tick(i32_of(t)), Some(u128_of(p)), "{at}");
            }
            ("pool_price_inv", [p, q]) => {
                assert_eq!(price::pool_price(u128_of(p), false), u128_of(q), "{at}");
                assert_eq!(price::pool_price(u128_of(p), true), u128_of(p), "{at}");
            }
            ("wnear_price_inv", [p, q]) => {
                assert_eq!(price::wnear_price(u128_of(p), false), u128_of(q), "{at}");
                assert_eq!(price::wnear_price(u128_of(p), true), u128_of(p), "{at}");
            }
            ("sqrt_for_odds", [a, b, s]) => {
                assert_eq!(
                    odds::sqrt_price_for_odds(u128_of(a), u128_of(b)),
                    u256_of(s),
                    "{at}"
                );
            }
            ("share0", [s, v]) => {
                assert_eq!(odds::share_of_token0(u256_of(s)), u128_of(v), "{at}");
            }
            (
                "to_shares_down" | "to_shares_up" | "to_assets_down" | "to_assets_up",
                [x, ta, ts, v],
            ) => {
                let (x, ta, ts) = (u128_of(x), u128_of(ta), u128_of(ts));
                let f = match kind {
                    "to_shares_down" => shares::to_shares_down,
                    "to_shares_up" => shares::to_shares_up,
                    "to_assets_down" => shares::to_assets_down,
                    _ => shares::to_assets_up,
                };
                match fits_u128(v) {
                    Some(expected) => assert_eq!(f(x, ta, ts), expected, "{at}"),
                    // Solidity has 256 bits of room; the port stores u128 and refuses anything larger.
                    None => assert_eq!(panic_message(|| f(x, ta, ts)), "MulDivOverflow", "{at}"),
                }
            }
            ("cost", [a, p, v]) => {
                assert_eq!(orders::cost(u128_of(a), u128_of(p)), u128_of(v), "{at}");
            }
            ("proceeds", [a, p, v]) => {
                assert_eq!(orders::proceeds(u128_of(a), u128_of(p)), u128_of(v), "{at}");
            }
            ("mul_div", [a, b, d, down, up @ ..]) => {
                let (a, b, d) = (u128_of(a), u128_of(b), u128_of(d));
                let up = up.first().copied().unwrap_or("overflow");
                assert_eq!(
                    fixed::checked_mul_div(a, b, d, Rounding::Down),
                    fits_u128(down),
                    "{at}"
                );
                assert_eq!(
                    fixed::checked_mul_div(a, b, d, Rounding::Up),
                    fits_u128(up),
                    "{at}"
                );
            }
            ("mul_div_256", [a, b, d, down, up @ ..]) => {
                let (a, b, d) = (u256_of(a), u256_of(b), u256_of(d));
                let expected = |text: &str| (text != "overflow").then(|| u256_of(text));
                let up = up.first().copied().unwrap_or("overflow");
                assert_eq!(
                    fixed::checked_mul_div_u256(a, b, d, Rounding::Down),
                    expected(down),
                    "{at}"
                );
                assert_eq!(
                    fixed::checked_mul_div_u256(a, b, d, Rounding::Up),
                    expected(up),
                    "{at}"
                );
            }
            ("flow_reset", []) => flow = SwapFlow::new(),
            ("flow_record", [v]) => {
                flow.record(v.parse().unwrap_or_else(|_| panic!("{at}")));
            }
            ("flow_state", [net_sold, total, count, fee, base, cap, fee_bounded]) => {
                let window = flow.window();
                let (negative, magnitude) = signed_u256(net_sold);
                assert_eq!(window.net_abs(), magnitude, "{at}");
                if !magnitude.is_zero() {
                    assert_eq!(window.net_is_negative(), negative, "{at}");
                }
                assert_eq!(window.total(), u256_of(total), "{at}");
                assert_eq!(flow.count(), u64_of(count), "{at}");
                assert_eq!(u64::from(flow.fee(3000, 15000)), u64_of(fee), "{at}");
                let (base, cap): (u32, u32) = (base.parse().unwrap(), cap.parse().unwrap());
                assert_eq!(u64::from(flow.fee(base, cap)), u64_of(fee_bounded), "{at}");
            }
            ("twap_init", [time, t]) => oracle = TwapOracle::new(u64_of(time), i32_of(t)),
            ("twap_write", [time, t]) => oracle.write(u64_of(time), i32_of(t)),
            ("twap_cum", [target, ok, value]) => {
                let expected = ok_of(ok).then(|| value.parse::<i64>().unwrap());
                assert_eq!(oracle.cumulative_at(u64_of(target)), expected, "{at}");
            }
            ("twap_mean", [time, window, ok, t]) => {
                let expected = ok_of(ok).then(|| i32_of(t));
                assert_eq!(
                    oracle.mean_tick(u64_of(time), u64_of(window)),
                    expected,
                    "{at}"
                );
            }
            ("twap_count", [count, newest]) => {
                assert_eq!(u64::from(oracle.count()), u64_of(count), "{at}");
                assert_eq!(u64::from(oracle.newest_index()), u64_of(newest), "{at}");
            }
            _ => panic!("unknown vector {at}"),
        }
        *checked.entry(kind).or_default() += 1;
    }

    // Guard against a truncated file or a parser that quietly skips a section.
    let expected = [
        ("sqrt_at_tick", 400),
        ("tick_at_sqrt", 700),
        ("to_sqrt", 70),
        ("from_sqrt", 70),
        ("seed_tick", 8),
        ("from_tick", 80),
        ("pool_price_inv", 40),
        ("wnear_price_inv", 40),
        ("sqrt_for_odds", 40),
        ("share0", 40),
        ("to_shares_down", 60),
        ("to_shares_up", 60),
        ("to_assets_down", 60),
        ("to_assets_up", 60),
        ("cost", 60),
        ("proceeds", 60),
        ("mul_div", 200),
        ("mul_div_256", 120),
        ("flow_record", 300),
        ("flow_state", 300),
        ("twap_write", 500),
        ("twap_cum", 200),
        ("twap_mean", 200),
        ("twap_count", 30),
    ];
    for (kind, at_least) in expected {
        let seen = checked.get(kind).copied().unwrap_or(0);
        assert!(
            seen >= at_least,
            "only {seen} {kind} vectors, expected at least {at_least}"
        );
    }
}

#[test]
fn vectors_cover_the_interesting_cases() {
    // The file must exercise refusals, the ring buffer wrapping and invalid TWAP reads, not just happy paths.
    assert!(VECTORS
        .lines()
        .any(|l| l.starts_with("mul_div_256 ") && l.ends_with(" overflow")));
    assert!(VECTORS.lines().any(|l| l.starts_with("twap_count 128 ")));
    assert!(VECTORS
        .lines()
        .any(|l| l.starts_with("twap_mean ") && l.split_whitespace().nth(3) == Some("0")));
    assert!(VECTORS
        .lines()
        .any(|l| l.starts_with("twap_cum ") && l.split_whitespace().nth(2) == Some("0")));
    assert!(VECTORS.lines().any(|l| l == "flow_record 0"));
    assert!(VECTORS
        .lines()
        .any(|l| l == format!("flow_record {}", i128::MIN)));
    let big = U256::from(u128::MAX);
    assert!(VECTORS
        .lines()
        .filter(|l| l.starts_with("to_shares_up "))
        .any(|l| u256_of(l.split_whitespace().nth(4).unwrap()) > big));
}
