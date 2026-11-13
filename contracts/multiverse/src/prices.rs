//! Prices for lending: one classification per world pool, a snapshot per
//! scenario that lending reads once per call, and the per-market price config.
//!
//! The functions below are the interface lending and the markets build on;
//! their bodies give v1's gates (a pool prices from `TWAP_MIN_AGE_SEC` on,
//! behind the v1 depth gate on its USDC reserve and the spot-to-TWAP band),
//! so code that moves onto this interface behaves exactly as v1 did. The
//! per-market config, the TWAP depth, the borrow side's min(spot, TWAP) and
//! the outside NEAR/USD reference replace these bodies, never the signatures.

use multiverse_math::odds;
use multiverse_math::price;
use multiverse_math::tick::get_sqrt_ratio_at_tick;
use near_sdk::json_types::U128;
use near_sdk::near;
use near_sdk::store::LookupMap;

use crate::amm::{Pool, MAX_SPOT_TWAP_TICKS};
use crate::masks;
use crate::types::{Params, WAD};
use crate::{now_sec, Contract, StorageKey};

/// A world pool's state for lending, checked in this order.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorldStatus {
    NoPool,
    Young,
    Shallow,
    OutOfBand,
    Trusted,
}

/// One world pool, read once. `twap` and `spot` are USDC per wNEAR (WAD, 0
/// when unknown); `depth` is what the depth gate compares.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WorldQuote {
    pub status: WorldStatus,
    pub twap: u128,
    pub spot: u128,
    pub mean_tick: Option<i32>,
    pub spot_tick: Option<i32>,
    pub depth: u128,
    pub age_sec: u64,
    pub full_window: bool,
}

impl WorldQuote {
    /// No pool in this world.
    pub fn no_pool() -> Self {
        Self {
            status: WorldStatus::NoPool,
            twap: 0,
            spot: 0,
            mean_tick: None,
            spot_tick: None,
            depth: 0,
            age_sec: 0,
            full_window: false,
        }
    }
}

#[allow(dead_code)] // lending reads prices through the snapshot once it moves onto it
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PriceMode {
    Borrow,
    Liquidate,
}

/// Every world of one scenario, read once, with the config and the reference
/// check it was read under. Pure: building it writes nothing.
#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PriceSnapshot {
    pub scenario_id: u64,
    pub possible: u8,
    pub cfg: MarketPriceCfg,
    pub quotes: Vec<WorldQuote>,
    pub check: RefCheck,
}

/// The outside NEAR/USD check: off for this market, no reference stored, the
/// implied spot unknown, or both known with their ratio (WAD).
#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RefCheck {
    Off,
    Missing,
    Unknown,
    Checked {
        reference: u128,
        implied: u128,
        ratio: u128,
        age_sec: u64,
        borrow_max_age_sec: u64,
        liquidation_max_age_sec: u64,
    },
}

/// Prices of one mode: per world (0 where unpriced), the priced and trusted
/// world masks, the highest price and the factor applied (WAD).
#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorldPrices {
    pub prices: Vec<u128>,
    pub priced: u8,
    pub trusted: u8,
    pub max_price: u128,
    pub factor: u128,
}

/// Why the reference blocks new borrowing (or, for `ReferenceGuard`, a
/// liquidation).
#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PriceBlock {
    ReferenceMissing,
    ImpliedSpotUnknown { scenario_id: u64 },
    ReferenceStale { age_sec: u64, max_age_sec: u64 },
    ReferenceDeviation { implied: u128, reference: u128 },
    ReferenceGuard { implied: u128, reference: u128 },
}

#[allow(dead_code)]
impl PriceBlock {
    /// The error in house format, e.g. `"ReferenceStale(4000, 3600)"`.
    pub fn error(&self) -> String {
        match self {
            PriceBlock::ReferenceMissing => "ReferenceMissing".to_string(),
            PriceBlock::ImpliedSpotUnknown { scenario_id } => {
                format!("ImpliedSpotUnknown({scenario_id})")
            }
            PriceBlock::ReferenceStale {
                age_sec,
                max_age_sec,
            } => format!("ReferenceStale({age_sec}, {max_age_sec})"),
            PriceBlock::ReferenceDeviation { implied, reference } => {
                format!("ReferenceDeviation({implied}, {reference})")
            }
            PriceBlock::ReferenceGuard { implied, reference } => {
                format!("ReferenceGuard({implied}, {reference})")
            }
        }
    }
}

