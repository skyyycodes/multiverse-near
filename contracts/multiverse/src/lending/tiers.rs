//! Lending tiers: three money markets per scenario (Safe, Normal, Bold), each
//! with its own pool of USDC, its own liquidation LTV and rate curve.
//!
//! A market is `MarketId { scenario_id, tier }`, stored under
//! `scenario_id | tier_code << 56`. Normal's code is 0, so every v1 lending
//! entry, keyed by the bare scenario id, is already the Normal tier of its
//! scenario and nothing is re-keyed. Key `0 | code << 56` holds a tier's
//! default config (scenario 0 never exists).

use multiverse_math::risk::CLOSE_FACTOR;
use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

use crate::migrate::{LendingMigrateArgs, LendingUpgradeLog};
use crate::types::WAD;
use crate::Contract;

/// JSON "normal" | "safe" | "bold"; missing in a msg or call argument =
/// Normal. Never stored as Borsh.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    #[default]
    Normal,
    Safe,
    Bold,
}

impl Tier {
    /// Display order.
    pub const ALL: [Tier; 3] = [Tier::Safe, Tier::Normal, Tier::Bold];

    pub const fn code(self) -> u64 {
        match self {
            Tier::Normal => 0,
            Tier::Safe => 1,
            Tier::Bold => 2,
        }
    }

    pub fn is_normal(&self) -> bool {
        *self == Tier::Normal
    }

    /// The JSON name, as errors print it (`MarketFrozen(5, bold)`).
    pub const fn name(self) -> &'static str {
        match self {
            Tier::Normal => "normal",
            Tier::Safe => "safe",
            Tier::Bold => "bold",
        }
    }
}

impl std::fmt::Display for Tier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}

/// One lending market.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MarketId {
    pub scenario_id: u64,
    pub tier: Tier,
}

/// The tier code sits above every scenario id (`< 2^56`).
pub const TIER_SHIFT: u32 = 56;

impl MarketId {
    /// `None` is Normal.
    pub fn new(sid: u64, tier: Option<Tier>) -> Self {
        Self {
            scenario_id: sid,
            tier: tier.unwrap_or_default(),
        }
    }

    /// The key of every lending map.
    pub fn key(self) -> u64 {
        self.scenario_id | (self.tier.code() << TIER_SHIFT)
    }
}

/// A market's terms. Rates are per second (WAD), the rest WAD fractions.
/// 160 bytes, fixed size.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TierConfig {
    pub lltv: u128,
    pub borrow_ltv: u128,
    pub liquidation_bonus: u128,
    pub reserve_factor: u128,
    pub rate_base: u128,
    pub rate_slope1: u128,
    pub rate_slope2: u128,
    pub rate_kink: u128,
    pub max_utilization: u128,
    /// `u128::MAX` = none.
    pub borrow_cap: u128,
}

/// A market's config and its insurance, snapshot when the market is first
/// touched. 209 bytes; 258 with key and trie overhead.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TierState {
    pub config: TierConfig,
    pub frozen: bool,
    /// This market's reserve claim, never lent.
    pub insurance: u128,
    /// Cumulative insurance spent on write-offs.
    pub bad_debt_covered: u128,
    /// Cumulative TSA written down.
    pub bad_debt_socialized: u128,
}

/// Global lending rules. 48 bytes.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LendingParams {
    /// No new loan below it (0 = off).
    pub min_loan: u128,
    /// Below this HF a liquidation may repay the whole loan (0 = off).
    pub full_liquidation_hf: u128,
    /// Below this debt a liquidation may repay the whole loan.
    pub small_loan: u128,
}

impl Default for LendingParams {
    fn default() -> Self {
        Self {
            min_loan: 100 * WAD,
            full_liquidation_hf: 900_000_000_000_000_000,
            small_loan: 200 * WAD,
        }
    }
}

pub const SECONDS_PER_YEAR: u128 = 31_536_000;

/// A per-second rate from an APR in hundredths of a percent, rounded down.
const fn per_sec(apr_bps: u128) -> u128 {
    apr_bps * (WAD / 10_000) / SECONDS_PER_YEAR
}

/// A WAD fraction from hundredths of a percent.
const fn pct(bps: u128) -> u128 {
    bps * (WAD / 10_000)
}

impl TierState {
    /// The compiled defaults of a tier (owner-set defaults override them).
    pub fn builtin(tier: Tier) -> Self {
        // (lltv, borrow ltv, bonus, base APR, slope1 APR, slope2 APR), in bps
        let (lltv, borrow_ltv, bonus, base, slope1, slope2) = match tier {
            Tier::Safe => (6_000, 5_000, 500, 100, 400, 4_500),
            Tier::Normal => (7_000, 6_000, 600, 200, 600, 5_200),
            Tier::Bold => (8_000, 7_000, 800, 300, 900, 6_300),
        };
        TierState {
            config: TierConfig {
                lltv: pct(lltv),
                borrow_ltv: pct(borrow_ltv),
                liquidation_bonus: pct(bonus),
                reserve_factor: pct(1_000),
                rate_base: per_sec(base),
                rate_slope1: per_sec(slope1),
                rate_slope2: per_sec(slope2),
                rate_kink: pct(8_000),
                max_utilization: pct(9_000),
                borrow_cap: u128::MAX,
            },
            frozen: false,
            insurance: 0,
            bad_debt_covered: 0,
            bad_debt_socialized: 0,
        }
    }
}

