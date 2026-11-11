//! Pool views and the lens maths: odds, implied spot, spot price and sale
//! quotes. Views only read; quotes run the swap maths on the stored pool
//! with the fee the next swap would pay, so they equal execution.

use multiverse_math::fixed::Rounding;
use multiverse_math::{odds, price};
use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

use super::{Pool, PoolKind, PoolToken};
use crate::{now_sec, Contract, ContractExt};

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolView {
    pub id: u64,
    /// "within", "between" or "spot".
    pub kind: String,
    /// Null for the spot pool.
    pub scenario_id: Option<u64>,
    /// The world of a within-world pool.
    pub world: Option<u8>,
    /// 0 for the spot pool.
    pub mask0: u8,
    pub mask1: u8,
    /// NEP-245 token ids of verse pools; the NEP-141 token accounts for spot.
    pub token0: String,
    pub token1: String,
    pub reserve0: U128,
    pub reserve1: U128,
    /// Null in a between-world pool, which holds no WETH side.
    pub weth_reserve: Option<U128>,
    pub usdc_reserve: Option<U128>,
    pub liquidity: U128,
    /// Fees held for liquidity providers, outside the reserves.
    pub fees0: U128,
    pub fees1: U128,
    /// The fee the next swap pays.
    pub fee_pips: u32,
    /// Swaps recorded in the fee window since creation.
    pub swap_count: u64,
    /// Token1 per token0 (USDC per WETH where WETH is token0), WAD, rounded
    /// down; "0" while the pool is empty.
    pub price: U128,
    /// Token1 per token0 at the mean tick of the TWAP window; null until the
    /// window has history, and always for the spot pool.
    pub twap_price: Option<U128>,
    /// For a within-world pool: whether lending can price the world (TWAP and
    /// the depth gate). For a between-world pool: whether there is a TWAP.
    pub twap_ok: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PositionView {
    pub liquidity: U128,
    /// What the liquidity is worth at the current reserves, rounded down.
    pub amount0: U128,
    pub amount1: U128,
    /// Fees `collect_fees` would pay now.
    pub fees0: U128,
    pub fees1: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OddsView {
    /// WAD per world; sums to exactly 1e18 over possible worlds when known.
    pub q: Vec<U128>,
    pub known: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SellPart {
    pub world: u8,
    pub weth_amount: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImpactPoint {
    pub at_sec: u64,
    /// Every world's pool price after the swap, "0" for a world without one.
    pub prices: Vec<U128>,
}

#[near]
impl Contract {
    /// Null for an unknown pool.
    pub fn get_pool(&self, pool_id: u64) -> Option<PoolView> {
        self.pools.get(&pool_id).map(|p| self.pool_view(pool_id, p))
    }

    pub fn get_spot_pool(&self) -> Option<PoolView> {
        self.spot_pool.and_then(|id| self.get_pool(id))
    }

    /// Every pool of the scenario, in creation order.
    pub fn pools_of(&self, scenario_id: u64) -> Vec<PoolView> {
        self.scenario(scenario_id)
            .pool_ids
            .iter()
            .filter_map(|id| self.get_pool(*id))
            .collect()
    }

    /// Null when the account has no position in the pool.
    pub fn position_of(&self, pool_id: u64, account_id: AccountId) -> Option<PositionView> {
        let position = self.positions.get(&(pool_id, account_id))?;
        let pool = self.pools.get(&pool_id)?;
        let (amount0, amount1) = pool
            .amm
            .amounts_for_liquidity(position.liquidity(), Rounding::Down)
            .unwrap_or((0, 0));
        let (fees0, fees1) = position.pending_fees(&pool.amm);
        Some(PositionView {
            liquidity: U128(position.liquidity()),
            amount0: U128(amount0),
            amount1: U128(amount1),
            fees0: U128(fees0),
            fees1: U128(fees1),
        })
    }

    /// For each world in `sell_mask`, the USDC-if-w that selling `weth_amount`
    /// WETH-if-w into its pool pays now; "0" for worlds not sold, without a
    /// pool, dead or halted. Worlds are quoted independently, without orders.
    pub fn quote_sell(&self, scenario_id: u64, weth_amount: U128, sell_mask: u8) -> Vec<U128> {
        let world_count = self.scenario(scenario_id).world_count;
        (0..world_count)
            .map(|w| {
                if sell_mask & (1 << w) == 0 {
                    return U128(0);
                }
                U128(self.quote_world_sale(scenario_id, w, weth_amount.0))
            })
            .collect()
    }

    /// One quote per part, in order, each against the current state.
    pub fn quote_sell_parts(&self, scenario_id: u64, parts: Vec<SellPart>) -> Vec<U128> {
        let world_count = self.scenario(scenario_id).world_count;
        parts
            .iter()
            .map(|p| {
                if p.world >= world_count {
                    return U128(0);
                }
                U128(self.quote_world_sale(scenario_id, p.world, p.weth_amount.0))
            })
            .collect()
    }

    pub fn odds(&self, scenario_id: u64) -> OddsView {
        let (q, known) = self.odds_of(scenario_id);
        OddsView {
            q: q.into_iter().map(U128).collect(),
            known,
        }
    }

    pub fn implied_spot(&self, scenario_id: u64) -> U128 {
        U128(self.implied_spot_of(scenario_id))
    }

    pub fn spot_price(&self) -> U128 {
        U128(self.spot_price_wad())
    }

    /// The scenario's last price points, oldest first.
    pub fn impact(&self, scenario_id: u64) -> Vec<ImpactPoint> {
        self.scenario(scenario_id);
        self.impact
            .get(&scenario_id)
            .map(|ring| {
                ring.points()
                    .iter()
                    .map(|p| ImpactPoint {
                        at_sec: p.at_sec,
                        prices: p.prices.iter().copied().map(U128).collect(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

impl Contract {
    /// Odds of every world from the between-world pools' current reserves:
    /// zeros and false when a split between two live verses has no pool.
    pub(crate) fn odds_of(&self, scenario_id: u64) -> (Vec<u128>, bool) {
        let s = self.scenario(scenario_id);
        let q = odds::odds(s.world_count, s.possible, |x, y| {
            // Tree pairs list the lower mask first, which is token0.
            let id = self.between.get(&(scenario_id, x, y))?;
            let (rx, ry) = self.pools.get(id)?.amm.reserves();
            odds::share_x(rx, ry)
        });
        match q {
            Some(q) => (q, true),
            None => (vec![0; usize::from(s.world_count)], false),
        }
    }

    /// `sum of floor(q_w * price_w)` over possible worlds with the current
    /// pool prices; 0 when the odds are unknown or a world has no pool.
    pub(crate) fn implied_spot_of(&self, scenario_id: u64) -> u128 {
        let (q, known) = self.odds_of(scenario_id);
        if !known {
            return 0;
        }
        let possible = self.scenario(scenario_id).possible;
        odds::implied_spot(&q, possible, |w| self.world_spot_price(scenario_id, w)).unwrap_or(0)
    }

    /// USDC per WETH in the spot pool, WAD; 0 without one.
    pub(crate) fn spot_price_wad(&self) -> u128 {
        self.spot_pool
            .and_then(|id| self.pools.get(&id))
            .and_then(|p| p.amm.price_wad())
            .unwrap_or(0)
    }

    fn quote_world_sale(&self, scenario_id: u64, world: u8, weth_amount: u128) -> u128 {
        self.world_pool(scenario_id, world)
            .and_then(|id| self.quote_exact_in(id, true, weth_amount))
            .unwrap_or(0)
    }

    fn pool_view(&self, id: u64, pool: &Pool) -> PoolView {
        let (t0, t1) = pool.tokens();
        let (r0, r1) = pool.amm.reserves();
        let (fees0, fees1) = pool.amm.fees();
        let (mask0, mask1) = pool.masks();
        let token_id = |t: PoolToken| match t {
            PoolToken::Verse(key) => key.token_id(),
            PoolToken::Real(asset) => self.asset_cfg(asset).token_id.to_string(),
        };
        let (world, weth_reserve, usdc_reserve) = match pool.kind {
            PoolKind::Within { world } => (Some(world), Some(U128(r0)), Some(U128(r1))),
            PoolKind::Spot => (None, Some(U128(r0)), Some(U128(r1))),
            PoolKind::Between { .. } => (None, None, None),
        };
        let twap_price = if pool.is_spot() {
            None
        } else {
            pool.twap
                .mean_tick(now_sec(), self.params.twap_window_sec)
                .and_then(price::from_tick)
        };
        let twap_ok = match pool.kind {
            PoolKind::Within { world } => self.world_price(pool.scenario_id, world).1,
            PoolKind::Between { .. } => twap_price.is_some(),
            PoolKind::Spot => false,
        };
        PoolView {
            id,
            kind: pool.kind.name().to_string(),
            scenario_id: (!pool.is_spot()).then_some(pool.scenario_id),
            world,
            mask0,
            mask1,
            token0: token_id(t0),
            token1: token_id(t1),
            reserve0: U128(r0),
            reserve1: U128(r1),
            weth_reserve,
            usdc_reserve,
            liquidity: U128(pool.amm.liquidity()),
            fees0: U128(fees0),
            fees1: U128(fees1),
            fee_pips: self.next_fee(pool),
            swap_count: pool.flow.count(),
            price: U128(pool.amm.price_wad().unwrap_or(0)),
            twap_price: twap_price.map(U128),
            twap_ok,
        }
    }
}
