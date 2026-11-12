//! Constant-product pool with full-range concentrated-liquidity semantics.
//!
//! Every pool the protocol creates holds full-range liquidity only, which behaves as `x * y = L^2`. This module keeps
//! the parts of that design the protocol relies on:
//!
//! - the LP fee is charged on the input and kept out of the curve:
//!   `a_eff = floor(a * (1e6 - f) / 1e6)`, `out = floor(R_out * a_eff / (R_in + a_eff))`;
//! - fees accrue per unit of liquidity (Q128 fee growth, wrapping), so positions earn them separately and the
//!   Root LP can see "fees earned" apart from principal;
//! - adding liquidity takes amounts rounded up, removing pays them rounded down;
//! - a quote is the swap computed on the same state, so quote equals execution.
//!
//! Reserves are the pool's actual balances. The tokens a pool owns are `reserve + fees` per side, where `fees` is
//! what swaps paid in fees and positions have not collected yet (plus rounding dust that nobody can claim).
//!
//! A liquidity change does not pay a position's fees out. It credits them to the position's owed tokens and
//! [`Pool::collect`] pays them, so a caller that wants them paid at once collects right after.
//!
//! Every operation validates before it changes anything: on `Err` neither the pool nor the position moved.

use core::fmt;

use borsh::{BorshDeserialize, BorshSerialize};

use crate::fixed::{
    checked_mul_div, checked_mul_div_u256, isqrt_u256, isqrt_u512, Rounding, Q128, U256, U512, WAD,
};
use crate::price;

/// Fee denominator: fees are in pips, 1e6 = 100%.
pub const FEE_DENOMINATOR: u32 = 1_000_000;

/// Why a pool operation was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CpmmError {
    /// A zero amount or zero liquidity was asked for (or a deposit too small to mint one liquidity unit).
    ZeroAmount,
    /// A target price of zero.
    ZeroPrice,
    /// The pool has no liquidity, so it has no price and cannot swap.
    NoLiquidity,
    /// `mint_initial` on a pool that already has liquidity.
    PoolNotEmpty,
    /// Removing more liquidity than the position (or the pool) holds.
    InsufficientLiquidity {
        /// Liquidity asked for.
        requested: u128,
        /// Liquidity there is.
        available: u128,
    },
    /// An exact-output swap asking for the whole reserve or more; a constant-product pool never pays that.
    InsufficientReserve {
        /// Output asked for.
        requested: u128,
        /// Reserve of the output token.
        reserve: u128,
    },
    /// A fee above 100% (or exactly 100% where the input could never move the price).
    InvalidFee(u32),
    /// A reserve, a fee balance or a result would not fit a `u128`.
    Overflow,
}

impl fmt::Display for CpmmError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CpmmError::ZeroAmount => f.write_str("ZeroAmount"),
            CpmmError::ZeroPrice => f.write_str("ZeroPrice"),
            CpmmError::NoLiquidity => f.write_str("NoLiquidity"),
            CpmmError::PoolNotEmpty => f.write_str("PoolNotEmpty"),
            CpmmError::InsufficientLiquidity {
                requested,
                available,
            } => {
                write!(f, "InsufficientLiquidity({requested}, {available})")
            }
            CpmmError::InsufficientReserve { requested, reserve } => {
                write!(f, "InsufficientReserve({requested}, {reserve})")
            }
            CpmmError::InvalidFee(fee) => write!(f, "InvalidFee({fee})"),
            CpmmError::Overflow => f.write_str("Overflow"),
        }
    }
}

impl std::error::Error for CpmmError {}

/// Reserves, total liquidity and fee accounting of one pool.
#[derive(Clone, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(borsh::BorshSchema))]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Pool {
    #[cfg_attr(feature = "serde", serde(with = "crate::serde_impls::u128_string"))]
    reserve0: u128,
    #[cfg_attr(feature = "serde", serde(with = "crate::serde_impls::u128_string"))]
    reserve1: u128,
    #[cfg_attr(feature = "serde", serde(with = "crate::serde_impls::u128_string"))]
    liquidity: u128,
    fee_growth0_x128: U256,
    fee_growth1_x128: U256,
    #[cfg_attr(feature = "serde", serde(with = "crate::serde_impls::u128_string"))]
    fees0: u128,
    #[cfg_attr(feature = "serde", serde(with = "crate::serde_impls::u128_string"))]
    fees1: u128,
}

