//! Prices for lending: one classification per world pool, a snapshot per
//! scenario that lending reads once per call, the per-market price config and
//! the outside NEAR/USD reference factor.
//!
//! A world pool is `no_pool`, `young`, `shallow`, `out_of_band` or `trusted`,
//! checked in that order under the market's config. Depth is the USDC side
//! the pool holds at its TWAP price (`liquidity * sqrtP(TWAP)`), which no swap
//! moves inside a block. The borrow side counts trusted worlds at
//! `min(spot, TWAP)`; the liquidation side prices trusted worlds, and
//! out-of-band worlds with a full TWAP window, at the TWAP. A market with the
//! reference switched on compares the stored NEAR/USD price `R` with the
//! TWAP-implied spot `I`: `rho = R / I` scales both sides (the only haircut),
//! blocks new borrowing when stale or too far off, and pauses liquidation when
//! the pools sit too far below it (the guard). Repay, deposits, exits and
//! liquidation never wait on the reference.

use multiverse_math::fixed::{mul_div_down, WAD};
use multiverse_math::tick::get_sqrt_ratio_at_tick;
use multiverse_math::{odds, price, pricing};
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::store::LookupMap;
use near_sdk::{assert_one_yocto, env, near};

use crate::amm::{Pool, MAX_SPOT_TWAP_TICKS};
use crate::events::MultiverseEvent;
use crate::masks;
use crate::reference::ReferenceSource;
use crate::types::Params;
use crate::{now_sec, Contract, ContractExt, StorageKey};

/// Bounds of `MarketPriceCfg` (`BadPriceConfig(field)`): `min_age_sec` from
/// 60 to the TWAP window; `min_depth` from 1 to 1e12 USDC.
pub const MIN_PRICE_AGE_SEC: u64 = 60;
pub const MIN_DEPTH_FLOOR: u128 = WAD;
pub const MIN_DEPTH_CAP: u128 = 1_000_000_000_000 * WAD;
/// `max_deviation` from 1% to 50%.
pub const MIN_DEVIATION: u128 = WAD / 100;
pub const MAX_DEVIATION: u128 = WAD / 2;
/// `max_haircut` up to 50%.
pub const MAX_HAIRCUT: u128 = WAD / 2;

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

impl WorldStatus {
    /// The JSON name.
    pub fn name(self) -> &'static str {
        match self {
            WorldStatus::NoPool => "no_pool",
            WorldStatus::Young => "young",
            WorldStatus::Shallow => "shallow",
            WorldStatus::OutOfBand => "out_of_band",
            WorldStatus::Trusted => "trusted",
        }
    }
}

/// One world pool, read once. `twap` and `spot` are USDC per wNEAR (WAD, 0
/// when unknown); `depth` is the USDC side at the TWAP price (0 while the
/// pool has no TWAP).
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

    /// Priced on the liquidation side: trusted, or out of band over a full
    /// TWAP window (a push has no weight in its own block and 1/window per
    /// second after, so the TWAP is the price the push did not move).
    pub fn liquidation_priced(&self) -> bool {
        self.status == WorldStatus::Trusted
            || (self.status == WorldStatus::OutOfBand && self.full_window)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PriceMode {
    Borrow,
    Liquidate,
}

/// Every world of one scenario, read once, with the config and the reference
/// check it was read under. Pure: building it writes nothing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PriceSnapshot {
    pub scenario_id: u64,
    pub possible: u8,
    pub cfg: MarketPriceCfg,
    pub quotes: Vec<WorldQuote>,
    pub check: RefCheck,
}

/// The outside NEAR/USD check: off for this market (or switched off
/// globally), no reference stored, the implied spot unknown, or both known
/// with their ratio (WAD).
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

