//! The borrower index (F1): exactly the accounts with debt per market,
//! dense, kept by the one writer of borrow shares; the paged `borrowers`
//! view with its at-risk filter and write-off-ready rows, and its gas at 8
//! worlds x 20 pieces. Then lending's part of `migrate` on production's
//! state: the legacy tier configs, Carl indexed and proved, a straggler's
//! gap, a tampered index, and Carl's liquidation in both modes.

use std::collections::BTreeSet;

use multiverse_math::shares::to_shares_up;
use near_sdk::borsh::{self, BorshDeserialize};
use near_sdk::json_types::U128;
use near_sdk::{env, AccountId, NearToken};

use super::harness::*;
use super::lending::*;
use super::migration::{migrated_prod, prod_account, prod_args, Prod, PROD_CONTRACT, PROD_OWNER};
use super::tiers::*;
use crate::lending::tiers::{MarketId, Tier, TierConfig, TierState};
use crate::lending::{CollateralKey, LiquidationState};
use crate::ops::PauseFlag;
use crate::types::Asset::{Usdc, Wnear};
use crate::types::WAD;

/// The index of `id` as stored: (count, slots in order), and checks that it
/// is dense and its positions agree.
fn index_of(w: &mut World, id: MarketId) -> Vec<AccountId> {
    w.view(|c| {
        let n = c.borrower_count_of(id);
        let slots: Vec<AccountId> = (0..n)
            .map(|i| c.borrower_at.get(&(id.key(), i)).cloned().expect("dense"))
            .collect();
        for (i, a) in slots.iter().enumerate() {
            assert_eq!(
                c.borrower_pos.get(&(id.key(), a.clone())),
                Some(&(i as u32))
            );
        }
        assert!(c.borrower_at.get(&(id.key(), n)).is_none());
        slots
    })
}

/// L-3: the index holds exactly the accounts with borrow shares.
fn assert_index(w: &mut World, id: MarketId, accounts: &[&str]) {
    let slots: BTreeSet<AccountId> = index_of(w, id).into_iter().collect();
    let owing: BTreeSet<AccountId> = accounts
        .iter()
        .map(|a| acc(a))
        .filter(|a| w.view(|c| c.borrow_shares_of(id, a)) > 0)
        .collect();
    assert_eq!(slots, owing);
}

const ERIN: &str = "erin.near";

fn index_world() -> World {
    let mut w = tier_world();
    let s = w.s2x2;
    w.register(ERIN, NearToken::from_near(5));
    w.fund(ERIN);
    w.lend_in(Tier::Normal, BOB, s, 100_000 * E18).unwrap();
    w
}

#[test]
fn the_index_keeps_exactly_the_borrowers_and_stays_dense() {
    let mut w = index_world();
    let s = w.s2x2;
    let id = MarketId::new(s, None);
    let who = [ALICE, CAROL, DAVE, ERIN];
    for a in who {
        w.post_real(a, s, Usdc, 1_000 * E18).unwrap();
        w.borrow_in(Tier::Normal, a, s, 100 * E18).unwrap();
    }
    assert_eq!(
        index_of(&mut w, id),
        who.iter().map(|a| acc(a)).collect::<Vec<_>>()
    );
    assert_eq!(w.view(|c| c.borrower_count(s, None)), 4);
    // Removing the first moves the last into its slot.
    w.repay_in(Tier::Normal, ALICE, s, 200 * E18, true).unwrap();
    assert_eq!(index_of(&mut w, id), vec![acc(ERIN), acc(CAROL), acc(DAVE)]);
    // The middle.
    w.repay_in(Tier::Normal, CAROL, s, 200 * E18, true).unwrap();
    assert_eq!(index_of(&mut w, id), vec![acc(ERIN), acc(DAVE)]);
    // The last.
    w.repay_in(Tier::Normal, DAVE, s, 200 * E18, true).unwrap();
    assert_eq!(index_of(&mut w, id), vec![acc(ERIN)]);
    // A top-up or partial repayment keeps the slot.
    w.borrow_in(Tier::Normal, ERIN, s, 50 * E18).unwrap();
    w.repay_in(Tier::Normal, ERIN, s, 20 * E18, false).unwrap();
    assert_eq!(index_of(&mut w, id), vec![acc(ERIN)]);
    assert_index(&mut w, id, &[ALICE, BOB, CAROL, DAVE, ERIN]);
    // The count entry goes at zero.
    w.repay_in(Tier::Normal, ERIN, s, 200 * E18, true).unwrap();
    assert!(index_of(&mut w, id).is_empty());
    assert!(w.view(|c| c.borrower_count.get(&id.key()).is_none()));
    // Other tiers have their own index.
    w.borrow_in(Tier::Normal, ALICE, s, 100 * E18).unwrap();
    assert_eq!(w.view(|c| c.borrower_count(s, Some(Tier::Safe))), 0);
    assert_eq!(w.view(|c| c.market_state(s, None)).borrowers, 1);
}

