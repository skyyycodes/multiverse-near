//! NEP-245 core, enumeration and metadata on the verse ledger: argument
//! shapes, 1 yoctoNEAR, the receiver's registration, `mt_transfer_call` and
//! its resolution under every promise result.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{NearToken, PromiseResult};

use super::harness::*;
use crate::nep245::Token;
use crate::types::Asset::{Usdc, Weth};

const MARKET: &str = "market.near";

fn world() -> World {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Weth, &[SHIPS, DELAYED], 10 * E18)
        .unwrap();
    w.register(MARKET, NearToken::from_near(1));
    w
}

fn ships() -> String {
    token_id(1, Weth, SHIPS)
}

fn delayed() -> String {
    token_id(1, Weth, DELAYED)
}

/// Runs the `mt_resolve_transfer` the last call scheduled, with the
/// receiver's `mt_on_transfer` ending in `result`.
fn resolve(w: &mut World, result: PromiseResult) -> Vec<u128> {
    let call = w
        .last
        .calls()
        .into_iter()
        .find(|c| c.method == "mt_resolve_transfer")
        .expect("resolve scheduled");
    let a = call.args;
    let sender = acc(a["sender_id"].as_str().unwrap());
    let receiver = acc(a["receiver_id"].as_str().unwrap());
    let ids: Vec<String> = a["token_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    let amounts: Vec<U128> = a["amounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| U128(v.as_str().unwrap().parse().unwrap()))
        .collect();
    assert!(a["approvals"].is_null());
    w.exec(CONTRACT, NO_DEPOSIT, vec![result], |c| {
        c.mt_resolve_transfer(sender, receiver, ids, amounts, None)
    })
    .expect("mt_resolve_transfer must never panic")
    .into_iter()
    .map(|u| u.0)
    .collect()
}

fn unused(amounts: &[u128]) -> PromiseResult {
    let v: Vec<String> = amounts.iter().map(|a| a.to_string()).collect();
    PromiseResult::Successful(json!(v).to_string().into_bytes())
}

fn transfer_call(
    w: &mut World,
    to: &str,
    ids: &[String],
    amounts: &[u128],
    msg: &str,
) -> Result<(), String> {
    let (to, ids, msg) = (acc(to), ids.to_vec(), msg.to_string());
    let amounts: Vec<U128> = amounts.iter().map(|a| U128(*a)).collect();
    w.call(ALICE, ONE_YOCTO, |c| {
        c.mt_batch_transfer_call(to, ids, amounts, None, None, msg);
    })
}

// Transfers

#[test]
fn mt_transfer_moves_balance_and_logs() {
    let mut w = world();
    w.mt_transfer(ALICE, BOB, &ships(), 3 * E18).unwrap();
    assert_eq!(w.bal(ALICE, 1, Weth, SHIPS), 7 * E18);
    assert_eq!(w.bal(BOB, 1, Weth, SHIPS), 3 * E18);
    // supply moves only on mint and burn
    assert_eq!(w.supply(1, Weth, SHIPS), 10 * E18);
    assert_eq!(
        w.last.logs,
        vec![
            r#"EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_transfer","data":[{"old_owner_id":"alice.near","new_owner_id":"bob.near","token_ids":["1:weth:5"],"amounts":["3000000000000000000"]}]}"#
        ]
    );
    let id = ships();
    w.call(ALICE, ONE_YOCTO, |c| {
        c.mt_transfer(acc(BOB), id, U128(1), None, Some("gift".into()))
    })
    .unwrap();
    assert_eq!(
        w.last.logs,
        vec![
            r#"EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_transfer","data":[{"old_owner_id":"alice.near","new_owner_id":"bob.near","token_ids":["1:weth:5"],"amounts":["1"],"memo":"gift"}]}"#
        ]
    );
}

#[test]
fn mt_transfer_requires_exactly_one_yocto() {
    let mut w = world();
    for deposit in [NO_DEPOSIT, NearToken::from_yoctonear(2)] {
        let id = ships();
        fails(
            w.call(ALICE, deposit, |c| {
                c.mt_transfer(acc(BOB), id, U128(1), None, None)
            }),
            "Requires attached deposit of exactly 1 yoctoNEAR",
        );
    }
}

