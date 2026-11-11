//! Pools: within-world (WETH-if-w / USDC-if-w), between-world (odds) and the
//! real WETH/USDC spot pool; swaps, liquidity, fees, TWAP and quotes.
//! Not built yet: the records below only hold their place in the
//! contract state, and the `spot_swap` action is not available.

use near_sdk::{near, AccountId};

use crate::errors::not_implemented;
use crate::receiver::SpotSwapMsg;
use crate::types::Asset;
use crate::Contract;

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Pool {}

/// A liquidity position, keyed by (pool id, account).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Position {}

/// The last 64 post-swap price points of a scenario, for the Impact Meter.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ImpactRing {}

#[cfg(test)]
thread_local! {
    /// Lending tests can price worlds without building pools; production reads the TWAP.
    pub(crate) static TEST_WORLD_PRICES: std::cell::RefCell<std::collections::HashMap<(u64, u8), (u128, bool)>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

impl Contract {
    /// WETH price in `world` of `scenario_id` for lending: the world pool's 60 s
    /// tick TWAP behind the depth gate, or `(0, false)` when there is no valid price.
    #[allow(dead_code)]
    pub(crate) fn world_price(&self, scenario_id: u64, world: u8) -> (u128, bool) {
        #[cfg(test)]
        if let Some(p) = TEST_WORLD_PRICES.with(|m| m.borrow().get(&(scenario_id, world)).copied())
        {
            return p;
        }
        let _ = (scenario_id, world);
        (0, false)
    }

    /// `ft_on_transfer` action `spot_swap`: `amount` (internal units) of
    /// `asset` was just credited to `sender`'s internal balance.
    pub(crate) fn ft_spot_swap(
        &mut self,
        _sender: &AccountId,
        _asset: Asset,
        _amount: u128,
        _msg: SpotSwapMsg,
    ) {
        not_implemented("spot_swap")
    }

    /// Must be true while `account_id` has liquidity or unclaimed fees in any
    /// pool; it blocks `storage_unregister`.
    pub(crate) fn has_pool_positions(&self, _account_id: &AccountId) -> bool {
        false
    }

    /// Verse tokens of `key` held by pools (reserves plus unclaimed fees),
    /// for the conservation check in the tests.
    #[cfg(test)]
    pub(crate) fn pool_holdings(&self, _key: &crate::types::VerseKey) -> u128 {
        0
    }
}
