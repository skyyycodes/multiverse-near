//! Operations: the pause matrix (every entry point under every flag, OPS-3),
//! guardian and owner rights, the liquidation grace, the two-step owner
//! transfer, `upgrade_accounts`, the version and pause views, `post_upgrade`
//! on a fresh deployment, the books views (OPS-1) and the NEAR books (M-13,
//! `near_books_matches_enumeration`).
//!
//! `books_hold` is the books assertion the random-op campaigns run after
//! every action (`invariants.rs`); other packages' campaigns can call it too.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use near_sdk::json_types::{U128, U64};
use near_sdk::mock::with_mocked_blockchain;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{env, AccountId, MockedBlockchain, NearToken, PromiseResult, RuntimeFeesConfig};
use proptest::prelude::*;
use proptest::test_runner::{Config, TestCaseError, TestRunner};

use super::amm::{give_world_tokens, pool_world, seed_demo_2x2, seed_spot};
use super::harness::*;
use super::lending::{clear_prices, price_2x2, price_bin, Lend};
use super::orders::give;
use crate::books::{BooksView, BOOKS_MAX_LIMIT};
use crate::lending::tiers::{MarketId, Tier};
use crate::lending::LiquidationState;
use crate::ops::{PauseFlag, LIQUIDATION_GRACE_SEC, MAX_LIQUIDATION_GRACE_SEC};
use crate::orders::Side;
use crate::types::Asset::{self, Usdc, Wnear};
use crate::version::{CODE_VERSION, STATE_VERSION};

const BYTE: u128 = 10_000_000_000_000_000_000; // 1e19 yoctoNEAR
const GUARDIAN: &str = "guardian.near";
const ERIN: &str = "erin.near";
const DAVE: &str = "dave.near";

fn paused(flag: PauseFlag) -> String {
    format!("Paused({})", flag.name())
}

fn pause(w: &mut World, who: &str, flags: &[PauseFlag]) -> Result<(), String> {
    let flags = flags.to_vec();
    w.call(who, NO_DEPOSIT, |c| c.pause(flags, String::new()))
}

fn unpause(w: &mut World, flags: &[PauseFlag], grace: Option<u64>) -> Result<(), String> {
    let flags = flags.to_vec();
    w.call(OWNER, ONE_YOCTO, |c| c.unpause(flags, grace))
}

// ---- Snapshots of the test chain ----

type Storage = HashMap<Vec<u8>, Vec<u8>>;

thread_local! {
    static CHAIN: Box<dyn Fn(Storage) -> MockedBlockchain> = {
        let config = near_sdk::test_vm_config();
        let fees = RuntimeFeesConfig::test();
        Box::new(move |storage| {
            let context = VMContextBuilder::new().build();
            MockedBlockchain::new(context, config.clone(), fees.clone(), vec![], storage, HashMap::new(), None)
        })
    };
}

/// The chain and the token ledgers at one moment.
struct Snapshot {
    storage: Storage,
    now: u64,
    wallets: HashMap<(AccountId, Asset), u128>,
    contract_ft: HashMap<Asset, u128>,
    ft_unregistered: HashSet<AccountId>,
}

fn install(storage: Storage) {
    let chain = CHAIN.with(|make| make(storage));
    env::set_blockchain_interface(chain);
}

fn snapshot(w: &World) -> Snapshot {
    let storage = with_mocked_blockchain(|b| b.take_storage());
    install(storage.clone());
    Snapshot {
        storage,
        now: w.now,
        wallets: w.wallets.clone(),
        contract_ft: w.contract_ft.clone(),
        ft_unregistered: w.ft_unregistered.clone(),
    }
}

fn restore(w: &mut World, s: &Snapshot) {
    install(s.storage.clone());
    w.now = s.now;
    w.wallets = s.wallets.clone();
    w.contract_ft = s.contract_ft.clone();
    w.ft_unregistered = s.ft_unregistered.clone();
}

// ---- The books assertion (OPS-1, M-13) ----

/// Every page of the `books` view, from scenario 1 on.
fn books_pages(w: &mut World, limit: Option<u32>) -> Vec<BooksView> {
    let mut pages = Vec::new();
    let mut from = None;
    loop {
        let page = w.view(|c| c.books(from, limit));
        from = page.next_scenario;
        pages.push(page);
        if from.is_none() {
            return pages;
        }
    }
}

/// OPS-1 and M-13 after an action: the `books` pages sum, per token, to
/// exactly what the contract holds (internal units); the running totals equal
/// their enumeration over `accounts` and the contract itself (pass every
/// account that can hold anything); the NEAR books equal the NEP-145 records
/// and `own_free` is never negative.
pub fn books_hold(w: &mut World, accounts: &[&str]) -> Result<(), String> {
    let pages = books_pages(w, Some(BOOKS_MAX_LIMIT));
    let mut accounts: Vec<AccountId> = accounts.iter().map(|a| acc(a)).collect();
    accounts.push(acc(CONTRACT));
    for (i, asset) in Asset::ALL.into_iter().enumerate() {
        let total: u128 = pages
            .iter()
            .map(|p| {
                if i == 0 {
                    p.wnear.total.0
                } else {
                    p.usdc.total.0
                }
            })
            .sum();
        let held = w.held_raw(asset);
        let (raw, dust) = w.cfg[i].to_raw(total).ok_or("books total overflows")?;
        if (raw, dust) != (held, 0) {
            return Err(format!(
                "books: {asset} total {total} = {raw} raw + {dust}, the contract holds {held}"
            ));
        }
    }
    let err = w.view(|c| -> Option<String> {
        let mut internal = [0u128; 2];
        let mut collateral = [0u128; 2];
        let (mut deposit, mut used) = (0u128, 0u64);
        for a in &accounts {
            for asset in Asset::ALL {
                internal[asset as usize] += c.real_balance(a, asset);
            }
            for sid in 1..=c.scenario_count {
                for tier in Tier::ALL {
                    let key = MarketId::new(sid, Some(tier)).key();
                    if let Some(pieces) = c.collateral.get(&(key, a.clone())) {
                        let real = crate::books::real_amounts(pieces);
                        collateral[0] += real[0];
                        collateral[1] += real[1];
                    }
                }
            }
            if let Some(r) = c.storage.get(a) {
                deposit += r.deposit.as_yoctonear();
                used += r.used_bytes;
            }
        }
        let b = &c.books;
        if b.internal != internal {
            return Some(format!("books.internal {:?} != {internal:?}", b.internal));
        }
        if b.collateral != collateral {
            return Some(format!(
                "books.collateral {:?} != {collateral:?}",
                b.collateral
            ));
        }
        if (b.nep145_deposit, b.nep145_used_bytes) != (deposit, used) {
            return Some(format!(
                "books NEP-145 ({}, {}) != ({deposit}, {used})",
                b.nep145_deposit, b.nep145_used_bytes
            ));
        }
        let near = c.near_books();
        let own_free: i128 = near.own_free.parse().unwrap();
        if own_free < 0 {
            return Some(format!("own_free {own_free} < 0"));
        }
        None
    });
    err.map_or(Ok(()), Err)
}

// ---- The pause matrix ----

/// Ids the matrix rows use.
#[derive(Clone)]
struct Ids {
    s: u64,
    b: u64,
    pools: Vec<u64>,
    order: u64,
    fed: u64,
    spice: u64,
}

/// A row: an entry point, the flags that stop it (empty: never paused) and
/// the call. The outcome is the call's return value (Debug) or error, plus
/// its logs.
struct Row {
    name: &'static str,
    flags: &'static [PauseFlag],
    run: fn(&mut World, &Ids) -> Result<String, String>,
}

fn dbg<R: std::fmt::Debug>(r: Result<R, String>) -> Result<String, String> {
    r.map(|v| format!("{v:?}"))
}

fn unit<R>(r: Result<R, String>) -> Result<String, String> {
    r.map(|_| "()".to_string())
}

fn ft(w: &mut World, who: &str, asset: Asset, raw: u128, msg: Value) -> Result<String, String> {
    dbg(w.ft_transfer_call(who, asset, raw, &msg.to_string()))
}

