//! NEP-145 and the per-call storage charging: the caller pays
//! for the bytes a call adds and gets back what it frees; owner methods may
//! pay with the attached deposit instead.

use near_sdk::json_types::U128;
use near_sdk::NearToken;

use super::harness::*;
use crate::storage::StorageBalance;
use crate::types::Asset::{Usdc, Weth};

const BYTE: u128 = 10_000_000_000_000_000_000; // 1e19 yoctoNEAR
const TENTH: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR
const ONE_NEAR: u128 = 10 * TENTH;

fn balance(w: &mut World, who: &str) -> Option<StorageBalance> {
    let who = acc(who);
    w.view(|c| c.storage_balance_of(who))
}

fn deposit(
    w: &mut World,
    payer: &str,
    account: Option<&str>,
    yocto: u128,
    registration_only: Option<bool>,
) -> Result<StorageBalance, String> {
    let account = account.map(acc);
    w.call(payer, NearToken::from_yoctonear(yocto), |c| {
        c.storage_deposit(account, registration_only)
    })
}

#[track_caller]
fn fails_starting(result: Result<impl Sized, String>, prefix: &str) -> String {
    match result {
        Ok(_) => panic!("expected `{prefix}...`, but the call succeeded"),
        Err(e) => {
            assert!(
                e.starts_with(prefix),
                "`{e}` does not start with `{prefix}`"
            );
            e
        }
    }
}

#[test]
fn storage_balance_bounds_min_is_a_tenth_of_a_near() {
    let mut w = World::new();
    let b = w.view(|c| c.storage_balance_bounds());
    assert_eq!(b.min, U128(TENTH));
    assert_eq!(b.max, None);
}

#[test]
fn storage_deposit_registers_and_refunds() {
    let mut w = World::new();
    assert_eq!(balance(&mut w, "dave.near"), None);
    fails(
        deposit(&mut w, "dave.near", None, TENTH / 2, None),
        &format!("InsufficientDeposit({}, {TENTH})", TENTH / 2),
    );

    // registration only: the minimum is kept, the rest goes back to the caller
    let b = deposit(&mut w, "dave.near", None, 5 * TENTH, Some(true)).unwrap();
    assert_eq!(w.last.near_transfers(), vec![(acc("dave.near"), 4 * TENTH)]);
    let used = w.storage_used("dave.near") as u128;
    // the record pays for itself
    assert!(used > 0);
    assert_eq!(
        b,
        StorageBalance {
            total: U128(TENTH),
            available: U128(TENTH - used * BYTE)
        }
    );

    // already registered: registration only refunds everything
    deposit(&mut w, "dave.near", None, TENTH, Some(true)).unwrap();
    assert_eq!(w.last.near_transfers(), vec![(acc("dave.near"), TENTH)]);
    // a top-up adds to the deposit and refunds nothing
    let b = deposit(&mut w, "dave.near", None, 2 * TENTH, None).unwrap();
    assert!(w.last.near_transfers().is_empty());
    assert_eq!(b.total, U128(3 * TENTH));
    assert_eq!(balance(&mut w, "dave.near"), Some(b));
}

#[test]
fn storage_deposit_for_someone_else() {
    let mut w = World::new();
    let b = deposit(&mut w, ALICE, Some("erin.near"), 3 * TENTH, Some(true)).unwrap();
    assert_eq!(b.total, U128(TENTH));
    // the refund goes to whoever paid
    assert_eq!(w.last.near_transfers(), vec![(acc(ALICE), 2 * TENTH)]);
    assert!(balance(&mut w, "erin.near").is_some());
}

#[test]
fn growth_is_charged_to_the_caller_and_shrinkage_credited_back() {
    let mut w = World::new();
    let start = w.storage_used(ALICE);
    let bob = w.storage_used(BOB);
    let total = balance(&mut w, ALICE).unwrap().total.0;

    w.split_ft(ALICE, 1, Weth, &SINGLES, E18).unwrap();
    let after_split = w.storage_used(ALICE);
    assert!(after_split > start);
    assert_eq!(
        balance(&mut w, ALICE).unwrap().available.0,
        total - after_split as u128 * BYTE
    );
    // nobody else paid
    assert_eq!(w.storage_used(BOB), bob);

    w.merge(ALICE, 1, Weth, &SINGLES, ROOT, E18).unwrap();
    let after_merge = w.storage_used(ALICE);
    // the balances and supplies are gone; the created markers and the
    // scenario's reserves slot stay, paid by whoever made them first
    assert!(after_merge < after_split);
    assert!(after_merge > start);

    // splitting again only pays for the balances and supplies
    w.split_ft(ALICE, 1, Weth, &SINGLES, E18).unwrap();
    assert_eq!(w.storage_used(ALICE), after_split);
}