#[test]
fn mt_transfer_rejects_bad_requests() {
    let mut w = world();
    let id = ships();
    fails(
        w.call(ALICE, ONE_YOCTO, |c| {
            c.mt_transfer(acc(BOB), id, U128(1), Some((acc(ALICE), 1)), None)
        }),
        "ApprovalsNotSupported",
    );
    fails(
        w.mt_transfer(ALICE, "dave.near", &ships(), 1),
        "NotRegistered(dave.near)",
    );
    fails(
        w.mt_transfer(ALICE, ALICE, &ships(), 1),
        "SelfTransfer(alice.near)",
    );
    fails(
        w.mt_transfer(ALICE, CONTRACT, &ships(), 1),
        "ReceiverIsContract(multiverse.near)",
    );
    fails(w.mt_transfer(ALICE, BOB, &ships(), 0), "ZeroAmount");
    fails(
        w.mt_transfer(ALICE, BOB, "1:weth", 1),
        "InvalidTokenId(1:weth)",
    );
    fails(
        w.mt_transfer(ALICE, BOB, "01:weth:5", 1),
        "InvalidTokenId(01:weth:5)",
    );
    fails(
        w.mt_transfer(ALICE, BOB, "1:WETH:5", 1),
        "InvalidTokenId(1:WETH:5)",
    );
    fails(
        w.mt_transfer(ALICE, BOB, &ships(), 10 * E18 + 1),
        "ERC20InsufficientBalance(alice.near, 10000000000000000000, 10000000000000000001)",
    );
    // a well-formed id nobody holds
    fails(
        w.mt_transfer(ALICE, BOB, "1:weth:1", 1),
        "ERC20InsufficientBalance(alice.near, 0, 1)",
    );
    // nothing moved
    assert_eq!(w.bal(ALICE, 1, Weth, SHIPS), 10 * E18);
}

#[test]
fn mt_batch_transfer_moves_several_ids_in_one_log() {
    let mut w = world();
    w.mt_batch_transfer(
        ALICE,
        BOB,
        &[ships(), delayed(), ships()],
        &[E18, 2 * E18, 3 * E18],
    )
    .unwrap();
    assert_eq!(w.bal(BOB, 1, Weth, SHIPS), 4 * E18);
    assert_eq!(w.bal(BOB, 1, Weth, DELAYED), 2 * E18);
    assert_eq!(w.bal(ALICE, 1, Weth, SHIPS), 6 * E18);
    assert_eq!(
        w.last.logs,
        vec![
            r#"EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_transfer","data":[{"old_owner_id":"alice.near","new_owner_id":"bob.near","token_ids":["1:weth:5","1:weth:10","1:weth:5"],"amounts":["1000000000000000000","2000000000000000000","3000000000000000000"]}]}"#
        ]
    );
}

#[test]
fn mt_batch_transfer_checks_lengths_and_approvals() {
    let mut w = world();
    let batch = |w: &mut World,
                 ids: Vec<String>,
                 amounts: Vec<u128>,
                 approvals: Option<Vec<Option<(near_sdk::AccountId, u64)>>>| {
        let amounts = amounts.into_iter().map(U128).collect();
        w.call(ALICE, ONE_YOCTO, |c| {
            c.mt_batch_transfer(acc(BOB), ids, amounts, approvals, None)
        })
    };
    fails(
        batch(&mut w, vec![ships(), delayed()], vec![1], None),
        "LengthMismatch(2, 1)",
    );
    fails(batch(&mut w, vec![], vec![], None), "EmptyBatch");
    fails(
        batch(
            &mut w,
            vec![ships(), delayed()],
            vec![1, 1],
            Some(vec![None]),
        ),
        "LengthMismatch(2, 1)",
    );
    fails(
        batch(
            &mut w,
            vec![ships(), delayed()],
            vec![1, 1],
            Some(vec![None, Some((acc(ALICE), 0))]),
        ),
        "ApprovalsNotSupported",
    );
    // all-null approvals are fine
    batch(
        &mut w,
        vec![ships(), delayed()],
        vec![1, 1],
        Some(vec![None, None]),
    )
    .unwrap();
    // a failing entry anywhere rolls back the whole batch
    fails(
        batch(&mut w, vec![ships(), delayed()], vec![1, 11 * E18], None),
        &format!(
            "ERC20InsufficientBalance(alice.near, {}, {})",
            10 * E18 - 1,
            11 * E18
        ),
    );
    assert_eq!(w.bal(BOB, 1, Weth, SHIPS), 1);
}