/// The matrix fixture: the 2x2 pools and the spot pool, bob lending in the
/// 2x2 market, alice with world tokens, real balances, a loan and a pool
/// position, carol with collateral and no debt, bob's open bid, and erin
/// registered with nothing.
fn matrix_world() -> (World, Ids) {
    clear_prices();
    let mut w = pool_world();
    let (s, b) = (w.s2x2, w.s_bin);
    let pools = seed_demo_2x2(&mut w);
    seed_spot(&mut w, 3_000 * E15, 10_000 * E18);
    price_2x2(s);
    price_bin(b);
    w.warp(61);
    w.lend(BOB, s, 100_000 * E18).unwrap();
    give_world_tokens(&mut w, ALICE, s, 1_000 * E18, 4_000 * E18);
    w.deposit(ALICE, Usdc, 1_000 * E18).unwrap();
    w.deposit(ALICE, Wnear, 1_000 * E18).unwrap();
    w.post(ALICE, s, "usdc", 500 * E18).unwrap();
    w.borrow(ALICE, s, 100 * E18).unwrap();
    w.call(ALICE, ONE_YOCTO, |c| {
        c.add_liquidity(pools[0], U128(10 * E18), U128(37 * E18), U128(0))
    })
    .unwrap();
    w.deposit(CAROL, Usdc, 100 * E18).unwrap();
    w.post(CAROL, b, "usdc", 50 * E18).unwrap();
    give(&mut w, BOB, s, Usdc, SHIPS_CUTS, 100 * E18);
    let expiry = w.now + DAY;
    let order = w
        .call(BOB, ONE_YOCTO, |c| {
            c.post_order(
                s,
                SHIPS_CUTS,
                Side::Bid,
                U128(3_000 * E15),
                U128(10 * E18),
                expiry,
            )
            .0
        })
        .unwrap();
    w.register(ERIN, NearToken::from_near(1));
    // the owner's tokens for moving the spot pool and opening pools; alice's
    // Root LP shares; bob proposed as the next owner
    w.fund(OWNER);
    w.deposit(OWNER, Wnear, 1_000 * E18).unwrap();
    w.deposit(OWNER, Usdc, 4_000 * E18).unwrap();
    give_world_tokens(&mut w, OWNER, b, 10 * E18, 40 * E18);
    give_world_tokens(&mut w, OWNER, s, 0, 40 * E18);
    w.call(ALICE, ONE_YOCTO, |c| {
        c.lp_deposit(s, U128(10 * E18), U128(40 * E18), U128(0))
    })
    .unwrap();
    w.call(OWNER, ONE_YOCTO, |c| c.propose_owner(Some(acc(BOB))))
        .unwrap();
    let ids = Ids {
        s,
        b,
        pools,
        order,
        fed: w.fed,
        spice: w.spice,
    };
    (w, ids)
}

const TRADE: &[PauseFlag] = &[PauseFlag::Trade];
const TRADE_LEND: &[PauseFlag] = &[PauseFlag::Trade, PauseFlag::Lend];
const MINT: &[PauseFlag] = &[PauseFlag::Mint];
const TRANSFER: &[PauseFlag] = &[PauseFlag::Transfer];
const LEND: &[PauseFlag] = &[PauseFlag::Lend];
const LIQUIDATE: &[PauseFlag] = &[PauseFlag::Liquidate];
const LIQUIDATE_TRADE: &[PauseFlag] = &[PauseFlag::Liquidate, PauseFlag::Trade];
const ORACLE: &[PauseFlag] = &[PauseFlag::Oracle];
const PLEDGE: &[PauseFlag] = &[PauseFlag::Pledge];
const EXIT: &[PauseFlag] = &[PauseFlag::Exit];
const NEVER: &[PauseFlag] = &[];

fn sc(w: &World) -> String {
    token_id(w.s2x2, Wnear, SHIPS_CUTS)
}

