//! Bad debt (F8): a liquidation that takes every piece writes the rest of
//! the debt off in the same call, and `write_off_bad_debt` does it for an
//! account whose collateral is worth nothing; the market's insurance covers
//! first and the lenders take the rest through the share price, while the
//! market's cash does not move. A market whose supply is wiped out freezes.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;

use super::harness::*;
use super::lending::*;
use super::tiers::*;
use crate::lending::tiers::{MarketId, Tier};
use crate::lending::CollateralKey;
use crate::ops::PauseFlag;
use crate::types::Asset::{Usdc, Wnear};
use crate::types::WAD;

/// The market's cash: supply plus insurance minus borrows (L-1).
fn cash(w: &mut World, tier: Tier, sid: u64) -> u128 {
    let m = w.market_in(tier, sid);
    let st = w.state_in(tier, sid);
    m.total_supply_assets + st.insurance - m.total_borrow_assets
}

/// Bob lends 10,000 in `tier`; Alice borrows 1,000 against 1,000 wNEAR,
/// which then falls to `value`; Dave funds `insurance`.
fn underwater(tier: Tier, value: u128, insurance: u128) -> World {
    let mut w = tier_world();
    let s = w.s2x2;
    w.lend_in(tier, BOB, s, 10_000 * E18).unwrap();
    if insurance > 0 {
        w.fund_insurance_in(tier, DAVE, s, insurance).unwrap();
    }
    wnear_loan(&mut w, tier, ALICE, 1_000 * E18, 1_000 * E18, value);
    w
}

#[test]
fn a_full_seizure_writes_the_rest_off_insurance_first() {
    let mut w = underwater(Tier::Normal, 600 * E18, 100 * E18);
    let s = w.s2x2;
    let tsa = w.market_in(Tier::Normal, s).total_supply_assets;
    let cash_before = cash(&mut w, Tier::Normal, s);
    assert_eq!(w.view(|c| c.borrower_count(s, None)), 1);
    let l = w
        .liquidate_with(Tier::Normal, CAROL, s, ALICE, None, 1_000 * E18)
        .unwrap();
    assert!(l.seize_all);
    let bad = 1_000 * E18 - l.repaid;
    assert_eq!(l.written_off, bad);
    // Cash grows by the repayment only: the write-off moves none.
    assert_eq!(cash(&mut w, Tier::Normal, s), cash_before + l.repaid);
    // Insurance first (100), then the lenders' supply, exactly.
    let st = w.state_in(Tier::Normal, s);
    assert_eq!(st.insurance, 0);
    assert_eq!(st.bad_debt_covered, 100 * E18);
    assert_eq!(st.bad_debt_socialized, bad - 100 * E18);
    assert_eq!(
        w.market_in(Tier::Normal, s).total_supply_assets,
        tsa - (bad - 100 * E18)
    );
    // The account ends with no shares and no index entry.
    assert_eq!(w.debt_in(Tier::Normal, s, ALICE), 0);
    assert_eq!(w.view(|c| c.borrower_count(s, None)), 0);
    assert!(w.pieces_in(Tier::Normal, s, ALICE).is_empty());
    let logged = &w.last.data_of("bad_debt")[0];
    assert_eq!(
        *logged,
        json!({
            "scenario_id": s, "tier": "normal", "account_id": ALICE, "caller_id": CAROL,
            "debt": bad.to_string(), "covered": (100 * E18).to_string(),
            "socialized": (bad - 100 * E18).to_string(), "insurance_after": "0",
            "total_supply_after": (tsa - (bad - 100 * E18)).to_string(),
        })
    );
    // The liquidation line reports the write-off.
    let liq = &w.last.data_of("liquidate")[0];
    assert_eq!(liq["seize_all"], true);
    assert_eq!(liq["written_off"], bad.to_string());
    assert_eq!(liq["receive"], "tokens");
    assert_eq!(liq["price_factor"], WAD.to_string());
}

#[test]
fn insurance_alone_can_cover_a_write_off() {
    let mut w = underwater(Tier::Safe, 400 * E18, 1_000 * E18);
    let s = w.s2x2;
    let tsa = w.market_in(Tier::Safe, s).total_supply_assets;
    let l = w
        .liquidate_with(Tier::Safe, CAROL, s, ALICE, None, 1_000 * E18)
        .unwrap();
    let bad = l.written_off;
    assert!(bad > 0);
    let st = w.state_in(Tier::Safe, s);
    assert_eq!(st.insurance, 1_000 * E18 - bad);
    assert_eq!((st.bad_debt_covered, st.bad_debt_socialized), (bad, 0));
    assert_eq!(w.market_in(Tier::Safe, s).total_supply_assets, tsa);
    assert_eq!(w.lent_in(Tier::Safe, s, BOB), 10_000 * E18);
}

