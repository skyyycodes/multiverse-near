//! The outside NEAR/USD reference (F6): its config and bounds, the request
//! sent to OutLayer, every way the callback drops a result (never a panic,
//! never a byte of storage), the reporter key, and what a stored reference
//! does to borrowing on a market that switches the check on.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::{NearToken, PromiseResult};

use super::amm::{independent_odds, seed_odds, seed_worlds, DEMO_2X2, DEPTH, ODDS_DEPTH};
use super::harness::*;
use super::lending::{lending_world, Lend, DAVE, PRICES_2X2};
use crate::amm::test_hooks;
use crate::ops::PauseFlag;
use crate::outlayer::ResourceLimits;
use crate::prices::{MarketPriceCfg, PriceBlock};
use crate::reference::{ReferenceConfig, ReferenceGuest, ReferenceSource, ReferenceState};

pub const URL: &str = "https://example.org/nearusd-guest.wasm";
pub const HASH: &str = "6034aac8620b4559660c0315f1d4897509b6c3a722290e6c426ab50c21f52fc7";
pub const DEPOSIT: u128 = 5_000_000_000_000_000_000_000;
pub const OUTLAYER: &str = "outlayer.testnet";

/// The reporter key only, at the defaults of SPEC-C 4.3.
pub fn reporter_only() -> ReferenceConfig {
    ReferenceConfig {
        enabled: true,
        guest: None,
        reporter_id: Some(acc(REPORTER)),
        min_sources: 3,
        max_spread_bps: 200,
        max_result_delay_sec: 120,
        borrow_max_age_sec: 3_600,
        liquidation_max_age_sec: 300,
        min_price: U128(E18 / 100),
        max_price: U128(10_000 * E18),
    }
}

/// The pinned guest and the reporter.
pub fn with_guest() -> ReferenceConfig {
    ReferenceConfig {
        guest: Some(ReferenceGuest {
            outlayer_id: acc(OUTLAYER),
            wasm_url: URL.into(),
            wasm_sha256: HASH.into(),
            resource_limits: ResourceLimits::default(),
            deposit: U128(DEPOSIT),
        }),
        ..reporter_only()
    }
}

pub fn configure(w: &mut World, config: ReferenceConfig) -> Result<(), String> {
    w.call(OWNER, ONE_YOCTO, |c| c.set_reference_config(config))
}

/// The reporter posts `price` observed now.
pub fn report(w: &mut World, price: u128) -> Result<(), String> {
    let now = w.now;
    report_at(w, price, now)
}

pub fn report_at(w: &mut World, price: u128, observed_at: u64) -> Result<(), String> {
    w.call(REPORTER, NO_DEPOSIT, |c| {
        c.report_reference(U128(price), observed_at)
    })
}

pub fn set_cfg(w: &mut World, s: u64, cfg: MarketPriceCfg) -> Result<(), String> {
    w.call(OWNER, ONE_YOCTO, |c| c.set_market_price_config(s, cfg))
}

/// A market's config with the reference switched on.
pub fn with_reference(cfg: MarketPriceCfg) -> MarketPriceCfg {
    MarketPriceCfg {
        reference: true,
        ..cfg
    }
}

fn state(w: &mut World) -> ReferenceState {
    w.view(|c| c.reference_state()).expect("a reference record")
}

fn request(w: &mut World, who: &str, deposit: u128) -> Result<(), String> {
    w.call(who, NearToken::from_yoctonear(deposit), |c| {
        c.request_reference();
    })
}

/// Runs the callback of `request` as the runtime would after OutLayer's
/// receipt produced `result`.
fn callback(w: &mut World, request: u64, result: PromiseResult) -> Option<U128> {
    w.exec(CONTRACT, NO_DEPOSIT, vec![result], |c| {
        c.on_reference_result(request, acc(ALICE), U128(DEPOSIT))
    })
    .expect("on_reference_result must never panic")
}

fn answer(json: &str) -> PromiseResult {
    PromiseResult::Successful(json.as_bytes().to_vec())
}

/// A guest answer observed `ago` seconds before now.
fn guest_json(w: &World, price: &str, ago: u64, sources: u64, spread: u64) -> String {
    json!({
        "price_wad": price,
        "observed_at": w.now - ago,
        "sources_used": sources,
        "spread_bps": spread,
        "evidence": "coinbase=3.5047 kraken=3.5083 gemini=3.4810 coingecko=3.50 median=3.50235",
    })
    .to_string()
}

fn rejected(w: &World) -> Vec<String> {
    w.last
        .data_of("reference_rejected")
        .iter()
        .map(|d| d["note"].as_str().unwrap().to_string())
        .collect()
}

