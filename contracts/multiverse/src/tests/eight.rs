//! Eight worlds (three events) end to end, and the scans that stop growing
//! with every market: the 3-event scenario, its labels, odds and resolution
//! orders, the router at 8 worlds and its fill caps, `LogScope` and the
//! exact-bytes log pins, the per-world supply counters, the per-account index
//! with its four hook paths, `holds_anything` and NEP-245 enumeration, the
//! views, and step 7 of `migrate` on production's state.
//!
//! The shadow checks of EW-1..EW-4 (`check_counters`, `check_index`,
//! `check_holds_anything`) live here and are shared with the random-op
//! runners; EW-5 is the harness's `Replay`.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use multiverse_math::odds;
use near_sdk::borsh::BorshDeserialize;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{env, testing_env, AccountId, NearToken};

use super::amm::{seed_demo_2x2, seed_odds, seed_worlds, singles, DEPTH, ODDS_DEPTH};
use super::harness::*;
use super::lending::{clear_prices, set_price, Lend, USDC_UNIT};
use super::migration::{migrated_prod, prod_account, prod_accounts, Prod, PROD_CONTRACT};
use super::orders::RAVI;
use crate::amm::Pool;
use crate::events::{MultiverseEvent, Split};
use crate::index::{AccountScenario, Footprint, MaskSet};
use crate::ledger::LogScope;
use crate::lending::tiers::TIER_SHIFT;
use crate::lending::MAX_COLLATERAL_PIECES;
use crate::masks;
use crate::orders::Side;
use crate::router::{max_trade_fills, MAX_TRADE_FILLS, MAX_TRADE_FILLS_8W};
use crate::types::Asset::{self, Usdc, Wnear};
use crate::types::{Scenario, VerseKey, WAD};
use crate::views::orders_per_side;
use crate::StorageKey;

pub const THIRD_QUESTION: &str = "Will NEAR close 2026 above 5 USD?";
pub const THIRD_RULE: &str =
    "YES if the NEAR/USD close of 2026-12-31 on Coinbase is above 5.00; otherwise NO.";
pub const OUT_YES: u8 = 0;
pub const OUT_NO: u8 = 1;
/// The worked example's world prices: the demo's 2x2 under YES, 0.95 of it
/// under NO.
pub const PRICES_8: [u128; 8] = [
    3_700 * E15,
    3_000 * E15,
    3_300 * E15,
    2_500 * E15,
    3_515 * E15,
    2_850 * E15,
    3_135 * E15,
    2_375 * E15,
];
const K: u128 = 1_000 * E18;
const SUPPLIED: u128 = 100_000 * E18;

/// The base fixture with a third binary event (YES / NO) and the 3-event
/// scenario `[spice, fed, third]`: world = spice + 2·fed + 4·third. The
/// owner, Carol and Ravi are funded too.
pub fn eight_bare() -> (World, u64, u64) {
    let mut w = World::new();
    w.fund(OWNER);
    w.fund(CAROL);
    w.register(RAVI, NearToken::from_near(1));
    w.fund(RAVI);
    let third = w
        .create_event(THIRD_QUESTION, &["YES", "NO"], THIRD_RULE, T0 + 50 * DAY)
        .unwrap();
    let (spice, fed) = (w.spice, w.fed);
    let s = w.create_scenario(&[spice, fed, third]).unwrap();
    (w, s, third)
}

/// The worked example's odds: P(YES) 0.5, P(CUTS | C) 0.01, P(SHIPS | B, C)
/// 0.6667, each split `floor(parent · share)` and `parent − that`.
pub fn worked_odds() -> Vec<u128> {
    let pairs = odds::pairs(8);
    odds::odds(8, 0xFF, |x, y| {
        let level = pairs.iter().position(|p| *p == (x, y)).unwrap();
        Some(match level {
            0 => WAD / 2,
            1 | 2 => WAD / 100,
            _ => 666_700_000_000_000_000,
        })
    })
    .unwrap()
}

pub struct Eight {
    pub w: World,
    pub s: u64,
    pub third: u64,
    pub world_pools: Vec<u64>,
    pub odds_pools: Vec<u64>,
}

/// `eight_bare` with the worked example's market: the 8 world pools
/// 100,000 wNEAR deep at `PRICES_8`, the 7 odds pools 1,000,000 deep at
/// `worked_odds()`, Bob lending 100,000 USDC, a TWAP window behind.
pub fn eight_market() -> Eight {
    clear_prices();
    let (mut w, s, third) = eight_bare();
    let world_pools = seed_worlds(&mut w, s, &PRICES_8, &[DEPTH; 8]);
    let odds_pools = seed_odds(&mut w, s, &worked_odds(), ODDS_DEPTH);
    w.lend(BOB, s, SUPPLIED).unwrap();
    w.warp(61);
    Eight {
        w,
        s,
        third,
        world_pools,
        odds_pools,
    }
}

type Plans = Vec<Vec<(u64, u128)>>;

fn plans_json(plans: &Plans) -> Value {
    plans
        .iter()
        .map(|fills| {
            fills
                .iter()
                .map(|(id, amount)| json!({"order_id": id.to_string(), "amount": amount.to_string()}))
                .collect::<Vec<_>>()
        })
        .collect()
}

fn amounts(v: &Value) -> Vec<u128> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|a| a.as_str().unwrap().parse().unwrap())
        .collect()
}

/// `conditional_sell` (or with `borrow`, `sell_and_borrow`) by wNEAR
/// `ft_transfer_call`; returns the proceeds per world.
#[allow(clippy::too_many_arguments)]
fn sell(
    w: &mut World,
    who: &str,
    s: u64,
    amount: u128,
    mask: u8,
    plans: &Plans,
    to_lending: bool,
    borrow: Option<u128>,
) -> Result<Vec<u128>, String> {
    let n = plans.len();
    let msg = match borrow {
        None => json!({
            "action": "conditional_sell", "scenario_id": s, "sell_mask": mask,
            "plans": plans_json(plans), "min_out": vec!["0"; n], "to_lending": to_lending,
        }),
        Some(b) => json!({
            "action": "sell_and_borrow", "scenario_id": s, "sell_mask": mask,
            "plans": plans_json(plans), "min_out": vec!["0"; n], "borrow_amount": b.to_string(),
        }),
    };
    let unused = w.ft_transfer_call(who, Wnear, amount, &msg.to_string())?;
    assert_eq!(unused, 0);
    Ok(amounts(&w.last.data_of("conditional_sale")[0]["proceeds"]))
}

/// `conditional_buy` by USDC `ft_transfer_call` (whole micro-USDC).
fn buy(
    w: &mut World,
    who: &str,
    s: u64,
    usdc: u128,
    mask: u8,
    plans: &Plans,
    to_lending: bool,
) -> Result<Vec<u128>, String> {
    let n = plans.len();
    let msg = json!({
        "action": "conditional_buy", "scenario_id": s, "buy_mask": mask,
        "plans": plans_json(plans), "min_out": vec!["0"; n], "to_lending": to_lending,
    });
    let unused = w.ft_transfer_call(who, Usdc, usdc / USDC_UNIT, &msg.to_string())?;
    assert_eq!(unused, 0);
    Ok(amounts(&w.last.data_of("conditional_buy")[0]["bought"]))
}

