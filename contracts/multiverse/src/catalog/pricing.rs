//! Pricing an opening: the reference prices of a listed market (TWAP only,
//! never current reserves), the spot reference `S_ref` from the anchors, a
//! new event's shape from its terms, a combination's shape from its events'
//! reference markets, and the goal.

use multiverse_math::odds;
use multiverse_math::seed::{self, SeedInput};
use near_sdk::json_types::U128;

use super::{Check, MarketParams, OpeningTerms, ReferenceView, BPS_DENOM, BPS_WAD};
use crate::amm::MAX_SPOT_TWAP_TICKS;
use crate::masks;
use crate::prices::{MarketPriceCfg, WorldStatus};
use crate::types::WAD;
use crate::{now_sec, Contract};

/// The outside reference counts for `require_external` up to this age.
pub const EXTERNAL_MAX_AGE_SEC: u64 = 3_600;

/// A listed market's prices from its TWAPs: odds and world prices over its
/// worlds (0 for dead ones) and the spot they imply.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RefPrices {
    pub q: Vec<u128>,
    pub p: Vec<u128>,
    pub implied: u128,
    pub possible: u8,
}

/// `S_ref` and the anchors it came from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SpotRef {
    pub s_ref: u128,
    pub anchors: Vec<(u64, u128)>,
}

/// A market's opening odds and world prices, and for a combination the
/// reference read for each event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Shape {
    pub q: Vec<u128>,
    pub p: Vec<u128>,
    pub references: Vec<ReferenceView>,
}

/// `|a / b - 1| <= bps`, computed without division.
fn within_bps(a: u128, b: u128, bps: u16) -> bool {
    let limit = multiverse_math::checked_mul_div(
        b,
        u128::from(bps),
        BPS_DENOM,
        multiverse_math::Rounding::Down,
    )
    .unwrap_or(u128::MAX);
    a.abs_diff(b) <= limit
}