// Transfer and call

#[test]
fn mt_transfer_call_schedules_receiver_then_resolve() {
    let mut w = world();
    let id = ships();
    w.call(ALICE, ONE_YOCTO, |c| {
        c.mt_transfer_call(
            acc(MARKET),
            id,
            U128(4 * E18),
            None,
            Some("m".into()),
            "list".into(),
        );
    })
    .unwrap();
    // the tokens move before the receiver runs
    assert_eq!(w.bal(MARKET, 1, Weth, SHIPS), 4 * E18);
    assert_eq!(w.last.data_of("mt_transfer")[0]["memo"], "m");
    let calls = w.last.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].receiver_id.as_str(), MARKET);
    assert_eq!(calls[0].method, "mt_on_transfer");
    assert_eq!(
        calls[0].args,
        json!({
            "sender_id": ALICE,
            "previous_owner_ids": [ALICE],
            "token_ids": ["1:weth:5"],
            "amounts": ["4000000000000000000"],
            "msg": "list",
        })
    );
    assert_eq!(calls[0].deposit, 0);
    // 300 Tgas less 25 kept back and 11 for the resolve (10 + 1 per token)
    assert_eq!(calls[0].tgas, 264);
    assert_eq!(calls[1].receiver_id.as_str(), CONTRACT);
    assert_eq!(calls[1].method, "mt_resolve_transfer");
    assert_eq!(calls[1].tgas, 11);
    assert_eq!(calls[1].after, vec![0]);
}

#[test]
fn resolve_with_everything_used() {
    let mut w = world();
    transfer_call(&mut w, MARKET, &[ships()], &[4 * E18], "").unwrap();
    assert_eq!(resolve(&mut w, unused(&[0])), vec![4 * E18]);
    assert!(w.last.logs.is_empty());
    assert_eq!(w.bal(MARKET, 1, Weth, SHIPS), 4 * E18);
    assert_eq!(w.bal(ALICE, 1, Weth, SHIPS), 6 * E18);
}

#[test]
fn resolve_refunds_unused() {
    let mut w = world();
    transfer_call(&mut w, MARKET, &[ships()], &[4 * E18], "").unwrap();
    assert_eq!(resolve(&mut w, unused(&[E18])), vec![3 * E18]);
    assert_eq!(w.bal(MARKET, 1, Weth, SHIPS), 3 * E18);
    assert_eq!(w.bal(ALICE, 1, Weth, SHIPS), 7 * E18);
    assert_eq!(
        w.last.logs,
        vec![
            r#"EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_transfer","data":[{"old_owner_id":"market.near","new_owner_id":"alice.near","token_ids":["1:weth:5"],"amounts":["1000000000000000000"],"memo":"refund"}]}"#
        ]
    );
}

#[test]
fn resolve_refunds_everything_when_the_receiver_fails() {
    let mut w = world();
    transfer_call(&mut w, MARKET, &[ships(), delayed()], &[4 * E18, E18], "").unwrap();
    assert_eq!(resolve(&mut w, PromiseResult::Failed), vec![0, 0]);
    assert_eq!(w.bal(ALICE, 1, Weth, SHIPS), 10 * E18);
    assert_eq!(w.bal(ALICE, 1, Weth, DELAYED), 10 * E18);
    assert_eq!(w.bal(MARKET, 1, Weth, SHIPS), 0);
}

#[test]
fn resolve_refunds_everything_on_a_malformed_answer() {
    for answer in [
        b"not json".to_vec(),
        br#"["1","2"]"#.to_vec(),
        br#"[1]"#.to_vec(),
    ] {
        let mut w = world();
        transfer_call(&mut w, MARKET, &[ships()], &[4 * E18], "").unwrap();
        assert_eq!(resolve(&mut w, PromiseResult::Successful(answer)), vec![0]);
        assert_eq!(w.bal(ALICE, 1, Weth, SHIPS), 10 * E18);
    }
}

#[test]
fn resolve_caps_unused_at_the_amount_sent() {
    let mut w = world();
    transfer_call(&mut w, MARKET, &[ships()], &[4 * E18], "").unwrap();
    assert_eq!(resolve(&mut w, unused(&[9 * E18])), vec![0]);
    assert_eq!(w.bal(ALICE, 1, Weth, SHIPS), 10 * E18);
}