/// Alice's piece list is replaced by `pieces` (her real USDC piece goes back
/// to her internal balance): a v1 leftover, which v2 itself never produces.
fn leave_only(w: &mut World, tier: Tier, pieces: Vec<(CollateralKey, u128)>) {
    let s = w.s2x2;
    let alice = acc(ALICE);
    w.call(OWNER, NO_DEPOSIT, |c| {
        let id = MarketId::new(s, Some(tier));
        let old = c.pieces(id, &alice);
        for (k, a) in &old {
            if let CollateralKey::Real(asset) = k {
                c.real_credit(&alice, *asset, *a);
            }
        }
        c.set_pieces(id, &alice, pieces);
    })
    .unwrap();
}

#[test]
fn write_off_bad_debt_takes_debt_without_collateral() {
    let mut w = tier_world();
    let s = w.s2x2;
    w.lend_in(Tier::Bold, BOB, s, 10_000 * E18).unwrap();
    w.post_real_in(Tier::Bold, ALICE, s, Usdc, 1_000 * E18)
        .unwrap();
    w.borrow_in(Tier::Bold, ALICE, s, 300 * E18).unwrap();
    let write_off = |w: &mut World, who: &str, account: &str| {
        let account = acc(account);
        w.call(who, ONE_YOCTO, |c| {
            c.write_off_bad_debt(s, account, Some(Tier::Bold))
        })
    };
    fails(
        write_off(&mut w, CAROL, ALICE),
        &format!("StillCollateralized({})", 1_000 * E18),
    );
    fails(write_off(&mut w, CAROL, BOB), &format!("NoDebt({BOB})"));
    fails(
        w.call(CAROL, ONE_YOCTO, |c| {
            c.write_off_bad_debt(999, acc(ALICE), None)
        }),
        "UnknownScenario(999)",
    );
    fails(
        w.call(CAROL, NO_DEPOSIT, |c| {
            c.write_off_bad_debt(s, acc(ALICE), Some(Tier::Bold))
        }),
        "Requires attached deposit of exactly 1 yoctoNEAR",
    );
    leave_only(&mut w, Tier::Bold, Vec::new());
    w.call(OWNER, NO_DEPOSIT, |c| {
        c.pause.flags = PauseFlag::Liquidate.bit()
    })
    .unwrap();
    fails(write_off(&mut w, CAROL, ALICE), "Paused(liquidate)");
    w.call(OWNER, NO_DEPOSIT, |c| c.pause.flags = 0).unwrap();
    // It works while halted.
    let fed = w.fed;
    w.report(fed, OUT_CUTS).unwrap();
    let used = w.storage_used(CAROL);
    let bad = write_off(&mut w, CAROL, ALICE).unwrap().0;
    assert_eq!(bad, 300 * E18);
    assert_eq!(w.debt_in(Tier::Bold, s, ALICE), 0);
    assert_eq!(w.view(|c| c.borrower_count(s, Some(Tier::Bold))), 0);
    assert_eq!(w.last.data_of("bad_debt")[0]["caller_id"], CAROL);
    // The freed bytes go to the caller.
    assert!(w.storage_used(CAROL) <= used);
    assert_eq!(w.state_in(Tier::Bold, s).bad_debt_socialized, 300 * E18);
}

#[test]
fn dead_pieces_are_worth_nothing_and_stay_with_the_account() {
    let mut w = tier_world();
    let s = w.s2x2;
    w.lend_in(Tier::Normal, BOB, s, 10_000 * E18).unwrap();
    w.split_ft(ALICE, s, Usdc, &[CUTS, HOLDS], 500 * E18)
        .unwrap();
    let cuts = token_id(s, Usdc, CUTS);
    w.post(ALICE, s, &cuts, 500 * E18).unwrap();
    w.post_real(ALICE, s, Usdc, 1_000 * E18).unwrap();
    w.borrow_in(Tier::Normal, ALICE, s, 200 * E18).unwrap();
    let piece = CollateralKey::Verse {
        asset: Usdc,
        mask: CUTS,
    };
    leave_only(&mut w, Tier::Normal, vec![(piece, 500 * E18)]);
    let write_off = |w: &mut World| {
        w.call(CAROL, ONE_YOCTO, |c| {
            c.write_off_bad_debt(s, acc(ALICE), None)
        })
    };
    fails(
        write_off(&mut w),
        &format!("StillCollateralized({})", 500 * E18),
    );
    let fed = w.fed;
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    let ready = w.view(|c| c.liquidation_status(s, acc(ALICE), None));
    assert!(ready.write_off_ready);
    assert_eq!(write_off(&mut w).unwrap().0, 200 * E18);
    // The dead piece stays, and once nothing is owed it can be taken back.
    assert_eq!(
        w.pieces_in(Tier::Normal, s, ALICE),
        vec![(piece, 500 * E18)]
    );
    w.unpost(ALICE, s, &cuts, 500 * E18).unwrap();
    w.assert_conservation(&[ALICE, BOB, CAROL, DAVE, OWNER]);
}

