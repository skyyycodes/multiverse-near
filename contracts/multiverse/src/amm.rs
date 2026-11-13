//! Pools. Each one is a constant-product pool with full-range
//! semantics (the maths crate's `cpmm`): the fee is charged on the input and
//! kept outside the curve for the liquidity providers, outputs round down.
//!
//! - Within-world: wNEAR-if-w (token0) against USDC-if-w (token1), one per
//!   world. Lending prices collateral from its tick TWAP; the app reads its
//!   current price, its quotes and the Impact Meter.
//! - Between-world: two disjoint USDC verses of one scenario, the lower mask
//!   as token0. Its price is the odds of one verse against the other.
//! - Spot: real wNEAR against real USDC drawn from internal balances, a static
//!   0.30% fee, no TWAP, never halted.
//!
//! Verse pools keep these rules: no swap while the
//! scenario is halted, none in a pool touching a dead verse (halt checked
//! first), a fee from the last 8 swaps' flow computed before the swap and
//! recorded after it, and a TWAP observation after every swap. Liquidity can
//! always be added, removed and collected.
//!
//! What a verse pool holds (reserves, plus fees not collected yet) stays in
//! the verse supply and leaves the holders' balances through the ledger's
//! custody helpers. The spot pool's wNEAR and USDC come out of internal real
//! balances, so the contract's token holdings are the internal balances, the
//! scenario reserves and the spot pool's reserves and fees.

pub mod create;
pub mod events;
pub mod liquidity;
pub mod trade;
pub mod views;

use multiverse_math::cpmm;
use multiverse_math::flow::SwapFlow;
use multiverse_math::twap::TwapOracle;
use near_sdk::{near, AccountId};

use crate::errors::fail;
use crate::events::MultiverseEvent;
use crate::prices::WorldStatus;
use crate::types::{Asset, VerseKey};
use crate::{now_sec, Contract};

pub use multiverse_math::cpmm::Position;

/// Fee of the spot pool, in pips (0.30%).
pub const SPOT_FEE_PIPS: u32 = 3_000;
/// Price points the Impact Meter keeps per scenario.
pub const IMPACT_POINTS: usize = 64;

/// A pool prices lending only once its history is this long. Until it is a
/// full TWAP window old, the mean runs over the whole history.
pub const TWAP_MIN_AGE_SEC: u64 = 60;

/// Lending refuses a world's price while the pool's current tick is more
/// than this far from its TWAP (about 10%). Moving a pool and acting before
/// the TWAP catches up is the manipulation; waiting it out means holding the
/// mispriced pool against arbitrage for a whole window.
pub const MAX_SPOT_TWAP_TICKS: i32 = 953;

/// What a pool trades. Token0 is wNEAR-if-w in a within-world pool and the
/// lower mask in a between-world pool, so the fee window and the TWAP always
/// measure token0 and a within-world price is USDC per wNEAR, rounded down.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoolKind {
    Within {
        world: u8,
    },
    /// `mask0 < mask1`, disjoint.
    Between {
        mask0: u8,
        mask1: u8,
    },
    Spot,
}

impl PoolKind {
    pub fn name(self) -> &'static str {
        match self {
            PoolKind::Within { .. } => "within",
            PoolKind::Between { .. } => "between",
            PoolKind::Spot => "spot",
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pool {
    pub kind: PoolKind,
    /// 0 for the spot pool, which belongs to no scenario.
    pub scenario_id: u64,
    pub amm: cpmm::Pool,
    /// Token0 volume of the last 8 swaps. The spot pool never records any.
    pub flow: SwapFlow,
    /// Empty for the spot pool.
    pub twap: TwapOracle,
}

/// One side of a pool.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoolToken {
    Verse(VerseKey),
    Real(Asset),
}

impl Pool {
    pub fn tokens(&self) -> (PoolToken, PoolToken) {
        let verse = |asset, mask| PoolToken::Verse(VerseKey::new(self.scenario_id, asset, mask));
        match self.kind {
            PoolKind::Within { world } => (
                verse(Asset::Wnear, 1 << world),
                verse(Asset::Usdc, 1 << world),
            ),
            PoolKind::Between { mask0, mask1 } => {
                (verse(Asset::Usdc, mask0), verse(Asset::Usdc, mask1))
            }
            PoolKind::Spot => (PoolToken::Real(Asset::Wnear), PoolToken::Real(Asset::Usdc)),
        }
    }

