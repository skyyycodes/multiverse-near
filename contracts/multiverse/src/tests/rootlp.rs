//! The Root LP vault, test by test, on the 2x2 pools at 3.70 / 3.00 / 3.30 /
//! 2.50 USDC per NEAR and the binary at 3.40 / 2.80, 100,000 NEAR deep.
//! Alice's conditional sales are the router's pool legs done by hand: a
//! root split into every world, then a sale of the wNEAR-if-w of each world
//! in the sold mask.
//!
//! "Held in world w" counts a real unit (wallet or internal) plus the
//! account's single-world token of w.

use near_sdk::json_types::U128;
use near_sdk::PromiseResult;
use proptest::prelude::*;
use proptest::test_runner::Config;

use super::amm::{pool_world, seed_world, seed_worlds, singles, wmul, DEMO_2X2, DEMO_BIN, DEPTH};
use super::harness::*;
use crate::rootlp::{LpDepositPreview, RootLpHolding, WorldAmounts, MINIMUM_SHARES};
use crate::types::Asset::{self, Usdc, Wnear};

const DAVE: &str = BOB;
const WNEAR_IN: u128 = 10_000 * E18;
const USDC_IN: u128 = 30_000 * E18;
const HOLDERS: [&str; 5] = [OWNER, ALICE, BOB, CAROL, CONTRACT];
/// sqrt(1000), scaled by 1e15.
const SQRT_1000_E15: u128 = 31_622_776_601_683_793;

/// Shares are pool liquidity, sqrt(wNEAR * USDC): with 1,000 times the
/// wNEAR of the prototype's demo numbers they are its shares times sqrt(1000).
fn proto_shares(shares: u128) -> u128 {
    shares * SQRT_1000_E15 / 1_000_000_000_000_000
}

struct Fx {
    w: World,
    s: u64,
    b: u64,
    pools: Vec<u64>,
    bin_pools: Vec<u64>,
}

fn setup() -> Fx {
    let mut w = pool_world();
    let (s, b) = (w.s2x2, w.s_bin);
    let pools = seed_worlds(&mut w, s, &DEMO_2X2, &[DEPTH; 4]);
    let bin_pools = seed_worlds(&mut w, b, &DEMO_BIN, &[DEPTH; 2]);
    Fx {
        w,
        s,
        b,
        pools,
        bin_pools,
    }
}

/// Tops `who`'s internal balances up to the amounts from the wallet.
fn fund_internal(w: &mut World, who: &str, wnear: u128, usdc: u128) {
    for (asset, amount) in [(Wnear, wnear), (Usdc, usdc)] {
        let short = amount.saturating_sub(w.real(who, asset));
        if short > 0 {
            w.deposit(who, asset, short.div_ceil(scale(asset)) * scale(asset))
                .unwrap();
        }
    }
}

fn deposit_min(
    w: &mut World,
    who: &str,
    sid: u64,
    wnear: u128,
    usdc: u128,
    min: u128,
) -> Result<u128, String> {
    fund_internal(w, who, wnear, usdc);
    w.call(who, ONE_YOCTO, |c| {
        c.lp_deposit(sid, U128(wnear), U128(usdc), U128(min))
    })
    .map(|s| s.0)
}

fn deposit(w: &mut World, who: &str, sid: u64, wnear: u128, usdc: u128) -> u128 {
    deposit_min(w, who, sid, wnear, usdc, 0).unwrap()
}

/// The real refunds the last deposit logged.
fn last_refunds(w: &World) -> (u128, u128) {
    let e = &w.last.data_of("lp_deposit")[0];
    let n = |k: &str| e[k].as_str().unwrap().parse::<u128>().unwrap();
    (n("wnear_refund"), n("usdc_refund"))
}

fn world_count(w: &mut World, sid: u64) -> usize {
    w.view(|c| c.scenario(sid).world_count) as usize
}

fn withdraw_mins(
    w: &mut World,
    who: &str,
    sid: u64,
    shares: u128,
    min_wnear: Vec<u128>,
    min_usdc: Vec<u128>,
) -> Result<(u128, u128), String> {
    let wrap = |v: Vec<u128>| v.into_iter().map(U128).collect::<Vec<_>>();
    let (mw, mu) = (wrap(min_wnear), wrap(min_usdc));
    w.auto_payouts = false;
    let out = w.call(who, ONE_YOCTO, |c| c.lp_withdraw(sid, U128(shares), mw, mu));
    w.auto_payouts = true;
    if out.is_ok() {
        settle_payouts(w);
    }
    out.map(|(a, b)| (a.0, b.0))
}

/// Carries out the last call's `ft_transfer` + `on_payout` pairs in order.
/// A withdrawal pays out two tokens in one call, and the mocked runtime
/// numbers the second callback's dependency past the receipt list, so the
/// pairs are matched by order here instead.
fn settle_payouts(w: &mut World) {
    let main = w.last.clone();
    let mut transfer = None;
    for call in main.calls() {
        match call.method.as_str() {
            "ft_transfer" => transfer = Some(call),
            "on_payout" => {
                let t = transfer.take().expect("on_payout without ft_transfer");
                assert_eq!(t.deposit, 1);
                let asset = if t.receiver_id.as_str() == WNEAR_TOKEN {
                    Wnear
                } else {
                    Usdc
                };
                let receiver = acc(t.args["receiver_id"].as_str().unwrap());
                let amount: u128 = t.args["amount"].as_str().unwrap().parse().unwrap();
                let ok = !w.ft_unregistered.contains(&receiver);
                if ok {
                    *w.contract_ft.get_mut(&asset).unwrap() -= amount;
                    *w.wallets.entry((receiver.clone(), asset)).or_default() += amount;
                }
                let result = if ok {
                    PromiseResult::Successful(vec![])
                } else {
                    PromiseResult::Failed
                };
                w.exec(CONTRACT, NO_DEPOSIT, vec![result], |c| {
                    c.on_payout(receiver, asset, U128(amount))
                })
                .expect("on_payout must never panic");
            }
            _ => {}
        }
    }
    w.last = main;
}

