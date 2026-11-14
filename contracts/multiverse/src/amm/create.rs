//! Opening pools (owner only) and moving the spot pool's price.
//!
//! A pool is born with liquidity, so its price is the ratio of what the owner
//! puts in. The owner's position is an ordinary one: its fees can be
//! collected and its liquidity removed like anybody's.

use multiverse_math::cpmm;
use multiverse_math::flow::SwapFlow;
use multiverse_math::twap::TwapOracle;
use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, near, AccountId};

use super::events::PoolCreated;
use super::{Pool, PoolKind, Position, SPOT_FEE_PIPS};
use crate::errors::fail;
use crate::events::MultiverseEvent;
use crate::masks;
use crate::ops::PauseFlag;
use crate::types::{Asset, VerseKey};
use crate::{now_sec, Contract, ContractExt};

/// Who seeds a new pool: the owner from its balances, or the contract from
/// tokens already in its custody (a market opened from pledges).
#[derive(Clone, Copy)]
pub(crate) enum PoolFunding<'a> {
    Owner(&'a AccountId),
    Custody,
}

/// The swap `move_spot_to` made.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpotMove {
    pub zero_for_one: bool,
    pub amount_in: U128,
    pub amount_out: U128,
}

#[near]
impl Contract {
    /// Opens world `world`'s pool of wNEAR-if-w and USDC-if-w, priced at
    /// `usdc_amount / wnear_amount`, with both amounts taken from the owner's
    /// verse balances. The attached deposit (or the owner's storage balance)
    /// pays for the new state.
    #[payable]
    pub fn create_within_pool(
        &mut self,
        scenario_id: u64,
        world: u8,
        wnear_amount: U128,
        usdc_amount: U128,
    ) -> u64 {
        self.assert_live(PauseFlag::Mint);
        self.assert_owner();
        let world_count = self.scenario(scenario_id).world_count;
        if world >= world_count {
            fail!("InvalidWorld({world})");
        }
        let mask = 1 << world;
        let kind = self.admit_pair(
            VerseKey::new(scenario_id, Asset::Wnear, mask),
            VerseKey::new(scenario_id, Asset::Usdc, mask),
        );
        self.open_pool(scenario_id, kind, wnear_amount.0, usdc_amount.0)
    }

    /// Opens the pool of USDC-if-`mask_x` against USDC-if-`mask_y` (disjoint),
    /// whose price is the odds of X against Y: reserves are inversely
    /// proportional to odds, so `amount_x : amount_y = q_y : q_x`. Both
    /// amounts come from the owner's verse balances.
    #[payable]
    pub fn create_between_pool(
        &mut self,
        scenario_id: u64,
        mask_x: u8,
        mask_y: u8,
        amount_x: U128,
        amount_y: U128,
    ) -> u64 {
        self.assert_live(PauseFlag::Mint);
        self.assert_owner();
        let kind = self.admit_pair(
            VerseKey::new(scenario_id, Asset::Usdc, mask_x),
            VerseKey::new(scenario_id, Asset::Usdc, mask_y),
        );
        let (amount0, amount1) = if mask_x < mask_y {
            (amount_x.0, amount_y.0)
        } else {
            (amount_y.0, amount_x.0)
        };
        self.open_pool(scenario_id, kind, amount0, amount1)
    }

    /// Opens the one spot pool of real wNEAR and USDC, with both amounts taken
    /// from the owner's internal real balances. It outlives every scenario.
    #[payable]
    pub fn create_spot_pool(&mut self, wnear_amount: U128, usdc_amount: U128) -> u64 {
        self.assert_live(PauseFlag::Mint);
        self.assert_owner();
        if let Some(id) = self.spot_pool {
            fail!("AlreadyInitialized({id})");
        }
        self.open_pool(0, PoolKind::Spot, wnear_amount.0, usdc_amount.0)
    }

    /// Moves the spot pool to `price` (USDC per wNEAR, WAD) with the one
    /// exact-input swap at 0.30% that lands there, paid from and received into
    /// the owner's internal real balances. Null when the pool is already at
    /// the price. A demo reset re-prices the spot pool this way, since it
    /// outlives the scenarios.
    #[payable]
    pub fn move_spot_to(&mut self, price: U128) -> Option<SpotMove> {
        assert_one_yocto();
        self.assert_live(PauseFlag::Trade);
        self.assert_owner();
        let pool_id = self.spot_pool.unwrap_or_else(|| fail("NoSpotPool"));
        let plan = self
            .pool(pool_id)
            .amm
            .plan_move_to(price.0, SPOT_FEE_PIPS)
            .unwrap_or_else(|e| fail!("{e}"))?;
        let owner = env::predecessor_account_id();
        let before = env::storage_usage();
        let amount_out =
            self.swap_exact_in_for(&owner, pool_id, plan.zero_for_one, plan.amount_in, 0);
        self.charge_storage(&owner, before);
        Some(SpotMove {
            zero_for_one: plan.zero_for_one,
            amount_in: U128(plan.amount_in),
            amount_out: U128(amount_out),
        })
    }
}