/// One owner's share of a pool: liquidity units, fee checkpoints and fees credited but not collected.
#[derive(Clone, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(borsh::BorshSchema))]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Position {
    #[cfg_attr(feature = "serde", serde(with = "crate::serde_impls::u128_string"))]
    liquidity: u128,
    fee_growth0_last_x128: U256,
    fee_growth1_last_x128: U256,
    #[cfg_attr(feature = "serde", serde(with = "crate::serde_impls::u128_string"))]
    tokens_owed0: u128,
    #[cfg_attr(feature = "serde", serde(with = "crate::serde_impls::u128_string"))]
    tokens_owed1: u128,
}

/// Outcome of a swap, exact input or exact output.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SwapResult {
    /// True when token0 went in and token1 came out.
    pub zero_for_one: bool,
    /// What the swapper paid, fee included.
    pub amount_in: u128,
    /// What the swapper received.
    pub amount_out: u128,
    /// The part of `amount_in` kept for liquidity providers, outside the curve.
    pub fee_amount: u128,
}

impl SwapResult {
    /// The input that entered the curve.
    pub fn amount_in_after_fee(&self) -> u128 {
        self.amount_in - self.fee_amount
    }
}

/// Outcome of a liquidity deposit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Deposit {
    /// Liquidity units minted to the position.
    pub liquidity: u128,
    /// Token0 the pool took.
    pub amount0: u128,
    /// Token1 the pool took.
    pub amount1: u128,
}

/// The single exact-input swap that moves a pool's price to a target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MoveTo {
    /// Direction of the swap.
    pub zero_for_one: bool,
    /// Input to pay, fee included.
    pub amount_in: u128,
}

impl Pool {
    /// An empty pool; it gets a price with [`Pool::mint_initial`].
    pub fn new() -> Self {
        Self::default()
    }

    /// Token0 in the curve.
    pub fn reserve0(&self) -> u128 {
        self.reserve0
    }

    /// Token1 in the curve.
    pub fn reserve1(&self) -> u128 {
        self.reserve1
    }

    /// `(reserve0, reserve1)`.
    pub fn reserves(&self) -> (u128, u128) {
        (self.reserve0, self.reserve1)
    }

    /// Total liquidity units (the sum over positions).
    pub fn liquidity(&self) -> u128 {
        self.liquidity
    }

    /// True when the pool holds no liquidity (and so no reserves).
    pub fn is_empty(&self) -> bool {
        self.liquidity == 0
    }

    /// Cumulative fees per liquidity unit, Q128, wrapping: `(token0, token1)`.
    pub fn fee_growth_x128(&self) -> (U256, U256) {
        (self.fee_growth0_x128, self.fee_growth1_x128)
    }

    /// Fee tokens the pool holds outside the curve, owed to positions or left as dust: `(token0, token1)`.
    pub fn fees(&self) -> (u128, u128) {
        (self.fees0, self.fees1)
    }

    /// Token1 per token0 (WAD), the exact reserve ratio rounded down; `None` while empty.
    pub fn price_wad(&self) -> Option<u128> {
        if self.is_empty() {
            return None;
        }
        price::price_from_reserves(self.reserve0, self.reserve1)
    }

    /// `floor(sqrt(reserve1 / reserve0) * 2^96)`; `None` while empty.
    pub fn sqrt_price_x96(&self) -> Option<U256> {
        if self.is_empty() {
            return None;
        }
        price::sqrt_price_x96_from_reserves(self.reserve0, self.reserve1)
    }

    /// The tick a TWAP observation records for the current reserves (clamped to the tick range); `None` while empty.
    pub fn tick(&self) -> Option<i32> {
        if self.is_empty() {
            return None;
        }
        price::tick_from_reserves(self.reserve0, self.reserve1)
    }

    /// Most liquidity `amount0` and `amount1` can buy at the current reserves:
    /// `min(floor(amount0 * L / reserve0), floor(amount1 * L / reserve1))` (the binding side is used almost fully).
    /// For an empty pool, what [`Pool::mint_initial`] would mint: `isqrt(amount0 * amount1)`. Saturates at
    /// `u128::MAX`.
    pub fn liquidity_for_amounts(&self, amount0: u128, amount1: u128) -> u128 {
        if self.is_empty() {
            return initial_liquidity(amount0, amount1);
        }
        let by0 = checked_mul_div(amount0, self.liquidity, self.reserve0, Rounding::Down)
            .unwrap_or(u128::MAX);
        let by1 = checked_mul_div(amount1, self.liquidity, self.reserve1, Rounding::Down)
            .unwrap_or(u128::MAX);
        by0.min(by1)
    }