fn rows() -> Vec<Row> {
    vec![
        // trade
        Row {
            name: "swap",
            flags: TRADE,
            run: |w, i| {
                let p = i.pools[1];
                dbg(w.call(ALICE, ONE_YOCTO, |c| c.swap(p, true, U128(E18), U128(0))))
            },
        },
        Row {
            name: "conditional_sell",
            flags: TRADE,
            run: |w, i| {
                let s = i.s;
                dbg(w.call(ALICE, ONE_YOCTO, |c| {
                    c.conditional_sell(
                        s,
                        U128(E18),
                        SHIPS_CUTS,
                        vec![vec![]; 4],
                        vec![U128(0); 4],
                        false,
                        None,
                    )
                }))
            },
        },
        Row {
            name: "conditional_sell to lending",
            flags: TRADE_LEND,
            run: |w, i| {
                let s = i.s;
                dbg(w.call(ALICE, ONE_YOCTO, |c| {
                    c.conditional_sell(
                        s,
                        U128(E18),
                        SHIPS_CUTS,
                        vec![vec![]; 4],
                        vec![U128(0); 4],
                        true,
                        None,
                    )
                }))
            },
        },
        Row {
            name: "conditional_buy",
            flags: TRADE,
            run: |w, i| {
                let s = i.s;
                dbg(w.call(ALICE, ONE_YOCTO, |c| {
                    c.conditional_buy(
                        s,
                        U128(E18),
                        SHIPS_CUTS,
                        vec![vec![]; 4],
                        vec![U128(0); 4],
                        false,
                        None,
                    )
                }))
            },
        },
        Row {
            name: "conditional_buy to lending",
            flags: TRADE_LEND,
            run: |w, i| {
                let s = i.s;
                dbg(w.call(ALICE, ONE_YOCTO, |c| {
                    c.conditional_buy(
                        s,
                        U128(E18),
                        SHIPS_CUTS,
                        vec![vec![]; 4],
                        vec![U128(0); 4],
                        true,
                        None,
                    )
                }))
            },
        },
        Row {
            name: "post_order",
            flags: TRADE,
            run: |w, i| {
                let (s, expiry) = (i.s, w.now + DAY);
                dbg(w.call(ALICE, ONE_YOCTO, |c| {
                    c.post_order(
                        s,
                        SHIPS_CUTS,
                        Side::Ask,
                        U128(3_900 * E15),
                        U128(E18),
                        expiry,
                    )
                }))
            },
        },
        Row {
            name: "fill_order",
            flags: TRADE,
            run: |w, i| {
                let o = i.order;
                dbg(w.call(ALICE, ONE_YOCTO, |c| {
                    c.fill_order(U64(o), U128(E18), U128(0))
                }))
            },
        },
        Row {
            name: "move_spot_to",
            flags: TRADE,
            run: |w, _| dbg(w.call(OWNER, ONE_YOCTO, |c| c.move_spot_to(U128(3_100 * E15)))),
        },
        Row {
            name: "spot_swap msg",
            flags: TRADE,
            run: |w, _| {
                ft(
                    w,
                    ALICE,
                    Usdc,
                    1_000_000,
                    json!({"action": "spot_swap", "min_out": "0"}),
                )
            },
        },
        Row {
            name: "post_order msg",
            flags: TRADE,
            run: |w, i| {
                let msg = json!({"action": "post_order", "scenario_id": i.s, "mask": SHIPS_CUTS, "side": "bid",
                             "price": (3_000 * E15).to_string(), "amount": E18.to_string(), "expiry_sec": w.now + DAY});
                ft(w, ALICE, Usdc, 5_000_000, msg)
            },
        },
        Row {
            name: "conditional_sell msg",
            flags: TRADE,
            run: |w, i| {
                let msg = json!({"action": "conditional_sell", "scenario_id": i.s, "sell_mask": SHIPS_CUTS,
                             "plans": [[], [], [], []], "min_out": ["0", "0", "0", "0"], "to_lending": false});
                ft(w, ALICE, Wnear, E18, msg)
            },
        },
        Row {
            name: "conditional_buy msg to lending",
            flags: TRADE_LEND,
            run: |w, i| {
                let msg = json!({"action": "conditional_buy", "scenario_id": i.s, "buy_mask": SHIPS_CUTS,
                             "plans": [[], [], [], []], "min_out": ["0", "0", "0", "0"], "to_lending": true});
                ft(w, ALICE, Usdc, 1_000_000, msg)
            },
        },
        Row {
            name: "sell_and_borrow msg",
            flags: TRADE_LEND,
            run: |w, i| {
                let msg = json!({"action": "sell_and_borrow", "scenario_id": i.s, "sell_mask": L_SHAPE,
                             "plans": [[], [], [], []], "min_out": ["0", "0", "0", "0"], "borrow_amount": E18.to_string()});
                ft(w, ALICE, Wnear, E18, msg)
            },
        },
        // mint
        Row {
            name: "split",
            flags: MINT,
            run: |w, i| unit(w.split(ALICE, i.s, Wnear, ROOT, &[SHIPS, DELAYED], E18)),
        },
        Row {
            name: "split msg",
            flags: MINT,
            run: |w, i| {
                ft(
                    w,
                    ALICE,
                    Wnear,
                    E18,
                    json!({"action": "split", "scenario_id": i.s, "to_masks": [SHIPS, DELAYED]}),
                )
            },
        },
        Row {
            name: "register_verse",
            flags: MINT,
            run: |w, i| {
                let s = i.s;
                dbg(w.call(ALICE, NO_DEPOSIT, |c| c.register_verse(s, Usdc, L_SHAPE)))
            },
        },
        Row {
            name: "create_event",
            flags: MINT,
            run: |w, _| {
                let deadline = w.now + 30 * DAY;
                dbg(w.create_event(
                    "Will it rain?",
                    &["YES", "NO"],
                    "YES iff it rains.",
                    deadline,
                ))
            },
        },
        Row {
            name: "create_scenario",
            flags: MINT,
            run: |w, i| dbg(w.create_scenario(&[i.fed])),
        },
        Row {
            name: "create_within_pool",
            flags: MINT,
            run: |w, i| {
                let b = i.b;
                dbg(w.call(OWNER, ONE_YOCTO, |c| {
                    c.create_within_pool(b, 0, U128(E18), U128(3 * E18))
                }))
            },
        },
        Row {
            name: "create_between_pool",
            flags: MINT,
            run: |w, i| {
                let s = i.s;
                dbg(w.call(OWNER, ONE_YOCTO, |c| {
                    c.create_between_pool(s, SHIPS_CUTS, DELAYED_CUTS, U128(E18), U128(E18))
                }))
            },
        },
        Row {
            name: "create_spot_pool",
            flags: MINT,
            run: |w, _| {
                dbg(w.call(OWNER, ONE_YOCTO, |c| {
                    c.create_spot_pool(U128(E18), U128(E18))
                }))
            },
        },
        Row {
            name: "add_liquidity",
            flags: MINT,
            run: |w, i| {
                let p = i.pools[1];
                dbg(w.call(ALICE, ONE_YOCTO, |c| {
                    c.add_liquidity(p, U128(E18), U128(3 * E18), U128(0))
                }))
            },
        },
        Row {
            name: "lp_deposit",
            flags: MINT,
            run: |w, i| {
                let s = i.s;
                dbg(w.call(ALICE, ONE_YOCTO, |c| {
                    c.lp_deposit(s, U128(E18), U128(E18), U128(0))
                }))
            },
        },
        Row {
            name: "lp_deposit msg",
            flags: MINT,
            run: |w, i| {
                let msg = json!({"action": "lp_deposit", "scenario_id": i.s, "wnear_amount": E18.to_string(), "min_shares": "0"});
                ft(w, ALICE, Usdc, 5_000_000, msg)
            },
        },
        // transfer
        Row {
            name: "mt_transfer",
            flags: TRANSFER,
            run: |w, _| {
                let t = sc(w);
                unit(w.mt_transfer(ALICE, BOB, &t, E18))
            },
        },
        Row {
            name: "mt_batch_transfer",
            flags: TRANSFER,
            run: |w, _| {
                let t = sc(w);
                unit(w.mt_batch_transfer(ALICE, BOB, &[t], &[E18]))
            },
        },
        Row {
            name: "mt_transfer_call",
            flags: TRANSFER,
            run: |w, _| {
                let t = sc(w);
                unit(w.call(ALICE, ONE_YOCTO, |c| {
                    c.mt_transfer_call(acc(BOB), t, U128(E18), None, None, String::new())
                }))
            },
        },
        Row {
            name: "mt_batch_transfer_call",
            flags: TRANSFER,
            run: |w, _| {
                let t = sc(w);
                unit(w.call(ALICE, ONE_YOCTO, |c| {
                    c.mt_batch_transfer_call(
                        acc(BOB),
                        vec![t],
                        vec![U128(E18)],
                        None,
                        None,
                        String::new(),
                    )
                }))
            },
        },
        Row {
            name: "lp_transfer",
            flags: TRANSFER,
            run: |w, i| {
                let s = i.s;
                unit(w.call(ALICE, ONE_YOCTO, |c| c.lp_transfer(s, acc(BOB), U128(1))))
            },
        },
        // lend
        Row {
            name: "borrow",
            flags: LEND,
            run: |w, i| unit(w.borrow(ALICE, i.s, 10 * E18)),
        },
        Row {
            name: "withdraw_collateral with debt",
            flags: LEND,
            run: |w, i| unit(w.unpost(ALICE, i.s, "usdc", E18)),
        },
        Row {
            name: "supply msg",
            flags: LEND,
            run: |w, i| {
                ft(
                    w,
                    CAROL,
                    Usdc,
                    1_000_000,
                    json!({"action": "supply", "scenario_id": i.s}),
                )
            },
        },
        // liquidate
        Row {
            name: "liquidate msg",
            flags: LIQUIDATE,
            run: |w, i| {
                let msg = json!({"action": "liquidate", "scenario_id": i.s, "account_id": ALICE, "repay_amount": "max"});
                ft(w, BOB, Usdc, 1_000_000, msg)
            },
        },
        Row {
            name: "liquidate msg for cash",
            flags: LIQUIDATE_TRADE,
            run: |w, i| {
                let msg = json!({"action": "liquidate", "scenario_id": i.s, "account_id": ALICE, "repay_amount": "max",
                             "receive": "cash", "min_out": "1"});
                ft(w, BOB, Usdc, 1_000_000, msg)
            },
        },
        // oracle
        Row {
            name: "report_outcome",
            flags: ORACLE,
            run: |w, i| unit(w.report(i.fed, 0)),
        },
        Row {
            name: "finalize",
            flags: ORACLE,
            run: |w, i| unit(w.finalize(ALICE, i.spice)),
        },
        Row {
            name: "request_resolution",
            flags: ORACLE,
            run: |w, i| {
                let fed = i.fed;
                unit(w.call(ALICE, NearToken::from_near(1), |c| {
                    c.request_resolution(fed)
                }))
            },
        },
        // pledge
        Row {
            name: "pledge msg",
            flags: PLEDGE,
            run: |w, _| {
                ft(
                    w,
                    ALICE,
                    Usdc,
                    1_000_000,
                    json!({"action": "pledge", "proposal_id": 1}),
                )
            },
        },
        // exit
        Row {
            name: "withdraw",
            flags: EXIT,
            run: |w, _| unit(w.withdraw(ALICE, Usdc, E18)),
        },
        Row {
            name: "withdraw_supply",
            flags: EXIT,
            run: |w, i| {
                let s = i.s;
                dbg(w.call(BOB, ONE_YOCTO, |c| {
                    c.withdraw_supply(s, Some(U128(E18)), None)
                }))
            },
        },
        Row {
            name: "withdraw_collateral without debt",
            flags: EXIT,
            run: |w, i| unit(w.unpost(CAROL, i.b, "usdc", E18)),
        },
        Row {
            name: "cancel_order",
            flags: EXIT,
            run: |w, i| {
                let o = i.order;
                dbg(w.call(BOB, ONE_YOCTO, |c| c.cancel_order(U64(o))))
            },
        },
        Row {
            name: "merge",
            flags: EXIT,
            run: |w, i| unit(w.merge(ALICE, i.s, Wnear, &SINGLES, ROOT, E18)),
        },
        Row {
            name: "redeem",
            flags: EXIT,
            run: |w, i| unit(w.redeem(ALICE, i.s, Wnear, SHIPS_CUTS, E18)),
        },
        Row {
            name: "close_after_resolution",
            flags: EXIT,
            run: |w, i| {
                let s = i.s;
                dbg(w.call(ALICE, ONE_YOCTO, |c| c.close_after_resolution(s, None)))
            },
        },
        Row {
            name: "close_after_resolution msg",
            flags: EXIT,
            run: |w, i| {
                ft(
                    w,
                    ALICE,
                    Usdc,
                    1_000_000,
                    json!({"action": "close_after_resolution", "scenario_id": i.s}),
                )
            },
        },
        Row {
            name: "lp_withdraw",
            flags: EXIT,
            run: |w, i| {
                // two payouts in one call: the harness cannot run them in order
                let s = i.s;
                w.auto_payouts = false;
                let r = dbg(w.call(ALICE, ONE_YOCTO, |c| {
                    c.lp_withdraw(s, U128(E18), vec![U128(0); 4], vec![U128(0); 4])
                }));
                w.auto_payouts = true;
                r
            },
        },
        Row {
            name: "remove_liquidity",
            flags: EXIT,
            run: |w, i| {
                let p = i.pools[0];
                dbg(w.call(ALICE, ONE_YOCTO, |c| {
                    c.remove_liquidity(p, U128(E18), U128(0), U128(0))
                }))
            },
        },
        Row {
            name: "collect_fees",
            flags: EXIT,
            run: |w, i| {
                let p = i.pools[0];
                dbg(w.call(ALICE, ONE_YOCTO, |c| c.collect_fees(p)))
            },
        },
        Row {
            name: "storage_withdraw",
            flags: EXIT,
            run: |w, _| dbg(w.call(ALICE, ONE_YOCTO, |c| c.storage_withdraw(Some(U128(BYTE))))),
        },
        Row {
            name: "storage_unregister",
            flags: EXIT,
            run: |w, _| dbg(w.call(ERIN, ONE_YOCTO, |c| c.storage_unregister(None))),
        },
        // never paused
        Row {
            name: "deposit msg",
            flags: NEVER,
            run: |w, _| dbg(w.ft_transfer_call(ALICE, Usdc, 1_000_000, "")),
        },
        Row {
            name: "repay msg",
            flags: NEVER,
            run: |w, i| {
                ft(
                    w,
                    ALICE,
                    Usdc,
                    1_000_000,
                    json!({"action": "repay", "scenario_id": i.s, "all": false}),
                )
            },
        },
        Row {
            name: "deposit_collateral msg",
            flags: NEVER,
            run: |w, i| {
                ft(
                    w,
                    ALICE,
                    Usdc,
                    1_000_000,
                    json!({"action": "deposit_collateral", "scenario_id": i.s}),
                )
            },
        },
        Row {
            name: "fund_insurance msg",
            flags: NEVER,
            run: |w, i| {
                ft(
                    w,
                    ALICE,
                    Usdc,
                    1_000_000,
                    json!({"action": "fund_insurance", "scenario_id": i.s}),
                )
            },
        },
        Row {
            name: "repay_from_balance",
            flags: NEVER,
            run: |w, i| {
                let s = i.s;
                dbg(w.call(ALICE, ONE_YOCTO, |c| {
                    c.repay_from_balance(s, Some(U128(E18)), None)
                }))
            },
        },
        Row {
            name: "deposit_collateral",
            flags: NEVER,
            run: |w, i| unit(w.post(ALICE, i.s, "usdc", E18)),
        },
        Row {
            name: "storage_deposit",
            flags: NEVER,
            run: |w, _| {
                dbg(w.call(DAVE, NearToken::from_millinear(200), |c| {
                    c.storage_deposit(None, None)
                }))
            },
        },
        Row {
            name: "dispute",
            flags: NEVER,
            run: |w, i| unit(w.dispute(i.fed)),
        },
        Row {
            name: "admin_resolve",
            flags: NEVER,
            run: |w, i| unit(w.admin_resolve(i.fed, 0)),
        },
        Row {
            name: "set_reporter",
            flags: NEVER,
            run: |w, _| unit(w.call(OWNER, ONE_YOCTO, |c| c.set_reporter(Some(acc(BOB))))),
        },
        Row {
            name: "set_dispute_window",
            flags: NEVER,
            run: |w, _| unit(w.call(OWNER, ONE_YOCTO, |c| c.set_dispute_window(45))),
        },
        Row {
            name: "set_demo_record",
            flags: NEVER,
            run: |w, _| {
                unit(w.call(OWNER, ONE_YOCTO, |c| {
                    c.set_demo_record(r#"{"a":1}"#.to_string())
                }))
            },
        },
        Row {
            name: "set_outlayer_config",
            flags: NEVER,
            run: |w, _| {
                unit(w.call(OWNER, ONE_YOCTO, |c| {
                    c.set_outlayer_config(
                        "https://x.example/g.wasm".into(),
                        "00".repeat(32),
                        None,
                        None,
                        None,
                    )
                }))
            },
        },
        Row {
            name: "set_outlayer_dates",
            flags: NEVER,
            run: |w, i| {
                let fed = i.fed;
                unit(w.call(OWNER, ONE_YOCTO, |c| {
                    c.set_outlayer_dates(fed, "2026-12-08".into(), "2026-12-10".into())
                }))
            },
        },
        Row {
            name: "pause",
            flags: NEVER,
            run: |w, _| unit(pause(w, OWNER, &[PauseFlag::Pledge])),
        },
        Row {
            name: "unpause",
            flags: NEVER,
            run: |w, _| unit(unpause(w, &[PauseFlag::Pledge], None)),
        },
        Row {
            name: "set_guardian",
            flags: NEVER,
            run: |w, _| unit(w.call(OWNER, ONE_YOCTO, |c| c.set_guardian(Some(acc(GUARDIAN))))),
        },
        Row {
            name: "propose_owner",
            flags: NEVER,
            run: |w, _| unit(w.call(OWNER, ONE_YOCTO, |c| c.propose_owner(Some(acc(BOB))))),
        },
        Row {
            name: "accept_owner",
            flags: NEVER,
            run: |w, _| unit(w.call(BOB, ONE_YOCTO, |c| c.accept_owner())),
        },
        Row {
            name: "upgrade_accounts",
            flags: NEVER,
            run: |w, _| {
                dbg(w.call(ALICE, ONE_YOCTO, |c| {
                    c.upgrade_accounts(vec![acc(CAROL), acc("nobody.near")])
                }))
            },
        },
        Row {
            name: "post_upgrade",
            flags: NEVER,
            run: |w, _| unit(w.call(CONTRACT, NO_DEPOSIT, |c| c.post_upgrade(STATE_VERSION))),
        },
        Row {
            name: "on_payout",
            flags: NEVER,
            run: |w, _| {
                dbg(
                    w.exec(CONTRACT, NO_DEPOSIT, vec![PromiseResult::Failed], |c| {
                        c.on_payout(acc(ALICE), Usdc, U128(1_000_000))
                    }),
                )
            },
        },
        Row {
            name: "mt_resolve_transfer",
            flags: NEVER,
            run: |w, _| {
                let t = sc(w);
                dbg(
                    w.exec(CONTRACT, NO_DEPOSIT, vec![PromiseResult::Failed], |c| {
                        c.mt_resolve_transfer(acc(ALICE), acc(BOB), vec![t], vec![U128(E18)], None)
                    }),
                )
            },
        },
        Row {
            name: "on_outlayer_result",
            flags: NEVER,
            run: |w, i| {
                let fed = i.fed;
                dbg(
                    w.exec(CONTRACT, NO_DEPOSIT, vec![PromiseResult::Failed], |c| {
                        c.on_outlayer_result(fed, 1, acc(ALICE), U128(0))
                    }),
                )
            },
        },
        // views
        Row {
            name: "books",
            flags: NEVER,
            run: |w, _| Ok(format!("{:?}", w.view(|c| c.books(None, None)))),
        },
        Row {
            name: "near_books",
            flags: NEVER,
            run: |w, _| Ok(format!("{:?}", w.view(|c| c.near_books()))),
        },
        Row {
            name: "contract_version",
            flags: NEVER,
            run: |w, _| Ok(format!("{:?}", w.view(|c| c.contract_version()))),
        },
        Row {
            name: "borrow_view",
            flags: NEVER,
            run: |w, i| {
                let s = i.s;
                Ok(format!(
                    "{:?}",
                    w.view(|c| c.borrow_view(s, Some(acc(ALICE)), None))
                ))
            },
        },
    ]
}

/// Logs with every `"paused":[..]` list dropped: `contract_upgraded`
/// reports the flags set, which is the one thing a flag changes there.
fn without_pause_list(logs: &[String]) -> Vec<String> {
    logs.iter()
        .map(|l| match l.find("\"paused\":[") {
            Some(i) => {
                let end = i + l[i..].find(']').unwrap();
                format!("{}{}", &l[..i], &l[end + 1..])
            }
            None => l.clone(),
        })
        .collect()
}

/// OPS-3: under any one flag, an entry point that flag stops fails
/// `Paused(<flag>)` before anything else, and every other entry point
/// behaves exactly as with no flag set (same return value or error, same
/// logs). Never-paused entry points behave as unpaused under every flag.
#[test]
fn pause_matrix_every_entry_point_under_every_flag() {
    let (mut w, ids) = matrix_world();
    let base = snapshot(&w);
    let rows = rows();
    let mut stopped = 0;
    for row in &rows {
        restore(&mut w, &base);
        w.last = Outcome::default();
        let expected = (row.run)(&mut w, &ids);
        let expected_logs = w.last.logs.clone();
        if let Err(e) = &expected {
            assert!(
                !e.starts_with("Paused("),
                "{}: {e} with no flag set",
                row.name
            );
        }
        for flag in PauseFlag::ALL {
            restore(&mut w, &base);
            pause(&mut w, OWNER, &[flag]).unwrap();
            w.last = Outcome::default();
            let got = (row.run)(&mut w, &ids);
            if row.flags.contains(&flag) {
                assert_eq!(got, Err(paused(flag)), "{} under {}", row.name, flag.name());
                stopped += 1;
            } else {
                assert_eq!(got, expected, "{} under {}", row.name, flag.name());
                assert_eq!(
                    without_pause_list(&w.last.logs),
                    without_pause_list(&expected_logs),
                    "{} under {}: logs",
                    row.name,
                    flag.name()
                );
            }
        }
    }
    // Every flag stops something; the rows cover SPEC-C 3.2's lists.
    for flag in PauseFlag::ALL {
        assert!(
            rows.iter().any(|r| r.flags.contains(&flag)),
            "no row stopped by {}",
            flag.name()
        );
    }
    assert!(
        rows.len() >= 70 && stopped >= 45,
        "{} rows, {stopped} stops",
        rows.len()
    );
    // The fixture really exercises the success paths of most rows.
    let mut refused = Vec::new();
    for row in &rows {
        restore(&mut w, &base);
        if let Err(e) = (row.run)(&mut w, &ids) {
            refused.push(format!("{}: {e}", row.name));
        }
    }
    println!(
        "pause matrix: {} rows x {} flags, {stopped} stops; {} rows refused unpaused: {refused:#?}",
        rows.len(),
        PauseFlag::ALL.len(),
        refused.len()
    );
    assert!(rows.len() - refused.len() >= 65, "{refused:#?}");
}

/// With every flag set at once, only never-paused entry points go through.
#[test]
fn every_flag_at_once_leaves_only_the_never_paused_paths() {
    let (mut w, ids) = matrix_world();
    let base = snapshot(&w);
    for row in rows() {
        restore(&mut w, &base);
        let expected = (row.run)(&mut w, &ids);
        restore(&mut w, &base);
        pause(&mut w, OWNER, &PauseFlag::ALL).unwrap();
        let got = (row.run)(&mut w, &ids);
        if row.flags.is_empty() {
            assert_eq!(got, expected, "{}", row.name);
        } else {
            let e = got.expect_err(row.name);
            assert!(
                row.flags.iter().any(|f| e == paused(*f)),
                "{}: {e}",
                row.name
            );
        }
    }
}

// ---- Guardian, owner, pause and unpause ----

#[test]
fn pause_rights_owner_guardian_and_strangers() {
    let mut w = World::new();
    fails(
        pause(&mut w, GUARDIAN, &[PauseFlag::Trade]),
        &format!("NotGuardian({GUARDIAN})"),
    );
    fails(
        pause(&mut w, ALICE, &[PauseFlag::Trade]),
        &format!("NotGuardian({ALICE})"),
    );
    w.call(OWNER, ONE_YOCTO, |c| c.set_guardian(Some(acc(GUARDIAN))))
        .unwrap();
    assert_eq!(
        w.last.data_of("guardian_set"),
        vec![json!({"guardian_id": GUARDIAN})]
    );
    // the guardian pauses every flag but exit, with no deposit
    pause(&mut w, GUARDIAN, &[PauseFlag::Trade, PauseFlag::Mint]).unwrap();
    fails(
        pause(&mut w, GUARDIAN, &[PauseFlag::Lend, PauseFlag::Exit]),
        "GuardianCannotPauseExit",
    );
    fails(pause(&mut w, GUARDIAN, &[]), "EmptyPauseFlags");
    // only the owner sets exit, and only the owner unpauses
    pause(&mut w, OWNER, &[PauseFlag::Exit]).unwrap();
    fails(
        w.call(GUARDIAN, ONE_YOCTO, |c| {
            c.unpause(vec![PauseFlag::Trade], None)
        }),
        &format!("NotOwner({GUARDIAN})"),
    );
    assert_eq!(
        w.view(|c| c.pause_state()).paused,
        vec![PauseFlag::Trade, PauseFlag::Mint, PauseFlag::Exit]
    );
    // unpause takes 1 yocto (pause takes none: the guardian's function-call
    // key signs it; near-sdk's wasm wrapper refuses a deposit)
    let err = w
        .call(OWNER, NO_DEPOSIT, |c| {
            c.unpause(vec![PauseFlag::Trade], None)
        })
        .unwrap_err();
    assert!(err.contains("exactly 1 yoctoNEAR"), "{err}");
    fails(unpause(&mut w, &[], None), "EmptyPauseFlags");
    unpause(&mut w, &[PauseFlag::Trade, PauseFlag::Exit], None).unwrap();
    assert_eq!(
        w.last.data_of("unpaused"),
        vec![json!({"flags": ["trade", "exit"], "by": OWNER, "liquidations_resume_at_sec": 0})]
    );
    assert_eq!(w.view(|c| c.pause_state()).paused, vec![PauseFlag::Mint]);
    // removing the guardian removes its rights
    w.call(OWNER, ONE_YOCTO, |c| c.set_guardian(None)).unwrap();
    assert_eq!(
        w.last.data_of("guardian_set"),
        vec![json!({"guardian_id": null})]
    );
    fails(
        pause(&mut w, GUARDIAN, &[PauseFlag::Trade]),
        &format!("NotGuardian({GUARDIAN})"),
    );
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.set_guardian(Some(acc(ALICE)))),
        &format!("NotOwner({ALICE})"),
    );
}

