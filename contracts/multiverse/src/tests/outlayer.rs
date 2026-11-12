//! OutLayer resolution: the request sent to `request_execution`, every way
//! the callback drops a result, the pending flag, and a proposal that goes
//! through the dispute window like any other.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, NearToken, PromiseResult};

use super::harness::*;
use crate::outlayer::{FomcDates, OutLayerConfig, ResourceLimits};
use crate::types::Source;

const URL: &str = "https://example.org/fred-guest.wasm";
const HASH: &str = "4f3c1b0a9e8d7c6b5a49382716f5e4d3c2b1a0f9e8d7c6b5a4938271605f4e3d";
const DEPOSIT: u128 = 5_000_000_000_000_000_000_000;
const OUTLAYER: &str = "outlayer.testnet";

fn limits(max_instructions: u64, max_memory_mb: u32, max_execution_seconds: u64) -> ResourceLimits {
    ResourceLimits {
        max_instructions,
        max_memory_mb,
        max_execution_seconds,
    }
}

fn configure(w: &mut World) {
    w.call(OWNER, ONE_YOCTO, |c| {
        c.set_outlayer_config(URL.into(), HASH.into(), None, None, None)
    })
    .unwrap();
}

fn set_dates(w: &mut World, event: u64) -> Result<(), String> {
    w.call(OWNER, ONE_YOCTO, |c| {
        c.set_outlayer_dates(event, "2026-10-27".into(), "2026-10-29".into())
    })
}

/// Configured, with dates on the Fed event.
fn ready() -> World {
    let mut w = World::new();
    configure(&mut w);
    let fed = w.fed;
    set_dates(&mut w, fed).unwrap();
    w
}

fn request(w: &mut World, who: &str, deposit: u128, event: u64) -> Result<(), String> {
    w.call(who, NearToken::from_yoctonear(deposit), |c| {
        c.request_resolution(event);
    })
}

fn dates(w: &mut World, event: u64) -> FomcDates {
    w.view(|c| c.get_outlayer_dates(event)).unwrap()
}

/// Runs the callback of run `request` as the runtime would, after
/// OutLayer's receipt produced `result`.
fn callback(w: &mut World, event: u64, request: u64, result: PromiseResult) -> Option<u8> {
    w.exec(CONTRACT, NO_DEPOSIT, vec![result], |c| {
        c.on_outlayer_result(event, request, acc(ALICE), U128(DEPOSIT))
    })
    .expect("on_outlayer_result must never panic")
}

fn answer(json: &str) -> PromiseResult {
    PromiseResult::Successful(json.as_bytes().to_vec())
}

const HOLDS_JSON: &str = r#"{"outcome":1,"evidence":"FRED DFEDTARU 2026-10-27=4.00 2026-10-29=4.00, DFEDTARL 2026-10-27=3.75 2026-10-29=3.75: HOLDS"}"#;

fn last_result(w: &World) -> Value {
    let results = w.last.data_of("outlayer_result");
    assert_eq!(results.len(), 1, "{:?}", w.last.logs);
    results[0].clone()
}

#[test]
fn config_takes_defaults_and_is_charged_to_the_owner() {
    let mut w = World::new();
    assert_eq!(w.view(|c| c.get_outlayer_config()), None);
    let used = w.view(|c| c.storage_balance_of(acc(OWNER)).unwrap().available);
    configure(&mut w);
    assert_eq!(
        w.view(|c| c.get_outlayer_config()),
        Some(OutLayerConfig {
            outlayer_id: acc(OUTLAYER),
            wasm_url: URL.into(),
            wasm_sha256: HASH.into(),
            resource_limits: ResourceLimits {
                max_instructions: 1_000_000_000,
                max_memory_mb: 128,
                max_execution_seconds: 30,
            },
            deposit: U128(DEPOSIT),
        })
    );
    let left = w.view(|c| c.storage_balance_of(acc(OWNER)).unwrap().available);
    assert!(left.0 < used.0);

    w.call(OWNER, ONE_YOCTO, |c| {
        c.set_outlayer_config(
            URL.into(),
            HASH.into(),
            Some(acc("outlayer.near")),
            Some(limits(20_000_000_000, 256, 60)),
            Some(U128(7_002_000_000_000_000_000_000)),
        )
    })
    .unwrap();
    let cfg = w.view(|c| c.get_outlayer_config()).unwrap();
    assert_eq!(cfg.outlayer_id, acc("outlayer.near"));
    assert_eq!(cfg.resource_limits, limits(20_000_000_000, 256, 60));
    assert_eq!(cfg.deposit, U128(7_002_000_000_000_000_000_000));
}

