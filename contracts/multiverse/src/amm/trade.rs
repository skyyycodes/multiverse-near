//! Swaps: the public method, the exact-input swap the router builds on, and
//! quotes, which run the same maths on the same state so they equal execution.

use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, near, AccountId};

use crate::errors::fail;
use crate::{Contract, ContractExt};

#[near]
impl Contract {
    /// Exact-input swap of `amount_in` of token0 (`zero_for_one`) or token1
    /// for the caller. Verse pools take and pay verse balances, the spot pool
    /// internal real balances. Returns the output.
    #[payable]
    pub fn swap(
        &mut self,
        pool_id: u64,
        zero_for_one: bool,
        amount_in: U128,
        min_out: U128,
    ) -> U128 {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        let out = self.swap_exact_in_for(&account, pool_id, zero_for_one, amount_in.0, min_out.0);
        self.charge_storage(&account, before);
        U128(out)
    }
}

impl Contract {
    /// Exact-input swap for `account`: takes `amount_in` from its verse (or,
    /// in the spot pool, internal real) balance and credits the output there.
    /// Check order as on the EVM: a zero amount, an unknown pool, then the
    /// hook's halt and dead-verse checks. Any input fills completely (dust can
    /// buy nothing, and is still taken); an empty pool fails `NoLiquidity`.
    pub(crate) fn swap_exact_in_for(
        &mut self,
        account: &AccountId,
        pool_id: u64,
        zero_for_one: bool,
        amount_in: u128,
        min_out: u128,
    ) -> u128 {
        if amount_in == 0 {
            fail("ZeroAmount");
        }
        let mut pool = self.pool(pool_id).clone();
        let fee = self.swap_gate(&pool).unwrap_or_else(|e| fail(&e));
        let swap = pool
            .amm
            .swap_exact_in(zero_for_one, amount_in, fee)
            .unwrap_or_else(|e| fail!("{e}"));
        if swap.amount_out < min_out {
            fail!("TooLittleReceived({}, {min_out})", swap.amount_out);
        }
        self.settle_swap(account, pool_id, pool, &swap, fee);
        swap.amount_out
    }

    /// What `swap_exact_in_for` would pay right now, or None where it would
    /// fail (zero amount, unknown or empty pool, halted scenario, dead verse).
    /// The swapper's balance is not checked.
    pub(crate) fn quote_exact_in(
        &self,
        pool_id: u64,
        zero_for_one: bool,
        amount_in: u128,
    ) -> Option<u128> {
        if amount_in == 0 {
            return None;
        }
        let pool = self.pools.get(&pool_id)?;
        let fee = self.swap_gate(pool).ok()?;
        let swap = pool.amm.quote_exact_in(zero_for_one, amount_in, fee).ok()?;
        Some(swap.amount_out)
    }
}

#[cfg(test)]
impl Contract {
    /// Exact-output swap, which only the fee tests need (the EVM suite buys
    /// exact amounts back to balance the fee window). Same gate and booking
    /// as an exact-input swap.
    pub(crate) fn swap_exact_out_for(
        &mut self,
        account: &AccountId,
        pool_id: u64,
        zero_for_one: bool,
        amount_out: u128,
    ) -> u128 {
        let mut pool = self.pool(pool_id).clone();
        let fee = self.swap_gate(&pool).unwrap_or_else(|e| fail(&e));
        let swap = pool
            .amm
            .swap_exact_out(zero_for_one, amount_out, fee)
            .unwrap_or_else(|e| fail!("{e}"));
        self.settle_swap(account, pool_id, pool, &swap, fee);
        swap.amount_in
    }
}