/// Configured with the guest, one request in flight (number 1).
fn requested() -> World {
    let mut w = World::new();
    configure(&mut w, with_guest()).unwrap();
    request(&mut w, ALICE, DEPOSIT).unwrap();
    w
}

// ---- Config ----

#[test]
fn config_is_owner_only_stored_and_charged_to_the_owner() {
    let mut w = World::new();
    assert_eq!(w.view(|c| c.get_reference_config()), None);
    assert_eq!(w.view(|c| c.get_reference()), None);
    assert!(!w.view(|c| c.get_app_config()).reference_configured);
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.set_reference_config(with_guest())),
        "NotOwner(alice.near)",
    );
    fails(
        w.call(OWNER, NO_DEPOSIT, |c| c.set_reference_config(with_guest())),
        "DepositRequired",
    );
    let available =
        |w: &mut World| w.view(|c| c.storage_balance_of(acc(OWNER)).unwrap().available.0);
    let before = available(&mut w);
    configure(&mut w, with_guest()).unwrap();
    assert!(available(&mut w) < before, "the owner pays for the records");
    assert_eq!(w.view(|c| c.get_reference_config()), Some(with_guest()));
    assert!(w.view(|c| c.get_app_config()).reference_configured);
    assert_eq!(
        w.last.data_of("reference_config_set"),
        vec![json!({
            "enabled": true, "outlayer": true, "reporter_id": REPORTER, "min_sources": 3,
            "max_spread_bps": 200, "borrow_max_age_sec": 3600, "liquidation_max_age_sec": 300,
        })]
    );
    // The record exists from the first config on, empty.
    assert_eq!(
        w.view(|c| c.get_reference())
            .map(|r| (r.price.0, r.request, r.pending)),
        Some((0, 0, false))
    );
    // A second config overwrites in place, keeps the reference, and a
    // smaller one gives the owner its bytes back.
    report(&mut w, 3_500 * E15).unwrap();
    let before = available(&mut w);
    configure(&mut w, reporter_only()).unwrap();
    assert!(available(&mut w) > before);
    assert_eq!(state(&mut w).price, 3_500 * E15);
    assert_eq!(w.view(|c| c.get_reference_config()), Some(reporter_only()));
}

#[test]
fn config_bounds() {
    let mut w = World::new();
    let base = with_guest();
    let cases: Vec<(ReferenceConfig, &str)> = vec![
        (
            ReferenceConfig {
                min_sources: 0,
                ..base.clone()
            },
            "BadReferenceConfig(min_sources)",
        ),
        (
            ReferenceConfig {
                min_sources: 5,
                ..base.clone()
            },
            "BadReferenceConfig(min_sources)",
        ),
        (
            ReferenceConfig {
                max_spread_bps: 0,
                ..base.clone()
            },
            "BadReferenceConfig(max_spread_bps)",
        ),
        (
            ReferenceConfig {
                max_spread_bps: 2_001,
                ..base.clone()
            },
            "BadReferenceConfig(max_spread_bps)",
        ),
        (
            ReferenceConfig {
                max_result_delay_sec: 29,
                ..base.clone()
            },
            "BadReferenceConfig(max_result_delay_sec)",
        ),
        (
            ReferenceConfig {
                max_result_delay_sec: 601,
                ..base.clone()
            },
            "BadReferenceConfig(max_result_delay_sec)",
        ),
        (
            ReferenceConfig {
                borrow_max_age_sec: 299,
                ..base.clone()
            },
            "BadReferenceConfig(borrow_max_age_sec)",
        ),
        (
            ReferenceConfig {
                borrow_max_age_sec: 86_401,
                ..base.clone()
            },
            "BadReferenceConfig(borrow_max_age_sec)",
        ),
        (
            ReferenceConfig {
                liquidation_max_age_sec: 59,
                ..base.clone()
            },
            "BadReferenceConfig(liquidation_max_age_sec)",
        ),
        (
            ReferenceConfig {
                liquidation_max_age_sec: 901,
                ..base.clone()
            },
            "BadReferenceConfig(liquidation_max_age_sec)",
        ),
        (
            ReferenceConfig {
                borrow_max_age_sec: 300,
                liquidation_max_age_sec: 301,
                ..base.clone()
            },
            "BadReferenceConfig(liquidation_max_age_sec)",
        ),
        (
            ReferenceConfig {
                min_price: U128(0),
                ..base.clone()
            },
            "BadReferenceConfig(min_price)",
        ),
        (
            ReferenceConfig {
                min_price: U128(5 * E18),
                max_price: U128(5 * E18),
                ..base.clone()
            },
            "BadReferenceConfig(min_price)",
        ),
        (
            ReferenceConfig {
                max_price: U128(1_000_000 * E18 + 1),
                ..base.clone()
            },
            "BadReferenceConfig(max_price)",
        ),
    ];
    for (config, error) in cases {
        fails(configure(&mut w, config), error);
    }
    let guest = |f: &dyn Fn(&mut ReferenceGuest)| {
        let mut config = with_guest();
        f(config.guest.as_mut().unwrap());
        config
    };
    fails(
        configure(
            &mut w,
            guest(&|g| g.wasm_url = "http://example.org/x.wasm".into()),
        ),
        "BadWasmUrl(not https)",
    );
    fails(
        configure(&mut w, guest(&|g| g.wasm_sha256 = HASH.to_uppercase())),
        "BadWasmHash",
    );
    fails(
        configure(&mut w, guest(&|g| g.resource_limits.max_memory_mb = 4_097)),
        "BadLimit(max_memory_mb, 4097)",
    );
    fails(
        configure(&mut w, guest(&|g| g.deposit = U128(0))),
        "BadLimit(deposit, 0)",
    );
    // Every edge inside the bounds is accepted.
    let edges = ReferenceConfig {
        min_sources: 4,
        max_spread_bps: 2_000,
        max_result_delay_sec: 30,
        borrow_max_age_sec: 86_400,
        liquidation_max_age_sec: 900,
        min_price: U128(1),
        max_price: U128(1_000_000 * E18),
        ..with_guest()
    };
    configure(&mut w, edges.clone()).unwrap();
    configure(
        &mut w,
        ReferenceConfig {
            min_sources: 1,
            max_spread_bps: 1,
            max_result_delay_sec: 600,
            borrow_max_age_sec: 300,
            liquidation_max_age_sec: 60,
            ..edges
        },
    )
    .unwrap();
}

