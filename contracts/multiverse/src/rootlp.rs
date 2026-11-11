//! Root LP vault: one deposit of real WETH and USDC provides liquidity in
//! every world of a scenario. Not built yet: the record below
//! only holds its place in the contract state, and the `lp_deposit` action is
//! not available.

use near_sdk::{near, AccountId};

use crate::errors::not_implemented;
use crate::receiver::LpDepositMsg;
use crate::types::Asset;
use crate::Contract;

/// Whether the Root LP is live; served to the app by `get_app_config`.
pub const ENABLED: bool = false;

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Vault {}

impl Contract {
    pub(crate) fn ft_lp_deposit(
        &mut self,
        _sender: &AccountId,
        _asset: Asset,
        _amount: u128,
        _msg: LpDepositMsg,
    ) {
        not_implemented("lp_deposit")
    }

    /// Must be true while `account_id` holds Root LP shares; it blocks
    /// `storage_unregister`.
    pub(crate) fn has_lp_shares(&self, _account_id: &AccountId) -> bool {
        false
    }

    /// Verse tokens of `key` held by Root LP vaults, for the conservation
    /// check in the tests.
    #[cfg(test)]
    pub(crate) fn vault_holdings(&self, _key: &crate::types::VerseKey) -> u128 {
        0
    }
}