#[test]
fn resolve_caps_the_refund_at_what_the_receiver_still_holds() {
    let mut w = world();
    transfer_call(&mut w, MARKET, &[ships()], &[4 * E18], "").unwrap();
    let pending = w.last.clone();
    // the receiver moved most of it on before the resolve ran
    w.mt_transfer(MARKET, BOB, &ships(), 3 * E18).unwrap();
    w.last = pending;
    assert_eq!(resolve(&mut w, PromiseResult::Failed), vec![3 * E18]);
    assert_eq!(w.bal(ALICE, 1, Weth, SHIPS), 7 * E18);
    assert_eq!(w.bal(MARKET, 1, Weth, SHIPS), 0);
}

#[test]
fn resolve_batch_with_a_repeated_id() {
    let mut w = world();
    transfer_call(&mut w, MARKET, &[ships(), ships()], &[2 * E18, 2 * E18], "").unwrap();
    let pending = w.last.clone();
    w.mt_transfer(MARKET, BOB, &ships(), 3 * E18).unwrap();
    w.last = pending;
    // 1e18 is left for two refunds of 2e18 each: the first takes it all
    assert_eq!(
        resolve(&mut w, unused(&[2 * E18, 2 * E18])),
        vec![E18, 2 * E18]
    );
    assert_eq!(w.bal(ALICE, 1, Weth, SHIPS), 7 * E18);
    assert_eq!(w.bal(MARKET, 1, Weth, SHIPS), 0);
    w.assert_conservation(&[ALICE, BOB, MARKET]);
}

#[test]
fn mt_transfer_call_needs_gas_for_the_resolve() {
    let mut w = world();
    w.prepaid_tgas = 30;
    fails(
        transfer_call(&mut w, MARKET, &[ships()], &[1], ""),
        "NotEnoughGas(30000000000000, 36000000000000)",
    );
    w.prepaid_tgas = 300;
    let id = ships();
    fails(
        w.call(ALICE, ONE_YOCTO, |c| {
            c.mt_transfer_call(
                acc(MARKET),
                id,
                U128(1),
                Some((acc(ALICE), 0)),
                None,
                "".into(),
            )
        }),
        "ApprovalsNotSupported",
    );
    fails(
        transfer_call(&mut w, "dave.near", &[ships()], &[1], ""),
        "NotRegistered(dave.near)",
    );
}

// Views

#[test]
fn balance_and_supply_views() {
    let mut w = world();
    let alice = acc(ALICE);
    assert_eq!(
        w.view(|c| c.mt_balance_of(alice.clone(), ships())),
        U128(10 * E18)
    );
    assert_eq!(
        w.view(|c| c.mt_balance_of(alice.clone(), "9:weth:1".into())),
        U128(0)
    );
    assert_eq!(
        w.view(|c| c.mt_balance_of(alice.clone(), "garbage".into())),
        U128(0)
    );
    assert_eq!(
        w.view(|c| c.mt_batch_balance_of(alice.clone(), vec![ships(), delayed(), "x".into()])),
        vec![U128(10 * E18), U128(10 * E18), U128(0)]
    );
    assert_eq!(w.view(|c| c.mt_supply(ships())), Some(U128(10 * E18)));
    assert_eq!(w.view(|c| c.mt_supply("1:weth:1".into())), None);
    assert_eq!(w.view(|c| c.mt_supply("garbage".into())), None);
    assert_eq!(
        w.view(|c| c.mt_batch_supply(vec![ships(), "1:weth:1".into()])),
        vec![Some(U128(10 * E18)), None]
    );
    // once created, a token keeps existing at supply 0
    w.merge(ALICE, 1, Weth, &[SHIPS, DELAYED], ROOT, 10 * E18)
        .unwrap();
    assert_eq!(w.view(|c| c.mt_supply(ships())), Some(U128(0)));
}

#[test]
fn mt_token_view() {
    let mut w = world();
    let id = ships();
    assert_eq!(
        w.view(|c| c.mt_token(vec![id.clone(), "1:weth:1".into(), "x".into()])),
        vec![
            Some(Token {
                token_id: id.clone(),
                owner_id: None,
                base_metadata_id: id
            }),
            None,
            None
        ]
    );
}

