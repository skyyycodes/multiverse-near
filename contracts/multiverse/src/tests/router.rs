//! The router over pools and orders, test by test, the router probes, the
//! demo sale's golden numbers on real pools, the transfer actions and their
//! refunds, the direct methods, storage and the per-receipt log budget.
//!
//! There is no router account: whatever a trade briefly holds lives in
//! the user's ledger during the call, so "the router ends empty" becomes
//! value conservation over every holder and module, checked after every
//! action the helpers run.

use multiverse_math::orders::{cost, proceeds};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::NearToken;
use proptest::prelude::*;

use super::amm::*;
use super::harness::*;
use super::lending::{clear_prices, Lend, LLTV, USDC_UNIT};
use super::orders::{order, RAVI};
use crate::orders::Side;
use crate::types::Asset::{self, Usdc, Wnear};
use crate::types::VerseKey;

const HOLDERS: [&str; 5] = [OWNER, ALICE, BOB, CAROL, RAVI];
/// Ravi's demo bid: 1,000 NEAR at 2.45 USDC per NEAR, 2% under DELAYED·HOLDS.
const RAVI_PRICE: u128 = 2_450 * E15;
const RAVI_SIZE: u128 = 1_000 * E18;
/// What Ravi's whole bid pays: 2,450 USDC.
const RAVI_ESCROW: u128 = 2_450 * E18;
/// Alice's demo sale: 2,000 NEAR.
const SALE: u128 = 2_000 * E18;
const HALF: u128 = E18 / 2;
/// 1,000 NEAR, the demo's order size.
const K: u128 = 1_000 * E18;
const SUPPLIED: u128 = 100_000 * E18;
const BORROW: u128 = 3_000 * E18;

/// The prototype's demo numbers, raw (wNEAR-if-w as token0).
const PROTO_PROCEEDS: [u128; 4] = [
    0,
    5_865_050_885_346_196_835_108,
    6_451_555_973_880_816_518_618,
    4_881_885_259_897_065_638_949,
];
const PROTO_BIN_PROCEEDS: u128 = 5_474_047_492_989_783_712_767;
const PROTO_HF: u128 = 1_220_471_314_974_266_409;

type Plans = Vec<Vec<(u64, u128)>>;

fn no_plans(worlds: usize) -> Plans {
    vec![Vec::new(); worlds]
}

/// A plan with `fills` in world `world` only.
fn plan_in(worlds: usize, world: usize, fills: &[(u64, u128)]) -> Plans {
    let mut p = no_plans(worlds);
    p[world] = fills.to_vec();
    p
}

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

fn amounts_json(values: &[u128]) -> Value {
    values.iter().map(|v| v.to_string()).collect()
}

fn amounts(v: &Value) -> Vec<u128> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|a| a.as_str().unwrap().parse().unwrap())
        .collect()
}

