//! The screen snapshots: every view's JSON against the keys and types the
//! app decodes, and the `MultiverseLens.t.sol` scenario and account checks
//! (`userRealWeth` is not a contract field on NEAR: the app reads the
//! token's `ft_balance_of`).

use std::collections::BTreeSet;

use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::serde_json::{self, Value};

use super::amm::*;
use super::harness::*;
use super::lending::*;
use crate::lending::LiquidationState;
use crate::orders::Side;
use crate::types::Asset::{Usdc, Weth};
use crate::views::{AccountView, ScenarioView};

const APP_CONFIG: &[&str] = &[
    "owner_id",
    "reporter_id",
    "weth",
    "usdc",
    "lltv",
    "liquidation_bonus",
    "borrow_rate_per_sec",
    "dispute_window_sec",
    "twap_window_sec",
    "min_pool_depth",
    "order_book",
    "root_lp",
    "demo",
];
const SCENARIO: &[&str] = &[
    "scenario_id",
    "world_count",
    "possible",
    "resolution_count",
    "halted",
    "event_ids",
    "spot_price",
    "worlds",
    "odds_known",
    "implied_spot",
];
const WORLD: &[&str] = &[
    "index",
    "mask",
    "label",
    "possible",
    "pool_initialized",
    "weth_price",
    "backed",
    "weth_token_id",
    "usdc_token_id",
    "user_weth",
    "user_usdc",
    "collateral_weth",
    "collateral_usdc",
    "odds",
    "pool_id",
];
const EVENT: &[&str] = &[
    "id",
    "question",
    "rule",
    "outcome_names",
    "deadline_sec",
    "proposed_at_sec",
    "proposed_outcome",
    "proposal_open",
    "finalized",
    "outcome",
    "finalizable_at_sec",
    "proposed_by",
];
const ORDER: &[&str] = &[
    "id",
    "maker",
    "scenario_id",
    "mask",
    "side",
    "price",
    "amount",
    "remaining",
    "expiry_sec",
    "epoch",
];
const ACCOUNT: &[&str] = &[
    "debt",
    "health_factor",
    "worst_world",
    "collateral_values",
    "world_price_ok",
    "collateral",
    "supplied",
    "supply_principal",
    "market_supply",
    "market_borrow",
    "utilization",
    "borrow_rate_per_sec",
    "supply_rate_per_sec",
    "lltv",
    "liquidation",
    "unpriced_world",
];
const PIECE: &[&str] = &["token_id", "label", "asset", "mask", "is_real", "amount"];

const DEMO: &str = r#"{"glam_event":1,"fed_event":2,"past_fed_event":3,"scenario_2x2":1,"scenario_binary":2,"implied_spot":"3163359000000000000000","odds_ships_bps":6667,"odds_cuts_bps":3000,"odds_source":null,"seeded_at_sec":1790000000,"spot_from":"2x2"}"#;

fn json<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap()
}

fn keys(v: &Value) -> BTreeSet<String> {
    v.as_object().expect("an object").keys().cloned().collect()
}

fn set(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|s| s.to_string()).collect()
}

/// Exactly the keys the app's type declares.
fn assert_keys(v: &Value, expected: &[&str]) {
    assert_eq!(keys(v), set(expected), "{v}");
}

/// The app's keys, plus extras it ignores.
fn assert_has_keys(v: &Value, expected: &[&str]) {
    let have = keys(v);
    for k in expected {
        assert!(have.contains(*k), "missing {k} in {v}");
    }
}

/// A U128: a decimal string.
fn assert_u128(v: &Value) {
    let s = v.as_str().unwrap_or_else(|| panic!("not a string: {v}"));
    assert!(s.parse::<u128>().is_ok(), "not a decimal: {s}");
}

fn u(v: &Value) -> u128 {
    assert_u128(v);
    v.as_str().unwrap().parse().unwrap()
}