/// Prices of one mode: per world (0 where unpriced or dead), the possible
/// worlds priced in this mode and those trusted, the highest price and the
/// factor applied (WAD).
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
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PriceBlock {
    ReferenceMissing,
    ImpliedSpotUnknown { scenario_id: u64 },
    ReferenceStale { age_sec: u64, max_age_sec: u64 },
    ReferenceDeviation { implied: u128, reference: u128 },
    ReferenceGuard { implied: u128, reference: u128 },
}

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

impl PriceSnapshot {
    /// `(f_b, f_l)`: the reference factors of the borrow and the liquidation
    /// side, 1e18 unless the check ran and the reference is fresh enough for
    /// that side. `f_b <= f_l` always.
    pub fn factors(&self) -> (u128, u128) {
        match self.check {
            RefCheck::Checked {
                ratio,
                age_sec,
                borrow_max_age_sec,
                liquidation_max_age_sec,
                ..
            } => {
                let f_l = if age_sec <= liquidation_max_age_sec {
                    pricing::liquidation_factor(ratio, self.cfg.max_haircut.0)
                } else {
                    WAD
                };
                let f_b = if age_sec <= borrow_max_age_sec {
                    pricing::borrow_factor(ratio)
                } else {
                    WAD
                };
                (f_b.min(f_l), f_l)
            }
            _ => (WAD, WAD),
        }
    }

    /// The price of every possible world for `mode`. Borrow: trusted worlds
    /// at `min(spot, TWAP) * f_b`. Liquidate: trusted worlds, and out-of-band
    /// worlds with a full window, at `TWAP * f_l`. Anything else is unpriced
    /// (0, and its bit clear in `priced`).
    pub fn prices(&self, mode: PriceMode) -> WorldPrices {
        let (f_b, f_l) = self.factors();
        let factor = match mode {
            PriceMode::Borrow => f_b,
            PriceMode::Liquidate => f_l,
        };
        let mut prices = vec![0u128; self.quotes.len()];
        let (mut priced, mut trusted, mut max_price) = (0u8, 0u8, 0u128);
        for (i, q) in self.quotes.iter().enumerate() {
            let w = i as u8;
            if !masks::contains(self.possible, w) {
                continue;
            }
            if q.status == WorldStatus::Trusted {
                trusted |= 1 << w;
            }
            let price = match mode {
                PriceMode::Borrow if q.status == WorldStatus::Trusted => {
                    pricing::borrow_price(q.spot, q.twap, f_b)
                }
                PriceMode::Liquidate if q.liquidation_priced() => {
                    pricing::liquidation_price(q.twap, f_l)
                }
                _ => continue,
            };
            prices[i] = price;
            priced |= 1 << w;
            max_price = max_price.max(price);
        }
        WorldPrices {
            prices,
            priced,
            trusted,
            max_price,
            factor,
        }
    }

    /// What blocks new borrowing (borrow, collateral withdrawal with debt,
    /// `sell_and_borrow`), first that applies; None while the check is off.
    pub fn borrow_block(&self) -> Option<PriceBlock> {
        match self.check {
            RefCheck::Off => None,
            RefCheck::Missing => Some(PriceBlock::ReferenceMissing),
            RefCheck::Unknown => Some(PriceBlock::ImpliedSpotUnknown {
                scenario_id: self.scenario_id,
            }),
            RefCheck::Checked {
                reference,
                implied,
                ratio,
                age_sec,
                borrow_max_age_sec,
                ..
            } => {
                if age_sec > borrow_max_age_sec {
                    Some(PriceBlock::ReferenceStale {
                        age_sec,
                        max_age_sec: borrow_max_age_sec,
                    })
                } else if pricing::deviates(ratio, self.cfg.max_deviation.0) {
                    Some(PriceBlock::ReferenceDeviation { implied, reference })
                } else {
                    None
                }
            }
        }
    }

    /// `ReferenceGuard` when the implied spot sits more than `max_deviation`
    /// below a reference fresh enough for liquidation; None otherwise.
    pub fn liquidation_guard(&self) -> Option<PriceBlock> {
        match self.check {
            RefCheck::Checked {
                reference,
                implied,
                ratio,
                age_sec,
                liquidation_max_age_sec,
                ..
            } if age_sec <= liquidation_max_age_sec
                && pricing::guard(ratio, self.cfg.max_deviation.0) =>
            {
                Some(PriceBlock::ReferenceGuard { implied, reference })
            }
            _ => None,
        }
    }