fn as_u128(v: &Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

fn plain(xs: &[U128]) -> Vec<u128> {
    xs.iter().map(|x| x.0).collect()
}

/// Token units of `asset` covering `internal`, rounded up.
fn units(asset: Asset, internal: u128) -> u128 {
    internal.div_ceil(scale(asset))
}

/// The router fixture: the 2x2 pools at the demo prices (world 3 `w3_depth`
/// wNEAR deep, the others 100,000), the binary pools, Bob lending 100,000 USDC in
/// both markets, Ravi and Carol funded, and a full TWAP window behind.
fn router_world(w3_depth: u128) -> (World, Vec<u64>, Vec<u64>) {
    clear_prices();
    let mut w = pool_world();
    w.register(RAVI, NearToken::from_near(1));
    w.fund(RAVI);
    let (s, sb) = (w.s2x2, w.s_bin);
    let p2 = seed_worlds(&mut w, s, &DEMO_2X2, &[DEPTH, DEPTH, DEPTH, w3_depth]);
    let pb = seed_worlds(&mut w, sb, &DEMO_BIN, &[DEPTH; 2]);
    w.lend(BOB, s, SUPPLIED).unwrap();
    w.lend(BOB, sb, SUPPLIED).unwrap();
    w.warp(61);
    (w, p2, pb)
}

/// Every 2x2 pool 100,000 wNEAR deep.
fn full_world() -> (World, Vec<u64>, Vec<u64>) {
    router_world(DEPTH)
}

/// World 3 is the thin 40,000 wNEAR pool.
fn thin_world() -> (World, Vec<u64>, Vec<u64>) {
    router_world(THIN_DEPTH)
}

trait Router {
    #[allow(clippy::too_many_arguments)]
    fn sell(
        &mut self,
        who: &str,
        sid: u64,
        amount: u128,
        mask: u8,
        plans: &Plans,
        min_out: &[u128],
        to_lending: bool,
    ) -> Result<Vec<u128>, String>;
    #[allow(clippy::too_many_arguments)]
    fn buy(
        &mut self,
        who: &str,
        sid: u64,
        usdc: u128,
        mask: u8,
        plans: &Plans,
        min_out: &[u128],
        to_lending: bool,
    ) -> Result<Vec<u128>, String>;
    #[allow(clippy::too_many_arguments)]
    fn sell_and_borrow(
        &mut self,
        who: &str,
        sid: u64,
        amount: u128,
        mask: u8,
        plans: &Plans,
        min_out: &[u128],
        borrow: u128,
    ) -> Result<Vec<u128>, String>;
    #[allow(clippy::too_many_arguments)]
    fn post_from_real(
        &mut self,
        who: &str,
        sid: u64,
        mask: u8,
        side: Side,
        price: u128,
        amount: u128,
        expiry: u64,
    ) -> Result<u64, String>;
    fn close(&mut self, who: &str, sid: u64, attached: u128) -> Result<(u128, u32), String>;
    fn close_direct(&mut self, who: &str, sid: u64) -> Result<u128, String>;
    fn conserved(&mut self);
}

impl Router for World {
    /// `conditional_sell` by wNEAR `ft_transfer_call`; returns the proceeds.
    fn sell(
        &mut self,
        who: &str,
        sid: u64,
        amount: u128,
        mask: u8,
        plans: &Plans,
        min_out: &[u128],
        to_lending: bool,
    ) -> Result<Vec<u128>, String> {
        let msg = json!({
            "action": "conditional_sell", "scenario_id": sid, "sell_mask": mask,
            "plans": plans_json(plans), "min_out": amounts_json(min_out), "to_lending": to_lending,
        });
        let unused = self.ft_transfer_call(who, Wnear, amount, &msg.to_string())?;
        assert_eq!(unused, 0);
        let out = amounts(&self.last.data_of("conditional_sale")[0]["proceeds"]);
        self.conserved();
        Ok(out)
    }

    /// `conditional_buy` by USDC `ft_transfer_call` (whole micro-USDC).
    fn buy(
        &mut self,
        who: &str,
        sid: u64,
        usdc: u128,
        mask: u8,
        plans: &Plans,
        min_out: &[u128],
        to_lending: bool,
    ) -> Result<Vec<u128>, String> {
        assert_eq!(usdc % USDC_UNIT, 0, "test setup: whole micro-USDC only");
        let msg = json!({
            "action": "conditional_buy", "scenario_id": sid, "buy_mask": mask,
            "plans": plans_json(plans), "min_out": amounts_json(min_out), "to_lending": to_lending,
        });
        let unused = self.ft_transfer_call(who, Usdc, usdc / USDC_UNIT, &msg.to_string())?;
        assert_eq!(unused, 0);
        let out = amounts(&self.last.data_of("conditional_buy")[0]["bought"]);
        self.conserved();
        Ok(out)
    }

    fn sell_and_borrow(
        &mut self,
        who: &str,
        sid: u64,
        amount: u128,
        mask: u8,
        plans: &Plans,
        min_out: &[u128],
        borrow: u128,
    ) -> Result<Vec<u128>, String> {
        let msg = json!({
            "action": "sell_and_borrow", "scenario_id": sid, "sell_mask": mask,
            "plans": plans_json(plans), "min_out": amounts_json(min_out),
            "borrow_amount": borrow.to_string(),
        });
        let unused = self.ft_transfer_call(who, Wnear, amount, &msg.to_string())?;
        assert_eq!(unused, 0);
        let out = amounts(&self.last.data_of("conditional_sale")[0]["proceeds"]);
        self.conserved();
        Ok(out)
    }

    /// `post_order` attaching exactly the escrow (rounded up to token units).
    fn post_from_real(
        &mut self,
        who: &str,
        sid: u64,
        mask: u8,
        side: Side,
        price: u128,
        amount: u128,
        expiry: u64,
    ) -> Result<u64, String> {
        let (asset, escrow) = match side {
            Side::Ask => (Wnear, amount),
            Side::Bid => (Usdc, cost(amount, price)),
        };
        let msg = json!({
            "action": "post_order", "scenario_id": sid, "mask": mask, "side": side,
            "price": price.to_string(), "amount": amount.to_string(), "expiry_sec": expiry,
        });
        let unused =
            self.ft_transfer_call(who, asset, units(asset, escrow).max(1), &msg.to_string())?;
        assert_eq!(unused, 0);
        let id = self.last.data_of("order_posted")[0]["order_id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        self.conserved();
        Ok(id)
    }

    /// `close_after_resolution` attaching `attached` USDC (rounded up to
    /// token units). Returns `(repaid, pieces)` from the `closed` event.
    fn close(&mut self, who: &str, sid: u64, attached: u128) -> Result<(u128, u32), String> {
        let msg = json!({"action": "close_after_resolution", "scenario_id": sid}).to_string();
        self.ft_transfer_call(who, Usdc, units(Usdc, attached).max(1), &msg)?;
        let closed = self.last.data_of("closed")[0].clone();
        self.conserved();
        Ok((
            as_u128(&closed["repaid"]),
            closed["pieces"].as_u64().unwrap() as u32,
        ))
    }

    fn close_direct(&mut self, who: &str, sid: u64) -> Result<u128, String> {
        let r = self.call(who, ONE_YOCTO, |c| c.close_after_resolution(sid).0)?;
        self.conserved();
        Ok(r)
    }

    fn conserved(&mut self) {
        self.assert_conservation(&HOLDERS);
    }
}

/// Ravi's bid: 1,000 wNEAR-if-DELAYED·HOLDS at 2.45, posted from real USDC.
fn ravi_bid(w: &mut World) -> u64 {
    let (s, e) = (w.s2x2, w.now + 30 * DAY);
    w.post_from_real(RAVI, s, DELAYED_HOLDS, Side::Bid, RAVI_PRICE, RAVI_SIZE, e)
        .unwrap()
}

fn quote_sell(w: &mut World, sid: u64, amount: u128, mask: u8) -> Vec<u128> {
    plain(&w.view(|c| c.quote_sell(sid, U128(amount), mask)))
}

/// What `amount_in` USDC-if-w buys in `pool` right now.
fn quote_buy(w: &mut World, pool: u64, amount_in: u128) -> u128 {
    w.view(|c| c.quote_exact_in(pool, false, amount_in))
        .unwrap()
}

fn escrow_held(w: &mut World, sid: u64, asset: Asset, mask: u8) -> u128 {
    super::orders::held(w, sid, asset, mask)
}

fn piece(sid: u64, asset: Asset, mask: u8) -> String {
    token_id(sid, asset, mask)
}

// Router over pools

#[test]
fn alice_sale_2x2_l_shape() {
    let (mut w, ..) = full_world();
    let s = w.s2x2;
    let out = w
        .sell(ALICE, s, SALE, L_SHAPE, &no_plans(4), &[0; 4], false)
        .unwrap();
    assert_eq!(out[0], 0);
    assert_eq!(w.bal(ALICE, s, Wnear, SHIPS_CUTS), SALE);
    let caps = [0, 6000 * E18, 6600 * E18, 5000 * E18];
    for i in 1..4u8 {
        let k = usize::from(i);
        assert_eq!(w.bal(ALICE, s, Usdc, 1 << i), out[k]);
        assert_eq!(w.bal(ALICE, s, Wnear, 1 << i), 0);
        assert!(out[k] < caps[k] && within_rel(out[k], caps[k], 33));
    }
    // a 100,000 wNEAR pool everywhere: x*y=k with the fee on the input
    assert_eq!(
        [cents(out[1]), cents(out[2]), cents(out[3])],
        [586505, 645155, 488754]
    );
    assert_eq!(w.wallet(ALICE, Wnear), FUND - SALE);
    assert_eq!(w.real(ALICE, Wnear), 0);
}

#[test]
fn alice_sale_binary() {
    let (mut w, ..) = full_world();
    let sb = w.s_bin;
    let out = w
        .sell(ALICE, sb, SALE, BIN_DELAYED, &no_plans(2), &[0; 2], false)
        .unwrap();
    assert_eq!(out[0], 0);
    assert_eq!(w.bal(ALICE, sb, Wnear, BIN_SHIPS), SALE);
    assert_eq!(w.bal(ALICE, sb, Usdc, BIN_DELAYED), out[1]);
    assert!(out[1] < 5600 * E18 && within_rel(out[1], 5600 * E18, 33));
    assert_eq!(cents(out[1]), 547404);
}

#[test]
fn min_out_is_enforced_per_world() {
    let (mut w, ..) = full_world();
    let s = w.s2x2;
    let q = quote_sell(&mut w, s, SALE, L_SHAPE);
    let min = [0, 0, 0, 5000 * E18];
    fails(
        w.sell(ALICE, s, SALE, L_SHAPE, &no_plans(4), &min, false),
        &format!("InsufficientOutput(3, {}, {})", q[3], 5000 * E18),
    );
    assert_eq!(w.wallet(ALICE, Wnear), FUND);
    // exactly the quote passes
    let out = w
        .sell(ALICE, s, SALE, L_SHAPE, &no_plans(4), &q, false)
        .unwrap();
    assert_eq!(out, q);
}

#[test]
fn after_resolution_only_live_worlds_are_split() {
    let (mut w, ..) = full_world();
    let (s, fed) = (w.s2x2, w.fed);
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    let out = w
        .sell(ALICE, s, E18, DELAYED_HOLDS, &no_plans(4), &[0; 4], false)
        .unwrap();
    assert_eq!(w.bal(ALICE, s, Wnear, SHIPS_HOLDS), E18);
    assert_eq!(w.bal(ALICE, s, Usdc, DELAYED_HOLDS), out[3]);
    assert!(out[3] > 0);
    for mask in [SHIPS_CUTS, DELAYED_CUTS] {
        for asset in [Wnear, Usdc] {
            assert_eq!(w.bal(ALICE, s, asset, mask), 0);
        }
    }
    // the dead worlds' supply is still just the seeded pools'
    assert_eq!(w.supply(s, Wnear, SHIPS_CUTS), DEPTH);
}

#[test]
fn rejects_bad_requests() {
    let (mut w, ..) = full_world();
    let s = w.s2x2;
    w.deposit(ALICE, Wnear, E18).unwrap();
    fails(
        w.call(ALICE, ONE_YOCTO, |c| {
            c.conditional_sell(
                s,
                U128(0),
                L_SHAPE,
                vec![vec![]; 4],
                vec![U128(0); 4],
                false,
            )
        }),
        "ZeroAmount",
    );
    let p4 = no_plans(4);
    fails(
        w.sell(ALICE, s, E18, 0, &p4, &[0; 4], false),
        "BadSellMask(0)",
    );
    fails(
        w.sell(ALICE, s, E18, 0x10, &p4, &[0; 4], false),
        "BadSellMask(16)",
    );
    fails(
        w.sell(ALICE, s, E18, L_SHAPE, &no_plans(2), &[0; 4], false),
        "LengthMismatch",
    );
    fails(
        w.sell(ALICE, s, E18, L_SHAPE, &p4, &[0; 3], false),
        "LengthMismatch",
    );
    fails(
        w.sell(
            ALICE,
            s,
            E18,
            L_SHAPE,
            &plan_in(4, 3, &[(0, 0)]),
            &[0; 4],
            false,
        ),
        "PlanOrderMismatch(3, 0)",
    );
    fails(
        w.sell(ALICE, 99, E18, L_SHAPE, &p4, &[0; 4], false),
        "UnknownScenario(99)",
    );
    // the mask is checked before the lengths
    fails(
        w.sell(ALICE, s, E18, 0x10, &no_plans(2), &[0; 3], false),
        "BadSellMask(16)",
    );
    assert_eq!(w.wallet(ALICE, Wnear), FUND - E18);
    assert_eq!(w.real(ALICE, Wnear), E18);
}

/// Lending is always live; this checks what `to_lending` does instead.
#[test]
fn to_lending_posts_every_piece() {
    let (mut w, ..) = full_world();
    let s = w.s2x2;
    let out = w
        .sell(ALICE, s, SALE, L_SHAPE, &no_plans(4), &[0; 4], true)
        .unwrap();
    let mut expected = vec![(piece(s, Wnear, SHIPS_CUTS), SALE)];
    for i in 1..4u8 {
        expected.push((piece(s, Usdc, 1 << i), out[usize::from(i)]));
        assert_eq!(w.bal(ALICE, s, Usdc, 1 << i), 0);
    }
    assert_eq!(w.pieces(s, ALICE), expected);
    assert_eq!(w.bal(ALICE, s, Wnear, SHIPS_CUTS), 0);
    assert_eq!(w.debt(s, ALICE), 0);
}

#[test]
fn rejects_selling_a_dead_world() {
    let (mut w, ..) = full_world();
    let (s, fed) = (w.s2x2, w.fed);
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    fails(
        w.sell(ALICE, s, SALE, L_SHAPE, &no_plans(4), &[0; 4], false),
        "BadSellMask(14)",
    );
}

#[test]
fn close_after_resolution_repays_withdraws_and_redeems() {
    let (mut w, ..) = full_world();
    let (s, spice, fed) = (w.s2x2, w.spice, w.fed);
    let usdc_start = w.usdc_total(ALICE);
    let out = w
        .sell_and_borrow(ALICE, s, SALE, L_SHAPE, &no_plans(4), &[0; 4], BORROW)
        .unwrap();
    assert_eq!(w.wallet(ALICE, Usdc), FUND + BORROW);
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    w.admin_resolve(spice, OUT_DELAYED).unwrap();
    w.warp(3600);
    let debt = w.debt(s, ALICE);
    assert!(debt > BORROW);
    let before = w.usdc_total(ALICE);
    let (repaid, pieces) = w.close(ALICE, s, debt + debt / 1000).unwrap();
    assert_eq!((repaid, pieces), (debt, 4));
    assert_eq!(w.debt(s, ALICE), 0);
    assert!(w.pieces(s, ALICE).is_empty());
    // the collapsed USDC-if-DELAYED·HOLDS came back as real USDC
    assert_eq!(w.usdc_total(ALICE), before - debt + out[3]);
    assert_eq!(w.usdc_total(ALICE), usdc_start + BORROW - debt + out[3]);
    assert_eq!(w.bal(ALICE, s, Usdc, DELAYED_HOLDS), 0);
    // dead pieces come back as tokens
    assert_eq!(w.bal(ALICE, s, Wnear, SHIPS_CUTS), SALE);
    assert_eq!(w.bal(ALICE, s, Usdc, SHIPS_HOLDS), out[2]);
    assert_eq!(w.bal(ALICE, s, Usdc, DELAYED_CUTS), out[1]);
    // only whole micro-USDC left for the wallet; the dust stays inside
    assert!(w.real(ALICE, Usdc) < USDC_UNIT);
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 32, failure_persistence: None, ..ProptestConfig::default() })]

    #[test]
    fn sale_keeps_backing(amount in 1_000_000_000u128..=20_000 * E18, mask in 1u8..=15) {
        let (mut w, ..) = full_world();
        let s = w.s2x2;
        let out = w.sell(ALICE, s, amount, mask, &no_plans(4), &[0; 4], false).unwrap();
        for i in 0..4u8 {
            let k = usize::from(i);
            if mask & (1 << i) != 0 {
                prop_assert_eq!(w.bal(ALICE, s, Wnear, 1 << i), 0);
                prop_assert_eq!(w.bal(ALICE, s, Usdc, 1 << i), out[k]);
                prop_assert!(out[k] > 0);
            } else {
                prop_assert_eq!(w.bal(ALICE, s, Wnear, 1 << i), amount);
                prop_assert_eq!(w.bal(ALICE, s, Usdc, 1 << i), 0);
                prop_assert_eq!(out[k], 0);
            }
            // every single-world wNEAR token is backed one to one
            prop_assert_eq!(w.supply(s, Wnear, 1 << i), w.reserves(s, Wnear));
        }
        prop_assert_eq!(w.held_by_contract(Wnear), w.reserves(s, Wnear) + w.reserves(w.s_bin, Wnear));
    }
}

