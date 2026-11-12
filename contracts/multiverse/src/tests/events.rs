//! Exact log lines: NEP-297 envelopes of the "multiverse" standard and the
//! NEP-245 `mt_mint` / `mt_burn` / `mt_transfer` logs. Indexers and the app
//! parse these, so their shape is part of the interface.

use super::harness::*;
use crate::types::Asset::{Usdc, Wnear};

#[test]
fn split_logs_one_mint_and_one_split() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &[SHIPS_CUTS, L_SHAPE], 2 * E18)
        .unwrap();
    assert_eq!(
        w.last.logs,
        vec![
            r#"EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_mint","data":[{"owner_id":"alice.near","token_ids":["1:wnear:1","1:wnear:14"],"amounts":["2000000000000000000","2000000000000000000"]}]}"#,
            r#"EVENT_JSON:{"standard":"multiverse","version":"1.0.0","event":"split","data":[{"account_id":"alice.near","scenario_id":1,"asset":"wnear","from_mask":15,"to_masks":[1,14],"amount":"2000000000000000000"}]}"#,
        ]
    );
    w.split(ALICE, 1, Wnear, L_SHAPE, &[DELAYED_CUTS, HOLDS], E18)
        .unwrap();
    assert_eq!(
        w.last.logs,
        vec![
            r#"EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_burn","data":[{"owner_id":"alice.near","token_ids":["1:wnear:14"],"amounts":["1000000000000000000"]}]}"#,
            r#"EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_mint","data":[{"owner_id":"alice.near","token_ids":["1:wnear:2","1:wnear:12"],"amounts":["1000000000000000000","1000000000000000000"]}]}"#,
            r#"EVENT_JSON:{"standard":"multiverse","version":"1.0.0","event":"split","data":[{"account_id":"alice.near","scenario_id":1,"asset":"wnear","from_mask":14,"to_masks":[2,12],"amount":"1000000000000000000"}]}"#,
        ]
    );
}

#[test]
fn merge_and_redeem_logs() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Usdc, &SINGLES, 4 * E18).unwrap();
    w.merge(ALICE, 1, Usdc, &[SHIPS_HOLDS, DELAYED_HOLDS], HOLDS, E18)
        .unwrap();
    assert_eq!(
        w.last.logs,
        vec![
            r#"EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_burn","data":[{"owner_id":"alice.near","token_ids":["1:usdc:4","1:usdc:8"],"amounts":["1000000000000000000","1000000000000000000"]}]}"#,
            r#"EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_mint","data":[{"owner_id":"alice.near","token_ids":["1:usdc:12"],"amounts":["1000000000000000000"]}]}"#,
            r#"EVENT_JSON:{"standard":"multiverse","version":"1.0.0","event":"merged","data":[{"account_id":"alice.near","scenario_id":1,"asset":"usdc","from_masks":[4,8],"to_mask":12,"amount":"1000000000000000000"}]}"#,
        ]
    );
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    w.redeem(ALICE, 1, Usdc, HOLDS, E18).unwrap();
    assert_eq!(
        w.last.logs,
        vec![
            r#"EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_burn","data":[{"owner_id":"alice.near","token_ids":["1:usdc:12"],"amounts":["1000000000000000000"]}]}"#,
            r#"EVENT_JSON:{"standard":"multiverse","version":"1.0.0","event":"redeemed","data":[{"account_id":"alice.near","scenario_id":1,"asset":"usdc","mask":12,"amount":"1000000000000000000"}]}"#,
        ]
    );
    // the payout callback logs nothing when the transfer goes through
    assert!(w.callbacks[0].logs.is_empty());
}