#[test]
fn config_rejects_what_outlayer_would() {
    let mut w = World::new();
    let set = |w: &mut World, url: &str, hash: &str, l: (u64, u32, u64), deposit: u128| {
        let (url, hash) = (url.to_string(), hash.to_string());
        w.call(OWNER, ONE_YOCTO, move |c| {
            c.set_outlayer_config(
                url,
                hash,
                None,
                Some(limits(l.0, l.1, l.2)),
                Some(U128(deposit)),
            )
        })
    };
    let ok = (1_000_000_000, 128, 30);
    fails(
        w.call(ALICE, ONE_YOCTO, |c| {
            c.set_outlayer_config(URL.into(), HASH.into(), None, None, None)
        }),
        "OwnableUnauthorizedAccount(alice.near)",
    );
    fails(
        w.call(OWNER, NO_DEPOSIT, |c| {
            c.set_outlayer_config(URL.into(), HASH.into(), None, None, None)
        }),
        "DepositRequired",
    );
    fails(
        set(&mut w, "http://example.org/a.wasm", HASH, ok, DEPOSIT),
        "BadWasmUrl(not https)",
    );
    fails(
        set(&mut w, "https://", HASH, ok, DEPOSIT),
        "BadWasmUrl(not https)",
    );
    fails(
        set(&mut w, "https://a b/x.wasm", HASH, ok, DEPOSIT),
        "BadWasmUrl(whitespace)",
    );
    fails(
        set(&mut w, "https://x/EVENT_JSON.wasm", HASH, ok, DEPOSIT),
        "BadWasmUrl(EVENT_JSON)",
    );
    let long = format!("https://{}", "a".repeat(2041));
    fails(
        set(&mut w, &long, HASH, ok, DEPOSIT),
        "BadWasmUrl(too long)",
    );
    fails(
        set(&mut w, URL, &HASH.to_uppercase(), ok, DEPOSIT),
        "BadWasmHash",
    );
    fails(set(&mut w, URL, &HASH[1..], ok, DEPOSIT), "BadWasmHash");
    fails(
        set(&mut w, URL, &format!("{HASH}0"), ok, DEPOSIT),
        "BadWasmHash",
    );
    fails(
        set(&mut w, URL, HASH, (0, 128, 30), DEPOSIT),
        "BadLimit(max_instructions, 0)",
    );
    fails(
        set(&mut w, URL, HASH, (500_000_000_001, 128, 30), DEPOSIT),
        "BadLimit(max_instructions, 500000000001)",
    );
    fails(
        set(&mut w, URL, HASH, (1, 4097, 30), DEPOSIT),
        "BadLimit(max_memory_mb, 4097)",
    );
    fails(
        set(&mut w, URL, HASH, (1, 128, 181), DEPOSIT),
        "BadLimit(max_execution_seconds, 181)",
    );
    fails(set(&mut w, URL, HASH, ok, 0), "BadLimit(deposit, 0)");
    set(&mut w, URL, HASH, (500_000_000_000, 4096, 180), 1).unwrap();
}