#[test]
fn unpriced_collateral_is_never_written_off() {
    let mut w = tier_world();
    let s = w.s2x2;
    w.lend_in(Tier::Normal, BOB, s, 10_000 * E18).unwrap();
    w.post_real(ALICE, s, Wnear, 1_000 * E18).unwrap();
    w.borrow_in(Tier::Normal, ALICE, s, 300 * E18).unwrap();
    set_unpriced(s, 2);
    for world in [0, 1, 3] {
        set_price(s, world, 0);
    }
    fails(
        w.call(CAROL, ONE_YOCTO, |c| {
            c.write_off_bad_debt(s, acc(ALICE), None)
        }),
        "PriceUnavailable(2)",
    );
    assert!(
        !w.view(|c| c.liquidation_status(s, acc(ALICE), None))
            .write_off_ready
    );
    // Priced at zero everywhere, the same wNEAR is worth nothing.
    set_price(s, 2, 0);
    w.call(CAROL, ONE_YOCTO, |c| {
        c.write_off_bad_debt(s, acc(ALICE), None)
    })
    .unwrap();
    assert_eq!(w.debt_in(Tier::Normal, s, ALICE), 0);
}

#[test]
fn a_wiped_out_market_freezes() {
    let mut w = tier_world();
    let s = w.s2x2;
    w.lend_in(Tier::Normal, BOB, s, 1_000 * E18).unwrap();
    w.post_real(ALICE, s, Wnear, 1_000 * E18).unwrap();
    flat_price(s, 2 * WAD);
    w.borrow_in(Tier::Normal, ALICE, s, 900 * E18).unwrap();
    w.withdraw_lent(BOB, s, Some(100 * E18)).unwrap();
    flat_price(s, 0);
    w.call(CAROL, ONE_YOCTO, |c| {
        c.write_off_bad_debt(s, acc(ALICE), None)
    })
    .unwrap();
    let m = w.market_in(Tier::Normal, s);
    assert_eq!(m.total_supply_assets, 0);
    assert!(m.total_supply_shares > 0);
    assert!(w.state_in(Tier::Normal, s).frozen);
    assert_eq!(w.lent_in(Tier::Normal, s, BOB), 0);
    fails(
        w.lend_in(Tier::Normal, CAROL, s, 10 * E18),
        &format!("MarketFrozen({s}, normal)"),
    );
    // Unfrozen, a deposit would mint shares at a zero price: refused.
    w.call(OWNER, ONE_YOCTO, |c| {
        c.set_market_frozen(s, Tier::Normal, false)
    })
    .unwrap();
    fails(
        w.lend_in(Tier::Normal, CAROL, s, 10 * E18),
        &format!("MarketWipedOut({s}, normal)"),
    );
    // The scenario's other tiers are not affected.
    w.lend_in(Tier::Safe, CAROL, s, 10 * E18).unwrap();
}

#[test]
fn write_offs_add_up_to_what_insurance_and_lenders_paid() {
    // L-15 over several write-offs in one market.
    let mut w = tier_world();
    let s = w.s2x2;
    w.lend_in(Tier::Bold, BOB, s, 100_000 * E18).unwrap();
    w.fund_insurance_in(Tier::Bold, DAVE, s, 150 * E18).unwrap();
    let mut written = 0;
    for (who, value) in [(ALICE, 700 * E18), (CAROL, 300 * E18), (DAVE, 900 * E18)] {
        wnear_loan(&mut w, Tier::Bold, who, 1_000 * E18, 1_000 * E18, value);
        let l = w
            .liquidate_with(Tier::Bold, BOB, s, who, None, 1_000 * E18)
            .unwrap();
        written += l.written_off;
        let st = w.state_in(Tier::Bold, s);
        assert_eq!(st.bad_debt_covered + st.bad_debt_socialized, written);
    }
    let st = w.state_in(Tier::Bold, s);
    assert_eq!(st.bad_debt_covered, 150 * E18);
    let view = w.view(|c| c.market_state(s, Some(Tier::Bold)));
    assert_eq!(view.bad_debt_covered, U128(150 * E18));
    assert_eq!(view.bad_debt_socialized.0, written - 150 * E18);
}
