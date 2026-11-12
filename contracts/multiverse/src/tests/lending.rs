//! The money markets: supply, borrow, repay, collateral and health, plus
//! the `ft_on_transfer` actions and their refunds,
//! payouts, interest over time, the router's internal API and storage.
//!
//! World prices come from the test price table instead of pool TWAPs, so
//! valuations are exact rather than within one tick. The router's L-shape
//! sale into lending is rebuilt from splits: the user keeps 2 wNEAR-if-SHIPS·CUTS
//! and gets the USDC-if-w a constant-product pool of 100 wNEAR depth would pay
//! for 2 wNEAR in worlds 1 to 3 (`proceeds[w]`; no assertion hard-codes them).

use near_sdk::json_types::U128;
use near_sdk::NearToken;

use super::harness::*;
use crate::amm::TEST_WORLD_PRICES;
use crate::lending::{CollateralKey, Liquidation, LiquidationState};
use crate::types::Asset::{self, Usdc, Wnear};

pub const PRICES_2X2: [u128; 4] = [3_700 * E18, 3_000 * E18, 3_300 * E18, 2_500 * E18];
pub const PRICES_BIN: [u128; 2] = [3_400 * E18, 2_800 * E18];
pub const LLTV: u128 = 750_000_000_000_000_000;
pub const BONUS: u128 = 50_000_000_000_000_000;
pub const RATE: u128 = 1_585_489_599;
pub const YEAR: u64 = 365 * DAY;
/// One micro-USDC (the token's smallest unit) in internal units.
pub const USDC_UNIT: u128 = 1_000_000_000_000;
pub const DAVE: &str = "dave.near";

pub fn set_price(sid: u64, world: u8, price: u128) {
    TEST_WORLD_PRICES.with(|m| m.borrow_mut().insert((sid, world), (price, true)));
}

pub fn set_unpriced(sid: u64, world: u8) {
    TEST_WORLD_PRICES.with(|m| m.borrow_mut().insert((sid, world), (0, false)));
}

pub fn clear_prices() {
    TEST_WORLD_PRICES.with(|m| m.borrow_mut().clear());
}

pub fn price_2x2(sid: u64) {
    for (w, p) in PRICES_2X2.iter().enumerate() {
        set_price(sid, w as u8, *p);
    }
}

pub fn price_bin(sid: u64) {
    for (w, p) in PRICES_BIN.iter().enumerate() {
        set_price(sid, w as u8, *p);
    }
}

/// The fixture: both scenarios priced at the demo prices, carol and dave
/// funded and registered, bob supplying `supplied` USDC to the 2x2 market.
pub fn lending_world(supplied: u128) -> World {
    clear_prices();
    let mut w = World::new();
    price_2x2(w.s2x2);
    price_bin(w.s_bin);
    w.register(DAVE, NearToken::from_near(1));
    w.fund(CAROL);
    w.fund(DAVE);
    w.warp(61);
    let s = w.s2x2;
    w.lend(BOB, s, supplied).unwrap();
    w
}

/// Whole token units covering `internal`, rounded up.
pub fn usdc_units(internal: u128) -> u128 {
    internal.div_ceil(USDC_UNIT)
}

pub fn rel_close(a: u128, b: u128, rel_wad: u128) -> bool {
    let diff = a.abs_diff(b);
    diff <= multiverse_math::mul_div_down(a.max(b), rel_wad, E18)
}

/// Lending calls and reads on the test chain.
pub trait Lend {
    fn lend(&mut self, who: &str, sid: u64, amount: u128) -> Result<(), String>;
    fn withdraw_lent(&mut self, who: &str, sid: u64, amount: Option<u128>) -> Result<u128, String>;
    fn post(&mut self, who: &str, sid: u64, piece: &str, amount: u128) -> Result<(), String>;
    fn post_real(&mut self, who: &str, sid: u64, asset: Asset, amount: u128) -> Result<(), String>;
    fn unpost(&mut self, who: &str, sid: u64, piece: &str, amount: u128) -> Result<(), String>;
    fn borrow(&mut self, who: &str, sid: u64, amount: u128) -> Result<(), String>;
    fn repay_ft(&mut self, who: &str, sid: u64, attached: u128, all: bool) -> Result<u128, String>;
    fn liquidate(
        &mut self,
        who: &str,
        sid: u64,
        account: &str,
        repay: Option<u128>,
    ) -> Result<Liquidation, String>;
    fn debt(&mut self, sid: u64, who: &str) -> u128;
    fn hf(&mut self, sid: u64, who: &str) -> (Option<u128>, u8);
    fn values(&mut self, sid: u64, who: &str) -> Vec<u128>;
    fn pieces(&mut self, sid: u64, who: &str) -> Vec<(String, u128)>;
    fn held(&mut self, sid: u64, who: &str, piece: &str) -> u128;
    fn lent(&mut self, sid: u64, who: &str) -> u128;
    fn lowest(&mut self, sid: u64, who: &str) -> u128;
    fn usdc_total(&mut self, who: &str) -> u128;
    fn l_shape(&mut self, who: &str) -> [u128; 4];
}

