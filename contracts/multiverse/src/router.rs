//! Router: conditional sell and buy, sell-and-borrow, posting an order from
//! real assets, and closing a position after resolution. Each one is a single
//! atomic call: the attached (or internal) real asset is split into every
//! possible world, the traded worlds fill their planned orders first and send
//! what is left into their pool, and the result stays in the user's ledger or
//! goes straight into lending.
//!
//! A trade runs inside a `LogScope` (one line per NEP-245 kind and per event
//! name, its fills as one `orders_filled` line), so even the heaviest plan
//! the app builds (four worlds, five fills each) stays inside a receipt's log
//! limits.
//!
//! Plans are strict: an order that was taken, cancelled,
//! expired or went stale fails the whole trade, and the app replans.

use multiverse_math::orders::cost;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Serialize;
use near_sdk::{assert_one_yocto, env, near, AccountId};

use crate::errors::{add, fail};
use crate::events::MultiverseEvent;
use crate::ledger::LogScope;
use crate::lending::{require_normal, CollateralKey};
use crate::masks;
use crate::ops::PauseFlag;
use crate::orders::Side;
use crate::receiver::{
    ConditionalBuyMsg, ConditionalSellMsg, PostOrderMsg, ScenarioMsg, SellAndBorrowMsg,
};
use crate::types::Asset;
use crate::{Contract, ContractExt};

/// Most order fills one trade may plan at up to 4 worlds (the v1 planner's
/// 4 x 5), and at 8 worlds, so every accepted trade fits a receipt's logs.
pub const MAX_TRADE_FILLS: usize = 20;
pub const MAX_TRADE_FILLS_8W: usize = 18;

pub fn max_trade_fills(world_count: u8) -> usize {
    if world_count <= 4 {
        MAX_TRADE_FILLS
    } else {
        MAX_TRADE_FILLS_8W
    }
}

/// One order fill in a sale plan: `{"order_id":"1","amount":"1000000000000000000"}`.
/// `amount` is always wNEAR, for bids and asks alike.
#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PlanFill {
    pub order_id: U64,
    pub amount: U128,
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ConditionalSale<'a> {
    pub account_id: &'a AccountId,
    pub scenario_id: u64,
    pub sell_mask: u8,
    pub amount: U128,
    pub proceeds: Vec<U128>,
    pub to_lending: bool,
}

impl MultiverseEvent for ConditionalSale<'_> {
    const NAME: &'static str = "conditional_sale";
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ConditionalBuy<'a> {
    pub account_id: &'a AccountId,
    pub scenario_id: u64,
    pub buy_mask: u8,
    pub amount: U128,
    pub bought: Vec<U128>,
    pub to_lending: bool,
}

impl MultiverseEvent for ConditionalBuy<'_> {
    const NAME: &'static str = "conditional_buy";
}

/// `pieces` counts every collateral piece taken back, redeemed or not.
#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Closed<'a> {
    pub account_id: &'a AccountId,
    pub scenario_id: u64,
    pub repaid: U128,
    pub pieces: u32,
}

impl MultiverseEvent for Closed<'_> {
    const NAME: &'static str = "closed";
}

/// A sale gives wNEAR and takes bids; a buy gives USDC and takes asks.
#[derive(Clone, Copy)]
struct Trade {
    scenario_id: u64,
    amount: u128,
    mask: u8,
    buy: bool,
    to_lending: bool,
}

impl Trade {
    fn asset_in(&self) -> Asset {
        if self.buy {
            Asset::Usdc
        } else {
            Asset::Wnear
        }
    }
}

#[near]
impl Contract {
    /// Sells `amount` wNEAR (from the internal balance) in the worlds of
    /// `sell_mask` and keeps it in every other possible world. Returns the
    /// USDC-if-w each world paid (0 where not sold).
    #[payable]
    pub fn conditional_sell(
        &mut self,
        scenario_id: u64,
        amount: U128,
        sell_mask: u8,
        plans: Vec<Vec<PlanFill>>,
        min_out: Vec<U128>,
        to_lending: bool,
    ) -> Vec<U128> {
        assert_one_yocto();
        self.assert_trade_live(to_lending);
        let user = env::predecessor_account_id();
        let before = env::storage_usage();
        let t = Trade {
            scenario_id,
            amount: amount.0,
            mask: sell_mask,
            buy: false,
            to_lending,
        };
        let out = self.conditional_trade(&user, t, &plans, &min_out);
        self.charge_storage(&user, before);
        out
    }