    /// Masks of token0 and token1; zeros for the spot pool.
    pub fn masks(&self) -> (u8, u8) {
        match self.kind {
            PoolKind::Within { world } => (1 << world, 1 << world),
            PoolKind::Between { mask0, mask1 } => (mask0, mask1),
            PoolKind::Spot => (0, 0),
        }
    }

    pub fn is_spot(&self) -> bool {
        self.kind == PoolKind::Spot
    }
}

/// The last `IMPACT_POINTS` post-swap price points of a scenario, oldest
/// first, for the Impact Meter (NEAR has no log queries to rebuild it from).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ImpactRing {
    points: Vec<ImpactSample>,
}

/// Every world's current pool price (USDC per wNEAR, 0 without a pool).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImpactSample {
    pub at_sec: u64,
    pub prices: Vec<u128>,
}

impl ImpactRing {
    /// Swaps in the same second leave one point, the state after the last of
    /// them, as the TWAP keeps one observation per second.
    pub fn record(&mut self, at_sec: u64, prices: Vec<u128>) {
        match self.points.last_mut() {
            Some(last) if last.at_sec == at_sec => last.prices = prices,
            _ => {
                if self.points.len() == IMPACT_POINTS {
                    self.points.remove(0);
                }
                self.points.push(ImpactSample { at_sec, prices });
            }
        }
    }

    pub fn points(&self) -> &[ImpactSample] {
        &self.points
    }
}

/// Test hooks: lending and market tests can price worlds and set odds without
/// building pools; production reads the pools.
#[cfg(test)]
pub(crate) mod test_hooks {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use crate::prices::WorldStatus;

    /// What `world_quote` returns for one world instead of reading its pool.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct TestQuote {
        pub twap: u128,
        pub spot: u128,
        pub status: WorldStatus,
        pub full_window: bool,
    }

    thread_local! {
        pub static TEST_WORLD_QUOTES: RefCell<HashMap<(u64, u8), TestQuote>> = RefCell::new(HashMap::new());
        pub static TEST_ODDS: RefCell<HashMap<u64, Vec<u128>>> = RefCell::new(HashMap::new());
    }

    pub fn set_quote(sid: u64, world: u8, quote: TestQuote) {
        TEST_WORLD_QUOTES.with(|m| m.borrow_mut().insert((sid, world), quote));
    }

    /// A trusted, full-window world at `price` (spot = TWAP).
    pub fn set_price(sid: u64, world: u8, price: u128) {
        set_quote(
            sid,
            world,
            TestQuote {
                twap: price,
                spot: price,
                status: WorldStatus::Trusted,
                full_window: true,
            },
        );
    }

    /// A world without a lending price.
    pub fn set_unpriced(sid: u64, world: u8) {
        set_quote(
            sid,
            world,
            TestQuote {
                twap: 0,
                spot: 0,
                status: WorldStatus::Shallow,
                full_window: true,
            },
        );
    }

    pub fn set_odds(sid: u64, odds: Vec<u128>) {
        TEST_ODDS.with(|m| m.borrow_mut().insert(sid, odds));
    }

    /// Forgets every quote and every odds override.
    pub fn clear() {
        TEST_WORLD_QUOTES.with(|m| m.borrow_mut().clear());
        TEST_ODDS.with(|m| m.borrow_mut().clear());
    }

    pub fn quote(sid: u64, world: u8) -> Option<TestQuote> {
        TEST_WORLD_QUOTES.with(|m| m.borrow().get(&(sid, world)).copied())
    }

    pub fn odds(sid: u64) -> Option<Vec<u128>> {
        TEST_ODDS.with(|m| m.borrow().get(&sid).cloned())
    }
}

impl Contract {
    /// wNEAR price in `world` of `scenario_id` for lending, as v1 reads it:
    /// the world pool's TWAP price when the world is trusted, else
    /// `(0, false)`.
    pub(crate) fn world_price(&self, scenario_id: u64, world: u8) -> (u128, bool) {
        let cfg = self.price_cfg(scenario_id);
        let q = self.world_quote(scenario_id, world, &cfg);
        if q.status == WorldStatus::Trusted {
            (q.twap, true)
        } else {
            (0, false)
        }
    }