fn assert_scenario_json(v: &Value) {
    assert_keys(v, SCENARIO);
    for k in ["spot_price", "implied_spot"] {
        assert_u128(&v[k]);
    }
    for k in ["scenario_id", "world_count", "possible", "resolution_count"] {
        assert!(v[k].is_u64(), "{k}");
    }
    assert!(v["halted"].is_boolean() && v["odds_known"].is_boolean());
    assert!(v["event_ids"].as_array().unwrap().iter().all(Value::is_u64));
    let worlds = v["worlds"].as_array().unwrap();
    assert_eq!(worlds.len() as u64, v["world_count"].as_u64().unwrap());
    for (i, w) in worlds.iter().enumerate() {
        assert_keys(w, WORLD);
        assert_eq!(w["index"].as_u64(), Some(i as u64));
        assert_eq!(w["mask"].as_u64(), Some(1 << i));
        for k in [
            "weth_price",
            "user_weth",
            "user_usdc",
            "collateral_weth",
            "collateral_usdc",
            "odds",
        ] {
            assert_u128(&w[k]);
        }
        for k in ["label", "weth_token_id", "usdc_token_id"] {
            assert!(w[k].is_string(), "{k}");
        }
        assert!(w["pool_id"].is_null() || w["pool_id"].is_u64());
    }
}

fn assert_event_json(v: &Value) {
    assert_keys(v, EVENT);
    for k in [
        "id",
        "deadline_sec",
        "proposed_at_sec",
        "proposed_outcome",
        "outcome",
        "finalizable_at_sec",
    ] {
        assert!(v[k].is_u64(), "{k}");
    }
    assert!(v["outcome_names"]
        .as_array()
        .unwrap()
        .iter()
        .all(Value::is_string));
    let by = &v["proposed_by"];
    assert!(by.is_null() || by == "admin" || by == "reporter", "{by}");
}

fn assert_account_json(v: &Value) {
    assert_keys(v, ACCOUNT);
    for k in [
        "debt",
        "supplied",
        "supply_principal",
        "market_supply",
        "market_borrow",
        "utilization",
        "borrow_rate_per_sec",
        "supply_rate_per_sec",
        "lltv",
    ] {
        assert_u128(&v[k]);
    }
    assert!(v["health_factor"].is_null() || v["health_factor"].is_string());
    assert!(v["worst_world"].is_null() || v["worst_world"].is_u64());
    assert!(v["unpriced_world"].is_null() || v["unpriced_world"].is_u64());
    v["collateral_values"]
        .as_array()
        .unwrap()
        .iter()
        .for_each(assert_u128);
    assert!(v["world_price_ok"]
        .as_array()
        .unwrap()
        .iter()
        .all(Value::is_boolean));
    let status = v["liquidation"].as_str().unwrap();
    assert!(["none", "liquidatable", "paused_halted", "paused_no_price"].contains(&status));
    for p in v["collateral"].as_array().unwrap() {
        assert_keys(p, PIECE);
        assert_u128(&p["amount"]);
        assert!(p["asset"] == "weth" || p["asset"] == "usdc");
        assert!(p["mask"].is_u64() && p["is_real"].is_boolean());
    }
}

fn set_demo(w: &mut World, json: &str) {
    let json = json.to_string();
    w.call(OWNER, ONE_YOCTO, |c| c.set_demo_record(json))
        .unwrap();
}

fn scenario(w: &mut World, sid: u64, who: Option<&str>) -> ScenarioView {
    let who = who.map(acc);
    w.view(|c| c.trade_view(sid, who)).scenario
}

fn account(w: &mut World, sid: u64, who: Option<&str>) -> AccountView {
    let who = who.map(acc);
    w.view(|c| c.borrow_view(sid, who)).account
}

/// A third, already-decided event for the demo record to point at.
fn past_fed(w: &mut World) -> u64 {
    let id = w
        .create_event(FED_QUESTION, &["CUTS", "HOLDS"], FED_RULE, T0 + DAY)
        .unwrap();
    w.admin_resolve(id, OUT_HOLDS).unwrap();
    id
}

// JSON shapes