#[test]
fn dates_are_owner_only_and_well_formed() {
    let mut w = World::new();
    let fed = w.fed;
    let mut put = |who: &str, event: u64, before: &str, after: &str| {
        let (before, after) = (before.to_string(), after.to_string());
        w.call(who, ONE_YOCTO, move |c| {
            c.set_outlayer_dates(event, before, after)
        })
    };
    fails(
        put(ALICE, fed, "2026-10-27", "2026-10-29"),
        "OwnableUnauthorizedAccount(alice.near)",
    );
    fails(
        put(OWNER, 99, "2026-10-27", "2026-10-29"),
        "UnknownEvent(99)",
    );
    for (before, after) in [
        ("2026-10-29", "2026-10-27"),
        ("2026-10-27", "2026-10-27"),
        ("2026-10-7", "2026-10-29"),
        ("2026/10/27", "2026-10-29"),
        ("2026-10-27", "2026-10-29&id=X"),
    ] {
        fails(put(OWNER, fed, before, after), "BadDates");
    }
    put(OWNER, fed, "2026-10-27", "2026-10-29").unwrap();
    assert_eq!(
        dates(&mut w, fed),
        FomcDates {
            before: "2026-10-27".into(),
            after: "2026-10-29".into(),
            pending: false,
            request: 0,
        }
    );
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    fails(set_dates(&mut w, fed), &format!("AlreadyFinalized({fed})"));
}

#[test]
fn request_sends_outlayer_exactly_its_interface() {
    let mut w = ready();
    let fed = w.fed;
    request(&mut w, BOB, DEPOSIT + 7, fed).unwrap();
    let calls = w.last.calls();
    assert_eq!(calls.len(), 2);

    let run = &calls[0];
    assert_eq!(run.receiver_id, acc(OUTLAYER));
    assert_eq!(run.method, "request_execution");
    assert_eq!(run.deposit, DEPOSIT + 7);
    assert_eq!(run.tgas, 200);
    assert_eq!(
        run.args,
        json!({
            "source": {"WasmUrl": {"url": URL, "hash": HASH, "build_target": "wasm32-wasip2"}},
            "resource_limits": {"max_instructions": 1_000_000_000u64, "max_memory_mb": 128, "max_execution_seconds": 30},
            "input_data": r#"{"after":"2026-10-29","before":"2026-10-27"}"#,
            "response_format": "Json",
            "payer_account_id": BOB,
        })
    );

    let cb = &calls[1];
    assert_eq!(cb.receiver_id, acc(CONTRACT));
    assert_eq!(cb.method, "on_outlayer_result");
    assert_eq!(cb.deposit, 0);
    assert_eq!(cb.tgas, 20);
    assert_eq!(cb.after, vec![0]);
    assert_eq!(
        cb.args,
        json!({"event_id": fed, "request": 1, "payer": BOB, "deposit": (DEPOSIT + 7).to_string()})
    );
    assert_eq!(
        w.last.data_of("outlayer_requested"),
        vec![json!({"event_id": fed, "request": 1, "payer_id": BOB})]
    );
    let d = dates(&mut w, fed);
    assert!(d.pending);
    assert_eq!(d.request, 1);
}

#[test]
fn request_input_comes_only_from_stored_config() {
    let mut w = ready();
    let fed = w.fed;
    w.call(OWNER, ONE_YOCTO, |c| {
        c.set_outlayer_dates(fed, "2025-12-09".into(), "2025-12-11".into())
    })
    .unwrap();
    request(&mut w, ALICE, DEPOSIT, fed).unwrap();
    let args = &w.last.calls()[0].args;
    assert_eq!(
        args["input_data"],
        r#"{"after":"2025-12-11","before":"2025-12-09"}"#
    );
    assert!(args.get("secrets_ref").is_none());
    assert!(args.get("params").is_none());
}