    /// Each world's status, dead worlds included.
    #[allow(dead_code)] // lending's account views read it
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

    /// The first field outside its bounds, if any.
    pub fn invalid_field(&self, twap_window_sec: u64) -> Option<&'static str> {
        if self.min_age_sec < MIN_PRICE_AGE_SEC || self.min_age_sec > twap_window_sec {
            Some("min_age_sec")
        } else if self.min_depth.0 < MIN_DEPTH_FLOOR || self.min_depth.0 > MIN_DEPTH_CAP {
            Some("min_depth")
        } else if self.max_deviation.0 < MIN_DEVIATION || self.max_deviation.0 > MAX_DEVIATION {
            Some("max_deviation")
        } else if self.max_haircut.0 > MAX_HAIRCUT {
            Some("max_haircut")
        } else {
            None
        }
    }

    /// Whether moving from `self` to `new` may happen while the market has
    /// debt: only turning the reference off, lowering the haircut, changing
    /// the deviation, raising the age or raising the depth. None of these
    /// lowers a liquidation price (PRC-6).
    pub fn allows_with_debt(&self, new: &MarketPriceCfg) -> bool {
        (new.reference == self.reference || !new.reference)
            && new.max_haircut.0 <= self.max_haircut.0
            && new.min_age_sec >= self.min_age_sec
            && new.min_depth.0 >= self.min_depth.0
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

/// `world_prices` row.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorldPriceView {
    pub world: u8,
    pub status: WorldStatus,
    pub twap: U128,
    pub spot: U128,
    /// 0 where the world does not count for borrowing (or is dead).
    pub borrow_price: U128,
    /// 0 where the world is unpriced for liquidation (or dead).
    pub liquidation_price: U128,
    pub depth: U128,
    pub age_sec: u64,
    pub full_window: bool,
}

/// The stored reference as `price_check` shows it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReferenceSummary {
    pub price: U128,
    pub observed_at: u64,
    pub age_sec: u64,
    pub source: ReferenceSource,
    pub sources_used: u8,
    pub spread_bps: u32,
}

/// What the reference does to one market now.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriceCheckView {
    pub scenario_id: u64,
    pub config: MarketPriceCfg,
    /// The stored reference, null before the first one.
    pub reference: Option<ReferenceSummary>,
    /// I, from full-window TWAPs of deep pools; null when unknown. Shown
    /// whether or not the market uses the reference.
    pub implied_twap_spot: Option<U128>,
    /// R / I (WAD), when both are known.
    pub ratio: Option<U128>,
    /// The error a borrow would fail with because of the reference.
    pub borrow_block: Option<String>,
    pub borrow_factor: U128,
    pub liquidation_factor: U128,
    pub liquidation_guard: bool,
}

/// `scenario_id` null = the defaults.
#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct PriceConfigSet {
    pub scenario_id: Option<u64>,
    pub min_age_sec: u64,
    pub min_depth: U128,
    pub reference: bool,
    pub max_deviation: U128,
    pub max_haircut: U128,
}

impl MultiverseEvent for PriceConfigSet {
    const NAME: &'static str = "price_config_set";
}

impl PriceConfigSet {
    fn new(scenario_id: Option<u64>, cfg: &MarketPriceCfg) -> Self {
        Self {
            scenario_id,
            min_age_sec: cfg.min_age_sec,
            min_depth: cfg.min_depth,
            reference: cfg.reference,
            max_deviation: cfg.max_deviation,
            max_haircut: cfg.max_haircut,
        }
    }
}