    /// Mean tick over the TWAP window, or over the pool's whole history while
    /// it is younger than the window; None before `TWAP_MIN_AGE_SEC`.
    pub(crate) fn pool_mean_tick(&self, pool: &Pool) -> Option<i32> {
        let now = now_sec();
        let first = pool.twap.observations().next()?.timestamp;
        let window = self.params.twap_window_sec.min(now.saturating_sub(first));
        if window < TWAP_MIN_AGE_SEC {
            return None;
        }
        pool.twap.mean_tick(now, window)
    }

    /// Observations at most every window / 64 seconds, so the 128 kept
    /// always span two windows however often the pool trades.
    pub(crate) fn twap_spacing(&self) -> u64 {
        (self.params.twap_window_sec / 64).max(1)
    }

    /// `ft_on_transfer` action `spot_swap`: `amount` (internal units) of
    /// `asset` was just credited to `sender`'s internal balance; all of it goes
    /// into the spot pool and the output lands in the other internal balance.
    pub(crate) fn ft_spot_swap(
        &mut self,
        sender: &AccountId,
        asset: Asset,
        amount: u128,
        msg: crate::receiver::SpotSwapMsg,
    ) {
        let pool_id = self.spot_pool.unwrap_or_else(|| fail("NoSpotPool"));
        self.swap_exact_in_for(
            sender,
            pool_id,
            asset == Asset::Wnear,
            amount,
            msg.min_out.0,
        );
    }

    /// True while `account_id` has liquidity or uncollected fees in any pool;
    /// it blocks `storage_unregister`. Empty positions are deleted, so a
    /// stored position always holds something.
    pub(crate) fn has_pool_positions(&self, account_id: &AccountId) -> bool {
        (1..=self.pool_count).any(|id| self.positions.contains_key(&(id, account_id.clone())))
    }

    /// Verse tokens of `key` held by pools (reserves plus uncollected fees),
    /// for the conservation check in the tests.
    #[cfg(test)]
    pub(crate) fn pool_holdings(&self, key: &VerseKey) -> u128 {
        let Some(s) = self.scenarios.get(&key.scenario) else {
            return 0;
        };
        s.pool_ids
            .iter()
            .map(|id| self.pool_side_holdings(*id, PoolToken::Verse(*key)))
            .sum()
    }

    /// Real wNEAR or USDC held by the spot pool (reserve plus uncollected
    /// fees), which the contract holds on the token beyond internal balances
    /// and scenario reserves.
    #[cfg(test)]
    pub(crate) fn spot_holdings(&self, asset: Asset) -> u128 {
        self.spot_pool
            .map_or(0, |id| self.pool_side_holdings(id, PoolToken::Real(asset)))
    }

    #[cfg(test)]
    fn pool_side_holdings(&self, pool_id: u64, token: PoolToken) -> u128 {
        let pool = self.pool(pool_id);
        let (t0, t1) = pool.tokens();
        let (r0, r1) = pool.amm.reserves();
        let (f0, f1) = pool.amm.fees();
        let mut held = 0;
        if t0 == token {
            held += r0 + f0;
        }
        if t1 == token {
            held += r1 + f1;
        }
        held
    }

    pub(crate) fn pool(&self, pool_id: u64) -> &Pool {
        self.pools
            .get(&pool_id)
            .unwrap_or_else(|| fail!("UnknownPool({pool_id})"))
    }

    /// The within-world pool of `world`, if it was created.
    pub(crate) fn world_pool(&self, scenario_id: u64, world: u8) -> Option<u64> {
        self.within.get(&(scenario_id, world)).copied()
    }

    /// The current price of `world`'s pool (USDC per wNEAR, WAD, rounded down),
    /// as the grid shows it; None without a pool.
    pub(crate) fn world_spot_price(&self, scenario_id: u64, world: u8) -> Option<u128> {
        let id = self.world_pool(scenario_id, world)?;
        self.pools.get(&id)?.amm.price_wad()
    }