    /// Buys wNEAR-if-w with `amount` USDC (from the internal balance) in the
    /// worlds of `buy_mask`, filling asks first. Returns the wNEAR-if-w bought.
    #[payable]
    pub fn conditional_buy(
        &mut self,
        scenario_id: u64,
        amount: U128,
        buy_mask: u8,
        plans: Vec<Vec<PlanFill>>,
        min_out: Vec<U128>,
        to_lending: bool,
    ) -> Vec<U128> {
        assert_one_yocto();
        self.assert_trade_live(to_lending);
        let user = env::predecessor_account_id();
        let before = env::storage_usage();
        let t = Trade {
            scenario_id,
            amount: amount.0,
            mask: buy_mask,
            buy: true,
            to_lending,
        };
        let out = self.conditional_trade(&user, t, &plans, &min_out);
        self.charge_storage(&user, before);
        out
    }

    /// Repays any debt from the internal USDC balance, takes every collateral
    /// piece back, redeems the collapsed ones and pays the real assets out.
    /// With debt the `close_after_resolution` transfer action is the usual
    /// path, since it brings the USDC along. Returns what was repaid.
    #[payable]
    pub fn close_after_resolution(&mut self, scenario_id: u64) -> U128 {
        assert_one_yocto();
        self.assert_live(PauseFlag::Exit);
        let user = env::predecessor_account_id();
        let before = env::storage_usage();
        let repaid = self.close_for(&user, scenario_id, None);
        self.charge_storage(&user, before);
        U128(repaid)
    }
}

impl Contract {
    /// A trade needs `trade` live, and `lend` too when its result goes into
    /// lending.
    pub(crate) fn assert_trade_live(&self, to_lending: bool) {
        self.assert_live(PauseFlag::Trade);
        if to_lending {
            self.assert_live(PauseFlag::Lend);
        }
    }

    pub(crate) fn ft_conditional_sell(
        &mut self,
        sender: &AccountId,
        asset: Asset,
        amount: u128,
        msg: ConditionalSellMsg,
    ) {
        require_asset(asset, Asset::Wnear);
        if msg.to_lending {
            require_normal(msg.tier);
        }
        let t = Trade {
            scenario_id: msg.scenario_id,
            amount,
            mask: msg.sell_mask,
            buy: false,
            to_lending: msg.to_lending,
        };
        self.conditional_trade(sender, t, &msg.plans, &msg.min_out);
    }

    pub(crate) fn ft_conditional_buy(
        &mut self,
        sender: &AccountId,
        asset: Asset,
        amount: u128,
        msg: ConditionalBuyMsg,
    ) {
        require_asset(asset, Asset::Usdc);
        if msg.to_lending {
            require_normal(msg.tier);
        }
        let t = Trade {
            scenario_id: msg.scenario_id,
            amount,
            mask: msg.buy_mask,
            buy: true,
            to_lending: msg.to_lending,
        };
        self.conditional_trade(sender, t, &msg.plans, &msg.min_out);
    }

    /// A sale into lending, then a USDC loan against it paid to the wallet.
    pub(crate) fn ft_sell_and_borrow(
        &mut self,
        sender: &AccountId,
        asset: Asset,
        amount: u128,
        msg: SellAndBorrowMsg,
    ) {
        require_asset(asset, Asset::Wnear);
        require_normal(msg.tier);
        let t = Trade {
            scenario_id: msg.scenario_id,
            amount,
            mask: msg.sell_mask,
            buy: false,
            to_lending: true,
        };
        self.conditional_trade(sender, t, &msg.plans, &msg.min_out);
        self.borrow_for(sender, msg.scenario_id, msg.borrow_amount.0);
    }