/// Switching the reference off never fails on another field.
#[test]
fn a_disabled_config_is_always_accepted() {
    let mut w = World::new();
    configure(&mut w, with_guest()).unwrap();
    let off = ReferenceConfig {
        enabled: false,
        guest: None,
        reporter_id: None,
        min_sources: 0,
        max_spread_bps: 0,
        max_result_delay_sec: 0,
        borrow_max_age_sec: 0,
        liquidation_max_age_sec: 0,
        min_price: U128(0),
        max_price: U128(0),
    };
    configure(&mut w, off.clone()).unwrap();
    assert_eq!(w.view(|c| c.get_reference_config()), Some(off));
    fails(request(&mut w, ALICE, DEPOSIT), "ReferenceNotConfigured");
}

// ---- Request ----

#[test]
fn request_sends_outlayer_exactly_its_interface() {
    let mut w = World::new();
    configure(&mut w, with_guest()).unwrap();
    request(&mut w, BOB, DEPOSIT + 7).unwrap();
    let calls = w.last.calls();
    assert_eq!(calls.len(), 2);
    let run = &calls[0];
    assert_eq!(run.receiver_id, acc(OUTLAYER));
    assert_eq!(run.method, "request_execution");
    assert_eq!((run.deposit, run.tgas), (DEPOSIT + 7, 200));
    assert_eq!(
        run.args,
        json!({
            "source": {"WasmUrl": {"url": URL, "hash": HASH, "build_target": "wasm32-wasip2"}},
            "resource_limits": {"max_instructions": 1_000_000_000u64, "max_memory_mb": 128, "max_execution_seconds": 30},
            "input_data": r#"{"max_spread_bps":200,"min_sources":3}"#,
            "response_format": "Json",
            "payer_account_id": BOB,
        })
    );
    let cb = &calls[1];
    assert_eq!(cb.receiver_id, acc(CONTRACT));
    assert_eq!(cb.method, "on_reference_result");
    assert_eq!((cb.deposit, cb.tgas, cb.after.clone()), (0, 20, vec![0]));
    assert_eq!(
        cb.args,
        json!({"request": 1, "payer": BOB, "deposit": (DEPOSIT + 7).to_string()})
    );
    assert_eq!(
        w.last.data_of("reference_requested"),
        vec![json!({"request": 1, "payer_id": BOB})]
    );
    let s = state(&mut w);
    assert_eq!((s.request, s.pending_since), (1, w.now));
    assert!(w.view(|c| c.get_reference()).unwrap().pending);
}