impl Contract {
    /// The admission rule for a pool of `a` and `b`, without the fee
    /// and tick-spacing checks, which mean nothing here. In order: both are
    /// verse tokens (the root mask is the real asset itself); of one scenario;
    /// within-world (wNEAR-if-w and USDC-if-w of one world) or between-world
    /// (two disjoint USDC verses, siblings or not); both live; no pool for the
    /// pair yet. Token0 is the lower key: wNEAR in a within-world pool, the
    /// lower mask in a between-world pool.
    pub(crate) fn admit_pair(&self, a: VerseKey, b: VerseKey) -> PoolKind {
        let (k0, k1) = if a <= b { (a, b) } else { (b, a) };
        self.check_verse_token(&k0);
        self.check_verse_token(&k1);
        if k0.scenario != k1.scenario {
            fail!("DifferentScenarios({}, {})", k0.scenario, k1.scenario);
        }
        let kind = if k0.mask == k1.mask
            && k0.asset == Asset::Wnear
            && k1.asset == Asset::Usdc
            && masks::is_single_world(k0.mask)
        {
            PoolKind::Within {
                world: masks::lowest_world(k0.mask),
            }
        } else if k0.asset == Asset::Usdc && k1.asset == Asset::Usdc && k0.mask & k1.mask == 0 {
            PoolKind::Between {
                mask0: k0.mask,
                mask1: k1.mask,
            }
        } else {
            fail!("UnsupportedPair({}, {})", k0.token_id(), k1.token_id())
        };
        // Liveness after the classification, so a dead unsupported pair still
        // reports UnsupportedPair.
        let s = self.scenario(k0.scenario);
        for mask in [k0.mask, k1.mask] {
            if !s.is_live(mask) {
                fail!("DeadVerse({mask})");
            }
        }
        if let Some(id) = self.pool_of_kind(k0.scenario, kind) {
            fail!("AlreadyInitialized({id})");
        }
        kind
    }

    fn check_verse_token(&self, key: &VerseKey) {
        let root = self.scenario(key.scenario).root();
        if key.mask == root {
            fail!("NotVerseToken({})", self.asset_cfg(key.asset).token_id);
        }
        if key.mask == 0 || key.mask & !root != 0 {
            fail!("NotVerseToken({})", key.token_id());
        }
    }

    pub(crate) fn pool_of_kind(&self, scenario_id: u64, kind: PoolKind) -> Option<u64> {
        match kind {
            PoolKind::Within { world } => self.world_pool(scenario_id, world),
            PoolKind::Between { mask0, mask1 } => {
                self.between.get(&(scenario_id, mask0, mask1)).copied()
            }
            PoolKind::Spot => self.spot_pool,
        }
    }

    /// Registers a pool whose admission passed and seeds it with the owner's
    /// `amount0` and `amount1`; the attached deposit (or the owner's storage
    /// balance) pays for the new state.
    fn open_pool(&mut self, scenario_id: u64, kind: PoolKind, amount0: u128, amount1: u128) -> u64 {
        let owner = env::predecessor_account_id();
        let before = env::storage_usage();
        let (id, _) = self.open_pool_core(
            scenario_id,
            kind,
            amount0,
            amount1,
            PoolFunding::Owner(&owner),
        );
        self.charge_storage_or_deposit(&owner, before);
        id
    }

    /// Registers a pool whose admission passed, seeded with `amount0` and
    /// `amount1`; verse pools start their TWAP here. The owner's pool takes
    /// them from the owner's balances and stores the owner's position (and
    /// records an Impact Meter point for a world pool); a custody pool's
    /// tokens are already in the contract's custody and its position is
    /// returned to the caller, which holds it (a market opened from pledges
    /// records one Impact Meter point once all its pools exist).
    pub(crate) fn open_pool_core(
        &mut self,
        scenario_id: u64,
        kind: PoolKind,
        amount0: u128,
        amount1: u128,
        funding: PoolFunding,
    ) -> (u64, Position) {
        if amount0 == 0 || amount1 == 0 {
            fail("ZeroAmount");
        }
        let mut amm = cpmm::Pool::new();
        let mut position = Position::new();
        let liquidity = amm
            .mint_initial(&mut position, amount0, amount1)
            .unwrap_or_else(|e| fail!("{e}"));
        let twap = match (kind, amm.tick()) {
            (PoolKind::Spot, _) | (_, None) => TwapOracle::default(),
            (_, Some(tick)) => TwapOracle::new(now_sec(), tick),
        };
        let pool = Pool {
            kind,
            scenario_id,
            amm,
            flow: SwapFlow::new(),
            twap,
        };
        let (token0, token1) = pool.tokens();
        let account = match funding {
            PoolFunding::Owner(owner) => {
                self.pay_in(owner, &[(token0, amount0), (token1, amount1)]);
                owner.clone()
            }
            PoolFunding::Custody => env::current_account_id(),
        };

        self.pool_count += 1;
        let id = self.pool_count;
        match kind {
            PoolKind::Within { world } => {
                self.within.insert((scenario_id, world), id);
            }
            PoolKind::Between { mask0, mask1 } => {
                self.between.insert((scenario_id, mask0, mask1), id);
            }
            PoolKind::Spot => self.spot_pool = Some(id),
        }
        if let Some(s) = self.scenarios.get_mut(&scenario_id) {
            s.pool_ids.push(id);
        }
        let (mask0, mask1) = pool.masks();
        let price = pool.amm.price_wad().unwrap_or(0);
        self.pools.insert(id, pool);
        if let PoolFunding::Owner(owner) = funding {
            self.put_position(id, owner, Some(position.clone()));
        }
        PoolCreated {
            pool_id: id,
            kind: kind.name(),
            scenario_id: (scenario_id != 0).then_some(scenario_id),
            mask0,
            mask1,
            account_id: &account,
            amount0: U128(amount0),
            amount1: U128(amount1),
            liquidity: U128(liquidity),
            price: U128(price),
        }
        .emit();
        if let (PoolKind::Within { .. }, PoolFunding::Owner(_)) = (kind, funding) {
            self.record_impact(scenario_id);
        }
        (id, position)
    }
}
