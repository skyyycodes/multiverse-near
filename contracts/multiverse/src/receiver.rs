//! Real WETH/USDC come in through `ft_transfer_call` with an action in `msg`:
//! one signature, no approval, and whatever the action leaves unused goes
//! back to the sender through the token contract.
//!
//! Flow: credit `amount * scale` to the sender's internal balance, run the
//! action for the sender (it draws what it uses from that balance), then hand
//! back the part of this transfer still sitting there. Only whole token units
//! can go back; a sub-unit remainder stays in the internal balance as dust.
//! Any failed check panics, which rolls the receipt back and makes the token
//! contract refund everything.

use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{env, near, serde_json, AccountId, PromiseOrValue};

use crate::errors::{fail, mul};
use crate::events::{MultiverseEvent, RealDeposit};
use crate::lending::RepayAmount;
use crate::orders::Side;
use crate::router::PlanFill;
use crate::types::Asset;
use crate::{Contract, ContractExt};

/// The `msg` of an `ft_transfer_call`, e.g. `{"action":"split","scenario_id":1,"to_masks":[5,10]}`.
/// An empty `msg` means `deposit`. Amounts are internal (18-decimal) units.
/// Unknown actions and unknown fields are rejected.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", tag = "action", rename_all = "snake_case")]
pub enum Action {
    /// Credit the internal real balance.
    Deposit(DepositMsg),
    /// Root split of the attached asset into `to_masks`, for the sender.
    Split(SplitMsg),
    ConditionalSell(ConditionalSellMsg),
    ConditionalBuy(ConditionalBuyMsg),
    SellAndBorrow(SellAndBorrowMsg),
    PostOrder(PostOrderMsg),
    Supply(ScenarioMsg),
    /// Repays `min(attached, debt)`; the rest is returned.
    Repay(RepayMsg),
    /// The attached real asset becomes collateral of the sender.
    DepositCollateral(ScenarioMsg),
    Liquidate(LiquidateMsg),
    CloseAfterResolution(ScenarioMsg),
    /// Attached USDC plus `weth_amount` from the internal WETH balance.
    LpDeposit(LpDepositMsg),
    /// Attached asset into the spot pool; the output is credited to the
    /// internal real balance.
    SpotSwap(SpotSwapMsg),
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct DepositMsg {}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct SplitMsg {
    pub scenario_id: u64,
    pub to_masks: Vec<u8>,
}

/// `plans` and `min_out` are indexed by world (length `world_count`).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct ConditionalSellMsg {
    pub scenario_id: u64,
    pub sell_mask: u8,
    pub plans: Vec<Vec<PlanFill>>,
    pub min_out: Vec<U128>,
    pub to_lending: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct ConditionalBuyMsg {
    pub scenario_id: u64,
    pub buy_mask: u8,
    pub plans: Vec<Vec<PlanFill>>,
    pub min_out: Vec<U128>,
    pub to_lending: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct SellAndBorrowMsg {
    pub scenario_id: u64,
    pub sell_mask: u8,
    pub plans: Vec<Vec<PlanFill>>,
    pub min_out: Vec<U128>,
    pub borrow_amount: U128,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct PostOrderMsg {
    pub scenario_id: u64,
    pub mask: u8,
    pub side: Side,
    pub price: U128,
    pub amount: U128,
    pub expiry_sec: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct ScenarioMsg {
    pub scenario_id: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct RepayMsg {
    pub scenario_id: u64,
    pub all: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct LiquidateMsg {
    pub scenario_id: u64,
    pub account_id: AccountId,
    pub repay_amount: RepayAmount,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct LpDepositMsg {
    pub scenario_id: u64,
    pub weth_amount: U128,
    pub min_shares: U128,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct SpotSwapMsg {
    pub min_out: U128,
}

/// Strict parse; an empty `msg` is a plain deposit.
pub fn parse_msg(msg: &str) -> Action {
    if msg.trim().is_empty() {
        return Action::Deposit(DepositMsg {});
    }
    serde_json::from_str(msg).unwrap_or_else(|e| fail!("BadMessage({e})"))
}

#[near]
impl Contract {
    /// NEP-141 receiver. Only the configured WETH and USDC contracts may call
    /// it; the sender must be registered for storage, and pays for what the
    /// action stores. Returns the unused amount in token units.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let asset = self
            .asset_by_token(&token)
            .unwrap_or_else(|| fail!("AssetNotAllowed({token})"));
        let action = parse_msg(&msg);
        if amount.0 == 0 {
            fail("ZeroAmount");
        }
        self.assert_registered(&sender_id);
        let before = env::storage_usage();
        let refund = self.receive(&sender_id, asset, amount.0, action);
        self.charge_storage(&sender_id, before);
        PromiseOrValue::Value(U128(refund))
    }
}

impl Contract {
    /// Credits the transfer, runs the action and settles what is left of it.
    /// Returns the token units to hand back.
    pub(crate) fn receive(
        &mut self,
        sender: &AccountId,
        asset: Asset,
        token_amount: u128,
        action: Action,
    ) -> u128 {
        let credited = mul(token_amount, self.scale(asset));
        let held_before = self.real_balance(sender, asset);
        self.real_credit(sender, asset, credited);
        if let Action::Deposit(_) = action {
            RealDeposit {
                account_id: sender,
                asset,
                amount: U128(credited),
            }
            .emit();
            return 0;
        }
        self.dispatch(sender, asset, credited, action);
        self.settle_unused(sender, asset, credited, held_before)
    }

    /// What is left of this transfer is whatever the sender's balance in
    /// `asset` holds above where it started, never more than was credited.
    /// Whole token units of it go back; the remainder stays as dust.
    pub(crate) fn settle_unused(
        &mut self,
        sender: &AccountId,
        asset: Asset,
        credited: u128,
        held_before: u128,
    ) -> u128 {
        let scale = self.scale(asset);
        let unused = self
            .real_balance(sender, asset)
            .saturating_sub(held_before)
            .min(credited);
        let refund = unused / scale;
        if refund > 0 {
            self.real_debit(sender, asset, refund * scale);
        }
        refund
    }

    /// Runs one action for `sender` with `amount` (internal units) of `asset`
    /// just credited to their internal balance.
    fn dispatch(&mut self, sender: &AccountId, asset: Asset, amount: u128, action: Action) {
        match action {
            Action::Deposit(_) => {}
            Action::Split(m) => {
                let root = self.scenario(m.scenario_id).root();
                self.internal_split(sender, m.scenario_id, asset, root, &m.to_masks, amount);
            }
            Action::ConditionalSell(m) => self.ft_conditional_sell(sender, asset, amount, m),
            Action::ConditionalBuy(m) => self.ft_conditional_buy(sender, asset, amount, m),
            Action::SellAndBorrow(m) => self.ft_sell_and_borrow(sender, asset, amount, m),
            Action::PostOrder(m) => self.ft_post_order(sender, asset, amount, m),
            Action::Supply(m) => self.ft_supply(sender, asset, amount, m),
            Action::Repay(m) => self.ft_repay(sender, asset, amount, m),
            Action::DepositCollateral(m) => self.ft_deposit_collateral(sender, asset, amount, m),
            Action::Liquidate(m) => self.ft_liquidate(sender, asset, amount, m),
            Action::CloseAfterResolution(m) => {
                self.ft_close_after_resolution(sender, asset, amount, m)
            }
            Action::LpDeposit(m) => self.ft_lp_deposit(sender, asset, amount, m),
            Action::SpotSwap(m) => self.ft_spot_swap(sender, asset, amount, m),
        }
    }
}