impl Lend for World {
    fn lend(&mut self, who: &str, sid: u64, amount: u128) -> Result<(), String> {
        let msg = format!(r#"{{"action":"supply","scenario_id":{sid}}}"#);
        assert_eq!(amount % USDC_UNIT, 0, "test setup: whole micro-USDC only");
        let unused = self.ft_transfer_call(who, Usdc, amount / USDC_UNIT, &msg)?;
        assert_eq!(unused, 0);
        Ok(())
    }

    fn withdraw_lent(&mut self, who: &str, sid: u64, amount: Option<u128>) -> Result<u128, String> {
        self.call(who, ONE_YOCTO, |c| {
            c.withdraw_supply(sid, amount.map(U128)).0
        })
    }

    fn post(&mut self, who: &str, sid: u64, piece: &str, amount: u128) -> Result<(), String> {
        let piece = piece.to_string();
        self.call(who, ONE_YOCTO, |c| {
            c.deposit_collateral(sid, piece, U128(amount))
        })
    }

    fn post_real(&mut self, who: &str, sid: u64, asset: Asset, amount: u128) -> Result<(), String> {
        let msg = format!(r#"{{"action":"deposit_collateral","scenario_id":{sid}}}"#);
        assert_eq!(
            amount % scale(asset),
            0,
            "test setup: whole token units only"
        );
        let unused = self.ft_transfer_call(who, asset, amount / scale(asset), &msg)?;
        assert_eq!(unused, 0);
        Ok(())
    }

    fn unpost(&mut self, who: &str, sid: u64, piece: &str, amount: u128) -> Result<(), String> {
        let piece = piece.to_string();
        self.call(who, ONE_YOCTO, |c| {
            c.withdraw_collateral(sid, piece, U128(amount))
        })
    }

    fn borrow(&mut self, who: &str, sid: u64, amount: u128) -> Result<(), String> {
        self.call(who, ONE_YOCTO, |c| c.borrow(sid, U128(amount)))
    }

    /// `repay` action with `attached` (internal, rounded up to whole
    /// micro-USDC); returns what was repaid.
    fn repay_ft(&mut self, who: &str, sid: u64, attached: u128, all: bool) -> Result<u128, String> {
        let msg = format!(r#"{{"action":"repay","scenario_id":{sid},"all":{all}}}"#);
        self.ft_transfer_call(who, Usdc, usdc_units(attached), &msg)?;
        let repaid = self.last.data_of("repay")[0]["assets"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        Ok(repaid)
    }

    /// `liquidate` action attaching enough USDC for the repayment (half the
    /// debt for `None`); the rest comes back.
    fn liquidate(
        &mut self,
        who: &str,
        sid: u64,
        account: &str,
        repay: Option<u128>,
    ) -> Result<Liquidation, String> {
        let (amount, attach) = match repay {
            Some(r) => (format!(r#""{r}""#), r.max(1)),
            None => (
                r#""max""#.to_string(),
                self.debt(sid, account) / 2 + USDC_UNIT,
            ),
        };
        let msg = format!(
            r#"{{"action":"liquidate","scenario_id":{sid},"account_id":"{account}","repay_amount":{amount}}}"#
        );
        self.ft_transfer_call(who, Usdc, usdc_units(attach), &msg)?;
        let log = &self.last.data_of("liquidate")[0];
        let u = |v: &near_sdk::serde_json::Value| -> u128 { v.as_str().unwrap().parse().unwrap() };
        let pieces = log["pieces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| CollateralKey::parse(sid, p.as_str().unwrap()).unwrap())
            .collect();
        Ok(Liquidation {
            repaid: u(&log["repaid"]),
            shares: u(&log["shares"]),
            pieces,
            seized: log["seized"].as_array().unwrap().iter().map(u).collect(),
        })
    }

    fn debt(&mut self, sid: u64, who: &str) -> u128 {
        let who = acc(who);
        self.view(|c| c.debt_of(sid, who).0)
    }

    fn hf(&mut self, sid: u64, who: &str) -> (Option<u128>, u8) {
        let who = acc(who);
        let h = self.view(|c| c.health_factor(sid, who));
        (h.health_factor.map(|v| v.0), h.worst_world.unwrap())
    }

    fn values(&mut self, sid: u64, who: &str) -> Vec<u128> {
        let who = acc(who);
        self.view(|c| c.collateral_values(sid, who))
            .values
            .iter()
            .map(|v| v.0)
            .collect()
    }

    fn pieces(&mut self, sid: u64, who: &str) -> Vec<(String, u128)> {
        let who = acc(who);
        self.view(|c| c.collateral_of(sid, who))
            .into_iter()
            .map(|p| (p.piece, p.amount.0))
            .collect()
    }

    fn held(&mut self, sid: u64, who: &str, piece: &str) -> u128 {
        self.pieces(sid, who)
            .into_iter()
            .find(|(p, _)| p == piece)
            .map_or(0, |(_, a)| a)
    }

    fn lent(&mut self, sid: u64, who: &str) -> u128 {
        let who = acc(who);
        self.view(|c| c.supply_balance_of(sid, who).0)
    }

    fn lowest(&mut self, sid: u64, who: &str) -> u128 {
        let possible = self.possible(sid);
        self.values(sid, who)
            .into_iter()
            .enumerate()
            .filter(|(w, _)| possible & (1 << w) != 0)
            .map(|(_, v)| v)
            .min()
            .unwrap()
    }

    /// Wallet plus internal USDC, in internal units.
    fn usdc_total(&mut self, who: &str) -> u128 {
        self.wallet(who, Usdc) + self.real(who, Usdc)
    }

    /// The router's `conditionalSell(s2x2, 2 wNEAR, L_SHAPE, into lending)`,
    /// rebuilt from splits. Returns `proceeds` (world 0 unused).
    fn l_shape(&mut self, who: &str) -> [u128; 4] {
        let s = self.s2x2;
        let mut proceeds = [0u128; 4];
        for w in 1..4 {
            proceeds[w] = cpmm_out(2 * E18, 100 * E18, 100 * PRICES_2X2[w]);
        }
        let total: u128 = proceeds.iter().sum();
        self.deposit(who, Usdc, total.div_ceil(E18) * E18).unwrap();
        self.split_ft(who, s, Wnear, &[SHIPS_CUTS, L_SHAPE], 2 * E18)
            .unwrap();
        self.post(who, s, &token_id(s, Wnear, SHIPS_CUTS), 2 * E18)
            .unwrap();
        for w in 1..4u8 {
            let single = 1u8 << w;
            self.split(
                who,
                s,
                Usdc,
                ROOT,
                &[single, ROOT ^ single],
                proceeds[w as usize],
            )
            .unwrap();
            self.post(who, s, &token_id(s, Usdc, single), proceeds[w as usize])
                .unwrap();
        }
        proceeds
    }
}

/// Exact-input output of a constant-product pool at the base fee (0.3%).
pub fn cpmm_out(amount_in: u128, reserve_in: u128, reserve_out: u128) -> u128 {
    let in_after_fee = amount_in * 997 / 1000;
    multiverse_math::mul_div_down(reserve_out, in_after_fee, reserve_in + in_after_fee)
}

pub fn hf_of(lowest: u128, debt: u128) -> u128 {
    multiverse_math::mul_div_down(lowest, LLTV, debt)
}

#[test]
fn supply_and_withdraw() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s2x2;
    assert_eq!(w.lent(s, BOB), 50_000 * E18);
    assert_eq!(
        w.view(|c| c.supply_principal_of(s, acc(BOB)).0),
        50_000 * E18
    );
    w.withdraw_lent(BOB, s, Some(20_000 * E18)).unwrap();
    assert_eq!(w.wallet(BOB, Usdc), FUND - 30_000 * E18);
    assert_eq!(
        w.view(|c| c.supply_principal_of(s, acc(BOB)).0),
        30_000 * E18
    );
    w.withdraw_lent(BOB, s, None).unwrap();
    assert_eq!(w.wallet(BOB, Usdc), FUND);
    assert_eq!(w.view(|c| c.supply_shares_of(s, &acc(BOB))), 0);
    assert_eq!(w.view(|c| c.supply_principal_of(s, acc(BOB)).0), 0);
}

#[test]
fn lenders_earn_the_borrow_rate() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s2x2;
    w.l_shape(ALICE);
    w.borrow(ALICE, s, 3_000 * E18).unwrap();
    w.warp(YEAR);
    let debt = w.debt(s, ALICE);
    assert!(
        rel_close(debt, 3_150 * E18, 1_000_000_000_000),
        "debt {debt}"
    );
    let interest = debt - 3_000 * E18;
    let balance = w.lent(s, BOB);
    assert!(
        balance.abs_diff(50_000 * E18 + interest) <= 1_000_000,
        "balance {balance}"
    );
    let m = w.view(|c| c.market_state(s));
    assert!(m.utilization.0 > 0);
    assert_eq!(
        m.supply_rate_per_sec.0,
        multiverse_math::mul_div_down(RATE, m.utilization.0, E18)
    );
}

#[test]
fn withdraw_fails() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s2x2;
    fails(
        w.withdraw_lent(BOB, s, Some(60_000 * E18)),
        &format!("InsufficientSupply({}, {})", 60_000 * E18, 50_000 * E18),
    );
    w.l_shape(ALICE);
    w.borrow(ALICE, s, 3_000 * E18).unwrap();
    fails(
        w.withdraw_lent(BOB, s, Some(50_000 * E18)),
        &format!("InsufficientLiquidity({}, {})", 50_000 * E18, 47_000 * E18),
    );
    fails(w.withdraw_lent(CAROL, s, None), "ZeroAmount");
}

#[test]
fn alice_borrows_worst_world_is_delayed_holds() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s2x2;
    let proceeds = w.l_shape(ALICE);
    let v = w.view(|c| c.collateral_values(s, acc(ALICE)));
    assert_eq!(v.possible, ROOT);
    assert_eq!(v.values[0].0, 7_400 * E18);
    for (value, paid) in v.values.iter().zip(proceeds).skip(1) {
        assert_eq!(value.0, paid);
    }
    let wallet = w.wallet(ALICE, Usdc);
    w.borrow(ALICE, s, 3_000 * E18).unwrap();
    let (hf, worst) = w.hf(s, ALICE);
    assert_eq!(worst, 3);
    assert_eq!(hf, Some(hf_of(proceeds[3], 3_000 * E18)));
    assert!(hf.unwrap() > E18);
    assert_eq!(w.wallet(ALICE, Usdc), wallet + 3_000 * E18);
}

#[test]
fn borrow_fails_below_health_factor_one() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s2x2;
    let proceeds = w.l_shape(ALICE);
    let max = multiverse_math::mul_div_down(proceeds[3], LLTV, E18);
    let err = w.borrow(ALICE, s, max + E18).unwrap_err();
    assert!(err.starts_with("Unhealthy("), "{err}");
    w.borrow(ALICE, s, max - E18).unwrap();
}

#[test]
fn real_assets_count_in_every_world() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s2x2;
    w.post_real(ALICE, s, Usdc, 1_000 * E18).unwrap();
    w.post_real(ALICE, s, Wnear, E18).unwrap();
    let values = w.values(s, ALICE);
    for (wd, price) in PRICES_2X2.iter().enumerate() {
        assert_eq!(values[wd], 1_000 * E18 + price);
    }
    assert_eq!(
        w.pieces(s, ALICE),
        vec![("usdc".into(), 1_000 * E18), ("wnear".into(), E18)]
    );
}

#[test]
fn deposit_collateral_fails() {
    let mut w = lending_world(50_000 * E18);
    let (s, bin) = (w.s2x2, w.s_bin);
    // neither a real asset nor a token id
    fails(w.post(ALICE, s, "dai", E18), "NotCollateral(dai)");
    // a token of another scenario
    let bin_token = token_id(bin, Usdc, BIN_SHIPS);
    w.split_ft(ALICE, bin, Usdc, &[BIN_SHIPS, BIN_DELAYED], 10 * E18)
        .unwrap();
    fails(
        w.post(ALICE, s, &bin_token, E18),
        &format!("NotCollateral({bin_token})"),
    );
    // root is the real asset, never a token
    fails(
        w.post(ALICE, s, "1:wnear:15", E18),
        "NotCollateral(1:wnear:15)",
    );
    fails(
        w.post(ALICE, s, "1:wnear:0", E18),
        "NotCollateral(1:wnear:0)",
    );
    fails(w.post(ALICE, 999, "wnear", E18), "UnknownScenario(999)");
    // a verse that died
    w.split_ft(ALICE, s, Wnear, &[CUTS, HOLDS], E18).unwrap();
    let fed = w.fed;
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    fails(
        w.post(ALICE, s, &token_id(s, Wnear, CUTS), E18),
        &format!("DeadVerse({CUTS})"),
    );
    fails(w.post(ALICE, s, "wnear", 0), "ZeroAmount");
    // the internal balance must hold it
    fails(
        w.post(ALICE, s, "wnear", E18),
        &format!("InsufficientBalance({ALICE}, 0, {E18})"),
    );
}

#[test]
fn withdraw_collateral_keeps_the_loan_safe() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s2x2;
    let proceeds = w.l_shape(ALICE);
    w.borrow(ALICE, s, 3_000 * E18).unwrap();
    let piece = token_id(s, Usdc, DELAYED_HOLDS);
    let err = w.unpost(ALICE, s, &piece, proceeds[3]).unwrap_err();
    assert!(err.starts_with("Unhealthy("), "{err}");
    w.unpost(ALICE, s, &piece, 100 * E18).unwrap();
    assert_eq!(w.bal(ALICE, s, Usdc, DELAYED_HOLDS), 100 * E18);
    assert_eq!(w.held(s, ALICE, &piece), proceeds[3] - 100 * E18);
}

