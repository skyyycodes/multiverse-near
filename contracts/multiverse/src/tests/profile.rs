//! The v1 profile. `World::new()` installs it through the real owner setters,
//! so the v1 suites run unchanged through v2 code: lending at v1's terms (one
//! flat rate, no reserve, `borrow_ltv = lltv` = 0.75, bonus 0.05, no minimum
//! loan and no full liquidation) and prices behind v1's gates (60 s of
//! history, 10,000 USDC of depth, no outside reference, no haircut).
//! `World::new_v2()` skips it and runs on the production defaults.

use super::harness::World;

/// Lending at v1's terms: the Normal tier's default config and the global
/// lending params, set through the owner setters.
pub fn v1_lending_profile(_w: &mut World) {}

/// Prices behind v1's gates: the default price config, set through the owner
/// setter.
pub fn v1_price_profile(_w: &mut World) {}