#[test]
fn pages_scan_slots_and_filter_the_at_risk() {
    let mut w = index_world();
    let s = w.s2x2;
    // Five borrowers: three healthy, one at HF 0.95, one with worthless collateral.
    let who = [ALICE, CAROL, DAVE, ERIN, BOB];
    for a in &who[..3] {
        w.post_real(a, s, Usdc, 1_000 * E18).unwrap();
        w.borrow_in(Tier::Normal, a, s, 100 * E18).unwrap();
    }
    w.post_real(ERIN, s, Wnear, 1_000 * E18).unwrap();
    w.post_real(BOB, s, Wnear, 1_000 * E18).unwrap();
    flat_price(s, 2 * WAD);
    w.borrow_in(Tier::Normal, ERIN, s, 1_000 * E18).unwrap();
    w.borrow_in(Tier::Normal, BOB, s, 100 * E18).unwrap();
    // ERIN at 0.95 (1,357.14 of collateral), BOB's 100 wNEAR worth nothing
    // in world 3.
    set_price(s, 0, 1_357_142_857_142_857_142);
    set_price(s, 1, 1_357_142_857_142_857_142);
    set_price(s, 2, 1_357_142_857_142_857_142);
    set_price(s, 3, 1_357_142_857_142_857_142);
    let page = |w: &mut World, from: Option<u32>, limit: Option<u32>, max: Option<u128>| {
        w.view(|c| c.borrowers(s, None, from, limit, max.map(U128)))
    };
    let p = page(&mut w, None, Some(2), None);
    assert_eq!((p.total, p.from_index, p.next_index), (5, 0, Some(2)));
    assert_eq!(p.rows.len(), 2);
    assert_eq!(p.tier, Tier::Normal);
    assert_eq!(p.now_sec, w.now);
    let p = page(&mut w, Some(2), Some(2), None);
    assert_eq!(p.next_index, Some(4));
    let p = page(&mut w, Some(4), Some(2), None);
    assert_eq!((p.next_index, p.rows.len()), (None, 1));
    let p = page(&mut w, Some(9), None, None);
    assert!(p.rows.is_empty() && p.next_index.is_none());
    // The at-risk filter: below 1.1 shows ERIN; below 1.0 too; the rows carry
    // what a bot needs.
    let p = page(&mut w, None, Some(500), Some(1_100_000_000_000_000_000));
    let names: Vec<AccountId> = p.rows.iter().map(|r| r.account_id.clone()).collect();
    assert_eq!(names, vec![acc(ERIN)]);
    let erin = &p.rows[0];
    assert_eq!(erin.index, 3);
    assert_eq!(erin.debt, U128(1_000 * E18));
    assert_eq!(erin.liquidation, LiquidationState::Liquidatable);
    assert_eq!(erin.max_repay, U128(500 * E18));
    assert_eq!(erin.worst_world, Some(0));
    assert!(!erin.write_off_ready);
    // BOB's collateral is priced at zero: HF 0, ready for a write-off, and
    // it passes any filter.
    set_price(s, 3, 0);
    for world in 0..3 {
        set_price(s, world, 0);
    }
    let p = page(&mut w, None, None, Some(1));
    let bob = p.rows.iter().find(|r| r.account_id == acc(BOB)).unwrap();
    assert_eq!(bob.health_factor, Some(U128(0)));
    assert!(bob.write_off_ready);
    assert_eq!(bob.c_min, U128(0));
    assert_eq!(bob.full_seize_repay, U128(1));
    // Unknown scenarios are refused.
    fails(
        w.try_view(|c| c.borrowers(999, None, None, None, None)),
        "UnknownScenario(999)",
    );
}

