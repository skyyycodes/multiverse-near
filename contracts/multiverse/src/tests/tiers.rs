//! Lending tiers (I5) and the borrower-side rules of F7 and F9: three
//! isolated markets per scenario, each with its own terms; the kinked rate
//! with its reserve cut; utilization and borrow caps; frozen markets; the
//! owner's setters and their validation; the minimum loan; liquidation
//! sizing (half, all, or what seizes everything); the borrow-side cushion.
//!
//! Most tests run on the production defaults (`World::new_v2`) with world
//! prices from the test table; the router tests run on real pools.

use multiverse_math::risk::{full_seize_repay, liquidation_target};
use multiverse_math::{irm, mul_div_down};
use near_sdk::borsh;
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::NearToken;
use proptest::prelude::*;

use super::amm::{seed_worlds, DEMO_2X2, DEPTH};
use super::harness::*;
use super::lending::*;
use super::profile::v1_tier_config;
use crate::amm::test_hooks::{self, TestQuote};
use crate::lending::tiers::{
    LendingParamsInput, MarketId, Tier, TierConfig, TierConfigInput, TierState,
};
use crate::lending::{CollateralKey, Liquidation, LiquidationState, Market};
use crate::prices::WorldStatus;
use crate::types::Asset::{self, Usdc, Wnear};
use crate::types::{Params, WAD};

pub const SAFE: Tier = Tier::Safe;
pub const NORMAL: Tier = Tier::Normal;
pub const BOLD: Tier = Tier::Bold;

/// A WAD fraction from hundredths of a percent.
pub fn pct(bps: u128) -> u128 {
    bps * WAD / 10_000
}

