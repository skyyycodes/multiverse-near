//! Lending tiers: three money markets per scenario (Safe, Normal, Bold), each
//! with its own pool of USDC, its own liquidation LTV and rate curve.
//!
//! A market is `MarketId { scenario_id, tier }`, stored under
//! `scenario_id | tier_code << 56`. Normal's code is 0, so every v1 lending
//! entry, keyed by the bare scenario id, is already the Normal tier of its
//! scenario and nothing is re-keyed. Key `0 | code << 56` holds a tier's
//! default config (scenario 0 never exists).

use multiverse_math::irm::Curve;
use multiverse_math::mul_div_down;
use multiverse_math::risk::CLOSE_FACTOR;
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{assert_one_yocto, env, near};

use crate::errors::fail;
use crate::events::MultiverseEvent;
use crate::types::{Params, WAD};
use crate::{Contract, ContractExt};

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

pub use multiverse_math::irm::{MAX_RATE_PER_SEC, SECONDS_PER_YEAR};

/// A per-second rate from an APR in hundredths of a percent, rounded down.
const fn per_sec(apr_bps: u128) -> u128 {
    multiverse_math::irm::rate_per_sec(apr_bps)
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

/// 0.10: the default gap between a tier's liquidation LTV and its borrow LTV.
pub const BORROW_CUSHION: u128 = WAD / 10;

impl TierConfig {
    /// The rate curve, for the maths crate.
    pub fn curve(&self) -> Curve {
        Curve {
            base: self.rate_base,
            slope1: self.rate_slope1,
            slope2: self.rate_slope2,
            kink: self.rate_kink,
        }
    }

    /// A legacy market that had debt at the upgrade keeps v1's economics
    /// exactly: v1's lltv and bonus, its flat rate (no slopes), no reserve and
    /// no utilization cap. Only the borrow side gains the 0.10 cushion.
    pub fn v1_terms(params: &Params) -> Self {
        Self {
            lltv: params.lltv,
            borrow_ltv: params.lltv.saturating_sub(BORROW_CUSHION),
            liquidation_bonus: params.liquidation_bonus,
            reserve_factor: 0,
            rate_base: params.borrow_rate_per_sec,
            rate_slope1: 0,
            rate_slope2: 0,
            rate_kink: pct(8_000),
            max_utilization: WAD,
            borrow_cap: u128::MAX,
        }
    }

    /// Every other legacy Normal market: v1's lltv and bonus on the Normal
    /// curve, reserve and utilization cap.
    pub fn legacy_live(params: &Params) -> Self {
        let normal = TierState::builtin(Tier::Normal).config;
        Self {
            lltv: params.lltv,
            borrow_ltv: params.lltv.saturating_sub(BORROW_CUSHION),
            liquidation_bonus: params.liquidation_bonus,
            ..normal
        }
    }

    /// The bounds every stored config meets (L-7), checked in this order.
    pub fn validate(&self) {
        if !(pct(3_000)..=pct(8_500)).contains(&self.lltv) {
            fail("InvalidTierConfig(lltv)");
        }
        if self.borrow_ltv == 0 || self.borrow_ltv > self.lltv {
            fail("InvalidTierConfig(borrow_ltv)");
        }
        let bonus = self.liquidation_bonus;
        if !(pct(100)..=pct(1_500)).contains(&bonus)
            || mul_div_down(self.lltv, WAD + bonus, WAD) >= pct(9_000)
        {
            fail!("InvalidLiquidationBonus({bonus})");
        }
        if self.reserve_factor > pct(5_000) {
            fail("InvalidTierConfig(reserve_factor)");
        }
        let top = self
            .rate_base
            .checked_add(self.rate_slope1)
            .and_then(|r| r.checked_add(self.rate_slope2));
        if !(pct(5_000)..=pct(9_500)).contains(&self.rate_kink)
            || top.is_none_or(|r| r > MAX_RATE_PER_SEC)
        {
            fail("InvalidTierConfig(rate)");
        }
        if !(pct(5_000)..=WAD).contains(&self.max_utilization) {
            fail("InvalidTierConfig(max_utilization)");
        }
        if self.borrow_cap == 0 {
            fail("InvalidTierConfig(borrow_cap)");
        }
    }
}

impl LendingParams {
    /// v1's lending: no minimum loan, no full liquidation.
    pub const OFF: Self = Self {
        min_loan: 0,
        full_liquidation_hf: 0,
        small_loan: 0,
    };

    pub fn validate(&self) {
        if self.min_loan > 10_000 * WAD {
            fail("InvalidLendingParams(min_loan)");
        }
        let hf = self.full_liquidation_hf;
        if hf != 0 && !(pct(9_000)..=WAD).contains(&hf) {
            fail("InvalidLendingParams(full_liquidation_hf)");
        }
        if self.small_loan < self.min_loan.saturating_mul(2) {
            fail("InvalidLendingParams(small_loan)");
        }
    }
}

/// A config as the owner sends it: every field required, U128 strings;
/// `borrow_cap` null for none.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TierConfigInput {
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

impl From<TierConfigInput> for TierConfig {
    fn from(c: TierConfigInput) -> Self {
        Self {
            lltv: c.lltv.0,
            borrow_ltv: c.borrow_ltv.0,
            liquidation_bonus: c.liquidation_bonus.0,
            reserve_factor: c.reserve_factor.0,
            rate_base: c.rate_base.0,
            rate_slope1: c.rate_slope1.0,
            rate_slope2: c.rate_slope2.0,
            rate_kink: c.rate_kink.0,
            max_utilization: c.max_utilization.0,
            borrow_cap: c.borrow_cap.map_or(u128::MAX, |cap| cap.0),
        }
    }
}

impl From<&TierConfig> for TierConfigInput {
    fn from(c: &TierConfig) -> Self {
        let v = TierConfigView::from(c);
        Self {
            lltv: v.lltv,
            borrow_ltv: v.borrow_ltv,
            liquidation_bonus: v.liquidation_bonus,
            reserve_factor: v.reserve_factor,
            rate_base: v.rate_base,
            rate_slope1: v.rate_slope1,
            rate_slope2: v.rate_slope2,
            rate_kink: v.rate_kink,
            max_utilization: v.max_utilization,
            borrow_cap: v.borrow_cap,
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LendingParamsInput {
    pub min_loan: U128,
    pub full_liquidation_hf: U128,
    pub small_loan: U128,
}

/// Where a market's config comes from: its own record, or its tier's default
/// until the market is first touched.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConfigSource {
    Stored,
    Default,
}

/// `tier_config(scenario_id, tier)`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TierConfigResult {
    pub config: TierConfigView,
    pub frozen: bool,
    pub source: ConfigSource,
}

/// `scenario_id` 0 = a tier's default.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct TierConfigSet {
    scenario_id: u64,
    tier: Tier,
    config: TierConfigView,
}

impl MultiverseEvent for TierConfigSet {
    const NAME: &'static str = "tier_config_set";
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct MarketFrozenSet {
    scenario_id: u64,
    tier: Tier,
    frozen: bool,
}

impl MultiverseEvent for MarketFrozenSet {
    const NAME: &'static str = "market_frozen";
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct LendingParamsSet {
    min_loan: U128,
    full_liquidation_hf: U128,
    small_loan: U128,
}

impl MultiverseEvent for LendingParamsSet {
    const NAME: &'static str = "lending_params_set";
}

#[near]
impl Contract {
    /// The config new markets of `tier` snapshot on their first touch.
    /// Markets already touched keep theirs.
    #[payable]
    #[deny_unknown_arguments]
    pub fn set_default_tier_config(&mut self, tier: Tier, config: TierConfigInput) {
        assert_one_yocto();
        self.assert_owner();
        let config = TierConfig::from(config);
        config.validate();
        let owner = env::predecessor_account_id();
        let before = env::storage_usage();
        let key = MarketId::new(0, Some(tier)).key();
        let mut state = self.default_state(tier);
        state.config = config;
        TierConfigSet {
            scenario_id: 0,
            tier,
            config: TierConfigView::from(&state.config),
        }
        .emit();
        self.tier_states.insert(key, state);
        self.charge_storage(&owner, before);
    }

    /// One market's config. Interest up to now accrues on the old curve
    /// first; the liquidation LTV cannot fall while the market has debt.
    /// Frozen, insurance and the bad-debt counters are kept.
    #[payable]
    #[deny_unknown_arguments]
    pub fn set_tier_config(&mut self, scenario_id: u64, tier: Tier, config: TierConfigInput) {
        assert_one_yocto();
        self.assert_owner();
        self.scenario(scenario_id);
        let owner = env::predecessor_account_id();
        let before = env::storage_usage();
        let id = MarketId::new(scenario_id, Some(tier));
        let (m, mut st) = self.accrue(id);
        let config = TierConfig::from(config);
        config.validate();
        if config.lltv < st.config.lltv && m.total_borrow_shares > 0 {
            fail!("LltvDecreaseWithDebt({}, {})", st.config.lltv, config.lltv);
        }
        st.config = config;
        TierConfigSet {
            scenario_id,
            tier,
            config: TierConfigView::from(&st.config),
        }
        .emit();
        self.tier_states.insert(id.key(), st);
        self.charge_storage(&owner, before);
    }

    /// A frozen market takes no new supply and no new borrowing; everything
    /// else (repay, withdraw, collateral, liquidation) goes on.
    #[payable]
    #[deny_unknown_arguments]
    pub fn set_market_frozen(&mut self, scenario_id: u64, tier: Tier, frozen: bool) {
        assert_one_yocto();
        self.assert_owner();
        self.scenario(scenario_id);
        let owner = env::predecessor_account_id();
        let before = env::storage_usage();
        let id = MarketId::new(scenario_id, Some(tier));
        let (_, mut st) = self.accrue(id);
        st.frozen = frozen;
        self.tier_states.insert(id.key(), st);
        MarketFrozenSet {
            scenario_id,
            tier,
            frozen,
        }
        .emit();
        self.charge_storage(&owner, before);
    }

    /// The global lending rules: minimum loan, full-liquidation HF and
    /// small-loan line.
    #[payable]
    pub fn set_lending_params(&mut self, params: LendingParamsInput) {
        assert_one_yocto();
        self.assert_owner();
        let params = LendingParams {
            min_loan: params.min_loan.0,
            full_liquidation_hf: params.full_liquidation_hf.0,
            small_loan: params.small_loan.0,
        };
        params.validate();
        LendingParamsSet {
            min_loan: U128(params.min_loan),
            full_liquidation_hf: U128(params.full_liquidation_hf),
            small_loan: U128(params.small_loan),
        }
        .emit();
        self.lending = params;
    }

    /// A market's config, frozen flag and whether it is its own record or
    /// still its tier's default.
    #[deny_unknown_arguments]
    pub fn tier_config(&self, scenario_id: u64, tier: Tier) -> TierConfigResult {
        let id = MarketId::new(scenario_id, Some(tier));
        let stored = self.tier_states.get(&id.key());
        let source = if stored.is_some() {
            ConfigSource::Stored
        } else {
            ConfigSource::Default
        };
        let st = self.tier_state(id);
        TierConfigResult {
            config: TierConfigView::from(&st.config),
            frozen: st.frozen,
            source,
        }
    }
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