// Router over orders and pools

#[test]
fn demo_ravi_bid_beats_the_pool_on_alices_sale() {
    let (mut w, p2, _) = thin_world();
    let s = w.s2x2;
    let id = ravi_bid(&mut w);
    let fair = price_of(&mut w, p2[3]);
    assert!(RAVI_PRICE < fair);
    let pool_only = quote_sell(&mut w, s, SALE, L_SHAPE);
    let slice = quote_sell(&mut w, s, K, DELAYED_HOLDS)[3];
    assert!(pool_only[3] / 2_000 < RAVI_PRICE);
    let ravi_before = w.bal(RAVI, s, Wnear, DELAYED_HOLDS);
    let planned = w
        .sell(
            ALICE,
            s,
            SALE,
            L_SHAPE,
            &plan_in(4, 3, &[(id, K)]),
            &[0; 4],
            false,
        )
        .unwrap();
    assert_eq!(planned[3], RAVI_ESCROW + slice);
    assert!(planned[3] > pool_only[3]);
    assert_eq!(planned[1..3], pool_only[1..3]);
    assert_eq!(w.bal(RAVI, s, Wnear, DELAYED_HOLDS), ravi_before + K);
    assert_eq!(w.bal(ALICE, s, Usdc, DELAYED_HOLDS), planned[3]);
    assert_eq!(order(&mut w, id).remaining.0, 0);
    assert_eq!(escrow_held(&mut w, s, Usdc, DELAYED_HOLDS), 0);
    assert_eq!(
        (cents(pool_only[3]), cents(slice), cents(planned[3])),
        (474829, 243188, 488188)
    );
}

#[test]
fn accept_bid_fills_only_pool_untouched() {
    let (mut w, p2, _) = thin_world();
    let s = w.s2x2;
    let id = ravi_bid(&mut w);
    let price_before = price_of(&mut w, p2[3]);
    let out = w
        .sell(
            ALICE,
            s,
            K,
            DELAYED_HOLDS,
            &plan_in(4, 3, &[(id, K)]),
            &[0, 0, 0, RAVI_ESCROW],
            false,
        )
        .unwrap();
    assert_eq!(out[3], RAVI_ESCROW);
    assert_eq!(price_of(&mut w, p2[3]), price_before);
    assert!(w.last.data_of("swap").is_empty());
    for mask in [SHIPS_CUTS, DELAYED_CUTS, SHIPS_HOLDS] {
        assert_eq!(w.bal(ALICE, s, Wnear, mask), K);
    }
}

#[test]
fn plan_several_orders_and_a_partial_fill() {
    let (mut w, _, _) = thin_world();
    let s = w.s2x2;
    let a = ravi_bid(&mut w);
    let e = w.now + DAY;
    let b = w
        .post_from_real(BOB, s, DELAYED_HOLDS, Side::Bid, 2_440 * E15, SALE, e)
        .unwrap();
    let slice = quote_sell(&mut w, s, 3 * K / 2, DELAYED_HOLDS)[3];
    let out = w
        .sell(
            ALICE,
            s,
            3 * K,
            DELAYED_HOLDS,
            &plan_in(4, 3, &[(a, K), (b, K / 2)]),
            &[0; 4],
            false,
        )
        .unwrap();
    assert_eq!(out[3], RAVI_ESCROW + 1220 * E18 + slice);
    assert_eq!(order(&mut w, a).remaining.0, 0);
    let ob = order(&mut w, b);
    assert_eq!((ob.remaining.0, ob.escrow.0), (3 * K / 2, 3660 * E18));
    assert_eq!(w.bal(BOB, s, Wnear, DELAYED_HOLDS), K / 2);
}

#[test]
fn plan_binary_scenario() {
    let (mut w, ..) = thin_world();
    let sb = w.s_bin;
    let e = w.now + DAY;
    let id = w
        .post_from_real(RAVI, sb, BIN_DELAYED, Side::Bid, 2_780 * E15, K / 2, e)
        .unwrap();
    let out = w
        .sell(
            ALICE,
            sb,
            SALE,
            BIN_DELAYED,
            &plan_in(2, 1, &[(id, K / 2)]),
            &[0; 2],
            false,
        )
        .unwrap();
    assert!(out[1] > 1390 * E18);
    assert_eq!(w.bal(RAVI, sb, Wnear, BIN_DELAYED), K / 2);
    assert_eq!(w.bal(ALICE, sb, Wnear, BIN_SHIPS), SALE);
}