fn withdraw(w: &mut World, who: &str, sid: u64, shares: u128) -> (u128, u128) {
    let n = world_count(w, sid);
    withdraw_mins(w, who, sid, shares, vec![0; n], vec![0; n]).unwrap()
}

fn preview_deposit(w: &mut World, sid: u64, wnear: u128, usdc: u128) -> LpDepositPreview {
    w.view(|c| c.preview_lp_deposit(sid, U128(wnear), U128(usdc)))
}

fn kept(p: &LpDepositPreview, asset: Asset, world: usize) -> u128 {
    match asset {
        Wnear => p.wnear_kept[world].0,
        Usdc => p.usdc_kept[world].0,
    }
}

fn claim(w: &mut World, sid: u64, shares: u128) -> WorldAmounts {
    w.view(|c| c.root_lp_preview_withdraw(sid, U128(shares)))
}

fn amt(a: &WorldAmounts, asset: Asset, world: usize) -> u128 {
    match asset {
        Wnear => a.wnear[world].0,
        Usdc => a.usdc[world].0,
    }
}

fn holdings(w: &mut World, sid: u64) -> Vec<RootLpHolding> {
    w.view(|c| c.root_lp_holdings(sid))
}

fn shares_of(w: &mut World, sid: u64, who: &str) -> u128 {
    let id = acc(who);
    w.view(|c| c.root_lp_shares_of(sid, id).balance.0)
}

fn supply(w: &mut World, sid: u64) -> u128 {
    let id = acc(CAROL);
    w.view(|c| c.root_lp_shares_of(sid, id).supply.0)
}

fn held_in(w: &mut World, who: &str, sid: u64, world: usize, asset: Asset) -> u128 {
    w.wallet(who, asset) + w.real(who, asset) + w.bal(who, sid, asset, 1 << world)
}

/// Alice's conditional sale of `amount` wNEAR over `mask`, pool legs only.
fn alice_sells(w: &mut World, sid: u64, pools: &[u64], mask: u8, amount: u128) {
    let n = pools.len();
    w.split_ft(ALICE, sid, Wnear, &singles(n), amount).unwrap();
    for (i, pool) in pools.iter().enumerate() {
        if mask & (1 << i) != 0 {
            w.call(ALICE, ONE_YOCTO, |c| {
                c.swap(*pool, true, U128(amount), U128(0))
            })
            .unwrap();
        }
    }
}

/// Every verse token is where the books say, and the contract's real wNEAR
/// and USDC are exactly the internal balances plus the scenario reserves.
fn assert_accounted(w: &mut World) {
    w.assert_conservation(&HOLDERS);
    for asset in Asset::ALL {
        let inside: u128 = HOLDERS.iter().map(|h| w.real(h, asset)).sum::<u128>()
            + w.reserves(1, asset)
            + w.reserves(2, asset);
        assert_eq!(w.held_by_contract(asset), inside, "real {asset}");
    }
}

/// In every live world the tokens covering it equal the reserves.
fn assert_backed(w: &mut World, sid: u64) {
    w.view(|c| {
        let s = c.scenario(sid);
        for world in 0..s.world_count {
            if s.possible & (1 << world) == 0 {
                continue;
            }
            for asset in Asset::ALL {
                assert_eq!(
                    c.supply_in_world(sid, s.root(), asset, world),
                    c.reserve(sid, asset),
                    "backing of world {world} {asset}"
                );
            }
        }
    });
}

fn assert_only_locked_remain(w: &mut World, sid: u64) {
    assert_eq!(supply(w, sid), MINIMUM_SHARES);
    for who in HOLDERS {
        assert_eq!(shares_of(w, sid, who), 0);
    }
    for h in holdings(w, sid) {
        assert!(h.wnear_in_pool.0 + h.wnear_idle.0 + h.wnear_fees.0 < 1_000_000);
        assert!(h.usdc_in_pool.0 + h.usdc_idle.0 + h.usdc_fees.0 < 100_000_000);
    }
}

fn within_rel(a: u128, b: u128, denominator: u128) -> bool {
    a.abs_diff(b) <= b / denominator
}

fn pool_liquidity_for(w: &mut World, pool: u64, wnear: u128, usdc: u128) -> u128 {
    w.view(|c| c.pool(pool).amm.liquidity_for_amounts(wnear, usdc))
}