#[test]
fn request_refusals() {
    let mut w = World::new();
    let (spice, fed) = (w.spice, w.fed);
    fails(
        request(&mut w, ALICE, DEPOSIT, fed),
        "OutLayerNotConfigured",
    );
    configure(&mut w);
    fails(
        request(&mut w, ALICE, DEPOSIT, fed),
        &format!("NoOutLayerDates({fed})"),
    );
    set_dates(&mut w, fed).unwrap();
    set_dates(&mut w, spice).unwrap();
    fails(
        request(&mut w, ALICE, DEPOSIT - 1, fed),
        &format!("InsufficientDeposit({DEPOSIT}, {})", DEPOSIT - 1),
    );
    w.prepaid_tgas = 200;
    fails(request(&mut w, ALICE, DEPOSIT, fed), "NotEnoughGas(240)");
    w.prepaid_tgas = 300;

    w.report(fed, OUT_HOLDS).unwrap();
    fails(
        request(&mut w, ALICE, DEPOSIT, fed),
        &format!("ProposalAlreadyOpen({fed})"),
    );
    w.admin_resolve(spice, OUT_SHIPS).unwrap();
    fails(
        request(&mut w, ALICE, DEPOSIT, spice),
        &format!("AlreadyFinalized({spice})"),
    );
    // nothing was left pending by the refusals
    assert!(!dates(&mut w, fed).pending);
}

#[test]
fn one_request_in_flight_per_event() {
    let mut w = ready();
    let (spice, fed) = (w.spice, w.fed);
    set_dates(&mut w, spice).unwrap();
    request(&mut w, ALICE, DEPOSIT, fed).unwrap();
    fails(
        request(&mut w, BOB, DEPOSIT, fed),
        &format!("RequestInFlight({fed})"),
    );
    // another event is independent
    request(&mut w, BOB, DEPOSIT, spice).unwrap();

    assert_eq!(callback(&mut w, fed, 1, answer("null")), None);
    assert!(!dates(&mut w, fed).pending);
    request(&mut w, BOB, DEPOSIT, fed).unwrap();
    let d = dates(&mut w, fed);
    assert!(d.pending);
    assert_eq!(d.request, 2);
}

#[test]
fn request_and_callback_do_not_change_storage() {
    let mut w = ready();
    let fed = w.fed;
    let usage = |w: &mut World| w.view(|_| env::storage_usage());
    let start = usage(&mut w);
    request(&mut w, ALICE, DEPOSIT, fed).unwrap();
    assert_eq!(usage(&mut w), start);
    callback(&mut w, fed, 1, answer("null"));
    assert_eq!(usage(&mut w), start);
}

