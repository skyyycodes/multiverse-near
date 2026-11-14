//! The shared vectors (`tests/vectors.json`), which `scripts/lib/spot.ts`
//! reads too: both implementations of the median rule must agree on every
//! case.

use nearusd_guest::{
    aggregate, parse_decimal_wad, parse_quote, parse_utc_time, run, Quote, Source,
};
use serde_json::Value;

const VECTORS: &str = include_str!("vectors.json");

fn vectors() -> Value {
    serde_json::from_str(VECTORS).expect("vectors.json")
}

fn wad(v: &Value) -> Option<u128> {
    v.as_str().map(|s| s.parse().expect("a decimal u128"))
}

fn source(v: &Value) -> Source {
    serde_json::from_value(v.clone()).expect("a source name")
}

#[test]
fn decimals() {
    let v = vectors();
    let cases = v["decimals"].as_array().unwrap();
    assert!(cases.len() >= 10);
    for case in cases {
        let raw = case["raw"].as_str().unwrap();
        assert_eq!(parse_decimal_wad(raw).ok(), wad(&case["wad"]), "{raw:?}");
    }
}

#[test]
fn times() {
    let v = vectors();
    for case in v["times"].as_array().unwrap() {
        let raw = case["raw"].as_str().unwrap();
        assert_eq!(parse_utc_time(raw), case["sec"].as_u64(), "{raw:?}");
    }
}

#[test]
fn sources() {
    let v = vectors();
    for case in v["sources"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let got = parse_quote(
            source(&case["source"]),
            case["body"].as_str().unwrap(),
            case["now"].as_u64().unwrap(),
        );
        let want = &case["quote"];
        if want.is_null() {
            assert!(got.is_err(), "{name}: {got:?}");
            continue;
        }
        let got = got.unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(got.raw, want["raw"].as_str().unwrap(), "{name}");
        assert_eq!(Some(got.price_wad), wad(&want["price_wad"]), "{name}");
        assert_eq!(
            got.observed_at,
            want["observed_at"].as_u64().unwrap(),
            "{name}"
        );
    }
}

#[test]
fn aggregates() {
    let v = vectors();
    let cases = v["aggregate"].as_array().unwrap();
    assert!(cases.len() >= 10);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let quotes: Vec<Quote> = case["quotes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|q| {
                let raw = q["raw"].as_str().unwrap().to_string();
                // The vectors' prices are the parsed decimals.
                assert_eq!(parse_decimal_wad(&raw).ok(), wad(&q["price_wad"]), "{name}");
                Quote {
                    source: source(&q["source"]),
                    raw,
                    price_wad: wad(&q["price_wad"]).unwrap(),
                    observed_at: q["observed_at"].as_u64().unwrap(),
                }
            })
            .collect();
        let min = u8::try_from(case["min_sources"].as_u64().unwrap()).unwrap();
        let max = u32::try_from(case["max_spread_bps"].as_u64().unwrap()).unwrap();
        let want = &case["result"];
        match aggregate(&quotes, min, max) {
            Ok(r) => {
                assert!(want["error"].is_null(), "{name}: accepted {r:?}");
                assert_eq!(Some(r.price_wad), wad(&want["price_wad"]), "{name}");
                assert_eq!(
                    r.observed_at,
                    want["observed_at"].as_u64().unwrap(),
                    "{name}"
                );
                assert_eq!(
                    u64::from(r.sources_used),
                    want["sources_used"].as_u64().unwrap(),
                    "{name}"
                );
                assert_eq!(
                    u64::from(r.spread_bps),
                    want["spread_bps"].as_u64().unwrap(),
                    "{name}"
                );
                let dropped = r.dropped.map(|s| s.name());
                assert_eq!(dropped, want["dropped"].as_str(), "{name}");
            }
            Err(e) => {
                assert_eq!(Some(e.note.as_str()), want["error"].as_str(), "{name}");
                assert_eq!(
                    u64::from(e.sources_used),
                    want["sources_used"].as_u64().unwrap(),
                    "{name}"
                );
                assert_eq!(
                    u64::from(e.spread_bps),
                    want["spread_bps"].as_u64().unwrap(),
                    "{name}"
                );
            }
        }
    }
}

/// Whole runs with canned bodies (`null` = the request fails with HTTP 503).
#[test]
fn runs() {
    let v = vectors();
    for case in v["runs"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let bodies = &case["bodies"];
        let out = run(
            case["input"].as_str().unwrap(),
            case["now"].as_u64().unwrap(),
            |s| match bodies[s.name()].as_str() {
                Some(body) => Ok(body.to_string()),
                None => Err("HTTP 503".to_string()),
            },
        );
        let got = serde_json::to_value(&out).unwrap();
        assert_eq!(got, case["output"], "{name}");
    }
}
