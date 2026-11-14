//! Interest: one pure projection of a market to a moment, which `accrue`
//! writes and every view reads, so a view always shows what the next
//! accrual stores.
//!
//! The rate is read at the utilization the market had at its last touch and
//! held for the interval; interest is simple within an interval and
//! compounds at every touch (v1). A reserve factor of the interest goes to
//! the market's insurance; lenders get the rest. With no slopes and no
//! reserve this is v1's accrual bit for bit.

use multiverse_math::irm;
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;

use super::tiers::{MarketId, Tier, TierState};
use super::Market;
use crate::errors::add;
use crate::events::MultiverseEvent;
use crate::{now_sec, Contract};

/// What `accrue` writes at `now`, computed without writing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Projection {
    pub market: Market,
    pub insurance: u128,
    pub interest: u128,
    pub cut: u128,
    /// The rate the interval ran at (per second, WAD).
    pub rate: u128,
}

/// `m` and its tier state projected to `now`. Pure.
pub(crate) fn project(m: &Market, st: &TierState, now: u64) -> Projection {
    let elapsed = if m.last_update == 0 {
        0
    } else {
        now.saturating_sub(m.last_update)
    };
    let a = irm::accrue(
        m.total_supply_assets,
        m.total_borrow_assets,
        &st.config.curve(),
        st.config.reserve_factor,
        elapsed,
    );
    let mut market = m.clone();
    market.total_borrow_assets = add(market.total_borrow_assets, a.interest);
    market.total_supply_assets = add(market.total_supply_assets, a.interest - a.cut);
    market.last_update = now;
    Projection {
        market,
        insurance: add(st.insurance, a.cut),
        interest: a.interest,
        cut: a.cut,
        rate: a.rate,
    }
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct AccrueLog {
    scenario_id: u64,
    #[serde(skip_serializing_if = "Tier::is_normal")]
    tier: Tier,
    interest: U128,
    to_insurance: U128,
}

impl MultiverseEvent for AccrueLog {
    const NAME: &'static str = "accrue";
}

impl Contract {
    /// The market as stored (zeros before its first touch).
    pub(crate) fn market_of(&self, id: MarketId) -> Market {
        self.markets.get(&id.key()).cloned().unwrap_or_default()
    }

    /// The market and its tier state projected to now, for views.
    pub(crate) fn projected(&self, id: MarketId) -> (Projection, TierState) {
        let st = self.tier_state(id);
        let p = project(&self.market_of(id), &st, now_sec());
        let mut st = st;
        st.insurance = p.insurance;
        (p, st)
    }

    /// Brings the market to now and stores it, also on its first touch,
    /// when its tier state is snapshot from the tier's default. The only
    /// place a market materializes. Logs `accrue` when interest ran.
    pub(crate) fn accrue(&mut self, id: MarketId) -> (Market, TierState) {
        let stored_state = self.tier_states.get(&id.key()).cloned();
        let fresh = stored_state.is_none();
        let mut st = stored_state.unwrap_or_else(|| self.default_state(id.tier));
        let p = project(&self.market_of(id), &st, now_sec());
        if p.interest > 0 {
            AccrueLog {
                scenario_id: id.scenario_id,
                tier: id.tier,
                interest: U128(p.interest),
                to_insurance: U128(p.cut),
            }
            .emit();
        }
        self.markets.insert(id.key(), p.market.clone());
        if fresh || p.cut > 0 {
            st.insurance = p.insurance;
            self.tier_states.insert(id.key(), st.clone());
        }
        (p.market, st)
    }

    /// Stores a market and its tier state after an action changed them.
    pub(crate) fn store_market(&mut self, id: MarketId, m: Market, st: &TierState) {
        self.markets.insert(id.key(), m);
        let changed = self.tier_states.get(&id.key()) != Some(st);
        if changed {
            self.tier_states.insert(id.key(), st.clone());
        }
    }
}