#[test]
fn repay_then_withdraw_everything() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s2x2;
    w.l_shape(ALICE);
    w.borrow(ALICE, s, 3_000 * E18).unwrap();
    w.warp(30 * DAY);
    let debt = w.debt(s, ALICE);
    let repaid = w.repay_ft(ALICE, s, debt + USDC_UNIT, true).unwrap();
    assert!(repaid > 3_000 * E18);
    assert_eq!(repaid, debt);
    assert_eq!(w.debt(s, ALICE), 0);
    for (piece, amount) in w.pieces(s, ALICE) {
        w.unpost(ALICE, s, &piece, amount).unwrap();
    }
    assert!(w.pieces(s, ALICE).is_empty());
    assert_eq!(w.hf(s, ALICE).0, None);
}

/// World prices that need TWAP history and the depth gate, seen from
/// lending: a world
/// whose pool has no valid price (too young or under the depth gate) values
/// wNEAR at 0, and the price counts again once it is valid.
#[test]
fn world_without_price_counts_zero() {
    let mut w = lending_world(50_000 * E18);
    let bin = w.s_bin;
    set_unpriced(bin, 0);
    w.post_real(ALICE, bin, Wnear, E18).unwrap();
    assert_eq!(w.values(bin, ALICE), vec![0, PRICES_BIN[1]]);
    set_price(bin, 0, PRICES_BIN[0]);
    assert_eq!(w.values(bin, ALICE), vec![PRICES_BIN[0], PRICES_BIN[1]]);
}