#[test]
fn a_page_of_100_rows_at_8_worlds_and_20_pieces_fits_the_view_budget() {
    let mut w = tier_world();
    let events: Vec<u64> = (0..3)
        .map(|i| {
            w.create_event(
                &format!("{SPICE_QUESTION} {i}"),
                &["A", "B"],
                SPICE_RULE,
                T0 + 90 * DAY,
            )
            .unwrap()
        })
        .collect();
    let sid = w.create_scenario(&events).unwrap();
    for world in 0..8u8 {
        set_price(sid, world, (2 + u128::from(world)) * WAD);
    }
    let id = MarketId::new(sid, None);
    // 100 borrowers with 20 pieces each, written in one go: the view's gas
    // depends on the stored records, not on how they got there.
    let longest = "b".repeat(56);
    w.call(OWNER, NO_DEPOSIT, |c| {
        let mut pieces = vec![
            (CollateralKey::Real(Wnear), 1_000 * E18),
            (CollateralKey::Real(Usdc), 1_000 * E18),
        ];
        for asset in [Wnear, Usdc] {
            for mask in 1..=9u8 {
                pieces.push((CollateralKey::Verse { asset, mask }, 10 * E18));
            }
        }
        assert_eq!(pieces.len(), 20);
        let (mut m, st) = c.accrue(id);
        m.total_supply_assets = 1_000_000 * E18;
        m.total_supply_shares = 1_000_000 * E18 * 1_000_000;
        for i in 0..100 {
            let a: AccountId = format!("{i:02}{longest}.near").parse().unwrap();
            let shares = to_shares_up(1_000 * E18, m.total_borrow_assets, m.total_borrow_shares);
            m.total_borrow_assets += 1_000 * E18;
            m.total_borrow_shares += shares;
            c.set_pieces(id, &a, pieces.clone());
            c.set_borrow_shares(id, &a, shares);
        }
        c.store_market(id, m, &st);
    })
    .unwrap();
    let (gas, rows) = w.view(|c| {
        let g0 = env::used_gas().as_gas();
        let page = c.borrowers(sid, None, None, Some(100), None);
        (env::used_gas().as_gas() - g0, page.rows.len())
    });
    assert_eq!(rows, 100);
    let tgas = gas / 1_000_000_000_000;
    println!("borrowers page: 100 rows x 20 pieces x 8 worlds = {gas} gas ({tgas} Tgas host)");
    assert!(gas <= 100_000_000_000_000, "{tgas} Tgas");
    let (gas50, _) = w.view(|c| {
        let g0 = env::used_gas().as_gas();
        let page = c.borrowers(sid, None, None, None, None);
        (env::used_gas().as_gas() - g0, page.rows.len())
    });
    assert!(gas50 <= gas / 2 + gas / 10);
}

// ---- migrate on production's state ----

const CARL_SHARES: u128 = 892_674_253_365_722_390_776_685_698;

fn carl() -> AccountId {
    prod_account("carl")
}

/// The spec's golden numbers for Carl (debt 892.822257, max 446.411128,
/// 226.391747 wNEAR seized) were read 2,420 s after the snapshot block.
const GOLDEN_READ_DELAY_SEC: u64 = 2_420;

/// Production migrated, then the clock moved to the golden read.
fn migrated_prod_at_the_golden_read() -> Prod {
    let mut p = migrated_prod();
    p.now_ns += GOLDEN_READ_DELAY_SEC * 1_000_000_000;
    p
}

/// The owner lifts every pause flag after R1-R17, with no liquidation grace.
fn unpause_all(p: &mut Prod) {
    let owner = prod_account(PROD_OWNER);
    p.call(&owner, NearToken::from_yoctonear(1), |c| {
        c.unpause(PauseFlag::GUARDIAN.to_vec(), Some(0))
    })
    .unwrap();
    assert_eq!(p.view(|c| c.pause.paused()), Vec::<PauseFlag>::new());
}