#[test]
fn sell_and_borrow_with_ravis_bid() {
    let (mut w, ..) = thin_world();
    let s = w.s2x2;
    let id = ravi_bid(&mut w);
    let out = w
        .sell_and_borrow(
            ALICE,
            s,
            SALE,
            L_SHAPE,
            &plan_in(4, 3, &[(id, K)]),
            &[0; 4],
            BORROW,
        )
        .unwrap();
    assert_eq!(w.held(s, ALICE, &piece(s, Usdc, DELAYED_HOLDS)), out[3]);
    assert_eq!(w.debt(s, ALICE), BORROW);
    assert_eq!(order(&mut w, id).remaining.0, 0);
    assert_eq!(w.wallet(ALICE, Usdc), FUND + BORROW);
}

#[test]
fn plan_fails() {
    let (mut w, ..) = thin_world();
    let (s, sb) = (w.s2x2, w.s_bin);
    let e = w.now + DAY;
    let bid = ravi_bid(&mut w);
    let ask = w
        .post_from_real(BOB, s, DELAYED_HOLDS, Side::Ask, 2_600 * E15, K, e)
        .unwrap();
    let other = w
        .post_from_real(BOB, s, DELAYED_CUTS, Side::Bid, 2_900 * E15, K, e)
        .unwrap();
    let bin = w
        .post_from_real(BOB, sb, BIN_DELAYED, Side::Bid, 2_700 * E15, K, e)
        .unwrap();
    let z = [0; 4];
    // a plan in a world that is not sold
    fails(
        w.sell(ALICE, s, K, 0x6, &plan_in(4, 3, &[(bid, K)]), &z, false),
        "BadPlan(3)",
    );
    // more than the world has
    fails(
        w.sell(
            ALICE,
            s,
            K / 2,
            DELAYED_HOLDS,
            &plan_in(4, 3, &[(bid, K)]),
            &z,
            false,
        ),
        "BadPlan(3)",
    );
    fails(
        w.sell(
            ALICE,
            s,
            SALE,
            DELAYED_HOLDS,
            &plan_in(4, 3, &[(bid, 3 * K / 2)]),
            &z,
            false,
        ),
        &format!("AmountExceedsRemaining({bid}, {}, {K})", 3 * K / 2),
    );
    fails(
        w.sell(
            ALICE,
            s,
            K,
            DELAYED_HOLDS,
            &plan_in(4, 3, &[(ask, K)]),
            &z,
            false,
        ),
        &format!("PlanOrderMismatch(3, {ask})"),
    );
    fails(
        w.sell(
            ALICE,
            s,
            K,
            DELAYED_HOLDS,
            &plan_in(4, 3, &[(other, K)]),
            &z,
            false,
        ),
        &format!("PlanOrderMismatch(3, {other})"),
    );
    // the binary bid's mask 0x2 is DELAYED·CUTS in the 2x2, but another scenario
    fails(
        w.sell(
            ALICE,
            s,
            K,
            DELAYED_CUTS,
            &plan_in(4, 1, &[(bin, K)]),
            &z,
            false,
        ),
        &format!("PlanOrderMismatch(1, {bin})"),
    );
    fails(
        w.sell(
            ALICE,
            s,
            K,
            DELAYED_HOLDS,
            &plan_in(4, 3, &[(999, K)]),
            &z,
            false,
        ),
        "PlanOrderMismatch(3, 999)",
    );
    fails(
        w.sell(
            ALICE,
            s,
            K,
            DELAYED_HOLDS,
            &plan_in(4, 3, &[(bid, K)]),
            &[0, 0, 0, RAVI_ESCROW + 1],
            false,
        ),
        &format!("InsufficientOutput(3, {RAVI_ESCROW}, {})", RAVI_ESCROW + 1),
    );
    assert_eq!(w.wallet(ALICE, Wnear), FUND);
    assert_eq!(order(&mut w, bid).remaining.0, K);
}

#[test]
fn plan_stale_order_fails() {
    let (mut w, ..) = thin_world();
    let (s, fed) = (w.s2x2, w.fed);
    let id = ravi_bid(&mut w);
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    fails(
        w.sell(
            ALICE,
            s,
            K,
            DELAYED_HOLDS,
            &plan_in(4, 3, &[(id, K)]),
            &[0; 4],
            false,
        ),
        &format!("StaleOrder({id}, 0, 1)"),
    );
    let refund = super::orders::cancel(&mut w, RAVI, id).unwrap();
    assert_eq!(refund, RAVI_ESCROW);
}

#[test]
fn post_order_bid_maker_is_the_caller() {
    let (mut w, ..) = thin_world();
    let s = w.s2x2;
    let e = w.now + 30 * DAY;
    let wallet = w.wallet(RAVI, Usdc);
    let id = w
        .post_from_real(RAVI, s, DELAYED_HOLDS, Side::Bid, RAVI_PRICE, E18, e)
        .unwrap();
    let posted = w.last.data_of("order_posted")[0].clone();
    assert_eq!(
        posted,
        json!({
            "order_id": id.to_string(), "scenario_id": s, "maker": RAVI, "mask": DELAYED_HOLDS,
            "side": "bid", "price": RAVI_PRICE.to_string(), "amount": E18.to_string(),
            "expiry_sec": e, "epoch": 0,
        })
    );
    assert_eq!(order(&mut w, id).maker.as_str(), RAVI);
    assert_eq!(w.wallet(RAVI, Usdc), wallet - RAVI_PRICE);
    for mask in [SHIPS_CUTS, DELAYED_CUTS, SHIPS_HOLDS] {
        assert_eq!(w.bal(RAVI, s, Usdc, mask), RAVI_PRICE);
    }
    assert_eq!(w.bal(RAVI, s, Usdc, DELAYED_HOLDS), 0);
    assert_eq!(escrow_held(&mut w, s, Usdc, DELAYED_HOLDS), RAVI_PRICE);
    // the smallest order keeps the 3-unit shape: escrow rounds up
    let tiny = 1_000_000_000_000_000 + 3;
    let id2 = w
        .post_from_real(RAVI, s, DELAYED_HOLDS, Side::Bid, 3 * HALF, tiny, e)
        .unwrap();
    assert_eq!(order(&mut w, id2).escrow.0, 1_500_000_000_000_000 + 5);
    // the part of the last micro-USDC the escrow did not use stays inside
    assert_eq!(w.real(RAVI, Usdc), USDC_UNIT - 5);
}

#[test]
fn post_order_ask_outcome_mask() {
    let (mut w, ..) = thin_world();
    let s = w.s2x2;
    let e = w.now + DAY;
    w.post_from_real(ALICE, s, DELAYED, Side::Ask, 3_000 * E15, E18, e)
        .unwrap();
    assert_eq!(escrow_held(&mut w, s, Wnear, DELAYED), E18);
    assert_eq!(w.bal(ALICE, s, Wnear, SHIPS_CUTS), E18);
    assert_eq!(w.bal(ALICE, s, Wnear, SHIPS_HOLDS), E18);
    assert_eq!(w.bal(ALICE, s, Wnear, DELAYED), 0);
}

#[test]
fn post_order_after_resolution() {
    let (mut w, ..) = thin_world();
    let (s, fed) = (w.s2x2, w.fed);
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    let e = w.now + DAY;
    let id = w
        .post_from_real(RAVI, s, DELAYED_HOLDS, Side::Bid, 2_600 * E15, E18, e)
        .unwrap();
    assert_eq!(order(&mut w, id).epoch, 1);
    assert_eq!(w.bal(RAVI, s, Usdc, SHIPS_HOLDS), 2_600 * E15);
    assert_eq!(w.bal(RAVI, s, Usdc, SHIPS_CUTS), 0);
    assert_eq!(w.bal(RAVI, s, Usdc, DELAYED_CUTS), 0);
}