/// A bid posted from real USDC (`post_order` action), escrow rounded up to
/// whole micro-USDC. Returns the order id.
fn post_bid(w: &mut World, who: &str, s: u64, mask: u8, price: u128, amount: u128) -> u64 {
    let escrow = multiverse_math::orders::cost(amount, price);
    let msg = json!({
        "action": "post_order", "scenario_id": s, "mask": mask, "side": Side::Bid,
        "price": price.to_string(), "amount": amount.to_string(), "expiry_sec": w.now + 30 * DAY,
    });
    let unused = w
        .ft_transfer_call(who, Usdc, escrow.div_ceil(USDC_UNIT), &msg.to_string())
        .unwrap();
    assert_eq!(unused, 0);
    w.last.data_of("order_posted")[0]["order_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap()
}

/// A registered, funded account with a 64-character id, the longest NEAR
/// allows.
fn long_account(w: &mut World, n: u64) -> String {
    let id = format!("{:064x}", 0xE1_0000 + n);
    w.register(&id, NearToken::from_near(1));
    w.fund(&id);
    id
}

// ---- Shadow checks shared with the random-op runners (EW-1..EW-4) ----

/// The keys of the map stored under `prefix`, decoded.
fn raw_keys<K: BorshDeserialize>(s: &Storage, prefix: &[u8]) -> Vec<K> {
    s.keys()
        .filter(|k| k.len() > prefix.len() && k.starts_with(prefix))
        .map(|k| K::try_from_slice(&k[prefix.len()..]).expect("stored key decodes"))
        .collect()
}

/// EW-1 and EW-2 from the raw maps: every per-world counter is the sum of
/// the supplies covering the world (no entry when all are zero), and every
/// scenario's created set is exactly its created keys.
pub fn check_counters(w: &mut World) -> Result<(), String> {
    w.with_raw(|s| {
        let scenarios: BTreeMap<u64, Scenario> = raw_entries(s, &prefix(StorageKey::Scenarios))
            .into_iter()
            .collect();
        let mut expected: BTreeMap<(u64, Asset), Vec<u128>> = BTreeMap::new();
        for (key, supply) in raw_entries::<VerseKey, u128>(s, &prefix(StorageKey::Supply)) {
            let n = scenarios[&key.scenario].world_count;
            let counts = expected
                .entry((key.scenario, key.asset))
                .or_insert_with(|| vec![0; usize::from(n)]);
            for (wi, c) in (0u8..).zip(counts.iter_mut()) {
                if masks::contains(key.mask, wi) {
                    *c = c.wrapping_add(supply);
                }
            }
        }
        expected.retain(|_, v| v.iter().any(|c| *c != 0));
        let actual: BTreeMap<(u64, Asset), Vec<u128>> =
            raw_entries(s, &prefix(StorageKey::WorldSupply))
                .into_iter()
                .collect();
        if expected != actual {
            return Err(format!(
                "EW-1: world_supply {actual:?} != recomputed {expected:?}"
            ));
        }
        let mut created: BTreeMap<u64, MaskSet> = BTreeMap::new();
        for key in raw_keys::<VerseKey>(s, &prefix(StorageKey::Created)) {
            created
                .entry(key.scenario)
                .or_default()
                .set(key.asset, key.mask, true);
        }
        let actual: BTreeMap<u64, MaskSet> = raw_entries(s, &prefix(StorageKey::CreatedMasks))
            .into_iter()
            .collect();
        if created != actual {
            return Err("EW-2: created_masks differ from the created set".to_string());
        }
        Ok(())
    })
}

/// EW-3 from the raw maps: for every account but the contract and every
/// scenario after `legacy_scenario_count`, the index record exists exactly
/// when the account holds something there, each field equals its
/// recomputed value, and the footprint lists exactly those scenarios,
/// ascending.
pub fn check_index(w: &mut World) -> Result<(), String> {
    let legacy = w.view(|c| c.legacy_scenario_count);
    let contract = acc(CONTRACT);
    w.with_raw(|s| {
        let pools: BTreeMap<u64, Pool> = raw_entries(s, &prefix(StorageKey::Pools))
            .into_iter()
            .collect();
        let mut expected: BTreeMap<(AccountId, u64), AccountScenario> = BTreeMap::new();
        let indexed = |a: &AccountId, sid: u64| sid != 0 && sid > legacy && *a != contract;
        for ((a, key), amount) in
            raw_entries::<(AccountId, VerseKey), u128>(s, &prefix(StorageKey::Balances))
        {
            assert!(amount > 0, "a stored zero balance");
            if indexed(&a, key.scenario) {
                let r = expected.entry((a, key.scenario)).or_default();
                r.verse.set(key.asset, key.mask, true);
            }
        }
        for (pool, a) in raw_keys::<(u64, AccountId)>(s, &prefix(StorageKey::Positions)) {
            let sid = pools[&pool].scenario_id;
            if indexed(&a, sid) {
                expected.entry((a, sid)).or_default().pool_positions += 1;
            }
        }
        for map in [
            StorageKey::SupplyShares,
            StorageKey::BorrowShares,
            StorageKey::Collateral,
        ] {
            for (market, a) in raw_keys::<(u64, AccountId)>(s, &prefix(map)) {
                let sid = market & ((1 << TIER_SHIFT) - 1);
                if indexed(&a, sid) {
                    expected.entry((a, sid)).or_default().lending_entries += 1;
                }
            }
        }
        for (sid, a) in raw_keys::<(u64, AccountId)>(s, &prefix(StorageKey::LpShares)) {
            if indexed(&a, sid) {
                expected.entry((a, sid)).or_default().lp_shares = true;
            }
        }
        let actual: BTreeMap<(AccountId, u64), AccountScenario> =
            raw_entries(s, &prefix(StorageKey::AccountScenarios))
                .into_iter()
                .collect();
        if expected != actual {
            let diff: Vec<_> = expected
                .keys()
                .chain(actual.keys())
                .filter(|k| expected.get(*k) != actual.get(*k))
                .take(3)
                .map(|k| (k.clone(), expected.get(k).cloned(), actual.get(k).cloned()))
                .collect();
            return Err(format!("EW-3: index (recomputed, stored) {diff:?}"));
        }
        let mut footprints: BTreeMap<AccountId, Footprint> = BTreeMap::new();
        for (a, sid) in expected.keys() {
            footprints
                .entry(a.clone())
                .or_default()
                .scenarios
                .push(*sid);
        }
        let actual: BTreeMap<AccountId, Footprint> =
            raw_entries(s, &prefix(StorageKey::Footprints))
                .into_iter()
                .collect();
        if footprints != actual {
            return Err(format!("EW-3: footprints {actual:?} != {footprints:?}"));
        }
        Ok(())
    })
}

/// The accounts that hold anything in a scenario or pool by the full scan of
/// every map (v1's definition, extended to the three tiers; a supply
/// principal counts in legacy scenarios, as v1 counted it).
fn scanned_holders(s: &Storage, legacy: u64) -> HashSet<AccountId> {
    let mut out: HashSet<AccountId> = HashSet::new();
    for (a, _) in raw_keys::<(AccountId, VerseKey)>(s, &prefix(StorageKey::Balances)) {
        out.insert(a);
    }
    for map in [
        StorageKey::Positions,
        StorageKey::SupplyShares,
        StorageKey::BorrowShares,
        StorageKey::Collateral,
        StorageKey::LpShares,
    ] {
        for (_, a) in raw_keys::<(u64, AccountId)>(s, &prefix(map)) {
            out.insert(a);
        }
    }
    for (market, a) in raw_keys::<(u64, AccountId)>(s, &prefix(StorageKey::SupplyPrincipal)) {
        if market & ((1 << TIER_SHIFT) - 1) <= legacy {
            out.insert(a);
        }
    }
    out
}

/// EW-4: for every registered account, `holds_anything` (index, legacy scan
/// and O(1) terms) equals the full-scan definition.
pub fn check_holds_anything(w: &mut World) -> Result<(), String> {
    let legacy = w.view(|c| c.legacy_scenario_count);
    let (accounts, scanned) = w.with_raw(|s| {
        (
            raw_keys::<AccountId>(s, &prefix(StorageKey::Storage)),
            scanned_holders(s, legacy),
        )
    });
    for a in accounts {
        let (fast, other) = w.view(|c| {
            let real = Asset::ALL
                .into_iter()
                .any(|x| c.real_balance(&a, x) >= c.asset_cfg(x).min_payable());
            (
                c.holds_anything(&a),
                real || c.has_open_orders(&a) || c.catalog.account_busy(&a),
            )
        });
        let full = other || scanned.contains(&a);
        if fast != full {
            return Err(format!(
                "EW-4: holds_anything({a}) = {fast}, the full scan says {full}"
            ));
        }
    }
    Ok(())
}

/// EW-1..EW-4 together.
pub fn check_eight_worlds(w: &mut World) -> Result<(), String> {
    check_counters(w)?;
    check_index(w)?;
    check_holds_anything(w)
}

// ---- Worst-case log bytes ----

const WIDEST_ACCOUNT: usize = 64;

/// A number field at its widest value.
fn widest_number(key: &str) -> Value {
    let widest: u64 = match key {
        "scenario_id" | "pool_id" | "event_id" | "order_id" | "expiry_sec" => u64::MAX,
        "mask" | "from_mask" | "to_mask" | "to_masks" | "from_masks" | "sell_mask" | "buy_mask"
        | "mask0" | "mask1" | "possible" | "removed" => 255,
        "world" | "worst_world" | "worst" | "unpriced_world" => 7,
        "epoch" => 3,
        "outcome" => 1,
        "world_count" => 8,
        "pieces" | "fee_pips" => u64::from(u32::MAX),
        other => panic!("classify the number field `{other}` for the log pins"),
    };
    Value::from(widest)
}

/// A string field at its widest value: account ids at 64 characters, token
/// ids at `{u64::MAX}:{asset}:255`, u64 ids at 20 digits, amounts at 39.
fn widest_string(s: &str, key: &str, index: Option<usize>, accounts: &BTreeSet<String>) -> String {
    if accounts.contains(s) {
        return "a".repeat(WIDEST_ACCOUNT);
    }
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() == 3 && Asset::parse(parts[1]).is_some() && parts[0].parse::<u64>().is_ok() {
        return format!("{}:{}:255", u64::MAX, parts[1]);
    }
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
        let id = key == "order_id" || (key == "fills" && index == Some(0));
        return if id {
            u64::MAX.to_string()
        } else {
            u128::MAX.to_string()
        };
    }
    s.to_string()
}

fn widen(v: &Value, key: &str, index: Option<usize>, accounts: &BTreeSet<String>) -> Value {
    match v {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, x)| (k.clone(), widen(x, k, None, accounts)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(i, x)| widen(x, key, Some(i), accounts))
                .collect(),
        ),
        Value::Number(_) => widest_number(key),
        Value::String(s) => Value::String(widest_string(s, key, index, accounts)),
        other => other.clone(),
    }
}

/// The call's log lines and their bytes with every field at its widest value
/// (the lines and items are the call's own, so this is the exact worst case
/// of what it logged). `accounts` are the ids widened to 64 characters; the
/// contract's own id always is. A field nobody classified fails the test.
pub fn widest_bytes(logs: &[String], accounts: &[&str]) -> (usize, usize) {
    let mut ids: BTreeSet<String> = accounts.iter().map(|a| a.to_string()).collect();
    ids.insert(CONTRACT.to_string());
    let bytes = logs
        .iter()
        .map(|l| match l.strip_prefix("EVENT_JSON:") {
            Some(json) => {
                let v: Value = near_sdk::serde_json::from_str(json).unwrap();
                "EVENT_JSON:".len() + widen(&v, "", None, &ids).to_string().len()
            }
            None => l.len(),
        })
        .sum();
    (logs.len(), bytes)
}

/// Asserts the receipt limits on the worst case and pins it.
#[track_caller]
fn pin_logs(w: &World, accounts: &[&str], limit: usize, golden: usize, what: &str) {
    let (lines, bytes) = widest_bytes(&w.last.logs, accounts);
    let actual: usize = w.last.logs.iter().map(String::len).sum();
    println!("{what}: {lines} lines, {actual} bytes as run, {bytes} bytes at the widest values");
    for l in &w.last.logs {
        let (_, line) = widest_bytes(std::slice::from_ref(l), accounts);
        let event = l
            .split("\"event\":\"")
            .nth(1)
            .and_then(|r| r.split('"').next());
        println!(
            "  {}: {line} bytes at the widest values",
            event.unwrap_or("?")
        );
    }
    assert!(lines <= 100, "{what}: {lines} lines");
    assert!(bytes <= limit, "{what}: {bytes} > {limit} bytes");
    assert_eq!(
        bytes, golden,
        "{what}: the worst case changed; review it, then update the pin"
    );
}

// ---- The scenario, labels, odds ----

#[test]
fn a_three_event_scenario_has_eight_worlds() {
    let (mut w, s, third) = eight_bare();
    let info = w.view(|c| c.get_scenario(s));
    assert_eq!(info.event_ids, vec![w.spice, w.fed, third]);
    assert_eq!(
        (info.world_count, info.root, info.possible),
        (8, 0xFF, 0xFF)
    );
    let (spice, fed) = (w.spice, w.fed);
    let with = |w: &mut World, e: u64, o: u8| w.view(|c| c.worlds_with(s, e, o));
    assert_eq!(with(&mut w, spice, OUT_SHIPS), 0x55);
    assert_eq!(with(&mut w, spice, OUT_DELAYED), 0xAA);
    assert_eq!(with(&mut w, fed, OUT_CUTS), 0x33);
    assert_eq!(with(&mut w, fed, OUT_HOLDS), 0xCC);
    assert_eq!(with(&mut w, third, OUT_YES), 0x0F);
    assert_eq!(with(&mut w, third, OUT_NO), 0xF0);
    // a fourth event is one too many
    let fourth = w
        .create_event("A fourth question?", &["A", "B"], "A rule.", T0 + DAY)
        .unwrap();
    fails(
        w.create_scenario(&[spice, fed, third, fourth]),
        "BadEventCount(4)",
    );
    // the app config says so
    let cfg = w.view(|c| c.get_app_config());
    assert_eq!(
        (
            cfg.max_worlds,
            cfg.max_events,
            cfg.max_trade_fills,
            cfg.max_trade_fills_8w
        ),
        (8, 3, 20, 16)
    );
}