    /// Tokens backing `liquidity` units at the current reserves: `liquidity * reserve / L` per side, rounded as asked
    /// (up for what a depositor pays, down for what a withdrawal or a holdings view returns).
    pub fn amounts_for_liquidity(
        &self,
        liquidity: u128,
        rounding: Rounding,
    ) -> Result<(u128, u128), CpmmError> {
        if self.is_empty() {
            return Err(CpmmError::NoLiquidity);
        }
        let amount0 = checked_mul_div(liquidity, self.reserve0, self.liquidity, rounding)
            .ok_or(CpmmError::Overflow)?;
        let amount1 = checked_mul_div(liquidity, self.reserve1, self.liquidity, rounding)
            .ok_or(CpmmError::Overflow)?;
        Ok((amount0, amount1))
    }

    /// First deposit into an empty pool: the pool takes both amounts in full, which sets its price, and mints
    /// `isqrt(amount0 * amount1)` liquidity to `position`.
    pub fn mint_initial(
        &mut self,
        position: &mut Position,
        amount0: u128,
        amount1: u128,
    ) -> Result<u128, CpmmError> {
        if !self.is_empty() {
            return Err(CpmmError::PoolNotEmpty);
        }
        if amount0 == 0 || amount1 == 0 {
            return Err(CpmmError::ZeroAmount);
        }
        let liquidity = initial_liquidity(amount0, amount1);
        let position_liquidity = position
            .liquidity
            .checked_add(liquidity)
            .ok_or(CpmmError::Overflow)?;
        position.accrue(self);
        position.liquidity = position_liquidity;
        self.liquidity = liquidity;
        self.reserve0 = amount0;
        self.reserve1 = amount1;
        Ok(liquidity)
    }

    /// Adds exactly `liquidity` units to `position`; the pool takes `ceil(liquidity * reserve / L)` of each token.
    /// Fees the position earned so far are credited to it first.
    pub fn add_liquidity(
        &mut self,
        position: &mut Position,
        liquidity: u128,
    ) -> Result<(u128, u128), CpmmError> {
        if liquidity == 0 {
            return Err(CpmmError::ZeroAmount);
        }
        let (amount0, amount1) = self.amounts_for_liquidity(liquidity, Rounding::Up)?;
        let total = self
            .liquidity
            .checked_add(liquidity)
            .ok_or(CpmmError::Overflow)?;
        let reserve0 = self
            .reserve0
            .checked_add(amount0)
            .ok_or(CpmmError::Overflow)?;
        let reserve1 = self
            .reserve1
            .checked_add(amount1)
            .ok_or(CpmmError::Overflow)?;
        let position_liquidity = position
            .liquidity
            .checked_add(liquidity)
            .ok_or(CpmmError::Overflow)?;
        position.accrue(self);
        position.liquidity = position_liquidity;
        self.liquidity = total;
        self.reserve0 = reserve0;
        self.reserve1 = reserve1;
        Ok((amount0, amount1))
    }

    /// Deposits at most `amount0_max` and `amount1_max`: the initial mint into an empty pool, otherwise the most
    /// liquidity both amounts allow (`ZeroAmount` if that is less than one unit). Returns what the pool took.
    pub fn deposit(
        &mut self,
        position: &mut Position,
        amount0_max: u128,
        amount1_max: u128,
    ) -> Result<Deposit, CpmmError> {
        if self.is_empty() {
            let liquidity = self.mint_initial(position, amount0_max, amount1_max)?;
            return Ok(Deposit {
                liquidity,
                amount0: amount0_max,
                amount1: amount1_max,
            });
        }
        let liquidity = self.liquidity_for_amounts(amount0_max, amount1_max);
        let (amount0, amount1) = self.add_liquidity(position, liquidity)?;
        Ok(Deposit {
            liquidity,
            amount0,
            amount1,
        })
    }

    /// Removes `liquidity` units from `position` and returns `floor(liquidity * reserve / L)` of each token. Fees the
    /// position earned so far are credited to it first; collect them with [`Pool::collect`].
    pub fn remove_liquidity(
        &mut self,
        position: &mut Position,
        liquidity: u128,
    ) -> Result<(u128, u128), CpmmError> {
        if liquidity == 0 {
            return Err(CpmmError::ZeroAmount);
        }
        let available = position.liquidity.min(self.liquidity);
        if liquidity > available {
            return Err(CpmmError::InsufficientLiquidity {
                requested: liquidity,
                available,
            });
        }
        let (amount0, amount1) = self.amounts_for_liquidity(liquidity, Rounding::Down)?;
        position.accrue(self);
        position.liquidity -= liquidity;
        self.liquidity -= liquidity;
        self.reserve0 -= amount0;
        self.reserve1 -= amount1;
        Ok((amount0, amount1))
    }