#[test]
fn request_reference_checks_in_order() {
    let mut w = World::new();
    fails(request(&mut w, ALICE, DEPOSIT), "ReferenceNotConfigured");
    // No guest: the reporter is the only source.
    configure(&mut w, reporter_only()).unwrap();
    fails(request(&mut w, ALICE, DEPOSIT), "ReferenceNotConfigured");
    configure(&mut w, with_guest()).unwrap();
    request(&mut w, ALICE, DEPOSIT).unwrap();
    // One in flight; the in-flight check comes before the deposit and gas.
    w.prepaid_tgas = 200;
    fails(request(&mut w, ALICE, 0), "ReferenceRequestInFlight(1)");
    w.warp(599);
    fails(request(&mut w, ALICE, 0), "ReferenceRequestInFlight(1)");
    assert!(w.view(|c| c.get_reference()).unwrap().pending);
    // A lost callback stops blocking after 600 s.
    w.warp(1);
    assert!(!w.view(|c| c.get_reference()).unwrap().pending);
    fails(
        request(&mut w, ALICE, DEPOSIT - 1),
        &format!("InsufficientDeposit({DEPOSIT}, {})", DEPOSIT - 1),
    );
    fails(request(&mut w, ALICE, DEPOSIT), "NotEnoughGas(240)");
    w.prepaid_tgas = 300;
    request(&mut w, ALICE, DEPOSIT).unwrap();
    assert_eq!(state(&mut w).request, 2);
    // The owner's `oracle` pause stops requests.
    w.call(OWNER, NO_DEPOSIT, |c| {
        c.pause.flags = PauseFlag::bits_of(&[PauseFlag::Oracle])
    })
    .unwrap();
    w.warp(600);
    fails(request(&mut w, ALICE, DEPOSIT), "Paused(oracle)");
}

// ---- Callback ----

#[test]
fn a_good_result_is_stored() {
    let mut w = requested();
    let json = guest_json(&w, "3502350000000000000", 20, 4, 78);
    let out = callback(&mut w, 1, answer(&json));
    assert_eq!(out, Some(U128(3_502_350_000_000_000_000)));
    let s = state(&mut w);
    assert_eq!(
        s,
        ReferenceState {
            price: 3_502_350_000_000_000_000,
            observed_at: w.now - 20,
            stored_at: w.now,
            source: ReferenceSource::OUTLAYER,
            sources_used: 4,
            spread_bps: 78,
            request: 1,
            pending_since: 0,
        }
    );
    assert_eq!(
        w.last.data_of("reference_updated"),
        vec![json!({
            "price": "3502350000000000000", "observed_at": w.now - 20, "source": "outlayer",
            "request": 1, "sources_used": 4, "spread_bps": 78,
        })]
    );
    let view = w.view(|c| c.get_reference()).unwrap();
    assert_eq!(
        (view.age_sec, view.source, view.pending),
        (20, ReferenceSource::Outlayer, false)
    );
    assert!(rejected(&w).is_empty());
}