/// Every result that must not become a proposal: nothing is proposed, the
/// pending flag is cleared and the reason is logged.
#[test]
fn callback_drops_everything_but_a_valid_outcome() {
    let cases: [(PromiseResult, &str); 11] = [
        (answer("null"), "no result"),
        (answer(""), "result is not JSON"),
        (answer("{\"outcome\":1"), "result is not JSON"),
        (answer("\"HOLDS\""), "no outcome"),
        (answer("[1]"), "no outcome"),
        (answer("{}"), "no outcome"),
        (answer(r#"{"outcome":"1"}"#), "no outcome"),
        (answer(r#"{"outcome":-1}"#), "no outcome"),
        (answer(r#"{"outcome":1.0}"#), "no outcome"),
        (
            answer(r#"{"outcome":null,"evidence":"FRED DFEDTARU has no value for 2026-10-29"}"#),
            "FRED DFEDTARU has no value for 2026-10-29",
        ),
        (answer(r#"{"outcome":256}"#), "no outcome"),
    ];
    for (result, note) in cases {
        let mut w = ready();
        let fed = w.fed;
        request(&mut w, ALICE, DEPOSIT, fed).unwrap();
        assert_eq!(callback(&mut w, fed, 1, result), None, "{note}");
        assert_eq!(
            last_result(&w),
            json!({"event_id": fed, "request": 1, "outcome": null, "proposed": false, "note": note})
        );
        assert!(w.last.data_of("outcome_proposed").is_empty());
        assert!(w.last.near_transfers().is_empty());
        assert!(!dates(&mut w, fed).pending);
        assert!(!w.view(|c| c.has_open_proposal(fed)));
    }
}

#[test]
fn callback_drops_an_outcome_the_event_cannot_take() {
    let mut w = ready();
    let fed = w.fed;
    request(&mut w, ALICE, DEPOSIT, fed).unwrap();
    assert_eq!(callback(&mut w, fed, 1, answer(r#"{"outcome":2}"#)), None);
    assert_eq!(last_result(&w)["note"], "InvalidOutcome(2)");
    assert_eq!(last_result(&w)["outcome"], 2);
    assert!(!dates(&mut w, fed).pending);

    // the reporter proposed while the run was in flight
    request(&mut w, ALICE, DEPOSIT, fed).unwrap();
    w.report(fed, OUT_CUTS).unwrap();
    assert_eq!(callback(&mut w, fed, 2, answer(HOLDS_JSON)), None);
    assert_eq!(
        last_result(&w)["note"],
        format!("ProposalAlreadyOpen({fed})")
    );
    assert_eq!(w.view(|c| c.get_event(fed)).proposed_outcome, OUT_CUTS);
    assert!(!dates(&mut w, fed).pending);

    // the owner resolved it while the run was in flight
    let mut w = ready();
    let fed = w.fed;
    request(&mut w, ALICE, DEPOSIT, fed).unwrap();
    w.admin_resolve(fed, OUT_CUTS).unwrap();
    assert_eq!(callback(&mut w, fed, 1, answer(HOLDS_JSON)), None);
    assert_eq!(last_result(&w)["note"], format!("AlreadyFinalized({fed})"));
    assert_eq!(w.view(|c| c.get_event(fed)).outcome, OUT_CUTS);
    assert!(!dates(&mut w, fed).pending);

    // a window so long that the proposal's end overflows
    let mut w = ready();
    let fed = w.fed;
    w.call(OWNER, ONE_YOCTO, |c| c.set_dispute_window(u64::MAX))
        .unwrap();
    request(&mut w, ALICE, DEPOSIT, fed).unwrap();
    assert_eq!(callback(&mut w, fed, 1, answer(HOLDS_JSON)), None);
    assert_eq!(last_result(&w)["note"], "ArithmeticOverflow");
}

#[test]
fn callback_drops_an_oversized_result() {
    let mut w = ready();
    let fed = w.fed;
    request(&mut w, ALICE, DEPOSIT, fed).unwrap();
    let big = format!(r#"{{"outcome":1,"evidence":"{}"}}"#, "x".repeat(5000));
    assert_eq!(callback(&mut w, fed, 1, answer(&big)), None);
    assert_eq!(last_result(&w)["note"], "result too long");
    assert!(!dates(&mut w, fed).pending);
}

/// `request_execution` itself failed (paused, deposit below the estimate):
/// the deposit came back to the contract and goes on to the payer.
#[test]
fn failed_request_refunds_the_payer() {
    let mut w = ready();
    let fed = w.fed;
    request(&mut w, ALICE, DEPOSIT, fed).unwrap();
    assert_eq!(callback(&mut w, fed, 1, PromiseResult::Failed), None);
    assert_eq!(w.last.near_transfers(), vec![(acc(ALICE), DEPOSIT)]);
    assert_eq!(last_result(&w)["note"], "request failed");
    assert!(!dates(&mut w, fed).pending);
    assert!(!w.view(|c| c.has_open_proposal(fed)));
}

#[test]
fn a_stale_result_is_dropped_and_leaves_the_newer_run_pending() {
    let mut w = ready();
    let fed = w.fed;
    request(&mut w, ALICE, DEPOSIT, fed).unwrap();
    // new dates make run 1 stale and free the event for run 3
    set_dates(&mut w, fed).unwrap();
    assert!(!dates(&mut w, fed).pending);
    request(&mut w, BOB, DEPOSIT, fed).unwrap();
    assert_eq!(dates(&mut w, fed).request, 3);

    assert_eq!(callback(&mut w, fed, 1, answer(HOLDS_JSON)), None);
    assert_eq!(last_result(&w)["note"], "stale request");
    assert!(dates(&mut w, fed).pending);
    assert!(!w.view(|c| c.has_open_proposal(fed)));

    // a stale run that failed still refunds its payer
    assert_eq!(callback(&mut w, fed, 1, PromiseResult::Failed), None);
    assert_eq!(w.last.near_transfers(), vec![(acc(ALICE), DEPOSIT)]);
    assert!(dates(&mut w, fed).pending);

    assert_eq!(
        callback(&mut w, fed, 3, answer(HOLDS_JSON)),
        Some(OUT_HOLDS)
    );
    assert!(!dates(&mut w, fed).pending);
}

#[test]
fn callback_for_an_event_without_dates_is_a_no_op() {
    let mut w = ready();
    let spice = w.spice;
    assert_eq!(callback(&mut w, spice, 1, answer(HOLDS_JSON)), None);
    assert_eq!(last_result(&w)["note"], "stale request");
    assert_eq!(w.view(|c| c.get_outlayer_dates(spice)), None);
}

#[test]
fn holds_is_proposed_by_outlayer_then_finalized_after_the_window() {
    let mut w = ready();
    let fed = w.fed;
    request(&mut w, ALICE, DEPOSIT, fed).unwrap();
    assert_eq!(
        callback(&mut w, fed, 1, answer(HOLDS_JSON)),
        Some(OUT_HOLDS)
    );
    assert_eq!(
        w.last.data_of("outcome_proposed"),
        vec![json!({
            "event_id": fed,
            "outcome": OUT_HOLDS,
            "source": "outlayer",
            "finalizable_at_sec": T0 + DISPUTE_WINDOW,
        })]
    );
    assert_eq!(
        last_result(&w),
        json!({
            "event_id": fed,
            "request": 1,
            "outcome": OUT_HOLDS,
            "proposed": true,
            "note": "FRED DFEDTARU 2026-10-27=4.00 2026-10-29=4.00, DFEDTARL 2026-10-27=3.75 2026-10-29=3.75: HOLDS",
        })
    );
    let e = w.view(|c| c.get_event(fed));
    assert!(e.proposal_open);
    assert_eq!(e.proposed_outcome, OUT_HOLDS);
    assert_eq!(e.proposed_by, Some(Source::OutLayer));
    assert!(!dates(&mut w, fed).pending);
    let view = w.view(|c| near_sdk::serde_json::to_value(c.get_event(fed)).unwrap());
    assert_eq!(view["proposed_by"], "outlayer");

    // a second run cannot stack a proposal on the open one
    fails(
        request(&mut w, ALICE, DEPOSIT, fed),
        &format!("ProposalAlreadyOpen({fed})"),
    );

    w.warp(DISPUTE_WINDOW - 1);
    fails(
        w.finalize(BOB, fed),
        &format!("DisputeWindowNotOver({fed}, {})", T0 + DISPUTE_WINDOW),
    );
    w.warp(1);
    w.finalize(BOB, fed).unwrap();
    let e = w.view(|c| c.get_event(fed));
    assert!(e.finalized);
    assert_eq!(e.outcome, OUT_HOLDS);
    assert_eq!(e.proposed_by, Some(Source::OutLayer));
}

#[test]
fn the_owner_can_dispute_an_outlayer_proposal() {
    let mut w = ready();
    let fed = w.fed;
    request(&mut w, ALICE, DEPOSIT, fed).unwrap();
    callback(&mut w, fed, 1, answer(r#"{"outcome":0,"evidence":"x"}"#));
    w.dispute(fed).unwrap();
    let e = w.view(|c| c.get_event(fed));
    assert!(!e.proposal_open);
    assert_eq!(e.proposed_by, Some(Source::OutLayer));
    // and a fresh run may follow
    request(&mut w, ALICE, DEPOSIT, fed).unwrap();
    assert_eq!(
        callback(&mut w, fed, 2, answer(HOLDS_JSON)),
        Some(OUT_HOLDS)
    );
}