#[test]
fn first_deposit_provides_liquidity_to_every_world() {
    let Fx {
        mut w, s, pools, ..
    } = setup();
    let preview = preview_deposit(&mut w, s, WNEAR_IN, USDC_IN);
    let expected: Vec<u128> = pools
        .iter()
        .map(|p| pool_liquidity_for(&mut w, *p, WNEAR_IN, USDC_IN))
        .collect();
    let reserves = (w.reserves(s, Wnear), w.reserves(s, Usdc));
    let shares = deposit(&mut w, CAROL, s, WNEAR_IN, USDC_IN);
    let (wnear_refund, usdc_refund) = last_refunds(&w);

    assert_eq!(shares, preview.shares.0);
    assert_eq!(shares_of(&mut w, s, CAROL), shares);
    // the locked shares belong to nobody
    assert_eq!(supply(&mut w, s) - shares, MINIMUM_SHARES);
    assert_eq!(w.reserves(s, Wnear), reserves.0 + WNEAR_IN - wnear_refund);
    assert_eq!(w.reserves(s, Usdc), reserves.1 + USDC_IN - usdc_refund);

    let h = holdings(&mut w, s);
    assert_eq!(h.len(), 4);
    for (i, x) in h.iter().enumerate() {
        assert_eq!(x.world as usize, i);
        assert_eq!(
            x.liquidity.0, expected[i],
            "each world gets its own maximum"
        );
        assert_eq!((x.wnear_idle.0, x.usdc_idle.0), (0, 0));
        assert!(x.wnear_in_pool.0.abs_diff(kept(&preview, Wnear, i)) <= 1);
        assert!(x.usdc_in_pool.0.abs_diff(kept(&preview, Usdc, i)) <= 1);
        for asset in Asset::ALL {
            assert_eq!(
                held_in(&mut w, CAROL, s, i, asset),
                FUND - kept(&preview, asset, i)
            );
        }
        // the scarcer asset at this world's price is used in full
        if wmul(WNEAR_IN, DEMO_2X2[i]) > USDC_IN {
            assert!(within_rel(
                kept(&preview, Usdc, i),
                USDC_IN,
                1_000_000_000_000_000
            ));
        } else {
            assert!(within_rel(
                kept(&preview, Wnear, i),
                WNEAR_IN,
                1_000_000_000_000_000
            ));
        }
    }
    assert_eq!(shares + MINIMUM_SHARES, *expected.iter().min().unwrap());
    assert!(w.bal(CAROL, s, Wnear, SHIPS_CUTS) > 1_800 * E18);
    assert!(w.bal(CAROL, s, Usdc, DELAYED_HOLDS) > 4_900 * E18);

    // the prototype's vector, through a different pool implementation
    assert!(within_rel(
        shares,
        proto_shares(493_196_961_916_071_619_077),
        1_000_000_000_000
    ));
    let proto_wnear_kept: [u128; 4] = [
        8_108_108_108_108_099_974_000,
        9_999_999_999_999_999_971_000,
        9_090_909_090_909_090_881_000,
        10_000_000_000_000_000_000_000,
    ];
    for (i, k) in proto_wnear_kept.iter().enumerate() {
        assert!(within_rel(kept(&preview, Wnear, i), *k, 1_000_000_000_000));
    }
    assert_eq!(wnear_refund, 0, "world 3 keeps all the wNEAR");
    assert!(usdc_refund < E18 / 1_000_000);

    let deposited = w.last.data_of("lp_deposit");
    assert_eq!(deposited.len(), 1);
    assert_eq!(deposited[0]["shares"], shares.to_string());
    assert_accounted(&mut w);
    assert_backed(&mut w, s);
}

#[test]
fn ft_lp_deposit_takes_attached_usdc_and_hands_back_the_rest() {
    let Fx { mut w, s, .. } = setup();
    let usdc = 40_000 * E18;
    let preview = preview_deposit(&mut w, s, WNEAR_IN, usdc);
    w.deposit(CAROL, Wnear, WNEAR_IN).unwrap();
    let msg = format!(
        r#"{{"action":"lp_deposit","scenario_id":{s},"wnear_amount":"{WNEAR_IN}","min_shares":"{}"}}"#,
        preview.shares.0
    );
    let wallet = w.wallet(CAROL, Usdc);
    let unused = w
        .ft_transfer_call(CAROL, Usdc, usdc / scale(Usdc), &msg)
        .unwrap();
    let (wnear_refund, usdc_refund) = last_refunds(&w);
    // world 0 at 3.70 needs exactly 37,000 USDC for 10,000 NEAR, so 3,000
    // of the 40,000 comes back
    assert!(usdc_refund >= 3_000 * E18);
    assert_eq!(unused, usdc_refund / scale(Usdc));
    assert_eq!(w.wallet(CAROL, Usdc), wallet - usdc + unused * scale(Usdc));
    assert_eq!(w.real(CAROL, Usdc), usdc_refund % scale(Usdc));
    assert_eq!(w.real(CAROL, Wnear), wnear_refund);
    assert_eq!(shares_of(&mut w, s, CAROL), preview.shares.0);

    // only USDC can be attached; a short wNEAR balance fails and refunds
    fails(
        w.ft_transfer_call(CAROL, Wnear, E18, &msg),
        "WrongAsset(wnear)",
    );
    let wallet = w.wallet(CAROL, Usdc);
    let err = w
        .ft_transfer_call(CAROL, Usdc, usdc / scale(Usdc), &msg)
        .unwrap_err();
    assert!(err.starts_with("InsufficientBalance(carol.near"), "{err}");
    assert_eq!(w.wallet(CAROL, Usdc), wallet);
    assert_accounted(&mut w);
}

#[test]
fn second_deposit_before_trading_joins_at_the_same_mix() {
    let Fx { mut w, s, .. } = setup();
    deposit(&mut w, CAROL, s, WNEAR_IN, USDC_IN);
    let supply_before = supply(&mut w, s);
    let preview = preview_deposit(&mut w, s, WNEAR_IN, USDC_IN);
    let shares = deposit(&mut w, DAVE, s, WNEAR_IN, USDC_IN);
    assert_eq!(shares, preview.shares.0);
    assert!(shares <= supply_before);
    assert!(within_rel(shares, supply_before, 1_000_000_000_000_000));
    assert!(within_rel(
        shares,
        proto_shares(493_196_961_916_071_619_929),
        1_000_000_000_000
    ));
    for i in 0..4 {
        let (c, d) = (
            held_in(&mut w, CAROL, s, i, Wnear),
            held_in(&mut w, DAVE, s, i, Wnear),
        );
        assert!(d >= c && d - c <= 1_000, "world {i} wNEAR {c} {d}");
        let (c, d) = (
            held_in(&mut w, CAROL, s, i, Usdc),
            held_in(&mut w, DAVE, s, i, Usdc),
        );
        assert!(d >= c && d - c <= 1_000_000, "world {i} USDC {c} {d}");
    }
    assert_accounted(&mut w);
}