/// The 26 named masks of an 8-world scenario (8 single worlds, 6 one-event
/// and 12 two-event cylinders), `ANY` for root, bits for the other 228.
#[test]
fn eight_world_labels() {
    let (mut w, s, _) = eight_bare();
    let named: [(u8, &str); 26] = [
        (0x01, "SHIPS·CUTS·YES"),
        (0x02, "DELAYED·CUTS·YES"),
        (0x04, "SHIPS·HOLDS·YES"),
        (0x08, "DELAYED·HOLDS·YES"),
        (0x10, "SHIPS·CUTS·NO"),
        (0x20, "DELAYED·CUTS·NO"),
        (0x40, "SHIPS·HOLDS·NO"),
        (0x80, "DELAYED·HOLDS·NO"),
        (0x55, "SHIPS"),
        (0xAA, "DELAYED"),
        (0x33, "CUTS"),
        (0xCC, "HOLDS"),
        (0x0F, "YES"),
        (0xF0, "NO"),
        (0x11, "SHIPS·CUTS"),
        (0x44, "SHIPS·HOLDS"),
        (0x22, "DELAYED·CUTS"),
        (0x88, "DELAYED·HOLDS"),
        (0x05, "SHIPS·YES"),
        (0x50, "SHIPS·NO"),
        (0x0A, "DELAYED·YES"),
        (0xA0, "DELAYED·NO"),
        (0x03, "CUTS·YES"),
        (0x30, "CUTS·NO"),
        (0x0C, "HOLDS·YES"),
        (0xC0, "HOLDS·NO"),
    ];
    let labels: Vec<String> = w.view(|c| (1..=255u8).map(|m| c.verse_label(s, m)).collect());
    for m in 1..=255u8 {
        let label = &labels[usize::from(m) - 1];
        match named.iter().find(|(n, _)| *n == m) {
            Some((_, name)) => assert_eq!(label, name, "mask {m:#04x}"),
            None if m == 0xFF => assert_eq!(label, "ANY"),
            None => assert_eq!(label, &format!("0b{m:08b}"), "mask {m:#04x}"),
        }
    }
    let distinct: BTreeSet<&String> = labels.iter().collect();
    assert_eq!(distinct.len(), 255, "every label is unique");
    // token names follow
    let names = w.view(|c| c.mt_metadata_base_by_token_id(vec![token_id(s, Wnear, 0x05)]));
    assert_eq!(names[0].name, "wNEAR-if-SHIPS·YES");
}

/// v1's labels of the 2x2 (every mask) and the binary scenario, unchanged.
#[test]
fn v1_labels_are_unchanged() {
    let mut w = World::new();
    let (s, sb) = (w.s2x2, w.s_bin);
    let golden = [
        "SHIPS·CUTS",
        "DELAYED·CUTS",
        "CUTS",
        "SHIPS·HOLDS",
        "SHIPS",
        "0b0110",
        "0b0111",
        "DELAYED·HOLDS",
        "0b1001",
        "DELAYED",
        "0b1011",
        "HOLDS",
        "0b1101",
        "0b1110",
        "ANY",
    ];
    let labels: Vec<String> = w.view(|c| (1..=15u8).map(|m| c.verse_label(s, m)).collect());
    assert_eq!(labels, golden);
    let bin: Vec<String> = w.view(|c| (1..=3u8).map(|m| c.verse_label(sb, m)).collect());
    assert_eq!(bin, ["SHIPS", "DELAYED", "ANY"]);
}

/// The worked example through the contract: odds read from the seeded odds
/// pools within pool rounding of the configured ones and summing to exactly
/// 1e18, and the implied spot 2.96175097.
#[test]
fn worked_example_odds_and_implied_spot() {
    let mut e = eight_market();
    let q = worked_odds();
    assert_eq!(
        q,
        [
            3_333_500_000_000_000,
            1_666_500_000_000_000,
            330_016_500_000_000_000,
            164_983_500_000_000_000,
            3_333_500_000_000_000,
            1_666_500_000_000_000,
            330_016_500_000_000_000,
            164_983_500_000_000_000
        ]
    );
    let s = e.s;
    let view = e.w.view(|c| c.trade_view(s, None)).scenario;
    assert!(view.odds_known);
    let read: Vec<u128> = view.worlds.iter().map(|x| x.odds.0).collect();
    assert_eq!(read.iter().sum::<u128>(), WAD);
    for (wi, (r, x)) in read.iter().zip(&q).enumerate() {
        assert!(r.abs_diff(*x) <= 1_000, "world {wi}: {r} vs {x}");
    }
    // 2.96175097 within 1e-9
    let implied = view.implied_spot.0;
    let reference = 2_961_750_967_500_000_000u128;
    assert!(
        implied.abs_diff(reference) * 1_000_000_000 <= reference,
        "{implied}"
    );
    assert!(view.worlds.iter().all(|x| x.backed && x.pool_initialized));
    assert_eq!(view.worlds.len(), 8);
}

/// Odds after each event resolves first: the tree still prices the
/// survivors with the pools it already has, and asks only for the pairs of
/// the design's table.
#[test]
fn resolution_orders_read_the_expected_pools() {
    // (event resolved first, its outcome, the worlds left, the pairs read)
    type Case = (usize, u8, u8, Vec<(u8, u8)>);
    let cases: [Case; 3] = [
        (
            2,
            OUT_YES,
            0x0F,
            vec![(0x03, 0x0C), (0x01, 0x02), (0x04, 0x08)],
        ),
        (
            1,
            OUT_CUTS,
            0x33,
            vec![(0x0F, 0xF0), (0x01, 0x02), (0x10, 0x20)],
        ),
        (
            0,
            OUT_SHIPS,
            0x55,
            vec![(0x0F, 0xF0), (0x03, 0x0C), (0x30, 0xC0)],
        ),
    ];
    for (k, outcome, possible, read) in cases {
        let mut e = eight_market();
        let (s, events) = (e.s, [e.w.spice, e.w.fed, e.third]);
        e.w.admin_resolve(events[k], outcome).unwrap();
        assert_eq!(e.w.possible(s), possible);
        let (view, asked, expected) = e.w.view(|c| {
            let view = c.trade_view(s, None).scenario;
            let mut asked = Vec::new();
            let expected = odds::odds(8, possible, |x, y| {
                asked.push((x, y));
                let id = c.between.get(&(s, x, y)).copied()?;
                let (r0, r1) = c.pool(id).amm.reserves();
                odds::share_x(r0, r1)
            })
            .unwrap();
            (view, asked, expected)
        });
        assert_eq!(asked, read, "event {k} resolved first");
        let got: Vec<u128> = view.worlds.iter().map(|x| x.odds.0).collect();
        assert_eq!(got, expected);
        assert_eq!(got.iter().sum::<u128>(), WAD);
        for (wi, q) in got.iter().enumerate() {
            assert_eq!(*q == 0, possible & (1 << wi) == 0, "world {wi}");
        }
        // then the other two, in order: down to one world, which needs no pool
        for j in (0..3).filter(|j| *j != k) {
            e.w.admin_resolve(events[j], 1).unwrap();
        }
        let view = e.w.view(|c| c.trade_view(s, None)).scenario;
        let one = view.worlds.iter().filter(|x| x.odds.0 == WAD).count();
        assert_eq!(one, 1);
        assert!(view.odds_known);
    }
}

// ---- The router at 8 worlds ----

#[test]
fn sale_buy_and_sell_and_borrow_at_eight_worlds() {
    let mut e = eight_market();
    let s = e.s;
    let none: Plans = vec![Vec::new(); 8];
    // a sale in the NO worlds keeps the wNEAR in the YES worlds
    let out = sell(&mut e.w, ALICE, s, 1_000 * E18, 0xF0, &none, false, None).unwrap();
    for (wi, proceeds) in out.iter().enumerate() {
        let single = 1u8 << wi;
        if wi < 4 {
            assert_eq!(*proceeds, 0);
            assert_eq!(e.w.bal(ALICE, s, Wnear, single), 1_000 * E18);
        } else {
            assert!(*proceeds > 2_000 * E18, "world {wi}: {proceeds}");
            assert_eq!(e.w.bal(ALICE, s, Usdc, single), *proceeds);
            assert_eq!(e.w.bal(ALICE, s, Wnear, single), 0);
        }
    }
    e.w.assert_conservation(&[OWNER, ALICE, BOB, CAROL, RAVI]);
    // a buy in the YES worlds
    let got = buy(&mut e.w, BOB, s, 3_000 * E18, 0x0F, &none, false).unwrap();
    assert_eq!(got.len(), 8);
    for (wi, bought) in got.iter().enumerate() {
        assert_eq!(*bought > 0, wi < 4);
    }
    // a sale of every world into lending and a loan on it: 8 USDC-if-w pieces
    let out = sell(
        &mut e.w,
        CAROL,
        s,
        1_000 * E18,
        ROOT_8,
        &none,
        true,
        Some(1_000 * E18),
    )
    .unwrap();
    let pieces = e.w.pieces(s, CAROL);
    assert_eq!(pieces.len(), 8);
    for (wi, (piece, amount)) in pieces.iter().enumerate() {
        assert_eq!(piece, &token_id(s, Usdc, 1 << wi));
        assert_eq!(*amount, out[wi]);
    }
    assert!(e.w.debt(s, CAROL) >= 1_000 * E18);
    e.w.assert_conservation(&[OWNER, ALICE, BOB, CAROL, RAVI]);
    check_eight_worlds(&mut e.w).unwrap();
}

/// `to_lending` with a split mask: USDC-if-w where sold, wNEAR-if-w where
/// kept, one piece per world.
#[test]
fn to_lending_posts_eight_pieces() {
    let mut e = eight_market();
    let s = e.s;
    let none: Plans = vec![Vec::new(); 8];
    let out = sell(&mut e.w, ALICE, s, 500 * E18, 0x55, &none, true, None).unwrap();
    let pieces = e.w.pieces(s, ALICE);
    assert_eq!(pieces.len(), 8);
    for wi in 0..8u8 {
        let (asset, amount) = if 0x55 & (1 << wi) != 0 {
            (Usdc, out[usize::from(wi)])
        } else {
            (Wnear, 500 * E18)
        };
        assert_eq!(e.w.held(s, ALICE, &token_id(s, asset, 1 << wi)), amount);
    }
    // the pieces are in lending, not in the ledger
    for wi in 0..8u8 {
        assert_eq!(e.w.bal(ALICE, s, Wnear, 1 << wi), 0);
        assert_eq!(e.w.bal(ALICE, s, Usdc, 1 << wi), 0);
    }
    e.w.assert_conservation(&[OWNER, ALICE, BOB, CAROL, RAVI]);
}

/// A plan of `fills` fills spread over the worlds of `world_count`, all on
/// order 1 (the cap is checked before any order is read).
fn bogus_plan(world_count: usize, fills: usize) -> Plans {
    let mut plans: Plans = vec![Vec::new(); world_count];
    for i in 0..fills {
        plans[i % world_count].push((1, E18));
    }
    plans
}