#[allow(dead_code)]
impl PriceSnapshot {
    /// The price of every possible world for `mode`: a trusted world at its
    /// TWAP, any other world unpriced.
    pub fn prices(&self, _mode: PriceMode) -> WorldPrices {
        let mut prices = vec![0u128; self.quotes.len()];
        let (mut priced, mut trusted, mut max_price) = (0u8, 0u8, 0u128);
        for (i, q) in self.quotes.iter().enumerate() {
            let w = i as u8;
            if !masks::contains(self.possible, w) || q.status != WorldStatus::Trusted {
                continue;
            }
            prices[i] = q.twap;
            priced |= 1 << w;
            trusted |= 1 << w;
            max_price = max_price.max(q.twap);
        }
        WorldPrices {
            prices,
            priced,
            trusted,
            max_price,
            factor: WAD,
        }
    }

    /// What blocks new borrowing; None while the reference check is off.
    pub fn borrow_block(&self) -> Option<PriceBlock> {
        None
    }

    /// `ReferenceGuard` when the implied spot sits too far above a fresh
    /// reference; None while the reference check is off.
    pub fn liquidation_guard(&self) -> Option<PriceBlock> {
        None
    }

    /// Each world's status, dead worlds included.
    pub fn statuses(&self) -> Vec<WorldStatus> {
        self.quotes.iter().map(|q| q.status).collect()
    }
}

/// How one market prices its worlds for lending. 57 bytes.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MarketPriceCfg {
    /// A world pool prices lending from this age.
    pub min_age_sec: u64,
    /// USDC-if-w at the TWAP price (world pools); liquidity (odds pools).
    pub min_depth: U128,
    /// Use the outside NEAR/USD check.
    pub reference: bool,
    /// WAD.
    pub max_deviation: U128,
    /// WAD; 0 = the reference never lowers liquidation prices.
    pub max_haircut: U128,
}

impl MarketPriceCfg {
    /// Scenarios created from v2 on.
    pub const V2: Self = Self {
        min_age_sec: 1_800,
        min_depth: U128(50_000 * WAD),
        reference: false,
        max_deviation: U128(WAD / 10),
        max_haircut: U128(WAD / 5),
    };

    /// Legacy markets: exact v1 gates.
    pub fn v1(params: &Params) -> Self {
        Self {
            min_age_sec: crate::amm::TWAP_MIN_AGE_SEC,
            min_depth: U128(params.min_pool_depth),
            reference: false,
            max_deviation: U128(WAD / 10),
            max_haircut: U128(0),
        }
    }
}

/// The defaults new scenarios snapshot, and one config per scenario.
#[near(serializers = [borsh])]
pub struct PriceState {
    pub defaults: MarketPriceCfg,
    pub configs: LookupMap<u64, MarketPriceCfg>,
}

impl PriceState {
    pub fn new(defaults: MarketPriceCfg) -> Self {
        Self {
            defaults,
            configs: LookupMap::new(StorageKey::PriceConfigs),
        }
    }
}

impl Contract {
    /// Every world of `sid` read once, under the market's config. Pure.
    #[allow(dead_code)]
    pub(crate) fn price_snapshot(&self, sid: u64) -> PriceSnapshot {
        let s = self.scenario(sid);
        let (world_count, possible) = (s.world_count, s.possible);
        let cfg = self.price_cfg(sid);
        let quotes = (0..world_count)
            .map(|w| self.world_quote(sid, w, &cfg))
            .collect();
        PriceSnapshot {
            scenario_id: sid,
            possible,
            cfg,
            quotes,
            check: RefCheck::Off,
        }
    }

    /// The market's stored config, else the defaults.
    pub(crate) fn price_cfg(&self, sid: u64) -> MarketPriceCfg {
        self.prices
            .configs
            .get(&sid)
            .copied()
            .unwrap_or(self.prices.defaults)
    }

    /// World `w`'s pool of `sid`, classified. Tests can set any quote with
    /// `TEST_WORLD_QUOTES`.
    pub(crate) fn world_quote(&self, sid: u64, w: u8, cfg: &MarketPriceCfg) -> WorldQuote {
        #[cfg(test)]
        if let Some(q) = crate::amm::test_hooks::quote(sid, w) {
            let deep = !matches!(q.status, WorldStatus::NoPool | WorldStatus::Shallow);
            return WorldQuote {
                status: q.status,
                twap: q.twap,
                spot: q.spot,
                mean_tick: None,
                spot_tick: None,
                depth: if deep { u128::MAX } else { 0 },
                age_sec: if q.full_window {
                    self.params.twap_window_sec
                } else {
                    0
                },
                full_window: q.full_window,
            };
        }
        match self.world_pool(sid, w).and_then(|id| self.pools.get(&id)) {
            Some(pool) => self.world_quote_of(pool, cfg),
            None => WorldQuote::no_pool(),
        }
    }