#[test]
fn enumeration_paginates_in_key_order() {
    let mut w = world();
    w.split_ft(ALICE, 1, Usdc, &SINGLES, E18).unwrap();
    w.split_ft(ALICE, 2, Weth, &[BIN_SHIPS, BIN_DELAYED], E18)
        .unwrap();
    let ids = |tokens: Vec<Token>| tokens.into_iter().map(|t| t.token_id).collect::<Vec<_>>();
    let alice = acc(ALICE);
    let all = vec![
        "1:weth:5",
        "1:weth:10",
        "1:usdc:1",
        "1:usdc:2",
        "1:usdc:4",
        "1:usdc:8",
        "2:weth:1",
        "2:weth:2",
    ];
    assert_eq!(
        ids(w.view(|c| c.mt_tokens_for_owner(alice.clone(), None, None))),
        all
    );
    assert_eq!(
        ids(w.view(|c| c.mt_tokens_for_owner(alice.clone(), Some(U128(2)), Some(3)))),
        vec!["1:usdc:1", "1:usdc:2", "1:usdc:4"]
    );
    assert!(w
        .view(|c| c.mt_tokens_for_owner(alice.clone(), Some(U128(8)), None))
        .is_empty());
    assert!(w
        .view(|c| c.mt_tokens_for_owner(acc(BOB), None, None))
        .is_empty());
    w.mt_transfer(ALICE, BOB, "1:usdc:4", 1).unwrap();
    assert_eq!(
        ids(w.view(|c| c.mt_tokens_for_owner(acc(BOB), None, None))),
        vec!["1:usdc:4"]
    );
    // burned out of alice's hands, still a token of the contract
    w.merge(ALICE, 1, Weth, &[SHIPS, DELAYED], ROOT, 10 * E18)
        .unwrap();
    assert_eq!(
        ids(w.view(|c| c.mt_tokens_for_owner(alice.clone(), None, Some(2)))),
        vec!["1:usdc:1", "1:usdc:2"]
    );
    assert_eq!(ids(w.view(|c| c.mt_tokens(None, None))), all);
    assert_eq!(
        ids(w.view(|c| c.mt_tokens(Some(U128(6)), Some(5)))),
        vec!["2:weth:1", "2:weth:2"]
    );
}

#[test]
fn metadata_views() {
    let mut w = World::new();
    let contract = w.view(|c| c.mt_metadata_contract());
    assert_eq!(
        (contract.spec.as_str(), contract.name.as_str()),
        ("mt-1.0.0", "Multiverse verse tokens")
    );
    // works before anything is minted
    let id = token_id(1, Weth, L_SHAPE);
    let base = w
        .view(|c| c.mt_metadata_base_by_token_id(vec![id.clone()]))
        .remove(0);
    assert_eq!(base.name, "WETH-if-0b1110");
    assert_eq!(base.symbol.as_deref(), Some("WETH-if-0b1110"));
    assert_eq!(base.id, id);
    assert_eq!(base.decimals.as_deref(), Some("18"));
    assert_eq!(
        w.view(|c| c.mt_metadata_base_by_metadata_id(vec![id.clone()]))
            .remove(0),
        base
    );
    let token = w
        .view(|c| c.mt_metadata_token_by_token_id(vec![token_id(1, Usdc, DELAYED_HOLDS)]))
        .remove(0);
    assert_eq!(token.title.as_deref(), Some("USDC-if-DELAYED·HOLDS"));
    assert_eq!(
        token.description.as_deref(),
        Some("Pays 1 USDC if the world that comes true is in DELAYED·HOLDS (scenario 1)")
    );
    fails(
        w.try_view(|c| c.mt_metadata_base_by_token_id(vec!["1:weth:15".into()])),
        "NoTokenForRoot",
    );
    fails(
        w.try_view(|c| c.mt_metadata_base_by_token_id(vec!["1:weth:16".into()])),
        "InvalidMask(16)",
    );
    fails(
        w.try_view(|c| c.mt_metadata_token_all(vec!["9:weth:1".into()])),
        "UnknownScenario(9)",
    );
    fails(
        w.try_view(|c| c.mt_metadata_token_by_token_id(vec!["bad".into()])),
        "InvalidTokenId(bad)",
    );
}