fn tier_json(tier: Tier) -> String {
    match tier {
        Tier::Normal => String::new(),
        t => format!(r#","tier":"{t}""#),
    }
}

/// Lending calls and reads in one tier (Normal by default).
pub trait TierLend {
    fn lend_in(&mut self, tier: Tier, who: &str, sid: u64, amount: u128) -> Result<(), String>;
    fn post_real_in(
        &mut self,
        tier: Tier,
        who: &str,
        sid: u64,
        asset: Asset,
        amount: u128,
    ) -> Result<(), String>;
    fn post_in(
        &mut self,
        tier: Tier,
        who: &str,
        sid: u64,
        piece: &str,
        amount: u128,
    ) -> Result<(), String>;
    fn borrow_in(&mut self, tier: Tier, who: &str, sid: u64, amount: u128) -> Result<(), String>;
    fn repay_in(
        &mut self,
        tier: Tier,
        who: &str,
        sid: u64,
        attached: u128,
        all: bool,
    ) -> Result<u128, String>;
    /// `liquidate` attaching `budget` (internal USDC, whole micro-USDC up).
    fn liquidate_with(
        &mut self,
        tier: Tier,
        who: &str,
        sid: u64,
        account: &str,
        repay: Option<u128>,
        budget: u128,
    ) -> Result<Liquidation, String>;
    fn fund_insurance_in(
        &mut self,
        tier: Tier,
        who: &str,
        sid: u64,
        amount: u128,
    ) -> Result<(), String>;
    fn debt_in(&mut self, tier: Tier, sid: u64, who: &str) -> u128;
    fn hf_in(&mut self, tier: Tier, sid: u64, who: &str) -> Option<u128>;
    fn lent_in(&mut self, tier: Tier, sid: u64, who: &str) -> u128;
    fn market_in(&mut self, tier: Tier, sid: u64) -> Market;
    fn state_in(&mut self, tier: Tier, sid: u64) -> TierState;
    fn pieces_in(&mut self, tier: Tier, sid: u64, who: &str) -> Vec<(CollateralKey, u128)>;
    fn set_config(&mut self, sid: u64, tier: Tier, config: TierConfigInput) -> Result<(), String>;
    fn set_params(&mut self, min_loan: u128, full_hf: u128, small: u128) -> Result<(), String>;
}

impl TierLend for World {
    fn lend_in(&mut self, tier: Tier, who: &str, sid: u64, amount: u128) -> Result<(), String> {
        let msg = format!(
            r#"{{"action":"supply","scenario_id":{sid}{}}}"#,
            tier_json(tier)
        );
        let unused = self.ft_transfer_call(who, Usdc, amount / USDC_UNIT, &msg)?;
        assert_eq!(unused, 0);
        Ok(())
    }

    fn post_real_in(
        &mut self,
        tier: Tier,
        who: &str,
        sid: u64,
        asset: Asset,
        amount: u128,
    ) -> Result<(), String> {
        let msg = format!(
            r#"{{"action":"deposit_collateral","scenario_id":{sid}{}}}"#,
            tier_json(tier)
        );
        let unused = self.ft_transfer_call(who, asset, amount / scale(asset), &msg)?;
        assert_eq!(unused, 0);
        Ok(())
    }

    fn post_in(
        &mut self,
        tier: Tier,
        who: &str,
        sid: u64,
        piece: &str,
        amount: u128,
    ) -> Result<(), String> {
        let piece = piece.to_string();
        self.call(who, ONE_YOCTO, |c| {
            c.deposit_collateral(sid, piece, U128(amount), Some(tier))
        })
    }

    fn borrow_in(&mut self, tier: Tier, who: &str, sid: u64, amount: u128) -> Result<(), String> {
        self.call(who, ONE_YOCTO, |c| c.borrow(sid, U128(amount), Some(tier)))
    }

    fn repay_in(
        &mut self,
        tier: Tier,
        who: &str,
        sid: u64,
        attached: u128,
        all: bool,
    ) -> Result<u128, String> {
        let msg = format!(
            r#"{{"action":"repay","scenario_id":{sid},"all":{all}{}}}"#,
            tier_json(tier)
        );
        self.ft_transfer_call(who, Usdc, usdc_units(attached), &msg)?;
        Ok(self.last.data_of("repay")[0]["assets"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap())
    }

    fn liquidate_with(
        &mut self,
        tier: Tier,
        who: &str,
        sid: u64,
        account: &str,
        repay: Option<u128>,
        budget: u128,
    ) -> Result<Liquidation, String> {
        let amount = match repay {
            Some(r) => format!(r#""{r}""#),
            None => r#""max""#.to_string(),
        };
        let msg = format!(
            r#"{{"action":"liquidate","scenario_id":{sid},"account_id":"{account}","repay_amount":{amount}{}}}"#,
            tier_json(tier)
        );
        self.ft_transfer_call(who, Usdc, usdc_units(budget), &msg)?;
        Ok(liquidation_of(self, sid))
    }

    fn fund_insurance_in(
        &mut self,
        tier: Tier,
        who: &str,
        sid: u64,
        amount: u128,
    ) -> Result<(), String> {
        let msg = format!(
            r#"{{"action":"fund_insurance","scenario_id":{sid}{}}}"#,
            tier_json(tier)
        );
        let unused = self.ft_transfer_call(who, Usdc, amount / USDC_UNIT, &msg)?;
        assert_eq!(unused, 0);
        Ok(())
    }

    fn debt_in(&mut self, tier: Tier, sid: u64, who: &str) -> u128 {
        let who = acc(who);
        self.view(|c| c.debt_of(sid, who, Some(tier)).0)
    }

    fn hf_in(&mut self, tier: Tier, sid: u64, who: &str) -> Option<u128> {
        let who = acc(who);
        self.view(|c| c.health_factor(sid, who, Some(tier)))
            .health_factor
            .map(|h| h.0)
    }

    fn lent_in(&mut self, tier: Tier, sid: u64, who: &str) -> u128 {
        let who = acc(who);
        self.view(|c| c.supply_balance_of(sid, who, Some(tier)).0)
    }

    fn market_in(&mut self, tier: Tier, sid: u64) -> Market {
        self.view(|c| c.market_of(MarketId::new(sid, Some(tier))))
    }

    fn state_in(&mut self, tier: Tier, sid: u64) -> TierState {
        self.view(|c| c.tier_state(MarketId::new(sid, Some(tier))))
    }

    fn pieces_in(&mut self, tier: Tier, sid: u64, who: &str) -> Vec<(CollateralKey, u128)> {
        let who = acc(who);
        self.view(|c| c.pieces(MarketId::new(sid, Some(tier)), &who))
    }

    fn set_config(&mut self, sid: u64, tier: Tier, config: TierConfigInput) -> Result<(), String> {
        self.call(OWNER, ONE_YOCTO, |c| c.set_tier_config(sid, tier, config))
    }

    fn set_params(&mut self, min_loan: u128, full_hf: u128, small: u128) -> Result<(), String> {
        self.call(OWNER, ONE_YOCTO, |c| {
            c.set_lending_params(LendingParamsInput {
                min_loan: U128(min_loan),
                full_liquidation_hf: U128(full_hf),
                small_loan: U128(small),
            })
        })
    }
}

/// The `Liquidation` the last call's `liquidate` line reports.
pub fn liquidation_of(w: &World, sid: u64) -> Liquidation {
    let log = &w.last.data_of("liquidate")[0];
    let u = |v: &near_sdk::serde_json::Value| -> u128 { v.as_str().unwrap().parse().unwrap() };
    Liquidation {
        repaid: u(&log["repaid"]),
        shares: u(&log["shares"]),
        pieces: log["pieces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| CollateralKey::parse(sid, p.as_str().unwrap()).unwrap())
            .collect(),
        seized: log["seized"].as_array().unwrap().iter().map(u).collect(),
        seize_all: log["seize_all"].as_bool().unwrap(),
        written_off: u(&log["written_off"]),
    }
}

/// The production defaults, both scenarios priced at the demo prices, carol
/// and dave funded and registered.
pub fn tier_world() -> World {
    clear_prices();
    let mut w = World::new_v2();
    price_2x2(w.s2x2);
    price_bin(w.s_bin);
    w.register(DAVE, NearToken::from_near(5));
    w.fund(CAROL);
    w.fund(DAVE);
    w.warp(61);
    w
}

/// Every world of the 2x2 at one price.
pub fn flat_price(sid: u64, price: u128) {
    for world in 0..4 {
        set_price(sid, world, price);
    }
}

/// `amount` borrowed in `tier` against `wnear` real wNEAR at 2.00 in every
/// world, then the price set so the collateral is worth `value`.
pub fn wnear_loan(w: &mut World, tier: Tier, who: &str, wnear: u128, amount: u128, value: u128) {
    let s = w.s2x2;
    flat_price(s, 2 * WAD);
    w.post_real_in(tier, who, s, Wnear, wnear).unwrap();
    w.borrow_in(tier, who, s, amount).unwrap();
    flat_price(s, mul_div_down(value, WAD, wnear));
}

fn config_input(c: &TierConfig) -> TierConfigInput {
    TierConfigInput::from(c)
}

// ---- Markets per tier ----

#[test]
fn each_tier_is_its_own_market() {
    let mut w = tier_world();
    let s = w.s2x2;
    w.lend_in(SAFE, BOB, s, 10_000 * E18).unwrap();
    w.post_real_in(BOLD, ALICE, s, Usdc, 2_000 * E18).unwrap();
    // Safe supply never funds a Bold borrow.
    fails(
        w.borrow_in(BOLD, ALICE, s, 500 * E18),
        &format!("InsufficientLiquidity({}, 0)", 500 * E18),
    );
    w.lend_in(BOLD, BOB, s, 10_000 * E18).unwrap();
    // L-11: actions on Bold change no byte of Safe or Normal.
    let bytes = |w: &mut World| {
        w.view(|c| {
            let mut out = Vec::new();
            for tier in [SAFE, NORMAL] {
                let id = MarketId::new(s, Some(tier));
                out.push(borsh::to_vec(&c.markets.get(&id.key()).cloned()).unwrap());
                out.push(borsh::to_vec(&c.tier_states.get(&id.key()).cloned()).unwrap());
                for who in [ALICE, BOB] {
                    let k = (id.key(), acc(who));
                    out.push(borsh::to_vec(&c.supply_shares.get(&k).copied()).unwrap());
                    out.push(borsh::to_vec(&c.collateral.get(&k).cloned()).unwrap());
                    out.push(borsh::to_vec(&c.borrow_shares.get(&k).copied()).unwrap());
                }
                out.push(borsh::to_vec(&c.borrower_count.get(&id.key()).copied()).unwrap());
            }
            out
        })
    };
    let before = bytes(&mut w);
    w.borrow_in(BOLD, ALICE, s, 500 * E18).unwrap();
    w.warp(30 * DAY);
    w.repay_in(BOLD, ALICE, s, 100 * E18, false).unwrap();
    w.fund_insurance_in(BOLD, CAROL, s, 10 * E18).unwrap();
    w.call(OWNER, ONE_YOCTO, |c| c.set_market_frozen(s, BOLD, true))
        .unwrap();
    assert_eq!(bytes(&mut w), before);
    assert_eq!(w.debt_in(SAFE, s, ALICE), 0);
    assert!(w.debt_in(BOLD, s, ALICE) > 400 * E18);
    assert_eq!(w.lent_in(SAFE, s, BOB), 10_000 * E18);
    // The keys: Normal is the bare scenario id, the others carry the tier above it.
    assert_eq!(MarketId::new(s, None).key(), s);
    assert_ne!(MarketId::new(s, Some(SAFE)).key(), s);
}

#[test]
fn health_uses_the_tier_terms() {
    let mut w = tier_world();
    let s = w.s2x2;
    for tier in Tier::ALL {
        w.lend_in(tier, BOB, s, 10_000 * E18).unwrap();
        w.post_real_in(tier, ALICE, s, Usdc, 1_000 * E18).unwrap();
        w.borrow_in(tier, ALICE, s, 400 * E18).unwrap();
    }
    // HF = 1,000 * lltv / 400 at 0.60 / 0.70 / 0.80.
    assert_eq!(w.hf_in(SAFE, s, ALICE), Some(1_500_000_000_000_000_000));
    assert_eq!(w.hf_in(NORMAL, s, ALICE), Some(1_750_000_000_000_000_000));
    assert_eq!(w.hf_in(BOLD, s, ALICE), Some(2_000_000_000_000_000_000));
    // Borrowing stops at the borrow LTV, 0.50 / 0.60 / 0.70 of 1,000.
    for (tier, limit) in [(SAFE, 500), (NORMAL, 600), (BOLD, 700)] {
        w.borrow_in(tier, ALICE, s, (limit - 400) * E18).unwrap();
        let err = w.borrow_in(tier, ALICE, s, E18).unwrap_err();
        assert!(err.starts_with("Unhealthy("), "{tier}: {err}");
        let view = w.view(|c| c.borrow_view(s, Some(acc(ALICE)), Some(tier)));
        let a = view.account;
        assert_eq!(a.tier, tier);
        assert_eq!(a.borrow_health_factor, Some(U128(WAD)));
        assert_eq!(a.borrow_limit, U128(limit * E18));
        assert_eq!(a.max_borrow, U128(0));
        assert_eq!(a.lltv.0, w.state_in(tier, s).config.lltv);
    }
}

#[test]
fn a_missing_tier_is_normal() {
    let mut w = tier_world();
    let s = w.s2x2;
    let normal = MarketId::new(s, None);
    let msg = format!(r#"{{"action":"supply","scenario_id":{s}}}"#);
    w.ft_transfer_call(BOB, Usdc, 1_000_000_000, &msg).unwrap();
    let msg = format!(r#"{{"action":"supply","scenario_id":{s},"tier":"normal"}}"#);
    w.ft_transfer_call(BOB, Usdc, 1_000_000_000, &msg).unwrap();
    assert_eq!(
        w.view(|c| c.market_of(normal)).total_supply_assets,
        2_000 * E18
    );
    w.post_real(ALICE, s, Usdc, 1_000 * E18).unwrap();
    w.call(ALICE, ONE_YOCTO, |c| c.borrow(s, U128(100 * E18), None))
        .unwrap();
    assert_eq!(w.debt_in(NORMAL, s, ALICE), 100 * E18);
    assert_eq!(w.view(|c| c.debt_of(s, acc(ALICE), None)).0, 100 * E18);
    assert_eq!(w.view(|c| c.market_state(s, None)).tier, NORMAL);
    for tier in [SAFE, BOLD] {
        assert_eq!(w.debt_in(tier, s, ALICE), 0);
        assert_eq!(w.view(|c| c.market_state(s, Some(tier))).total_supply.0, 0);
    }
}

#[test]
fn logs_name_the_tier_off_normal_only() {
    let mut w = tier_world();
    let s = w.s2x2;
    for tier in [NORMAL, BOLD] {
        w.lend_in(tier, BOB, s, 10_000 * E18).unwrap();
        let supply = &w.last.data_of("supply")[0];
        w.post_real_in(tier, ALICE, s, Usdc, 1_000 * E18).unwrap();
        let posted = &w.last.data_of("deposit_collateral")[0];
        w.borrow_in(tier, ALICE, s, 200 * E18).unwrap();
        let borrowed = &w.last.data_of("borrow")[0];
        w.warp(DAY);
        w.repay_in(tier, ALICE, s, 50 * E18, false).unwrap();
        let repaid = &w.last.data_of("repay")[0];
        let accrued = &w.last.data_of("accrue")[0];
        for line in [supply, posted, borrowed, repaid, accrued] {
            match tier {
                Tier::Normal => assert!(line.get("tier").is_none(), "{line}"),
                t => assert_eq!(line["tier"], t.name(), "{line}"),
            }
        }
        assert!(accrued["to_insurance"].as_str().is_some());
    }
}

#[test]
fn the_piece_cap_is_per_tier() {
    let mut w = tier_world();
    let s = w.s2x2;
    w.deposit(ALICE, Wnear, 100 * E18).unwrap();
    w.deposit(ALICE, Usdc, 100 * E18).unwrap();
    let mut ids = vec!["wnear".to_string(), "usdc".to_string()];
    'fill: for asset in [Wnear, Usdc] {
        for mask in 1..ROOT {
            if ids.len() == 21 {
                break 'fill;
            }
            w.split(ALICE, s, asset, ROOT, &[mask, ROOT ^ mask], 2 * E18)
                .unwrap();
            ids.push(token_id(s, asset, mask));
        }
    }
    for id in &ids[..20] {
        w.post_in(NORMAL, ALICE, s, id, E18).unwrap();
    }
    fails(
        w.post_in(NORMAL, ALICE, s, &ids[20], E18),
        "TooManyCollateralTokens",
    );
    // Another tier of the same scenario has its own 20.
    w.post_in(SAFE, ALICE, s, &ids[20], E18).unwrap();
    for id in &ids[..19] {
        w.post_in(SAFE, ALICE, s, id, E18).unwrap();
    }
    assert_eq!(w.pieces_in(SAFE, s, ALICE).len(), 20);
    let config = w.view(|c| c.get_app_config());
    assert_eq!(config.lending.max_collateral_pieces, 20);
}

#[test]
fn close_after_resolution_closes_one_tier() {
    let mut w = tier_world();
    let s = w.s2x2;
    w.lend_in(BOLD, BOB, s, 10_000 * E18).unwrap();
    w.post_real_in(SAFE, ALICE, s, Usdc, 300 * E18).unwrap();
    w.post_real_in(BOLD, ALICE, s, Usdc, 500 * E18).unwrap();
    w.borrow_in(BOLD, ALICE, s, 100 * E18).unwrap();
    let wallet = w.wallet(ALICE, Usdc);
    let msg = format!(r#"{{"action":"close_after_resolution","scenario_id":{s},"tier":"bold"}}"#);
    let unused = w
        .ft_transfer_call(ALICE, Usdc, usdc_units(150 * E18), &msg)
        .unwrap();
    assert_eq!(unused, usdc_units(50 * E18));
    let closed = &w.last.data_of("closed")[0];
    assert_eq!(closed["tier"], "bold");
    assert_eq!(closed["repaid"], (100 * E18).to_string());
    assert!(w.pieces_in(BOLD, s, ALICE).is_empty());
    assert_eq!(w.pieces_in(SAFE, s, ALICE).len(), 1);
    assert_eq!(w.wallet(ALICE, Usdc), wallet - 100 * E18 + 500 * E18);
    // The method form, for the Safe tier.
    w.call(ALICE, ONE_YOCTO, |c| {
        c.close_after_resolution(s, Some(SAFE))
    })
    .unwrap();
    assert!(w.pieces_in(SAFE, s, ALICE).is_empty());
    assert_eq!(w.wallet(ALICE, Usdc), wallet + 700 * E18);
}

/// The 2x2 on real demo pools under the production defaults, Bob lending
/// in Safe and Bold, a minute of history.
fn pool_tier_world() -> World {
    clear_prices();
    let mut w = World::new_v2();
    w.fund(OWNER);
    w.fund(CAROL);
    let s = w.s2x2;
    seed_worlds(&mut w, s, &DEMO_2X2, &[DEPTH; 4]);
    for tier in [SAFE, BOLD] {
        w.lend_in(tier, BOB, s, 100_000 * E18).unwrap();
    }
    w.warp(61);
    w
}

#[test]
fn trades_into_lending_land_in_their_tier() {
    let mut w = pool_tier_world();
    let s = w.s2x2;
    let empty = json!([[], [], [], []]);
    let zeros = json!(["0", "0", "0", "0"]);
    let msg = json!({"action": "conditional_sell", "scenario_id": s, "sell_mask": L_SHAPE,
                     "plans": empty, "min_out": zeros, "to_lending": true, "tier": "bold"})
    .to_string();
    w.ft_transfer_call(ALICE, Wnear, 2_000 * E18, &msg).unwrap();
    let bold = w.pieces_in(BOLD, s, ALICE);
    assert_eq!(bold.len(), 4);
    assert_eq!(
        bold[0],
        (
            CollateralKey::Verse {
                asset: Wnear,
                mask: SHIPS_CUTS
            },
            2_000 * E18
        )
    );
    assert!(w.pieces_in(NORMAL, s, ALICE).is_empty());
    // A sale and borrow below the minimum loan refunds the whole transfer.
    let wallet = w.wallet_raw(BOB, Wnear);
    let sab = |borrow: u128| {
        json!({"action": "sell_and_borrow", "scenario_id": s, "sell_mask": L_SHAPE, "plans": empty,
               "min_out": zeros, "borrow_amount": borrow.to_string(), "tier": "safe"})
        .to_string()
    };
    fails(
        w.ft_transfer_call(BOB, Wnear, 2_000 * E18, &sab(99 * E18)),
        &format!("BelowMinLoan({}, {})", 99 * E18, 100 * E18),
    );
    assert_eq!(w.wallet_raw(BOB, Wnear), wallet);
    assert!(w.pieces_in(SAFE, s, BOB).is_empty());
    w.ft_transfer_call(BOB, Wnear, 2_000 * E18, &sab(500 * E18))
        .unwrap();
    assert_eq!(w.debt_in(SAFE, s, BOB), 500 * E18);
    assert_eq!(w.pieces_in(SAFE, s, BOB).len(), 4);
    assert_eq!(w.debt_in(NORMAL, s, BOB), 0);
    // The method form takes the tier too.
    w.deposit(CAROL, Wnear, 1_000 * E18).unwrap();
    w.call(CAROL, ONE_YOCTO, |c| {
        c.conditional_sell(
            s,
            U128(1_000 * E18),
            SHIPS,
            vec![vec![]; 4],
            vec![U128(0); 4],
            true,
            Some(SAFE),
        )
    })
    .unwrap();
    assert_eq!(w.pieces_in(SAFE, s, CAROL).len(), 4);
}

// ---- Owner setters ----

#[test]
fn every_stored_config_is_validated() {
    let mut w = tier_world();
    let s = w.s2x2;
    let base = TierState::builtin(NORMAL).config;
    let with = |f: &dyn Fn(&mut TierConfig)| {
        let mut c = base.clone();
        f(&mut c);
        config_input(&c)
    };
    let cases: Vec<(TierConfigInput, String)> = vec![
        (
            with(&|c| c.lltv = pct(2_999)),
            "InvalidTierConfig(lltv)".into(),
        ),
        (
            with(&|c| c.lltv = pct(8_501)),
            "InvalidTierConfig(lltv)".into(),
        ),
        (
            with(&|c| c.borrow_ltv = 0),
            "InvalidTierConfig(borrow_ltv)".into(),
        ),
        (
            with(&|c| c.borrow_ltv = c.lltv + 1),
            "InvalidTierConfig(borrow_ltv)".into(),
        ),
        (
            with(&|c| c.liquidation_bonus = pct(99)),
            format!("InvalidLiquidationBonus({})", pct(99)),
        ),
        (
            with(&|c| c.liquidation_bonus = pct(1_501)),
            format!("InvalidLiquidationBonus({})", pct(1_501)),
        ),
        (
            with(&|c| {
                c.lltv = pct(8_500);
                c.liquidation_bonus = pct(600);
            }),
            format!("InvalidLiquidationBonus({})", pct(600)),
        ),
        (
            with(&|c| c.reserve_factor = pct(5_001)),
            "InvalidTierConfig(reserve_factor)".into(),
        ),
        (
            with(&|c| c.rate_kink = pct(4_999)),
            "InvalidTierConfig(rate)".into(),
        ),
        (
            with(&|c| c.rate_kink = pct(9_501)),
            "InvalidTierConfig(rate)".into(),
        ),
        (
            with(&|c| c.rate_slope2 = irm::MAX_RATE_PER_SEC),
            "InvalidTierConfig(rate)".into(),
        ),
        (
            with(&|c| c.max_utilization = pct(4_999)),
            "InvalidTierConfig(max_utilization)".into(),
        ),
        (
            with(&|c| c.max_utilization = WAD + 1),
            "InvalidTierConfig(max_utilization)".into(),
        ),
        (
            with(&|c| c.borrow_cap = 0),
            "InvalidTierConfig(borrow_cap)".into(),
        ),
    ];
    for (config, err) in cases {
        let again = config.clone();
        fails(w.set_config(s, NORMAL, config), &err);
        fails(
            w.call(OWNER, ONE_YOCTO, |c| c.set_default_tier_config(BOLD, again)),
            &err,
        );
    }
    // Strangers and missing deposits.
    let c = config_input(&base);
    fails(
        w.call(ALICE, ONE_YOCTO, |x| {
            x.set_tier_config(s, NORMAL, c.clone())
        }),
        &format!("NotOwner({ALICE})"),
    );
    fails(
        w.call(OWNER, NO_DEPOSIT, |x| {
            x.set_tier_config(s, NORMAL, c.clone())
        }),
        "Requires attached deposit of exactly 1 yoctoNEAR",
    );
    fails(
        w.call(OWNER, ONE_YOCTO, |x| {
            x.set_tier_config(999, NORMAL, c.clone())
        }),
        "UnknownScenario(999)",
    );
    // The builtins, the legacy terms and the v1 profile all pass.
    let params = Params::new(DISPUTE_WINDOW);
    for config in [
        TierState::builtin(SAFE).config,
        TierState::builtin(NORMAL).config,
        TierState::builtin(BOLD).config,
        TierConfig::v1_terms(&params),
        TierConfig::legacy_live(&params),
        TierConfig::from(v1_tier_config()),
    ] {
        config.validate();
    }
    // The lending params.
    for ((min, hf, small), err) in [
        (
            (10_001 * E18, 0, 30_000 * E18),
            "InvalidLendingParams(min_loan)",
        ),
        (
            (100 * E18, pct(8_999), 200 * E18),
            "InvalidLendingParams(full_liquidation_hf)",
        ),
        (
            (100 * E18, WAD + 1, 200 * E18),
            "InvalidLendingParams(full_liquidation_hf)",
        ),
        (
            (100 * E18, pct(9_000), 199 * E18),
            "InvalidLendingParams(small_loan)",
        ),
    ] {
        fails(w.set_params(min, hf, small), err);
    }
    fails(
        w.call(ALICE, ONE_YOCTO, |c| {
            c.set_lending_params(LendingParamsInput {
                min_loan: U128(0),
                full_liquidation_hf: U128(0),
                small_loan: U128(0),
            })
        }),
        &format!("NotOwner({ALICE})"),
    );
    w.set_params(0, 0, 0).unwrap();
    w.set_params(10_000 * E18, WAD, 20_000 * E18).unwrap();
    let logged = &w.last.data_of("lending_params_set")[0];
    assert_eq!(logged["min_loan"], (10_000 * E18).to_string());
}

#[test]
fn lltv_cannot_fall_while_the_market_has_debt() {
    let mut w = tier_world();
    let s = w.s2x2;
    w.lend_in(NORMAL, BOB, s, 10_000 * E18).unwrap();
    w.post_real(ALICE, s, Usdc, 1_000 * E18).unwrap();
    w.borrow_in(NORMAL, ALICE, s, 300 * E18).unwrap();
    let mut c = TierState::builtin(NORMAL).config;
    c.lltv = pct(6_500);
    c.borrow_ltv = pct(5_500);
    fails(
        w.set_config(s, NORMAL, config_input(&c)),
        &format!("LltvDecreaseWithDebt({}, {})", pct(7_000), pct(6_500)),
    );
    // Raising it, or anything else, is fine with debt.
    let mut up = TierState::builtin(NORMAL).config;
    up.lltv = pct(7_500);
    up.borrow_ltv = pct(5_000);
    up.rate_slope1 = 0;
    w.set_config(s, NORMAL, config_input(&up)).unwrap();
    assert_eq!(w.state_in(NORMAL, s).config, up);
    let logged = &w.last.data_of("tier_config_set")[0];
    assert_eq!(logged["scenario_id"], s);
    assert_eq!(logged["tier"], "normal");
    assert_eq!(logged["config"]["lltv"], pct(7_500).to_string());
    // Once nobody owes, it may fall.
    w.repay_in(NORMAL, ALICE, s, 400 * E18, true).unwrap();
    w.set_config(s, NORMAL, config_input(&c)).unwrap();
    assert_eq!(w.state_in(NORMAL, s).config.lltv, pct(6_500));
}

#[test]
fn a_config_change_accrues_on_the_old_curve_first() {
    let mut w = tier_world();
    let s = w.s2x2;
    w.lend_in(NORMAL, BOB, s, 10_000 * E18).unwrap();
    w.post_real(ALICE, s, Usdc, 10_000 * E18).unwrap();
    w.borrow_in(NORMAL, ALICE, s, 5_000 * E18).unwrap();
    let st = w.state_in(NORMAL, s);
    let rate = st
        .config
        .curve()
        .rate(irm::utilization(5_000 * E18, 10_000 * E18));
    w.warp(YEAR);
    let mut flat = st.config.clone();
    flat.rate_slope1 = 0;
    flat.rate_slope2 = 0;
    w.set_config(s, NORMAL, config_input(&flat)).unwrap();
    let interest = irm::interest(5_000 * E18, rate, YEAR);
    let accrued = &w.last.data_of("accrue")[0];
    assert_eq!(accrued["interest"], interest.to_string());
    let m = w.market_in(NORMAL, s);
    assert_eq!(m.total_borrow_assets, 5_000 * E18 + interest);
    assert_eq!(m.last_update, w.now);
    // From here on the new (flat) curve runs.
    w.warp(YEAR);
    let flat_interest = irm::interest(m.total_borrow_assets, flat.rate_base, YEAR);
    let debt = w.debt_in(NORMAL, s, ALICE);
    assert!(debt.abs_diff(m.total_borrow_assets + flat_interest) <= 1);
}

#[test]
fn a_market_keeps_the_default_it_was_touched_with() {
    let mut w = tier_world();
    let (s, b) = (w.s2x2, w.s_bin);
    w.lend_in(BOLD, BOB, s, 1_000 * E18).unwrap();
    let mut c = TierState::builtin(BOLD).config;
    c.lltv = pct(7_500);
    c.borrow_ltv = pct(6_500);
    w.call(OWNER, ONE_YOCTO, |x| {
        x.set_default_tier_config(BOLD, config_input(&c))
    })
    .unwrap();
    assert_eq!(
        w.last.data_of("tier_config_set")[0]["scenario_id"],
        json!(0)
    );
    // The touched market keeps its snapshot; an untouched one reads the new default.
    assert_eq!(w.state_in(BOLD, s).config.lltv, pct(8_000));
    assert_eq!(w.state_in(BOLD, b).config.lltv, pct(7_500));
    let view = w.view(|x| x.tier_config(b, BOLD));
    assert_eq!(view.source, crate::lending::tiers::ConfigSource::Default);
    w.lend_in(BOLD, BOB, b, 1_000 * E18).unwrap();
    let view = w.view(|x| x.tier_config(b, BOLD));
    assert_eq!(view.source, crate::lending::tiers::ConfigSource::Stored);
    assert_eq!(view.config.lltv, U128(pct(7_500)));
    let app = w.view(|x| x.get_app_config());
    assert_eq!(app.lending.defaults[2].config.lltv, U128(pct(7_500)));
}

#[test]
fn a_frozen_market_takes_no_supply_or_borrowing_only() {
    let mut w = tier_world();
    let s = w.s2x2;
    w.lend_in(NORMAL, BOB, s, 10_000 * E18).unwrap();
    w.post_real(ALICE, s, Usdc, 2_000 * E18).unwrap();
    w.borrow_in(NORMAL, ALICE, s, 300 * E18).unwrap();
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.set_market_frozen(s, NORMAL, true)),
        &format!("NotOwner({ALICE})"),
    );
    w.call(OWNER, ONE_YOCTO, |c| c.set_market_frozen(s, NORMAL, true))
        .unwrap();
    assert_eq!(
        w.last.data_of("market_frozen")[0],
        json!({"scenario_id": s, "tier": "normal", "frozen": true})
    );
    let frozen = format!("MarketFrozen({s}, normal)");
    fails(w.lend_in(NORMAL, CAROL, s, 100 * E18), &frozen);
    fails(w.borrow_in(NORMAL, ALICE, s, 100 * E18), &frozen);
    // Everything else goes on.
    w.repay_in(NORMAL, ALICE, s, 100 * E18, false).unwrap();
    w.withdraw_lent(BOB, s, Some(1_000 * E18)).unwrap();
    w.post_real(ALICE, s, Usdc, 100 * E18).unwrap();
    w.unpost(ALICE, s, "usdc", 100 * E18).unwrap();
    assert!(
        w.view(|c| c.borrow_view(s, Some(acc(ALICE)), None))
            .account
            .frozen
    );
    assert_eq!(
        w.view(|c| c.borrow_view(s, Some(acc(ALICE)), None))
            .account
            .max_borrow,
        U128(0)
    );
    w.call(OWNER, ONE_YOCTO, |c| c.set_market_frozen(s, NORMAL, false))
        .unwrap();
    w.borrow_in(NORMAL, ALICE, s, 100 * E18).unwrap();
}

/// Every public method that takes a tier refuses unknown arguments: a
/// v1 contract would ignore `tier` and act on Normal, so v2 must not ignore
/// a misspelled one either. near-sdk only checks that with the attribute.
#[test]
fn tier_methods_carry_deny_unknown_arguments() {
    let sources = [
        ("lending/mod.rs", include_str!("../lending/mod.rs")),
        ("lending/tiers.rs", include_str!("../lending/tiers.rs")),
        (
            "lending/bad_debt.rs",
            include_str!("../lending/bad_debt.rs"),
        ),
        (
            "lending/borrowers.rs",
            include_str!("../lending/borrowers.rs"),
        ),
        (
            "lending/cash_out.rs",
            include_str!("../lending/cash_out.rs"),
        ),
        ("router.rs", include_str!("../router.rs")),
        ("views.rs", include_str!("../views.rs")),
    ];
    let mut checked = 0;
    for (file, src) in sources {
        let lines: Vec<&str> = src.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            let Some(rest) = line.trim_start().strip_prefix("pub fn ") else {
                continue;
            };
            let name = rest.split('(').next().unwrap();
            let end = (i..lines.len()).find(|j| lines[*j].contains('{')).unwrap();
            let signature: String = lines[i..=end].concat();
            let takes_tier =
                signature.contains("tier: Option<Tier>") || signature.contains("tier: Tier");
            if !takes_tier || !signature.contains("self") {
                continue;
            }
            let attrs: Vec<&str> = lines[..i]
                .iter()
                .rev()
                .map(|l| l.trim())
                .take_while(|l| l.starts_with("#[") || l.starts_with("///"))
                .collect();
            assert!(
                attrs.contains(&"#[deny_unknown_arguments]"),
                "{file}: {name} takes a tier without #[deny_unknown_arguments]"
            );
            checked += 1;
        }
    }
    assert!(checked >= 25, "only {checked} tier methods found");
}

// ---- Rates, caps and insurance cuts ----

#[test]
fn views_show_what_the_next_accrual_writes() {
    let mut w = tier_world();
    let s = w.s2x2;
    w.lend_in(NORMAL, BOB, s, 100_000 * E18).unwrap();
    w.post_real(ALICE, s, Usdc, 200_000 * E18).unwrap();
    w.borrow_in(NORMAL, ALICE, s, 80_000 * E18).unwrap();
    w.warp(YEAR);
    let view = w.view(|c| c.market_state(s, None));
    let debt = w.debt_in(NORMAL, s, ALICE);
    let lent = w.lent_in(NORMAL, s, BOB);
    // The one-year Normal example: I = 6,400, cut 640 (within the floors).
    let interest = view.total_borrow.0 - 80_000 * E18;
    let cut = view.insurance.0;
    assert_eq!((interest + WAD / 2) / WAD, 6_400);
    assert_eq!((cut + WAD / 2) / WAD, 640);
    assert_eq!(cut, mul_div_down(interest, pct(1_000), WAD));
    assert_eq!(view.total_supply.0, 100_000 * E18 + interest - cut);
    // Cash is 20,000 before and after.
    assert_eq!(
        view.total_supply.0 + view.insurance.0 - view.total_borrow.0,
        20_000 * E18
    );
    // A touch writes exactly what the views showed.
    w.lend_in(NORMAL, CAROL, s, 1 * E18).unwrap();
    let m = w.market_in(NORMAL, s);
    assert_eq!(m.total_borrow_assets, view.total_borrow.0);
    assert_eq!(m.total_supply_assets, view.total_supply.0 + E18);
    assert_eq!(w.state_in(NORMAL, s).insurance, cut);
    let accrued = &w.last.data_of("accrue")[0];
    assert_eq!(accrued["interest"], interest.to_string());
    assert_eq!(accrued["to_insurance"], cut.to_string());
    assert_eq!(w.debt_in(NORMAL, s, ALICE), debt);
    assert!(w.lent_in(NORMAL, s, BOB).abs_diff(lent) <= 1);
    // The rate the view reports is the curve at the current utilization.
    let u = irm::utilization(m.total_borrow_assets, m.total_supply_assets);
    let view = w.view(|c| c.market_state(s, None));
    let curve = w.state_in(NORMAL, s).config.curve();
    assert_eq!(view.borrow_rate_per_sec.0, curve.rate(u));
    assert_eq!(view.utilization.0, u);
}

#[test]
fn borrows_above_the_supply_never_underflow() {
    let mut w = tier_world();
    let s = w.s2x2;
    let mut c = TierState::builtin(NORMAL).config;
    c.max_utilization = WAD;
    w.set_config(s, NORMAL, config_input(&c)).unwrap();
    w.lend_in(NORMAL, BOB, s, 1_000 * E18).unwrap();
    w.post_real(ALICE, s, Usdc, 3_000 * E18).unwrap();
    w.borrow_in(NORMAL, ALICE, s, 1_000 * E18).unwrap();
    w.warp(YEAR);
    // A year at 100% with a 10% cut: borrows outgrow the supply.
    w.lend_in(NORMAL, CAROL, s, USDC_UNIT).unwrap();
    let m = w.market_in(NORMAL, s);
    assert!(m.total_borrow_assets > m.total_supply_assets);
    fails(
        w.borrow_in(NORMAL, ALICE, s, E18),
        &format!("InsufficientLiquidity({E18}, 0)"),
    );
    fails(
        w.withdraw_lent(BOB, s, Some(E18)),
        &format!("InsufficientLiquidity({E18}, 0)"),
    );
    let view = w.view(|x| x.market_state(s, None));
    assert_eq!((view.utilization.0, view.liquid.0), (WAD, 0));
    // A repayment brings liquidity back.
    w.repay_in(NORMAL, ALICE, s, 500 * E18, false).unwrap();
    w.withdraw_lent(BOB, s, Some(100 * E18)).unwrap();
}

#[test]
fn utilization_and_borrow_caps() {
    let mut w = tier_world();
    let s = w.s2x2;
    w.lend_in(NORMAL, BOB, s, 1_000 * E18).unwrap();
    w.post_real(ALICE, s, Usdc, 5_000 * E18).unwrap();
    fails(
        w.borrow_in(NORMAL, ALICE, s, 901 * E18),
        &format!("UtilizationCap({}, {})", pct(9_010), pct(9_000)),
    );
    w.borrow_in(NORMAL, ALICE, s, 900 * E18).unwrap();
    let view = w.view(|x| x.borrow_view(s, Some(acc(ALICE)), None));
    assert_eq!(view.account.max_borrow, U128(0));
    w.repay_in(NORMAL, ALICE, s, 1_000 * E18, true).unwrap();
    let mut c = TierState::builtin(NORMAL).config;
    c.borrow_cap = 500 * E18;
    w.set_config(s, NORMAL, config_input(&c)).unwrap();
    assert_eq!(
        w.view(|x| x.tier_config(s, NORMAL)).config.borrow_cap,
        Some(U128(500 * E18))
    );
    fails(
        w.borrow_in(NORMAL, ALICE, s, 501 * E18),
        &format!("BorrowCapExceeded({}, {})", 501 * E18, 500 * E18),
    );
    w.borrow_in(NORMAL, ALICE, s, 500 * E18).unwrap();
}

// ---- F7: minimum loan and liquidation sizing ----

#[test]
fn new_loans_start_at_the_minimum() {
    let mut w = tier_world();
    let s = w.s2x2;
    w.lend_in(NORMAL, BOB, s, 10_000 * E18).unwrap();
    w.post_real(ALICE, s, Usdc, 1_000 * E18).unwrap();
    fails(
        w.borrow_in(NORMAL, ALICE, s, 99 * E18),
        &format!("BelowMinLoan({}, {})", 99 * E18, 100 * E18),
    );
    w.borrow_in(NORMAL, ALICE, s, 100 * E18).unwrap();
    // A top-up of an existing loan passes.
    w.borrow_in(NORMAL, ALICE, s, E18).unwrap();
    assert_eq!(w.debt_in(NORMAL, s, ALICE), 101 * E18);
}

#[test]
fn a_partial_repayment_may_not_leave_dust() {
    let mut w = tier_world();
    let s = w.s2x2;
    w.lend_in(NORMAL, BOB, s, 10_000 * E18).unwrap();
    w.post_real(ALICE, s, Usdc, 1_000 * E18).unwrap();
    w.borrow_in(NORMAL, ALICE, s, 150 * E18).unwrap();
    fails(
        w.repay_in(NORMAL, ALICE, s, 60 * E18, false),
        &format!("DustDebtLeft({}, {})", 90 * E18, 100 * E18),
    );
    w.repay_in(NORMAL, ALICE, s, 50 * E18, false).unwrap();
    assert_eq!(w.debt_in(NORMAL, s, ALICE), 100 * E18);
    // A loan the owner's raised minimum left behind can only be repaid in full.
    w.set_params(200 * E18, pct(9_000), 400 * E18).unwrap();
    fails(
        w.repay_in(NORMAL, ALICE, s, 10 * E18, false),
        &format!("DustDebtLeft({}, {})", 90 * E18, 200 * E18),
    );
    w.deposit(ALICE, Usdc, 100 * E18).unwrap();
    w.call(ALICE, ONE_YOCTO, |c| c.repay_from_balance(s, None, None))
        .unwrap();
    assert_eq!(w.debt_in(NORMAL, s, ALICE), 0);
}

/// A Normal market with Bob's 100,000 USDC and Carol's wallet ready to
/// liquidate.
fn liq_tier_world(tier: Tier) -> World {
    let mut w = tier_world();
    let s = w.s2x2;
    w.lend_in(tier, BOB, s, 100_000 * E18).unwrap();
    w
}

#[test]
fn max_repays_half_all_or_what_seizes_everything() {
    // HF >= 0.90 and debt >= 200: half.
    let mut w = liq_tier_world(NORMAL);
    let s = w.s2x2;
    wnear_loan(&mut w, NORMAL, ALICE, 1_000 * E18, 1_000 * E18, 1_350 * E18);
    let hf = w.hf_in(NORMAL, s, ALICE).unwrap();
    assert!(hf >= pct(9_000) && hf < WAD, "{hf}");
    let status = w.view(|c| c.liquidation_status(s, acc(ALICE), None));
    assert_eq!(status.status, LiquidationState::Liquidatable);
    assert_eq!(status.max_repay, U128(500 * E18));
    let l = w
        .liquidate_with(NORMAL, CAROL, s, ALICE, None, 1_000 * E18)
        .unwrap();
    assert_eq!(l.repaid, 500 * E18);
    assert!(!l.seize_all);
    assert_eq!(w.debt_in(NORMAL, s, ALICE), 500 * E18);

    // HF < 0.90: the whole debt (Normal 0.70 / 0.06, debt 1,000, HF 0.85).
    let mut w = liq_tier_world(NORMAL);
    let c_min = 1_214_285_714_285_714_285_000;
    wnear_loan(&mut w, NORMAL, ALICE, 1_000 * E18, 1_000 * E18, c_min);
    let hf = w.hf_in(NORMAL, s, ALICE).unwrap();
    assert_eq!(hf / 10u128.pow(16), 84);
    let l = w
        .liquidate_with(NORMAL, CAROL, s, ALICE, None, 1_000 * E18)
        .unwrap();
    assert_eq!(l.repaid, 1_000 * E18);
    let target = liquidation_target(1_000 * E18, pct(600));
    assert_eq!(target, 1_060 * E18);
    assert!(!l.seize_all);
    // 87.3% of every piece; the borrower keeps 154.29 of value.
    assert_eq!(l.seized[0], mul_div_down(1_000 * E18, target, c_min));
    assert_eq!(l.seized[0] / 10u128.pow(17), 8_729);
    assert_eq!(w.debt_in(NORMAL, s, ALICE), 0);
    let left = w.lowest(s, ALICE);
    assert_eq!((left + WAD / 200) / 10u128.pow(16), 15_429);
    assert_eq!(w.view(|c| c.borrower_count(s, None)), 0);
    assert_eq!(
        w.view(|c| c.borrow_shares_of(MarketId::new(s, None), &acc(ALICE))),
        0
    );

    // A small loan (150 < 200) at HF 0.95: the whole debt; an explicit cut
    // that would leave 50 fails first.
    let mut w = liq_tier_world(NORMAL);
    let c_min = mul_div_down(950_000_000_000_000_000, 150 * E18, pct(7_000));
    wnear_loan(&mut w, NORMAL, ALICE, 1_000 * E18, 150 * E18, c_min);
    let hf = w.hf_in(NORMAL, s, ALICE).unwrap();
    assert!(hf >= pct(9_000) && hf < WAD);
    fails(
        w.liquidate_with(NORMAL, CAROL, s, ALICE, Some(100 * E18), 1_000 * E18),
        &format!("DustDebtLeft({}, {})", 50 * E18, 100 * E18),
    );
    let l = w
        .liquidate_with(NORMAL, CAROL, s, ALICE, None, 1_000 * E18)
        .unwrap();
    assert_eq!(l.repaid, 150 * E18);
    assert_eq!(liquidation_target(l.repaid, pct(600)), 159 * E18);
    assert_eq!(l.seized[0] * 1_000 / (1_000 * E18), 781);
    assert_eq!(w.debt_in(NORMAL, s, ALICE), 0);
}

#[test]
fn bold_bad_debt_is_covered_by_insurance_then_lenders() {
    let mut w = tier_world();
    let s = w.s2x2;
    for tier in Tier::ALL {
        w.lend_in(tier, BOB, s, 100_000 * E18).unwrap();
    }
    w.fund_insurance_in(BOLD, DAVE, s, 1_000 * E18).unwrap();
    assert_eq!(
        w.last.data_of("insurance_funded")[0],
        json!({"scenario_id": s, "tier": "bold", "account_id": DAVE, "amount": (1_000 * E18).to_string()})
    );
    // Debt 10,000 against collateral worth 8,000: HF 0.64, underwater.
    wnear_loan(&mut w, BOLD, ALICE, 10_000 * E18, 10_000 * E18, 8_000 * E18);
    assert_eq!(w.hf_in(BOLD, s, ALICE), Some(640_000_000_000_000_000));
    let fsr = full_seize_repay(8_000 * E18, pct(800));
    let status = w.view(|c| c.liquidation_status(s, acc(ALICE), Some(BOLD)));
    assert_eq!((status.max_repay.0, status.full_seize_repay.0), (fsr, fsr));
    let l = w
        .liquidate_with(BOLD, CAROL, s, ALICE, None, 10_000 * E18)
        .unwrap();
    assert_eq!(l.repaid, fsr);
    assert!(l.seize_all);
    let bad = 10_000 * E18 - fsr;
    assert_eq!(l.written_off, bad);
    assert_eq!(bad / 10u128.pow(16), 259_259);
    let logged = &w.last.data_of("bad_debt")[0];
    assert_eq!(logged["covered"], (1_000 * E18).to_string());
    assert_eq!(logged["socialized"], (bad - 1_000 * E18).to_string());
    assert_eq!(logged["insurance_after"], "0");
    let st = w.state_in(BOLD, s);
    assert_eq!(
        (st.insurance, st.bad_debt_covered, st.bad_debt_socialized),
        (0, 1_000 * E18, bad - 1_000 * E18)
    );
    // Bold lenders lose 1.59%; Safe and Normal lenders nothing.
    let bold = w.lent_in(BOLD, s, BOB);
    assert_eq!(100_000 * E18 - bold, bad - 1_000 * E18);
    assert_eq!((100_000 * E18 - bold) * 10_000 / (100_000 * E18), 159);
    assert_eq!(w.lent_in(SAFE, s, BOB), 100_000 * E18);
    assert_eq!(w.lent_in(NORMAL, s, BOB), 100_000 * E18);
    assert_eq!(w.debt_in(BOLD, s, ALICE), 0);
    let m = w.market_in(BOLD, s);
    assert_eq!((m.total_borrow_assets, m.total_borrow_shares), (0, 0));
}

#[test]
fn a_full_repayment_burns_every_share() {
    // v1 could leave one share behind when a liquidation repaid the whole
    // debt through `to_shares_down`.
    let mut w = liq_tier_world(NORMAL);
    let s = w.s2x2;
    w.post_real(CAROL, s, Usdc, 10_000 * E18).unwrap();
    w.borrow_in(NORMAL, CAROL, s, 3_333 * E18).unwrap();
    w.warp(7 * DAY + 13);
    let c_min = mul_div_down(800_000_000_000_000_000, 777 * E18, pct(7_000));
    wnear_loan(&mut w, NORMAL, ALICE, 1_000 * E18, 777 * E18, c_min);
    w.warp(3 * DAY + 7);
    let debt = w.debt_in(NORMAL, s, ALICE);
    let l = w
        .liquidate_with(NORMAL, DAVE, s, ALICE, Some(debt), 2 * debt)
        .unwrap();
    assert_eq!(l.repaid, debt);
    assert_eq!(
        w.view(|c| c.borrow_shares_of(MarketId::new(s, None), &acc(ALICE))),
        0
    );
    let m = w.market_in(NORMAL, s);
    assert_eq!(
        m.total_borrow_shares,
        w.view(|c| c.borrow_shares_of(MarketId::new(s, None), &acc(CAROL)))
    );
}

#[test]
fn a_debt_of_one_unit_is_liquidatable() {
    let mut w = liq_tier_world(NORMAL);
    let s = w.s2x2;
    // No minimum loan, the production small-loan line.
    w.set_params(0, pct(9_000), 200 * E18).unwrap();
    w.post_real(ALICE, s, Wnear, E18).unwrap();
    w.borrow_in(NORMAL, ALICE, s, 1).unwrap();
    set_price(s, 3, 0);
    assert_eq!(w.hf_in(NORMAL, s, ALICE), Some(0));
    let l = w
        .liquidate_with(NORMAL, CAROL, s, ALICE, None, USDC_UNIT)
        .unwrap();
    assert_eq!(l.repaid, 1);
    assert_eq!(w.debt_in(NORMAL, s, ALICE), 0);
}

#[test]
fn fund_insurance_takes_usdc_only_and_is_never_paused() {
    let mut w = tier_world();
    let s = w.s2x2;
    let msg = format!(r#"{{"action":"fund_insurance","scenario_id":{s},"tier":"safe"}}"#);
    fails(
        w.ft_transfer_call(ALICE, Wnear, E18, &msg),
        "WrongAsset(wnear)",
    );
    let msg999 = r#"{"action":"fund_insurance","scenario_id":999}"#;
    fails(
        w.ft_transfer_call(ALICE, Usdc, 1_000_000, msg999),
        "UnknownScenario(999)",
    );
    w.call(OWNER, ONE_YOCTO, |c| c.set_market_frozen(s, SAFE, true))
        .unwrap();
    let fed = w.fed;
    w.report(fed, OUT_CUTS).unwrap();
    w.call(OWNER, NO_DEPOSIT, |c| {
        c.pause.flags = crate::ops::PauseFlag::bits_of(&crate::ops::PauseFlag::ALL)
    })
    .unwrap();
    assert!(w.view(|c| c.is_halted(s)));
    w.fund_insurance_in(SAFE, ALICE, s, 7 * E18).unwrap();
    assert_eq!(w.state_in(SAFE, s).insurance, 7 * E18);
    // Insurance is not lent.
    assert_eq!(w.view(|c| c.market_state(s, Some(SAFE))).liquid.0, 0);
}

#[test]
fn the_borrow_side_reads_the_lower_of_spot_and_twap() {
    // With the price interface's bodies of the scaffold both sides read
    // the TWAP; with the price package's, the borrow side reads
    // min(spot, TWAP). Either way the borrow limit never exceeds what the
    // liquidation side carries at the borrow LTV.
    let mut w = tier_world();
    let s = w.s2x2;
    w.lend_in(NORMAL, BOB, s, 10_000 * E18).unwrap();
    w.post_real(ALICE, s, Wnear, 1_000 * E18).unwrap();
    for world in 0..4 {
        test_hooks::set_quote(
            s,
            world,
            TestQuote {
                twap: 2 * WAD,
                spot: WAD,
                status: WorldStatus::Trusted,
                full_window: true,
            },
        );
    }
    let a = w.view(|c| c.borrow_view(s, Some(acc(ALICE)), None)).account;
    let at_twap = mul_div_down(2_000 * E18, pct(6_000), WAD);
    assert!(a.borrow_limit.0 <= at_twap);
    let limit = a.borrow_limit.0;
    fails(
        w.borrow_in(NORMAL, ALICE, s, limit + E18),
        &format!("Unhealthy({}, 0)", mul_div_down(limit, WAD, limit + E18)),
    );
    w.borrow_in(NORMAL, ALICE, s, limit).unwrap();
    assert!(w.hf_in(NORMAL, s, ALICE).unwrap() >= WAD);
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 48, failure_persistence: None, ..ProptestConfig::default() })]

    /// L-5: after any successful borrow the liquidation side is healthy,
    /// whatever spot and TWAP say per world (spot below TWAP included).
    #[test]
    fn a_passing_borrow_is_never_liquidatable(
        tier_ix in 0usize..3,
        twaps in proptest::collection::vec(1_000u128..5_000, 4),
        spot_bps in proptest::collection::vec(5_000u128..=10_000, 4),
        wnear in 100u128..5_000,
        fraction in 1u128..=100,
    ) {
        let tier = Tier::ALL[tier_ix];
        let mut w = tier_world();
        let s = w.s2x2;
        w.lend_in(tier, BOB, s, 1_000_000 * E18).unwrap();
        w.post_real_in(tier, ALICE, s, Wnear, wnear * E18).unwrap();
        for world in 0..4u8 {
            let twap = twaps[world as usize] * E15;
            test_hooks::set_quote(s, world, TestQuote {
                twap,
                spot: twap * spot_bps[world as usize] / 10_000,
                status: WorldStatus::Trusted,
                full_window: true,
            });
        }
        let limit = w.view(|c| c.borrow_view(s, Some(acc(ALICE)), Some(tier))).account.borrow_limit.0;
        let amount = (limit * fraction / 100).max(100 * E18);
        if w.borrow_in(tier, ALICE, s, amount).is_ok() {
            let hf = w.hf_in(tier, s, ALICE).unwrap();
            prop_assert!(hf >= WAD, "liquidation-side HF {} after a borrow", hf);
            let status = w.view(|c| c.liquidation_status(s, acc(ALICE), Some(tier)));
            prop_assert_eq!(status.status, LiquidationState::None);
        }
    }
}
