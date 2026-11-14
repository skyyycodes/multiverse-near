//! Liquidate and cash out (F3): every kind of seized piece turned into
//! real USDC in the liquidation's receipt, on real pools, with the quote
//! equal to execution, the `min_out` and unpricing guards, one payout, the
//! refund of the unused budget, backing (V-1) and the USDC books (L-2)
//! after every cash-out.
//!
//! Liquidation prices come from the test table (so a crash is a table
//! change); the sales go through the real world pools, whose state the
//! guard reads.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::NearToken;

use super::amm::{seed_worlds, DEMO_2X2, DEMO_BIN, DEPTH};
use super::harness::*;
use super::lending::*;
use super::tiers::*;
use crate::lending::cash_out::LiquidationQuote;
use crate::lending::tiers::{MarketId, Tier};
use crate::lending::{CollateralKey, MaxKeyword, RepayAmount};
use crate::ops::PauseFlag;
use crate::prices::MarketPriceCfg;
use crate::receiver::Receive;
use crate::types::Asset::{self, Usdc, Wnear};
use crate::types::WAD;

const LIQ: &str = CAROL;
const EVERYONE: [&str; 5] = [OWNER, ALICE, BOB, CAROL, DAVE];

/// Real pools on both demo scenarios under the production defaults, Bob
/// lending 100,000 in the 2x2's Normal market, a full TWAP window of history
/// (the production `min_age_sec`, so every world pool is trusted), and the
/// test table at the pools' prices.
fn cash_world() -> World {
    clear_prices();
    let mut w = World::new_v2();
    w.fund(OWNER);
    w.fund(CAROL);
    w.register(DAVE, NearToken::from_near(5));
    w.fund(DAVE);
    let (s, b) = (w.s2x2, w.s_bin);
    seed_worlds(&mut w, s, &DEMO_2X2, &[DEPTH; 4]);
    seed_worlds(&mut w, b, &DEMO_BIN, &[DEPTH; 2]);
    w.lend_in(Tier::Normal, BOB, s, 100_000 * E18).unwrap();
    w.warp(1_801);
    price_2x2(s);
    price_bin(b);
    w
}

/// Every world's table price times `bps / 10_000`.
fn crash(sid: u64, prices: &[u128], bps: u128) {
    for (world, p) in prices.iter().enumerate() {
        set_price(sid, world as u8, p * bps / 10_000);
    }
}

/// Splits `amount` of `asset` from `who`'s wallet into `[mask, the rest]`
/// and posts the `mask` piece in the Normal market.
fn post_piece(w: &mut World, who: &str, sid: u64, asset: Asset, mask: u8, amount: u128) {
    let root = w.view(|c| c.get_scenario(sid).root);
    w.split_ft(who, sid, asset, &[mask, root ^ mask], amount)
        .unwrap();
    w.post(who, sid, &token_id(sid, asset, mask), amount)
        .unwrap();
}

fn liquidate_msg(sid: u64, account: &str, repay: Option<u128>, min_out: Option<u128>) -> String {
    let mut msg = json!({"action": "liquidate", "scenario_id": sid, "account_id": account,
                         "repay_amount": repay.map_or("max".to_string(), |r| r.to_string())});
    if let Some(m) = min_out {
        msg["receive"] = json!("cash");
        msg["min_out"] = json!(m.to_string());
    }
    msg.to_string()
}

fn quote(w: &mut World, sid: u64, account: &str, receive: Receive) -> LiquidationQuote {
    let account = acc(account);
    w.view(|c| {
        c.liquidation_quote(
            sid,
            account,
            None,
            Some(RepayAmount::Max(MaxKeyword::Max)),
            Some(receive),
        )
    })
}