#[test]
fn resolution_never_lowers_health_factor() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s2x2;
    w.l_shape(ALICE);
    w.borrow(ALICE, s, 3_000 * E18).unwrap();
    let (hf0, _) = w.hf(s, ALICE);
    let (fed, spice) = (w.fed, w.spice);
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    let (hf1, worst1) = w.hf(s, ALICE);
    assert!(hf1 >= hf0);
    assert_eq!(worst1, 3);
    w.admin_resolve(spice, OUT_DELAYED).unwrap();
    let (hf2, worst2) = w.hf(s, ALICE);
    assert!(hf2 >= hf1);
    assert_eq!(worst2, 3);
    assert!(hf2.unwrap() >= E18);
}

#[test]
fn interest_accrues_over_time() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s2x2;
    let first = w.view(|c| c.market_state(s));
    // the first touch only stamps the time
    assert_eq!(first.last_update_sec, w.now);
    assert!(w.last.data_of("accrue").is_empty());
    w.l_shape(ALICE);
    w.borrow(ALICE, s, 3_000 * E18).unwrap();
    // views add pending interest without writing it
    w.warp(DAY);
    let expected = 3_000 * E18 * (RATE * u128::from(DAY)) / E18;
    assert_eq!(w.debt(s, ALICE), 3_000 * E18 + expected);
    let m = w.view(|c| c.market_state(s));
    assert_eq!(m.total_borrow.0, 3_000 * E18 + expected);
    assert_eq!(m.total_supply.0, 50_000 * E18 + expected);
    assert_eq!(w.view(|c| c.market(s)).total_borrow_assets, 3_000 * E18);
    // a touch writes it to both sides and logs it
    w.lend(CAROL, s, 1_000 * E18).unwrap();
    let accrued = w.last.data_of("accrue");
    assert_eq!(accrued[0]["interest"], expected.to_string());
    let stored = w.view(|c| c.market(s));
    assert_eq!(stored.total_borrow_assets, 3_000 * E18 + expected);
    assert_eq!(stored.total_supply_assets, 51_000 * E18 + expected);
    assert_eq!(stored.last_update, w.now);
    // several touches in one second accrue nothing between them
    w.lend(CAROL, s, 1_000 * E18).unwrap();
    assert!(w.last.data_of("accrue").is_empty());
    // simple within an interval, compounding across touches
    for _ in 0..30 {
        w.warp(DAY);
        w.lend(CAROL, s, E18).unwrap();
    }
    let daily = w.debt(s, ALICE);
    let mut once = lending_world(50_000 * E18);
    once.l_shape(ALICE);
    once.borrow(ALICE, s, 3_000 * E18).unwrap();
    once.warp(31 * DAY);
    assert!(daily > once.debt(s, ALICE));
}