#[test]
fn on_reference_result_drops_and_never_panics() {
    // (answer, note); each from a fresh request 1.
    type Case = (Box<dyn Fn(&World) -> PromiseResult>, &'static str);
    let price = "3502350000000000000";
    let cases: Vec<Case> = vec![
        (Box::new(|_| answer(&"x".repeat(4_097))), "result too long"),
        (Box::new(|_| answer("not json")), "result is not JSON"),
        (Box::new(|_| answer("null")), "no result"),
        (
            Box::new(|_| answer(r#"{"price_wad":null,"evidence":"too few sources (2 < 3)"}"#)),
            "no result",
        ),
        (
            Box::new(move |w| answer(&guest_json(w, "3.5", 20, 4, 78))),
            "bad price",
        ),
        (
            Box::new(move |w| answer(&guest_json(w, "-1", 20, 4, 78))),
            "bad price",
        ),
        (
            Box::new(move |w| answer(&guest_json(w, "+35", 20, 4, 78))),
            "bad price",
        ),
        (
            Box::new(move |w| {
                answer(&guest_json(
                    w,
                    "340282366920938463463374607431768211456",
                    20,
                    4,
                    78,
                ))
            }),
            "bad price",
        ),
        (
            Box::new(move |w| {
                answer(&json!({"price_wad": 3_500_000u64, "observed_at": w.now}).to_string())
            }),
            "bad price",
        ),
        (
            Box::new(move |w| answer(&guest_json(w, price, 20, 2, 78))),
            "too few sources (2 < 3)",
        ),
        (
            Box::new(move |w| {
                answer(&json!({"price_wad": price, "observed_at": w.now}).to_string())
            }),
            "too few sources (0 < 3)",
        ),
        (
            Box::new(move |w| answer(&guest_json(w, price, 20, 4, 201))),
            "spread 201 bps above 200",
        ),
        (
            Box::new(move |w| {
                answer(
                    &json!({"price_wad": price, "observed_at": w.now, "sources_used": 4})
                        .to_string(),
                )
            }),
            "spread 4294967295 bps above 200",
        ),
        (
            Box::new(move |w| {
                answer(&json!({"price_wad": price, "observed_at": w.now + 61, "sources_used": 4, "spread_bps": 78}).to_string())
            }),
            "observed in the future",
        ),
        (
            Box::new(move |w| answer(&guest_json(w, price, 121, 4, 78))),
            "late by 121 s",
        ),
        (
            Box::new(move |_| {
                answer(
                    &json!({"price_wad": price, "sources_used": 4, "spread_bps": 78}).to_string(),
                )
            }),
            "late by 1790000000 s",
        ),
        (
            Box::new(move |w| answer(&guest_json(w, "9999999999999999", 20, 4, 78))),
            "out of bounds",
        ),
        (
            Box::new(move |w| answer(&guest_json(w, "10000000000000000000001", 20, 4, 78))),
            "out of bounds",
        ),
    ];
    for (make, note) in cases {
        let mut w = requested();
        let result = make(&w);
        let before = state(&mut w);
        assert_eq!(callback(&mut w, 1, result), None, "{note}");
        assert_eq!(rejected(&w), vec![note.to_string()], "{note}");
        assert!(w.last.data_of("reference_updated").is_empty());
        // Nothing stored but the cleared in-flight mark.
        assert_eq!(
            state(&mut w),
            ReferenceState {
                pending_since: 0,
                ..before
            },
            "{note}"
        );
    }
    // The edges that pass: 60 s ahead, 120 s late, the bounds themselves.
    for (observed, price) in [
        (60i64, "10000000000000000"),
        (-120, "10000000000000000000000"),
    ] {
        let mut w = requested();
        let at = (w.now as i64 + observed) as u64;
        let json =
            json!({"price_wad": price, "observed_at": at, "sources_used": 3, "spread_bps": 200})
                .to_string();
        assert!(callback(&mut w, 1, answer(&json)).is_some(), "{observed}");
    }
}

#[test]
fn a_failed_request_returns_the_deposit_and_a_stale_one_is_dropped() {
    let mut w = requested();
    assert_eq!(callback(&mut w, 1, PromiseResult::Failed), None);
    assert_eq!(rejected(&w), vec!["request failed"]);
    assert_eq!(w.last.near_transfers(), vec![(acc(ALICE), DEPOSIT)]);
    assert_eq!(state(&mut w).pending_since, 0);

    // Request 2 is in flight; request 1's late answer is stale and keeps the
    // pending mark of request 2.
    request(&mut w, BOB, DEPOSIT).unwrap();
    let json = guest_json(&w, "3502350000000000000", 5, 4, 78);
    assert_eq!(callback(&mut w, 1, answer(&json)), None);
    assert_eq!(rejected(&w), vec!["stale request"]);
    assert_eq!(state(&mut w).pending_since, w.now);
    assert_eq!(state(&mut w).price, 0);
    // A stale failure still refunds its payer.
    assert_eq!(callback(&mut w, 1, PromiseResult::Failed), None);
    assert_eq!(w.last.near_transfers(), vec![(acc(ALICE), DEPOSIT)]);
    assert_eq!(
        callback(&mut w, 2, answer(&json)),
        Some(U128(3_502_350_000_000_000_000))
    );
}

#[test]
fn an_older_result_never_replaces_a_newer_one() {
    let mut w = requested();
    let ten_ago = w.now - 10;
    report_at(&mut w, 3_400 * E15, ten_ago).unwrap();
    let json = guest_json(&w, "3502350000000000000", 10, 4, 78);
    assert_eq!(callback(&mut w, 1, answer(&json)), None);
    assert_eq!(rejected(&w), vec!["older than stored"]);
    assert_eq!(state(&mut w).price, 3_400 * E15);
}

/// The callback's storage delta, measured inside its own receipt.
fn callback_growth(w: &mut World, request: u64, result: PromiseResult) -> (Option<U128>, i64) {
    w.exec(CONTRACT, NO_DEPOSIT, vec![result], |c| {
        let before = near_sdk::env::storage_usage();
        let out = c.on_reference_result(request, acc(ALICE), U128(DEPOSIT));
        (out, near_sdk::env::storage_usage() as i64 - before as i64)
    })
    .expect("on_reference_result must never panic")
}

#[test]
fn reference_callbacks_never_grow_storage() {
    let mut w = requested();
    for (number, ago) in [(1u64, 30u64), (2, 20), (3, 10)] {
        if number > 1 {
            request(&mut w, ALICE, DEPOSIT).unwrap();
        }
        let json = guest_json(&w, "3502350000000000000", ago, 4, 78);
        let (out, grown) = callback_growth(&mut w, number, answer(&json));
        assert!(out.is_some());
        assert_eq!(grown, 0, "request {number}");
    }
    // Rejections, failures and stale answers write nothing that grows.
    request(&mut w, ALICE, DEPOSIT).unwrap();
    assert_eq!(callback_growth(&mut w, 4, answer("[]")), (None, 0));
    assert_eq!(callback_growth(&mut w, 3, PromiseResult::Failed), (None, 0));
    let json = guest_json(&w, "3502350000000000000", 5, 4, 78);
    assert_eq!(callback_growth(&mut w, 2, answer(&json)), (None, 0));
    // The reporter overwrites the same record.
    w.warp(1);
    let now = w.now;
    let grown = w
        .exec(REPORTER, NO_DEPOSIT, vec![], |c| {
            let before = near_sdk::env::storage_usage();
            c.report_reference(U128(3_500 * E15), now);
            near_sdk::env::storage_usage() as i64 - before as i64
        })
        .unwrap();
    assert_eq!(grown, 0);
}

// ---- Reporter ----

#[test]
fn report_reference_only_by_the_reporter() {
    let mut w = World::new();
    fails(
        report(&mut w, 3_500 * E15),
        "NotReferenceReporter(resolver.near)",
    );
    configure(
        &mut w,
        ReferenceConfig {
            reporter_id: None,
            ..reporter_only()
        },
    )
    .unwrap();
    fails(
        report(&mut w, 3_500 * E15),
        "NotReferenceReporter(resolver.near)",
    );
    configure(&mut w, reporter_only()).unwrap();
    let now = w.now;
    fails(
        w.call(ALICE, NO_DEPOSIT, |c| {
            c.report_reference(U128(3_500 * E15), now)
        }),
        "NotReferenceReporter(alice.near)",
    );
    fails(
        report_at(&mut w, 3_500 * E15, now + 61),
        "BadReference(observed in the future)",
    );
    fails(
        report_at(&mut w, 3_500 * E15, now - 121),
        "BadReference(late by 121 s)",
    );
    fails(report(&mut w, E18 / 100 - 1), "BadReference(out of bounds)");
    fails(
        report(&mut w, 10_000 * E18 + 1),
        "BadReference(out of bounds)",
    );
    report(&mut w, 3_500 * E15).unwrap();
    assert_eq!(
        w.last.data_of("reference_updated"),
        vec![json!({
            "price": "3500000000000000000", "observed_at": now, "source": "reporter",
            "request": 0, "sources_used": 0, "spread_bps": 0,
        })]
    );
    let s = state(&mut w);
    assert_eq!(
        (s.price, s.observed_at, s.stored_at, s.source),
        (3_500 * E15, now, now, ReferenceSource::REPORTER)
    );
    fails(
        report(&mut w, 3_600 * E15),
        "BadReference(older than stored)",
    );
    w.warp(1);
    report(&mut w, 3_600 * E15).unwrap();
    // A disabled config keeps the reporter out.
    configure(
        &mut w,
        ReferenceConfig {
            enabled: false,
            ..reporter_only()
        },
    )
    .unwrap();
    w.warp(1);
    fails(report(&mut w, 3_600 * E15), "ReferenceNotConfigured");
    configure(&mut w, reporter_only()).unwrap();
    w.call(OWNER, NO_DEPOSIT, |c| {
        c.pause.flags = PauseFlag::bits_of(&[PauseFlag::Oracle])
    })
    .unwrap();
    fails(report(&mut w, 3_600 * E15), "Paused(oracle)");
}

// ---- What the reference does to borrowing ----

/// The 2x2 scenario priced by test quotes at the demo prices, odds 1/4
/// each: I = (3.70 + 3.00 + 3.30 + 2.50) / 4 = 3.125.
fn quoted_2x2() -> (World, u64) {
    test_hooks::clear();
    let mut w = World::new();
    let s = w.s2x2;
    for (world, p) in PRICES_2X2.iter().enumerate() {
        test_hooks::set_price(s, world as u8, *p);
    }
    test_hooks::set_odds(s, vec![E18 / 4; 4]);
    set_cfg(&mut w, s, with_reference(super::profile::V1_PRICE_CFG)).unwrap();
    (w, s)
}

const I_2X2: u128 = 3_125 * E15;

fn borrow_block(w: &mut World, s: u64) -> Option<String> {
    w.view(|c| c.price_check(s)).borrow_block
}

#[test]
fn borrow_needs_a_fresh_reference() {
    let (mut w, s) = quoted_2x2();
    // No config at all, then a config with nothing stored yet.
    assert_eq!(borrow_block(&mut w, s).as_deref(), Some("ReferenceMissing"));
    configure(&mut w, reporter_only()).unwrap();
    assert_eq!(borrow_block(&mut w, s).as_deref(), Some("ReferenceMissing"));
    report(&mut w, I_2X2).unwrap();
    assert_eq!(borrow_block(&mut w, s), None);
    w.warp(3_600);
    assert_eq!(borrow_block(&mut w, s), None);
    w.warp(1);
    assert_eq!(
        borrow_block(&mut w, s).as_deref(),
        Some("ReferenceStale(3601, 3600)")
    );
    // The global switch turns the check off on every market.
    configure(
        &mut w,
        ReferenceConfig {
            enabled: false,
            ..reporter_only()
        },
    )
    .unwrap();
    assert_eq!(borrow_block(&mut w, s), None);
    test_hooks::clear();
}

#[test]
fn borrow_refuses_a_10_01_percent_gap_and_allows_10_00() {
    let (mut w, s) = quoted_2x2();
    configure(&mut w, reporter_only()).unwrap();
    let cases = [
        (I_2X2 * 110 / 100, None),
        (
            I_2X2 * 11_001 / 10_000,
            Some((I_2X2, I_2X2 * 11_001 / 10_000)),
        ),
        (I_2X2 * 90 / 100, None),
        (
            I_2X2 * 8_999 / 10_000,
            Some((I_2X2, I_2X2 * 8_999 / 10_000)),
        ),
    ];
    for (reference, block) in cases {
        w.warp(1);
        report(&mut w, reference).unwrap();
        let expected = block.map(|(implied, reference)| {
            PriceBlock::ReferenceDeviation { implied, reference }.error()
        });
        assert_eq!(borrow_block(&mut w, s), expected, "{reference}");
    }
    test_hooks::clear();
}

#[test]
fn implied_spot_unknown_blocks_borrowing_on_reference_markets() {
    test_hooks::clear();
    let mut w = World::new();
    w.fund(OWNER);
    let s = w.s2x2;
    seed_worlds(&mut w, s, &DEMO_2X2, &[DEPTH; 4]);
    configure(&mut w, reporter_only()).unwrap();
    set_cfg(&mut w, s, with_reference(super::profile::V1_PRICE_CFG)).unwrap();
    w.warp(1_801);
    report(&mut w, 3_125 * E15).unwrap();
    // Every world is trusted, but no odds pool exists.
    let check = w.view(|c| c.price_check(s));
    assert_eq!(check.implied_twap_spot, None);
    assert_eq!(check.borrow_block, Some(format!("ImpliedSpotUnknown({s})")));
    assert_eq!(
        (check.borrow_factor.0, check.liquidation_factor.0),
        (E18, E18)
    );
    // Odds pools younger than a window do not count either.
    let q = independent_odds(4, 6_667, 100);
    seed_odds(&mut w, s, &q, ODDS_DEPTH);
    w.warp(1_799);
    report(&mut w, 3_125 * E15).unwrap();
    assert_eq!(
        borrow_block(&mut w, s),
        Some(format!("ImpliedSpotUnknown({s})"))
    );
    w.warp(1);
    report(&mut w, 3_125 * E15).unwrap();
    let check = w.view(|c| c.price_check(s));
    let implied = check.implied_twap_spot.unwrap().0;
    // The demo's implied spot, 3.0377, at the floored TWAP prices; 3.125 is
    // 2.9% above it, inside the 10% band.
    assert!(implied > 3_037 * E15 && implied < 3_038 * E15, "{implied}");
    assert_eq!(check.borrow_block, None);
    assert_eq!(
        check.ratio.unwrap().0,
        multiverse_math::mul_div_down(3_125 * E15, E18, implied)
    );
}

/// A market whose pools sit 12% under NEAR/USD (3.125 against 3.50) keeps
/// lending with the switch off; switching it on blocks borrowing.
#[test]
fn synthetic_market_with_the_switch_off_borrows() {
    let (mut w, s) = quoted_2x2();
    configure(&mut w, reporter_only()).unwrap();
    report(&mut w, 3_500 * E15).unwrap();
    assert!(borrow_block(&mut w, s)
        .unwrap()
        .starts_with("ReferenceDeviation("));
    set_cfg(&mut w, s, super::profile::V1_PRICE_CFG).unwrap();
    assert_eq!(borrow_block(&mut w, s), None);
    let check = w.view(|c| c.price_check(s));
    // The view still shows the gap.
    assert_eq!(check.implied_twap_spot, Some(U128(I_2X2)));
    assert_eq!(check.ratio, Some(U128(1_120_000_000_000_000_000)));
    assert!(!check.liquidation_guard);
    test_hooks::clear();
}

/// Repay, collateral deposits, supply, withdrawals and liquidation never
/// wait on the reference, even on a market with the switch on and a stale
/// or missing reference.
#[test]
fn repay_deposit_close_and_liquidate_ignore_a_stale_reference() {
    let mut w = lending_world(100_000 * E18);
    let s = w.s2x2;
    // A reference market with a fresh reference equal to the implied spot,
    // so the borrow passes every check.
    test_hooks::set_odds(s, vec![E18 / 4; 4]);
    configure(&mut w, reporter_only()).unwrap();
    report(&mut w, I_2X2).unwrap();
    set_cfg(&mut w, s, with_reference(super::profile::V1_PRICE_CFG)).unwrap();
    assert_eq!(borrow_block(&mut w, s), None);
    w.post_real(ALICE, s, crate::types::Asset::Wnear, 10_000 * E18)
        .unwrap();
    w.borrow(ALICE, s, 15_000 * E18).unwrap();
    w.warp(4_000);
    assert_eq!(
        borrow_block(&mut w, s).as_deref(),
        Some("ReferenceStale(4000, 3600)")
    );
    // A stale reference neither scales liquidation prices nor guards.
    let check = w.view(|c| c.price_check(s));
    assert_eq!(
        (check.liquidation_factor.0, check.liquidation_guard),
        (E18, false)
    );
    w.repay_ft(ALICE, s, 1_000 * E18, false).unwrap();
    w.post_real(ALICE, s, crate::types::Asset::Wnear, 1_000 * E18)
        .unwrap();
    w.lend(CAROL, s, 1_000 * E18).unwrap();
    w.withdraw_lent(CAROL, s, Some(500 * E18)).unwrap();
    // The worst world falls far enough for a liquidation.
    test_hooks::set_price(s, 3, 1_000 * E15);
    let done = w.liquidate(DAVE, s, ALICE, Some(1_000 * E18)).unwrap();
    assert!(done.repaid > 0);
    test_hooks::clear();
}

/// The views carry the keys of SPEC-C 3.9.
#[test]
fn reference_views_have_their_keys() {
    let mut w = World::new();
    configure(&mut w, with_guest()).unwrap();
    report(&mut w, 3_500 * E15).unwrap();
    let keys = |v: Value| -> Vec<String> {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    };
    let reference = near_sdk::serde_json::to_value(w.view(|c| c.get_reference())).unwrap();
    assert_eq!(
        keys(reference.clone()),
        [
            "age_sec",
            "observed_at",
            "pending",
            "price",
            "request",
            "source",
            "sources_used",
            "spread_bps",
            "stored_at"
        ]
    );
    assert_eq!(reference["source"], "reporter");
    let config = near_sdk::serde_json::to_value(w.view(|c| c.get_reference_config())).unwrap();
    assert_eq!(
        keys(config.clone()),
        [
            "borrow_max_age_sec",
            "enabled",
            "guest",
            "liquidation_max_age_sec",
            "max_price",
            "max_result_delay_sec",
            "max_spread_bps",
            "min_price",
            "min_sources",
            "reporter_id"
        ]
    );
    assert_eq!(
        keys(config["guest"].clone()),
        [
            "deposit",
            "outlayer_id",
            "resource_limits",
            "wasm_sha256",
            "wasm_url"
        ]
    );
}

/// SPEC-C 7: the callback runs on its 20 Tgas static gas, and its longest
/// path (every check, then a rejection) must stay under 60% of it. The
/// mocked runtime counts the host calls; the sandbox gate re-measures the
/// wasm at the parent's minimum gas.
#[test]
fn on_reference_result_gas_stays_under_its_floor() {
    let mut longest = 0u64;
    for price in ["9999999999999999", "3502350000000000000"] {
        let mut w = requested();
        let json = guest_json(&w, price, 20, 4, 78);
        let gas = w
            .exec(CONTRACT, NO_DEPOSIT, vec![answer(&json)], |c| {
                let before = near_sdk::env::used_gas().as_gas();
                c.on_reference_result(1, acc(ALICE), U128(DEPOSIT));
                near_sdk::env::used_gas().as_gas() - before
            })
            .unwrap();
        longest = longest.max(gas);
    }
    assert!(longest < 12_000_000_000_000, "{longest}");
}