#[test]
fn app_config_json_shape() {
    let mut w = pool_world();
    let v = json(&w.view(|c| c.get_app_config()));
    assert_has_keys(&v, APP_CONFIG);
    assert!(v["demo"].is_null() && v["spot_pool_id"].is_null());
    assert_eq!(v["order_book"], true);
    assert_eq!(v["root_lp"], crate::rootlp::ENABLED);
    assert_eq!(v["owner_id"], OWNER);
    assert_eq!(v["reporter_id"], REPORTER);
    for (k, token, decimals) in [("weth", WETH_TOKEN, 18), ("usdc", USDC_TOKEN, 6)] {
        assert_eq!(v[k]["token_id"], token);
        assert_eq!(v[k]["decimals"], decimals);
        assert!(v[k]["symbol"].is_string());
    }
    for k in [
        "lltv",
        "liquidation_bonus",
        "borrow_rate_per_sec",
        "min_pool_depth",
    ] {
        assert_u128(&v[k]);
    }
    assert_eq!(v["dispute_window_sec"], DISPUTE_WINDOW);
    assert!(v["twap_window_sec"].is_u64());

    let spot = seed_spot(&mut w, 3000 * E18, DEPTH);
    set_demo(&mut w, DEMO);
    let v = json(&w.view(|c| c.get_app_config()));
    assert_eq!(v["spot_pool_id"], spot);
    let demo = &v["demo"];
    assert_eq!(demo["scenario_2x2"], 1);
    assert_eq!(demo["scenario_binary"], 2);
    assert_eq!(demo["past_fed_event"], 3);
    assert_eq!(demo["implied_spot"], "3163359000000000000000");
    assert!(demo["odds_source"].is_null());
    assert_eq!(demo["spot_from"], "2x2");
}

#[test]
fn trade_view_json_shape() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let s = w.s2x2;
    give_world_tokens(&mut w, BOB, s, 2 * E18, 0);
    let expiry = T0 + DAY;
    let order = w
        .call(BOB, ONE_YOCTO, |c| {
            c.post_order(
                s,
                DELAYED_HOLDS,
                Side::Ask,
                U128(2600 * E18),
                U128(E18),
                expiry,
            )
        })
        .unwrap();
    give_world_tokens(&mut w, ALICE, s, 2 * E18, 0);
    sell(&mut w, ALICE, pools[1], E18);

    let v = json(&w.view(|c| c.trade_view(s, Some(acc(ALICE)))));
    assert_keys(&v, &["scenario", "events", "orders", "impact", "now_sec"]);
    assert_eq!(v["now_sec"], w.now);
    assert_scenario_json(&v["scenario"]);
    let worlds = v["scenario"]["worlds"].as_array().unwrap();
    for (i, world) in worlds.iter().enumerate() {
        assert_eq!(world["pool_id"], pools[i]);
        assert_eq!(world["weth_token_id"], token_id(s, Weth, 1 << i));
        assert_eq!(world["usdc_token_id"], token_id(s, Usdc, 1 << i));
    }
    let events = v["events"].as_array().unwrap();
    assert_eq!(events.len(), 2);
    events.iter().for_each(assert_event_json);
    assert_eq!(events[0]["id"], w.glam);
    assert_eq!(
        events[1]["outcome_names"],
        serde_json::json!(["CUTS", "HOLDS"])
    );

    let orders = v["orders"].as_array().unwrap();
    assert_eq!(orders.len(), 1);
    let o = &orders[0];
    assert_has_keys(o, ORDER);
    // order ids are U64 strings
    assert_eq!(o["id"], order.0.to_string());
    assert_eq!(o["maker"], BOB);
    assert_eq!(o["side"], "ask");
    assert_eq!(o["mask"], DELAYED_HOLDS);
    assert_eq!(o["expiry_sec"], expiry);
    assert_eq!(o["epoch"], 0);
    for k in ["price", "amount", "remaining"] {
        assert_u128(&o[k]);
    }

    let impact = v["impact"].as_array().unwrap();
    assert!(!impact.is_empty());
    for p in impact {
        assert_keys(p, &["at_sec", "prices"]);
        assert!(p["at_sec"].is_u64());
        let prices = p["prices"].as_array().unwrap();
        assert_eq!(prices.len(), 4);
        prices.iter().for_each(assert_u128);
    }

    // another scenario's book stays out; an unknown scenario fails
    let sb = w.s_bin;
    let other = json(&w.view(|c| c.trade_view(sb, None)));
    assert!(other["orders"].as_array().unwrap().is_empty());
    assert_scenario_json(&other["scenario"]);
    assert!(w.try_view(|c| c.trade_view(9, None)).is_err());
}

