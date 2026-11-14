//! The v2 scaffold: pause flags on the v1 entry points, the v2 transfer msg
//! fields and actions, the price interface's v1 behaviour, lending tier keys
//! and defaults, the app config's v2 keys, the catalogue stubs and
//! scenarios of three events.

use near_sdk::json_types::{U128, U64};
use near_sdk::NearToken;

use super::amm::{pool_world, seed_demo_2x2};
use super::harness::*;
use super::lending::*;
use crate::amm::test_hooks::{self, TestQuote};
use crate::lending::tiers::{LendingParams, MarketId, Tier, TierState, TIER_SHIFT};
use crate::ops::PauseFlag;
use crate::prices::{MarketPriceCfg, PriceMode, WorldStatus};
use crate::receiver::{parse_msg, Action, Receive};
use crate::types::Asset::{Usdc, Wnear};
use crate::types::WAD;

fn pause(w: &mut World, flags: &[PauseFlag]) {
    let bits = PauseFlag::bits_of(flags);
    w.call(OWNER, NO_DEPOSIT, |c| c.pause.flags = bits).unwrap();
}

fn paused(flag: PauseFlag) -> String {
    format!("Paused({})", flag.name())
}

// ---- Pause flags ----

#[test]
fn trade_stops_swaps_orders_and_trades_first() {
    let mut w = World::new();
    pause(&mut w, &[PauseFlag::Trade]);
    let err = paused(PauseFlag::Trade);
    // Every call names things that do not exist: the flag is checked first.
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.swap(999, true, U128(1), U128(0))),
        &err,
    );
    fails(
        w.call(ALICE, ONE_YOCTO, |c| {
            c.fill_order(U64(999), U128(1), U128(0))
        }),
        &err,
    );
    fails(
        w.call(ALICE, ONE_YOCTO, |c| {
            c.post_order(999, 1, crate::orders::Side::Bid, U128(1), U128(1), 0)
        }),
        &err,
    );
    fails(
        w.call(ALICE, ONE_YOCTO, |c| {
            c.conditional_sell(999, U128(0), 1, vec![], vec![], false, None)
        }),
        &err,
    );
    fails(
        w.call(ALICE, ONE_YOCTO, |c| {
            c.conditional_buy(999, U128(0), 1, vec![], vec![], true, None)
        }),
        &err,
    );
    fails(w.call(OWNER, ONE_YOCTO, |c| c.move_spot_to(U128(1))), &err);
}

#[test]
fn mint_stops_splits_creation_and_liquidity() {
    let mut w = World::new();
    pause(&mut w, &[PauseFlag::Mint]);
    let err = paused(PauseFlag::Mint);
    fails(w.split(ALICE, 999, Wnear, 15, &[1, 14], 1), &err);
    fails(
        w.call(ALICE, NO_DEPOSIT, |c| c.register_verse(999, Wnear, 1)),
        &err,
    );
    fails(w.create_event("Q?", &["A", "B"], "R.", 0), &err);
    fails(w.create_scenario(&[]), &err);
    fails(
        w.call(OWNER, ONE_YOCTO, |c| {
            c.create_within_pool(999, 0, U128(1), U128(1))
        }),
        &err,
    );
    fails(
        w.call(OWNER, ONE_YOCTO, |c| {
            c.create_between_pool(999, 1, 2, U128(1), U128(1))
        }),
        &err,
    );
    fails(
        w.call(OWNER, ONE_YOCTO, |c| c.create_spot_pool(U128(1), U128(1))),
        &err,
    );
    fails(
        w.call(ALICE, ONE_YOCTO, |c| {
            c.add_liquidity(999, U128(1), U128(1), U128(0))
        }),
        &err,
    );
    fails(
        w.call(ALICE, ONE_YOCTO, |c| {
            c.lp_deposit(999, U128(1), U128(1), U128(0))
        }),
        &err,
    );
    // The owner's other tools are never paused.
    w.call(OWNER, ONE_YOCTO, |c| c.set_dispute_window(45))
        .unwrap();
}

