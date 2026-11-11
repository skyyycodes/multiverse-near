//! Money markets: supply, collateral, borrow, repay, worst-world health
//! factor and liquidation. Not built yet: the records below only
//! hold their place in the contract state, and the lending actions of
//! `ft_on_transfer` are not available.

use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{near, AccountId};

use crate::errors::not_implemented;
use crate::receiver::{LiquidateMsg, RepayMsg, ScenarioMsg};
use crate::types::Asset;
use crate::Contract;

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Market {}

/// One collateral piece: a real asset, or a verse token of the market's scenario.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CollateralKey {
    Real(Asset),
    Verse { asset: Asset, mask: u8 },
}

/// `"max"` or an amount, for `liquidate`'s `repay_amount`.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", untagged)]
pub enum RepayAmount {
    Max(MaxKeyword),
    Amount(U128),
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", rename_all = "lowercase")]
pub enum MaxKeyword {
    Max,
}

impl Contract {
    pub(crate) fn ft_supply(
        &mut self,
        _sender: &AccountId,
        _asset: Asset,
        _amount: u128,
        _msg: ScenarioMsg,
    ) {
        not_implemented("supply")
    }

    pub(crate) fn ft_repay(
        &mut self,
        _sender: &AccountId,
        _asset: Asset,
        _amount: u128,
        _msg: RepayMsg,
    ) {
        not_implemented("repay")
    }

    pub(crate) fn ft_deposit_collateral(
        &mut self,
        _sender: &AccountId,
        _asset: Asset,
        _amount: u128,
        _msg: ScenarioMsg,
    ) {
        not_implemented("deposit_collateral")
    }

    pub(crate) fn ft_liquidate(
        &mut self,
        _sender: &AccountId,
        _asset: Asset,
        _amount: u128,
        _msg: LiquidateMsg,
    ) {
        not_implemented("liquidate")
    }

    /// Must be true while `account_id` has supply, debt or collateral in any
    /// market; it blocks `storage_unregister`.
    pub(crate) fn has_lending_position(&self, _account_id: &AccountId) -> bool {
        false
    }

    /// Verse tokens of `key` held as collateral, for the conservation check in
    /// the tests.
    #[cfg(test)]
    pub(crate) fn collateral_holdings(&self, _key: &crate::types::VerseKey) -> u128 {
        0
    }
}