#[test]
fn post_order_fails() {
    let (mut w, ..) = thin_world();
    let (s, spice) = (w.s2x2, w.spice);
    let e = w.now + DAY;
    let post = |w: &mut World,
                asset: Asset,
                attach: u128,
                mask: u8,
                side: &str,
                price: u128,
                amount: u128,
                expiry: u64| {
        let msg = json!({
            "action": "post_order", "scenario_id": s, "mask": mask, "side": side,
            "price": price.to_string(), "amount": amount.to_string(), "expiry_sec": expiry,
        });
        w.ft_transfer_call(RAVI, asset, attach, &msg.to_string())
    };
    let usdc = units(Usdc, RAVI_PRICE);
    fails(post(&mut w, Usdc, usdc, 8, "bid", 0, E18, e), "ZeroAmount");
    fails(
        post(&mut w, Wnear, E18, 8, "ask", RAVI_PRICE, 0, e),
        "ZeroAmount",
    );
    fails(post(&mut w, Wnear, E18, 8, "ask", 0, E18, e), "ZeroPrice");
    fails(
        post(&mut w, Usdc, usdc, ROOT, "bid", RAVI_PRICE, E18, e),
        "NotStrictSubset(15, 15)",
    );
    fails(
        post(&mut w, Usdc, usdc, 0x10, "bid", RAVI_PRICE, E18, e),
        "NotStrictSubset(16, 15)",
    );
    fails(
        post(&mut w, Usdc, usdc, 0, "bid", RAVI_PRICE, E18, e),
        "NotStrictSubset(0, 15)",
    );
    let now = w.now;
    fails(
        post(&mut w, Usdc, usdc, 8, "bid", RAVI_PRICE, E18, now),
        &format!("ExpiryInPast({now})"),
    );
    // NEAR: the asset must match the side, and the transfer must cover the escrow
    fails(
        post(&mut w, Wnear, E18, 8, "bid", RAVI_PRICE, E18, e),
        "WrongAsset(wnear)",
    );
    fails(
        post(&mut w, Usdc, usdc, 8, "ask", RAVI_PRICE, E18, e),
        "WrongAsset(usdc)",
    );
    fails(
        post(&mut w, Usdc, usdc - 1, 8, "bid", RAVI_PRICE, E18, e),
        &format!(
            "InsufficientDeposit({}, {RAVI_PRICE})",
            RAVI_PRICE - USDC_UNIT
        ),
    );
    let msg = json!({
        "action": "post_order", "scenario_id": 99, "mask": 8, "side": "bid",
        "price": RAVI_PRICE.to_string(), "amount": E18.to_string(), "expiry_sec": e,
    });
    fails(
        w.ft_transfer_call(RAVI, Usdc, usdc, &msg.to_string()),
        "UnknownScenario(99)",
    );
    w.admin_resolve(spice, OUT_SHIPS).unwrap();
    fails(
        post(&mut w, Usdc, usdc, 8, "bid", RAVI_PRICE, E18, e),
        "DeadVerse(8)",
    );
    assert_eq!(w.wallet(RAVI, Usdc), FUND);
    assert_eq!(w.wallet(RAVI, Wnear), FUND);
}

#[test]
fn post_order_returns_what_the_escrow_does_not_use() {
    let (mut w, ..) = thin_world();
    let s = w.s2x2;
    let msg = json!({
        "action": "post_order", "scenario_id": s, "mask": 8, "side": "bid",
        "price": RAVI_PRICE.to_string(), "amount": K.to_string(), "expiry_sec": w.now + DAY,
    });
    let attached = units(Usdc, 3000 * E18);
    let unused = w
        .ft_transfer_call(RAVI, Usdc, attached, &msg.to_string())
        .unwrap();
    assert_eq!(unused, units(Usdc, 550 * E18));
    assert_eq!(w.wallet(RAVI, Usdc), FUND - RAVI_ESCROW);
    assert_eq!(w.real(RAVI, Usdc), 0);
    w.conserved();
}

#[test]
fn conditional_buy_pool_only() {
    let (mut w, ..) = thin_world();
    let s = w.s2x2;
    let got = w
        .buy(
            BOB,
            s,
            5000 * E18,
            DELAYED_HOLDS,
            &no_plans(4),
            &[0; 4],
            false,
        )
        .unwrap();
    assert!(got[3] > 1_850 * E18 && got[3] < SALE);
    assert_eq!(w.bal(BOB, s, Wnear, DELAYED_HOLDS), got[3]);
    for mask in [SHIPS_CUTS, DELAYED_CUTS, SHIPS_HOLDS] {
        assert_eq!(w.bal(BOB, s, Usdc, mask), 5000 * E18);
    }
    assert_eq!(got[..3], [0, 0, 0]);
}

#[test]
fn conditional_buy_fills_asks_first() {
    let (mut w, p2, _) = thin_world();
    let s = w.s2x2;
    let e = w.now + DAY;
    let ask = w
        .post_from_real(CAROL, s, DELAYED_HOLDS, Side::Ask, 2_510 * E15, K, e)
        .unwrap();
    let pool_only = quote_buy(&mut w, p2[3], 5000 * E18);
    let slice = quote_buy(&mut w, p2[3], 2490 * E18);
    let got = w
        .buy(
            BOB,
            s,
            5000 * E18,
            DELAYED_HOLDS,
            &plan_in(4, 3, &[(ask, K)]),
            &[0; 4],
            false,
        )
        .unwrap();
    assert_eq!(got[3], K + slice);
    assert!(got[3] > pool_only);
    assert_eq!(w.bal(CAROL, s, Usdc, DELAYED_HOLDS), 2_510 * E18);
    assert_eq!(order(&mut w, ask).remaining.0, 0);
}

/// The 3-unit ask at 1.5, on the smallest order: buying 1e15 + 1 costs
/// the rounded-up 1.5e15 + 2, and the pool is not touched.
#[test]
fn accept_ask_exact_cost() {
    let (mut w, p2, _) = thin_world();
    let s = w.s2x2;
    let e = w.now + DAY;
    let size = 1_000_000_000_000_000 + 3;
    let ask = w
        .post_from_real(CAROL, s, DELAYED_HOLDS, Side::Ask, 3 * HALF, size, e)
        .unwrap();
    let price_before = price_of(&mut w, p2[3]);
    let pay = 1_500_000_000_000_000 + 2;
    w.deposit(BOB, Usdc, 2 * USDC_UNIT * 1000).unwrap();
    let got = w
        .call(BOB, ONE_YOCTO, |c| {
            let mut plans = vec![vec![]; 4];
            plans[3] = vec![crate::router::PlanFill {
                order_id: U64(ask),
                amount: U128(1_000_000_000_000_000 + 1),
            }];
            c.conditional_buy(s, U128(pay), DELAYED_HOLDS, plans, vec![U128(0); 4], false)
        })
        .unwrap();
    w.conserved();
    assert_eq!(got[3].0, 1_000_000_000_000_000 + 1);
    assert_eq!(price_of(&mut w, p2[3]), price_before);
    assert_eq!(w.bal(CAROL, s, Usdc, DELAYED_HOLDS), pay);
    assert_eq!(order(&mut w, ask).remaining.0, 2);
}

#[test]
fn buy_plan_fails() {
    let (mut w, ..) = thin_world();
    let s = w.s2x2;
    let e = w.now + DAY;
    let bid = ravi_bid(&mut w);
    let ask = w
        .post_from_real(CAROL, s, DELAYED_HOLDS, Side::Ask, 2_510 * E15, K, e)
        .unwrap();
    fails(
        w.buy(
            BOB,
            s,
            5000 * E18,
            DELAYED_HOLDS,
            &plan_in(4, 3, &[(bid, K)]),
            &[0; 4],
            false,
        ),
        &format!("PlanOrderMismatch(3, {bid})"),
    );
    fails(
        w.buy(
            BOB,
            s,
            2000 * E18,
            DELAYED_HOLDS,
            &plan_in(4, 3, &[(ask, K)]),
            &[0; 4],
            false,
        ),
        "BadPlan(3)",
    );
    fails(
        w.buy(
            BOB,
            s,
            2_510 * E18,
            DELAYED_HOLDS,
            &plan_in(4, 3, &[(ask, K)]),
            &[0, 0, 0, K + 1],
            false,
        ),
        &format!("InsufficientOutput(3, {K}, {})", K + 1),
    );
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 24, failure_persistence: None, ..ProptestConfig::default() })]

    #[test]
    fn sell_through_bid(amount in 1_000_000_000_000u128..=10_000 * E18, fill_seed in any::<u128>()) {
        let fill = 1 + fill_seed % amount.min(K);
        let (mut w, ..) = thin_world();
        let s = w.s2x2;
        let id = ravi_bid(&mut w);
        let rest = amount - fill;
        let slice = if rest > 0 { quote_sell(&mut w, s, rest, DELAYED_HOLDS)[3] } else { 0 };
        let out = w
            .sell(ALICE, s, amount, DELAYED_HOLDS, &plan_in(4, 3, &[(id, fill)]), &[0; 4], false)
            .unwrap();
        prop_assert_eq!(out[3], proceeds(fill, RAVI_PRICE) + slice);
        prop_assert_eq!(w.bal(RAVI, s, Wnear, DELAYED_HOLDS), fill);
        let o = order(&mut w, id);
        prop_assert_eq!(o.remaining.0, K - fill);
        prop_assert_eq!(escrow_held(&mut w, s, Usdc, DELAYED_HOLDS), o.escrow.0);
    }
}

