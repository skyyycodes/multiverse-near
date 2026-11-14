//! The v1 profile. `World::new()` installs it through the real owner setters,
//! so the v1 suites run unchanged through v2 code: lending at v1's terms (one
//! flat rate, no reserve, `borrow_ltv = lltv` = 0.75, bonus 0.05, no minimum
//! loan and no full liquidation) and prices behind v1's gates (60 s of
//! history, 10,000 USDC of depth, no outside reference, no haircut).
//! `World::new_v2()` skips it and runs on the production defaults.

use near_sdk::json_types::U128;

use super::harness::{World, E18, ONE_YOCTO, OWNER};
use crate::lending::tiers::{LendingParamsInput, Tier, TierConfigInput};
use crate::prices::MarketPriceCfg;

/// v1's lending terms as a Normal tier config: lltv = borrow LTV 0.75, bonus
/// 0.05, the flat 5% rate (no slopes), no reserve, no utilization cap.
pub fn v1_tier_config() -> TierConfigInput {
    TierConfigInput {
        lltv: U128(750_000_000_000_000_000),
        borrow_ltv: U128(750_000_000_000_000_000),
        liquidation_bonus: U128(50_000_000_000_000_000),
        reserve_factor: U128(0),
        rate_base: U128(1_585_489_599),
        rate_slope1: U128(0),
        rate_slope2: U128(0),
        rate_kink: U128(800_000_000_000_000_000),
        max_utilization: U128(1_000_000_000_000_000_000),
        borrow_cap: None,
    }
}

/// Lending at v1's terms: the Normal tier's default config and the global
/// lending params, set through the owner setters.
pub fn v1_lending_profile(w: &mut World) {
    w.call(OWNER, ONE_YOCTO, |c| {
        c.set_default_tier_config(Tier::Normal, v1_tier_config())
    })
    .expect("v1 tier config");
    w.call(OWNER, ONE_YOCTO, |c| {
        c.set_lending_params(LendingParamsInput {
            min_loan: U128(0),
            full_liquidation_hf: U128(0),
            small_loan: U128(0),
        })
    })
    .expect("v1 lending params");
}

/// The price config of the v1 profile: v1's gates (60 s of TWAP history,
/// 10,000 USDC of depth), no outside reference and no haircut.
pub const V1_PRICE_CFG: MarketPriceCfg = MarketPriceCfg {
    min_age_sec: 60,
    min_depth: U128(10_000 * E18),
    reference: false,
    max_deviation: U128(E18 / 10),
    max_haircut: U128(0),
};

/// Prices behind v1's gates: the default price config, set through the owner
/// setter before any scenario exists, so every scenario of the fixture
/// snapshots it.
pub fn v1_price_profile(w: &mut World) {
    w.call(OWNER, ONE_YOCTO, |c| {
        c.set_default_price_config(V1_PRICE_CFG)
    })
    .expect("v1 price profile");
}