#[test]
fn borrow_view_json_shape() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s2x2;
    let none = json(&w.view(|c| c.borrow_view(s, None)));
    assert_keys(&none, &["scenario", "account", "now_sec"]);
    assert_scenario_json(&none["scenario"]);
    assert_account_json(&none["account"]);
    assert!(none["account"]["health_factor"].is_null());
    assert_eq!(none["account"]["worst_world"], 0);
    assert_eq!(none["account"]["liquidation"], "none");
    assert_eq!(u(&none["account"]["market_supply"]), 50_000 * E18);

    w.l_shape(ALICE);
    w.post_real(ALICE, s, Weth, E18).unwrap();
    w.borrow(ALICE, s, 3_000 * E18).unwrap();
    let v = json(&w.view(|c| c.borrow_view(s, Some(acc(ALICE)))));
    let a = &v["account"];
    assert_account_json(a);
    assert_u128(&a["health_factor"]);
    let pieces = a["collateral"].as_array().unwrap();
    assert_eq!(pieces.len(), 5);
    assert_eq!(pieces[0]["token_id"], token_id(s, Weth, SHIPS_CUTS));
    assert_eq!(pieces[0]["is_real"], false);
    assert_eq!(pieces[1]["label"], "USDC-if-DELAYED·CUTS");
    let real = &pieces[4];
    assert_eq!(real["token_id"], "weth");
    assert_eq!(real["label"], "WETH");
    assert_eq!(real["mask"], ROOT);
    assert_eq!(real["is_real"], true);
    assert_eq!(u(&real["amount"]), E18);
}

#[test]
fn lend_view_json_shape() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s_bin;
    let v = json(&w.view(|c| c.lend_view(s, Some(acc(BOB)))));
    assert_keys(&v, &["account", "root_lp", "worlds"]);
    assert_account_json(&v["account"]);
    // the Root LP is not wired into this snapshot yet
    assert!(v["root_lp"].is_null());
    let worlds = v["worlds"].as_array().unwrap();
    assert_eq!(worlds.len(), 2);
    for (i, world) in worlds.iter().enumerate() {
        assert_keys(world, &["index", "mask", "label", "possible"]);
        assert_eq!(world["index"], i);
        assert_eq!(world["mask"], 1 << i);
        assert_eq!(world["possible"], true);
    }
    assert_eq!(worlds[0]["label"], "SHIPS");
    assert_eq!(worlds[1]["label"], "DELAYED");

    let s = w.s2x2;
    let v = json(&w.view(|c| c.lend_view(s, Some(acc(BOB)))));
    assert_eq!(u(&v["account"]["supplied"]), 50_000 * E18);
    assert_eq!(u(&v["account"]["supply_principal"]), 50_000 * E18);
    let labels: Vec<&str> = v["worlds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["label"].as_str().unwrap())
        .collect();
    assert_eq!(
        labels,
        ["SHIPS·CUTS", "DELAYED·CUTS", "SHIPS·HOLDS", "DELAYED·HOLDS"]
    );
}