// Probes

#[test]
fn close_with_no_position_does_nothing() {
    let (mut w, ..) = full_world();
    let s = w.s2x2;
    assert_eq!(w.close_direct(ALICE, s).unwrap(), 0);
    assert_eq!(
        w.last.data_of("closed")[0],
        json!({"account_id": ALICE, "scenario_id": s, "repaid": "0", "pieces": 0})
    );
    assert!(w.last.calls().is_empty());
    fails(w.close_direct(ALICE, 99), "UnknownScenario(99)");
}

#[test]
fn plan_fill_of_zero_fails_in_the_book() {
    let (mut w, ..) = thin_world();
    let s = w.s2x2;
    let id = ravi_bid(&mut w);
    fails(
        w.sell(
            ALICE,
            s,
            E18,
            DELAYED_HOLDS,
            &plan_in(4, 3, &[(id, 0)]),
            &[0; 4],
            false,
        ),
        "ZeroAmount",
    );
}

#[test]
fn same_order_twice_in_a_plan() {
    let (mut w, ..) = thin_world();
    let s = w.s2x2;
    let id = ravi_bid(&mut w);
    let six = 6 * K / 10;
    let four = 4 * K / 10;
    fails(
        w.sell(
            ALICE,
            s,
            SALE,
            DELAYED_HOLDS,
            &plan_in(4, 3, &[(id, six), (id, six)]),
            &[0; 4],
            false,
        ),
        &format!("AmountExceedsRemaining({id}, {six}, {four})"),
    );
    let out = w
        .sell(
            ALICE,
            s,
            K,
            DELAYED_HOLDS,
            &plan_in(4, 3, &[(id, four), (id, six)]),
            &[0; 4],
            false,
        )
        .unwrap();
    assert_eq!(out[3], RAVI_ESCROW);
    assert_eq!(order(&mut w, id).remaining.0, 0);
}

#[test]
fn min_out_in_an_unsold_world_is_ignored() {
    let (mut w, ..) = full_world();
    let s = w.s2x2;
    let out = w
        .sell(
            ALICE,
            s,
            E18,
            DELAYED_HOLDS,
            &no_plans(4),
            &[u128::MAX, 0, 0, 0],
            false,
        )
        .unwrap();
    assert!(out[3] > 0);
}

#[test]
fn selling_the_last_possible_world() {
    let (mut w, ..) = full_world();
    let (s, spice, fed) = (w.s2x2, w.spice, w.fed);
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    w.admin_resolve(spice, OUT_DELAYED).unwrap();
    let out = w
        .sell(ALICE, s, E18, DELAYED_HOLDS, &no_plans(4), &[0; 4], false)
        .unwrap();
    assert!(out[3] > 0);
    assert_eq!(w.bal(ALICE, s, Usdc, DELAYED_HOLDS), out[3]);
}

#[test]
fn halted_trades_report_the_book_before_the_pool() {
    let (mut w, ..) = thin_world();
    let (s, spice) = (w.s2x2, w.spice);
    let id = ravi_bid(&mut w);
    w.report(spice, OUT_DELAYED).unwrap();
    let halted = format!("ScenarioHalted({s})");
    fails(
        w.sell(
            ALICE,
            s,
            SALE,
            L_SHAPE,
            &plan_in(4, 3, &[(id, E18)]),
            &[0; 4],
            false,
        ),
        &halted,
    );
    fails(
        w.sell(ALICE, s, SALE, L_SHAPE, &no_plans(4), &[0; 4], false),
        &halted,
    );
    // still halted after the window, until someone finalizes
    w.warp(DISPUTE_WINDOW + 1);
    fails(
        w.sell(ALICE, s, E18, DELAYED_HOLDS, &no_plans(4), &[0; 4], false),
        &halted,
    );
    // posting and cancelling work while halted
    let e = w.now + DAY;
    let id2 = w
        .post_from_real(RAVI, s, DELAYED_HOLDS, Side::Bid, RAVI_PRICE, E18, e)
        .unwrap();
    super::orders::cancel(&mut w, RAVI, id2).unwrap();
    w.finalize(BOB, spice).unwrap();
    w.sell(ALICE, s, E18, DELAYED_HOLDS, &no_plans(4), &[0; 4], false)
        .unwrap();
}

#[test]
fn post_order_on_a_half_dead_mask() {
    let (mut w, ..) = thin_world();
    let (s, fed) = (w.s2x2, w.fed);
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    let e = w.now + DAY;
    let id = w
        .post_from_real(ALICE, s, DELAYED, Side::Ask, 3_000 * E15, E18, e)
        .unwrap();
    assert_eq!(order(&mut w, id).epoch, 1);
    assert_eq!(w.bal(ALICE, s, Wnear, SHIPS_HOLDS), E18);
    assert_eq!(w.bal(ALICE, s, Wnear, SHIPS_CUTS), 0);
    assert_eq!(escrow_held(&mut w, s, Wnear, DELAYED), E18);
}

#[test]
fn sell_and_borrow_of_zero_fails_in_lending() {
    let (mut w, ..) = full_world();
    let s = w.s2x2;
    fails(
        w.sell_and_borrow(ALICE, s, SALE, L_SHAPE, &no_plans(4), &[0; 4], 0),
        "ZeroAmount",
    );
    assert_eq!(w.wallet(ALICE, Wnear), FUND);
}

#[test]
fn sell_and_borrow_too_much_is_unhealthy() {
    let (mut w, ..) = full_world();
    let s = w.s2x2;
    let err = w
        .sell_and_borrow(ALICE, s, SALE, L_SHAPE, &no_plans(4), &[0; 4], 4500 * E18)
        .unwrap_err();
    assert!(err.starts_with("Unhealthy("), "{err}");
    assert!(err.ends_with(", 3)"), "{err}");
    assert_eq!(w.wallet(ALICE, Wnear), FUND);
    assert_eq!(w.debt(s, ALICE), 0);
}

#[test]
fn multi_world_order_in_a_plan() {
    let (mut w, ..) = thin_world();
    let s = w.s2x2;
    let e = w.now + DAY;
    let id = w
        .post_from_real(RAVI, s, HOLDS, Side::Bid, 2_400 * E15, E18, e)
        .unwrap();
    fails(
        w.sell(
            ALICE,
            s,
            E18,
            DELAYED_HOLDS,
            &plan_in(4, 3, &[(id, E18)]),
            &[0; 4],
            false,
        ),
        &format!("PlanOrderMismatch(3, {id})"),
    );
}

#[test]
fn conditional_buy_to_lending_deposits_both_legs() {
    let (mut w, ..) = full_world();
    let s = w.s2x2;
    let got = w
        .buy(
            BOB,
            s,
            3000 * E18,
            DELAYED_HOLDS,
            &no_plans(4),
            &[0; 4],
            true,
        )
        .unwrap();
    let mut expected: Vec<(String, u128)> = [SHIPS_CUTS, DELAYED_CUTS, SHIPS_HOLDS]
        .iter()
        .map(|m| (piece(s, Usdc, *m), 3000 * E18))
        .collect();
    expected.push((piece(s, Wnear, DELAYED_HOLDS), got[3]));
    assert_eq!(w.pieces(s, BOB), expected);
    assert_eq!(w.bal(BOB, s, Wnear, DELAYED_HOLDS), 0);
}

#[test]
fn close_returns_real_collateral_and_uncollapsed_pieces() {
    let (mut w, ..) = full_world();
    let s = w.s2x2;
    w.post_real(ALICE, s, Wnear, K).unwrap();
    let out = w
        .sell(ALICE, s, SALE, L_SHAPE, &no_plans(4), &[0; 4], true)
        .unwrap();
    assert_eq!(w.wallet(ALICE, Wnear), FUND - SALE - K);
    assert_eq!(w.close_direct(ALICE, s).unwrap(), 0);
    let calls = w.last.calls();
    assert_eq!(calls[0].method, "ft_transfer");
    assert_eq!(calls[0].receiver_id.as_str(), WNEAR_TOKEN);
    assert_eq!(w.wallet(ALICE, Wnear), FUND - SALE);
    assert!(w.pieces(s, ALICE).is_empty());
    assert_eq!(w.bal(ALICE, s, Wnear, SHIPS_CUTS), SALE);
    for i in 1..4u8 {
        assert_eq!(w.bal(ALICE, s, Usdc, 1 << i), out[usize::from(i)]);
    }
}

