//! Real wNEAR/USDC come in through `ft_transfer_call` with an action in `msg`:
//! one signature, no approval, and whatever the action leaves unused goes
//! back to the sender through the token contract.
//!
//! Flow: convert the amount to internal units and credit them to the
//! sender's internal balance, run the action for the sender (it draws what it
//! uses from that balance), then hand back the part of this transfer still
//! sitting there. Only whole token units can go back; up to 18 decimals a
//! sub-unit remainder stays in the internal balance as dust. Above 18
//! decimals (wNEAR has 24) the raw units below one internal unit never enter
//! the ledger and go back as unused.
//! Any failed check panics, which rolls the receipt back and makes the token
//! contract refund everything.

use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{env, near, serde_json, AccountId, PromiseOrValue};

use crate::errors::fail;
use crate::events::{MultiverseEvent, RealDeposit};
use crate::ledger::LogScope;
use crate::lending::tiers::Tier;
use crate::lending::RepayAmount;
use crate::ops::PauseFlag;
use crate::orders::Side;
use crate::router::PlanFill;
use crate::types::Asset;
use crate::{Contract, ContractExt};

/// The `msg` of an `ft_transfer_call`, e.g. `{"action":"split","scenario_id":1,"to_masks":[5,10]}`.
/// An empty `msg` means `deposit`. Amounts are internal (18-decimal) units.
/// Unknown actions and unknown fields are rejected. Fields added in v2 are
/// optional (`tier` defaults to Normal, `receive` to tokens), so every v1 msg
/// parses with the same meaning.
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
    /// Attached USDC plus `wnear_amount` from the internal wNEAR balance.
    LpDeposit(LpDepositMsg),
    /// Attached asset into the spot pool; the output is credited to the
    /// internal real balance.
    SpotSwap(SpotSwapMsg),
    /// Attached USDC into a market's insurance reserve.
    FundInsurance(FundInsuranceMsg),
    /// The attached asset pledged to a proposal.
    Pledge(PledgeMsg),
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
    /// The market the result goes into with `to_lending`; ignored otherwise.
    #[serde(default)]
    pub tier: Tier,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct ConditionalBuyMsg {
    pub scenario_id: u64,
    pub buy_mask: u8,
    pub plans: Vec<Vec<PlanFill>>,
    pub min_out: Vec<U128>,
    pub to_lending: bool,
    /// The market the result goes into with `to_lending`; ignored otherwise.
    #[serde(default)]
    pub tier: Tier,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct SellAndBorrowMsg {
    pub scenario_id: u64,
    pub sell_mask: u8,
    pub plans: Vec<Vec<PlanFill>>,
    pub min_out: Vec<U128>,
    pub borrow_amount: U128,
    #[serde(default)]
    pub tier: Tier,
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
    #[serde(default)]
    pub tier: Tier,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct RepayMsg {
    pub scenario_id: u64,
    pub all: bool,
    #[serde(default)]
    pub tier: Tier,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct LiquidateMsg {
    pub scenario_id: u64,
    pub account_id: AccountId,
    pub repay_amount: RepayAmount,
    #[serde(default)]
    pub tier: Tier,
    #[serde(default)]
    pub receive: Receive,
    /// Required with `receive: "cash"`, refused otherwise.
    #[serde(default)]
    pub min_out: Option<U128>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct LpDepositMsg {
    pub scenario_id: u64,
    pub wnear_amount: U128,
    pub min_shares: U128,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct SpotSwapMsg {
    pub min_out: U128,
}

/// What a liquidator takes: the seized pieces as tokens (default), or sold
/// for real USDC in the same receipt.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Receive {
    #[default]
    Tokens,
    Cash,
}

/// Attached USDC into a market's insurance reserve; it cannot be taken back.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct FundInsuranceMsg {
    pub scenario_id: u64,
    #[serde(default)]
    pub tier: Tier,
}

/// The attached wNEAR or USDC pledged to a proposal.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct PledgeMsg {
    pub proposal_id: u64,
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
    /// NEP-141 receiver. Only the configured wNEAR and USDC contracts may call
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
        // every action logs as one group of lines (ledger.rs, LogScope)
        let scope = LogScope::open();
        let refund = self.receive(&sender_id, asset, amount.0, action);
        drop(scope);
        self.charge_storage(&sender_id, before);
        PromiseOrValue::Value(U128(refund))
    }
}

impl Contract {
    /// Credits the transfer, runs the action and settles what is left of it.
    /// Returns the token units to hand back: what the action left unused plus
    /// the remainder below one internal unit.
    pub(crate) fn receive(
        &mut self,
        sender: &AccountId,
        asset: Asset,
        token_amount: u128,
        action: Action,
    ) -> u128 {
        let (credited, remainder) = self
            .asset_cfg(asset)
            .to_internal(token_amount)
            .unwrap_or_else(|| fail("ArithmeticOverflow"));
        if credited == 0 {
            fail("ZeroAmount");
        }
        let held_before = self.real_balance(sender, asset);
        self.real_credit(sender, asset, credited);
        if let Action::Deposit(_) = action {
            RealDeposit {
                account_id: sender,
                asset,
                amount: U128(credited),
            }
            .emit();
            return remainder;
        }
        self.dispatch(sender, asset, credited, action);
        self.settle_unused(sender, asset, credited, held_before) + remainder
    }

    /// What is left of this transfer is whatever the sender's balance in
    /// `asset` holds above where it started, never more than was credited.
    /// Whole token units of it go back (`to_raw`); the dust below one token
    /// unit stays in the internal balance. Returns the token units.
    pub(crate) fn settle_unused(
        &mut self,
        sender: &AccountId,
        asset: Asset,
        credited: u128,
        held_before: u128,
    ) -> u128 {
        let unused = self
            .real_balance(sender, asset)
            .saturating_sub(held_before)
            .min(credited);
        // cannot overflow: `unused` is at most what came in as `to_internal`
        let (refund, dust) = self
            .asset_cfg(asset)
            .to_raw(unused)
            .unwrap_or_else(|| fail("ArithmeticOverflow"));
        if refund > 0 {
            self.real_debit(sender, asset, unused - dust);
        }
        refund
    }

    /// Runs one action for `sender` with `amount` (internal units) of `asset`
    /// just credited to their internal balance. The action's pause flags are
    /// checked first, so a paused action fails `Paused(<flag>)` and the token
    /// refunds the whole transfer.
    fn dispatch(&mut self, sender: &AccountId, asset: Asset, amount: u128, action: Action) {
        self.assert_action_live(&action);
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
            Action::FundInsurance(m) => self.ft_fund_insurance(sender, asset, amount, m),
            Action::Pledge(m) => self.ft_pledge(sender, asset, amount, m),
        }
    }

    /// The pause flags of each action. Deposits, repayments, collateral
    /// top-ups and insurance donations are never paused.
    fn assert_action_live(&self, action: &Action) {
        match action {
            Action::Deposit(_)
            | Action::Repay(_)
            | Action::DepositCollateral(_)
            | Action::FundInsurance(_) => {}
            Action::Split(_) | Action::LpDeposit(_) => self.assert_live(PauseFlag::Mint),
            Action::ConditionalSell(m) => self.assert_trade_live(m.to_lending),
            Action::ConditionalBuy(m) => self.assert_trade_live(m.to_lending),
            Action::SellAndBorrow(_) => self.assert_trade_live(true),
            Action::PostOrder(_) | Action::SpotSwap(_) => self.assert_live(PauseFlag::Trade),
            Action::Supply(_) => self.assert_live(PauseFlag::Lend),
            Action::Liquidate(m) => self.liquidation_gate(m.receive),
            Action::CloseAfterResolution(_) => self.assert_live(PauseFlag::Exit),
            Action::Pledge(_) => self.assert_live(PauseFlag::Pledge),
        }
    }
}