#[test]
fn migrate_writes_the_legacy_tier_configs() {
    let mut p = migrated_prod();
    let params = p.view(|c| c.params.clone());
    let state = |p: &mut Prod, sid: u64, tier: Tier| {
        p.view(|c| {
            c.tier_states
                .get(&MarketId::new(sid, Some(tier)).key())
                .cloned()
        })
    };
    // Market 1 has Carl's debt: v1's terms exactly; the others the legacy live terms.
    let one = state(&mut p, 1, Tier::Normal).unwrap();
    assert_eq!(one.config, TierConfig::v1_terms(&params));
    assert_eq!(one.config.rate_base, 1_585_489_599);
    assert_eq!(
        (one.config.lltv, one.config.borrow_ltv),
        (750 * E15, 650 * E15)
    );
    assert!(one.frozen);
    for sid in 2..=6 {
        let st = state(&mut p, sid, Tier::Normal).unwrap();
        assert_eq!(st.config, TierConfig::legacy_live(&params), "{sid}");
        assert_eq!(st.frozen, sid <= 4, "{sid}");
        assert_eq!(
            (st.insurance, st.bad_debt_covered, st.bad_debt_socialized),
            (0, 0, 0)
        );
    }
    for sid in 1..=6 {
        for tier in [Tier::Safe, Tier::Bold] {
            match state(&mut p, sid, tier) {
                Some(st) if sid <= 4 => {
                    let mut builtin = TierState::builtin(tier);
                    builtin.frozen = true;
                    assert_eq!(st, builtin);
                }
                None if sid > 4 => {}
                other => panic!("{sid} {tier}: {other:?}"),
            }
        }
    }
    let upgraded = &p.data_of("contract_upgraded")[0]["lending"];
    assert_eq!(
        *upgraded,
        near_sdk::serde_json::json!({"legacy_markets": 4, "borrowers": 1, "v1_terms": [1],
                                     "frozen": [1, 2, 3, 4], "unindexed": []})
    );
    // Nothing accrued and no Market entry was rewritten (R8).
    assert_eq!(
        p.view(|c| c.market_of(MarketId::new(1, None)))
            .total_borrow_shares,
        CARL_SHARES
    );
}

#[test]
fn migrate_indexes_carl_and_keeps_his_loan() {
    let mut p = migrated_prod();
    // R15: the index of every legacy market matches its shares.
    assert_eq!(p.view(|c| c.borrower_count(1, None)), 1);
    for sid in 2..=6 {
        assert_eq!(p.view(|c| c.borrower_count(sid, None)), 0);
    }
    assert_eq!(p.view(|c| c.lending_backfill_proof()), None);
    assert!(!p.view(|c| c.legacy_backfill_open));
    let page = p.view(|c| c.borrowers(1, None, None, None, None));
    assert_eq!(page.rows.len(), 1);
    let row = &page.rows[0];
    assert_eq!(row.account_id, carl());
    // L-8: v1's formula at the migration timestamp (5% flat since the last
    // touch, nothing accrued by migrate).
    let m = p.view(|c| c.market_of(MarketId::new(1, None)));
    let elapsed = p.now_sec() - m.last_update;
    let interest = multiverse_math::irm::interest(m.total_borrow_assets, 1_585_489_599, elapsed);
    let v1_debt = multiverse_math::shares::to_assets_up(
        CARL_SHARES,
        m.total_borrow_assets + interest,
        m.total_borrow_shares,
    );
    assert_eq!(row.debt.0, v1_debt);
    assert_eq!(row.c_min.0, 1_133_134_240_133_792_851_806);
    assert_eq!(
        row.health_factor.unwrap().0,
        multiverse_math::risk::health_factor(row.c_min.0, v1_debt, 750 * E15).unwrap()
    );
    // The golden read: debt 892.822257, HF 0.951870.
    let mut p = migrated_prod_at_the_golden_read();
    let row = p.view(|c| c.borrowers(1, None, None, None, None)).rows[0].clone();
    assert_eq!(row.debt.0, 892_822_257_272_781_333_774);
    assert_eq!(row.health_factor.unwrap().0 / 1_000_000_000_000, 951_869);
    // R9: paused after migrate, v1's status once liquidation is unpaused.
    assert_eq!(row.liquidation, LiquidationState::Paused);
    unpause_all(&mut p);
    let status = p.view(|c| c.liquidation_status(1, carl(), None));
    assert_eq!(status.status, LiquidationState::Liquidatable);
    assert_eq!(status.max_repay.0, 446_411_128_636_390_666_887);
    assert_eq!(status.full_seize_repay.0, 1_079_175_466_794_088_430_292);
    let view = p.view(|c| c.market_state(1, None));
    assert_eq!(view.borrow_rate_per_sec, U128(1_585_489_599));
    assert_eq!(view.supply_rate_per_sec.0, {
        let rate = 1_585_489_599u128;
        multiverse_math::mul_div_down(rate, view.total_borrow.0, view.total_supply.0)
    });
}