/// Runs a direct `conditional_sell` of 1 wNEAR from Alice's internal balance
/// in a throwaway receipt and returns `(error, gas used, reserves before and
/// after the attempt)`: the receipt's panic is caught inside it, so what the
/// call did before failing is visible.
fn attempt_sale(w: &mut World, s: u64, mask: u8, plans: Plans) -> (String, u64, u128, u128) {
    w.deposit(ALICE, Wnear, E18).unwrap();
    let n = plans.len();
    w.exec(ALICE, ONE_YOCTO, vec![], move |c| {
        let reserves = c.reserve(s, Wnear);
        let plans: Vec<Vec<crate::router::PlanFill>> = plans
            .iter()
            .map(|fills| {
                fills
                    .iter()
                    .map(|(id, a)| crate::router::PlanFill {
                        order_id: U64(*id),
                        amount: U128(*a),
                    })
                    .collect()
            })
            .collect();
        let before = env::used_gas().as_gas();
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.conditional_sell(s, U128(E18), mask, plans, vec![U128(0); n], false, None)
        }));
        let gas = env::used_gas().as_gas() - before;
        let err = panic_message(r.expect_err("the sale must fail"));
        (err, gas, reserves, c.reserve(s, Wnear))
    })
    .unwrap()
}

#[test]
fn too_many_fills_fails_before_any_work() {
    let (mut w, s, _) = eight_bare();
    assert_eq!((MAX_TRADE_FILLS, MAX_TRADE_FILLS_8W), (20, 16));
    assert_eq!(max_trade_fills(8), MAX_TRADE_FILLS_8W);
    assert_eq!(max_trade_fills(4), MAX_TRADE_FILLS);
    assert_eq!(max_trade_fills(2), MAX_TRADE_FILLS);
    // 17 at 8 worlds: refused before the split (reserves untouched, a
    // fraction of the work); 16 pass the cap and fail on the order instead
    let (err, gas, before, after) = attempt_sale(&mut w, s, ROOT_8, bogus_plan(8, 17));
    assert_eq!(err, "TooManyFills(17, 16)");
    assert_eq!(before, after);
    let (err, split_gas, before, after) = attempt_sale(&mut w, s, ROOT_8, bogus_plan(8, 16));
    assert_eq!(err, "PlanOrderMismatch(0, 1)");
    assert_eq!(after, before + E18, "this one split first");
    assert!(gas * 2 < split_gas, "{gas} vs {split_gas}");
    assert!(gas < 5_000_000_000_000, "{gas} gas");
    // 21 at 4 worlds, 20 pass
    let s4 = w.s2x2;
    let (err, _, before, after) = attempt_sale(&mut w, s4, ROOT, bogus_plan(4, 21));
    assert_eq!(err, "TooManyFills(21, 20)");
    assert_eq!(before, after);
    let (err, _, _, _) = attempt_sale(&mut w, s4, ROOT, bogus_plan(4, 20));
    assert_eq!(err, "PlanOrderMismatch(0, 1)");
    // the check order: ZeroAmount, UnknownScenario, BadSellMask,
    // LengthMismatch, then TooManyFills
    let many = bogus_plan(8, 30);
    let fail_with = |w: &mut World, sid: u64, amount: u128, mask: u8, plans: Plans, n: usize| {
        w.call(ALICE, ONE_YOCTO, |c| {
            let plans = plans
                .iter()
                .map(|f| {
                    f.iter()
                        .map(|(id, a)| crate::router::PlanFill {
                            order_id: U64(*id),
                            amount: U128(*a),
                        })
                        .collect()
                })
                .collect();
            c.conditional_sell(
                sid,
                U128(amount),
                mask,
                plans,
                vec![U128(0); n],
                false,
                None,
            )
        })
    };
    fails(
        fail_with(&mut w, s, 0, ROOT_8, many.clone(), 8),
        "ZeroAmount",
    );
    fails(
        fail_with(&mut w, 99, E18, ROOT_8, many.clone(), 8),
        "UnknownScenario(99)",
    );
    fails(
        fail_with(&mut w, s, E18, 0, many.clone(), 8),
        "BadSellMask(0)",
    );
    fails(
        fail_with(&mut w, s, E18, ROOT_8, many.clone(), 7),
        "LengthMismatch",
    );
    fails(
        fail_with(&mut w, s, E18, ROOT_8, many, 8),
        "TooManyFills(30, 16)",
    );
}

// ---- LogScope ----

fn scope_env() {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc(CONTRACT))
        .build());
}

fn split_event(account: &AccountId, amount: u128) -> Split<'_> {
    Split {
        account_id: account,
        scenario_id: 1,
        asset: Wnear,
        from_mask: 15,
        to_masks: &[1, 14],
        amount: U128(amount),
    }
}