    /// Pays out every fee `position` has earned: credits what accrued since its last checkpoint, then returns and
    /// clears its owed tokens.
    pub fn collect(&mut self, position: &mut Position) -> (u128, u128) {
        position.accrue(self);
        let owed = (position.tokens_owed0, position.tokens_owed1);
        // Positions are credited floor(growth * liquidity / 2^128) out of fees the pool received, so the pool
        // always holds at least what any position can collect; failing here means a position from another pool.
        self.fees0 = self
            .fees0
            .checked_sub(owed.0)
            .expect("collected fees exceed the pool's fee balance");
        self.fees1 = self
            .fees1
            .checked_sub(owed.1)
            .expect("collected fees exceed the pool's fee balance");
        position.tokens_owed0 = 0;
        position.tokens_owed1 = 0;
        owed
    }

    /// The swap [`Pool::swap_exact_in`] would make, without making it.
    pub fn quote_exact_in(
        &self,
        zero_for_one: bool,
        amount_in: u128,
        fee_pips: u32,
    ) -> Result<SwapResult, CpmmError> {
        if fee_pips > FEE_DENOMINATOR {
            return Err(CpmmError::InvalidFee(fee_pips));
        }
        if amount_in == 0 {
            return Err(CpmmError::ZeroAmount);
        }
        if self.is_empty() {
            return Err(CpmmError::NoLiquidity);
        }
        let (reserve_in, reserve_out, fees_in) = self.sides(zero_for_one);
        let after_fee = checked_mul_div(
            amount_in,
            u128::from(FEE_DENOMINATOR - fee_pips),
            u128::from(FEE_DENOMINATOR),
            Rounding::Down,
        )
        .expect("at most amount_in");
        let fee_amount = amount_in - after_fee;
        let new_reserve_in = reserve_in
            .checked_add(after_fee)
            .ok_or(CpmmError::Overflow)?;
        fees_in.checked_add(fee_amount).ok_or(CpmmError::Overflow)?;
        // reserve_out * after_fee / (reserve_in + after_fee) < reserve_out, since reserve_in > 0.
        let amount_out = checked_mul_div(reserve_out, after_fee, new_reserve_in, Rounding::Down)
            .expect("below reserve_out");
        Ok(SwapResult {
            zero_for_one,
            amount_in,
            amount_out,
            fee_amount,
        })
    }

    /// Exact-input swap at `fee_pips`: the input after the fee enters the curve, the output is the constant-product
    /// amount rounded down, and the fee accrues to liquidity providers. Zero output is allowed (dust in).
    pub fn swap_exact_in(
        &mut self,
        zero_for_one: bool,
        amount_in: u128,
        fee_pips: u32,
    ) -> Result<SwapResult, CpmmError> {
        let swap = self.quote_exact_in(zero_for_one, amount_in, fee_pips)?;
        self.apply(&swap);
        Ok(swap)
    }

    /// The swap [`Pool::swap_exact_out`] would make, without making it.
    pub fn quote_exact_out(
        &self,
        zero_for_one: bool,
        amount_out: u128,
        fee_pips: u32,
    ) -> Result<SwapResult, CpmmError> {
        if fee_pips >= FEE_DENOMINATOR {
            return Err(CpmmError::InvalidFee(fee_pips));
        }
        if amount_out == 0 {
            return Err(CpmmError::ZeroAmount);
        }
        if self.is_empty() {
            return Err(CpmmError::NoLiquidity);
        }
        let (reserve_in, reserve_out, fees_in) = self.sides(zero_for_one);
        if amount_out >= reserve_out {
            return Err(CpmmError::InsufficientReserve {
                requested: amount_out,
                reserve: reserve_out,
            });
        }
        // The least curve input that releases amount_out, then the least gross input whose fee leaves that much.
        let into_curve = checked_mul_div(
            reserve_in,
            amount_out,
            reserve_out - amount_out,
            Rounding::Up,
        )
        .ok_or(CpmmError::Overflow)?;
        let amount_in = checked_mul_div(
            into_curve,
            u128::from(FEE_DENOMINATOR),
            u128::from(FEE_DENOMINATOR - fee_pips),
            Rounding::Up,
        )
        .ok_or(CpmmError::Overflow)?;
        let fee_amount = amount_in - into_curve;
        reserve_in
            .checked_add(into_curve)
            .ok_or(CpmmError::Overflow)?;
        fees_in.checked_add(fee_amount).ok_or(CpmmError::Overflow)?;
        Ok(SwapResult {
            zero_for_one,
            amount_in,
            amount_out,
            fee_amount,
        })
    }

