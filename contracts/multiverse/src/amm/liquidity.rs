//! Full-range liquidity: add, remove, collect fees. None of these is ever
//! blocked: not while the scenario is halted, not in a pool touching a dead
//! verse (the EVM hook never saw liquidity changes). As in v4, every change
//! to a position also pays out the fees it has earned.

use multiverse_math::cpmm;
use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, near, AccountId};

use super::events::Liquidity;
use super::Pool;
use crate::errors::add;
use crate::events::MultiverseEvent;
use crate::{now_sec, Contract, ContractExt};

/// What a liquidity call moved, in pool token order.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiquidityResult {
    pub liquidity: U128,
    pub amount0: U128,
    pub amount1: U128,
    pub fees0: U128,
    pub fees1: U128,
}

#[near]
impl Contract {
    /// Adds the most liquidity `amount0` and `amount1` allow at the pool's
    /// price (an empty pool takes both and is priced by them). The binding
    /// side is used almost fully, the other partly; amounts round up.
    #[payable]
    pub fn add_liquidity(
        &mut self,
        pool_id: u64,
        amount0: U128,
        amount1: U128,
        min_liquidity: U128,
    ) -> LiquidityResult {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        let mut pool = self.pool(pool_id).clone();
        let mut position = self.position(pool_id, &account);
        let was_empty = pool.amm.is_empty();
        let deposit = pool
            .amm
            .deposit(&mut position, amount0.0, amount1.0)
            .unwrap_or_else(|e| fail!("{e}"));
        if deposit.liquidity < min_liquidity.0 {
            fail!(
                "TooLittleLiquidity({}, {})",
                deposit.liquidity,
                min_liquidity.0
            );
        }
        // A drained pool gets a new price from this deposit; the TWAP has to
        // know, or it would keep weighting the old tick.
        if was_empty && !pool.is_spot() {
            if let Some(tick) = pool.amm.tick() {
                pool.twap.write(now_sec(), tick);
            }
        }
        let fees = pool.amm.collect(&mut position);
        let (t0, t1) = pool.tokens();
        self.pay_in(&account, &[(t0, deposit.amount0), (t1, deposit.amount1)]);
        self.pay_out(&account, &[(t0, fees.0), (t1, fees.1)]);
        let result = LiquidityResult {
            liquidity: U128(deposit.liquidity),
            amount0: U128(deposit.amount0),
            amount1: U128(deposit.amount1),
            fees0: U128(fees.0),
            fees1: U128(fees.1),
        };
        self.store_position(pool_id, &account, pool, position, "add", &result);
        self.charge_storage(&account, before);
        result
    }

    /// Removes `liquidity` units of the caller's position and pays out what
    /// backs them (rounded down) plus every fee the position earned.
    #[payable]
    pub fn remove_liquidity(
        &mut self,
        pool_id: u64,
        liquidity: U128,
        min0: U128,
        min1: U128,
    ) -> LiquidityResult {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        let mut pool = self.pool(pool_id).clone();
        let mut position = self.position(pool_id, &account);
        let (amount0, amount1) = pool
            .amm
            .remove_liquidity(&mut position, liquidity.0)
            .unwrap_or_else(|e| fail!("{e}"));
        if amount0 < min0.0 {
            fail!("TooLittleReceived({amount0}, {})", min0.0);
        }
        if amount1 < min1.0 {
            fail!("TooLittleReceived({amount1}, {})", min1.0);
        }
        let fees = pool.amm.collect(&mut position);
        let (t0, t1) = pool.tokens();
        self.pay_out(
            &account,
            &[(t0, add(amount0, fees.0)), (t1, add(amount1, fees.1))],
        );
        let result = LiquidityResult {
            liquidity,
            amount0: U128(amount0),
            amount1: U128(amount1),
            fees0: U128(fees.0),
            fees1: U128(fees.1),
        };
        self.store_position(pool_id, &account, pool, position, "remove", &result);
        self.charge_storage(&account, before);
        result
    }

    /// Pays out the fees the caller's position has earned.
    #[payable]
    pub fn collect_fees(&mut self, pool_id: u64) -> LiquidityResult {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        let mut pool = self.pool(pool_id).clone();
        if !self.positions.contains_key(&(pool_id, account.clone())) {
            fail!("NoPosition({pool_id}, {account})");
        }
        let mut position = self.position(pool_id, &account);
        let fees = pool.amm.collect(&mut position);
        let (t0, t1) = pool.tokens();
        self.pay_out(&account, &[(t0, fees.0), (t1, fees.1)]);
        let result = LiquidityResult {
            liquidity: U128(0),
            amount0: U128(0),
            amount1: U128(0),
            fees0: U128(fees.0),
            fees1: U128(fees.1),
        };
        self.store_position(pool_id, &account, pool, position, "collect", &result);
        self.charge_storage(&account, before);
        result
    }
}

impl Contract {
    /// The account's position in the pool; empty if it has none.
    pub(crate) fn position(&self, pool_id: u64, account: &AccountId) -> cpmm::Position {
        self.positions
            .get(&(pool_id, account.clone()))
            .cloned()
            .unwrap_or_default()
    }

    /// Writes the pool and the position back (an empty position is deleted,
    /// which frees its storage) and logs the change.
    fn store_position(
        &mut self,
        pool_id: u64,
        account: &AccountId,
        pool: Pool,
        position: cpmm::Position,
        action: &'static str,
        result: &LiquidityResult,
    ) {
        self.pools.insert(pool_id, pool);
        let key = (pool_id, account.clone());
        if position.is_empty() {
            self.positions.remove(&key);
        } else {
            self.positions.insert(key, position);
        }
        Liquidity {
            pool_id,
            account_id: account,
            action,
            liquidity: result.liquidity,
            amount0: result.amount0,
            amount1: result.amount1,
            fees0: result.fees0,
            fees1: result.fees1,
        }
        .emit();
    }
}