#[test]
fn resolve_view_json_shape_and_past_fed_event() {
    let mut w = pool_world();
    let s = w.s2x2;
    let v = json(&w.view(|c| c.resolve_view(s, None)));
    assert_keys(
        &v,
        &["scenario", "events", "past_fed_event", "account", "now_sec"],
    );
    assert!(v["past_fed_event"].is_null());
    assert_scenario_json(&v["scenario"]);
    assert_account_json(&v["account"]);

    let past = past_fed(&mut w);
    // a record naming an event that does not exist reads as no event
    set_demo(&mut w, r#"{"past_fed_event":99}"#);
    assert!(w.view(|c| c.resolve_view(s, None)).past_fed_event.is_none());
    set_demo(&mut w, &format!(r#"{{"past_fed_event":"{past}"}}"#));
    let v = json(&w.view(|c| c.resolve_view(s, Some(acc(ALICE)))));
    let e = &v["past_fed_event"];
    assert_event_json(e);
    assert_eq!(e["id"], past);
    assert_eq!(e["finalized"], true);
    assert_eq!(e["outcome"], OUT_HOLDS);
    assert_eq!(e["proposed_by"], "admin");

    // an open proposal shows in the events and halts the scenario
    w.report(w.fed, OUT_HOLDS).unwrap();
    let v = json(&w.view(|c| c.resolve_view(s, None)));
    let fed = &v["events"][1];
    assert_eq!(fed["proposal_open"], true);
    assert_eq!(fed["proposed_by"], "reporter");
    assert_eq!(fed["finalizable_at_sec"], w.now + DISPUTE_WINDOW);
    assert_eq!(v["scenario"]["halted"], true);
}

#[test]
fn admin_view_json_shape() {
    let mut w = pool_world();
    let past = past_fed(&mut w);
    set_demo(&mut w, &format!(r#"{{"past_fed_event":{past}}}"#));
    let s = w.s_bin;
    let v = json(&w.view(|c| c.admin_view(s, Some(acc(ALICE)))));
    assert_keys(
        &v,
        &[
            "scenario",
            "events",
            "past_fed_event",
            "owner_id",
            "now_sec",
        ],
    );
    assert_eq!(v["owner_id"], OWNER);
    assert_eq!(v["now_sec"], w.now);
    assert_scenario_json(&v["scenario"]);
    assert_eq!(v["events"].as_array().unwrap().len(), 1);
    assert_event_json(&v["events"][0]);
    assert_eq!(v["past_fed_event"]["id"], past);
}

// MultiverseLens.t.sol

#[test]
fn scenario_view_before_and_after_alice_sale() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let s = w.s2x2;
    let v = scenario(&mut w, s, Some(ALICE));
    assert_eq!((v.world_count, v.possible, v.halted), (4, ROOT, false));
    assert_eq!(v.spot_price.0, 0);
    for (i, world) in v.worlds.iter().enumerate() {
        assert!(world.pool_initialized && world.backed && world.possible);
        assert!(within_rel(world.weth_price.0, DEMO_2X2[i], 1_000_000));
        assert_eq!(world.pool_id, Some(pools[i]));
    }
    assert_eq!(v.worlds[3].label, "DELAYED·HOLDS");

    give_world_tokens(&mut w, ALICE, s, 2 * E18, 0);
    let mut proceeds = [0u128; 4];
    for i in 1..4 {
        proceeds[i] = sell(&mut w, ALICE, pools[i], 2 * E18).0;
    }
    let v = scenario(&mut w, s, Some(ALICE));
    assert_eq!(v.worlds[0].user_weth.0, 2 * E18);
    for i in 1..4 {
        let world = &v.worlds[i];
        assert_eq!(world.user_weth.0, 0);
        assert_eq!(world.user_usdc.0, proceeds[i]);
        assert!(world.weth_price.0 < DEMO_2X2[i]);
        assert!(world.backed);
    }
    // no account, no holdings
    let anon = scenario(&mut w, s, None);
    assert!(anon
        .worlds
        .iter()
        .all(|x| x.user_weth.0 == 0 && x.user_usdc.0 == 0));
}

#[test]
fn account_view_matches_lending() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s2x2;
    w.l_shape(ALICE);
    w.borrow(ALICE, s, 3_000 * E18).unwrap();
    let a = account(&mut w, s, Some(ALICE));
    let (hf, worst) = w.hf(s, ALICE);
    assert_eq!(a.health_factor.map(|h| h.0), hf);
    assert_eq!(a.worst_world, Some(worst));
    assert_eq!(a.debt.0, w.debt(s, ALICE));
    let values: Vec<u128> = a.collateral_values.iter().map(|x| x.0).collect();
    assert_eq!(values, w.values(s, ALICE));
    assert_eq!(a.world_price_ok, [true; 4]);
    assert_eq!(a.collateral.len(), 4);
    assert_eq!(a.collateral[0].label, "WETH-if-SHIPS·CUTS");
    assert_eq!(a.collateral[0].mask, SHIPS_CUTS);
    assert_eq!(a.market_borrow.0, 3_000 * E18);
    assert_eq!(a.liquidation, LiquidationState::None);
    let v = scenario(&mut w, s, Some(ALICE));
    assert_eq!(v.worlds[0].collateral_weth.0, 2 * E18);
    assert_eq!(v.worlds[0].user_weth.0, 0);
    for i in 1..4 {
        assert_eq!(
            v.worlds[i].collateral_usdc.0,
            w.held(s, ALICE, &token_id(s, Usdc, 1 << i))
        );
    }
}

#[test]
fn scenario_view_after_resolution_marks_dead_worlds() {
    let mut w = pool_world();
    seed_demo_2x2(&mut w);
    let s = w.s2x2;
    give_world_tokens(&mut w, ALICE, s, E18, E18);
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    let v = scenario(&mut w, s, Some(ALICE));
    assert_eq!(v.possible, HOLDS);
    assert_eq!(v.resolution_count, 1);
    let possible: Vec<bool> = v.worlds.iter().map(|x| x.possible).collect();
    assert_eq!(possible, [false, false, true, true]);
    assert!(v.worlds.iter().all(|x| x.backed));
    // dead worlds keep their frozen price and zero odds
    assert!(v.worlds[0].weth_price.0 > 0);
    assert!(v.worlds.iter().all(|x| x.odds.0 == 0));
}

#[test]
fn odds_in_the_scenario_view() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let s = w.s2x2;
    let v = scenario(&mut w, s, None);
    assert!(!v.odds_known);
    assert_eq!(v.implied_spot.0, 0);
    assert!(v.worlds.iter().all(|x| x.odds.0 == 0));

    let q = independent_odds(4, 6667, 3000);
    seed_odds(&mut w, s, &q, ODDS_DEPTH);
    let v = scenario(&mut w, s, None);
    let odds = w.view(|c| c.odds(s));
    assert!(v.odds_known && odds.known);
    for (i, world) in v.worlds.iter().enumerate() {
        assert_eq!(world.odds, odds.q[i]);
        assert!(world.odds.0.abs_diff(q[i]) <= 10);
    }
    assert_eq!(v.worlds.iter().map(|x| x.odds.0).sum::<u128>(), E18);
    assert_eq!(v.implied_spot, w.view(|c| c.implied_spot(s)));
    let weighted: u128 = (0..4)
        .map(|i| wmul(v.worlds[i].odds.0, price_of(&mut w, pools[i])))
        .sum();
    assert_eq!(v.implied_spot.0, weighted);

    let spot = seed_spot(&mut w, 3000 * E18, DEPTH);
    let v = scenario(&mut w, s, None);
    assert_eq!(v.spot_price.0, price_of(&mut w, spot));
}

// Liquidation state comes from the lending module's own checks.

#[test]
fn account_view_liquidation_states() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s2x2;
    w.l_shape(ALICE);
    w.borrow(ALICE, s, 3_000 * E18).unwrap();
    let a = account(&mut w, s, Some(ALICE));
    assert_eq!(
        (a.liquidation, a.unpriced_world),
        (LiquidationState::None, None)
    );

    // WETH-if-SHIPS·CUTS loses almost all its value
    set_price(s, 0, 10 * E18);
    let a = account(&mut w, s, Some(ALICE));
    assert!(a.health_factor.unwrap().0 < E18);
    assert_eq!(a.liquidation, LiquidationState::Liquidatable);

    // without a price where WETH collateral pays, liquidation pauses
    set_unpriced(s, 0);
    let a = account(&mut w, s, Some(ALICE));
    assert_eq!(a.world_price_ok, [false, true, true, true]);
    assert_eq!(
        (a.liquidation, a.unpriced_world),
        (LiquidationState::PausedNoPrice, Some(0))
    );
    let status = w.view(|c| c.liquidation_status(s, acc(ALICE)));
    assert_eq!(
        (status.status, status.unpriced_world),
        (a.liquidation, a.unpriced_world)
    );

    // an open proposal pauses it first
    w.report(w.fed, OUT_HOLDS).unwrap();
    let a = account(&mut w, s, Some(ALICE));
    assert_eq!(
        (a.liquidation, a.unpriced_world),
        (LiquidationState::PausedHalted, None)
    );
}