#[test]
fn pause_logs_flags_caller_and_reason_and_stores_no_reason() {
    let mut w = World::new();
    w.warp(500);
    let state = w.view(borsh_state_len);
    let reason = "r".repeat(256);
    let r = reason.clone();
    w.call(OWNER, NO_DEPOSIT, |c| {
        c.pause(
            vec![PauseFlag::Oracle, PauseFlag::Trade, PauseFlag::Oracle],
            r,
        )
    })
    .unwrap();
    // flags are logged once each, in bit order
    assert_eq!(
        w.last.data_of("paused"),
        vec![json!({"flags": ["trade", "oracle"], "by": OWNER, "reason": reason})]
    );
    assert_eq!(w.view(borsh_state_len), state, "the reason is not stored");
    let p = w.view(|c| c.pause_state());
    assert_eq!(p.since_sec, T0 + 500);
    let r = "r".repeat(257);
    fails(
        w.call(OWNER, NO_DEPOSIT, |c| c.pause(vec![PauseFlag::Mint], r)),
        "TextTooLong(reason)",
    );
}

fn borsh_state_len(c: &crate::Contract) -> usize {
    near_sdk::borsh::to_vec(c).unwrap().len()
}

#[test]
fn pause_state_and_contract_version_shapes() {
    let mut w = World::new();
    let p = serde_json::to_value(w.view(|c| c.pause_state())).unwrap();
    assert_eq!(
        p,
        json!({"paused": [], "since_sec": 0, "liquidations_resume_at_sec": 0,
               "guardian_id": null, "pending_owner_id": null})
    );
    let v = serde_json::to_value(w.view(|c| c.contract_version())).unwrap();
    assert_eq!(
        v,
        json!({"code_version": CODE_VERSION, "state_version": 2, "recorded_code_version": CODE_VERSION,
               "upgraded_at_sec": T0, "upgraded_from": "", "event_version": "2.0.0",
               "legacy_scenario_count": 0})
    );
    assert_eq!(CODE_VERSION, "2.0.0");
}