#[near]
impl Contract {
    /// Owner, 1 yoctoNEAR. The config scenarios created from now on start
    /// with; existing scenarios keep theirs.
    #[payable]
    pub fn set_default_price_config(&mut self, cfg: MarketPriceCfg) {
        assert_one_yocto();
        self.assert_owner();
        self.assert_price_config(&cfg);
        self.prices.defaults = cfg;
        PriceConfigSet::new(None, &cfg).emit();
    }

    /// Owner, 1 yoctoNEAR; storage from the owner's NEP-145 balance. While
    /// any tier of the scenario has debt, only changes that never lower a
    /// liquidation price pass (`PriceConfigLocked`).
    #[payable]
    pub fn set_market_price_config(&mut self, scenario_id: u64, cfg: MarketPriceCfg) {
        assert_one_yocto();
        self.assert_owner();
        self.scenario(scenario_id);
        self.assert_price_config(&cfg);
        if self.has_debt(scenario_id) && !self.price_cfg(scenario_id).allows_with_debt(&cfg) {
            fail!("PriceConfigLocked({scenario_id})");
        }
        let before = env::storage_usage();
        self.prices.configs.insert(scenario_id, cfg);
        self.charge_storage(&env::predecessor_account_id(), before);
        PriceConfigSet::new(Some(scenario_id), &cfg).emit();
    }

    /// Every world of the scenario: status, TWAP and spot, the price it
    /// counts at on each side (0 = unpriced), depth, age and window.
    pub fn world_prices(&self, scenario_id: u64) -> Vec<WorldPriceView> {
        let snap = self.price_snapshot(scenario_id);
        let borrow = snap.prices(PriceMode::Borrow);
        let liquidate = snap.prices(PriceMode::Liquidate);
        snap.quotes
            .iter()
            .enumerate()
            .map(|(i, q)| WorldPriceView {
                world: i as u8,
                status: q.status,
                twap: U128(q.twap),
                spot: U128(q.spot),
                borrow_price: U128(borrow.prices[i]),
                liquidation_price: U128(liquidate.prices[i]),
                depth: U128(q.depth),
                age_sec: q.age_sec,
                full_window: q.full_window,
            })
            .collect()
    }

    /// The market's config, the stored reference, the implied spot and what
    /// the reference does to borrowing and liquidation now.
    pub fn price_check(&self, scenario_id: u64) -> PriceCheckView {
        let snap = self.price_snapshot(scenario_id);
        let state = self.reference_state().filter(|s| s.price > 0);
        let implied = self.implied_twap_spot(scenario_id, snap.possible, &snap.cfg, &snap.quotes);
        let ratio = match (&state, implied) {
            (Some(s), Some(i)) => pricing::ratio(s.price, i),
            _ => None,
        };
        let (f_b, f_l) = snap.factors();
        let now = now_sec();
        PriceCheckView {
            scenario_id,
            config: snap.cfg,
            reference: state.map(|s| ReferenceSummary {
                price: U128(s.price),
                observed_at: s.observed_at,
                age_sec: now.saturating_sub(s.observed_at),
                source: ReferenceSource::from_code(s.source),
                sources_used: s.sources_used,
                spread_bps: s.spread_bps,
            }),
            implied_twap_spot: implied.map(U128),
            ratio: ratio.map(U128),
            borrow_block: snap.borrow_block().map(|b| b.error()),
            borrow_factor: U128(f_b),
            liquidation_factor: U128(f_l),
            liquidation_guard: snap.liquidation_guard().is_some(),
        }
    }

    pub fn get_market_price_config(&self, scenario_id: u64) -> MarketPriceCfg {
        self.scenario(scenario_id);
        self.price_cfg(scenario_id)
    }

    pub fn get_default_price_config(&self) -> MarketPriceCfg {
        self.prices.defaults
    }
}

