//! Insurance (F8, first half): each market's reserve, built from a cut of
//! the interest and from donations, never lent, spent first on write-offs.
//! The owner can take it back only from a frozen market nobody owes.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::NearToken;

use super::harness::*;
use super::lending::*;
use super::tiers::*;
use crate::lending::tiers::Tier;
use crate::ops::PauseFlag;
use crate::types::Asset::Usdc;
use crate::types::WAD;

fn withdraw(w: &mut World, who: &str, sid: u64, tier: Tier, amount: u128) -> Result<U128, String> {
    w.call(who, ONE_YOCTO, |c| {
        c.withdraw_insurance(sid, tier, U128(amount))
    })
}

#[test]
fn withdraw_insurance_checks_in_order() {
    let mut w = tier_world();
    let s = w.s2x2;
    w.lend_in(Tier::Bold, BOB, s, 10_000 * E18).unwrap();
    w.fund_insurance_in(Tier::Bold, DAVE, s, 500 * E18).unwrap();
    w.post_real_in(Tier::Bold, ALICE, s, Usdc, 1_000 * E18)
        .unwrap();
    w.borrow_in(Tier::Bold, ALICE, s, 200 * E18).unwrap();
    w.call(OWNER, NO_DEPOSIT, |c| c.pause.flags = PauseFlag::Exit.bit())
        .unwrap();
    fails(withdraw(&mut w, OWNER, s, Tier::Bold, E18), "Paused(exit)");
    w.call(OWNER, NO_DEPOSIT, |c| c.pause.flags = 0).unwrap();
    fails(
        withdraw(&mut w, ALICE, s, Tier::Bold, E18),
        &format!("NotOwner({ALICE})"),
    );
    fails(
        withdraw(&mut w, OWNER, 999, Tier::Bold, E18),
        "UnknownScenario(999)",
    );
    fails(
        withdraw(&mut w, OWNER, s, Tier::Bold, E18),
        &format!("MarketNotFrozen({s}, bold)"),
    );
    w.call(OWNER, ONE_YOCTO, |c| {
        c.set_market_frozen(s, Tier::Bold, true)
    })
    .unwrap();
    let tbs = w.market_in(Tier::Bold, s).total_borrow_shares;
    fails(
        withdraw(&mut w, OWNER, s, Tier::Bold, E18),
        &format!("InsuranceLocked({tbs})"),
    );
    w.repay_in(Tier::Bold, ALICE, s, 300 * E18, true).unwrap();
    let insurance = w.state_in(Tier::Bold, s).insurance;
    assert!(insurance >= 500 * E18);
    fails(
        withdraw(&mut w, OWNER, s, Tier::Bold, insurance + 1),
        &format!("InsufficientInsurance({}, {insurance})", insurance + 1),
    );
    let before = w.real(OWNER, Usdc);
    assert_eq!(
        withdraw(&mut w, OWNER, s, Tier::Bold, 400 * E18).unwrap(),
        U128(400 * E18)
    );
    assert_eq!(w.real(OWNER, Usdc), before + 400 * E18);
    assert_eq!(w.state_in(Tier::Bold, s).insurance, insurance - 400 * E18);
    assert_eq!(
        w.last.data_of("insurance_withdrawn")[0],
        json!({"scenario_id": s, "tier": "bold", "amount": (400 * E18).to_string(), "to": OWNER})
    );
    // The owner withdraws it like any internal balance.
    w.withdraw(OWNER, Usdc, 400 * E18).unwrap();
}

#[test]
fn insurance_is_never_lent() {
    let mut w = tier_world();
    let s = w.s2x2;
    w.lend_in(Tier::Normal, BOB, s, 1_000 * E18).unwrap();
    w.fund_insurance_in(Tier::Normal, DAVE, s, 5_000 * E18)
        .unwrap();
    w.post_real(ALICE, s, Usdc, 100_000 * E18).unwrap();
    // 900 is the utilization cap of Bob's 1,000; the 5,000 of insurance adds nothing.
    let view = w.view(|c| c.market_state(s, None));
    assert_eq!(
        (view.liquid.0, view.insurance.0),
        (1_000 * E18, 5_000 * E18)
    );
    fails(
        w.borrow_in(Tier::Normal, ALICE, s, 1_001 * E18),
        &format!("InsufficientLiquidity({}, {})", 1_001 * E18, 1_000 * E18),
    );
    fails(
        w.withdraw_lent(BOB, s, Some(1_001 * E18)),
        &format!("InsufficientSupply({}, {})", 1_001 * E18, 1_000 * E18),
    );
    // Lenders do not earn on it either: the utilization reads the supply only.
    w.borrow_in(Tier::Normal, ALICE, s, 500 * E18).unwrap();
    let view = w.view(|c| c.market_state(s, None));
    assert_eq!(view.utilization.0, WAD / 2);
}

#[test]
fn insurance_falls_only_through_write_offs_and_the_owner() {
    // L-10: interest, supply, withdrawals, borrowing, repayment and
    // liquidations without a write-off never lower it.
    let mut w = tier_world();
    let s = w.s2x2;
    w.lend_in(Tier::Normal, BOB, s, 10_000 * E18).unwrap();
    w.fund_insurance_in(Tier::Normal, DAVE, s, 100 * E18)
        .unwrap();
    let mut last = w.state_in(Tier::Normal, s).insurance;
    let mut check = |w: &mut World| {
        let now = w.view(|c| c.market_state(s, None)).insurance.0;
        assert!(now >= last, "{now} < {last}");
        last = now;
    };
    wnear_loan(
        &mut w,
        Tier::Normal,
        ALICE,
        1_000 * E18,
        1_000 * E18,
        1_350 * E18,
    );
    check(&mut w);
    w.warp(30 * DAY);
    check(&mut w);
    w.lend_in(Tier::Normal, CAROL, s, 1_000 * E18).unwrap();
    check(&mut w);
    w.withdraw_lent(CAROL, s, Some(500 * E18)).unwrap();
    check(&mut w);
    w.liquidate_with(Tier::Normal, CAROL, s, ALICE, None, 1_000 * E18)
        .unwrap();
    check(&mut w);
    w.repay_in(Tier::Normal, ALICE, s, 100 * E18, false)
        .unwrap();
    check(&mut w);
}

#[test]
fn the_last_share_takes_the_principal_after_a_loss() {
    // v1 left principal > 0 behind after a socialized loss, which blocked
    // storage_unregister for good.
    let mut w = tier_world();
    let s = w.s2x2;
    w.register("erin.near", NearToken::from_near(1));
    w.fund("erin.near");
    w.lend_in(Tier::Normal, BOB, s, 9_000 * E18).unwrap();
    w.lend_in(Tier::Normal, "erin.near", s, 1_000 * E18)
        .unwrap();
    wnear_loan(
        &mut w,
        Tier::Normal,
        ALICE,
        1_000 * E18,
        1_000 * E18,
        500 * E18,
    );
    w.liquidate_with(Tier::Normal, CAROL, s, ALICE, None, 1_000 * E18)
        .unwrap();
    let lent = w.lent_in(Tier::Normal, s, "erin.near");
    assert!(lent < 1_000 * E18);
    assert_eq!(
        w.view(|c| c.supply_principal_of(s, acc("erin.near"), None)),
        U128(1_000 * E18)
    );
    w.withdraw_lent("erin.near", s, None).unwrap();
    assert_eq!(
        w.view(|c| c.supply_principal_of(s, acc("erin.near"), None)),
        U128(0)
    );
    assert!(w
        .call("erin.near", ONE_YOCTO, |c| c.storage_unregister(None))
        .unwrap());
}
