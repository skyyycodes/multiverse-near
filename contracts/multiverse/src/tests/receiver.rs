//! `ft_on_transfer`: the token whitelist, the strict `msg`, scaling between
//! token units and internal units, refunds of what an action leaves, dust,
//! and the actions whose modules are not built yet.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::PromiseOrValue;

use super::harness::*;
use crate::lending::{MaxKeyword, RepayAmount};
use crate::orders::Side;
use crate::receiver::{parse_msg, Action};
use crate::router::PlanFill;
use crate::types::Asset::{Usdc, Wnear};

const USDC_UNIT: u128 = 1_000_000_000_000; // one micro-USDC in internal units

#[track_caller]
fn fails_starting(result: Result<impl Sized, String>, prefix: &str) {
    match result {
        Ok(_) => panic!("expected `{prefix}...`, but the call succeeded"),
        Err(e) => assert!(
            e.starts_with(prefix),
            "`{e}` does not start with `{prefix}`"
        ),
    }
}

#[test]
fn wrong_token_is_refunded() {
    let mut w = World::new();
    let alice = acc(ALICE);
    // checked before anything else, the message included
    fails(
        w.call("beef.near", NO_DEPOSIT, |c| {
            c.ft_on_transfer(alice, U128(1), "{".into())
        }),
        "AssetNotAllowed(beef.near)",
    );
}