/// Inner scopes join the outer one; only the outer writes, once, when it
/// ends; one held item writes the same bytes as an unscoped emit.
#[test]
fn nested_scopes_join_and_the_first_one_writes() {
    scope_env();
    let alice = acc(ALICE);
    split_event(&alice, 1).emit();
    let unscoped = get_logs();
    assert_eq!(unscoped.len(), 1);

    scope_env();
    {
        let _outer = LogScope::open();
        {
            let _inner = LogScope::open();
            assert!(LogScope::is_open());
            split_event(&alice, 1).emit();
        }
        // the inner scope ended: nothing written yet
        assert!(get_logs().is_empty());
        assert!(LogScope::is_open());
    }
    assert!(!LogScope::is_open());
    assert_eq!(get_logs(), unscoped, "one item, the same bytes");

    // two items of one name: one line, both in data, in order
    scope_env();
    {
        let _scope = LogScope::open();
        split_event(&alice, 1).emit();
        split_event(&alice, 2).emit();
    }
    let logs = get_logs();
    assert_eq!(logs.len(), 1);
    let v: Value =
        near_sdk::serde_json::from_str(logs[0].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert_eq!(v["data"][0]["amount"], "1");
    assert_eq!(v["data"][1]["amount"], "2");
}

/// A scope dropped while unwinding writes nothing and leaves no scope open.
#[test]
fn a_panic_inside_a_scope_writes_nothing() {
    scope_env();
    let alice = acc(ALICE);
    let r = quietly(|| {
        std::panic::catch_unwind(|| {
            let _scope = LogScope::open();
            split_event(&alice, 1).emit();
            panic!("the call fails");
        })
    });
    assert!(r.is_err());
    assert!(!LogScope::is_open());
    assert!(get_logs().is_empty());
}

/// Lines in a fixed order: mints, transfers (every account -> contract
/// entry, then every contract -> account entry), burns, then one line per
/// held name in first-emission order; a memo transfer bypasses the scope.
#[test]
fn scope_lines_come_in_a_fixed_order() {
    let mut w = World::new();
    let s = w.s2x2;
    w.split_ft(ALICE, s, Wnear, &SINGLES, 10 * E18).unwrap();
    let (alice, bob) = (acc(ALICE), acc(BOB));
    w.call(ALICE, NO_DEPOSIT, |c| {
        let _scope = LogScope::open();
        let k = |m: u8| VerseKey::new(s, Wnear, m);
        c.transfer_verse(&alice, &bob, &[(k(SHIPS_CUTS), 3)], None);
        c.mint(&bob, &[(k(SHIPS_CUTS), 5)], None);
        c.burn(&alice, &[(k(DELAYED_CUTS), 1)], None);
        split_event(&alice, 7).emit();
        c.transfer_verse(&bob, &alice, &[(k(SHIPS_CUTS), 1)], None);
        // a memo transfer is written at once, outside the scope's lines
        c.transfer_verse(&alice, &bob, &[(k(SHIPS_HOLDS), 2)], Some("m"));
        split_event(&alice, 8).emit();
    })
    .unwrap();
    let names = w.last.event_names();
    let short: Vec<&str> = names.iter().map(|(_, e)| e.as_str()).collect();
    assert_eq!(
        short,
        ["mt_transfer", "mt_mint", "mt_transfer", "mt_burn", "split"]
    );
    let events = w.last.events();
    assert_eq!(events[0]["data"][0]["memo"], "m");
    // alice: -3 +1 = -2 (an out); bob: +3 -1 = +2 (an in)
    let t = &events[2]["data"];
    assert_eq!(t.as_array().unwrap().len(), 2);
    assert_eq!(
        (t[0]["old_owner_id"].as_str(), t[0]["new_owner_id"].as_str()),
        (Some(ALICE), Some(CONTRACT))
    );
    assert_eq!(t[0]["amounts"], json!(["2"]));
    assert_eq!(
        (t[1]["old_owner_id"].as_str(), t[1]["new_owner_id"].as_str()),
        (Some(CONTRACT), Some(BOB))
    );
    assert_eq!(t[1]["amounts"], json!(["2"]));
    assert_eq!(events[1]["data"][0]["owner_id"], BOB);
    assert_eq!(events[3]["data"][0]["owner_id"], ALICE);
    assert_eq!(w.last.data_of("split").len(), 2);
}

/// A direct `fill_order` keeps v1's `order_filled` line; inside a trade the
/// fills are one `orders_filled` item per (scenario, taker).
#[test]
fn direct_fills_keep_order_filled() {
    let mut e = eight_market();
    let s = e.s;
    let id = post_bid(&mut e.w, RAVI, s, 0x01, 3_000 * E15, K);
    e.w.split_ft(CAROL, s, Wnear, &SINGLES_8, K).unwrap();
    super::orders::fill(&mut e.w, CAROL, id, E18, 0).unwrap();
    assert_eq!(e.w.last.data_of("order_filled").len(), 1);
    assert!(e.w.last.data_of("orders_filled").is_empty());
    let mut plans: Plans = vec![Vec::new(); 8];
    plans[0].push((id, 2 * E18));
    sell(&mut e.w, ALICE, s, 10 * E18, 0x01, &plans, false, None).unwrap();
    assert!(e.w.last.data_of("order_filled").is_empty());
    assert_eq!(
        e.w.last.data_of("orders_filled"),
        vec![json!({
            "scenario_id": s, "taker": ALICE,
            "fills": [[id.to_string(), (2 * E18).to_string(), (6 * E18).to_string(), (K - 3 * E18).to_string()]],
        })]
    );
}

// ---- Exact-bytes log pins ----

/// Bids from `makers`, `per_world[w]` of them in world `w` at an odd price,
/// each taken by one unit first so the trade's fill closes it and hands the
/// rounding dust back. Returns the plan (every bid but that unit).
fn dusty_bids(w: &mut World, s: u64, makers: &[String], per_world: &[usize]) -> Plans {
    let price = 2_000 * E15 - 1;
    let mut plans: Plans = vec![Vec::new(); per_world.len()];
    let mut next = makers.iter();
    for (wi, n) in per_world.iter().enumerate() {
        for _ in 0..*n {
            let maker = next.next().unwrap();
            let id = post_bid(w, maker, s, 1 << wi, price, K);
            plans[wi].push((id, K - 1));
        }
    }
    let worlds = per_world.len();
    w.split_ft(CAROL, s, Wnear, &singles(worlds), K).unwrap();
    for fills in &plans {
        for &(id, _) in fills {
            super::orders::fill(w, CAROL, id, 1, 0).unwrap();
        }
    }
    plans
}

/// The heaviest trade at 8 worlds with `fills` fills: every world sold,
/// `fills` bids from as many makers each closed with dust for its maker, the
/// rest through the pools, all into lending, interest pending (an `accrue`
/// line) and a loan on top. Returns the world, the accounts to widen and the
/// fill count.
fn heaviest_eight_world_trade(fills: usize) -> (World, Vec<String>) {
    let mut e = eight_market();
    let s = e.s;
    let makers: Vec<String> = (0..fills as u64)
        .map(|i| long_account(&mut e.w, i))
        .collect();
    let taker = long_account(&mut e.w, 99);
    let mut per_world = [0usize; 8];
    for i in 0..fills {
        per_world[i % 8] += 1;
    }
    let plans = dusty_bids(&mut e.w, s, &makers, &per_world);
    // a loan already open, a day of interest pending
    e.w.post_real(CAROL, s, Wnear, 1_000 * E18).unwrap();
    e.w.borrow(CAROL, s, 100 * E18).unwrap();
    e.w.warp(DAY);
    sell(
        &mut e.w,
        &taker,
        s,
        4 * K,
        ROOT_8,
        &plans,
        true,
        Some(1_000 * E18),
    )
    .unwrap();
    let filled = e.w.last.data_of("orders_filled");
    assert_eq!(filled[0]["fills"].as_array().unwrap().len(), fills);
    assert_eq!(e.w.last.data_of("accrue").len(), 1);
    assert_eq!(e.w.last.data_of("swap").len(), 8);
    let mut ids = makers;
    ids.push(taker);
    (e.w, ids)
}

/// Each fill from its own maker costs 492 bytes at the widest values at 8
/// worlds (its tuple in `orders_filled` and its maker's `mt_transfer`
/// entry), so 18 fills (16,606 bytes) would break the 16,384-byte receipt
/// limit even in the Normal tier; 16 leave more than 500 bytes in the Bold
/// tier.
#[test]
fn eight_world_trade_bytes_per_fill() {
    let bytes: Vec<usize> = [14, 15, 16]
        .into_iter()
        .map(|fills| {
            let (w, ids) = heaviest_eight_world_trade(fills);
            let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
            let (lines, bytes) = widest_bytes(&w.last.logs, &ids);
            println!("8 worlds, {fills} fills: {lines} lines, {bytes} bytes at the widest values");
            assert_eq!(lines, 9);
            bytes
        })
        .collect();
    let per_fill = bytes[2] - bytes[1];
    assert_eq!(per_fill, 492);
    assert_eq!(bytes[1] - bytes[0], per_fill);
    assert_eq!(bytes[2] + 2 * per_fill, 16_606, "18 fills");
    assert!(
        bytes[2] + 2 * per_fill > 16_384,
        "18 fills would not fit a receipt"
    );
    assert!(bytes[2] + LEND_FIELDS_8W_TRADE <= 16_384 - 500);
    // the contract refuses the 17th fill before any work
    let (mut w, s, _) = eight_bare();
    let (err, ..) = attempt_sale(&mut w, s, ROOT_8, bogus_plan(8, MAX_TRADE_FILLS_8W + 1));
    assert_eq!(err, "TooManyFills(17, 16)");
}

/// What the Bold tier adds to the heaviest trade at the widest values
/// (SPEC-C 3.10): `,"tier":"bold"` (14 bytes) on each collateral item, on
/// `borrow` and on `accrue` (the Normal tier logs no `tier`). The
/// `accrue` line's `,"to_insurance":"<39 digits>"` (57 bytes) is in the
/// measured bytes. The pins hold with them.
const LEND_FIELDS_8W_TRADE: usize = 8 * 14 + 14 + 14;
const LEND_FIELDS_4W_TRADE: usize = 4 * 14 + 14 + 14;

/// The heaviest trade at 8 worlds, at the cap: 9 lines, 15,622 bytes at the
/// widest values (15,762 in the Bold tier), within the 15,872-byte pin.
#[test]
fn log_pin_eight_world_sell_and_borrow_at_the_cap() {
    let (w, ids) = heaviest_eight_world_trade(MAX_TRADE_FILLS_8W);
    let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
    pin_logs(
        &w,
        &ids,
        15_872 - LEND_FIELDS_8W_TRADE,
        15_622,
        "8-world sell_and_borrow, 16 fills",
    );
}

/// v1's heaviest trade (4 worlds × 5 fills) with 64-character ids.
#[test]
fn log_pin_four_world_trade_20_fills() {
    clear_prices();
    let mut w = World::new();
    w.fund(OWNER);
    w.fund(CAROL);
    let s = w.s2x2;
    seed_demo_2x2(&mut w);
    w.lend(BOB, s, SUPPLIED).unwrap();
    w.warp(61);
    let makers: Vec<String> = (0..20).map(|i| long_account(&mut w, i)).collect();
    let taker = long_account(&mut w, 99);
    let plans = dusty_bids(&mut w, s, &makers, &[5, 5, 5, 5]);
    // interest pending, so the trade logs an `accrue` line too
    w.post_real(CAROL, s, Wnear, 1_000 * E18).unwrap();
    w.borrow(CAROL, s, 100 * E18).unwrap();
    w.warp(DAY);
    sell(
        &mut w,
        &taker,
        s,
        6 * K,
        ROOT,
        &plans,
        true,
        Some(1_000 * E18),
    )
    .unwrap();
    assert_eq!(w.last.data_of("accrue").len(), 1);
    let mut ids: Vec<&str> = makers.iter().map(String::as_str).collect();
    ids.push(&taker);
    pin_logs(
        &w,
        &ids,
        16_384 - 500 - LEND_FIELDS_4W_TRADE,
        14_694,
        "4-world sell_and_borrow, 20 fills",
    );
}

/// A Root LP join at 8 worlds with fees to collect in every pool.
#[test]
fn log_pin_root_lp_join_eight_worlds() {
    let mut e = eight_market();
    let s = e.s;
    let first = long_account(&mut e.w, 1);
    let joiner = long_account(&mut e.w, 2);
    let deposit = |w: &mut World, who: &str| {
        w.deposit(who, Wnear, 10 * K).unwrap();
        let msg = json!({"action": "lp_deposit", "scenario_id": s,
            "wnear_amount": (10 * K).to_string(), "min_shares": "0"});
        w.ft_transfer_call(who, Usdc, (40 * K) / USDC_UNIT, &msg.to_string())
            .unwrap();
    };
    deposit(&mut e.w, &first);
    // fees in every world pool
    let none: Plans = vec![Vec::new(); 8];
    sell(&mut e.w, ALICE, s, 100 * E18, ROOT_8, &none, false, None).unwrap();
    deposit(&mut e.w, &joiner);
    assert_eq!(e.w.last.data_of("lp_deposit").len(), 1);
    assert!(!e.w.last.data_of("lp_fees_collected").is_empty());
    pin_logs(
        &e.w,
        &[&first, &joiner],
        16_384,
        10_340,
        "8-world Root LP join",
    );
}

/// A borrower at 8 worlds with `MAX_COLLATERAL_PIECES` pieces and a loan,
/// on test prices (no pools): the single-world tokens of both assets, the two
/// real assets, then two-world tokens, as many as the cap takes (26 to choose
/// from, so a cap of 20 fits too). Returns the borrower.
fn many_piece_loan(w: &mut World, s: u64) -> String {
    const PAIRS: [u8; 4] = [0x03, 0x0C, 0x30, 0xC0];
    for (wi, p) in PRICES_8.iter().enumerate() {
        set_price(s, wi as u8, *p);
    }
    let who = long_account(w, 7);
    // (asset, Some(mask)) a verse piece, (asset, None) the real asset
    let mut candidates: Vec<(Asset, Option<u8>)> = Vec::new();
    for asset in [Wnear, Usdc] {
        candidates.extend(SINGLES_8.iter().map(|m| (asset, Some(*m))));
    }
    candidates.push((Wnear, None));
    candidates.push((Usdc, None));
    for asset in [Wnear, Usdc] {
        candidates.extend(PAIRS.iter().map(|m| (asset, Some(*m))));
    }
    assert!(candidates.len() >= 20);
    let chosen = &candidates[..MAX_COLLATERAL_PIECES];
    for asset in [Wnear, Usdc] {
        w.split_ft(&who, s, asset, &SINGLES_8, 100 * E18).unwrap();
        let pairs = chosen
            .iter()
            .any(|(a, m)| *a == asset && m.is_some_and(|m| m.count_ones() == 2));
        if pairs {
            w.split_ft(&who, s, asset, &PAIRS, 100 * E18).unwrap();
        }
    }
    for (asset, mask) in chosen {
        match mask {
            Some(m) => w.post(&who, s, &token_id(s, *asset, *m), 100 * E18),
            None => w.post_real(&who, s, *asset, 100 * E18),
        }
        .unwrap();
    }
    assert_eq!(w.pieces(s, &who).len(), MAX_COLLATERAL_PIECES);
    w.lend(BOB, s, SUPPLIED).unwrap();
    let lowest = w.lowest(s, &who);
    let borrow = lowest * 74 / 100;
    w.borrow(&who, s, borrow).unwrap();
    who
}

/// A tokens-mode liquidation seizing a slice of every one of
/// `MAX_COLLATERAL_PIECES` pieces at 8 worlds.
#[test]
fn log_pin_liquidation_of_every_piece() {
    clear_prices();
    let (mut w, s, _) = eight_bare();
    let who = many_piece_loan(&mut w, s);
    // every wNEAR price 10% lower: the loan is liquidatable; a day of
    // interest pending, so the call accrues too
    for (wi, p) in PRICES_8.iter().enumerate() {
        set_price(s, wi as u8, p * 9 / 10);
    }
    w.warp(DAY);
    let liquidator = long_account(&mut w, 8);
    let l = w.liquidate(&liquidator, s, &who, None).unwrap();
    assert_eq!(l.pieces.len(), MAX_COLLATERAL_PIECES);
    assert!(l.seized.iter().all(|x| *x > 0));
    pin_logs(
        &w,
        &[&who, &liquidator],
        16_384,
        3_906,
        "liquidation, every piece",
    );
    clear_prices();
}

/// `close_after_resolution` with `MAX_COLLATERAL_PIECES` pieces: the debt
/// repaid, every piece back, the collapsed ones redeemed and paid out.
#[test]
fn log_pin_close_after_resolution_with_every_piece() {
    clear_prices();
    let (mut w, s, third) = eight_bare();
    let who = many_piece_loan(&mut w, s);
    let (spice, fed) = (w.spice, w.fed);
    for (e, o) in [(spice, OUT_DELAYED), (fed, OUT_HOLDS), (third, OUT_NO)] {
        w.admin_resolve(e, o).unwrap();
    }
    assert_eq!(w.possible(s), 0x80);
    let debt = w.debt(s, &who);
    let msg = json!({"action": "close_after_resolution", "scenario_id": s}).to_string();
    w.ft_transfer_call(&who, Usdc, (debt + USDC_UNIT).div_ceil(USDC_UNIT), &msg)
        .unwrap();
    let closed = &w.last.data_of("closed")[0];
    assert_eq!(closed["pieces"], MAX_COLLATERAL_PIECES as u64);
    assert!(w.pieces(s, &who).is_empty());
    pin_logs(
        &w,
        &[&who],
        16_384,
        7_198,
        "close_after_resolution, every piece",
    );
    clear_prices();
}

// ---- Counters, index and scans ----

/// `world_supply` equals the per-world supplies of `backing`, before and
/// after trades and a resolution.
#[test]
fn world_supply_equals_backing() {
    let mut e = eight_market();
    let s = e.s;
    let none: Plans = vec![Vec::new(); 8];
    sell(&mut e.w, ALICE, s, 700 * E18, 0x3C, &none, true, None).unwrap();
    for step in 0..2 {
        let (ws, b) = e.w.view(|c| (c.world_supply(s), c.backing(s)));
        assert_eq!((ws.scenario_id, ws.possible), (s, b.possible));
        assert_eq!(
            (ws.wnear_reserves, ws.usdc_reserves),
            (b.wnear_reserves, b.usdc_reserves)
        );
        assert_eq!(ws.wnear.len(), 8);
        for (i, x) in b.worlds.iter().enumerate() {
            assert_eq!(ws.wnear[i], x.wnear_supply);
            assert_eq!(ws.usdc[i], x.usdc_supply);
            if x.possible {
                assert_eq!(ws.wnear[i], ws.wnear_reserves);
            }
        }
        if step == 0 {
            e.w.admin_resolve(e.third, OUT_NO).unwrap();
        }
    }
    check_eight_worlds(&mut e.w).unwrap();
}

fn record(w: &mut World, who: &str, s: u64) -> Option<AccountScenario> {
    let a = acc(who);
    w.view(|c| c.account_scenarios.get(&(a.clone(), s)).cloned())
}

fn footprint(w: &mut World, who: &str) -> Vec<u64> {
    let a = acc(who);
    w.view(|c| c.indexed_scenarios(&a))
}

fn holds(w: &mut World, who: &str) -> bool {
    let a = acc(who);
    w.view(|c| c.holds_anything(&a))
}

fn unregister(w: &mut World, who: &str) -> Result<bool, String> {
    w.call(who, ONE_YOCTO, |c| c.storage_unregister(None))
}

/// Verse balances: the record and the footprint appear with the first
/// token and go with the last one.
#[test]
fn index_follows_verse_balances() {
    let (mut w, s, _) = eight_bare();
    let s2 = w.s2x2;
    assert_eq!(record(&mut w, ALICE, s), None);
    w.split_ft(ALICE, s, Wnear, &[0x0F, 0xF0], E18).unwrap();
    let r = record(&mut w, ALICE, s).unwrap();
    assert!(r.verse.contains(Wnear, 0x0F) && r.verse.contains(Wnear, 0xF0));
    assert_eq!(
        r.verse.iter().collect::<Vec<_>>(),
        [(Wnear, 0x0F), (Wnear, 0xF0)]
    );
    w.split_ft(ALICE, s2, Usdc, &SINGLES, E18).unwrap();
    assert_eq!(footprint(&mut w, ALICE), vec![s2, s]);
    // a transfer creates the receiver's record (paid by the sender)
    w.mt_transfer(ALICE, BOB, &token_id(s, Wnear, 0x0F), 1)
        .unwrap();
    assert!(record(&mut w, BOB, s).unwrap().verse.contains(Wnear, 0x0F));
    w.mt_transfer(BOB, ALICE, &token_id(s, Wnear, 0x0F), 1)
        .unwrap();
    assert_eq!(record(&mut w, BOB, s), None);
    assert!(footprint(&mut w, BOB).is_empty());
    // merging back removes the record; the other scenario stays
    w.merge(ALICE, s, Wnear, &[0x0F, 0xF0], ROOT_8, E18)
        .unwrap();
    assert_eq!(record(&mut w, ALICE, s), None);
    assert_eq!(footprint(&mut w, ALICE), vec![s2]);
    // the contract's custody is never indexed
    let c = acc(CONTRACT);
    assert!(w.view(|x| x.footprints.get(&c).is_none()));
    check_eight_worlds(&mut w).unwrap();
}

/// Pool positions: the opener's position counts, an add counts, removing
/// all of it drops it.
#[test]
fn index_follows_pool_positions() {
    let mut e = eight_market();
    let s = e.s;
    // the opener's position in each of the 8 world pools and 7 odds pools
    assert_eq!((e.world_pools.len(), e.odds_pools.len()), (8, 7));
    assert_eq!(record(&mut e.w, OWNER, s).unwrap().pool_positions, 15);
    let pool = e.world_pools[3];
    e.w.split_ft(CAROL, s, Wnear, &SINGLES_8, 10 * E18).unwrap();
    e.w.split_ft(CAROL, s, Usdc, &SINGLES_8, 100 * E18).unwrap();
    let r =
        e.w.call(CAROL, ONE_YOCTO, |c| {
            c.add_liquidity(pool, U128(10 * E18), U128(100 * E18), U128(0))
        })
        .unwrap();
    assert_eq!(record(&mut e.w, CAROL, s).unwrap().pool_positions, 1);
    e.w.call(CAROL, ONE_YOCTO, |c| {
        c.remove_liquidity(pool, r.liquidity, U128(0), U128(0))
    })
    .unwrap();
    let after = record(&mut e.w, CAROL, s).unwrap();
    assert_eq!(after.pool_positions, 0);
    assert!(!after.verse.is_empty(), "the tokens came back");
    check_eight_worlds(&mut e.w).unwrap();
}

/// Root LP shares: a deposit marks them, withdrawing every share clears it.
#[test]
fn index_follows_root_lp_shares() {
    let mut e = eight_market();
    let s = e.s;
    e.w.deposit(CAROL, Wnear, 10 * K).unwrap();
    let msg = json!({"action": "lp_deposit", "scenario_id": s,
        "wnear_amount": (10 * K).to_string(), "min_shares": "0"});
    e.w.ft_transfer_call(CAROL, Usdc, (40 * K) / USDC_UNIT, &msg.to_string())
        .unwrap();
    assert!(record(&mut e.w, CAROL, s).unwrap().lp_shares);
    let carol = acc(CAROL);
    let shares = e.w.view(|c| c.root_lp_shares_of(s, carol.clone()).balance);
    e.w.call(CAROL, ONE_YOCTO, |c| {
        c.lp_withdraw(s, shares, vec![U128(0); 8], vec![U128(0); 8])
    })
    .unwrap();
    assert!(!record(&mut e.w, CAROL, s).is_some_and(|r| r.lp_shares));
    check_eight_worlds(&mut e.w).unwrap();
}

/// Lending entries: supply, collateral and debt each count once and go when
/// they go.
#[test]
fn index_follows_lending_entries() {
    clear_prices();
    let (mut w, s, _) = eight_bare();
    for (wi, p) in PRICES_8.iter().enumerate() {
        set_price(s, wi as u8, *p);
    }
    let entries = |w: &mut World, who: &str| record(w, who, s).map_or(0, |r| r.lending_entries);
    w.lend(BOB, s, SUPPLIED).unwrap();
    assert_eq!(entries(&mut w, BOB), 1);
    w.post_real(CAROL, s, Wnear, 1_000 * E18).unwrap();
    assert_eq!(entries(&mut w, CAROL), 1);
    w.borrow(CAROL, s, 100 * E18).unwrap();
    assert_eq!(entries(&mut w, CAROL), 2);
    let debt = w.debt(s, CAROL);
    w.repay_ft(CAROL, s, debt + USDC_UNIT, true).unwrap();
    assert_eq!(entries(&mut w, CAROL), 1);
    w.unpost(CAROL, s, "wnear", 1_000 * E18).unwrap();
    assert_eq!(record(&mut w, CAROL, s), None);
    w.withdraw_lent(BOB, s, None).unwrap();
    assert_eq!(entries(&mut w, BOB), 0);
    check_eight_worlds(&mut w).unwrap();
    clear_prices();
}

/// Hands every verse token `who` holds to Alice.
fn give_away_tokens(w: &mut World, who: &str) {
    let a = acc(who);
    let tokens: Vec<(String, u128)> = w.view(|c| {
        c.mt_tokens_for_owner(a.clone(), None, None)
            .into_iter()
            .map(|t| {
                let k = VerseKey::parse(&t.token_id).unwrap();
                (t.token_id, c.verse_balance(&a, &k))
            })
            .collect()
    });
    if !tokens.is_empty() {
        let (ids, amounts): (Vec<String>, Vec<u128>) = tokens.into_iter().unzip();
        w.mt_batch_transfer(who, ALICE, &ids, &amounts).unwrap();
    }
}

/// Pays out every whole token unit of `who`'s real balances; what is left is
/// dust below one unit, which no payout can send.
fn withdraw_real(w: &mut World, who: &str) {
    let a = acc(who);
    for asset in Asset::ALL {
        let (real, unit) =
            w.view(|c| (c.real_balance(&a, asset), c.asset_cfg(asset).min_payable()));
        let whole = real - real % unit;
        if whole > 0 {
            w.withdraw(who, asset, whole).unwrap();
        }
    }
}

/// Each kind of holding alone blocks `storage_unregister`; once it is gone
/// the account can leave.
#[test]
fn unregister_is_blocked_by_each_kind_and_allowed_once_empty() {
    let mut e = eight_market();
    let s = e.s;
    let who = "dora.near";
    e.w.register(who, NearToken::from_near(1));
    e.w.fund(who);
    let blocked = |w: &mut World, kind: &str| {
        assert!(holds(w, who), "{kind}");
        fails(unregister(w, who), &format!("AccountNotEmpty({who})"));
        check_holds_anything(w).unwrap();
    };
    let free = |w: &mut World, kind: &str| {
        give_away_tokens(w, who);
        assert!(!holds(w, who), "after {kind}");
    };
    free(&mut e.w, "registering");
    // a verse balance
    e.w.split_ft(who, s, Wnear, &[0x01, 0xFE], E18).unwrap();
    blocked(&mut e.w, "a verse balance");
    free(&mut e.w, "a verse balance");
    // a pool position, alone
    let pool = e.world_pools[0];
    e.w.split_ft(who, s, Wnear, &[0x01, 0xFE], 10 * E18)
        .unwrap();
    e.w.split_ft(who, s, Usdc, &[0x01, 0xFE], 100 * E18)
        .unwrap();
    let r =
        e.w.call(who, ONE_YOCTO, |c| {
            c.add_liquidity(pool, U128(10 * E18), U128(100 * E18), U128(0))
        })
        .unwrap();
    give_away_tokens(&mut e.w, who);
    blocked(&mut e.w, "a pool position");
    e.w.call(who, ONE_YOCTO, |c| {
        c.remove_liquidity(pool, r.liquidity, U128(0), U128(0))
    })
    .unwrap();
    free(&mut e.w, "a pool position");
    // collateral, alone
    e.w.split_ft(who, s, Usdc, &[0x01, 0xFE], 10 * E18).unwrap();
    let piece = token_id(s, Usdc, 0x01);
    e.w.post(who, s, &piece, 10 * E18).unwrap();
    give_away_tokens(&mut e.w, who);
    blocked(&mut e.w, "collateral");
    e.w.unpost(who, s, &piece, 10 * E18).unwrap();
    free(&mut e.w, "collateral");
    // supply
    e.w.lend(who, s, 10 * E18).unwrap();
    blocked(&mut e.w, "supply");
    e.w.withdraw_lent(who, s, None).unwrap();
    free(&mut e.w, "supply");
    // Root LP shares, alone
    e.w.deposit(who, Wnear, K).unwrap();
    let msg = json!({"action": "lp_deposit", "scenario_id": s,
        "wnear_amount": K.to_string(), "min_shares": "0"});
    e.w.ft_transfer_call(who, Usdc, (4 * K) / USDC_UNIT, &msg.to_string())
        .unwrap();
    withdraw_real(&mut e.w, who);
    give_away_tokens(&mut e.w, who);
    blocked(&mut e.w, "Root LP shares");
    let dora = acc(who);
    let shares = e.w.view(|c| c.root_lp_shares_of(s, dora.clone()).balance);
    e.w.call(who, ONE_YOCTO, |c| {
        c.lp_withdraw(s, shares, vec![U128(0); 8], vec![U128(0); 8])
    })
    .unwrap();
    withdraw_real(&mut e.w, who);
    free(&mut e.w, "Root LP shares");
    // an open order
    let id = post_bid(&mut e.w, who, s, 0x01, 2 * E18, E18);
    give_away_tokens(&mut e.w, who);
    blocked(&mut e.w, "an open order");
    super::orders::cancel(&mut e.w, who, id).unwrap();
    free(&mut e.w, "an open order");
    // a real balance of a token unit or more
    e.w.deposit(who, Wnear, E18).unwrap();
    blocked(&mut e.w, "a real balance");
    e.w.withdraw(who, Wnear, E18).unwrap();
    free(&mut e.w, "a real balance");
    assert_eq!(unregister(&mut e.w, who), Ok(true));
    check_eight_worlds(&mut e.w).unwrap();
}

/// A spot-pool position belongs to no scenario, so `holds_anything` checks
/// it directly, also on a deployment made with `new` (no legacy scan).
#[test]
fn a_spot_position_blocks_unregister() {
    let mut w = World::new();
    w.fund(OWNER);
    super::amm::seed_spot(&mut w, 3 * E18, 1_000 * E18);
    let owner = acc(OWNER);
    let spot = w.view(|c| c.spot_pool.unwrap());
    assert!(w.view(|c| c.positions.contains_key(&(spot, owner.clone()))));
    // nothing else: no real balance, no order, no scenario
    let (real, orders, indexed) = w.view(|c| {
        (
            Asset::ALL
                .into_iter()
                .any(|x| c.real_balance(&owner, x) >= c.asset_cfg(x).min_payable()),
            c.has_open_orders(&owner),
            c.indexed_scenarios(&owner),
        )
    });
    assert!(!real && !orders && indexed.is_empty());
    assert!(holds(&mut w, OWNER));
    fails(
        unregister(&mut w, OWNER),
        &format!("AccountNotEmpty({OWNER})"),
    );
    check_holds_anything(&mut w).unwrap();
}

/// Scenarios up to `legacy_scenario_count` are never indexed; the legacy
/// scan finds what accounts hold there, for `holds_anything`, `markets_of`
/// and `mt_tokens_for_owner`.
#[test]
fn legacy_scenarios_are_scanned_never_indexed() {
    let (mut w, s, _) = eight_bare();
    let (s2, sb) = (w.s2x2, w.s_bin);
    // as after `migrate` on a v1 state with the 2x2 and the binary scenario
    w.call(OWNER, NO_DEPOSIT, |c| c.legacy_scenario_count = 2)
        .unwrap();
    w.split_ft(ALICE, s2, Wnear, &SINGLES, E18).unwrap();
    w.split_ft(ALICE, s, Usdc, &[0x0F, 0xF0], E18).unwrap();
    assert_eq!(record(&mut w, ALICE, s2), None);
    assert_eq!(footprint(&mut w, ALICE), vec![s]);
    let alice = acc(ALICE);
    assert_eq!(w.view(|c| c.markets_of(alice.clone())), vec![s2, s]);
    let tokens: Vec<String> = w.view(|c| {
        c.mt_tokens_for_owner(alice.clone(), None, None)
            .into_iter()
            .map(|t| t.token_id)
            .collect()
    });
    let mut expected: Vec<String> = SINGLES.iter().map(|m| token_id(s2, Wnear, *m)).collect();
    expected.push(token_id(s, Usdc, 0x0F));
    expected.push(token_id(s, Usdc, 0xF0));
    assert_eq!(tokens, expected);
    // paging keeps its meaning across the legacy part and the index
    let page: Vec<String> = w.view(|c| {
        c.mt_tokens_for_owner(alice.clone(), Some(U128(3)), Some(2))
            .into_iter()
            .map(|t| t.token_id)
            .collect()
    });
    assert_eq!(page, expected[3..5]);
    // legacy lending (any tier key) and LP shares are found by the scan
    w.lend(BOB, sb, 10 * E18).unwrap();
    let bob = acc(BOB);
    assert_eq!(w.view(|c| c.markets_of(bob.clone())), vec![sb]);
    assert!(holds(&mut w, BOB));
    assert!(footprint(&mut w, BOB).is_empty());
    check_eight_worlds(&mut w).unwrap();
}

/// `mt_tokens` and its metadata twin read `created_masks` and list exactly
/// what the full scan lists, in the same order, page by page;
/// `mt_tokens_for_owner` is the full scan of balances.
#[test]
fn enumeration_equals_the_full_scan() {
    let mut e = eight_market();
    let s = e.s;
    let none: Plans = vec![Vec::new(); 8];
    sell(&mut e.w, ALICE, s, 50 * E18, 0x0F, &none, false, None).unwrap();
    e.w.call(OWNER, NO_DEPOSIT, |c| c.register_verse(s, Wnear, 0x81))
        .unwrap();
    let (fast, full, meta) = e.w.view(|c| {
        let fast: Vec<String> = c
            .mt_tokens(None, None)
            .into_iter()
            .map(|t| t.token_id)
            .collect();
        let full: Vec<String> = c
            .verse_keys()
            .filter(|k| c.is_created(k))
            .map(|k| k.token_id())
            .collect();
        let meta: Vec<String> = c
            .mt_tokens_base_metadata_all(None, None)
            .into_iter()
            .map(|m| m.id)
            .collect();
        (fast, full, meta)
    });
    assert_eq!(fast, full);
    assert_eq!(meta, full);
    assert!(fast.contains(&token_id(s, Wnear, 0x81)));
    for (from, limit) in [(0u128, 7u32), (5, 50), (60, 3), (1_000, 10)] {
        let page: Vec<String> = e.w.view(|c| {
            c.mt_tokens(Some(U128(from)), Some(limit))
                .into_iter()
                .map(|t| t.token_id)
                .collect()
        });
        let from = (from as usize).min(full.len());
        let to = (from + limit as usize).min(full.len());
        assert_eq!(page, full[from..to]);
    }
    for who in [OWNER, ALICE, BOB, CAROL] {
        let a = acc(who);
        let (fast, full) = e.w.view(|c| {
            let fast: Vec<String> = c
                .mt_tokens_for_owner(a.clone(), None, None)
                .into_iter()
                .map(|t| t.token_id)
                .collect();
            let full: Vec<String> = c
                .verse_keys()
                .filter(|k| c.verse_balance(&a, k) > 0)
                .map(|k| k.token_id())
                .collect();
            (fast, full)
        });
        assert_eq!(fast, full, "{who}");
    }
}

// ---- Views ----

#[test]
fn orders_per_side_follows_the_world_count() {
    assert_eq!(orders_per_side(2), 25);
    assert_eq!(orders_per_side(4), 25);
    assert_eq!(orders_per_side(8), 12);
    // an 8-world snapshot shows the 12 best bids of a world, plus the
    // viewer's own orders
    let mut e = eight_market();
    let s = e.s;
    for i in 0..13u128 {
        post_bid(&mut e.w, RAVI, s, 0x01, 2_000 * E15 + i * E15, E18);
    }
    let ravi = acc(RAVI);
    let anyone = e.w.view(|c| c.trade_view(s, None)).orders;
    assert_eq!(anyone.len(), 12);
    assert!(
        anyone.iter().all(|o| o.price.0 > 2_000 * E15),
        "the best 12"
    );
    let own = e.w.view(|c| c.trade_view(s, Some(ravi.clone()))).orders;
    assert_eq!(own.len(), 13);
}

#[test]
fn world_supply_and_markets_of_shapes() {
    let mut e = eight_market();
    let s = e.s;
    let v =
        e.w.view(|c| near_sdk::serde_json::to_value(c.world_supply(s)).unwrap());
    let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
    let mut expected = [
        "scenario_id",
        "possible",
        "wnear_reserves",
        "usdc_reserves",
        "wnear",
        "usdc",
    ];
    expected.sort();
    let mut keys: Vec<&str> = keys.into_iter().map(String::as_str).collect();
    keys.sort();
    assert_eq!(keys, expected);
    assert_eq!(v["wnear"].as_array().unwrap().len(), 8);
    assert_eq!(v["possible"], 255);
    // the owner seeded the market; Bob lends in it
    let (owner, bob) = (acc(OWNER), acc(BOB));
    assert_eq!(e.w.view(|c| c.markets_of(owner.clone())), vec![s]);
    assert_eq!(e.w.view(|c| c.markets_of(bob.clone())), vec![s]);
    fails(e.w.try_view(|c| c.world_supply(77)), "UnknownScenario(77)");
}

// ---- migrate step 7 on production's state ----

/// After `migrate`: every legacy scenario's counters equal `backing`, its
/// created set equals the created keys, and the enumeration, the scans and
/// `holds_anything` agree with the full scans for the 8 production accounts.
#[test]
fn migrate_backfills_the_counters_of_every_legacy_scenario() {
    let mut p = migrated_prod();
    let (legacy, count) = p.view(|c| (c.legacy_scenario_count, c.scenario_count));
    assert_eq!((legacy, count), (6, 6));
    for sid in 1..=6 {
        let (ws, b, created, set) = p.view(|c| {
            let created: Vec<(Asset, u8)> = c
                .verse_keys_in(sid..=sid)
                .filter(|k| c.is_created(k))
                .map(|k| (k.asset, k.mask))
                .collect();
            let set: Vec<(Asset, u8)> = c
                .created_masks
                .get(&sid)
                .map(|m| m.iter().collect())
                .unwrap_or_default();
            (c.world_supply(sid), c.backing(sid), created, set)
        });
        for (i, x) in b.worlds.iter().enumerate() {
            assert_eq!(
                (ws.wnear[i], ws.usdc[i]),
                (x.wnear_supply, x.usdc_supply),
                "scenario {sid}"
            );
            assert!(x.wnear_backed && x.usdc_backed);
        }
        assert_eq!(created, set, "scenario {sid}");
    }
    // the keys step 7 adds: one vector per (scenario, asset) with supply,
    // one created set per scenario
    let count_under = |p: &Prod, key: StorageKey| {
        let pre = near_sdk::IntoStorageKey::into_storage_key(key);
        p.storage
            .keys()
            .filter(|k| k.len() > 1 && k.starts_with(&pre))
            .count()
    };
    assert_eq!(count_under(&p, StorageKey::WorldSupply), 12);
    assert_eq!(count_under(&p, StorageKey::CreatedMasks), 6);
    assert_eq!(count_under(&p, StorageKey::AccountScenarios), 0);
    assert_eq!(count_under(&p, StorageKey::Footprints), 0);
    let (fast, full) = p.view(|c| {
        let fast: Vec<String> = c
            .mt_tokens(None, None)
            .into_iter()
            .map(|t| t.token_id)
            .collect();
        let full: Vec<String> = c
            .verse_keys()
            .filter(|k| c.is_created(k))
            .map(|k| k.token_id())
            .collect();
        (fast, full)
    });
    assert_eq!(fast, full);
    let scanned = scanned_holders(&p.storage, 6);
    for a in prod_accounts() {
        let (tokens, scan, holds, other) = p.view(|c| {
            let tokens: Vec<String> = c
                .mt_tokens_for_owner(a.clone(), None, None)
                .into_iter()
                .map(|t| t.token_id)
                .collect();
            let scan: Vec<String> = c
                .verse_keys()
                .filter(|k| c.verse_balance(&a, k) > 0)
                .map(|k| k.token_id())
                .collect();
            let real = Asset::ALL
                .into_iter()
                .any(|x| c.real_balance(&a, x) >= c.asset_cfg(x).min_payable());
            (
                tokens,
                scan,
                c.holds_anything(&a),
                real || c.has_open_orders(&a),
            )
        });
        assert_eq!(tokens, scan, "{a}");
        assert_eq!(holds, other || scanned.contains(&a), "{a}");
    }
    // Leo's dust supply shares in market 1 are found by the legacy scan
    let leo = prod_account("leo");
    assert_eq!(p.view(|c| c.markets_of(leo.clone())), vec![1]);
}

/// A supply entry that breaks invariant 1 reverts the whole upgrade.
#[test]
fn migrate_refuses_a_broken_backing() {
    let mut p = Prod::from_snapshot();
    let possible_of = |p: &Prod, sid: u64| -> u8 {
        let key = [
            prefix(StorageKey::Scenarios),
            near_sdk::borsh::to_vec(&sid).unwrap(),
        ]
        .concat();
        Scenario::try_from_slice(&p.storage[&key]).unwrap().possible
    };
    // the first supply entry, in key order, of a token still paying somewhere
    let supply = prefix(StorageKey::Supply);
    let mut keys: Vec<Vec<u8>> = p
        .storage
        .keys()
        .filter(|k| k.len() > 1 && k.starts_with(&supply))
        .cloned()
        .collect();
    keys.sort();
    let (key, vk) = keys
        .into_iter()
        .map(|k| {
            let vk = VerseKey::try_from_slice(&k[1..]).unwrap();
            (k, vk)
        })
        .find(|(_, vk)| vk.mask & possible_of(&p, vk.scenario) != 0)
        .expect("a live token on production");
    let amount = u128::try_from_slice(&p.storage[&key]).unwrap();
    p.storage
        .insert(key, near_sdk::borsh::to_vec(&(amount + 1)).unwrap());
    let live = vk.mask & possible_of(&p, vk.scenario);
    let w = masks::lowest_world(live);
    let r = p.migrate(&acc(PROD_CONTRACT), super::migration::prod_args());
    assert_eq!(
        r,
        Err(format!(
            "BackingMismatch({}, {}, {w})",
            vk.scenario, vk.asset
        ))
    );
}

/// A tier's market key (`sid | tier << 56`) counts in its scenario's record.
#[test]
fn a_tier_market_key_counts_in_its_scenario() {
    let (mut w, s, _) = eight_bare();
    let bob = acc(BOB);
    w.call(OWNER, NO_DEPOSIT, |c| {
        c.note_lending(&bob, s | (2 << TIER_SHIFT), false, true);
        c.note_lending(&bob, s | (1 << TIER_SHIFT), true, true);
    })
    .unwrap();
    assert_eq!(record(&mut w, BOB, s).unwrap().lending_entries, 1);
    assert_eq!(footprint(&mut w, BOB), vec![s]);
    w.call(OWNER, NO_DEPOSIT, |c| {
        c.note_lending(&bob, s | (2 << TIER_SHIFT), true, false);
    })
    .unwrap();
    assert_eq!(record(&mut w, BOB, s), None);
    assert!(footprint(&mut w, BOB).is_empty());
}

/// Every `.rs` file under `src/` but the tests: `(path, source)`.
fn contract_sources() -> Vec<(String, String)> {
    fn walk(dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .expect("src/ is readable")
            .map(|e| e.expect("a directory entry").path())
            .collect();
        entries.sort();
        for path in entries {
            if path.is_dir() {
                if path.file_name().is_some_and(|n| n != "tests") {
                    walk(&path, out);
                }
            } else if path.extension().is_some_and(|x| x == "rs") {
                let source = std::fs::read_to_string(&path).expect("a source file");
                out.push((path.display().to_string(), source));
            }
        }
    }
    let mut out = Vec::new();
    walk(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut out,
    );
    out
}

/// `(line, name)` of every function declared in `source`, in order.
fn fn_lines(source: &str) -> Vec<(usize, String)> {
    source
        .lines()
        .enumerate()
        .filter_map(|(i, line)| {
            let t = line.trim_start();
            let rest = [
                "fn ",
                "pub fn ",
                "pub(crate) fn ",
                "const fn ",
                "pub const fn ",
            ]
            .iter()
            .find_map(|p| t.strip_prefix(p))?;
            let name: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            (!name.is_empty()).then_some((i, name))
        })
        .collect()
}

/// Every place `source` mutates `self.<field>`: `(line, enclosing fn, the
/// fn's body)`. Whitespace is ignored, so a call rustfmt split over lines
/// counts too.
fn writes_of<'s>(source: &'s str, field: &str) -> Vec<(usize, String, &'s str)> {
    let mut flat = String::new();
    let mut line_of = Vec::new();
    for (i, line) in source.lines().enumerate() {
        for ch in line.chars().filter(|c| !c.is_whitespace()) {
            flat.push(ch);
            line_of.push(i);
        }
    }
    let fns = fn_lines(source);
    let lines: Vec<&str> = source.lines().collect();
    let mut offsets = vec![0usize];
    for l in &lines {
        offsets.push(offsets.last().unwrap() + l.len() + 1);
    }
    let methods = [
        "insert(", "remove(", "entry(", "get_mut(", "clear(", "retain(", "extend(", "set(",
    ];
    let mut patterns: Vec<String> = methods
        .iter()
        .map(|m| format!("self.{field}.{m}"))
        .collect();
    patterns.push(format!("&mutself.{field}"));
    patterns.push(format!("self.{field}="));
    let mut out = Vec::new();
    for p in &patterns {
        let mut from = 0;
        while let Some(at) = flat[from..].find(p.as_str()) {
            let at = from + at;
            from = at + p.len();
            // `self.supply=` must not match `self.supply==`, nor `&mut
            // self.supply` match `&mut self.supply_shares`
            let next = flat[from..].chars().next();
            if (p.ends_with('=') && next == Some('='))
                || (p.starts_with('&') && next.is_some_and(|c| c.is_alphanumeric() || c == '_'))
            {
                continue;
            }
            let line = line_of[at];
            let k = fns
                .iter()
                .rposition(|(l, _)| *l <= line)
                .expect("a write inside a function");
            let start = offsets[fns[k].0];
            let end = fns
                .get(k + 1)
                .map_or(source.len(), |(l, _)| offsets[*l].min(source.len()));
            out.push((line + 1, fns[k].1.clone(), &source[start..end]));
        }
    }
    out
}