#[test]
fn liquidation_grace_after_unpausing_liquidate() {
    let mut w = World::new();
    let msg =
        r#"{"action":"liquidate","scenario_id":1,"account_id":"bob.near","repay_amount":"max"}"#;
    pause(&mut w, OWNER, &[PauseFlag::Liquidate]).unwrap();
    fails(
        w.ft_transfer_call(ALICE, Usdc, 1_000_000, msg),
        "Paused(liquidate)",
    );
    // the default grace is one TWAP window
    unpause(&mut w, &[PauseFlag::Liquidate], None).unwrap();
    let resume = w.now + LIQUIDATION_GRACE_SEC;
    assert_eq!(
        w.view(|c| c.pause_state()).liquidations_resume_at_sec,
        resume
    );
    assert_eq!(
        w.last.data_of("unpaused")[0]["liquidations_resume_at_sec"],
        resume
    );
    fails(
        w.ft_transfer_call(ALICE, Usdc, 1_000_000, msg),
        &format!("LiquidationGrace({resume})"),
    );
    w.warp(LIQUIDATION_GRACE_SEC - 1);
    fails(
        w.ft_transfer_call(ALICE, Usdc, 1_000_000, msg),
        &format!("LiquidationGrace({resume})"),
    );
    w.warp(1);
    fails(
        w.ft_transfer_call(ALICE, Usdc, 1_000_000, msg),
        "NotLiquidatable(340282366920938463463374607431768211455)",
    );
    // the grace is capped at a day; Some(0) ends a running grace at once
    pause(&mut w, OWNER, &[PauseFlag::Liquidate]).unwrap();
    unpause(&mut w, &[PauseFlag::Liquidate], Some(10 * DAY)).unwrap();
    assert_eq!(
        w.view(|c| c.pause_state()).liquidations_resume_at_sec,
        w.now + MAX_LIQUIDATION_GRACE_SEC
    );
    unpause(&mut w, &[PauseFlag::Liquidate], Some(0)).unwrap();
    assert_eq!(
        w.view(|c| c.pause_state()).liquidations_resume_at_sec,
        w.now
    );
    fails(
        w.ft_transfer_call(ALICE, Usdc, 1_000_000, msg),
        "NotLiquidatable(340282366920938463463374607431768211455)",
    );
    // unpausing other flags leaves the grace alone
    unpause(&mut w, &[PauseFlag::Trade], Some(DAY)).unwrap();
    assert_eq!(
        w.view(|c| c.pause_state()).liquidations_resume_at_sec,
        w.now
    );
}

