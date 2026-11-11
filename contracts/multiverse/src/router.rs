//! Router: conditional sell and buy, sell-and-borrow, posting an order from
//! real assets, and closing a position after resolution.
//! Not built yet: these `ft_on_transfer` actions are not available.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::AccountId;

use crate::errors::not_implemented;
use crate::receiver::{
    ConditionalBuyMsg, ConditionalSellMsg, PostOrderMsg, ScenarioMsg, SellAndBorrowMsg,
};
use crate::types::Asset;
use crate::Contract;

/// One order fill in a sale plan: `{"order_id":"1","amount":"1000000000000000000"}`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct PlanFill {
    pub order_id: U64,
    pub amount: U128,
}

impl Contract {
    pub(crate) fn ft_conditional_sell(
        &mut self,
        _sender: &AccountId,
        _asset: Asset,
        _amount: u128,
        _msg: ConditionalSellMsg,
    ) {
        not_implemented("conditional_sell")
    }

    pub(crate) fn ft_conditional_buy(
        &mut self,
        _sender: &AccountId,
        _asset: Asset,
        _amount: u128,
        _msg: ConditionalBuyMsg,
    ) {
        not_implemented("conditional_buy")
    }

    pub(crate) fn ft_sell_and_borrow(
        &mut self,
        _sender: &AccountId,
        _asset: Asset,
        _amount: u128,
        _msg: SellAndBorrowMsg,
    ) {
        not_implemented("sell_and_borrow")
    }

    pub(crate) fn ft_post_order(
        &mut self,
        _sender: &AccountId,
        _asset: Asset,
        _amount: u128,
        _msg: PostOrderMsg,
    ) {
        not_implemented("post_order")
    }

    pub(crate) fn ft_close_after_resolution(
        &mut self,
        _sender: &AccountId,
        _asset: Asset,
        _amount: u128,
        _msg: ScenarioMsg,
    ) {
        not_implemented("close_after_resolution")
    }
}