#[test]
fn transfer_lend_and_oracle_stop_their_methods() {
    let mut w = World::new();
    pause(&mut w, &[PauseFlag::Transfer]);
    fails(
        w.mt_transfer(ALICE, BOB, "1:wnear:1", 1),
        &paused(PauseFlag::Transfer),
    );
    fails(
        w.mt_batch_transfer(ALICE, BOB, &["1:wnear:1".to_string()], &[1]),
        &paused(PauseFlag::Transfer),
    );
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.lp_transfer(1, acc(BOB), U128(1))),
        &paused(PauseFlag::Transfer),
    );

    pause(&mut w, &[PauseFlag::Lend]);
    fails(w.borrow(ALICE, 999, 1), &paused(PauseFlag::Lend));
    // A trade into lending needs `lend` as well as `trade`.
    fails(
        w.call(ALICE, ONE_YOCTO, |c| {
            c.conditional_sell(999, U128(0), 1, vec![], vec![], true, None)
        }),
        &paused(PauseFlag::Lend),
    );
    fails(
        w.call(ALICE, ONE_YOCTO, |c| {
            c.conditional_sell(999, U128(0), 1, vec![], vec![], false, None)
        }),
        "ZeroAmount",
    );

    pause(&mut w, &[PauseFlag::Oracle]);
    let (fed, spice) = (w.fed, w.spice);
    fails(w.report(fed, 0), &paused(PauseFlag::Oracle));
    fails(w.finalize(ALICE, spice), &paused(PauseFlag::Oracle));
    fails(
        w.call(ALICE, NearToken::from_near(1), |c| {
            c.request_resolution(fed)
        }),
        &paused(PauseFlag::Oracle),
    );
    // The owner's override and dispute are never paused.
    w.admin_resolve(fed, 0).unwrap();
}

#[test]
fn exit_stops_every_way_out_and_nothing_else() {
    let mut w = World::new();
    w.deposit(ALICE, Usdc, 10 * E18).unwrap();
    pause(&mut w, &[PauseFlag::Exit]);
    let err = paused(PauseFlag::Exit);
    fails(w.withdraw(ALICE, Usdc, E18), &err);
    fails(w.merge(ALICE, 1, Wnear, &[1, 14], 15, 1), &err);
    fails(w.redeem(ALICE, 1, Wnear, 1, 1), &err);
    fails(w.call(ALICE, ONE_YOCTO, |c| c.cancel_order(U64(999))), &err);
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.close_after_resolution(999, None)),
        &err,
    );
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.withdraw_supply(999, None, None)),
        &err,
    );
    // Without debt, taking collateral back is an exit.
    fails(
        w.call(ALICE, ONE_YOCTO, |c| {
            c.withdraw_collateral(1, "usdc".to_string(), U128(1), None)
        }),
        &err,
    );
    fails(
        w.call(ALICE, ONE_YOCTO, |c| {
            c.lp_withdraw(999, U128(1), vec![], vec![])
        }),
        &err,
    );
    fails(
        w.call(ALICE, ONE_YOCTO, |c| {
            c.remove_liquidity(999, U128(1), U128(0), U128(0))
        }),
        &err,
    );
    fails(w.call(ALICE, ONE_YOCTO, |c| c.collect_fees(999)), &err);
    fails(w.call(ALICE, ONE_YOCTO, |c| c.storage_withdraw(None)), &err);
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.storage_unregister(None)),
        &err,
    );
    // Deposits, collateral top-ups and storage deposits go on.
    w.deposit(ALICE, Usdc, E18).unwrap();
    w.post_real(ALICE, 1, Usdc, E18).unwrap();
    w.post(ALICE, 1, "usdc", E18).unwrap();
    w.register(CAROL, NearToken::from_near(1));
}