    /// Posts an order from real assets: USDC for a bid, wNEAR for an ask. The
    /// escrow is split into `[mask, every other possible world]`; the mask
    /// piece goes into the order and the sender keeps the rest. Whatever the
    /// transfer brought beyond the escrow is returned.
    pub(crate) fn ft_post_order(
        &mut self,
        sender: &AccountId,
        asset: Asset,
        amount: u128,
        msg: PostOrderMsg,
    ) {
        require_asset(asset, msg.side.escrow_asset());
        let escrow = match msg.side {
            Side::Ask => msg.amount.0,
            Side::Bid => cost(msg.amount.0, msg.price.0),
        };
        if escrow == 0 {
            fail("ZeroAmount");
        }
        let s = self.scenario(msg.scenario_id);
        let (root, possible) = (s.root(), s.possible);
        if amount < escrow {
            fail!("InsufficientDeposit({amount}, {escrow})");
        }
        let mut parts = vec![msg.mask];
        parts.extend(masks::single_worlds(possible & !msg.mask));
        // The split checks the mask, so a bad one fails with the core's errors.
        self.internal_split(sender, msg.scenario_id, asset, root, &parts, escrow);
        self.post_order_for(
            sender,
            msg.scenario_id,
            msg.mask,
            msg.side,
            msg.price.0,
            msg.amount.0,
            msg.expiry_sec,
        );
    }

    /// Repays the debt from the attached USDC, which must cover it; the
    /// receiver returns the rest.
    pub(crate) fn ft_close_after_resolution(
        &mut self,
        sender: &AccountId,
        asset: Asset,
        amount: u128,
        msg: ScenarioMsg,
    ) {
        require_asset(asset, Asset::Usdc);
        require_normal(msg.tier);
        self.close_for(sender, msg.scenario_id, Some(amount));
    }

    /// The shared pipeline of sell, buy and sell-and-borrow. Returns what
    /// each traded world got (0 elsewhere). Checks run in a fixed order.
    fn conditional_trade(
        &mut self,
        user: &AccountId,
        t: Trade,
        plans: &[Vec<PlanFill>],
        min_out: &[U128],
    ) -> Vec<U128> {
        let _scope = LogScope::open();
        let out = self.trade(user, t, plans, min_out);
        let out: Vec<U128> = out.into_iter().map(U128).collect();
        if t.buy {
            ConditionalBuy {
                account_id: user,
                scenario_id: t.scenario_id,
                buy_mask: t.mask,
                amount: U128(t.amount),
                bought: out.clone(),
                to_lending: t.to_lending,
            }
            .emit();
        } else {
            ConditionalSale {
                account_id: user,
                scenario_id: t.scenario_id,
                sell_mask: t.mask,
                amount: U128(t.amount),
                proceeds: out.clone(),
                to_lending: t.to_lending,
            }
            .emit();
        }
        out
    }

    fn trade(
        &mut self,
        user: &AccountId,
        t: Trade,
        plans: &[Vec<PlanFill>],
        min_out: &[U128],
    ) -> Vec<u128> {
        if t.amount == 0 {
            fail("ZeroAmount");
        }
        let s = self.scenario(t.scenario_id);
        let (world_count, possible, root) = (s.world_count, s.possible, s.root());
        if t.mask == 0 || t.mask & !possible != 0 {
            fail!("BadSellMask({})", t.mask);
        }
        let n = usize::from(world_count);
        if plans.len() != n || min_out.len() != n {
            fail("LengthMismatch");
        }
        let singles = masks::single_worlds(possible);
        self.internal_split(user, t.scenario_id, t.asset_in(), root, &singles, t.amount);

        // Every planned fill of every world runs before any pool swap.
        let mut out = vec![0u128; n];
        let mut to_pool = vec![0u128; n];
        for w in 0..world_count {
            let i = usize::from(w);
            if !masks::contains(t.mask, w) {
                if !plans[i].is_empty() {
                    fail!("BadPlan({w})");
                }
                continue;
            }
            let mut left = t.amount;
            for f in &plans[i] {
                let (spent, got) = self.fill_planned(user, &t, w, f, left);
                left -= spent;
                out[i] = add(out[i], got);
            }
            to_pool[i] = left;
        }

        for w in 0..world_count {
            let i = usize::from(w);
            if to_pool[i] == 0 {
                continue;
            }
            let pool_id = self
                .world_pool(t.scenario_id, w)
                .unwrap_or_else(|| fail!("PoolNotInitialized({w})"));
            // token0 is wNEAR-if-w: a sale goes 0 -> 1, a buy 1 -> 0
            let got = self.swap_exact_in_for(user, pool_id, !t.buy, to_pool[i], 0);
            out[i] = add(out[i], got);
        }

        for w in 0..world_count {
            if !masks::contains(possible, w) {
                continue;
            }
            let i = usize::from(w);
            let traded = masks::contains(t.mask, w);
            if traded && out[i] < min_out[i].0 {
                fail!("InsufficientOutput({w}, {}, {})", out[i], min_out[i].0);
            }
            // the traded leg is the other asset; untraded worlds keep the input
            let (asset, amount) = if traded {
                (if t.buy { Asset::Wnear } else { Asset::Usdc }, out[i])
            } else {
                (t.asset_in(), t.amount)
            };
            if amount == 0 || !t.to_lending {
                continue;
            }
            let piece = CollateralKey::Verse {
                asset,
                mask: 1 << w,
            };
            self.deposit_collateral_for(user, t.scenario_id, piece, amount);
        }
        out
    }