#[test]
fn a_transfer_pays_for_the_receivers_new_entry() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Weth, &[SHIPS, DELAYED], E18).unwrap();
    let (alice, bob) = (w.storage_used(ALICE), w.storage_used(BOB));
    w.mt_transfer(ALICE, BOB, &token_id(1, Weth, SHIPS), 1)
        .unwrap();
    let entry = w.storage_used(ALICE) - alice;
    assert!(entry > 0);
    assert_eq!(w.storage_used(BOB), bob);
    // whoever frees an entry gets its bytes back, down to zero: the sum of
    // what accounts are charged never falls below the bytes they use
    w.mt_transfer(BOB, ALICE, &token_id(1, Weth, SHIPS), 1)
        .unwrap();
    assert_eq!(w.storage_used(BOB), bob.saturating_sub(entry));
    assert_eq!(w.storage_used(ALICE), alice + entry);
}

#[test]
fn insufficient_storage_rolls_the_call_back() {
    let mut w = World::new();
    deposit(&mut w, "dave.near", None, TENTH, None).unwrap();
    w.call("dave.near", ONE_YOCTO, |c| c.storage_withdraw(None))
        .unwrap();
    assert_eq!(balance(&mut w, "dave.near").unwrap().available, U128(0));
    w.fund("dave.near");
    let wallet = w.wallet("dave.near", Weth);
    let err = fails_starting(
        w.split_ft("dave.near", 1, Weth, &SINGLES, E18),
        "InsufficientStorage(",
    );
    assert!(err.ends_with(", 0)"), "{err}");
    // the token contract refunds the whole transfer
    assert_eq!(w.wallet("dave.near", Weth), wallet);
    assert_eq!(w.reserves(1, Weth), 0);
}

#[test]
fn unregistered_sender_is_refunded() {
    let mut w = World::new();
    w.fund("dave.near");
    fails(
        w.split_ft("dave.near", 1, Weth, &SINGLES, E18),
        "NotRegistered(dave.near)",
    );
    fails(
        w.deposit("dave.near", Usdc, E18),
        "NotRegistered(dave.near)",
    );
    assert_eq!(w.wallet("dave.near", Weth), FUND);
    assert_eq!(w.held_by_contract(Weth), 0);
}

#[test]
fn storage_withdraw() {
    let mut w = World::new();
    fails(
        w.call(ALICE, NO_DEPOSIT, |c| c.storage_withdraw(None)),
        "Requires attached deposit of exactly 1 yoctoNEAR",
    );
    fails(
        w.call("dave.near", ONE_YOCTO, |c| c.storage_withdraw(None)),
        "NotRegistered(dave.near)",
    );
    let available = balance(&mut w, ALICE).unwrap().available.0;
    fails(
        w.call(ALICE, ONE_YOCTO, |c| {
            c.storage_withdraw(Some(U128(available + 1)))
        }),
        &format!("WithdrawExceedsAvailable({}, {available})", available + 1),
    );
    let b = w
        .call(ALICE, ONE_YOCTO, |c| c.storage_withdraw(Some(U128(TENTH))))
        .unwrap();
    assert_eq!(w.last.near_transfers(), vec![(acc(ALICE), TENTH)]);
    assert_eq!(b.total, U128(ONE_NEAR - TENTH));
    assert_eq!(b.available, U128(available - TENTH));
    // what is in use cannot leave
    let b = w
        .call(ALICE, ONE_YOCTO, |c| c.storage_withdraw(None))
        .unwrap();
    assert_eq!(b.available, U128(0));
    assert_eq!(b.total.0, w.storage_used(ALICE) as u128 * BYTE);
}

#[test]
fn storage_unregister() {
    let mut w = World::new();
    fails(
        w.call(CAROL, NO_DEPOSIT, |c| c.storage_unregister(None)),
        "Requires attached deposit of exactly 1 yoctoNEAR",
    );
    fails(
        w.call(CAROL, ONE_YOCTO, |c| c.storage_unregister(Some(true))),
        "ForceUnregisterUnsupported",
    );
    assert!(!w
        .call("dave.near", ONE_YOCTO, |c| c.storage_unregister(None))
        .unwrap());

    // an account that never stored anything gets its whole deposit back
    assert!(w
        .call(CAROL, ONE_YOCTO, |c| c.storage_unregister(Some(false)))
        .unwrap());
    assert_eq!(w.last.near_transfers(), vec![(acc(CAROL), ONE_NEAR)]);
    assert_eq!(balance(&mut w, CAROL), None);

    // holding verse tokens or a real balance blocks it
    w.split_ft(ALICE, 1, Weth, &[SHIPS, DELAYED], E18).unwrap();
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.storage_unregister(None)),
        "AccountNotEmpty(alice.near)",
    );
    w.merge(ALICE, 1, Weth, &[SHIPS, DELAYED], ROOT, E18)
        .unwrap();
    w.deposit(ALICE, Usdc, E18).unwrap();
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.storage_unregister(None)),
        "AccountNotEmpty(alice.near)",
    );
    w.withdraw(ALICE, Usdc, E18).unwrap();

    // bytes alice paid for that outlive her (created markers, the reserves
    // slot) stay paid for out of her deposit
    let used = w.storage_used(ALICE) as u128;
    let total = balance(&mut w, ALICE).unwrap().total.0;
    assert!(w
        .call(ALICE, ONE_YOCTO, |c| c.storage_unregister(None))
        .unwrap());
    let refund = w.last.near_transfers()[0].1;
    let kept = (total - refund) / BYTE;
    // more than nothing (those entries), less than everything (the record
    // itself is gone and refunded)
    assert!(kept > 0 && kept < used, "kept {kept} of {used} bytes");
    assert_eq!(balance(&mut w, ALICE), None);
}