#[test]
fn ft_actions_refund_what_they_do_not_use() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s2x2;
    w.l_shape(ALICE);
    w.borrow(ALICE, s, 3_000 * E18).unwrap();
    let wallet = w.wallet(ALICE, Usdc);
    let dust = w.real(ALICE, Usdc);
    // a partial repayment uses all of it
    let repaid = w.repay_ft(ALICE, s, 1_000 * E18, false).unwrap();
    assert_eq!(repaid, 1_000 * E18);
    assert_eq!(w.wallet(ALICE, Usdc), wallet - 1_000 * E18);
    // more than the debt repays the debt and refunds the rest
    let debt = w.debt(s, ALICE);
    let repaid = w.repay_ft(ALICE, s, 5_000 * E18, false).unwrap();
    assert_eq!(repaid, debt);
    assert_eq!(w.debt(s, ALICE), 0);
    // whole micro-USDC go back; the rest stays as internal dust
    assert_eq!(w.usdc_total(ALICE), wallet + dust - 1_000 * E18 - debt);
    // `all` needs the whole debt attached
    w.borrow(ALICE, s, 2_000 * E18).unwrap();
    let wallet = w.wallet(ALICE, Usdc);
    fails(
        w.repay_ft(ALICE, s, 1_000 * E18, true),
        &format!("InsufficientRepayment({}, {})", 1_000 * E18, 2_000 * E18),
    );
    assert_eq!(w.wallet(ALICE, Usdc), wallet);
    // nothing to repay
    fails(w.repay_ft(CAROL, s, E18, false), "ZeroAmount");
    // USDC only
    let msg = format!(r#"{{"action":"supply","scenario_id":{s}}}"#);
    fails(
        w.ft_transfer_call(ALICE, Wnear, E18, &msg),
        "WrongAsset(wnear)",
    );
    let msg = format!(r#"{{"action":"repay","scenario_id":{s},"all":false}}"#);
    fails(
        w.ft_transfer_call(ALICE, Wnear, E18, &msg),
        "WrongAsset(wnear)",
    );
    fails(w.lend(ALICE, 999, E18), "UnknownScenario(999)");
}

#[test]
fn repay_from_balance_and_one_yocto() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s2x2;
    w.l_shape(ALICE);
    w.borrow(ALICE, s, 3_000 * E18).unwrap();
    let yocto = "Requires attached deposit of exactly 1 yoctoNEAR";
    fails(w.call(ALICE, NO_DEPOSIT, |c| c.borrow(s, U128(E18))), yocto);
    fails(
        w.call(ALICE, NO_DEPOSIT, |c| c.withdraw_supply(s, None)),
        yocto,
    );
    fails(
        w.call(ALICE, NO_DEPOSIT, |c| {
            c.deposit_collateral(s, "wnear".into(), U128(1))
        }),
        yocto,
    );
    fails(
        w.call(ALICE, NO_DEPOSIT, |c| {
            c.withdraw_collateral(s, "wnear".into(), U128(1))
        }),
        yocto,
    );
    fails(
        w.call(ALICE, NO_DEPOSIT, |c| c.repay_from_balance(s, None)),
        yocto,
    );
    let real = w.real(ALICE, Usdc);
    w.deposit(ALICE, Usdc, 1_000 * E18).unwrap();
    let repaid = w
        .call(ALICE, ONE_YOCTO, |c| {
            c.repay_from_balance(s, Some(U128(400 * E18)))
        })
        .unwrap();
    assert_eq!(repaid.0, 400 * E18);
    assert_eq!(w.real(ALICE, Usdc), real + 600 * E18);
    let (real, debt) = (w.real(ALICE, Usdc), w.debt(s, ALICE));
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.repay_from_balance(s, None)),
        &format!("InsufficientBalance({ALICE}, {real}, {debt})"),
    );
}