#[test]
fn withdraw_partial_then_full_before_trading() {
    let Fx { mut w, s, .. } = setup();
    let preview = preview_deposit(&mut w, s, WNEAR_IN, USDC_IN);
    let shares = deposit(&mut w, CAROL, s, WNEAR_IN, USDC_IN);
    withdraw(&mut w, CAROL, s, shares / 2);
    for i in 0..4 {
        for (asset, tol) in [(Wnear, 1_000_000), (Usdc, 100_000_000)] {
            let held = held_in(&mut w, CAROL, s, i, asset);
            let target = FUND - kept(&preview, asset, i) / 2;
            assert!(held <= target && target - held <= tol, "world {i} {asset}");
        }
    }
    let rest = shares_of(&mut w, s, CAROL);
    withdraw(&mut w, CAROL, s, rest);
    assert_eq!(shares_of(&mut w, s, CAROL), 0);
    for i in 0..4 {
        for (asset, tol) in [(Wnear, 1_000_000), (Usdc, 100_000_000)] {
            let held = held_in(&mut w, CAROL, s, i, asset);
            assert!(held <= FUND && FUND - held <= tol, "world {i} {asset}");
        }
    }
    assert_accounted(&mut w);
    assert_only_locked_remain(&mut w, s);
}

#[test]
fn trade_then_withdraw_pays_fees_and_returns_world_tokens() {
    let Fx {
        mut w, s, pools, ..
    } = setup();
    let shares = deposit(&mut w, CAROL, s, WNEAR_IN, USDC_IN);
    let before = holdings(&mut w, s);
    alice_sells(&mut w, s, &pools, L_SHAPE, 2_000 * E18);
    let after = holdings(&mut w, s);
    assert_eq!((after[0].wnear_fees.0, after[0].usdc_fees.0), (0, 0));
    for i in 1..4 {
        assert!(after[i].wnear_fees.0 > 0);
        assert_eq!(after[i].usdc_fees.0, 0);
        assert!(after[i].wnear_in_pool.0 > before[i].wnear_in_pool.0);
        assert!(after[i].usdc_in_pool.0 < before[i].usdc_in_pool.0);
    }

    let preview = claim(&mut w, s, shares);
    let tokens: Vec<(u128, u128)> = (0..4)
        .map(|i| {
            (
                w.bal(CAROL, s, Wnear, 1 << i),
                w.bal(CAROL, s, Usdc, 1 << i),
            )
        })
        .collect();
    let (wnear_out, usdc_out) = withdraw(&mut w, CAROL, s, shares);
    assert_eq!(wnear_out, preview.wnear.iter().map(|a| a.0).min().unwrap());
    assert_eq!(usdc_out, preview.usdc.iter().map(|a| a.0).min().unwrap());
    for (i, (tw, tu)) in tokens.iter().enumerate() {
        assert_eq!(
            w.bal(CAROL, s, Wnear, 1 << i) - tw,
            preview.wnear[i].0 - wnear_out
        );
        assert_eq!(
            w.bal(CAROL, s, Usdc, 1 << i) - tu,
            preview.usdc[i].0 - usdc_out
        );
    }
    let fees = w.last.data_of("lp_fees_collected");
    assert_eq!(fees.len(), 3);
    assert_eq!(fees[0]["world"], 1);
    assert_accounted(&mut w);
    assert_only_locked_remain(&mut w, s);
}

#[test]
fn full_resolution_surviving_world_collapses_to_real_assets() {
    let Fx {
        mut w, s, pools, ..
    } = setup();
    let shares = deposit(&mut w, CAROL, s, WNEAR_IN, USDC_IN);
    let leftover = w.bal(CAROL, s, Usdc, DELAYED_HOLDS);
    alice_sells(&mut w, s, &pools, L_SHAPE, 2_000 * E18);
    let price = w.view(|c| c.world_spot_price(1, 3).unwrap());
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    w.admin_resolve(w.spice, OUT_DELAYED).unwrap();
    assert_eq!(w.possible(s), DELAYED_HOLDS);

    let preview = claim(&mut w, s, shares);
    for i in 0..3 {
        assert_eq!((preview.wnear[i].0, preview.usdc[i].0), (0, 0));
    }
    let real = |w: &mut World, a| w.wallet(CAROL, a) + w.real(CAROL, a);
    let (w0, u0) = (real(&mut w, Wnear), real(&mut w, Usdc));
    let (wnear_out, usdc_out) = withdraw(&mut w, CAROL, s, shares);
    assert_eq!(
        (wnear_out, usdc_out),
        (preview.wnear[3].0, preview.usdc[3].0)
    );
    assert_eq!(real(&mut w, Wnear) - w0, wnear_out);
    assert_eq!(real(&mut w, Usdc) - u0, usdc_out);
    assert_eq!(w.bal(CAROL, s, Wnear, DELAYED_HOLDS), 0);
    assert_eq!(w.bal(CAROL, s, Usdc, DELAYED_HOLDS), leftover);
    w.redeem(CAROL, s, Usdc, DELAYED_HOLDS, leftover).unwrap();
    assert_eq!(w.bal(CAROL, s, Usdc, DELAYED_HOLDS), 0);

    let wnear_got = real(&mut w, Wnear) - (FUND - WNEAR_IN);
    let usdc_got = real(&mut w, Usdc) - (FUND - USDC_IN);
    assert!(wnear_got > WNEAR_IN);
    assert!(usdc_got < USDC_IN);
    let value = wmul(wnear_got, price) + usdc_got;
    let held = wmul(WNEAR_IN, price) + USDC_IN;
    assert!(within_rel(value, held, 1_000), "{value} vs {held}");
    // the prototype's walk-through at NEAR scale: 10,181.818 wNEAR + 29,554.886868 USDC
    assert!(within_rel(wnear_got, 10_181_818 * E18 / 1_000, 100_000));
    assert!(within_rel(
        usdc_got,
        29_554_886_868 * E18 / 1_000_000,
        100_000
    ));
    assert_accounted(&mut w);
    assert_backed(&mut w, s);
    assert_only_locked_remain(&mut w, s);
}