#[test]
fn owner_methods_can_pay_with_the_attached_deposit() {
    let mut w = World::new();
    let owner_used = w.storage_used(OWNER);
    let names = || vec!["YES".to_string(), "NO".to_string()];
    w.call(OWNER, NearToken::from_near(1), |c| {
        c.create_event("q".into(), names(), "r".into(), 0)
    })
    .unwrap();
    let refunds = w.last.near_transfers();
    assert_eq!(refunds.len(), 1);
    assert_eq!(refunds[0].0, acc(OWNER));
    let paid = ONE_NEAR - refunds[0].1;
    assert!(paid > 0 && paid % BYTE == 0);
    // the deposit paid, so the owner's storage balance did not
    assert_eq!(w.storage_used(OWNER), owner_used);

    fails_starting(
        w.call(OWNER, ONE_YOCTO, |c| {
            c.create_event("q".into(), names(), "r".into(), 0)
        }),
        "InsufficientStorage(",
    );
    // with nothing attached the owner's NEP-145 balance pays
    w.call(OWNER, NO_DEPOSIT, |c| {
        c.create_event("q".into(), names(), "r".into(), 0)
    })
    .unwrap();
    assert!(w.storage_used(OWNER) > owner_used);
    assert!(w.last.near_transfers().is_empty());
}

#[test]
fn demo_record_is_charged_to_the_owner() {
    let mut w = World::new();
    assert_eq!(w.view(|c| c.get_app_config()).demo, None);
    let before = w.storage_used(OWNER);
    let record = r#"{"glam_event":1,"fed_event":2,"past_fed_event":null,"scenario_2x2":1,"scenario_binary":2}"#;
    w.call(OWNER, ONE_YOCTO, |c| c.set_demo_record(record.into()))
        .unwrap();
    assert!(w.storage_used(OWNER) > before);
    let demo = w.view(|c| c.get_app_config()).demo.unwrap();
    assert_eq!(demo["scenario_2x2"], 1);
    assert!(demo["past_fed_event"].is_null());
    // clearing it gives the bytes back
    w.call(OWNER, ONE_YOCTO, |c| c.set_demo_record(String::new()))
        .unwrap();
    assert_eq!(w.storage_used(OWNER), before);
    assert_eq!(w.view(|c| c.get_app_config()).demo, None);

    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.set_demo_record("{}".into())),
        "OwnableUnauthorizedAccount(alice.near)",
    );
    fails(
        w.call(OWNER, NO_DEPOSIT, |c| c.set_demo_record("{}".into())),
        "Requires attached deposit of exactly 1 yoctoNEAR",
    );
    fails(
        w.call(OWNER, ONE_YOCTO, |c| c.set_demo_record("[1]".into())),
        "BadDemoRecord(not a JSON object)",
    );
    fails_starting(
        w.call(OWNER, ONE_YOCTO, |c| c.set_demo_record("{".into())),
        "BadDemoRecord(EOF",
    );
}

#[test]
fn app_config_reports_the_configuration() {
    let mut w = World::new();
    let cfg = w.view(|c| c.get_app_config());
    assert_eq!(cfg.owner_id, acc(OWNER));
    assert_eq!(cfg.reporter_id, Some(acc(REPORTER)));
    assert_eq!(cfg.weth, weth_cfg());
    assert_eq!(cfg.usdc, usdc_cfg());
    assert_eq!(cfg.lltv, U128(750_000_000_000_000_000));
    assert_eq!(cfg.liquidation_bonus, U128(50_000_000_000_000_000));
    assert_eq!(cfg.borrow_rate_per_sec, U128(1_585_489_599));
    assert_eq!(cfg.dispute_window_sec, DISPUTE_WINDOW);
    assert_eq!(cfg.twap_window_sec, 60);
    assert_eq!(cfg.min_pool_depth, U128(10_000 * E18));
    assert_eq!((cfg.fee_base_pips, cfg.fee_cap_pips), (3_000, 15_000));
    // not built yet
    assert!(!cfg.order_book && !cfg.root_lp);
    assert_eq!(cfg.spot_pool_id, None);
    assert_eq!((cfg.event_count, cfg.scenario_count), (2, 2));
    assert_eq!(w.view(|c| c.owner_id()), acc(OWNER));
}