    /// Exact-output swap at `fee_pips`: the swapper receives exactly `amount_out` and pays the least input that
    /// covers it on the curve plus the fee, both rounded up (the usual exact-output rule). Only tests and order-flow
    /// fixtures need it; protocol trades are exact input.
    pub fn swap_exact_out(
        &mut self,
        zero_for_one: bool,
        amount_out: u128,
        fee_pips: u32,
    ) -> Result<SwapResult, CpmmError> {
        let swap = self.quote_exact_out(zero_for_one, amount_out, fee_pips)?;
        self.apply(&swap);
        Ok(swap)
    }

    /// The one exact-input swap at `fee_pips` that brings the price (token1 per token0, WAD) to `target_price`, or
    /// `None` when the pool is already there (to within one unit of reserve).
    ///
    /// Closed form for `x * y = k`: moving down, token0 goes in until `x' = isqrt(k * 1e18 / target)`; moving up,
    /// token1 goes in until `y' = isqrt(k * target / 1e18)`. The input is `ceil((x' - x) * 1e6 / (1e6 - f))`, which
    /// puts exactly `x' - x` into the curve. The price lands on the target or just above it (moving down), or just
    /// below it (moving up), off by about `2 / x'` relative.
    pub fn plan_move_to(
        &self,
        target_price: u128,
        fee_pips: u32,
    ) -> Result<Option<MoveTo>, CpmmError> {
        if fee_pips >= FEE_DENOMINATOR {
            return Err(CpmmError::InvalidFee(fee_pips));
        }
        if target_price == 0 {
            return Err(CpmmError::ZeroPrice);
        }
        if self.is_empty() {
            return Err(CpmmError::NoLiquidity);
        }
        let (x, y) = (U256::from(self.reserve0), U256::from(self.reserve1));
        let k = U512::from(x * y);
        let wad = U512::from(WAD);
        let target = U512::from(target_price);
        let (zero_for_one, into_curve) =
            match (y * U256::from(WAD)).cmp(&(x * U256::from(target_price))) {
                core::cmp::Ordering::Equal => return Ok(None),
                core::cmp::Ordering::Greater => {
                    let x_target = u128::try_from(isqrt_u512(k * wad / target))
                        .map_err(|_| CpmmError::Overflow)?;
                    if x_target <= self.reserve0 {
                        return Ok(None);
                    }
                    (true, x_target - self.reserve0)
                }
                core::cmp::Ordering::Less => {
                    let y_target = u128::try_from(isqrt_u512(k * target / wad))
                        .map_err(|_| CpmmError::Overflow)?;
                    if y_target <= self.reserve1 {
                        return Ok(None);
                    }
                    (false, y_target - self.reserve1)
                }
            };
        let amount_in = checked_mul_div(
            into_curve,
            u128::from(FEE_DENOMINATOR),
            u128::from(FEE_DENOMINATOR - fee_pips),
            Rounding::Up,
        )
        .ok_or(CpmmError::Overflow)?;
        Ok(Some(MoveTo {
            zero_for_one,
            amount_in,
        }))
    }

    /// `(reserve_in, reserve_out, fees_in)` for a swap direction.
    fn sides(&self, zero_for_one: bool) -> (u128, u128, u128) {
        if zero_for_one {
            (self.reserve0, self.reserve1, self.fees0)
        } else {
            (self.reserve1, self.reserve0, self.fees1)
        }
    }

    /// Books a swap the quote functions accepted (they already ruled out every overflow).
    fn apply(&mut self, swap: &SwapResult) {
        let into_curve = swap.amount_in_after_fee();
        // fee < 2^128, so fee * 2^128 fits 256 bits.
        let growth = (U256::from(swap.fee_amount) << 128) / U256::from(self.liquidity);
        if swap.zero_for_one {
            self.reserve0 += into_curve;
            self.reserve1 -= swap.amount_out;
            self.fees0 += swap.fee_amount;
            self.fee_growth0_x128 = self.fee_growth0_x128.overflowing_add(growth).0;
        } else {
            self.reserve1 += into_curve;
            self.reserve0 -= swap.amount_out;
            self.fees1 += swap.fee_amount;
            self.fee_growth1_x128 = self.fee_growth1_x128.overflowing_add(growth).0;
        }
    }
}