#[test]
fn oracle_logs() {
    let mut w = World::bare();
    let names = |a: &str, b: &str| vec![a.to_string(), b.to_string()];
    w.call(OWNER, near_sdk::NearToken::from_near(1), |c| {
        c.create_event("Q?".into(), names("YES", "NO"), "R.".into(), 77)
    })
    .unwrap();
    assert_eq!(
        w.last.logs,
        vec![
            r#"EVENT_JSON:{"standard":"multiverse","version":"1.0.0","event":"event_created","data":[{"event_id":1,"question":"Q?","outcome_names":["YES","NO"],"rule":"R.","deadline_sec":77}]}"#
        ]
    );
    w.create_scenario(&[1]).unwrap();
    assert_eq!(
        w.last.logs,
        vec![
            r#"EVENT_JSON:{"standard":"multiverse","version":"1.0.0","event":"scenario_created","data":[{"scenario_id":1,"event_ids":[1],"world_count":2}]}"#
        ]
    );
    w.report(1, 1).unwrap();
    assert_eq!(
        w.last.logs[0],
        format!(
            r#"EVENT_JSON:{{"standard":"multiverse","version":"1.0.0","event":"outcome_proposed","data":[{{"event_id":1,"outcome":1,"source":"reporter","finalizable_at_sec":{}}}]}}"#,
            T0 + DISPUTE_WINDOW
        )
    );
    w.dispute(1).unwrap();
    assert_eq!(
        w.last.logs,
        vec![
            r#"EVENT_JSON:{"standard":"multiverse","version":"1.0.0","event":"proposal_disputed","data":[{"event_id":1,"outcome":1}]}"#
        ]
    );
    w.report(1, 0).unwrap();
    w.warp(DISPUTE_WINDOW);
    w.finalize(BOB, 1).unwrap();
    assert_eq!(
        w.last.logs,
        vec![
            r#"EVENT_JSON:{"standard":"multiverse","version":"1.0.0","event":"worlds_removed","data":[{"scenario_id":1,"event_id":1,"outcome":0,"removed":2,"possible":1}]}"#,
            r#"EVENT_JSON:{"standard":"multiverse","version":"1.0.0","event":"event_finalized","data":[{"event_id":1,"outcome":0,"scenario_ids":[1]}]}"#,
        ]
    );
}

#[test]
fn config_logs() {
    let mut w = World::new();
    w.call(OWNER, ONE_YOCTO, |c| c.set_reporter(None)).unwrap();
    assert_eq!(
        w.last.logs,
        vec![
            r#"EVENT_JSON:{"standard":"multiverse","version":"1.0.0","event":"reporter_set","data":[{"reporter_id":null}]}"#
        ]
    );
    w.call(OWNER, ONE_YOCTO, |c| c.set_reporter(Some(acc(REPORTER))))
        .unwrap();
    assert_eq!(
        w.last.logs,
        vec![
            r#"EVENT_JSON:{"standard":"multiverse","version":"1.0.0","event":"reporter_set","data":[{"reporter_id":"resolver.near"}]}"#
        ]
    );
    w.call(OWNER, ONE_YOCTO, |c| c.set_dispute_window(45))
        .unwrap();
    assert_eq!(
        w.last.logs,
        vec![
            r#"EVENT_JSON:{"standard":"multiverse","version":"1.0.0","event":"dispute_window_set","data":[{"dispute_window_sec":45}]}"#
        ]
    );
}

/// Every event carries the NEP-297 fields in the same order, and the NEP-245
/// optional fields only when set.
#[test]
fn envelopes_follow_nep_297() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &SINGLES, E18).unwrap();
    w.mt_transfer(ALICE, BOB, &token_id(1, Wnear, SHIPS_CUTS), 1)
        .unwrap();
    w.admin_resolve(w.spice, OUT_DELAYED).unwrap();
    for line in [w.last.logs.clone(), vec![]].concat() {
        let json = line
            .strip_prefix("EVENT_JSON:")
            .expect("every log is an event");
        assert!(json.starts_with(r#"{"standard":""#), "{json}");
        let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(json).unwrap();
        let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        assert_eq!(keys.len(), 4);
        assert!(v["data"].is_array() && v["data"].as_array().unwrap().len() == 1);
        assert_eq!(v["version"], "1.0.0");
    }
    let id = token_id(1, Wnear, SHIPS_CUTS);
    w.call(BOB, ONE_YOCTO, |c| {
        c.mt_transfer(acc(ALICE), id, near_sdk::json_types::U128(1), None, None)
    })
    .unwrap();
    let data = &w.last.data_of("mt_transfer")[0];
    assert!(data.get("memo").is_none() && data.get("authorized_id").is_none());
}