    /// The fee the next swap in `pool` pays, in pips.
    pub(crate) fn next_fee(&self, pool: &Pool) -> u32 {
        if pool.is_spot() {
            return SPOT_FEE_PIPS;
        }
        pool.flow
            .fee(self.params.fee_base_pips, self.params.fee_cap_pips)
    }

    /// The checks run before every swap, in this order, then the
    /// fee the swap pays: a halted scenario, then a dead verse on either side
    /// (token0 first). The spot pool has neither and a static fee.
    pub(crate) fn swap_gate(&self, pool: &Pool) -> Result<u32, String> {
        if !pool.is_spot() {
            let s = self.scenario(pool.scenario_id);
            if self.halted(s) {
                return Err(format!("ScenarioHalted({})", pool.scenario_id));
            }
            let (mask0, mask1) = pool.masks();
            for mask in [mask0, mask1] {
                if !s.is_live(mask) {
                    return Err(format!("DeadVerse({mask})"));
                }
            }
        }
        Ok(self.next_fee(pool))
    }

    /// Books a swap the pool record already applied: moves the tokens, then,
    /// for verse pools, writes the TWAP observation and records the flow
    /// (both after the swap, as the hook did), adds an Impact Meter point for
    /// within-world pools and logs the swap.
    pub(crate) fn settle_swap(
        &mut self,
        account: &AccountId,
        pool_id: u64,
        mut pool: Pool,
        swap: &cpmm::SwapResult,
        fee_pips: u32,
    ) {
        let (t0, t1) = pool.tokens();
        let (token_in, token_out) = if swap.zero_for_one {
            (t0, t1)
        } else {
            (t1, t0)
        };
        self.pay_in(account, &[(token_in, swap.amount_in)]);
        self.pay_out(account, &[(token_out, swap.amount_out)]);
        if !pool.is_spot() {
            if let Some(tick) = pool.amm.tick() {
                pool.twap.write_spaced(now_sec(), tick, self.twap_spacing());
            }
            pool.flow
                .record_swap(swap.zero_for_one, swap.amount_in, swap.amount_out);
        }
        let price_after = pool.amm.price_wad().unwrap_or(0);
        let (kind, scenario_id) = (pool.kind, pool.scenario_id);
        self.pools.insert(pool_id, pool);
        if let PoolKind::Within { .. } = kind {
            self.record_impact(scenario_id);
        }
        events::Swap {
            pool_id,
            account_id: account,
            zero_for_one: swap.zero_for_one,
            amount_in: swap.amount_in.into(),
            amount_out: swap.amount_out.into(),
            fee_pips,
            price_after: price_after.into(),
        }
        .emit();
    }

    /// Takes `items` from `account` into a pool: verse tokens through the
    /// ledger's custody (one NEP-245 log), real assets out of the internal
    /// balance. Zero amounts are skipped.
    pub(crate) fn pay_in(&mut self, account: &AccountId, items: &[(PoolToken, u128)]) {
        let mut verse = Vec::new();
        for &(token, amount) in items {
            match token {
                _ if amount == 0 => {}
                PoolToken::Verse(key) => verse.push((key, amount)),
                PoolToken::Real(asset) => self.real_debit(account, asset, amount),
            }
        }
        if !verse.is_empty() {
            self.take_into_custody(account, &verse, None);
        }
    }

    /// Pays `items` out of a pool to `account`; the counterpart of `pay_in`.
    pub(crate) fn pay_out(&mut self, account: &AccountId, items: &[(PoolToken, u128)]) {
        let mut verse = Vec::new();
        for &(token, amount) in items {
            match token {
                _ if amount == 0 => {}
                PoolToken::Verse(key) => verse.push((key, amount)),
                PoolToken::Real(asset) => self.real_credit(account, asset, amount),
            }
        }
        if !verse.is_empty() {
            self.release_from_custody(account, &verse, None);
        }
    }

    /// Appends every world's current price to the scenario's Impact Meter.
    fn record_impact(&mut self, scenario_id: u64) {
        let world_count = self.scenario(scenario_id).world_count;
        let prices = (0..world_count)
            .map(|w| self.world_spot_price(scenario_id, w).unwrap_or(0))
            .collect();
        let mut ring = self.impact.get(&scenario_id).cloned().unwrap_or_default();
        ring.record(now_sec(), prices);
        self.impact.insert(scenario_id, ring);
    }
}