impl Position {
    /// An empty position.
    pub fn new() -> Self {
        Self::default()
    }

    /// Liquidity units held.
    pub fn liquidity(&self) -> u128 {
        self.liquidity
    }

    /// Fees credited at the last checkpoint and not collected yet: `(token0, token1)`.
    pub fn tokens_owed(&self) -> (u128, u128) {
        (self.tokens_owed0, self.tokens_owed1)
    }

    /// True when the position holds nothing (no liquidity, nothing owed), so its storage can be freed.
    pub fn is_empty(&self) -> bool {
        self.liquidity == 0 && self.tokens_owed0 == 0 && self.tokens_owed1 == 0
    }

    /// Everything `collect` would pay right now: owed tokens plus fees accrued since the last checkpoint.
    pub fn pending_fees(&self, pool: &Pool) -> (u128, u128) {
        let (accrued0, accrued1) = self.accrued_since_checkpoint(pool);
        (
            self.tokens_owed0.saturating_add(accrued0),
            self.tokens_owed1.saturating_add(accrued1),
        )
    }

    /// Credits fees accrued since the last checkpoint to the owed tokens and moves the checkpoint to now. A position
    /// must be checkpointed before its liquidity changes; the pool methods do it.
    pub fn accrue(&mut self, pool: &Pool) {
        let (accrued0, accrued1) = self.accrued_since_checkpoint(pool);
        self.tokens_owed0 = crate::fixed::add(self.tokens_owed0, accrued0);
        self.tokens_owed1 = crate::fixed::add(self.tokens_owed1, accrued1);
        self.fee_growth0_last_x128 = pool.fee_growth0_x128;
        self.fee_growth1_last_x128 = pool.fee_growth1_x128;
    }

    fn accrued_since_checkpoint(&self, pool: &Pool) -> (u128, u128) {
        (
            fees_for(
                pool.fee_growth0_x128,
                self.fee_growth0_last_x128,
                self.liquidity,
            ),
            fees_for(
                pool.fee_growth1_x128,
                self.fee_growth1_last_x128,
                self.liquidity,
            ),
        )
    }
}

/// `floor((growth - last) * liquidity / 2^128)`, the subtraction wrapping.
fn fees_for(growth: U256, last: U256, liquidity: u128) -> u128 {
    let delta = growth.overflowing_sub(last).0;
    // Only a position checkpointed against another pool could owe more than a u128.
    checked_mul_div_u256(delta, U256::from(liquidity), Q128, Rounding::Down)
        .and_then(|fees| u128::try_from(fees).ok())
        .unwrap_or_else(|| panic!("Overflow"))
}