#[test]
fn liquidation_status_reads_paused_while_the_flag_or_the_grace_holds() {
    clear_prices();
    let mut w = World::new();
    let s = w.s2x2;
    price_2x2(s);
    w.warp(61);
    w.lend(BOB, s, 10_000 * E18).unwrap();
    w.deposit(ALICE, Usdc, 1_000 * E18).unwrap();
    w.post(ALICE, s, "usdc", 1_000 * E18).unwrap();
    w.borrow(ALICE, s, 700 * E18).unwrap();
    let status = |w: &mut World| w.view(|c| c.liquidation_status(s, acc(ALICE), None).status);
    assert_eq!(status(&mut w), LiquidationState::None);
    // a year of interest makes the loan unhealthy
    w.warp(4 * 365 * DAY);
    assert_eq!(status(&mut w), LiquidationState::Liquidatable);
    pause(&mut w, OWNER, &[PauseFlag::Liquidate]).unwrap();
    assert_eq!(status(&mut w), LiquidationState::Paused);
    unpause(&mut w, &[PauseFlag::Liquidate], None).unwrap();
    assert_eq!(status(&mut w), LiquidationState::Paused);
    let view = w.view(|c| c.borrow_view(s, Some(acc(ALICE)), None));
    assert_eq!(
        serde_json::to_value(view.account.liquidation).unwrap(),
        json!("paused")
    );
    w.warp(LIQUIDATION_GRACE_SEC);
    assert_eq!(status(&mut w), LiquidationState::Liquidatable);
    // a healthy account reads none whatever the flags
    pause(&mut w, OWNER, &[PauseFlag::Liquidate]).unwrap();
    assert_eq!(
        w.view(|c| c.liquidation_status(s, acc(BOB), None).status),
        LiquidationState::None
    );
}

#[test]
fn unpausing_lend_or_liquidate_reruns_the_backfill_proof() {
    let mut w = World::new();
    w.call(OWNER, NO_DEPOSIT, |c| c.legacy_backfill_open = true)
        .unwrap();
    pause(
        &mut w,
        OWNER,
        &[PauseFlag::Lend, PauseFlag::Liquidate, PauseFlag::Trade],
    )
    .unwrap();
    // other flags leave the gap flag alone
    unpause(&mut w, &[PauseFlag::Trade], None).unwrap();
    assert!(w.view(|c| c.legacy_backfill_open));
    // a balanced index (no legacy market is short) clears it
    unpause(&mut w, &[PauseFlag::Lend], None).unwrap();
    assert!(!w.view(|c| c.legacy_backfill_open));
    assert_eq!(
        w.view(|c| c.pause_state()).paused,
        vec![PauseFlag::Liquidate]
    );
}

#[test]
fn two_step_owner_transfer() {
    let mut w = World::new();
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.propose_owner(Some(acc(ALICE)))),
        &format!("NotOwner({ALICE})"),
    );
    fails(
        w.call(OWNER, ONE_YOCTO, |c| c.propose_owner(Some(acc(CONTRACT)))),
        "OwnerIsContract",
    );
    fails(
        w.call(BOB, ONE_YOCTO, |c| c.accept_owner()),
        "NoPendingOwner",
    );
    w.call(OWNER, ONE_YOCTO, |c| c.propose_owner(Some(acc(BOB))))
        .unwrap();
    assert_eq!(
        w.last.data_of("owner_proposed"),
        vec![json!({"owner_id": OWNER, "pending_owner_id": BOB})]
    );
    assert_eq!(w.view(|c| c.pause_state()).pending_owner_id, Some(acc(BOB)));
    // proposing changes nothing yet
    assert_eq!(w.view(|c| c.owner_id()), acc(OWNER));
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.accept_owner()),
        &format!("NotPendingOwner({ALICE})"),
    );
    let err = w.call(BOB, NO_DEPOSIT, |c| c.accept_owner()).unwrap_err();
    assert!(err.contains("exactly 1 yoctoNEAR"), "{err}");
    // None cancels
    w.call(OWNER, ONE_YOCTO, |c| c.propose_owner(None)).unwrap();
    fails(
        w.call(BOB, ONE_YOCTO, |c| c.accept_owner()),
        "NoPendingOwner",
    );
    w.call(OWNER, ONE_YOCTO, |c| c.propose_owner(Some(acc(BOB))))
        .unwrap();
    w.call(BOB, ONE_YOCTO, |c| c.accept_owner()).unwrap();
    assert_eq!(
        w.last.data_of("owner_changed"),
        vec![json!({"previous_owner_id": OWNER, "owner_id": BOB})]
    );
    assert_eq!(w.view(|c| c.owner_id()), acc(BOB));
    assert_eq!(w.view(|c| c.get_app_config()).pending_owner_id, None);
    // the old owner lost every owner right, the new one has them
    fails(
        w.call(OWNER, ONE_YOCTO, |c| c.set_dispute_window(10)),
        &format!("NotOwner({OWNER})"),
    );
    fails(
        pause(&mut w, OWNER, &[PauseFlag::Trade]),
        &format!("NotGuardian({OWNER})"),
    );
    pause(&mut w, BOB, &[PauseFlag::Exit]).unwrap();
    w.call(BOB, ONE_YOCTO, |c| c.unpause(vec![PauseFlag::Exit], None))
        .unwrap();
}

// ---- upgrade_accounts, the marker, post_upgrade on a fresh deployment ----

#[test]
fn upgrade_accounts_limits_and_charges_the_markers() {
    let mut w = World::new();
    let ids: Vec<AccountId> = (0..101).map(|i| acc(&format!("a{i}.near"))).collect();
    let too_many = ids.clone();
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.upgrade_accounts(too_many)),
        "TooManyAccounts(101, 100)",
    );
    fails(
        w.call(DAVE, ONE_YOCTO, |c| c.upgrade_accounts(vec![])),
        &format!("NotRegistered({DAVE})"),
    );
    let err = w
        .call(ALICE, NO_DEPOSIT, |c| c.upgrade_accounts(vec![]))
        .unwrap_err();
    assert!(err.contains("exactly 1 yoctoNEAR"), "{err}");
    // registered accounts were upgraded when they registered
    assert_eq!(
        w.call(ALICE, ONE_YOCTO, |c| c
            .upgrade_accounts(vec![acc(BOB), acc(CAROL)]))
            .unwrap(),
        0
    );
    assert_eq!(
        w.last.data_of("accounts_upgraded"),
        vec![json!({"count": 0})]
    );
    // an unknown id gets a marker, paid by the caller; once only
    let used = w.storage_used(ALICE);
    let hundred = ids[..100].to_vec();
    assert_eq!(
        w.call(ALICE, ONE_YOCTO, |c| c.upgrade_accounts(hundred.clone()))
            .unwrap(),
        100
    );
    assert_eq!(
        w.last.data_of("accounts_upgraded"),
        vec![json!({"count": 100})]
    );
    let marker = |id: &AccountId| 40 + 1 + 4 + id.len() as u64 + 4;
    let paid: u64 = hundred.iter().map(marker).sum();
    assert_eq!(w.storage_used(ALICE) - used, paid);
    assert_eq!(
        w.call(ALICE, ONE_YOCTO, |c| c.upgrade_accounts(hundred))
            .unwrap(),
        0
    );
    assert_eq!(w.storage_used(ALICE) - used, paid);
}