#[test]
fn withdraw_between_resolutions_merges_across_live_worlds() {
    let Fx {
        mut w, s, pools, ..
    } = setup();
    let shares = deposit(&mut w, CAROL, s, WNEAR_IN, USDC_IN);
    alice_sells(&mut w, s, &pools, L_SHAPE, 2_000 * E18);
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    let preview = claim(&mut w, s, shares);
    for i in 0..2 {
        assert_eq!((preview.wnear[i].0, preview.usdc[i].0), (0, 0));
    }
    let tokens: Vec<(u128, u128)> = (0..4)
        .map(|i| {
            (
                w.bal(CAROL, s, Wnear, 1 << i),
                w.bal(CAROL, s, Usdc, 1 << i),
            )
        })
        .collect();
    let (wnear_out, usdc_out) = withdraw(&mut w, CAROL, s, shares);
    assert_eq!(wnear_out, preview.wnear[2].0.min(preview.wnear[3].0));
    assert_eq!(usdc_out, preview.usdc[2].0.min(preview.usdc[3].0));
    for (i, (tw, tu)) in tokens.iter().enumerate() {
        let (nw, nu) = (
            w.bal(CAROL, s, Wnear, 1 << i),
            w.bal(CAROL, s, Usdc, 1 << i),
        );
        if i < 2 {
            assert_eq!((nw, nu), (*tw, *tu));
        } else {
            assert_eq!(nw - tw, preview.wnear[i].0 - wnear_out);
            assert_eq!(nu - tu, preview.usdc[i].0 - usdc_out);
        }
    }
    assert_accounted(&mut w);
    assert_backed(&mut w, s);
}

#[test]
fn binary_deposit_trade_resolve_withdraw() {
    let Fx {
        mut w,
        b,
        bin_pools,
        ..
    } = setup();
    let preview = preview_deposit(&mut w, b, WNEAR_IN, USDC_IN);
    assert!(within_rel(
        preview.shares.0,
        proto_shares(514_495_755_427_526_048_090),
        1_000_000_000_000
    ));
    let shares = deposit(&mut w, CAROL, b, WNEAR_IN, USDC_IN);
    let (wnear_refund, _) = last_refunds(&w);
    alice_sells(&mut w, b, &bin_pools, BIN_DELAYED, 2_000 * E18);
    w.admin_resolve(w.spice, OUT_SHIPS).unwrap();

    let wallet = w.wallet(CAROL, Wnear) + w.real(CAROL, Wnear);
    let (wnear_out, usdc_out) = withdraw(&mut w, CAROL, b, shares);
    assert_eq!(
        w.wallet(CAROL, Wnear) + w.real(CAROL, Wnear) - wallet,
        wnear_out
    );
    for (out, k) in [
        (wnear_out, kept(&preview, Wnear, 0)),
        (usdc_out, kept(&preview, Usdc, 0)),
    ] {
        assert!(out <= k);
        assert!(within_rel(out, k, 1_000_000_000_000));
    }
    let leftover = w.bal(CAROL, b, Wnear, BIN_SHIPS);
    assert_eq!(leftover, WNEAR_IN - kept(&preview, Wnear, 0) - wnear_refund);
    if leftover > 0 {
        w.redeem(CAROL, b, Wnear, BIN_SHIPS, leftover).unwrap();
    }
    for (asset, tol) in [(Wnear, 1_000_000), (Usdc, 100_000_000)] {
        let held = held_in(&mut w, CAROL, b, 0, asset);
        assert!(held <= FUND && FUND - held <= tol, "{asset}");
    }
    assert_accounted(&mut w);
    assert_only_locked_remain(&mut w, b);
}

#[test]
fn deposit_and_withdraw_while_halted() {
    let Fx { mut w, s, .. } = setup();
    let carol = deposit(&mut w, CAROL, s, WNEAR_IN, USDC_IN);
    w.report(w.fed, OUT_HOLDS).unwrap();
    assert!(w.view(|c| c.is_halted(1)));
    let dave = deposit(&mut w, DAVE, s, WNEAR_IN, USDC_IN);
    withdraw(&mut w, CAROL, s, carol);
    withdraw(&mut w, DAVE, s, dave);
    assert_accounted(&mut w);
    assert_only_locked_remain(&mut w, s);
}

#[test]
fn deposit_after_partial_resolution_skips_dead_worlds() {
    let Fx { mut w, s, .. } = setup();
    let carol = deposit(&mut w, CAROL, s, WNEAR_IN, USDC_IN);
    w.admin_resolve(w.fed, OUT_CUTS).unwrap();
    let h = holdings(&mut w, s);
    assert_eq!(h.iter().map(|x| x.world).collect::<Vec<_>>(), vec![0, 1]);
    let dead = w.supply(s, Wnear, SHIPS_HOLDS);
    let preview = preview_deposit(&mut w, s, WNEAR_IN, USDC_IN);
    assert_eq!(kept(&preview, Wnear, 2) + kept(&preview, Usdc, 3), 0);
    let dave = deposit(&mut w, DAVE, s, WNEAR_IN, USDC_IN);
    assert_eq!(w.supply(s, Wnear, SHIPS_HOLDS), dead);
    assert_eq!(w.bal(DAVE, s, Wnear, SHIPS_HOLDS), 0);
    withdraw(&mut w, DAVE, s, dave);
    withdraw(&mut w, CAROL, s, carol);
    assert_accounted(&mut w);
    assert_backed(&mut w, s);
    assert_only_locked_remain(&mut w, s);
}

