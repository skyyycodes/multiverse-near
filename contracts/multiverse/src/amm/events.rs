//! Pool logs, standard "multiverse". They carry ids, masks and amounts only;
//! token ids and labels follow from the pool, which `get_pool` returns.

use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::AccountId;

use crate::events::MultiverseEvent;

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct PoolCreated<'a> {
    pub pool_id: u64,
    pub kind: &'static str,
    /// Absent for the spot pool.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scenario_id: Option<u64>,
    pub mask0: u8,
    pub mask1: u8,
    pub account_id: &'a AccountId,
    pub amount0: U128,
    pub amount1: U128,
    pub liquidity: U128,
    /// Token1 per token0, WAD.
    pub price: U128,
}

impl MultiverseEvent for PoolCreated<'_> {
    const NAME: &'static str = "pool_created";
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Swap<'a> {
    pub pool_id: u64,
    pub account_id: &'a AccountId,
    pub zero_for_one: bool,
    pub amount_in: U128,
    pub amount_out: U128,
    pub fee_pips: u32,
    /// Token1 per token0 after the swap, WAD: the world price in a
    /// within-world pool, which the Impact Meter plots.
    pub price_after: U128,
}

impl MultiverseEvent for Swap<'_> {
    const NAME: &'static str = "swap";
}

/// Liquidity added, removed, or only fees collected. `amount0/1` is what
/// went into (add) or came out of (remove) the reserves; `fees0/1` the fees
/// paid out with it, as v4 pays a position's fees on every change to it.
#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Liquidity<'a> {
    pub pool_id: u64,
    pub account_id: &'a AccountId,
    /// "add", "remove" or "collect".
    pub action: &'static str,
    pub liquidity: U128,
    pub amount0: U128,
    pub amount1: U128,
    pub fees0: U128,
    pub fees1: U128,
}

impl MultiverseEvent for Liquidity<'_> {
    const NAME: &'static str = "liquidity";
}