#[test]
fn registration_writes_the_marker_and_unregistering_removes_it() {
    let mut w = World::new();
    let version = |w: &mut World, who: &str| {
        let who = acc(who);
        w.view(|c| c.account_version.get(&who).copied())
    };
    assert_eq!(version(&mut w, ALICE), Some(STATE_VERSION));
    assert_eq!(version(&mut w, ERIN), None);
    w.register(ERIN, NearToken::from_millinear(100));
    assert_eq!(version(&mut w, ERIN), Some(STATE_VERSION));
    // the record and the marker are paid by the registration
    let record = 40 + 1 + 4 + ERIN.len() as u64 + 16 + 8 + 4;
    let marker = 40 + 1 + 4 + ERIN.len() as u64 + 4;
    assert_eq!(w.storage_used(ERIN), record + marker);
    w.call(ERIN, ONE_YOCTO, |c| c.storage_unregister(None))
        .unwrap();
    assert_eq!(version(&mut w, ERIN), None);
    // everything comes back
    assert_eq!(
        w.last.near_transfers(),
        vec![(acc(ERIN), NearToken::from_millinear(100).as_yoctonear())]
    );
    books_hold(&mut w, &[OWNER, ALICE, BOB, CAROL, ERIN]).unwrap();
    // coming back folds nothing and writes a new marker
    w.register(ERIN, NearToken::from_millinear(100));
    assert_eq!(version(&mut w, ERIN), Some(STATE_VERSION));
    assert_eq!(w.storage_used(ERIN), record + marker);
    books_hold(&mut w, &[OWNER, ALICE, BOB, CAROL, ERIN]).unwrap();
}

#[test]
fn post_upgrade_on_a_fresh_deployment() {
    let mut w = World::new();
    fails(
        w.call(OWNER, NO_DEPOSIT, |c| c.post_upgrade(STATE_VERSION)),
        "InitNotSelf",
    );
    fails(
        w.call(CONTRACT, NO_DEPOSIT, |c| c.post_upgrade(1)),
        "WrongStateVersion(2, 1)",
    );
    fails(
        w.call(CONTRACT, NO_DEPOSIT, |c| c.post_upgrade(3)),
        "WrongStateVersion(2, 3)",
    );
    pause(&mut w, OWNER, &[PauseFlag::Trade]).unwrap();
    w.warp(100);
    w.call(CONTRACT, NO_DEPOSIT, |c| c.post_upgrade(STATE_VERSION))
        .unwrap();
    let v = w.view(|c| c.contract_version());
    assert_eq!(
        (
            v.state_version,
            v.recorded_code_version.as_str(),
            v.upgraded_from.as_str()
        ),
        (2, CODE_VERSION, CODE_VERSION)
    );
    assert_eq!(v.upgraded_at_sec, T0 + 100);
    let u = &w.last.data_of("contract_upgraded")[0];
    assert_eq!(
        *u,
        json!({"from_state_version": 2, "to_state_version": 2, "from_code_version": CODE_VERSION,
               "code_version": CODE_VERSION, "accounts_upgraded": 0, "scenarios": 2, "pools": 0,
               "orders": 0, "paused": ["trade"], "legacy_scenario_count": 0,
               "lending": null, "catalog": null})
    );
    // it pauses nothing and leaves the flags as they were
    assert_eq!(w.view(|c| c.pause_state()).paused, vec![PauseFlag::Trade]);
}

// ---- The books view ----