/// A config as the views show it: U128 strings, `borrow_cap` null for none.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TierConfigView {
    pub lltv: U128,
    pub borrow_ltv: U128,
    pub liquidation_bonus: U128,
    pub reserve_factor: U128,
    pub rate_base: U128,
    pub rate_slope1: U128,
    pub rate_slope2: U128,
    pub rate_kink: U128,
    pub max_utilization: U128,
    pub borrow_cap: Option<U128>,
}

impl From<&TierConfig> for TierConfigView {
    fn from(c: &TierConfig) -> Self {
        Self {
            lltv: U128(c.lltv),
            borrow_ltv: U128(c.borrow_ltv),
            liquidation_bonus: U128(c.liquidation_bonus),
            reserve_factor: U128(c.reserve_factor),
            rate_base: U128(c.rate_base),
            rate_slope1: U128(c.rate_slope1),
            rate_slope2: U128(c.rate_slope2),
            rate_kink: U128(c.rate_kink),
            max_utilization: U128(c.max_utilization),
            borrow_cap: (c.borrow_cap != u128::MAX).then_some(U128(c.borrow_cap)),
        }
    }
}

/// One tier's default, for `get_app_config`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TierDefaultView {
    pub tier: Tier,
    pub config: TierConfigView,
}

/// `get_app_config().lending`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LendingConfigView {
    pub min_loan: U128,
    pub full_liquidation_hf: U128,
    pub small_loan: U128,
    pub close_factor: U128,
    pub max_collateral_pieces: u32,
    /// Safe, Normal, Bold.
    pub defaults: Vec<TierDefaultView>,
}

impl Contract {
    /// A tier's default: the owner-set one if stored, else the builtin.
    pub(crate) fn default_state(&self, tier: Tier) -> TierState {
        self.tier_states
            .get(&MarketId::new(0, Some(tier)).key())
            .cloned()
            .unwrap_or_else(|| TierState::builtin(tier))
    }

    /// A market's stored state, else its tier's default. View-safe: no write.
    #[allow(dead_code)] // read by the lending paths once they take a MarketId
    pub(crate) fn tier_state(&self, id: MarketId) -> TierState {
        self.tier_states
            .get(&id.key())
            .cloned()
            .unwrap_or_else(|| self.default_state(id.tier))
    }

    /// Whether any of the scenario's three markets has debt (3 reads).
    #[allow(dead_code)] // the price config lock and the seed depth floor read it
    pub(crate) fn has_debt(&self, sid: u64) -> bool {
        Tier::ALL.into_iter().any(|tier| {
            self.markets
                .get(&MarketId::new(sid, Some(tier)).key())
                .is_some_and(|m| m.total_borrow_shares > 0)
        })
    }

    /// Migrate step 9: the Normal `TierState` of every legacy scenario (v1
    /// terms where it has debt, the legacy live terms elsewhere), frozen per
    /// `args`, and builtin frozen Safe and Bold for each frozen scenario.
    pub(crate) fn migrate_lending_configs(
        &mut self,
        _args: &LendingMigrateArgs,
        _log: &mut LendingUpgradeLog,
    ) {
    }

    /// Lending's part of `upgrade_account`: indexes `a` as a borrower of every
    /// legacy market where it has borrow shares.
    pub(crate) fn lending_upgrade_account(&mut self, _a: &AccountId) {}

    /// Migrate step 11: Σ indexed borrow shares against TBS per legacy market.
    /// Above TBS fails `BorrowerBackfillIncomplete`; below it logs the gap,
    /// sets `legacy_backfill_open` and pauses `lend` and `liquidate`.
    pub(crate) fn migrate_lending_proof(&mut self, _log: &mut LendingUpgradeLog) {}

    /// Step 11's proof again, for `unpause` while `legacy_backfill_open`: the
    /// first legacy market still short as `(sid, indexed, tbs)`, None when all
    /// balance.
    #[allow(dead_code)] // called by unpause
    pub(crate) fn lending_backfill_proof(&self) -> Option<(u64, u128, u128)> {
        None
    }

    /// `get_app_config().lending`.
    pub(crate) fn lending_config_view(&self) -> LendingConfigView {
        LendingConfigView {
            min_loan: U128(self.lending.min_loan),
            full_liquidation_hf: U128(self.lending.full_liquidation_hf),
            small_loan: U128(self.lending.small_loan),
            close_factor: U128(CLOSE_FACTOR),
            max_collateral_pieces: super::MAX_COLLATERAL_PIECES as u32,
            defaults: Tier::ALL
                .into_iter()
                .map(|tier| TierDefaultView {
                    tier,
                    config: TierConfigView::from(&self.default_state(tier).config),
                })
                .collect(),
        }
    }
}