#[test]
fn one_unit_pool_sale_pays_nothing() {
    let (mut w, ..) = full_world();
    let s = w.s2x2;
    let out = w
        .sell(ALICE, s, 1, DELAYED_HOLDS, &no_plans(4), &[0; 4], true)
        .unwrap();
    assert_eq!(out, [0, 0, 0, 0]);
    assert_eq!(w.bal(ALICE, s, Usdc, DELAYED_HOLDS), 0);
    // the zero leg is skipped, the kept worlds go into lending
    assert_eq!(w.pieces(s, ALICE).len(), 3);
}

// NEAR

#[test]
fn wrong_asset_is_refunded() {
    let (mut w, ..) = full_world();
    let s = w.s2x2;
    let p = plans_json(&no_plans(4));
    let sell = json!({"action": "conditional_sell", "scenario_id": s, "sell_mask": 8, "plans": p, "min_out": amounts_json(&[0; 4]), "to_lending": false});
    let buy = json!({"action": "conditional_buy", "scenario_id": s, "buy_mask": 8, "plans": p, "min_out": amounts_json(&[0; 4]), "to_lending": false});
    let sab = json!({"action": "sell_and_borrow", "scenario_id": s, "sell_mask": 8, "plans": p, "min_out": amounts_json(&[0; 4]), "borrow_amount": "1"});
    let close = json!({"action": "close_after_resolution", "scenario_id": s});
    fails(
        w.ft_transfer_call(ALICE, Usdc, 1_000_000, &sell.to_string()),
        "WrongAsset(usdc)",
    );
    fails(
        w.ft_transfer_call(ALICE, Usdc, 1_000_000, &sab.to_string()),
        "WrongAsset(usdc)",
    );
    fails(
        w.ft_transfer_call(ALICE, Wnear, E18, &buy.to_string()),
        "WrongAsset(wnear)",
    );
    fails(
        w.ft_transfer_call(ALICE, Wnear, E18, &close.to_string()),
        "WrongAsset(wnear)",
    );
    assert_eq!(
        (w.wallet(ALICE, Wnear), w.wallet(ALICE, Usdc)),
        (FUND, FUND)
    );
}

#[test]
fn close_needs_the_debt_attached_and_returns_the_rest() {
    let (mut w, ..) = full_world();
    let (s, fed) = (w.s2x2, w.fed);
    w.sell_and_borrow(ALICE, s, SALE, L_SHAPE, &no_plans(4), &[0; 4], BORROW)
        .unwrap();
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    w.warp(DAY);
    let debt = w.debt(s, ALICE);
    fails(
        w.close(ALICE, s, BORROW),
        &format!("InsufficientRepayment({BORROW}, {debt})"),
    );
    // the direct call draws on the internal balance, which is empty
    let err = w.close_direct(ALICE, s).unwrap_err();
    assert!(
        err.starts_with("InsufficientBalance(alice.near, 0, "),
        "{err}"
    );
    let wallet = w.wallet(ALICE, Usdc);
    let attached = units(Usdc, debt + 1000 * E18);
    let msg = json!({"action": "close_after_resolution", "scenario_id": s}).to_string();
    let unused = w.ft_transfer_call(ALICE, Usdc, attached, &msg).unwrap();
    w.conserved();
    // the unused part goes back with the transfer; nothing else was redeemable
    let used = attached - unused;
    assert_eq!(used, units(Usdc, debt));
    assert_eq!(w.wallet(ALICE, Usdc), wallet - used * USDC_UNIT);
    assert_eq!(w.debt(s, ALICE), 0);
    assert!(w.pieces(s, ALICE).is_empty());
}

#[test]
fn close_direct_repays_from_the_internal_balance() {
    let (mut w, ..) = full_world();
    let s = w.s2x2;
    w.sell_and_borrow(ALICE, s, SALE, L_SHAPE, &no_plans(4), &[0; 4], BORROW)
        .unwrap();
    w.deposit(ALICE, Usdc, BORROW).unwrap();
    assert_eq!(w.close_direct(ALICE, s).unwrap(), BORROW);
    assert_eq!(w.real(ALICE, Usdc), 0);
    assert_eq!(w.debt(s, ALICE), 0);
    assert_eq!(w.last.data_of("closed")[0]["pieces"], 4);
}

#[test]
fn direct_trades_draw_on_the_internal_balance_and_pay_storage() {
    let (mut w, ..) = full_world();
    let s = w.s2x2;
    w.deposit(ALICE, Wnear, SALE + K).unwrap();
    let call = |w: &mut World, deposit: NearToken| {
        w.call(ALICE, deposit, |c| {
            c.conditional_sell(
                s,
                U128(SALE),
                L_SHAPE,
                vec![vec![]; 4],
                vec![U128(0); 4],
                false,
            )
        })
    };
    fails(
        call(&mut w, NO_DEPOSIT),
        "Requires attached deposit of exactly 1 yoctoNEAR",
    );
    let used = w.storage_used(ALICE);
    let out = call(&mut w, ONE_YOCTO).unwrap();
    w.conserved();
    assert!(w.storage_used(ALICE) > used);
    assert_eq!(w.real(ALICE, Wnear), K);
    assert_eq!(w.bal(ALICE, s, Usdc, DELAYED_HOLDS), out[3].0);
    fails(
        call(&mut w, ONE_YOCTO),
        &format!("InsufficientBalance(alice.near, {K}, {SALE})"),
    );
    // buying with internal USDC
    w.deposit(ALICE, Usdc, 1000 * E18).unwrap();
    let got = w
        .call(ALICE, ONE_YOCTO, |c| {
            c.conditional_buy(
                s,
                U128(1000 * E18),
                SHIPS_CUTS,
                vec![vec![]; 4],
                vec![U128(0); 4],
                false,
            )
        })
        .unwrap();
    w.conserved();
    assert_eq!(w.bal(ALICE, s, Wnear, SHIPS_CUTS), SALE + got[0].0);
    assert_eq!(w.real(ALICE, Usdc), 0);
}

#[test]
fn trade_events_are_compact() {
    let (mut w, ..) = full_world();
    let s = w.s2x2;
    let out = w
        .sell(ALICE, s, SALE, L_SHAPE, &no_plans(4), &[0; 4], true)
        .unwrap();
    assert_eq!(
        w.last.data_of("conditional_sale")[0],
        json!({
            "account_id": ALICE, "scenario_id": s, "sell_mask": L_SHAPE,
            "amount": (SALE).to_string(), "proceeds": amounts_json(&out), "to_lending": true,
        })
    );
    let got = w
        .buy(BOB, s, 1000 * E18, SHIPS_CUTS, &no_plans(4), &[0; 4], false)
        .unwrap();
    assert_eq!(
        w.last.data_of("conditional_buy")[0],
        json!({
            "account_id": BOB, "scenario_id": s, "buy_mask": SHIPS_CUTS,
            "amount": (1000 * E18).to_string(), "bought": amounts_json(&got), "to_lending": false,
        })
    );
}

/// The heaviest trade the app can build: every world sold, five bids per
/// world each closed with rounding dust for its maker, the rest through
/// the pools, everything into lending and a loan on top. A receipt may log
/// at most 100 lines and 16 KiB.
#[test]
fn worst_case_trade_fits_the_log_limits() {
    let (mut w, ..) = full_world();
    let s = w.s2x2;
    // an odd price, so a partial fill leaves rounding dust in the escrow
    let price = 2_000 * E15 - 1;
    let e = w.now + DAY;
    let makers = [RAVI, CAROL, BOB, OWNER, RAVI];
    let mut plans = no_plans(4);
    for wi in 0..4u8 {
        for maker in makers {
            let id = w
                .post_from_real(maker, s, 1 << wi, Side::Bid, price, K, e)
                .unwrap();
            plans[usize::from(wi)].push((id, K - 1));
        }
    }
    // Carol takes 1 unit of each bid first
    w.split_ft(CAROL, s, Wnear, &SINGLES, K).unwrap();
    for fills in &plans {
        for &(id, _) in fills {
            super::orders::fill(&mut w, CAROL, id, 1, 0).unwrap();
        }
    }
    let out = w
        .sell_and_borrow(ALICE, s, 6 * K, ROOT, &plans, &[0; 4], 1000 * E18)
        .unwrap();
    for wi in 0..4usize {
        for &(id, _) in &plans[wi] {
            assert_eq!(order(&mut w, id).remaining.0, 0);
        }
        assert!(out[wi] > 5 * proceeds(K - 1, price));
    }
    let logs = &w.last.logs;
    assert_eq!(w.last.data_of("order_filled").len(), 20);
    // every fill's tokens are in the one batched transfer line
    let transfers = w.last.data_of("mt_transfer");
    assert_eq!(transfers.len(), 1);
    let batched = &w
        .last
        .events()
        .into_iter()
        .find(|e| e["event"] == "mt_transfer")
        .unwrap()["data"];
    assert!(batched.as_array().unwrap().len() >= 10);
    assert!(logs.len() <= 100, "{} log lines", logs.len());
    // with testnet's longer account ids
    let testnet: usize = logs
        .iter()
        .map(|l| {
            l.replace(CONTRACT, "app.multiverse-lending.testnet")
                .replace(".near\"", ".multiverse-lending.testnet\"")
                .len()
        })
        .sum();
    assert!(testnet <= 16 * 1024, "{testnet} log bytes on testnet");
}