#[test]
fn books_buckets_through_lending_spot_pool_and_failed_payouts() {
    let (mut w, ids) = matrix_world();
    let holders = [OWNER, ALICE, BOB, CAROL, ERIN];
    books_hold(&mut w, &holders).unwrap();
    let page = w.view(|c| c.books(None, None));
    assert_eq!((page.from_scenario, page.next_scenario), (1, None));
    // bob's 100,000 USDC, alice's 100 borrowed: lending cash is the rest
    assert_eq!(page.wnear.lending_cash, U128(0));
    let tsa_tba = w.view(|c| {
        let m = c.markets.get(&ids.s).unwrap();
        m.total_supply_assets - m.total_borrow_assets
    });
    assert_eq!(page.usdc.lending_cash, U128(tsa_tba));
    assert_eq!(page.usdc.insurance, U128(0));
    // alice's 500 and carol's 50 USDC pieces are the real collateral
    assert_eq!(page.usdc.collateral, U128(550 * E18));
    assert_eq!(page.wnear.collateral, U128(0));
    let spot = w.view(|c| c.get_spot_pool().unwrap());
    assert_eq!(page.wnear.spot_pool, spot.reserve0);
    assert_eq!(page.usdc.pledges, U128(0));
    let reserves: u128 = [ids.s, ids.b].iter().map(|s| w.reserves(*s, Usdc)).sum();
    assert_eq!(page.usdc.reserves, U128(reserves));
    let expected_total = page.usdc.reserves.0
        + page.usdc.lending_cash.0
        + page.usdc.internal.0
        + page.usdc.collateral.0
        + page.usdc.spot_pool.0
        + page.usdc.pledges.0;
    assert_eq!(page.usdc.total, U128(expected_total));

    // interest moves debt and supply together: cash stays
    w.warp(30 * DAY);
    w.call(ALICE, ONE_YOCTO, |c| {
        c.repay_from_balance(ids.s, Some(U128(10 * E18)), None)
    })
    .unwrap();
    books_hold(&mut w, &holders).unwrap();
    // spot swaps and their fees
    w.ft_transfer_call(
        ALICE,
        Usdc,
        30_000_000,
        r#"{"action":"spot_swap","min_out":"0"}"#,
    )
    .unwrap();
    books_hold(&mut w, &holders).unwrap();
    assert!(w.view(|c| c.books(None, None)).usdc.spot_pool.0 > spot.reserve1.0);
    // failed payouts come back into the internal balance (carol cannot be paid)
    w.ft_unregistered.insert(acc(CAROL));
    w.withdraw(CAROL, Usdc, 10 * E18).unwrap();
    assert_eq!(w.real(CAROL, Usdc), 50 * E18);
    books_hold(&mut w, &holders).unwrap();
    w.unpost(CAROL, ids.b, "usdc", 20 * E18).unwrap();
    books_hold(&mut w, &holders).unwrap();
    // a liquidation moves pieces and repays debt: ten years of interest
    // make alice's loan unhealthy
    w.borrow(ALICE, ids.s, 250 * E18).unwrap();
    w.warp(10 * 365 * DAY);
    w.ft_transfer_call(
        BOB,
        Usdc,
        1_000_000_000,
        &format!(r#"{{"action":"liquidate","scenario_id":{},"account_id":"{ALICE}","repay_amount":"max"}}"#, ids.s),
    )
    .unwrap();
    assert_eq!(w.last.data_of("liquidate").len(), 1);
    books_hold(&mut w, &holders).unwrap();
    // bob takes his supply out, the order and the pool position close
    w.call(BOB, ONE_YOCTO, |c| {
        c.withdraw_supply(ids.s, Some(U128(1_000 * E18)), None)
    })
    .unwrap();
    w.call(BOB, ONE_YOCTO, |c| c.cancel_order(U64(ids.order)))
        .unwrap();
    w.call(ALICE, ONE_YOCTO, |c| c.collect_fees(ids.pools[0]))
        .unwrap();
    books_hold(&mut w, &holders).unwrap();
}

#[test]
fn books_pages_split_scenarios_and_carry_the_globals_once() {
    let (mut w, _) = matrix_world();
    for _ in 0..3 {
        let fed = w.fed;
        w.create_scenario(&[fed]).unwrap();
    }
    let count = w.view(|c| c.scenario_count);
    assert_eq!(count, 5);
    let one = books_pages(&mut w, None);
    assert_eq!(one.len(), 1);
    let pages = books_pages(&mut w, Some(2));
    assert_eq!(
        pages
            .iter()
            .map(|p| (p.from_scenario, p.next_scenario))
            .collect::<Vec<_>>(),
        vec![(1, Some(3)), (3, Some(5)), (5, None)]
    );
    for asset in [0, 1] {
        let pick = |p: &BooksView| {
            if asset == 0 {
                p.wnear.clone()
            } else {
                p.usdc.clone()
            }
        };
        let sum = |f: fn(&crate::books::BooksAssetView) -> u128| -> u128 {
            pages.iter().map(|p| f(&pick(p))).sum()
        };
        let whole = pick(&one[0]);
        assert_eq!(sum(|a| a.total.0), whole.total.0);
        assert_eq!(sum(|a| a.reserves.0), whole.reserves.0);
        assert_eq!(sum(|a| a.lending_cash.0), whole.lending_cash.0);
        // global buckets only on the first page
        for p in &pages[1..] {
            let a = pick(p);
            assert_eq!(
                (a.internal, a.collateral, a.spot_pool, a.pledges),
                (U128(0), U128(0), U128(0), U128(0))
            );
        }
    }
    // a page past the last scenario holds nothing; limits clamp to 1..=100
    let past = w.view(|c| c.books(Some(9), None));
    assert_eq!((past.from_scenario, past.next_scenario), (9, None));
    assert_eq!(past.usdc.total, U128(0));
    assert_eq!(w.view(|c| c.books(Some(0), Some(0))).next_scenario, Some(2));
    assert_eq!(w.view(|c| c.books(None, Some(1_000))).next_scenario, None);
}

// ---- The NEAR books (M-13) ----

#[derive(Clone, Copy, Debug)]
enum NearOp {
    Register,
    RegisterOnly,
    RegisterFor,
    TopUp,
    StorageWithdraw,
    StorageWithdrawAll,
    Unregister,
    Split,
    Merge,
    Transfer,
    FailedPayout,
    FailedPayoutAfterDrain,
    Upgrade,
}

fn near_op() -> impl Strategy<Value = NearOp> {
    prop_oneof![
        3 => Just(NearOp::Register),
        1 => Just(NearOp::RegisterOnly),
        1 => Just(NearOp::RegisterFor),
        2 => Just(NearOp::TopUp),
        2 => Just(NearOp::StorageWithdraw),
        1 => Just(NearOp::StorageWithdrawAll),
        2 => Just(NearOp::Unregister),
        3 => Just(NearOp::Split),
        2 => Just(NearOp::Merge),
        2 => Just(NearOp::Transfer),
        2 => Just(NearOp::FailedPayout),
        2 => Just(NearOp::FailedPayoutAfterDrain),
        1 => Just(NearOp::Upgrade),
    ]
}

const PEOPLE: [&str; 7] = [ALICE, BOB, CAROL, OWNER, DAVE, ERIN, "frank.near"];

fn run_near_op(w: &mut World, op: NearOp, seed: u64) -> Result<(), String> {
    let who = PEOPLE[(seed % 7) as usize];
    let other = PEOPLE[((seed >> 8) % 7) as usize];
    let yocto = u128::from((seed >> 16) % 2_000 + 1) * NearToken::from_millinear(1).as_yoctonear();
    let s = w.s2x2;
    match op {
        NearOp::Register => w
            .call(who, NearToken::from_yoctonear(yocto), |c| {
                c.storage_deposit(None, None)
            })
            .map(|_| ()),
        NearOp::RegisterOnly => w
            .call(who, NearToken::from_yoctonear(yocto), |c| {
                c.storage_deposit(None, Some(true))
            })
            .map(|_| ()),
        NearOp::RegisterFor => w
            .call(who, NearToken::from_yoctonear(yocto), |c| {
                c.storage_deposit(Some(acc(other)), None)
            })
            .map(|_| ()),
        NearOp::TopUp => {
            if w.view(|c| c.storage_balance_of(acc(who))).is_none() {
                return Err("unregistered".into());
            }
            w.call(who, NearToken::from_yoctonear(yocto), |c| {
                c.storage_deposit(None, None)
            })
            .map(|_| ())
        }
        NearOp::StorageWithdraw => w
            .call(who, ONE_YOCTO, |c| {
                c.storage_withdraw(Some(U128(yocto / 50)))
            })
            .map(|_| ()),
        NearOp::StorageWithdrawAll => w
            .call(who, ONE_YOCTO, |c| c.storage_withdraw(None))
            .map(|_| ()),
        NearOp::Unregister => w
            .call(who, ONE_YOCTO, |c| c.storage_unregister(None))
            .map(|_| ()),
        NearOp::Split => {
            if w.wallet_raw(who, Wnear) < 10 * E18 {
                w.fund(who);
            }
            w.split_ft(
                who,
                s,
                Wnear,
                &SINGLES,
                E18 * u128::from(1 + (seed >> 24) % 5),
            )
        }
        NearOp::Merge => w.merge(who, s, Wnear, &SINGLES, ROOT, E18),
        NearOp::Transfer => {
            let t = token_id(s, Wnear, SINGLES[((seed >> 24) % 4) as usize]);
            w.mt_transfer(who, other, &t, E18 / 2)
        }
        NearOp::FailedPayout => {
            if w.wallet_raw(who, Usdc) < 1_000_000 {
                w.fund(who);
            }
            w.ft_unregistered.insert(acc(who));
            let r = w
                .deposit(who, Usdc, E18)
                .and_then(|_| w.withdraw(who, Usdc, E18));
            w.ft_unregistered.remove(&acc(who));
            r
        }
        NearOp::FailedPayoutAfterDrain => {
            // The withdrawal frees the balance entry, the account drains its
            // deposit, then the failed payout re-creates the entry in the
            // callback: the record ends up using more than its deposit.
            if w.wallet_raw(who, Usdc) < 1_000_000 {
                w.fund(who);
            }
            w.deposit(who, Usdc, E18)?;
            w.ft_unregistered.insert(acc(who));
            w.auto_payouts = false;
            let r = w.withdraw(who, Usdc, E18).map(|_| {
                let pending = w.last.clone();
                let _ = w.call(who, ONE_YOCTO, |c| c.storage_withdraw(None));
                w.last = pending;
                w.run_payouts();
            });
            w.auto_payouts = true;
            w.ft_unregistered.remove(&acc(who));
            r
        }
        NearOp::Upgrade => w
            .call(who, ONE_YOCTO, |c| {
                c.upgrade_accounts(vec![acc(other), acc("ghost.near")])
            })
            .map(|_| ()),
    }
}

/// M-13: after every NEAR move of a random campaign, `near_books` equals the
/// enumeration of every NEP-145 record (Σ deposit − Σ used bytes × byte
/// cost, which is Σ `storage_balance_of(a).available` while no account uses
/// more than its deposit), the proposal NEAR and the storage fund are zero,
/// and `own_free` is the balance minus the stake minus all of that, never
/// negative.
#[test]
fn near_books_matches_enumeration() {
    let config = Config {
        cases: 48,
        failure_persistence: None,
        max_shrink_iters: 64,
        ..Config::default()
    };
    let moves = RefCell::new((0u64, 0u64, 0u64));
    let mut runner = TestRunner::new(config);
    let result = runner.run(
        &proptest::collection::vec((near_op(), any::<u64>()), 20..=60),
        |ops| {
            let mut w = World::new();
            for (op, seed) in ops {
                let ok = run_near_op(&mut w, op, seed).is_ok();
                let mut m = moves.borrow_mut();
                m.0 += 1;
                m.1 += u64::from(ok);
                drop(m);
                let (deposit, used, available, over) = w.view(|c| {
                    let mut out = (0u128, 0u128, 0u128, false);
                    for who in PEOPLE.iter().chain([&CONTRACT]) {
                        let a = acc(who);
                        if let Some(r) = c.storage.get(&a) {
                            let cost = u128::from(r.used_bytes) * BYTE;
                            out.0 += r.deposit.as_yoctonear();
                            out.1 += cost;
                            out.2 += c.storage_balance_of(a).unwrap().available.0;
                            out.3 |= cost > r.deposit.as_yoctonear();
                        }
                    }
                    out
                });
                if over {
                    moves.borrow_mut().2 += 1;
                }
                let near = w.view(|c| c.near_books());
                let usage = w.view(|_| env::storage_usage());
                let aggregate = deposit.saturating_sub(used);
                prop_assert_eq!(near.nep145_available.0, aggregate, "after {:?}", op);
                if !over {
                    prop_assert_eq!(near.nep145_available.0, available, "after {:?}", op);
                }
                prop_assert_eq!((near.near_held.0, near.storage_fund.0), (0, 0));
                prop_assert_eq!(near.storage_stake.0, u128::from(usage) * BYTE);
                let own_free =
                    near.balance.0 as i128 - near.storage_stake.0 as i128 - aggregate as i128;
                prop_assert_eq!(near.own_free.parse::<i128>().unwrap(), own_free);
                prop_assert!(own_free >= 0);
                books_hold(&mut w, &PEOPLE).map_err(TestCaseError::fail)?;
            }
            Ok(())
        },
    );
    let (total, ok, over) = moves.into_inner();
    println!("near_books_matches_enumeration: {total} moves, {ok} succeeded, {over} with an over-used record");
    if let Err(e) = result {
        panic!("near_books_matches_enumeration: {e}");
    }
    assert!(ok * 3 > total, "too few moves succeeded: {ok} of {total}");
    assert!(
        over > 0,
        "no move left a record using more than its deposit"
    );
}

#[test]
fn near_books_shape() {
    let mut w = World::new();
    let near = w.view(|c| c.near_books());
    let text = serde_json::to_string(&near).unwrap();
    let order = [
        "balance",
        "storage_stake",
        "nep145_available",
        "near_held",
        "storage_fund",
        "own_free",
    ];
    let at: Vec<usize> = order
        .iter()
        .map(|k| text.find(&format!("\"{k}\"")).unwrap())
        .collect();
    assert!(at.windows(2).all(|p| p[0] < p[1]), "{text}");
    let v = serde_json::to_value(near).unwrap();
    assert_eq!(v.as_object().unwrap().len(), order.len());
    assert!(v["own_free"].is_string());
    assert_eq!(
        v["balance"],
        json!(NearToken::from_near(10_000).as_yoctonear().to_string())
    );
}