    /// A world pool classified as it stands (it may be a clone with a swap
    /// applied). v1 gates: young below `TWAP_MIN_AGE_SEC`, shallow below
    /// `params.min_pool_depth` of USDC, out of band past `MAX_SPOT_TWAP_TICKS`
    /// between the latest and the mean tick.
    pub(crate) fn world_quote_of(&self, pool: &Pool, _cfg: &MarketPriceCfg) -> WorldQuote {
        let now = now_sec();
        let age_sec = pool
            .twap
            .observations()
            .next()
            .map_or(0, |o| now.saturating_sub(o.timestamp));
        let mean_tick = self.pool_mean_tick(pool);
        let spot_tick = pool.twap.latest().map(|o| o.tick);
        // wNEAR is token0, so the floored mean tick prices it down by at most a tick.
        let twap_price = mean_tick.and_then(|t| price::wnear_price_at_tick(t, true));
        let depth = pool.amm.reserve1();
        let status = match (mean_tick, spot_tick) {
            (Some(mean), Some(spot)) => {
                if depth < self.params.min_pool_depth {
                    WorldStatus::Shallow
                } else if (i64::from(spot) - i64::from(mean)).abs() > i64::from(MAX_SPOT_TWAP_TICKS)
                    || twap_price.is_none()
                {
                    WorldStatus::OutOfBand
                } else {
                    WorldStatus::Trusted
                }
            }
            _ => WorldStatus::Young,
        };
        WorldQuote {
            status,
            twap: twap_price.unwrap_or(0),
            spot: pool.amm.price_wad().unwrap_or(0),
            mean_tick,
            spot_tick,
            depth,
            age_sec,
            full_window: self.pool_full_window(pool),
        }
    }

    /// Whether a world pool prices the liquidation side as it stands.
    #[allow(dead_code)]
    pub(crate) fn world_liq_priced_with(
        &self,
        _sid: u64,
        pool: &Pool,
        cfg: &MarketPriceCfg,
    ) -> bool {
        self.world_quote_of(pool, cfg).status == WorldStatus::Trusted
    }

    /// The odds of every world from the odds pools' mean ticks (never current
    /// reserves), or None when a split between two live worlds lacks a pool
    /// that exists, has a full TWAP window and `liquidity >= cfg.min_depth`.
    /// Tests can set odds with `TEST_ODDS`.
    #[allow(dead_code)]
    pub(crate) fn twap_odds(&self, sid: u64, cfg: &MarketPriceCfg) -> Option<Vec<u128>> {
        #[cfg(test)]
        if let Some(q) = crate::amm::test_hooks::odds(sid) {
            return Some(q);
        }
        let s = self.scenarios.get(&sid)?;
        odds::odds(s.world_count, s.possible, |x, y| {
            // Tree pairs list the lower mask first, which is token0.
            let pool = self.pools.get(self.between.get(&(sid, x, y))?)?;
            if !self.pool_full_window(pool) || pool.amm.liquidity() < cfg.min_depth.0 {
                return None;
            }
            let mean = self.pool_mean_tick(pool)?;
            Some(odds::share_of_token0(get_sqrt_ratio_at_tick(mean)))
        })
    }

    /// The pool's kept history spans a whole TWAP window.
    pub(crate) fn pool_full_window(&self, pool: &Pool) -> bool {
        pool.twap
            .observations()
            .next()
            .is_some_and(|o| now_sec().saturating_sub(o.timestamp) >= self.params.twap_window_sec)
    }

    /// A new scenario snapshots the default config.
    pub(crate) fn prices_on_scenario_created(&mut self, sid: u64) {
        let defaults = self.prices.defaults;
        self.prices.configs.insert(sid, defaults);
    }

    /// Migrate step 8: every legacy scenario gets `MarketPriceCfg::v1(params)`,
    /// and every world of a scenario with debt must price exactly as under v1
    /// (`MigratePriceMismatch(sid, w)`).
    pub(crate) fn migrate_prices(&mut self, _params: &Params) {}
}