#[test]
fn a_failed_trade_leaves_no_batch_open() {
    let (mut w, ..) = full_world();
    let s = w.s2x2;
    fails(
        w.sell(
            ALICE,
            s,
            E18,
            L_SHAPE,
            &no_plans(4),
            &[0, 0, 0, u128::MAX],
            false,
        ),
        &format!(
            "InsufficientOutput(3, {}, {})",
            quote_sell(&mut w, s, E18, L_SHAPE)[3],
            u128::MAX
        ),
    );
    // a plain move afterwards logs its own line again
    let to = acc(BOB);
    let id = token_id(s, Wnear, SHIPS_CUTS);
    w.sell(ALICE, s, E18, L_SHAPE, &no_plans(4), &[0; 4], false)
        .unwrap();
    w.call(ALICE, ONE_YOCTO, |c| {
        c.mt_transfer(to, id, U128(1), None, None)
    })
    .unwrap();
    assert_eq!(w.last.data_of("mt_transfer").len(), 1);
    assert_eq!(w.last.logs.len(), 1);
}

// The demo sale on real pools

/// The demo seed then the demo sale: every world pool (DELAYED·HOLDS the thin one),
/// the between-world pools at 66.67% SHIPS / 1.04% CUTS, the spot pool at
/// the implied spot, Bob's supply, Ravi's bid; a full TWAP window later
/// Alice sells 2,000 NEAR in the L-shape through Ravi's bid and borrows
/// 3,000 USDC, then sells 2,000 NEAR-if-DELAYED in the binary market and
/// borrows 3,000 more.
#[test]
fn golden_demo_sale() {
    clear_prices();
    let mut w = pool_world();
    w.register(RAVI, NearToken::from_near(1));
    w.fund(RAVI);
    let (s, sb) = (w.s2x2, w.s_bin);
    let p2 = seed_demo_thin(&mut w);
    let pb = seed_worlds(&mut w, sb, &DEMO_BIN, &[DEPTH; 2]);
    seed_odds(&mut w, s, &independent_odds(4, 6667, 104), ODDS_DEPTH);
    seed_odds(&mut w, sb, &independent_odds(2, 6667, 0), ODDS_DEPTH);
    let implied = w.view(|c| c.implied_spot(s)).0;
    // 3.03786 USDC per NEAR
    assert_eq!(price_5dp(implied), 303786);
    // whole micro-USDC for the 100,000 wNEAR deep spot pool
    seed_spot(&mut w, implied / 10_000_000 * 10_000_000, DEPTH);
    w.conserved();
    w.lend(BOB, s, SUPPLIED).unwrap();
    w.lend(BOB, sb, SUPPLIED).unwrap();
    let ravi = ravi_bid(&mut w);
    w.warp(61);

    // the app's rule: use the bid only if it beats the pool for the slice
    let pool_only = quote_sell(&mut w, s, SALE, DELAYED_HOLDS)[3];
    let with_bid =
        proceeds(RAVI_SIZE, RAVI_PRICE) + quote_sell(&mut w, s, SALE - RAVI_SIZE, DELAYED_HOLDS)[3];
    assert!(with_bid > pool_only);
    assert_eq!((cents(with_bid), cents(pool_only)), (488188, 474829));

    let out = w
        .sell_and_borrow(
            ALICE,
            s,
            SALE,
            L_SHAPE,
            &plan_in(4, 3, &[(ravi, RAVI_SIZE)]),
            &[0; 4],
            BORROW,
        )
        .unwrap();
    assert_eq!(
        out.iter().map(|x| cents(*x)).collect::<Vec<_>>(),
        [0, 586505, 645155, 488188]
    );
    for (got, proto) in out.iter().zip(PROTO_PROCEEDS) {
        assert!(got.abs_diff(proto) <= 1_000_000, "{got} vs {proto}");
    }
    assert_eq!(w.wallet(ALICE, Usdc), FUND + BORROW);
    assert_eq!(w.debt(s, ALICE), BORROW);
    // the TWAP still sits on the seeded tick: the sale's has no weight yet
    let twap: Vec<u128> = (0..4)
        .map(|i| price_5dp(w.view(|c| c.world_price(s, i)).0))
        .collect();
    assert_eq!(twap, [369963, 299979, 329972, 249990]);
    let values: Vec<u128> = w.values(s, ALICE).into_iter().map(cents).collect();
    // 2,000 NEAR at world 0's TWAP is 7,399.27: the mean tick at 3.70 floors
    // a hair higher than at the prototype's 3,700 (its demo numbers: 7,399.26)
    assert_eq!(values, [739927, 586505, 645155, 488188]);
    let (hf, worst) = w.hf(s, ALICE);
    let hf = hf.unwrap();
    assert_eq!((worst, hf / 10_000_000_000_000_000), (3, 122));
    assert!(hf.abs_diff(PROTO_HF) <= 1_000, "{hf}");
    let lowest = w.lowest(s, ALICE);
    assert_eq!(
        cents(multiverse_math::mul_div_down(lowest, LLTV, E18)),
        366141
    );
    assert_eq!(order(&mut w, ravi).remaining.0, 0);

    let bin = w
        .sell_and_borrow(ALICE, sb, SALE, BIN_DELAYED, &no_plans(2), &[0; 2], BORROW)
        .unwrap();
    assert_eq!(cents(bin[1]), 547404);
    assert!(bin[1].abs_diff(PROTO_BIN_PROCEEDS) <= 1_000_000);
    let values: Vec<u128> = w.values(sb, ALICE).into_iter().map(cents).collect();
    // 6,799.75 for SHIPS, a cent over the prototype's 6,799.74 for the same reason
    assert_eq!(values, [679975, 547404]);
    let (hf, worst) = w.hf(sb, ALICE);
    assert_eq!((worst, hf.unwrap() / 10_000_000_000_000_000), (1, 136));
    let lowest = w.lowest(sb, ALICE);
    assert_eq!(
        cents(multiverse_math::mul_div_down(lowest, LLTV, E18)),
        410553
    );
    assert_eq!(w.wallet(ALICE, Usdc), FUND + 2 * BORROW);

    // the pools after the sale, and the fee each one charges next
    let after: Vec<u128> = p2
        .iter()
        .map(|id| price_5dp(price_of(&mut w, *id)))
        .collect();
    assert_eq!(after, [370000, 288384, 317223, 237988]);
    assert_eq!(price_5dp(price_of(&mut w, pb[1])), 269158);
    let fees: Vec<u32> = p2.iter().map(|id| fee_of(&mut w, *id)).collect();
    assert_eq!(fees, [3000, 15000, 15000, 15000]);
    assert_eq!(fee_of(&mut w, pb[1]), 15000);
    w.conserved();
}

/// Every verse key Alice could touch is accounted for: a sanity check that
/// the conservation helper sees the router's flows at all.
#[test]
fn conservation_counts_collateral_and_escrow() {
    let (mut w, ..) = thin_world();
    let s = w.s2x2;
    let id = ravi_bid(&mut w);
    w.sell_and_borrow(
        ALICE,
        s,
        SALE,
        L_SHAPE,
        &plan_in(4, 3, &[(id, RAVI_SIZE)]),
        &[0; 4],
        BORROW,
    )
    .unwrap();
    let key = VerseKey::new(s, Usdc, DELAYED_HOLDS);
    let in_lending = w.view(|c| c.collateral_holdings(&key));
    assert!(in_lending > RAVI_ESCROW);
    w.conserved();
}