fn initial_liquidity(amount0: u128, amount1: u128) -> u128 {
    // The square root of a product of two u128 values is below 2^128.
    isqrt_u256(U256::from(amount0) * U256::from(amount1)).low_u128()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool(reserve0: u128, reserve1: u128) -> (Pool, Position) {
        let mut pool = Pool::new();
        let mut lp = Position::new();
        pool.mint_initial(&mut lp, reserve0, reserve1).unwrap();
        (pool, lp)
    }

    #[test]
    fn golden_demo_sale() {
        // The demo's thin pool: 2 wNEAR into 40 wNEAR / 100,000 USDC at 0.30% gives 4,748.29 USDC; 1 wNEAR gives 2,431.88.
        let (thin, _) = pool(40 * WAD, 100_000 * WAD);
        let two = thin.quote_exact_in(true, 2 * WAD, 3000).unwrap();
        assert_eq!(two.amount_out, 4_748_297_375_815_592_703_719);
        assert_eq!(two.fee_amount, 6_000_000_000_000_000);
        let one = thin.quote_exact_in(true, WAD, 3000).unwrap();
        assert_eq!(one.amount_out, 2_431_885_259_897_065_638_949);
    }

    #[test]
    fn first_deposit_sets_price_and_liquidity() {
        let (pool, lp) = pool(100 * WAD, 370_000 * WAD);
        assert_eq!(pool.liquidity(), lp.liquidity());
        // The seed table: L = sqrt(100 * 370,000) = 6,082.76e18.
        assert_eq!(pool.liquidity() / WAD, 6_082);
        assert_eq!(pool.price_wad(), Some(3_700 * WAD));
        assert_eq!(pool.reserves(), (100 * WAD, 370_000 * WAD));
    }

    #[test]
    fn errors() {
        let mut empty = Pool::new();
        let mut lp = Position::new();
        assert_eq!(
            empty.quote_exact_in(true, 1, 3000),
            Err(CpmmError::NoLiquidity)
        );
        assert_eq!(
            empty.quote_exact_out(true, 1, 3000),
            Err(CpmmError::NoLiquidity)
        );
        assert_eq!(empty.add_liquidity(&mut lp, 1), Err(CpmmError::NoLiquidity));
        assert_eq!(
            empty.mint_initial(&mut lp, 0, 1),
            Err(CpmmError::ZeroAmount)
        );
        assert_eq!(empty.plan_move_to(WAD, 3000), Err(CpmmError::NoLiquidity));
        assert_eq!(empty.price_wad(), None);
        assert_eq!(empty.tick(), None);
        let (mut p, mut lp) = pool(10, 10);
        assert_eq!(p.mint_initial(&mut lp, 1, 1), Err(CpmmError::PoolNotEmpty));
        assert_eq!(p.quote_exact_in(true, 0, 3000), Err(CpmmError::ZeroAmount));
        assert_eq!(p.quote_exact_out(true, 0, 3000), Err(CpmmError::ZeroAmount));
        assert_eq!(
            p.quote_exact_in(true, 1, 1_000_001),
            Err(CpmmError::InvalidFee(1_000_001))
        );
        assert_eq!(
            p.quote_exact_out(true, 1, 1_000_000),
            Err(CpmmError::InvalidFee(1_000_000))
        );
        assert_eq!(
            p.quote_exact_out(false, 10, 3000),
            Err(CpmmError::InsufficientReserve {
                requested: 10,
                reserve: 10
            })
        );
        assert_eq!(
            p.plan_move_to(WAD, 1_000_000),
            Err(CpmmError::InvalidFee(1_000_000))
        );
        assert_eq!(p.plan_move_to(0, 3000), Err(CpmmError::ZeroPrice));
        assert_eq!(
            p.remove_liquidity(&mut lp, 11),
            Err(CpmmError::InsufficientLiquidity {
                requested: 11,
                available: 10
            })
        );
        assert_eq!(p.remove_liquidity(&mut lp, 0), Err(CpmmError::ZeroAmount));
        assert_eq!(
            p.quote_exact_in(true, u128::MAX, 0),
            Err(CpmmError::Overflow)
        );
        assert_eq!(
            CpmmError::InsufficientLiquidity {
                requested: 11,
                available: 10
            }
            .to_string(),
            "InsufficientLiquidity(11, 10)"
        );
        assert_eq!(
            CpmmError::InsufficientReserve {
                requested: 3,
                reserve: 2
            }
            .to_string(),
            "InsufficientReserve(3, 2)"
        );
        // Nothing moved.
        assert_eq!((p.reserve0(), p.reserve1(), p.liquidity()), (10, 10, 10));
    }

    #[test]
    fn dust_swap_pays_only_the_fee() {
        let (mut p, _) = pool(40 * WAD, 100_000 * WAD);
        let swap = p.swap_exact_in(false, 1, 3000).unwrap();
        assert_eq!(
            swap,
            SwapResult {
                zero_for_one: false,
                amount_in: 1,
                amount_out: 0,
                fee_amount: 1
            }
        );
        assert_eq!(p.reserves(), (40 * WAD, 100_000 * WAD));
        assert_eq!(p.fees(), (0, 1));
    }

    #[test]
    fn exact_out_pays_the_least_input_that_covers_the_output() {
        let (mut p, _) = pool(40 * WAD, 100_000 * WAD);
        let quote = p.quote_exact_out(false, WAD, 3000).unwrap();
        // 100,000 * 1 / 39 USDC into the curve, rounded up, then grossed up for the 0.30% fee.
        let into_curve = (100_000 * WAD).div_ceil(39);
        assert_eq!(quote.amount_in_after_fee(), into_curve);
        assert_eq!(quote.amount_in, (into_curve * 1_000_000).div_ceil(997_000));
        // The same input as an exact-input swap buys at least the output, and the fee is the same.
        let as_exact_in = p.quote_exact_in(false, quote.amount_in, 3000).unwrap();
        assert!(as_exact_in.amount_out >= WAD);
        assert_eq!(as_exact_in.fee_amount, quote.fee_amount);
        let swap = p.swap_exact_out(false, WAD, 3000).unwrap();
        assert_eq!(swap, quote);
        assert_eq!(p.reserves(), (39 * WAD, 100_000 * WAD + into_curve));
        assert_eq!(p.fees(), (0, quote.fee_amount));
    }

    #[test]
    fn full_withdrawal_empties_the_pool() {
        let (mut p, mut lp) = pool(3 * WAD, 7 * WAD);
        p.swap_exact_in(true, WAD / 10, 3000).unwrap();
        let liquidity = lp.liquidity();
        let (out0, out1) = p.remove_liquidity(&mut lp, liquidity).unwrap();
        assert_eq!(
            (out0, out1),
            (
                3 * WAD + WAD / 10 - 300_000_000_000_000,
                p_reserve_out_after(7 * WAD)
            )
        );
        assert!(p.is_empty());
        assert_eq!(p.reserves(), (0, 0));
        // The fee is still owed to the position, outside the reserves.
        assert_eq!(p.collect(&mut lp), (300_000_000_000_000 - 1, 0));
        assert_eq!(p.fees(), (1, 0));
    }

    fn p_reserve_out_after(reserve1: u128) -> u128 {
        let after_fee = WAD / 10 - 300_000_000_000_000;
        reserve1 - reserve1 * after_fee / (3 * WAD + after_fee)
    }

    #[test]
    fn fees_split_by_liquidity_and_time() {
        // Two LPs with 1:3 liquidity share a swap's fee 1:3; an LP who joins later earns nothing from earlier swaps.
        let (mut p, mut a) = pool(1_000 * WAD, 1_000 * WAD);
        let mut b = Position::new();
        p.add_liquidity(&mut b, 3_000 * WAD).unwrap();
        let first = p.swap_exact_in(true, 10 * WAD, 3000).unwrap();
        let mut c = Position::new();
        p.add_liquidity(&mut c, 4_000 * WAD).unwrap();
        let fees_a = p.collect(&mut a);
        let fees_b = p.collect(&mut b);
        let fees_c = p.collect(&mut c);
        assert_eq!(fees_c, (0, 0));
        assert_eq!(fees_a.0, first.fee_amount / 4 - 1);
        assert_eq!(fees_b.0, first.fee_amount * 3 / 4 - 1);
        // Collecting again pays nothing new.
        assert_eq!(p.collect(&mut a), (0, 0));
        assert_eq!(p.fees().0, first.fee_amount - fees_a.0 - fees_b.0);
    }

    #[test]
    fn deposit_never_takes_more_than_offered() {
        let (mut p, _) = pool(40 * WAD, 100_000 * WAD);
        p.swap_exact_in(true, 3 * WAD, 3000).unwrap();
        let mut lp = Position::new();
        let deposit = p.deposit(&mut lp, 5 * WAD, 9_000 * WAD).unwrap();
        assert!(deposit.amount0 <= 5 * WAD && deposit.amount1 <= 9_000 * WAD);
        assert_eq!(lp.liquidity(), deposit.liquidity);
        // A deposit worth less than one liquidity unit on one side mints nothing.
        assert_eq!(
            p.deposit(&mut lp, 0, 9_000 * WAD),
            Err(CpmmError::ZeroAmount)
        );
    }

    #[test]
    fn move_to_lands_on_the_target() {
        // The pool seeder's walk-through moves a 3,000 pool to 3,200 then 2,900; the spot reset moves it to the implied spot.
        let (mut p, _) = pool(100 * WAD, 300_000 * WAD);
        for target in [3_200 * WAD, 2_900 * WAD, 3_037_866_632_000_000_000_000] {
            let plan = p.plan_move_to(target, 3000).unwrap().expect("a move");
            p.swap_exact_in(plan.zero_for_one, plan.amount_in, 3000)
                .unwrap();
            // Moving down (token0 in) lands at or just above the target, moving up at or just below.
            let (x, y) = (U256::from(p.reserve0()), U256::from(p.reserve1()));
            let scaled = y * U256::from(WAD);
            let at_target = x * U256::from(target);
            assert!(if plan.zero_for_one {
                scaled >= at_target
            } else {
                scaled <= at_target
            });
            let price = p.price_wad().unwrap();
            assert!(
                price.abs_diff(target) * 1_000_000_000_000_000 <= target,
                "{price} vs {target}"
            );
            // Planning again asks for nothing, or for dust the square-root floors left out (at most 1e-15 of the
            // input reserve; the reserves' integer granularity is all that separates the price from the target).
            let again = p.plan_move_to(target, 3000).unwrap();
            assert!(
                again.is_none_or(|m| {
                    let reserve_in = if m.zero_for_one {
                        p.reserve0()
                    } else {
                        p.reserve1()
                    };
                    m.amount_in * 1_000_000_000_000_000 <= reserve_in
                }),
                "{again:?}"
            );
        }
    }
}