impl Contract {
    /// Every world of `sid` read once, under the market's config, with the
    /// reference check. Pure: W world-pool reads, plus the two reference keys
    /// and the W-1 odds pools when the market uses the reference.
    pub(crate) fn price_snapshot(&self, sid: u64) -> PriceSnapshot {
        let s = self.scenario(sid);
        let (world_count, possible) = (s.world_count, s.possible);
        let cfg = self.price_cfg(sid);
        let quotes: Vec<WorldQuote> = (0..world_count)
            .map(|w| self.world_quote(sid, w, &cfg))
            .collect();
        let check = self.reference_check(sid, possible, &cfg, &quotes);
        PriceSnapshot {
            scenario_id: sid,
            possible,
            cfg,
            quotes,
            check,
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

    /// World `w`'s pool of `sid`, classified under `cfg`. Tests can set any
    /// quote with `TEST_WORLD_QUOTES`.
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
    /// applied): young without a TWAP or below `cfg.min_age_sec`, shallow
    /// below `cfg.min_depth` of USDC at the TWAP price, out of band past
    /// `MAX_SPOT_TWAP_TICKS` between the latest observation and the mean
    /// tick, else trusted.
    pub(crate) fn world_quote_of(&self, pool: &Pool, cfg: &MarketPriceCfg) -> WorldQuote {
        let age_sec = self.pool_age(pool);
        let mean_tick = self.pool_mean_tick(pool);
        let spot_tick = pool.twap.latest().map(|o| o.tick);
        // wNEAR is token0, so the floored mean tick prices it down by at most a tick.
        let twap = mean_tick.and_then(|t| price::wnear_price_at_tick(t, true));
        let depth = mean_tick.map_or(0, |t| pricing::depth_at_tick(pool.amm.liquidity(), t));
        let status = match (mean_tick, twap, spot_tick) {
            // A TWAP too large for a price is no price at all.
            (Some(mean), Some(_), Some(spot)) if age_sec >= cfg.min_age_sec => {
                if depth < cfg.min_depth.0 {
                    WorldStatus::Shallow
                } else if (i64::from(spot) - i64::from(mean)).abs() > i64::from(MAX_SPOT_TWAP_TICKS)
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
            twap: twap.unwrap_or(0),
            spot: pool.amm.price_wad().unwrap_or(0),
            mean_tick,
            spot_tick,
            depth,
            age_sec,
            full_window: self.pool_full_window(pool),
        }
    }

    /// Whether a world pool prices the liquidation side as it stands (trusted,
    /// or out of band over a full window): the cash-out guard asks it of a
    /// pool with the sale applied.
    #[allow(dead_code)] // the cash-out guard calls it
    pub(crate) fn world_liq_priced_with(
        &self,
        _sid: u64,
        pool: &Pool,
        cfg: &MarketPriceCfg,
    ) -> bool {
        self.world_quote_of(pool, cfg).liquidation_priced()
    }

    /// The odds of every world from the odds pools' mean ticks (never current
    /// reserves), or None when a split between two live worlds lacks a pool
    /// that exists, has a full TWAP window and `liquidity >= cfg.min_depth`.
    /// Tests can set odds with `TEST_ODDS`.
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

    /// I, the TWAP-implied spot: `sum of floor(q_w * twap_w / 1e18)` over the
    /// possible worlds, with odds from the odds pools' mean ticks. Known only
    /// when every possible world is liquidation-priced and every odds pool
    /// the tree needs is full-window and deep; never 0.
    pub(crate) fn implied_twap_spot(
        &self,
        sid: u64,
        possible: u8,
        cfg: &MarketPriceCfg,
        quotes: &[WorldQuote],
    ) -> Option<u128> {
        let all_priced = quotes
            .iter()
            .enumerate()
            .all(|(i, q)| !masks::contains(possible, i as u8) || q.liquidation_priced());
        if !all_priced {
            return None;
        }
        let q = self.twap_odds(sid, cfg)?;
        let mut implied = 0u128;
        for (i, quote) in quotes.iter().enumerate() {
            if !masks::contains(possible, i as u8) {
                continue;
            }
            // q <= 1e18, so each term is at most the TWAP.
            let part = mul_div_down(*q.get(i)?, quote.twap, WAD);
            implied = implied.checked_add(part)?;
        }
        (implied > 0).then_some(implied)
    }

    /// The reference check of one market: off unless the market and the
    /// global config both switch it on; missing without a stored price;
    /// unknown without an implied spot.
    fn reference_check(
        &self,
        sid: u64,
        possible: u8,
        cfg: &MarketPriceCfg,
        quotes: &[WorldQuote],
    ) -> RefCheck {
        if !cfg.reference {
            return RefCheck::Off;
        }
        let config = match self.reference_config() {
            None => return RefCheck::Missing,
            Some(c) if !c.enabled => return RefCheck::Off,
            Some(c) => c,
        };
        let state = self.reference_state().unwrap_or_default();
        if state.price == 0 {
            return RefCheck::Missing;
        }
        let Some(implied) = self.implied_twap_spot(sid, possible, cfg, quotes) else {
            return RefCheck::Unknown;
        };
        let Some(ratio) = pricing::ratio(state.price, implied) else {
            return RefCheck::Unknown;
        };
        RefCheck::Checked {
            reference: state.price,
            implied,
            ratio,
            age_sec: now_sec().saturating_sub(state.observed_at),
            borrow_max_age_sec: config.borrow_max_age_sec,
            liquidation_max_age_sec: config.liquidation_max_age_sec,
        }
    }

    fn assert_price_config(&self, cfg: &MarketPriceCfg) {
        if let Some(field) = cfg.invalid_field(self.params.twap_window_sec) {
            fail!("BadPriceConfig({field})");
        }
    }

    /// v1's lending price of a world, from the pool as it stands: the mean
    /// tick behind 60 s of history, the 953-tick band and the depth gate on
    /// the current USDC reserve. Only `migrate` reads it, to prove that the
    /// v2 price of every legacy world with debt is the same.
    fn v1_world_price(&self, sid: u64, w: u8) -> (u128, bool) {
        let Some(pool) = self.world_pool(sid, w).and_then(|id| self.pools.get(&id)) else {
            return (0, false);
        };
        let Some(tick) = self.pool_mean_tick(pool) else {
            return (0, false);
        };
        let Some(spot) = pool.twap.latest().map(|o| o.tick) else {
            return (0, false);
        };
        if (i64::from(spot) - i64::from(tick)).abs() > i64::from(MAX_SPOT_TWAP_TICKS) {
            return (0, false);
        }
        if pool.amm.reserve1() < self.params.min_pool_depth {
            return (0, false);
        }
        match price::wnear_price_at_tick(tick, true) {
            Some(p) => (p, true),
            None => (0, false),
        }
    }

    /// Migrate step 8: every legacy scenario gets `MarketPriceCfg::v1(params)`,
    /// and every possible world of a legacy scenario with debt must be priced
    /// for liquidation exactly as v1 prices it, same flag and same price
    /// (`MigratePriceMismatch(sid, w)`): no upgrade makes a loan liquidatable
    /// or changes its health.
    pub(crate) fn migrate_prices(&mut self, params: &Params) {
        let cfg = MarketPriceCfg::v1(params);
        for sid in 1..=self.legacy_scenario_count {
            self.prices.configs.insert(sid, cfg);
        }
        for sid in 1..=self.legacy_scenario_count {
            if !self.has_debt(sid) {
                continue;
            }
            let snap = self.price_snapshot(sid);
            let liquidation = snap.prices(PriceMode::Liquidate);
            for w in 0..snap.quotes.len() as u8 {
                if !masks::contains(snap.possible, w) {
                    continue;
                }
                let (v1_price, v1_priced) = self.v1_world_price(sid, w);
                let v2_priced = masks::contains(liquidation.priced, w);
                if v1_priced != v2_priced
                    || (v1_priced && v1_price != liquidation.prices[usize::from(w)])
                {
                    fail!("MigratePriceMismatch({sid}, {w})");
                }
            }
        }
    }
}