fn u(v: &Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

fn us(v: &Value) -> Vec<u128> {
    v.as_array().unwrap().iter().map(u).collect()
}

/// USDC held by the contract equals its books: reserves, internal
/// balances, real collateral and every market's cash (L-2).
fn assert_usdc_books(w: &mut World) {
    let held = w.held_by_contract(Usdc);
    let mut accounts: Vec<_> = EVERYONE.iter().map(|a| acc(a)).collect();
    accounts.push(acc(CONTRACT));
    let books = w.view(|c| {
        let mut total = 0u128;
        for sid in 1..=c.scenario_count {
            total += c.reserve(sid, Usdc);
            for tier in Tier::ALL {
                let id = MarketId::new(sid, Some(tier));
                let m = c.market_of(id);
                let st = c.tier_state(id);
                total += m.total_supply_assets + st.insurance - m.total_borrow_assets;
                for a in &accounts {
                    for (k, amount) in c.pieces(id, a) {
                        if k == CollateralKey::Real(Usdc) {
                            total += amount;
                        }
                    }
                }
            }
        }
        total
            + accounts
                .iter()
                .map(|a| c.real_balance(a, Usdc))
                .sum::<u128>()
    });
    assert_eq!(held, books, "USDC books");
}

/// Every possible world of every scenario backed (V-1).
fn assert_backed(w: &mut World) {
    let n = w.view(|c| c.scenario_count);
    for sid in 1..=n {
        for b in w.view(|c| c.backing(sid)).worlds {
            assert!(b.wnear_backed && b.usdc_backed, "{sid}: {b:?}");
        }
    }
}

/// Liquidates `account` in cash mode with `budget` and `min_out`; checks the
/// result against the quote taken just before, the single payout, the
/// refund and the books. Returns the `cash_out` line.
fn cash_out(w: &mut World, sid: u64, account: &str, budget: u128, slack: u128) -> Value {
    let q = quote(w, sid, account, Receive::Cash);
    assert_eq!(q.error, None, "{q:?}");
    let cash = q.cash.clone().unwrap();
    let min_out = cash.cash.0 - slack;
    let total = w.usdc_total(LIQ);
    let msg = liquidate_msg(sid, account, None, Some(min_out));
    let unused = w
        .ft_transfer_call(LIQ, Usdc, usdc_units(budget), &msg)
        .unwrap();
    let out = w.last.data_of("cash_out")[0].clone();
    let liq = &w.last.data_of("liquidate")[0];
    // The quote equals execution.
    assert_eq!(u(&liq["repaid"]), q.repay.0);
    assert_eq!(liq["seize_all"], q.seize_all);
    assert_eq!(u(&liq["written_off"]), q.written_off.0);
    assert_eq!(
        us(&liq["seized"]),
        q.pieces.iter().map(|p| p.seized.0).collect::<Vec<_>>()
    );
    assert_eq!(liq["receive"], "cash");
    assert_eq!(
        us(&out["sold"]),
        cash.sold.iter().map(|x| x.0).collect::<Vec<_>>()
    );
    assert_eq!(
        us(&out["received"]),
        cash.received.iter().map(|x| x.0).collect::<Vec<_>>()
    );
    assert_eq!(
        us(&out["left_usdc"]),
        cash.left_usdc.iter().map(|x| x.0).collect::<Vec<_>>()
    );
    assert_eq!(u(&out["merged"]), cash.merged.0);
    assert_eq!(u(&out["real_usdc"]), cash.real_usdc.0);
    assert_eq!(u(&out["redeemed"]), cash.redeemed.0);
    assert_eq!(u(&out["cash"]), cash.cash.0);
    assert_eq!(u(&out["min_out"]), min_out);
    assert_eq!(out["dead"], json!(cash.dead));
    assert_eq!(
        cash.cash.0,
        cash.real_usdc.0 + cash.redeemed.0 + cash.merged.0
    );
    // Exactly one payout, of the cash, to the liquidator.
    let transfers: Vec<_> = w
        .last
        .calls()
        .into_iter()
        .filter(|c| c.method == "ft_transfer")
        .collect();
    assert_eq!(transfers.len(), 1);
    assert_eq!(transfers[0].receiver_id, acc(USDC_TOKEN));
    assert_eq!(transfers[0].args["receiver_id"], LIQ);
    assert_eq!(u(&transfers[0].args["amount"]), cash.cash.0 / USDC_UNIT);
    // The unused budget comes back (the payout's sub-micro dust may round
    // one more micro-USDC into it); the liquidator ends with the cash less
    // the repayment.
    let repaid = q.repay.0;
    let back = (usdc_units(budget) * USDC_UNIT - repaid) / USDC_UNIT;
    assert!(unused == back || unused == back + 1, "{unused} vs {back}");
    assert_eq!(w.usdc_total(LIQ), total - repaid + cash.cash.0);
    // What was not merged stays with the liquidator as USDC-if-w.
    let possible = w.possible(sid);
    for (world, left) in cash.left_usdc.iter().enumerate() {
        if possible & (1 << world) != 0 && left.0 > 0 {
            assert!(w.bal(LIQ, sid, Usdc, 1 << world) >= left.0);
        }
    }
    assert_backed(w);
    assert_usdc_books(w);
    w.assert_conservation(&EVERYONE);
    out
}

#[test]
fn real_wnear_is_split_into_every_world_and_sold() {
    let mut w = cash_world();
    let s = w.s2x2;
    w.post_real(ALICE, s, Wnear, 1_000 * E18).unwrap();
    w.borrow_in(Tier::Normal, ALICE, s, 1_400 * E18).unwrap();
    crash(s, &PRICES_2X2, 7_000);
    let q = quote(&mut w, s, ALICE, Receive::Cash);
    assert_eq!(q.repay.0, 1_400 * E18);
    assert!(!q.seize_all);
    let out = cash_out(&mut w, s, ALICE, 1_500 * E18, 0);
    let sold = us(&out["sold"]);
    let seized = q.pieces[0].seized.0;
    assert_eq!(sold, vec![seized; 4]);
    // Pool prices (3.70 / 3.00 / 3.30 / 2.50) are above the crashed table:
    // the liquidator is paid more than it repaid.
    let cash = u(&out["cash"]);
    assert!(cash > 1_400 * E18);
    let received = us(&out["received"]);
    assert_eq!(u(&out["merged"]), *received.iter().min().unwrap());
    assert_eq!(out["dead"], json!([]));
    assert_eq!(w.debt_in(Tier::Normal, s, ALICE), 0);
}

#[test]
fn every_kind_of_piece_is_converted() {
    let mut w = cash_world();
    let s = w.s2x2;
    post_piece(&mut w, ALICE, s, Wnear, SHIPS_CUTS, 100 * E18);
    post_piece(&mut w, ALICE, s, Wnear, SHIPS, 1_000 * E18);
    post_piece(&mut w, ALICE, s, Usdc, DELAYED_HOLDS, 500 * E18);
    post_piece(&mut w, ALICE, s, Usdc, HOLDS, 300 * E18);
    w.post_real(ALICE, s, Usdc, 200 * E18).unwrap();
    let fed = w.fed;
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    // Worlds 2 (SHIPS·HOLDS) and 3 (DELAYED·HOLDS) are left: 3,800 / 1,000.
    w.borrow_in(Tier::Normal, ALICE, s, 600 * E18).unwrap();
    set_price(s, 2, WAD / 4);
    let q = quote(&mut w, s, ALICE, Receive::Cash);
    assert_eq!(q.error, None);
    let out = cash_out(&mut w, s, ALICE, 700 * E18, 0);
    let seized: Vec<u128> = q.pieces.iter().map(|p| p.seized.0).collect();
    // The dead SHIPS·CUTS wNEAR stays a token.
    assert_eq!(out["dead"], json!([token_id(s, Wnear, SHIPS_CUTS)]));
    assert_eq!(w.bal(LIQ, s, Wnear, SHIPS_CUTS), seized[0]);
    // SHIPS wNEAR became wNEAR-if-2 and was sold in world 2's pool.
    assert_eq!(us(&out["sold"]), vec![0, 0, seized[1], 0]);
    // USDC-if-HOLDS is collapsed: redeemed. Real USDC is cash as it is.
    assert_eq!(u(&out["redeemed"]), seized[3]);
    assert_eq!(u(&out["real_usdc"]), seized[4]);
    // World 3 holds the seized USDC-if-3; world 2 the sale. The smaller merges.
    let received = us(&out["received"]);
    let merged = u(&out["merged"]);
    assert_eq!(merged, received[2].min(seized[2]));
    assert_eq!(
        us(&out["left_usdc"]),
        vec![0, 0, received[2] - merged, seized[2] - merged]
    );
    assert_eq!(w.bal(LIQ, s, Wnear, SHIPS), 0);
}

#[test]
fn collapsed_wnear_is_split_into_its_live_worlds() {
    let mut w = cash_world();
    let s = w.s2x2;
    post_piece(&mut w, ALICE, s, Wnear, HOLDS, 1_000 * E18);
    let fed = w.fed;
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    w.borrow_in(Tier::Normal, ALICE, s, 1_400 * E18).unwrap();
    crash(s, &PRICES_2X2, 7_000);
    let q = quote(&mut w, s, ALICE, Receive::Cash);
    let out = cash_out(&mut w, s, ALICE, 1_500 * E18, 0);
    let seized = q.pieces[0].seized.0;
    assert_eq!(us(&out["sold"]), vec![0, 0, seized, seized]);
    assert_eq!(w.bal(LIQ, s, Wnear, HOLDS), 0);
}

#[test]
fn a_fully_resolved_scenario_redeems_and_sells_its_one_world() {
    let mut w = cash_world();
    let s = w.s2x2;
    post_piece(&mut w, ALICE, s, Usdc, DELAYED_HOLDS, 400 * E18);
    post_piece(&mut w, ALICE, s, Wnear, DELAYED_HOLDS, 500 * E18);
    w.post_real(ALICE, s, Wnear, 300 * E18).unwrap();
    let (fed, spice) = (w.fed, w.spice);
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    w.admin_resolve(spice, OUT_DELAYED).unwrap();
    assert_eq!(w.possible(s), DELAYED_HOLDS);
    // 400 + 800 wNEAR at 2.50 = 2,400.
    w.borrow_in(Tier::Normal, ALICE, s, 1_400 * E18).unwrap();
    crash(s, &PRICES_2X2, 6_000);
    let q = quote(&mut w, s, ALICE, Receive::Cash);
    let out = cash_out(&mut w, s, ALICE, 1_500 * E18, 0);
    let seized: Vec<u128> = q.pieces.iter().map(|p| p.seized.0).collect();
    assert_eq!(u(&out["redeemed"]), seized[0]);
    assert_eq!(us(&out["sold"]), vec![0, 0, 0, seized[1] + seized[2]]);
    let received = us(&out["received"]);
    assert_eq!(u(&out["merged"]), received[3]);
    assert_eq!(us(&out["left_usdc"]), vec![0, 0, 0, 0]);
}

#[test]
fn below_min_out_nothing_happens() {
    let mut w = cash_world();
    let s = w.s2x2;
    w.post_real(ALICE, s, Wnear, 1_000 * E18).unwrap();
    w.borrow_in(Tier::Normal, ALICE, s, 1_400 * E18).unwrap();
    crash(s, &PRICES_2X2, 7_000);
    let cash = quote(&mut w, s, ALICE, Receive::Cash).cash.unwrap().cash.0;
    let wallet = w.wallet_raw(LIQ, Usdc);
    let debt = w.debt_in(Tier::Normal, s, ALICE);
    let msg = liquidate_msg(s, ALICE, None, Some(cash + 1));
    fails(
        w.ft_transfer_call(LIQ, Usdc, usdc_units(1_500 * E18), &msg),
        &format!("CashOutBelowMin({cash}, {})", cash + 1),
    );
    assert_eq!(w.wallet_raw(LIQ, Usdc), wallet);
    assert_eq!(w.debt_in(Tier::Normal, s, ALICE), debt);
    // The message's own checks.
    let tokens_with_min = json!({"action": "liquidate", "scenario_id": s, "account_id": ALICE,
                                 "repay_amount": "max", "min_out": "1"})
    .to_string();
    fails(
        w.ft_transfer_call(LIQ, Usdc, 1_000_000, &tokens_with_min),
        "MinOutWithoutCash",
    );
    let cash_without_min = json!({"action": "liquidate", "scenario_id": s, "account_id": ALICE,
                                  "repay_amount": "max", "receive": "cash"})
    .to_string();
    fails(
        w.ft_transfer_call(LIQ, Usdc, 1_000_000, &cash_without_min),
        "MinOutRequired",
    );
}

#[test]
fn a_paused_trade_flag_stops_cash_but_not_tokens() {
    let mut w = cash_world();
    let s = w.s2x2;
    w.post_real(ALICE, s, Wnear, 1_000 * E18).unwrap();
    w.borrow_in(Tier::Normal, ALICE, s, 1_400 * E18).unwrap();
    crash(s, &PRICES_2X2, 7_000);
    w.call(OWNER, NO_DEPOSIT, |c| {
        c.pause.flags = PauseFlag::Trade.bit()
    })
    .unwrap();
    assert_eq!(
        quote(&mut w, s, ALICE, Receive::Cash).error,
        Some("Paused(trade)".to_string())
    );
    fails(
        w.ft_transfer_call(
            LIQ,
            Usdc,
            usdc_units(1_500 * E18),
            &liquidate_msg(s, ALICE, None, Some(1)),
        ),
        "Paused(trade)",
    );
    let q = quote(&mut w, s, ALICE, Receive::Tokens);
    assert_eq!(q.error, None);
    assert!(q.cash.is_none());
    w.ft_transfer_call(
        LIQ,
        Usdc,
        usdc_units(1_500 * E18),
        &liquidate_msg(s, ALICE, None, None),
    )
    .unwrap();
    // Tokens mode is v1's: the real wNEAR lands in the internal balance.
    let liq = &w.last.data_of("liquidate")[0];
    assert_eq!(liq["receive"], "tokens");
    assert_eq!(u(&liq["repaid"]), q.repay.0);
    assert_eq!(w.real(LIQ, Wnear), q.pieces[0].seized.0);
    assert!(w.last.data_of("cash_out").is_empty());
}

#[test]
fn a_sale_may_not_leave_a_world_unpriced() {
    let mut w = cash_world();
    // A fresh binary market: world 0's pool is 4,000 wNEAR deep, world 1's
    // 100,000; both a minute old, so a 10% move is out of band.
    let ev = w
        .create_event(SPICE_QUESTION, &["A", "B"], SPICE_RULE, T0 + 90 * DAY)
        .unwrap();
    let sid = w.create_scenario(&[ev]).unwrap();
    w.call(OWNER, NO_DEPOSIT, |c| {
        let v1 = MarketPriceCfg::v1(&c.params);
        c.prices.configs.insert(sid, v1);
    })
    .unwrap();
    seed_worlds(
        &mut w,
        sid,
        &[3 * WAD, 3 * WAD],
        &[4_000 * E18, 100_000 * E18],
    );
    w.lend_in(Tier::Normal, BOB, sid, 10_000 * E18).unwrap();
    w.warp(61);
    set_price(sid, 0, 3 * WAD);
    set_price(sid, 1, 3 * WAD);
    w.post_real(ALICE, sid, Wnear, 1_000 * E18).unwrap();
    w.borrow_in(Tier::Normal, ALICE, sid, 1_700 * E18).unwrap();
    crash(sid, &[3 * WAD, 3 * WAD], 7_000);
    let q = quote(&mut w, sid, ALICE, Receive::Cash);
    assert_eq!(q.error, Some("CashOutUnpricesWorld(0)".to_string()));
    assert!(!q.cash.as_ref().unwrap().guard_ok);
    let msg = liquidate_msg(sid, ALICE, None, Some(1));
    fails(
        w.ft_transfer_call(LIQ, Usdc, usdc_units(2_000 * E18), &msg),
        "CashOutUnpricesWorld(0)",
    );
    // Tokens mode is always there.
    w.ft_transfer_call(
        LIQ,
        Usdc,
        usdc_units(2_000 * E18),
        &liquidate_msg(sid, ALICE, None, None),
    )
    .unwrap();
}

#[test]
fn the_quote_equals_execution_in_tokens_mode_too() {
    let mut w = cash_world();
    let s = w.s2x2;
    post_piece(&mut w, ALICE, s, Wnear, SHIPS, 1_000 * E18);
    post_piece(&mut w, ALICE, s, Usdc, DELAYED, 1_500 * E18);
    w.post_real(ALICE, s, Usdc, 300 * E18).unwrap();
    w.borrow_in(Tier::Normal, ALICE, s, 1_000 * E18).unwrap();
    crash(s, &PRICES_2X2, 1_000);
    let q = quote(&mut w, s, ALICE, Receive::Tokens);
    assert!(q.seize_all && q.written_off.0 > 0);
    assert_eq!(
        q.liquidation,
        crate::lending::LiquidationState::Liquidatable
    );
    w.ft_transfer_call(
        LIQ,
        Usdc,
        usdc_units(2_000 * E18),
        &liquidate_msg(s, ALICE, None, None),
    )
    .unwrap();
    let liq = &w.last.data_of("liquidate")[0];
    assert_eq!(u(&liq["repaid"]), q.repay.0);
    assert_eq!(
        us(&liq["seized"]),
        q.pieces.iter().map(|p| p.seized.0).collect::<Vec<_>>()
    );
    assert_eq!(u(&liq["written_off"]), q.written_off.0);
    // Errors go to `error` instead of panicking.
    let q = quote(&mut w, s, ALICE, Receive::Tokens);
    assert!(q.error.unwrap().starts_with("NotLiquidatable("));
    let unknown = w.view(|c| c.liquidation_quote(999, acc(ALICE), None, None, None));
    assert_eq!(unknown.error, Some("UnknownScenario(999)".to_string()));
    let zero = w.view(|c| {
        c.liquidation_quote(
            s,
            acc(ALICE),
            None,
            Some(RepayAmount::Amount(U128(0))),
            None,
        )
    });
    assert_eq!(zero.error, Some("ZeroAmount".to_string()));
}