#[test]
fn two_lps_join_is_fair_in_every_world() {
    let Fx {
        mut w, s, pools, ..
    } = setup();
    let carol = deposit(&mut w, CAROL, s, WNEAR_IN, USDC_IN);
    alice_sells(&mut w, s, &pools, L_SHAPE, 2_000 * E18);
    let before = claim(&mut w, s, carol);
    let preview = preview_deposit(&mut w, s, WNEAR_IN, USDC_IN);
    let dave = deposit(&mut w, DAVE, s, WNEAR_IN, USDC_IN);
    assert_eq!(dave, preview.shares.0);
    let (wnear_refund, _) = last_refunds(&w);
    let after = claim(&mut w, s, carol);
    let theirs = claim(&mut w, s, dave);
    for i in 0..4 {
        for (asset, tol) in [(Wnear, 1_000_000), (Usdc, 100_000_000)] {
            assert!(
                amt(&after, asset, i) >= amt(&before, asset, i),
                "carol {i} {asset}"
            );
            let k = kept(&preview, asset, i);
            let d = amt(&theirs, asset, i);
            assert!(d <= k && k - d <= tol, "dave {i} {asset}");
        }
        assert_eq!(
            w.bal(DAVE, s, Wnear, 1 << i) + wnear_refund,
            WNEAR_IN - kept(&preview, Wnear, i)
        );
    }

    alice_sells(&mut w, s, &pools, DELAYED_HOLDS, 1_000 * E18);
    let total = supply(&mut w, s);
    let all = claim(&mut w, s, total);
    let c = claim(&mut w, s, carol);
    let (cw, cu) = withdraw(&mut w, CAROL, s, carol);
    assert_eq!(cw, c.wnear.iter().map(|a| a.0).min().unwrap());
    assert_eq!(cu, c.usdc.iter().map(|a| a.0).min().unwrap());
    let d = claim(&mut w, s, dave);
    withdraw(&mut w, DAVE, s, dave);
    let locked = claim(&mut w, s, MINIMUM_SHARES);
    for i in 0..4 {
        for (asset, tol) in [(Wnear, 10), (Usdc, 1_000)] {
            let both = amt(&c, asset, i) + amt(&d, asset, i);
            let total = amt(&all, asset, i);
            assert!(both <= total, "world {i} {asset}");
            let with_locked = both + amt(&locked, asset, i);
            assert!(with_locked.abs_diff(total) <= tol, "world {i} {asset}");
        }
    }
    assert_accounted(&mut w);
    assert_only_locked_remain(&mut w, s);
}

#[test]
fn skewed_first_deposit_cannot_crowd_out_later_deposits() {
    let Fx {
        mut w, s, pools, ..
    } = setup();
    let tiny = 1_000_000_000_000_000;
    deposit(&mut w, DAVE, s, tiny, tiny);
    let fresh: Vec<u128> = pools
        .iter()
        .map(|p| pool_liquidity_for(&mut w, *p, WNEAR_IN, USDC_IN))
        .collect();
    let before = holdings(&mut w, s);
    deposit(&mut w, CAROL, s, WNEAR_IN, USDC_IN);
    let after = holdings(&mut w, s);
    for i in 0..4 {
        let added = after[i].liquidity.0 - before[i].liquidity.0;
        assert!(
            added * 10 >= fresh[i] * 8,
            "world {i}: {added} of {}",
            fresh[i]
        );
    }
    assert_accounted(&mut w);
}

#[test]
fn rejects_deposit() {
    let Fx { mut w, s, .. } = setup();
    let call = |w: &mut World, sid, wnear, usdc, min| {
        w.call(CAROL, ONE_YOCTO, |c| {
            c.lp_deposit(sid, U128(wnear), U128(usdc), U128(min))
        })
    };
    fails(call(&mut w, s, 0, USDC_IN, 0), "ZeroAmount");
    fails(call(&mut w, s, WNEAR_IN, 0, 0), "ZeroAmount");
    fails(
        call(&mut w, 99, WNEAR_IN, USDC_IN, 0),
        "UnknownScenario(99)",
    );
    fails(call(&mut w, s, 1, 1, 0), "DepositTooSmall");
    assert_eq!(
        w.try_view(|c| c.preview_lp_deposit(s, U128(1), U128(1))),
        Err("DepositTooSmall".to_string())
    );
    let shares = preview_deposit(&mut w, s, WNEAR_IN, USDC_IN).shares.0;
    fails(
        deposit_min(&mut w, CAROL, s, WNEAR_IN, USDC_IN, shares + 1),
        &format!("TooFewShares({shares}, {})", shares + 1),
    );
    assert_eq!(
        deposit_min(&mut w, CAROL, s, WNEAR_IN, USDC_IN, shares),
        Ok(shares)
    );
    fails(call(&mut w, s, 1, 1, 0), "DepositTooSmall");
    // Dave has nothing in his internal balances to draw from
    fails(
        w.call(DAVE, ONE_YOCTO, |c| {
            c.lp_deposit(s, U128(WNEAR_IN), U128(USDC_IN), U128(0))
        }),
        &format!("InsufficientBalance(bob.near, 0, {WNEAR_IN})"),
    );
}