/// EW-3's other half: the maps behind the counters and the index are written
/// only by their one write helper, so no path can skip `note`, the counters
/// or the created set; the lending share maps (written through `set_amount`)
/// only from functions that also call `note_lending`.
#[test]
fn indexed_maps_are_written_only_by_their_helpers() {
    let helpers: [(&str, &[&str]); 10] = [
        ("balances", &["set_verse_balance"]),
        ("supply", &["add_supply", "sub_supply"]),
        ("created", &["mark_created"]),
        (
            "world_supply",
            &["bump_world_supply", "migrate_eight_worlds"],
        ),
        ("created_masks", &["mark_created", "migrate_eight_worlds"]),
        ("positions", &["put_position"]),
        ("lp_shares", &["set_shares"]),
        ("collateral", &["set_pieces"]),
        ("account_scenarios", &["note"]),
        ("footprints", &["footprint_add", "footprint_remove"]),
    ];
    // the scan sees through rustfmt's line breaks, ignores reads and names
    // the enclosing function
    let sample = "impl C {\n    fn a(&mut self) {\n        self.positions\n            .insert(k, v);\n    }\n    \
                  fn b(&self) -> bool {\n        self.positions.contains_key(&k)\n    }\n    \
                  fn c(&mut self) {\n        let m = &mut self.positions_x;\n    }\n}\n";
    let found: Vec<(usize, String)> = writes_of(sample, "positions")
        .into_iter()
        .map(|(line, f, _)| (line, f))
        .collect();
    assert_eq!(found, [(3, "a".to_string())]);
    let sources = contract_sources();
    assert!(sources.len() > 20, "found {} files", sources.len());
    let mut seen = BTreeMap::new();
    for (path, source) in &sources {
        for (field, allowed) in helpers {
            for (line, f, _) in writes_of(source, field) {
                assert!(
                    allowed.contains(&f.as_str()),
                    "{path}:{line}: `{field}` written in `{f}`, not in {allowed:?}"
                );
                *seen.entry(field).or_insert(0) += 1;
            }
        }
        for field in ["supply_shares", "borrow_shares"] {
            for (line, f, body) in writes_of(source, field) {
                assert!(
                    body.contains("note_lending("),
                    "{path}:{line}: `{field}` written in `{f}` without `note_lending`"
                );
                *seen.entry(field).or_insert(0) += 1;
            }
        }
    }
    // the scan finds the helpers themselves
    for field in helpers
        .iter()
        .map(|(f, _)| *f)
        .chain(["supply_shares", "borrow_shares"])
    {
        assert!(
            seen.get(field).is_some_and(|n| *n > 0),
            "no write of `{field}` found"
        );
    }
}