#[test]
fn real_collateral_is_paid_out_and_verse_goes_back_to_the_ledger() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s2x2;
    let wallet = w.wallet(ALICE, Wnear);
    w.post_real(ALICE, s, Wnear, 2 * E18).unwrap();
    assert_eq!(w.wallet(ALICE, Wnear), wallet - 2 * E18);
    w.unpost(ALICE, s, "wnear", E18).unwrap();
    assert_eq!(w.wallet(ALICE, Wnear), wallet - E18);
    assert_eq!(w.held(s, ALICE, "wnear"), E18);
    fails(
        w.unpost(ALICE, s, "wnear", 2 * E18),
        &format!("InsufficientCollateral({}, {})", 2 * E18, E18),
    );
    fails(
        w.unpost(ALICE, s, "usdc", 1),
        "InsufficientCollateral(1, 0)",
    );
    fails(w.unpost(ALICE, s, "nope", 1), "NotCollateral(nope)");
    // verse pieces move through the ledger, with NEP-245 logs
    w.split_ft(ALICE, s, Wnear, &[SHIPS, DELAYED], 3 * E18)
        .unwrap();
    let ships = token_id(s, Wnear, SHIPS);
    w.post(ALICE, s, &ships, 3 * E18).unwrap();
    assert_eq!(w.bal(ALICE, s, Wnear, SHIPS), 0);
    let moves = w.last.data_of("mt_transfer");
    assert_eq!(moves[0]["new_owner_id"], CONTRACT);
    assert_eq!(w.supply(s, Wnear, SHIPS), 3 * E18);
    w.assert_conservation(&[ALICE, BOB, CAROL, DAVE, OWNER]);
    w.unpost(ALICE, s, &ships, 3 * E18).unwrap();
    assert_eq!(w.bal(ALICE, s, Wnear, SHIPS), 3 * E18);
    assert_eq!(w.last.data_of("mt_transfer")[0]["old_owner_id"], CONTRACT);
    assert_eq!(w.pieces(s, ALICE), vec![("wnear".into(), E18)]);
    w.assert_conservation(&[ALICE, BOB, CAROL, DAVE, OWNER]);
}