#[test]
fn rejects_deposit_without_pools() {
    let mut w = pool_world();
    let b = w.s_bin;
    let call = |w: &mut World| {
        w.call(CAROL, ONE_YOCTO, |c| {
            c.lp_deposit(b, U128(WNEAR_IN), U128(USDC_IN), U128(0))
        })
    };
    fails(call(&mut w), "PoolNotInitialized(0)");
    w.split_ft(OWNER, b, Wnear, &[BIN_SHIPS, BIN_DELAYED], DEPTH)
        .unwrap();
    w.split_ft(OWNER, b, Usdc, &[BIN_SHIPS, BIN_DELAYED], 340_000 * E18)
        .unwrap();
    seed_world(&mut w, b, 0, DEMO_BIN[0], DEPTH);
    fails(call(&mut w), "PoolNotInitialized(1)");
    assert_eq!(w.view(|c| c.root_lp_view(b, None)), None);
}

#[test]
fn rejects_withdraw() {
    let Fx { mut w, s, .. } = setup();
    let zeros = || vec![0u128; 4];
    fails(
        withdraw_mins(&mut w, CAROL, s, 1, zeros(), zeros()),
        &format!("NoDeposits({s})"),
    );
    fails(
        w.try_view(|c| c.root_lp_preview_withdraw(s, U128(1))),
        &format!("NoDeposits({s})"),
    );
    let shares = deposit(&mut w, CAROL, s, WNEAR_IN, USDC_IN);
    fails(
        withdraw_mins(&mut w, CAROL, s, 0, zeros(), zeros()),
        "ZeroAmount",
    );
    fails(
        withdraw_mins(&mut w, CAROL, s, shares, vec![0; 2], zeros()),
        "LengthMismatch",
    );
    fails(
        withdraw_mins(&mut w, CAROL, s, shares, zeros(), vec![0; 2]),
        "LengthMismatch",
    );
    fails(
        withdraw_mins(&mut w, CAROL, s, shares + 1, zeros(), zeros()),
        &format!("InsufficientBalance(carol.near, {shares}, {})", shares + 1),
    );
    let preview = claim(&mut w, s, shares);
    let mut min_wnear: Vec<u128> = preview.wnear.iter().map(|a| a.0).collect();
    let min_usdc: Vec<u128> = preview.usdc.iter().map(|a| a.0).collect();
    min_wnear[2] += 1;
    fails(
        withdraw_mins(
            &mut w,
            CAROL,
            s,
            shares,
            min_wnear.clone(),
            min_usdc.clone(),
        ),
        &format!(
            "InsufficientOutput(2, 1:wnear:4, {}, {})",
            preview.wnear[2].0, min_wnear[2]
        ),
    );
    min_wnear[2] -= 1;
    withdraw_mins(&mut w, CAROL, s, shares, min_wnear, min_usdc).unwrap();
    assert_accounted(&mut w);
}

/// The vault's guards are the one-yocto deposit and the custody split:
/// the vault's positions are not in the pool's position book, so nobody can
/// remove them through `remove_liquidity`.
#[test]
fn rejects_without_one_yocto_and_vault_positions_are_not_public() {
    let Fx {
        mut w, s, pools, ..
    } = setup();
    let yocto = "Requires attached deposit of exactly 1 yoctoNEAR";
    let err = w
        .call(CAROL, NO_DEPOSIT, |c| {
            c.lp_deposit(s, U128(WNEAR_IN), U128(USDC_IN), U128(0))
        })
        .unwrap_err();
    assert!(err.contains(yocto), "{err}");
    let err = w
        .call(CAROL, NO_DEPOSIT, |c| {
            c.lp_withdraw(s, U128(1), vec![], vec![])
        })
        .unwrap_err();
    assert!(err.contains(yocto), "{err}");
    let err = w
        .call(CAROL, NO_DEPOSIT, |c| c.lp_transfer(s, acc(BOB), U128(1)))
        .unwrap_err();
    assert!(err.contains(yocto), "{err}");

    deposit(&mut w, CAROL, s, WNEAR_IN, USDC_IN);
    let liquidity = holdings(&mut w, s)[0].liquidity.0;
    for who in [CONTRACT, CAROL] {
        let err = w
            .call(who, ONE_YOCTO, |c| {
                c.remove_liquidity(pools[0], U128(liquidity), U128(0), U128(0))
            })
            .unwrap_err();
        assert!(
            err.starts_with("InsufficientLiquidity(") && err.ends_with(", 0)"),
            "{err}"
        );
    }
    let carol = acc(CAROL);
    assert!(w.view(|c| c.has_lp_shares(&carol)));
}

#[test]
fn shares_are_transferable() {
    let Fx { mut w, s, .. } = setup();
    let shares = deposit(&mut w, CAROL, s, WNEAR_IN, USDC_IN);
    fails(
        w.call(CAROL, ONE_YOCTO, |c| {
            c.lp_transfer(s, acc("stranger.near"), U128(shares))
        }),
        "NotRegistered(stranger.near)",
    );
    fails(
        w.call(CAROL, ONE_YOCTO, |c| {
            c.lp_transfer(s, acc(DAVE), U128(shares + 1))
        }),
        &format!("InsufficientBalance(carol.near, {shares}, {})", shares + 1),
    );
    w.call(CAROL, ONE_YOCTO, |c| {
        c.lp_transfer(s, acc(DAVE), U128(shares))
    })
    .unwrap();
    assert_eq!(w.last.data_of("lp_transfer").len(), 1);
    let (wnear_out, _) = withdraw(&mut w, DAVE, s, shares);
    assert!(wnear_out > 0);
    let view = w.view(|c| c.root_lp_shares_of(s, acc(CAROL)));
    assert_eq!((view.balance.0, view.supply.0), (0, MINIMUM_SHARES));
    let carol = acc(CAROL);
    assert!(!w.view(|c| c.has_lp_shares(&carol)));
    assert_accounted(&mut w);
}

