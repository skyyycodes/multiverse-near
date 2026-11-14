//! The v1 profile. `World::new()` installs it through the real owner setters,
//! so the v1 suites run unchanged through v2 code: lending at v1's terms (one
//! flat rate, no reserve, `borrow_ltv = lltv` = 0.75, bonus 0.05, no minimum
//! loan and no full liquidation) and prices behind v1's gates (60 s of
//! history, 10,000 USDC of depth, no outside reference, no haircut).
//! `World::new_v2()` skips it and runs on the production defaults.

use near_sdk::json_types::U128;

use super::harness::{World, E18, ONE_YOCTO, OWNER};
use crate::prices::MarketPriceCfg;

/// Lending at v1's terms: the Normal tier's default config and the global
/// lending params, set through the owner setters.
pub fn v1_lending_profile(_w: &mut World) {}

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