#[test]
fn malformed_messages_are_refunded() {
    let mut w = World::new();
    let cases = [
        ("{", "BadMessage(EOF while parsing an object"),
        (
            r#"{"action":"fly"}"#,
            "BadMessage(unknown variant `fly`, expected one of `deposit`, `split`",
        ),
        (r#"{"scenario_id":1}"#, "BadMessage(missing field `action`"),
        (
            r#"{"action":"split","scenario_id":1}"#,
            "BadMessage(missing field `to_masks`",
        ),
        (
            r#"{"action":"split","scenario_id":1,"to_masks":[5,10],"to":"bob.near"}"#,
            "BadMessage(unknown field `to`",
        ),
        (
            r#"{"action":"split","scenario_id":1,"to_masks":[256]}"#,
            "BadMessage(invalid value: integer `256`",
        ),
        (
            r#"{"action":"deposit","memo":"x"}"#,
            "BadMessage(unknown field `memo`",
        ),
        (r#""deposit""#, "BadMessage(invalid type: string"),
    ];
    for (msg, expected) in cases {
        fails_starting(w.ft_transfer_call(ALICE, Wnear, E18, msg), expected);
    }
    assert_eq!(w.wallet(ALICE, Wnear), FUND);
    assert_eq!(w.held_by_contract(Wnear), 0);
    assert_eq!(w.real(ALICE, Wnear), 0);
}

#[test]
fn empty_message_is_a_deposit() {
    let mut w = World::new();
    for msg in ["", "  ", r#"{"action":"deposit"}"#] {
        assert_eq!(w.ft_transfer_call(ALICE, Wnear, E18, msg).unwrap(), 0);
    }
    assert_eq!(w.real(ALICE, Wnear), 3 * E18);
    assert_eq!(w.held_by_contract(Wnear), 3 * E18);
    assert_eq!(
        w.last.logs,
        vec![
            r#"EVENT_JSON:{"standard":"multiverse","version":"2.0.0","event":"real_deposit","data":[{"account_id":"alice.near","asset":"wnear","amount":"1000000000000000000"}]}"#
        ]
    );
}

#[test]
fn zero_amount_and_unregistered_sender_are_refunded() {
    let mut w = World::new();
    let alice = acc(ALICE);
    fails(
        w.call(WNEAR_TOKEN, NO_DEPOSIT, |c| {
            c.ft_on_transfer(alice, U128(0), String::new())
        }),
        "ZeroAmount",
    );
    w.fund("dave.near");
    fails(
        w.ft_transfer_call("dave.near", Usdc, 5, ""),
        "NotRegistered(dave.near)",
    );
    assert_eq!(w.wallet("dave.near", Usdc), FUND);
}

#[test]
fn a_deposit_whose_scaled_amount_overflows_is_refunded() {
    let mut w = World::new();
    let alice = acc(ALICE);
    // u128::MAX / 1e12 is about 3.4e26 micro-USDC
    let too_many = u128::MAX / USDC_UNIT + 1;
    fails(
        w.call(USDC_TOKEN, NO_DEPOSIT, |c| {
            c.ft_on_transfer(alice, U128(too_many), String::new())
        }),
        "ArithmeticOverflow",
    );
    let alice = acc(ALICE);
    w.call(USDC_TOKEN, NO_DEPOSIT, |c| {
        c.ft_on_transfer(alice, U128(u128::MAX / USDC_UNIT), String::new())
    })
    .unwrap();
}

#[test]
fn a_split_that_fails_is_refunded_in_full() {
    let mut w = World::new();
    let cases = [
        (
            r#"{"action":"split","scenario_id":9,"to_masks":[1,2]}"#,
            "UnknownScenario(9)",
        ),
        (
            r#"{"action":"split","scenario_id":1,"to_masks":[]}"#,
            "EmptyPartition",
        ),
        (
            r#"{"action":"split","scenario_id":1,"to_masks":[14]}"#,
            "DoesNotCover(1)",
        ),
    ];
    for (msg, expected) in cases {
        fails(w.ft_transfer_call(ALICE, Usdc, 1_000_000, msg), expected);
    }
    assert_eq!(w.wallet(ALICE, Usdc), FUND);
    assert_eq!(w.real(ALICE, Usdc), 0);
    assert_eq!(w.reserves(1, Usdc), 0);
}

#[test]
fn usdc_is_scaled_to_18_decimals() {
    let mut w = World::new();
    // 1234.567891 USDC
    w.ft_transfer_call(ALICE, Usdc, 1_234_567_891, "").unwrap();
    assert_eq!(w.real(ALICE, Usdc), 1_234_567_891 * USDC_UNIT);
    // 2.5 USDC split from the wallet
    let msg = r#"{"action":"split","scenario_id":1,"to_masks":[1,2,4,8]}"#;
    assert_eq!(w.ft_transfer_call(ALICE, Usdc, 2_500_000, msg).unwrap(), 0);
    for m in SINGLES {
        assert_eq!(w.bal(ALICE, 1, Usdc, m), 2_500_000 * USDC_UNIT);
    }
    assert_eq!(w.reserves(1, Usdc), 25 * E18 / 10);
    // the split used exactly what came in: no change in the internal balance
    assert_eq!(w.real(ALICE, Usdc), 1_234_567_891 * USDC_UNIT);
    // and this wNEAR has 18 decimals already: 1 raw unit is 1 internal unit
    w.ft_transfer_call(ALICE, Wnear, 1, "").unwrap();
    assert_eq!(w.real(ALICE, Wnear), 1);
    // the split action's logs: the NEP-245 mint and the split, nothing else
    w.ft_transfer_call(ALICE, Usdc, 1, msg).unwrap();
    let names: Vec<String> = w.last.event_names().into_iter().map(|(_, e)| e).collect();
    assert_eq!(names, vec!["mt_mint", "split"]);
}

/// What an action leaves of this transfer goes back in whole token units;
/// anything below one unit stays as dust; never more than came in.
#[test]
fn unused_part_is_refunded_and_dust_stays() {
    let mut w = World::new();
    let alice = acc(ALICE);
    // took 1.5 USDC and 7 internal units of a 5 USDC transfer
    let (refund, left) = w
        .call(CONTRACT, NO_DEPOSIT, |c| {
            let credited = 5 * E18;
            c.real_credit(&alice, Usdc, credited);
            c.real_debit(&alice, Usdc, 15 * E18 / 10 + 7);
            let refund = c.settle_unused(&alice, Usdc, credited, 0);
            (refund, c.real_balance(&alice, Usdc))
        })
        .unwrap();
    assert_eq!(refund, 3_499_999);
    assert_eq!(left, USDC_UNIT - 7);

    // an action that adds to the same balance: only the transfer goes back
    let bob = acc(BOB);
    let (refund, left) = w
        .call(CONTRACT, NO_DEPOSIT, |c| {
            c.real_credit(&bob, Usdc, E18);
            c.real_credit(&bob, Usdc, 2 * E18);
            let refund = c.settle_unused(&bob, Usdc, E18, 0);
            (refund, c.real_balance(&bob, Usdc))
        })
        .unwrap();
    assert_eq!((refund, left), (1_000_000, 2 * E18));

    // an action that drew on what was already there: nothing to refund
    let carol = acc(CAROL);
    let refund = w
        .call(CONTRACT, NO_DEPOSIT, |c| {
            c.real_credit(&carol, Wnear, 10 * E18);
            c.real_credit(&carol, Wnear, E18);
            c.real_debit(&carol, Wnear, 3 * E18);
            c.settle_unused(&carol, Wnear, E18, 10 * E18)
        })
        .unwrap();
    assert_eq!(refund, 0);
}

#[test]
fn ft_on_transfer_returns_a_value_not_a_promise() {
    let mut w = World::new();
    let alice = acc(ALICE);
    let out = w
        .call(WNEAR_TOKEN, NO_DEPOSIT, |c| {
            c.ft_on_transfer(alice, U128(5), String::new())
        })
        .unwrap();
    assert!(matches!(out, PromiseOrValue::Value(U128(0))));
}

/// The `msg` shapes the app sends.
const DESIGN_MESSAGES: [(&str, &str); 11] = [
    (
        "conditional_sell",
        r#"{"action":"conditional_sell","scenario_id":1,"sell_mask":14,"plans":[[],[],[],[{"order_id":"1","amount":"1000000000000000000000"}]],"min_out":["0","0","0","0"],"to_lending":true}"#,
    ),
    (
        "conditional_buy",
        r#"{"action":"conditional_buy","scenario_id":1,"buy_mask":1,"plans":[[],[],[],[]],"min_out":["0","0","0","0"],"to_lending":false}"#,
    ),
    (
        "sell_and_borrow",
        r#"{"action":"sell_and_borrow","scenario_id":1,"sell_mask":14,"plans":[[],[],[],[]],"min_out":["0","0","0","0"],"borrow_amount":"3000000000000000000000"}"#,
    ),
    (
        "post_order",
        r#"{"action":"post_order","scenario_id":1,"mask":8,"side":"bid","price":"2450000000000000000","amount":"1000000000000000000000","expiry_sec":1795000000}"#,
    ),
    ("supply", r#"{"action":"supply","scenario_id":1}"#),
    ("repay", r#"{"action":"repay","scenario_id":1,"all":true}"#),
    (
        "deposit_collateral",
        r#"{"action":"deposit_collateral","scenario_id":1}"#,
    ),
    (
        "liquidate",
        r#"{"action":"liquidate","scenario_id":1,"account_id":"carl.x.testnet","repay_amount":"max"}"#,
    ),
    (
        "close_after_resolution",
        r#"{"action":"close_after_resolution","scenario_id":1}"#,
    ),
    (
        "lp_deposit",
        r#"{"action":"lp_deposit","scenario_id":1,"wnear_amount":"5000000000000000000000","min_shares":"0"}"#,
    ),
    ("spot_swap", r#"{"action":"spot_swap","min_out":"0"}"#),
];

#[test]
fn actions_not_built_yet_fail_and_refund() {
    let mut w = World::new();
    let built = [
        "supply",
        "repay",
        "deposit_collateral",
        "liquidate",
        "conditional_sell",
        "conditional_buy",
        "sell_and_borrow",
        "post_order",
        "close_after_resolution",
        "lp_deposit",
    ];
    for (action, msg) in DESIGN_MESSAGES.iter().filter(|(a, _)| !built.contains(a)) {
        let expected = match *action {
            // built, but there is no spot pool in this fixture
            "spot_swap" => "NoSpotPool".to_string(),
            _ => format!("NotImplemented({action})"),
        };
        fails(w.ft_transfer_call(ALICE, Usdc, 1_000_000, msg), &expected);
    }
    assert_eq!(w.wallet(ALICE, Usdc), FUND);
    assert_eq!(w.real(ALICE, Usdc), 0);
}

#[test]
fn design_messages_parse_to_the_right_actions() {
    for (_, msg) in DESIGN_MESSAGES {
        // every example round-trips
        let action = parse_msg(msg);
        assert_eq!(
            parse_msg(&near_sdk::serde_json::to_string(&action).unwrap()),
            action
        );
    }
    match parse_msg(DESIGN_MESSAGES[0].1) {
        Action::ConditionalSell(m) => {
            assert_eq!((m.scenario_id, m.sell_mask, m.to_lending), (1, 14, true));
            assert_eq!(
                m.plans[3],
                vec![PlanFill {
                    order_id: U64(1),
                    amount: U128(1_000 * E18)
                }]
            );
            assert_eq!(m.min_out, vec![U128(0); 4]);
        }
        other => panic!("{other:?}"),
    }
    match parse_msg(DESIGN_MESSAGES[3].1) {
        Action::PostOrder(m) => {
            assert_eq!(
                (m.mask, m.side, m.price, m.expiry_sec),
                (8, Side::Bid, U128(2_450 * E15), 1_795_000_000)
            );
        }
        other => panic!("{other:?}"),
    }
    match parse_msg(DESIGN_MESSAGES[7].1) {
        Action::Liquidate(m) => {
            assert_eq!(m.account_id.as_str(), "carl.x.testnet");
            assert_eq!(m.repay_amount, RepayAmount::Max(MaxKeyword::Max));
        }
        other => panic!("{other:?}"),
    }
    match parse_msg(
        r#"{"action":"liquidate","scenario_id":1,"account_id":"carl.near","repay_amount":"25"}"#,
    ) {
        Action::Liquidate(m) => assert_eq!(m.repay_amount, RepayAmount::Amount(U128(25))),
        other => panic!("{other:?}"),
    }
    match parse_msg(r#"{"action":"split","scenario_id":3,"to_masks":[5,10]}"#) {
        Action::Split(m) => assert_eq!((m.scenario_id, m.to_masks), (3, vec![5, 10])),
        other => panic!("{other:?}"),
    }
    assert_eq!(parse_msg(""), parse_msg(r#"{"action":"deposit"}"#));
}

#[test]
fn ids_and_amounts_must_be_strings_where_the_design_says_so() {
    let mut w = World::new();
    // order ids are U64 strings and amounts U128 strings
    let bad = [
        r#"{"action":"conditional_sell","scenario_id":1,"sell_mask":14,"plans":[[{"order_id":1,"amount":"1"}]],"min_out":["0"],"to_lending":true}"#,
        r#"{"action":"spot_swap","min_out":0}"#,
        r#"{"action":"liquidate","scenario_id":1,"account_id":"carl.near","repay_amount":"all"}"#,
        r#"{"action":"post_order","scenario_id":1,"mask":8,"side":"buy","price":"1","amount":"1","expiry_sec":1}"#,
    ];
    for msg in bad {
        fails_starting(w.ft_transfer_call(ALICE, Usdc, 1, msg), "BadMessage(");
    }
}

// A 24-decimal token (the testnet wNEAR): one internal unit is 10^6 raw units.

/// Raw units of a 24-decimal token per internal unit.
const RAW_PER_UNIT_24: u128 = 1_000_000;
/// One whole 24-decimal token, raw.
const E24: u128 = 1_000_000_000_000_000_000_000_000;

#[test]
fn conversions_at_every_supported_decimals() {
    let cfg = |d| wnear_cfg_with(d);
    // up to 18 decimals: exact in, rounded down out with the dust kept
    assert_eq!(
        cfg(6).to_internal(1_234_567),
        Some((1_234_567 * USDC_UNIT, 0))
    );
    assert_eq!(cfg(6).to_raw(USDC_UNIT + 7), Some((1, 7)));
    assert_eq!(cfg(6).to_internal(u128::MAX), None);
    assert_eq!(cfg(18).to_internal(5), Some((5, 0)));
    assert_eq!(cfg(18).to_raw(5), Some((5, 0)));
    assert_eq!(cfg(0).to_raw(E18 - 1), Some((0, E18 - 1)));
    // above 18: rounded down in with the raw remainder, exact out
    assert_eq!(
        cfg(24).to_internal(3 * E24 + 999_999),
        Some((3 * E18, 999_999))
    );
    assert_eq!(cfg(24).to_internal(999_999), Some((0, 999_999)));
    assert_eq!(
        cfg(24).to_raw(3 * E18 + 1),
        Some((3 * E24 + RAW_PER_UNIT_24, 0))
    );
    assert_eq!(cfg(24).to_raw(u128::MAX), None);
    // the smallest balance a payout can send
    assert_eq!(cfg(6).min_payable(), USDC_UNIT);
    assert_eq!(cfg(18).min_payable(), 1);
    assert_eq!(cfg(24).min_payable(), 1);
}

#[test]
fn a_24_decimal_deposit_is_exact() {
    let mut w = World::new_with_wnear_decimals(24);
    let wallet = w.wallet_raw(ALICE, Wnear);
    let unused = w.ft_transfer_call(ALICE, Wnear, 5 * E24, "").unwrap();
    assert_eq!(unused, 0);
    assert_eq!(w.real(ALICE, Wnear), 5 * E18);
    assert_eq!(w.held_raw(Wnear), 5 * E24);
    assert_eq!(w.wallet_raw(ALICE, Wnear), wallet - 5 * E24);
    assert_eq!(
        w.last.data_of("real_deposit"),
        vec![json!({"account_id": ALICE, "asset": "wnear", "amount": (5 * E18).to_string()})]
    );
}

/// The raw units below one internal unit never enter the ledger: the
/// receiver hands them back as unused, for a plain deposit and for an action.
#[test]
fn a_24_decimal_sub_unit_remainder_is_refunded() {
    let mut w = World::new_with_wnear_decimals(24);
    let wallet = w.wallet_raw(ALICE, Wnear);
    // 2.000000000000000001234567 wNEAR: 2e18 + 1 internal units and 234,567 raw left over
    let raw = 2 * E24 + 1_234_567;
    assert_eq!(w.ft_transfer_call(ALICE, Wnear, raw, "").unwrap(), 234_567);
    assert_eq!(w.real(ALICE, Wnear), 2 * E18 + 1);
    assert_eq!(w.held_raw(Wnear), 2 * E24 + RAW_PER_UNIT_24);
    assert_eq!(
        w.wallet_raw(ALICE, Wnear),
        wallet - 2 * E24 - RAW_PER_UNIT_24
    );
    // a split takes the whole internal units; the remainder comes back too
    let msg = r#"{"action":"split","scenario_id":1,"to_masks":[1,2,4,8]}"#;
    assert_eq!(w.ft_transfer_call(ALICE, Wnear, E24 + 42, msg).unwrap(), 42);
    for m in SINGLES {
        assert_eq!(w.bal(ALICE, 1, Wnear, m), E18);
    }
    assert_eq!(w.reserves(1, Wnear), E18);
    assert_eq!(w.real(ALICE, Wnear), 2 * E18 + 1);
    assert_eq!(w.held_raw(Wnear), 3 * E24 + RAW_PER_UNIT_24);
    // less than one internal unit is nothing to deposit: refunded in full
    fails(w.ft_transfer_call(ALICE, Wnear, 999_999, ""), "ZeroAmount");
    assert_eq!(w.held_raw(Wnear), 3 * E24 + RAW_PER_UNIT_24);
}

#[test]
fn a_24_decimal_payout_is_exact() {
    let mut w = World::new_with_wnear_decimals(24);
    let wallet = w.wallet_raw(ALICE, Wnear);
    w.deposit(ALICE, Wnear, 5 * E18 + 3).unwrap();
    w.auto_payouts = false;
    w.withdraw(ALICE, Wnear, 2 * E18 + 1).unwrap();
    let calls = w.last.calls();
    assert_eq!(calls[0].method, "ft_transfer");
    assert_eq!(
        calls[0].args,
        json!({"receiver_id": ALICE, "amount": (2 * E24 + RAW_PER_UNIT_24).to_string(), "memo": null})
    );
    w.run_payouts();
    // no dust: every internal unit is a whole number of raw units
    assert_eq!(w.real(ALICE, Wnear), 3 * E18 + 2);
    assert_eq!(
        w.wallet_raw(ALICE, Wnear),
        wallet - 3 * E24 - 2 * RAW_PER_UNIT_24
    );
    assert_eq!(w.held_raw(Wnear), 3 * E24 + 2 * RAW_PER_UNIT_24);
    // a single internal unit is still worth sending
    w.withdraw(ALICE, Wnear, 1).unwrap();
    assert_eq!(
        w.last.calls()[0].args["amount"],
        json!(RAW_PER_UNIT_24.to_string())
    );
}

#[test]
fn a_failed_24_decimal_payout_is_credited_back() {
    let mut w = World::new_with_wnear_decimals(24);
    w.deposit(ALICE, Wnear, 5 * E18).unwrap();
    w.ft_unregistered.insert(acc(ALICE));
    w.withdraw(ALICE, Wnear, 2 * E18).unwrap();
    assert_eq!(w.real(ALICE, Wnear), 5 * E18);
    assert_eq!(w.held_raw(Wnear), 5 * E24);
    assert_eq!(
        w.callbacks[0].data_of("payout_failed"),
        vec![json!({
            "account_id": ALICE,
            "asset": "wnear",
            "token_amount": (2 * E24).to_string(),
            "credited": (2 * E18).to_string(),
        })]
    );
    // registered again, the same balance withdraws in full
    w.ft_unregistered.clear();
    w.withdraw(ALICE, Wnear, 5 * E18).unwrap();
    assert_eq!(w.real(ALICE, Wnear), 0);
    assert_eq!(w.held_raw(Wnear), 0);
}

/// At 24 decimals every internal unit can be paid out, so even one blocks
/// `storage_unregister`; there is no wNEAR dust to sweep.
#[test]
fn one_internal_unit_of_24_decimal_wnear_blocks_unregister() {
    let mut w = World::new_with_wnear_decimals(24);
    w.deposit(ALICE, Wnear, 1).unwrap();
    assert_eq!(w.held_raw(Wnear), RAW_PER_UNIT_24);
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.storage_unregister(None)),
        "AccountNotEmpty(alice.near)",
    );
    w.withdraw(ALICE, Wnear, 1).unwrap();
    assert_eq!(w.held_raw(Wnear), 0);
    assert!(w
        .call(ALICE, ONE_YOCTO, |c| c.storage_unregister(None))
        .unwrap());
}