#[test]
fn root_lp_view_for_the_lend_screen() {
    let Fx { mut w, s, .. } = setup();
    let carol = acc(CAROL);
    let empty = w.view(|c| c.root_lp_view(s, Some(&carol))).unwrap();
    assert_eq!((empty.share_supply.0, empty.your_shares.0), (0, 0));
    assert_eq!(empty.share_decimals, 18);
    assert_eq!(empty.preview_withdraw, None);
    assert_eq!(empty.holdings.len(), 4);
    assert_eq!(w.view(|c| c.root_lp_view(99, None)), None);

    let shares = deposit(&mut w, CAROL, s, WNEAR_IN, USDC_IN);
    let v = w.view(|c| c.root_lp_view(s, Some(&carol))).unwrap();
    assert_eq!(v.your_shares.0, shares);
    assert_eq!(v.share_supply.0, shares + MINIMUM_SHARES);
    assert_eq!(v.preview_withdraw, Some(claim(&mut w, s, shares)));
    assert_eq!(v.holdings, holdings(&mut w, s));
    let anyone = w.view(|c| c.root_lp_view(s, None)).unwrap();
    assert_eq!((anyone.your_shares.0, anyone.preview_withdraw), (0, None));
}

fn quick() -> Config {
    Config {
        cases: 256,
        failure_persistence: None,
        ..Config::default()
    }
}

/// Whole USDC token units, so the wallet can pay them.
fn whole_usdc(x: u128) -> u128 {
    x / scale(Usdc) * scale(Usdc)
}

proptest! {
    #![proptest_config(quick())]

    #[test]
    fn fuzz_deposit_withdraw_round_trip(
        wnear in 1_000_000_000u128..=1_000_000_000 * E18,
        usdc in 1_000_000_000_000u128..=1_000_000_000_000 * E18,
    ) {
        let Fx { mut w, s, .. } = setup();
        let usdc = whole_usdc(usdc);
        let preview = preview_deposit(&mut w, s, wnear, usdc);
        let shares = deposit(&mut w, CAROL, s, wnear, usdc);
        let total = supply(&mut w, s);
        withdraw(&mut w, CAROL, s, shares);
        for i in 0..4 {
            for (asset, slack) in [(Wnear, 4), (Usdc, 200)] {
                let held = held_in(&mut w, CAROL, s, i, asset);
                let floor = FUND - kept(&preview, asset, i) * MINIMUM_SHARES / total - slack;
                prop_assert!(held <= FUND, "world {} {}", i, asset);
                prop_assert!(held >= floor, "world {} {}: {} < {}", i, asset, held, floor);
            }
        }
        assert_accounted(&mut w);
    }

    #[test]
    fn fuzz_join_after_trade(
        wnear in 1_000_000_000_000u128..=1_000_000 * E18,
        usdc in 1_000_000_000_000u128..=10_000_000_000 * E18,
        sale in 1_000_000_000_000_000u128..=20 * E18,
        mask in 1u8..=15,
    ) {
        let Fx { mut w, s, pools, .. } = setup();
        let usdc = whole_usdc(usdc);
        let carol = deposit(&mut w, CAROL, s, WNEAR_IN, USDC_IN);
        alice_sells(&mut w, s, &pools, mask, sale);
        let before = claim(&mut w, s, carol);
        let preview = preview_deposit(&mut w, s, wnear, usdc);
        let dave = deposit(&mut w, DAVE, s, wnear, usdc);
        prop_assert_eq!(dave, preview.shares.0);
        let after = claim(&mut w, s, carol);
        let theirs = claim(&mut w, s, dave);
        for i in 0..4 {
            for (asset, amount) in [(Wnear, wnear), (Usdc, usdc)] {
                let k = kept(&preview, asset, i);
                prop_assert!(k <= amount);
                prop_assert!(amt(&after, asset, i) >= amt(&before, asset, i));
                prop_assert!(amt(&theirs, asset, i) <= k);
            }
        }
        assert_accounted(&mut w);
    }

    #[test]
    fn fuzz_full_resolution_any_order(
        sale in 1_000_000_000_000_000u128..=20 * E18,
        mask in 1u8..=15,
        spice in 0u8..=1,
        fed in 0u8..=1,
        fed_first: bool,
    ) {
        let Fx { mut w, s, pools, .. } = setup();
        let shares = deposit(&mut w, CAROL, s, WNEAR_IN, USDC_IN);
        alice_sells(&mut w, s, &pools, mask, sale);
        let (first, second) = if fed_first {
            ((w.fed, fed), (w.spice, spice))
        } else {
            ((w.spice, spice), (w.fed, fed))
        };
        w.admin_resolve(first.0, first.1).unwrap();
        w.admin_resolve(second.0, second.1).unwrap();
        let survivor = usize::from(spice + 2 * fed);
        prop_assert_eq!(w.possible(s), 1u8 << survivor);
        let preview = claim(&mut w, s, shares);
        let tokens: Vec<u128> = (0..4)
            .flat_map(|i| [w.bal(CAROL, s, Wnear, 1 << i), w.bal(CAROL, s, Usdc, 1 << i)])
            .collect();
        let out = withdraw(&mut w, CAROL, s, shares);
        prop_assert_eq!(out, (preview.wnear[survivor].0, preview.usdc[survivor].0));
        let now: Vec<u128> = (0..4)
            .flat_map(|i| [w.bal(CAROL, s, Wnear, 1 << i), w.bal(CAROL, s, Usdc, 1 << i)])
            .collect();
        prop_assert_eq!(tokens, now);
        assert_accounted(&mut w);
        assert_backed(&mut w, s);
    }
}