/// Carl's market-1 loan liquidated with `"max"` by Bob, tokens or cash.
fn liquidate_carl(p: &mut Prod, cash_min_out: Option<u128>) -> Result<(), String> {
    let token = p.view(|c| c.usdc.token_id.clone());
    let mut msg = near_sdk::serde_json::json!({"action": "liquidate", "scenario_id": 1,
        "account_id": carl(), "repay_amount": "max"});
    if let Some(m) = cash_min_out {
        msg["receive"] = "cash".into();
        msg["min_out"] = m.to_string().into();
    }
    let msg = msg.to_string();
    let bob = prod_account("bob");
    p.call(&token, NearToken::from_yoctonear(0), move |c| {
        c.ft_on_transfer(bob, U128(447_000_000), msg);
    })
}

#[test]
fn carl_is_liquidated_as_under_v1_in_tokens_mode() {
    let mut p = migrated_prod_at_the_golden_read();
    unpause_all(&mut p);
    liquidate_carl(&mut p, None).unwrap();
    let liq = &p.data_of("liquidate")[0];
    let u = |v: &near_sdk::serde_json::Value| -> u128 { v.as_str().unwrap().parse().unwrap() };
    assert_eq!(u(&liq["repaid"]), 446_411_128_636_390_666_887);
    assert_eq!(u(&liq["seized"][0]), 226_391_746_944_898_575_452);
    assert_eq!(liq["seize_all"], false);
    let hf = p
        .view(|c| c.health_factor(1, carl(), None))
        .health_factor
        .unwrap()
        .0;
    assert_eq!(hf / 10u128.pow(14), 11_162);
    assert_eq!(p.view(|c| c.borrower_count(1, None)), 1);
}

#[test]
fn carl_can_be_liquidated_for_cash_from_pool_4() {
    let mut p = migrated_prod_at_the_golden_read();
    unpause_all(&mut p);
    let q = p
        .view(|c| c.liquidation_quote(1, carl(), None, None, Some(crate::receiver::Receive::Cash)));
    assert_eq!(q.error, None);
    let cash = q.cash.unwrap().cash.0;
    // 226.39 wNEAR sold in pool 4. At the snapshot its dynamic fee sits at the
    // 1.5% cap, so the cash is the lending design's fee-cap figure, 459.41
    // (464.98 at the 0.30% base fee): 13.00 USDC more than the repayment.
    assert_eq!(p.view(|c| c.get_pool(4).unwrap().fee_pips), 15_000);
    assert_eq!(cash / 10u128.pow(16), 45_941);
    assert_eq!(q.repay.0 / 10u128.pow(16), 44_641);
    liquidate_carl(&mut p, Some(cash)).unwrap();
    let out = &p.data_of("cash_out")[0];
    assert_eq!(out["cash"], cash.to_string());
    assert_eq!(out["merged"], cash.to_string());
}