#[test]
fn piece_list_is_capped_and_swap_popped() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s2x2;
    w.deposit(ALICE, Wnear, 100 * E18).unwrap();
    w.deposit(ALICE, Usdc, 100 * E18).unwrap();
    let mut ids = vec!["wnear".to_string(), "usdc".to_string()];
    for asset in [Wnear, Usdc] {
        for mask in 1..ROOT {
            if ids.len() == 16 {
                break;
            }
            w.split(ALICE, s, asset, ROOT, &[mask, ROOT ^ mask], E18)
                .unwrap();
            ids.push(token_id(s, asset, mask));
        }
    }
    for id in &ids {
        w.post(ALICE, s, id, E18).unwrap();
    }
    w.split(ALICE, s, Usdc, ROOT, &[3, 12], E18).unwrap();
    fails(
        w.post(ALICE, s, &token_id(s, Usdc, 3), E18),
        "TooManyCollateralTokens",
    );
    // topping up an existing piece is fine
    w.post(ALICE, s, "wnear", E18).unwrap();
    // removing the second piece moves the last one into its place
    w.unpost(ALICE, s, "usdc", E18).unwrap();
    let list: Vec<String> = w.pieces(s, ALICE).into_iter().map(|(p, _)| p).collect();
    assert_eq!(list[1], ids[15]);
    assert_eq!(list.len(), 15);
}