impl Contract {
    /// The prices a listed market offers as a reference (SPEC-C 3.7.4), or
    /// why it cannot: `halted`, `resolved`, `no_pool`, `young` (no full TWAP
    /// window), `shallow` (world depth below `min_reference_depth_usdc`),
    /// `out_of_band`, `odds_unknown` or `thin_odds` (an odds pool's smaller
    /// reserve below `min_reference_odds_depth_usdc`).
    pub(crate) fn reference_prices(
        &self,
        sid: u64,
        params: &MarketParams,
    ) -> Result<RefPrices, &'static str> {
        let s = self.scenarios.get(&sid).ok_or("no_pool")?;
        if self.halted(s) {
            return Err("halted");
        }
        if masks::is_single_world(s.possible) {
            return Err("resolved");
        }
        let (world_count, possible) = (s.world_count, s.possible);
        let cfg = MarketPriceCfg {
            min_age_sec: self.params.twap_window_sec,
            min_depth: params.min_reference_depth_usdc,
            reference: false,
            max_deviation: U128(WAD / 10),
            max_haircut: U128(0),
        };
        let mut p = vec![0u128; usize::from(world_count)];
        for w in 0..world_count {
            if !masks::contains(possible, w) {
                continue;
            }
            let quote = self.world_quote(sid, w, &cfg);
            match quote.status {
                WorldStatus::NoPool => return Err("no_pool"),
                WorldStatus::Young => return Err("young"),
                _ if !quote.full_window || quote.twap == 0 => return Err("young"),
                WorldStatus::Shallow => return Err("shallow"),
                _ if quote.depth < cfg.min_depth.0 => return Err("shallow"),
                WorldStatus::OutOfBand => return Err("out_of_band"),
                WorldStatus::Trusted => {}
            }
            p[usize::from(w)] = quote.twap;
        }
        for &(x, y) in odds::pairs(world_count) {
            if x & possible == 0 || y & possible == 0 {
                continue;
            }
            let pool = self
                .between
                .get(&(sid, x, y))
                .and_then(|id| self.pools.get(id))
                .ok_or("odds_unknown")?;
            if !self.pool_full_window(pool) {
                return Err("young");
            }
            let mean = self.pool_mean_tick(pool).ok_or("young")?;
            let latest = pool.twap.latest().map_or(mean, |o| o.tick);
            if (i64::from(latest) - i64::from(mean)).abs() > i64::from(MAX_SPOT_TWAP_TICKS) {
                return Err("out_of_band");
            }
            let (r0, r1) = pool.amm.reserves();
            if r0.min(r1) < params.min_reference_odds_depth_usdc.0 {
                return Err("thin_odds");
            }
        }
        let odds_cfg = MarketPriceCfg {
            min_depth: U128(0),
            ..cfg
        };
        let q = self.twap_odds(sid, &odds_cfg).ok_or("odds_unknown")?;
        let implied = odds::implied_spot(&q, possible, |w| p.get(usize::from(w)).copied())
            .ok_or("odds_unknown")?;
        Ok(RefPrices {
            q,
            p,
            implied,
            possible,
        })
    }

    /// `S_ref`: the median spot implied by the valid anchors (listed, with
    /// reference prices), which must agree within `max_anchor_divergence_bps`;
    /// with `require_external`, a reference at most an hour old that agrees
    /// within `max_external_divergence_bps`. Errors: `NoSpotReference`,
    /// `AnchorsDisagree(sid, implied, s_ref)`, `ReferenceMissing`,
    /// `ReferenceStale(age, 3600)`, `ExternalDisagrees(ext, s_ref)`.
    pub(crate) fn spot_reference(&self, params: &MarketParams) -> Check<SpotRef> {
        let mut anchors: Vec<(u64, u128)> = params
            .anchors
            .iter()
            .filter(|sid| **sid != 0 && self.market_entry(**sid).listed)
            .filter_map(|sid| {
                self.reference_prices(*sid, params)
                    .ok()
                    .map(|r| (*sid, r.implied))
            })
            .collect();
        if anchors.is_empty() {
            return Err("NoSpotReference".to_string());
        }
        anchors.sort_by_key(|(_, implied)| *implied);
        let n = anchors.len();
        let s_ref = if n % 2 == 1 {
            anchors[n / 2].1
        } else {
            (anchors[n / 2 - 1].1 + anchors[n / 2].1) / 2
        };
        let (low, high) = (anchors[0].1, anchors[n - 1].1);
        if !within_bps(high, low, params.max_anchor_divergence_bps) {
            let (sid, implied) = if s_ref - low >= high - s_ref {
                anchors[0]
            } else {
                anchors[n - 1]
            };
            return Err(format!("AnchorsDisagree({sid}, {implied}, {s_ref})"));
        }
        if params.require_external {
            let state = self.reference_state().unwrap_or_default();
            if state.price == 0 {
                return Err("ReferenceMissing".to_string());
            }
            let age = now_sec().saturating_sub(state.observed_at);
            if age > EXTERNAL_MAX_AGE_SEC {
                return Err(format!("ReferenceStale({age}, {EXTERNAL_MAX_AGE_SEC})"));
            }
            if !within_bps(s_ref, state.price, params.max_external_divergence_bps) {
                return Err(format!("ExternalDisagrees({}, {s_ref})", state.price));
            }
        }
        Ok(SpotRef { s_ref, anchors })
    }

    /// A combination's shape at `s_ref` from each event's reference market
    /// (`NoReferenceMarket(e)`, `ReferenceUnavailable(sid, reason)`,
    /// `ReferenceDiverges(sid, implied, s_ref)` per event, then
    /// `PriceOutOfRange(w)`).
    pub(crate) fn kind_b_shape(
        &self,
        events: &[u64],
        s_ref: u128,
        params: &MarketParams,
    ) -> Check<Shape> {
        let mut marginals = Vec::with_capacity(events.len());
        let mut references = Vec::with_capacity(events.len());
        for &e in events {
            let sid = self
                .catalog
                .reference_market
                .get(&e)
                .copied()
                .filter(|sid| self.check_reference(e, *sid).is_ok())
                .ok_or_else(|| format!("NoReferenceMarket({e})"))?;
            let r = self
                .reference_prices(sid, params)
                .map_err(|reason| format!("ReferenceUnavailable({sid}, {reason})"))?;
            if !within_bps(r.implied, s_ref, params.max_reference_divergence_bps) {
                return Err(format!("ReferenceDiverges({sid}, {}, {s_ref})", r.implied));
            }
            let k = self.scenario(sid).event_index(sid, e) as u8;
            let m = seed::marginal(&r.q, &r.p, r.possible, k)
                .ok_or_else(|| format!("ReferenceUnavailable({sid}, odds_unknown)"))?;
            references.push(ReferenceView {
                event_id: e,
                scenario_id: sid,
                odds0: U128(m.odds0),
                ratio0: U128(m.ratio[0]),
                ratio1: U128(m.ratio[1]),
                implied: U128(r.implied),
            });
            marginals.push(m);
        }
        let clamp = u128::from(params.odds_clamp_bps) * BPS_WAD;
        let (q, m) =
            seed::kind_b_shape(&marginals, clamp).ok_or_else(|| "PlanFailed(shape)".to_string())?;
        let (p, total) =
            seed::shape_prices(&q, &m, s_ref).map_err(|e| format!("PlanFailed({e})"))?;
        let [low, high] = params.mult_b_bps.map(|b| u128::from(b) * BPS_WAD);
        for (w, mw) in m.iter().enumerate() {
            let ratio =
                multiverse_math::checked_mul_div(*mw, WAD, total, multiverse_math::Rounding::Down)
                    .unwrap_or(u128::MAX);
            if ratio < low || ratio > high {
                return Err(format!("PriceOutOfRange({w})"));
            }
        }
        Ok(Shape { q, p, references })
    }

    /// A new event's shape at `s_ref` from its terms.
    pub(crate) fn kind_a_shape(
        &self,
        terms: &OpeningTerms,
        s_ref: u128,
        params: &MarketParams,
    ) -> Check<Shape> {
        let (q, m) = check_terms(terms, params)?;
        let (p, _) = seed::shape_prices(&q, &m, s_ref).map_err(|e| format!("PlanFailed({e})"))?;
        Ok(Shape {
            q,
            p,
            references: Vec::new(),
        })
    }

    /// The goal and the ideal mix `(goal, wNEAR, USDC)` of a shape at `s_ref`.
    pub(crate) fn goal_of(
        &self,
        shape: &Shape,
        s_ref: u128,
        params: &MarketParams,
    ) -> Check<(u128, u128, u128)> {
        let input = SeedInput {
            world_count: shape.q.len() as u8,
            q: &shape.q,
            p: &shape.p,
            s: s_ref,
            beta: u128::from(params.beta_bps) * BPS_WAD,
            pledged_wnear: 0,
            pledged_usdc: 0,
        };
        seed::goal_for(
            &input,
            params.goal_depth_usdc.0,
            params.goal_round_usdc.0,
            params.min_goal_usdc.0,
        )
        .map_err(|e| format!("PlanFailed({e})"))
    }
}

/// A new event's terms: `BadTerms(odds0)` unless the odds of outcome 0 lie in
/// `[odds_clamp, 1 - odds_clamp]`, `BadTerms(mult)` unless both raw and
/// normalised multipliers lie in `mult_a_bps`. Returns the shape `(q, m)`.
pub(crate) fn check_terms(
    terms: &OpeningTerms,
    params: &MarketParams,
) -> Check<(Vec<u128>, Vec<u128>)> {
    let clamp = params.odds_clamp_bps;
    if terms.odds0_bps < clamp || terms.odds0_bps > 10_000u16.saturating_sub(clamp) {
        return Err("BadTerms(odds0)".to_string());
    }
    let [low, high] = params.mult_a_bps;
    let bad_mult = || "BadTerms(mult)".to_string();
    if terms.mult_bps.iter().any(|m| *m < low || *m > high) {
        return Err(bad_mult());
    }
    let (q, m) = seed::kind_a_shape(terms.odds0_bps, terms.mult_bps).ok_or_else(bad_mult)?;
    let (low, high) = (u128::from(low) * BPS_WAD, u128::from(high) * BPS_WAD);
    if m.iter().any(|x| *x < low || *x > high) {
        return Err(bad_mult());
    }
    Ok((q, m))
}