#[test]
fn transfer_actions_check_their_flag_and_refund_in_full() {
    let mut w = World::new();
    let wallet = w.wallet_raw(ALICE, Usdc);
    let cases = [
        (PauseFlag::Lend, r#"{"action":"supply","scenario_id":1}"#),
        (
            PauseFlag::Mint,
            r#"{"action":"split","scenario_id":1,"to_masks":[1,14]}"#,
        ),
        (
            PauseFlag::Liquidate,
            r#"{"action":"liquidate","scenario_id":1,"account_id":"bob.near","repay_amount":"max"}"#,
        ),
        (
            PauseFlag::Exit,
            r#"{"action":"close_after_resolution","scenario_id":1}"#,
        ),
        (PauseFlag::Trade, r#"{"action":"spot_swap","min_out":"0"}"#),
        (PauseFlag::Pledge, r#"{"action":"pledge","proposal_id":1}"#),
        (
            PauseFlag::Mint,
            r#"{"action":"lp_deposit","scenario_id":1,"wnear_amount":"0","min_shares":"0"}"#,
        ),
    ];
    for (flag, msg) in cases {
        pause(&mut w, &[flag]);
        fails(
            w.ft_transfer_call(ALICE, Usdc, 1_000_000, msg),
            &paused(flag),
        );
        assert_eq!(w.wallet_raw(ALICE, Usdc), wallet, "{msg}");
    }
    // Plain deposits, repayments and collateral are never paused.
    pause(&mut w, &PauseFlag::ALL);
    w.deposit(ALICE, Usdc, E18).unwrap();
    w.post_real(ALICE, 1, Usdc, E18).unwrap();
    fails(w.repay_ft(ALICE, 1, E18, false), "ZeroAmount");
}

#[test]
fn liquidation_waits_out_the_grace_and_cash_needs_trade() {
    let mut w = World::new();
    let resume = T0 + 100;
    w.call(OWNER, NO_DEPOSIT, |c| {
        c.pause.liquidations_resume_at_sec = resume
    })
    .unwrap();
    let msg =
        r#"{"action":"liquidate","scenario_id":1,"account_id":"bob.near","repay_amount":"max"}"#;
    fails(
        w.ft_transfer_call(ALICE, Usdc, 1_000_000, msg),
        &format!("LiquidationGrace({resume})"),
    );
    w.warp(100);
    fails(
        w.ft_transfer_call(ALICE, Usdc, 1_000_000, msg),
        "NotLiquidatable(340282366920938463463374607431768211455)",
    );
    pause(&mut w, &[PauseFlag::Trade]);
    let cash = r#"{"action":"liquidate","scenario_id":1,"account_id":"bob.near","repay_amount":"max","receive":"cash","min_out":"1"}"#;
    fails(
        w.ft_transfer_call(ALICE, Usdc, 1_000_000, cash),
        "Paused(trade)",
    );
}

// ---- Transfer msgs ----

#[test]
fn v1_msgs_parse_with_v2_defaults() {
    match parse_msg(r#"{"action":"supply","scenario_id":5}"#) {
        Action::Supply(m) => assert_eq!((m.scenario_id, m.tier), (5, Tier::Normal)),
        other => panic!("{other:?}"),
    }
    match parse_msg(
        r#"{"action":"liquidate","scenario_id":1,"account_id":"carl.near","repay_amount":"max"}"#,
    ) {
        Action::Liquidate(m) => {
            assert_eq!(
                (m.tier, m.receive, m.min_out),
                (Tier::Normal, Receive::Tokens, None)
            )
        }
        other => panic!("{other:?}"),
    }
    match parse_msg(r#"{"action":"repay","scenario_id":5,"all":true,"tier":"bold"}"#) {
        Action::Repay(m) => assert_eq!(m.tier, Tier::Bold),
        other => panic!("{other:?}"),
    }
    match parse_msg(r#"{"action":"fund_insurance","scenario_id":5,"tier":"safe"}"#) {
        Action::FundInsurance(m) => assert_eq!((m.scenario_id, m.tier), (5, Tier::Safe)),
        other => panic!("{other:?}"),
    }
    match parse_msg(r#"{"action":"pledge","proposal_id":12}"#) {
        Action::Pledge(m) => assert_eq!(m.proposal_id, 12),
        other => panic!("{other:?}"),
    }
}

#[test]
fn unknown_fields_and_tiers_are_still_refused() {
    let mut w = World::new();
    fails(
        w.ft_transfer_call(
            ALICE,
            Usdc,
            1,
            r#"{"action":"supply","scenario_id":1,"tiers":"bold"}"#,
        ),
        "BadMessage(unknown field `tiers`, expected `scenario_id` or `tier`)",
    );
    fails(
        w.ft_transfer_call(
            ALICE,
            Usdc,
            1,
            r#"{"action":"supply","scenario_id":1,"tier":"wild"}"#,
        ),
        "BadMessage(unknown variant `wild`, expected one of `normal`, `safe`, `bold`)",
    );
    fails(
        w.ft_transfer_call(
            ALICE,
            Usdc,
            1,
            r#"{"action":"pledge","proposal_id":1,"x":1}"#,
        ),
        "BadMessage(unknown field `x`, expected `proposal_id`)",
    );
}

#[test]
fn every_tier_acts_through_its_msgs() {
    let mut w = lending_world(1_000 * E18);
    let s = w.s2x2;
    let msg = format!(r#"{{"action":"supply","scenario_id":{s},"tier":"bold"}}"#);
    assert_eq!(w.ft_transfer_call(BOB, Usdc, 1_000_000, &msg), Ok(0));
    let bold = MarketId::new(s, Some(Tier::Bold));
    assert_eq!(w.view(|c| c.market_of(bold)).total_supply_assets, E18);
    let msg = format!(r#"{{"action":"deposit_collateral","scenario_id":{s},"tier":"safe"}}"#);
    assert_eq!(w.ft_transfer_call(BOB, Usdc, 1_000_000, &msg), Ok(0));
    let safe = MarketId::new(s, Some(Tier::Safe));
    assert_eq!(
        w.view(|c| c.pieces(safe, &acc(BOB))),
        vec![(crate::lending::CollateralKey::Real(Usdc), E18)]
    );
    // Normal, named or not, acts as v1 did.
    let msg = format!(r#"{{"action":"supply","scenario_id":{s},"tier":"normal"}}"#);
    assert_eq!(w.ft_transfer_call(BOB, Usdc, 1_000_000, &msg), Ok(0));
    assert_eq!(w.lent(s, BOB), 1_001 * E18);
}

#[test]
fn liquidation_msg_checks_its_cash_fields() {
    let mut w = World::new();
    let base =
        r#""action":"liquidate","scenario_id":1,"account_id":"bob.near","repay_amount":"max""#;
    fails(
        w.ft_transfer_call(ALICE, Usdc, 1, &format!(r#"{{{base},"receive":"cash"}}"#)),
        "MinOutRequired",
    );
    fails(
        w.ft_transfer_call(ALICE, Usdc, 1, &format!(r#"{{{base},"min_out":"1"}}"#)),
        "MinOutWithoutCash",
    );
    // Both fields right: the liquidation itself runs (bob owes nothing).
    fails(
        w.ft_transfer_call(
            ALICE,
            Usdc,
            1,
            &format!(r#"{{{base},"receive":"cash","min_out":"1"}}"#),
        ),
        &format!("NotLiquidatable({})", u128::MAX),
    );
    fails(
        w.ft_transfer_call(ALICE, Wnear, 1, &format!(r#"{{{base},"receive":"cash"}}"#)),
        "WrongAsset(wnear)",
    );
}

#[test]
fn fund_insurance_acts_and_pledge_is_a_stub() {
    let mut w = World::new();
    let msg = r#"{"action":"fund_insurance","scenario_id":1}"#;
    assert_eq!(w.ft_transfer_call(ALICE, Usdc, 1_000_000, msg), Ok(0));
    assert_eq!(
        w.view(|c| c.tier_state(MarketId::new(1, None))).insurance,
        E18
    );
    fails(
        w.ft_transfer_call(ALICE, Wnear, 1, r#"{"action":"pledge","proposal_id":1}"#),
        "NotImplemented(pledge)",
    );
    // fund_insurance is never paused.
    pause(&mut w, &PauseFlag::ALL);
    assert_eq!(w.ft_transfer_call(ALICE, Usdc, 1_000_000, msg), Ok(0));
    assert_eq!(
        w.view(|c| c.tier_state(MarketId::new(1, None))).insurance,
        2 * E18
    );
}

// ---- Prices ----

#[test]
fn world_price_reads_the_world_quote() {
    let mut w = World::new();
    let s = w.s2x2;
    test_hooks::clear();
    test_hooks::set_quote(
        s,
        0,
        TestQuote {
            twap: 3 * WAD,
            spot: 2 * WAD,
            status: WorldStatus::OutOfBand,
            full_window: true,
        },
    );
    assert_eq!(w.view(|c| c.world_price(s, 0)), (0, false));
    test_hooks::set_price(s, 0, 3 * WAD);
    assert_eq!(w.view(|c| c.world_price(s, 0)), (3 * WAD, true));
    test_hooks::set_unpriced(s, 0);
    assert_eq!(w.view(|c| c.world_price(s, 0)), (0, false));
    test_hooks::clear();
    // No pool, no override.
    let q = w.view(|c| c.world_quote(s, 1, &c.price_cfg(s)));
    assert_eq!(q.status, WorldStatus::NoPool);
}

#[test]
fn the_snapshot_prices_as_v1_on_real_pools() {
    test_hooks::clear();
    let mut w = pool_world();
    let s = w.s2x2;
    seed_demo_2x2(&mut w);
    // Below 60 s of history no pool prices.
    let young = w.view(|c| c.price_snapshot(s));
    assert_eq!(young.statuses(), vec![WorldStatus::Young; 4]);
    assert_eq!(young.prices(PriceMode::Liquidate).priced, 0);
    w.warp(61);
    let snap = w.view(|c| c.price_snapshot(s));
    assert_eq!(snap.statuses(), vec![WorldStatus::Trusted; 4]);
    for mode in [PriceMode::Borrow, PriceMode::Liquidate] {
        let px = snap.prices(mode);
        assert_eq!((px.priced, px.trusted, px.factor), (0xF, 0xF, WAD));
        for world in 0..4u8 {
            assert_eq!(
                (px.prices[usize::from(world)], true),
                w.view(|c| c.world_price(s, world))
            );
        }
        assert_eq!(px.max_price, *px.prices.iter().max().unwrap());
    }
    assert!(snap.borrow_block().is_none() && snap.liquidation_guard().is_none());
    assert!(!w.view(|c| {
        let pool = c.pool(c.world_pool(s, 0).unwrap());
        c.pool_full_window(pool)
    }));
    w.warp(1_800);
    assert!(w.view(|c| {
        let pool = c.pool(c.world_pool(s, 0).unwrap());
        c.pool_full_window(pool) && c.world_liq_priced_with(s, pool, &c.price_cfg(s))
    }));
    // A resolved world drops out of the prices.
    let spice = w.spice;
    w.admin_resolve(spice, OUT_SHIPS).unwrap();
    let px = w.view(|c| c.price_snapshot(s)).prices(PriceMode::Liquidate);
    assert_eq!(px.priced, 0x5);
    assert_eq!(px.prices[1], 0);
}

#[test]
fn new_scenarios_snapshot_the_default_price_config() {
    // The production defaults; `World::new()` installs the v1 profile's.
    let mut w = World::new_v2();
    let (s, b) = (w.s2x2, w.s_bin);
    assert_eq!(
        w.view(|c| c.prices.configs.get(&s).copied()),
        Some(MarketPriceCfg::V2)
    );
    assert_eq!(
        w.view(|c| c.prices.configs.get(&b).copied()),
        Some(MarketPriceCfg::V2)
    );
    assert_eq!(w.view(|c| c.price_cfg(999)), MarketPriceCfg::V2);
    let v1 = MarketPriceCfg::v1(&crate::types::Params::new(DISPUTE_WINDOW));
    assert_eq!(
        (
            v1.min_age_sec,
            v1.min_depth.0,
            v1.reference,
            v1.max_haircut.0
        ),
        (60, 10_000 * WAD, false, 0)
    );
}

#[test]
fn twap_odds_need_every_odds_pool_or_the_test_hook() {
    let mut w = World::new();
    let s = w.s2x2;
    test_hooks::clear();
    assert_eq!(w.view(|c| c.twap_odds(s, &c.price_cfg(s))), None);
    let q = vec![WAD / 4; 4];
    test_hooks::set_odds(s, q.clone());
    assert_eq!(w.view(|c| c.twap_odds(s, &c.price_cfg(s))), Some(q));
    test_hooks::clear();
}

// ---- Lending tiers ----

#[test]
fn market_keys_put_the_tier_above_the_scenario() {
    assert_eq!(MarketId::new(5, None).key(), 5);
    assert_eq!(MarketId::new(5, Some(Tier::Normal)).key(), 5);
    assert_eq!(
        MarketId::new(5, Some(Tier::Safe)).key(),
        5 | 1 << TIER_SHIFT
    );
    assert_eq!(
        MarketId::new(5, Some(Tier::Bold)).key(),
        5 | 2 << TIER_SHIFT
    );
    assert_eq!(Tier::ALL, [Tier::Safe, Tier::Normal, Tier::Bold]);
    assert_eq!(Tier::default(), Tier::Normal);
    assert_eq!(
        near_sdk::serde_json::to_string(&Tier::ALL).unwrap(),
        r#"["safe","normal","bold"]"#
    );
}

#[test]
fn builtin_tiers_are_the_owner_defaults() {
    // (lltv, borrow ltv, bonus, base, slope1, slope2) per second.
    let golden = [
        (
            Tier::Safe,
            60,
            50,
            5,
            317_097_919,
            1_268_391_679,
            14_269_406_392,
        ),
        (
            Tier::Normal,
            70,
            60,
            6,
            634_195_839,
            1_902_587_519,
            16_489_091_831,
        ),
        (
            Tier::Bold,
            80,
            70,
            8,
            951_293_759,
            2_853_881_278,
            19_977_168_949,
        ),
    ];
    for (tier, lltv, borrow_ltv, bonus, base, slope1, slope2) in golden {
        let c = TierState::builtin(tier).config;
        assert_eq!(
            (c.lltv, c.borrow_ltv, c.liquidation_bonus),
            (lltv * WAD / 100, borrow_ltv * WAD / 100, bonus * WAD / 100),
            "{tier}"
        );
        assert_eq!(
            (c.rate_base, c.rate_slope1, c.rate_slope2),
            (base, slope1, slope2),
            "{tier}"
        );
        assert_eq!(
            (
                c.reserve_factor,
                c.rate_kink,
                c.max_utilization,
                c.borrow_cap
            ),
            (WAD / 10, 8 * WAD / 10, 9 * WAD / 10, u128::MAX)
        );
    }
    let p = LendingParams::default();
    assert_eq!(
        (p.min_loan, p.full_liquidation_hf, p.small_loan),
        (100 * WAD, 9 * WAD / 10, 200 * WAD)
    );
}

#[test]
fn has_debt_reads_every_tier_of_the_scenario() {
    let mut w = lending_world(10_000 * E18);
    let (s, b) = (w.s2x2, w.s_bin);
    assert!(!w.view(|c| c.has_debt(s)));
    w.post_real(ALICE, s, Usdc, 1_000 * E18).unwrap();
    w.borrow(ALICE, s, 100 * E18).unwrap();
    assert!(w.view(|c| c.has_debt(s)));
    assert!(!w.view(|c| c.has_debt(b)));
    // The touched market snapshot its tier's default (the v1 profile's here).
    let normal = w.view(|c| c.tier_state(MarketId::new(s, None)));
    assert_eq!(normal, w.view(|c| c.default_state(Tier::Normal)));
    assert_eq!(normal.config.lltv, LLTV);
}

// ---- App config ----

#[test]
fn app_config_reports_the_v2_values() {
    let mut w = World::new_v2();
    let c = w.view(|c| c.get_app_config());
    assert_eq!(c.code_version, crate::version::CODE_VERSION);
    assert_eq!(c.state_version, 2);
    assert!(c.paused.is_empty() && c.guardian_id.is_none() && c.pending_owner_id.is_none());
    assert_eq!((c.max_worlds, c.max_events), (8, 3));
    assert_eq!((c.max_trade_fills, c.max_trade_fills_8w), (20, 16));
    assert!(!c.reference_configured);
    assert_eq!(c.proposal_count, 0);
    assert_eq!(c.lending.min_loan, U128(100 * WAD));
    assert_eq!(c.lending.close_factor, U128(WAD / 2));
    let tiers: Vec<Tier> = c.lending.defaults.iter().map(|d| d.tier).collect();
    assert_eq!(tiers, Tier::ALL);
    assert_eq!(c.lending.defaults[2].config.lltv, U128(8 * WAD / 10));
    assert_eq!(c.lending.defaults[0].config.borrow_cap, None);
    // v1 keys keep v1's global params.
    assert_eq!((c.lltv, c.liquidation_bonus), (U128(LLTV), U128(BONUS)));
    pause(&mut w, &[PauseFlag::Lend, PauseFlag::Exit]);
    let json = near_sdk::serde_json::to_value(w.view(|c| c.get_app_config())).unwrap();
    assert_eq!(
        json["paused"],
        near_sdk::serde_json::json!(["lend", "exit"])
    );
    assert_eq!(json["lending"]["defaults"][1]["tier"], "normal");
}

// ---- Catalogue stubs ----

#[test]
fn catalogue_entry_points_are_stubs() {
    let mut w = World::new();
    fails(
        w.call(ALICE, NearToken::from_near(1), |c| {
            c.propose_market(vec![1])
        }),
        "NotImplemented(propose_market)",
    );
    fails(
        w.call(ALICE, NO_DEPOSIT, |c| c.open_market(1)),
        "NotImplemented(open_market)",
    );
    fails(
        w.try_view(|c| c.list_markets(None, None, None)),
        "NotImplemented(list_markets)",
    );
    fails(
        w.try_view(|c| c.get_events(vec![1])),
        "NotImplemented(get_events)",
    );
    let alice = acc(ALICE);
    assert!(!w.view(|c| c.catalog.account_busy(&alice)));
    assert_eq!(w.view(|c| c.catalog.proposal_count), 0);
}

// ---- NEP-145 credits ----

#[test]
fn credit_deposit_adds_to_the_storage_deposit() {
    let mut w = World::new();
    let alice = acc(ALICE);
    let before = w.view(|c| c.storage_balance_of(acc(ALICE)).unwrap());
    let yocto = 50_000_000_000_000_000_000_000;
    w.call(OWNER, NO_DEPOSIT, |c| c.credit_deposit(&alice, yocto))
        .unwrap();
    let after = w.view(|c| c.storage_balance_of(acc(ALICE)).unwrap());
    assert_eq!(after.total.0, before.total.0 + yocto);
    assert_eq!(after.available.0, before.available.0 + yocto);
    assert!(w.last.near_transfers().is_empty());
    // Withdrawable like any deposit.
    w.call(ALICE, ONE_YOCTO, |c| c.storage_withdraw(Some(U128(yocto))))
        .unwrap();
    assert_eq!(w.last.near_transfers(), vec![(acc(ALICE), yocto)]);
    // Not registered: the NEAR is sent.
    let dave = acc(DAVE);
    w.call(OWNER, NO_DEPOSIT, |c| c.credit_deposit(&dave, yocto))
        .unwrap();
    assert_eq!(w.last.near_transfers(), vec![(acc(DAVE), yocto)]);
    w.call(OWNER, NO_DEPOSIT, |c| c.credit_deposit(&dave, 0))
        .unwrap();
    assert!(w.last.near_transfers().is_empty());
}

// ---- Fixtures ----

#[test]
fn the_v2_fixture_matches_the_v1_one_until_the_profiles_differ() {
    let mut v1 = World::new();
    let mut v2 = World::new_v2();
    assert_eq!(
        (v1.spice, v1.fed, v1.s2x2, v1.s_bin),
        (v2.spice, v2.fed, v2.s2x2, v2.s_bin)
    );
    let config =
        |w: &mut World| near_sdk::serde_json::to_value(w.view(|c| c.get_app_config())).unwrap();
    assert_eq!(config(&mut v1), config(&mut v2));
}

// ---- Three events ----

#[test]
fn a_scenario_of_three_events_has_eight_worlds() {
    let mut w = World::new();
    let third = w
        .create_event("Third?", &["YES", "NO"], "YES if so.", T0 + DAY)
        .unwrap();
    let s = w.create_scenario(&[w.spice, w.fed, third]).unwrap();
    let info = w.view(|c| c.get_scenario(s));
    assert_eq!(
        (info.world_count, info.root, info.possible),
        (8, 0xFF, 0xFF)
    );
    let singles: Vec<u8> = (0..8).map(|i| 1u8 << i).collect();
    w.split_ft(ALICE, s, Usdc, &singles, 8 * E18).unwrap();
    assert!(w
        .view(|c| c.backing(s))
        .worlds
        .iter()
        .all(|b| b.usdc_backed));
    fails(
        w.create_scenario(&[w.spice, w.fed, third, 4]),
        "BadEventCount(4)",
    );
}