#[test]
fn router_api() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s2x2;
    let alice = acc(ALICE);
    w.deposit(ALICE, Wnear, 2 * E18).unwrap();
    w.deposit(ALICE, Usdc, 500 * E18).unwrap();
    w.split_ft(ALICE, s, Usdc, &[HOLDS, CUTS], 1_000 * E18)
        .unwrap();
    let a = alice.clone();
    w.call(ALICE, ONE_YOCTO, |c| {
        c.deposit_collateral_for(&a, s, CollateralKey::Real(Wnear), 2 * E18);
        c.deposit_collateral_for(
            &a,
            s,
            CollateralKey::Verse {
                asset: Usdc,
                mask: HOLDS,
            },
            1_000 * E18,
        );
        c.borrow_for(&a, s, 2_000 * E18);
    })
    .unwrap();
    assert_eq!(w.view(|c| c.debt_for(s, &alice)), 2_000 * E18);
    // the borrowed USDC went to the wallet
    assert_eq!(
        w.wallet(ALICE, Usdc),
        FUND - 500 * E18 - 1_000 * E18 + 2_000 * E18
    );
    w.warp(DAY);
    let a = alice.clone();
    let repaid = w
        .call(ALICE, ONE_YOCTO, |c| c.repay_for(&a, s, 300 * E18))
        .unwrap();
    assert_eq!(repaid, 300 * E18);
    // still in debt: taking everything back fails
    let a = alice.clone();
    let err = w
        .call(ALICE, ONE_YOCTO, |c| c.withdraw_all_collateral_for(&a, s))
        .unwrap_err();
    assert!(err.starts_with("Unhealthy(0, "), "{err}");
    w.deposit(ALICE, Usdc, 2_000 * E18).unwrap();
    let a = alice.clone();
    let debt = w.view(|c| c.debt_for(s, &a));
    let real_before = w.real(ALICE, Usdc);
    let a = alice.clone();
    let repaid = w
        .call(ALICE, ONE_YOCTO, |c| c.repay_for(&a, s, u128::MAX))
        .unwrap();
    assert_eq!(repaid, debt);
    let a = alice.clone();
    let back = w
        .call(ALICE, ONE_YOCTO, |c| c.withdraw_all_collateral_for(&a, s))
        .unwrap();
    assert_eq!(
        back,
        vec![
            (CollateralKey::Real(Wnear), 2 * E18),
            (
                CollateralKey::Verse {
                    asset: Usdc,
                    mask: HOLDS
                },
                1_000 * E18
            )
        ]
    );
    assert_eq!(w.real(ALICE, Wnear), 2 * E18);
    assert_eq!(w.real(ALICE, Usdc), real_before - debt);
    assert_eq!(w.bal(ALICE, s, Usdc, HOLDS), 1_000 * E18);
    // nothing posted: nothing to do
    let a = alice.clone();
    assert!(w
        .call(ALICE, ONE_YOCTO, |c| c.withdraw_all_collateral_for(&a, s))
        .unwrap()
        .is_empty());
    let a = alice.clone();
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.repay_for(&a, s, u128::MAX)),
        "ZeroAmount",
    );
}

#[test]
fn storage_is_charged_and_unregister_waits_for_positions() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s2x2;
    w.split_ft(DAVE, s, Wnear, &[SHIPS, DELAYED], 2 * E18)
        .unwrap();
    let before = w.storage_used(DAVE);
    let ships = token_id(s, Wnear, SHIPS);
    w.post(DAVE, s, &ships, E18).unwrap();
    let posted = w.storage_used(DAVE);
    assert!(posted > before, "a new piece list costs storage");
    w.unpost(DAVE, s, &ships, E18).unwrap();
    assert_eq!(
        w.storage_used(DAVE),
        before,
        "an emptied list frees it again"
    );
    // lenders and borrowers cannot unregister while they hold a position
    w.lend(DAVE, s, 100 * E18).unwrap();
    fails(
        w.call(DAVE, ONE_YOCTO, |c| c.storage_unregister(None)),
        &format!("AccountNotEmpty({DAVE})"),
    );
    w.withdraw_lent(DAVE, s, None).unwrap();
    w.merge(DAVE, s, Wnear, &[SHIPS, DELAYED], ROOT, 2 * E18)
        .unwrap();
    assert!(w
        .call(DAVE, ONE_YOCTO, |c| c.storage_unregister(None))
        .unwrap());
    // an unregistered sender cannot act at all
    fails(w.lend(DAVE, s, E18), &format!("NotRegistered({DAVE})"));
}

#[test]
fn events_are_compact_and_complete() {
    let mut w = lending_world(50_000 * E18);
    let s = w.s2x2;
    let supply = w.last.data_of("supply");
    assert_eq!(
        supply[0],
        near_sdk::serde_json::json!({
            "scenario_id": s, "account_id": BOB,
            "assets": (50_000 * E18).to_string(), "shares": (50_000 * E18 * 1_000_000).to_string()
        })
    );
    w.post_real(ALICE, s, Usdc, 2_000 * E18).unwrap();
    assert_eq!(
        w.last.data_of("deposit_collateral")[0],
        near_sdk::serde_json::json!({
            "scenario_id": s, "account_id": ALICE, "piece": "usdc", "amount": (2_000 * E18).to_string()
        })
    );
    w.borrow(ALICE, s, 1_000 * E18).unwrap();
    let b = &w.last.data_of("borrow")[0];
    assert_eq!(b["assets"], (1_000 * E18).to_string());
    assert_eq!(b["shares"], (1_000 * E18 * 1_000_000).to_string());
    w.withdraw_lent(BOB, s, Some(E18)).unwrap();
    assert_eq!(w.last.data_of("withdraw")[0]["assets"], E18.to_string());
    w.unpost(ALICE, s, "usdc", E18).unwrap();
    assert_eq!(w.last.data_of("withdraw_collateral")[0]["piece"], "usdc");
    assert_eq!(
        w.view(|c| c.liquidation_status(s, acc(ALICE))).status,
        LiquidationState::None
    );
}