#[test]
fn new_tiers_open_on_legacy_scenarios() {
    let mut p = migrated_prod();
    unpause_all(&mut p);
    let token = p.view(|c| c.usdc.token_id.clone());
    let bob = prod_account("bob");
    p.call(&token, NearToken::from_yoctonear(0), |c| {
        c.ft_on_transfer(
            bob,
            U128(1_000_000_000),
            r#"{"action":"supply","scenario_id":5,"tier":"bold"}"#.to_string(),
        );
    })
    .unwrap();
    let st = p.view(|c| c.tier_state(MarketId::new(5, Some(Tier::Bold))));
    assert_eq!(st, TierState::builtin(Tier::Bold));
    assert_eq!(
        p.view(|c| c.market_state(5, Some(Tier::Bold)))
            .total_supply
            .0,
        1_000 * E18
    );
    // Frozen legacy tiers take no supply.
    let bob = prod_account("bob");
    let err = p
        .call(&token, NearToken::from_yoctonear(0), |c| {
            c.ft_on_transfer(
                bob,
                U128(1_000_000_000),
                r#"{"action":"supply","scenario_id":2,"tier":"safe"}"#.to_string(),
            );
        })
        .unwrap_err();
    assert_eq!(err, "MarketFrozen(2, safe)");
}

#[test]
fn a_straggler_borrower_leaves_a_gap_that_their_upgrade_closes() {
    let mut p = Prod::from_snapshot();
    let mut args = prod_args();
    args.accounts.retain(|a| *a != carl());
    args.pause = Some(vec![]);
    p.migrate(&prod_account(PROD_CONTRACT), args).unwrap();
    let lending = &p.data_of("contract_upgraded")[0]["lending"];
    assert_eq!(
        lending["unindexed"],
        near_sdk::serde_json::json!([[1, CARL_SHARES.to_string()]])
    );
    assert_eq!(lending["borrowers"], 0);
    assert!(p.view(|c| c.legacy_backfill_open));
    assert_eq!(
        p.view(|c| c.pause.paused()),
        vec![PauseFlag::Lend, PauseFlag::Liquidate]
    );
    assert_eq!(
        p.view(|c| c.lending_backfill_proof()),
        Some((1, 0, CARL_SHARES))
    );
    // While the gap is open the owner cannot unpause lend or liquidate.
    let owner = prod_account(PROD_OWNER);
    let one = NearToken::from_yoctonear(1);
    for flag in [PauseFlag::Lend, PauseFlag::Liquidate] {
        assert_eq!(
            p.call(&owner, one, |c| c.unpause(vec![flag], Some(0))),
            Err(format!("BorrowerBackfillIncomplete(1, 0, {CARL_SHARES})"))
        );
    }
    // Folding Carl (upgrade_accounts, or his first touch) indexes him.
    let n = p
        .call(&prod_account("bob"), one, |c| {
            c.upgrade_accounts(vec![carl()])
        })
        .unwrap();
    assert_eq!(n, 1);
    assert_eq!(p.view(|c| c.lending_backfill_proof()), None);
    assert_eq!(p.view(|c| c.borrower_count(1, None)), 1);
    // The proof balances now: unpausing clears the gap flag.
    p.call(&owner, one, |c| {
        c.unpause(vec![PauseFlag::Lend, PauseFlag::Liquidate], Some(0))
    })
    .unwrap();
    assert!(!p.view(|c| c.legacy_backfill_open));
    assert_eq!(p.view(|c| c.pause.paused()), Vec::<PauseFlag>::new());
}

#[test]
fn an_index_above_the_shares_reverts_migrate() {
    let mut p = Prod::from_snapshot();
    // Carl's borrow-shares entry (prefix 0x12, key (1, carl)) one share up.
    let key = {
        let mut k = vec![18u8];
        k.extend(borsh::to_vec(&(1u64, carl())).unwrap());
        k
    };
    let shares = u128::try_from_slice(&p.storage[&key]).unwrap();
    assert_eq!(shares, CARL_SHARES);
    p.storage.insert(key, borsh::to_vec(&(shares + 1)).unwrap());
    fails(
        p.migrate(&prod_account(PROD_CONTRACT), prod_args()),
        &format!(
            "BorrowerBackfillIncomplete(1, {}, {CARL_SHARES})",
            CARL_SHARES + 1
        ),
    );
}

#[test]
fn frozen_scenarios_must_be_legacy() {
    for sid in [0, 7] {
        let mut p = Prod::from_snapshot();
        let mut args = prod_args();
        args.lending.frozen_scenarios = vec![1, sid];
        fails(
            p.migrate(&prod_account(PROD_CONTRACT), args),
            &format!("MigrateBadArgs(frozen_scenarios, {sid})"),
        );
    }
}