    /// One planned fill in world `w` with `left` of the world's input still
    /// unspent. Returns `(spent, got)`.
    fn fill_planned(
        &mut self,
        user: &AccountId,
        t: &Trade,
        w: u8,
        f: &PlanFill,
        left: u128,
    ) -> (u128, u128) {
        let id = f.order_id.0;
        let side = if t.buy { Side::Ask } else { Side::Bid };
        let (price, fits) = match self.order(id) {
            Some(o) => (
                o.price,
                o.side == side && o.scenario_id == t.scenario_id && o.mask == 1 << w,
            ),
            None => (0, false),
        };
        if !fits {
            fail!("PlanOrderMismatch({w}, {id})");
        }
        let amount = f.amount.0;
        let spent = if t.buy { cost(amount, price) } else { amount };
        if spent > left {
            fail!("BadPlan({w})");
        }
        // No price limit: the order's price cannot change, and min_out bounds the world.
        let limit = if t.buy { u128::MAX } else { 0 };
        let (paid, got) = self.fill_order_for(user, id, amount, limit);
        debug_assert_eq!(paid, spent);
        (spent, got)
    }

    /// Repays all debt (`budget` caps what the attached USDC can cover; None
    /// draws on the internal balance), takes back every collateral piece,
    /// redeems the collapsed verse pieces and pays every real asset out. Live
    /// and dead verse pieces stay in the ledger. Returns what was repaid.
    fn close_for(&mut self, user: &AccountId, scenario_id: u64, budget: Option<u128>) -> u128 {
        self.scenario(scenario_id);
        let _scope = LogScope::open();
        let debt = self.debt_for(scenario_id, user);
        let mut repaid = 0;
        if debt != 0 {
            if let Some(budget) = budget {
                if budget < debt {
                    fail!("InsufficientRepayment({budget}, {debt})");
                }
            }
            repaid = self.repay_for(user, scenario_id, u128::MAX);
        }
        let pieces = self.withdraw_all_collateral_for(user, scenario_id);
        let possible = self.scenario(scenario_id).possible;
        let mut pay = [0u128; 2];
        for &(piece, amount) in &pieces {
            match piece {
                CollateralKey::Real(asset) => {
                    // back in the internal balance; it leaves with the payout below
                    self.real_debit(user, asset, amount);
                    pay[asset_index(asset)] = add(pay[asset_index(asset)], amount);
                }
                CollateralKey::Verse { asset, mask } if masks::is_collapsed(mask, possible) => {
                    self.internal_redeem(user, scenario_id, asset, mask, amount);
                    pay[asset_index(asset)] = add(pay[asset_index(asset)], amount);
                }
                CollateralKey::Verse { .. } => {}
            }
        }
        Closed {
            account_id: user,
            scenario_id,
            repaid: U128(repaid),
            pieces: pieces.len() as u32,
        }
        .emit();
        for asset in Asset::ALL {
            let amount = pay[asset_index(asset)];
            if amount > 0 {
                self.payout(user, asset, amount);
            }
        }
        repaid
    }
}

fn asset_index(asset: Asset) -> usize {
    match asset {
        Asset::Wnear => 0,
        Asset::Usdc => 1,
    }
}

fn require_asset(asset: Asset, expected: Asset) {
    if asset != expected {
        fail!("WrongAsset({asset})");
    }
}
