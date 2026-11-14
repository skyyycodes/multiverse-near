//! The opening planner of pledge-funded markets: how pledged wNEAR and USDC
//! become world pools and odds pools at given odds and prices, the goal of a
//! proposal, and the pledgers' shares and unused parts.
//!
//! Everything a pool or a user receives rounds down; what the planner takes
//! from the pledges rounds the other way, so an opening never uses more than
//! was pledged. All products are full-width `mul_div`s. The same arithmetic is
//! mirrored in `scripts/lib/seed-plan.ts` and pinned by
//! `tests/data/seed-vectors.json`.

use core::fmt;

use crate::fixed::{checked_mul_div, Rounding, WAD};
use crate::odds;

/// One basis point in WAD.
pub const BPS: u128 = 100_000_000_000_000;

/// The asset of an idle custody token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeedAsset {
    Wnear,
    Usdc,
}

/// What the planner works from. `q` (odds) and `p` (USDC per wNEAR) have one
/// entry per world; `s` is the spot reference and `beta` the odds pools'
/// depth per unit of base depth, both WAD.
#[derive(Clone, Copy, Debug)]
pub struct SeedInput<'a> {
    pub world_count: u8,
    pub q: &'a [u128],
    pub p: &'a [u128],
    pub s: u128,
    pub beta: u128,
    pub pledged_wnear: u128,
    pub pledged_usdc: u128,
}

/// What an opening creates. Every world is covered by exactly `used_wnear`
/// wNEAR and `used_usdc` USDC across its pool, the odds sides containing it
/// and its idle tokens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeedPlan {
    /// Base depth `d`: the wNEAR every world pool would hold at the first cut.
    pub base: u128,
    pub used_wnear: u128,
    pub used_usdc: u128,
    /// `(wNEAR-if-w, USDC-if-w)` per world pool, in world order.
    pub world: Vec<(u128, u128)>,
    /// `(mask0, mask1, amount0, amount1)` per odds pool, in `pairs()` order.
    pub odds_pools: Vec<(u8, u8, u128, u128)>,
    /// Single-world custody leftovers, by world, wNEAR first; no zeros.
    pub idle: Vec<(SeedAsset, u8, u128)>,
    /// `floor(used_wnear * s) + used_usdc`: the opening value, = the shares.
    pub usable_value: u128,
    /// What the idle tokens are worth at the opening odds and prices.
    pub idle_value: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanError {
    /// The pledges cannot fund one unit of every pool.
    ZeroBase,
    /// An odds pool would get nothing on one side.
    EmptyOddsSide(u8, u8),
    Overflow,
}

impl fmt::Display for PlanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PlanError::ZeroBase => f.write_str("ZeroBase"),
            PlanError::EmptyOddsSide(x, y) => write!(f, "EmptyOddsSide({x}, {y})"),
            PlanError::Overflow => f.write_str("Overflow"),
        }
    }
}

fn md(a: u128, b: u128, d: u128, rounding: Rounding) -> Result<u128, PlanError> {
    checked_mul_div(a, b, d, rounding).ok_or(PlanError::Overflow)
}

fn plus(a: u128, b: u128) -> Result<u128, PlanError> {
    a.checked_add(b).ok_or(PlanError::Overflow)
}

fn mask_odds(q: &[u128], mask: u8) -> u128 {
    q.iter()
        .enumerate()
        .filter(|(w, _)| mask & (1 << w) != 0)
        .map(|(_, v)| *v)
        .sum()
}

fn min_over(values: &[u128], mask: u8) -> u128 {
    values
        .iter()
        .enumerate()
        .filter(|(w, _)| mask & (1 << w) != 0)
        .map(|(_, v)| *v)
        .min()
        .unwrap_or(0)
}

/// One odds pool of the tree: its masks, which side is less likely, and the
/// summed odds of each side.
#[derive(Clone, Copy)]
struct Pair {
    x: u8,
    y: u8,
    /// The less likely side is `x` (ties: `x`).
    x_less: bool,
    q_less: u128,
    q_more: u128,
}

impl Pair {
    fn less_mask(&self) -> u8 {
        if self.x_less {
            self.x
        } else {
            self.y
        }
    }

    fn more_mask(&self) -> u8 {
        if self.x_less {
            self.y
        } else {
            self.x
        }
    }

    /// `(amount_x, amount_y)` from `(less, more)`.
    fn ordered(&self, less: u128, more: u128) -> (u128, u128) {
        if self.x_less {
            (less, more)
        } else {
            (more, less)
        }
    }
}

/// The tree's pairs with their odds, and per pair `(unit_less, unit_more)`:
/// the USDC each side takes per wNEAR of base depth (step 1).
fn units(i: &SeedInput) -> Result<(Vec<Pair>, Vec<(u128, u128)>), PlanError> {
    let unit = md(i.beta, i.s, WAD, Rounding::Down)?;
    let mut pairs = Vec::new();
    let mut per_unit = Vec::new();
    for &(x, y) in odds::pairs(i.world_count) {
        let (qx, qy) = (mask_odds(i.q, x), mask_odds(i.q, y));
        let x_less = qx <= qy;
        let (q_less, q_more) = if x_less { (qx, qy) } else { (qy, qx) };
        if q_less == 0 {
            return Err(PlanError::EmptyOddsSide(x, y));
        }
        let unit_more = md(unit, q_less, q_more, Rounding::Down)?;
        pairs.push(Pair {
            x,
            y,
            x_less,
            q_less,
            q_more,
        });
        per_unit.push((unit, unit_more));
    }
    Ok((pairs, per_unit))
}

/// `u = max_w (p_w + o_w)`: the USDC one wNEAR of base depth needs in the
/// hungriest world (step 2).
fn usdc_per_base(
    i: &SeedInput,
    pairs: &[Pair],
    per_unit: &[(u128, u128)],
) -> Result<u128, PlanError> {
    let mut u = 0;
    for w in 0..i.world_count {
        let mut need = i.p[usize::from(w)];
        for (pair, &(ul, um)) in pairs.iter().zip(per_unit) {
            if pair.less_mask() & (1 << w) != 0 {
                need = plus(need, ul)?;
            }
            if pair.more_mask() & (1 << w) != 0 {
                need = plus(need, um)?;
            }
        }
        u = u.max(need);
    }
    Ok(u)
}

fn check_input(i: &SeedInput) -> Result<usize, PlanError> {
    let n = usize::from(i.world_count);
    if odds::pairs(i.world_count).is_empty()
        || i.q.len() != n
        || i.p.len() != n
        || i.p.iter().any(|p| *p == 0)
        || i.s == 0
    {
        return Err(PlanError::ZeroBase);
    }
    Ok(n)
}

/// The opening plan for the pledged amounts (SPEC-C 3.7.6 steps 1-6).
pub fn seed_plan(i: &SeedInput) -> Result<SeedPlan, PlanError> {
    let n = check_input(i)?;
    let (pairs, per_unit) = units(i)?;
    let u = usdc_per_base(i, &pairs, &per_unit)?;
    // Step 2: base depth.
    let d = i
        .pledged_wnear
        .min(md(i.pledged_usdc, WAD, u, Rounding::Down)?);
    if d == 0 {
        return Err(PlanError::ZeroBase);
    }
    // Step 3: amounts at d, consumption per world and leftovers.
    let mut sides = Vec::with_capacity(pairs.len());
    for (pair, &(ul, um)) in pairs.iter().zip(&per_unit) {
        let less = md(d, ul, WAD, Rounding::Down)?;
        let more = md(d, um, WAD, Rounding::Down)?;
        if less == 0 || more == 0 {
            return Err(PlanError::EmptyOddsSide(pair.x, pair.y));
        }
        sides.push((less, more));
    }
    let mut used = vec![0u128; n];
    for w in 0..n {
        let world_usdc = md(d, i.p[w], WAD, Rounding::Down)?;
        if world_usdc == 0 {
            return Err(PlanError::ZeroBase);
        }
        used[w] = world_usdc;
    }
    let consumption = |sides: &[(u128, u128)], w: usize| -> Result<u128, PlanError> {
        let mut c = 0u128;
        for (pair, &(less, more)) in pairs.iter().zip(sides) {
            if pair.less_mask() & (1 << w) != 0 {
                c = plus(c, less)?;
            }
            if pair.more_mask() & (1 << w) != 0 {
                c = plus(c, more)?;
            }
        }
        Ok(c)
    };
    for (w, total) in used.iter_mut().enumerate() {
        *total = plus(*total, consumption(&sides, w)?)?;
    }
    let u_used = used.iter().copied().max().unwrap_or(0);
    let mut left: Vec<u128> = used.iter().map(|c| u_used - c).collect();

    // Step 4: soak the leftovers into the odds pools, children first.
    for k in (0..pairs.len()).rev() {
        let pair = pairs[k];
        let (less, more) = sides[k];
        let left_less = min_over(&left, pair.less_mask());
        let left_more = min_over(&left, pair.more_mask());
        let t = left_less.min(md(left_more, pair.q_more, pair.q_less, Rounding::Down)?);
        let new_less = plus(less, t)?;
        let new_more = md(new_less, pair.q_less, pair.q_more, Rounding::Down)?
            .min(plus(more, left_more)?)
            .max(more);
        for (w, l) in left.iter_mut().enumerate() {
            if pair.less_mask() & (1 << w) != 0 {
                *l -= t;
            }
            if pair.more_mask() & (1 << w) != 0 {
                *l -= new_more - more;
            }
        }
        sides[k] = (new_less, new_more);
    }

    // Step 5: spare wNEAR deepens the worlds with USDC left.
    let mut odds_use = vec![0u128; n];
    let mut cap = vec![0u128; n];
    for w in 0..n {
        odds_use[w] = consumption(&sides, w)?;
        cap[w] = md(u_used - odds_use[w], WAD, i.p[w], Rounding::Down)?;
    }
    let mut candidates = vec![d];
    for w in 0..n {
        if left[w] > 0 {
            candidates.push(i.pledged_wnear.min(cap[w]));
        }
    }
    let layout = |a: u128| -> Result<(Vec<(u128, u128)>, u128), PlanError> {
        let mut world = Vec::with_capacity(n);
        let mut idle_value = 0u128;
        for w in 0..n {
            let a_w = a.min(cap[w]);
            let usdc_w = md(a_w, i.p[w], WAD, Rounding::Down)?;
            let idle_usdc = u_used - usdc_w - odds_use[w];
            let idle_wnear_value = md(a - a_w, i.p[w], WAD, Rounding::Down)?;
            idle_value = plus(
                idle_value,
                md(
                    i.q[w],
                    plus(idle_wnear_value, idle_usdc)?,
                    WAD,
                    Rounding::Down,
                )?,
            )?;
            world.push((a_w, usdc_w));
        }
        Ok((world, idle_value))
    };
    let mut best: Option<(u128, Vec<(u128, u128)>, u128)> = None;
    for a in candidates {
        let (world, idle_value) = layout(a)?;
        let better = match &best {
            None => true,
            Some((best_a, _, best_idle)) => {
                idle_value < *best_idle || (idle_value == *best_idle && a < *best_a)
            }
        };
        if better {
            best = Some((a, world, idle_value));
        }
    }
    let (a, world, idle_value) = best.ok_or(PlanError::ZeroBase)?;
    if world.iter().any(|(wn, us)| *wn == 0 || *us == 0) {
        return Err(PlanError::ZeroBase);
    }

    // Step 6: the plan.
    let mut idle = Vec::new();
    for (w, &(a_w, usdc_w)) in world.iter().enumerate() {
        let mask = 1u8 << w;
        if a > a_w {
            idle.push((SeedAsset::Wnear, mask, a - a_w));
        }
        let idle_usdc = u_used - usdc_w - odds_use[w];
        if idle_usdc > 0 {
            idle.push((SeedAsset::Usdc, mask, idle_usdc));
        }
    }
    let odds_pools = pairs
        .iter()
        .zip(&sides)
        .map(|(pair, &(less, more))| {
            let (ax, ay) = pair.ordered(less, more);
            (pair.x, pair.y, ax, ay)
        })
        .collect();
    let usable_value = plus(md(a, i.s, WAD, Rounding::Down)?, u_used)?;
    Ok(SeedPlan {
        base: d,
        used_wnear: a,
        used_usdc: u_used,
        world,
        odds_pools,
        idle,
        usable_value,
        idle_value,
    })
}

/// `ceil(x / round) * round`.
fn ceil_to(round: u128, x: u128) -> Result<u128, PlanError> {
    if round == 0 {
        return Ok(x);
    }
    x.div_ceil(round)
        .checked_mul(round)
        .ok_or(PlanError::Overflow)
}

/// The goal of a market of this shape and the ideal pledge mix
/// `(goal, A*, U*)`: the opening value at which the thinnest world pool holds
/// `depth` USDC (`d* = ceil(depth / min p)`, `U* = ceil(d* u)`, `A*` the wNEAR
/// the planner deploys with unlimited wNEAR and `U*` USDC), rounded up to
/// `round` and at least `min_goal`. The pledged amounts of `shape` are ignored.
pub fn goal_for(
    shape: &SeedInput,
    depth: u128,
    round: u128,
    min_goal: u128,
) -> Result<(u128, u128, u128), PlanError> {
    check_input(shape)?;
    let (pairs, per_unit) = units(shape)?;
    let u = usdc_per_base(shape, &pairs, &per_unit)?;
    let min_p = shape.p.iter().copied().min().ok_or(PlanError::ZeroBase)?;
    let d_star = md(depth, WAD, min_p, Rounding::Up)?;
    let u_star = md(d_star, u, WAD, Rounding::Up)?;
    let plan = seed_plan(&SeedInput {
        pledged_wnear: u128::MAX,
        pledged_usdc: u_star,
        ..*shape
    })?;
    let a_star = plan.used_wnear;
    let value = plus(md(a_star, shape.s, WAD, Rounding::Down)?, u_star)?;
    let goal = ceil_to(round, value)?.max(min_goal);
    Ok((goal, a_star, u_star))
}

/// Prices from a shape: `p_w = floor(s * m_w / M)` with
/// `M = sum floor(q_w * m_w / WAD)`, so the implied spot `sum q_w p_w` is `s`
/// within `W` units. Returns `(p, M)`.
pub fn shape_prices(q: &[u128], m: &[u128], s: u128) -> Result<(Vec<u128>, u128), PlanError> {
    let mut total = 0u128;
    for (qw, mw) in q.iter().zip(m) {
        total = plus(total, md(*qw, *mw, WAD, Rounding::Down)?)?;
    }
    if total == 0 {
        return Err(PlanError::ZeroBase);
    }
    let p = m
        .iter()
        .map(|mw| md(s, *mw, total, Rounding::Down))
        .collect::<Result<Vec<_>, _>>()?;
    Ok((p, total))
}

/// A brand-new binary event's shape from its terms: odds `[q0, 1 - q0]` with
/// `q0 = odds0_bps * 1e14`, and the raw multipliers normalised by
/// `k = q0 m0 + q1 m1` so that the odds-weighted multiplier is 1. Returns
/// `(q, m)`; `None` if `k` is 0 or the odds exceed 1.
pub fn kind_a_shape(odds0_bps: u16, mult_bps: [u16; 2]) -> Option<(Vec<u128>, Vec<u128>)> {
    let q0 = u128::from(odds0_bps) * BPS;
    let q1 = WAD.checked_sub(q0)?;
    let raw = [u128::from(mult_bps[0]) * BPS, u128::from(mult_bps[1]) * BPS];
    let k = (q0 * raw[0] + q1 * raw[1]) / WAD;
    if k == 0 {
        return None;
    }
    let m = raw
        .iter()
        .map(|r| checked_mul_div(*r, WAD, k, Rounding::Down))
        .collect::<Option<Vec<_>>>()?;
    Some((vec![q0, q1], m))
}

/// One event of a combination, from its reference market: the odds of
/// outcome 0 and the price ratio of each outcome to the reference's level.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Marginal {
    pub odds0: u128,
    pub ratio: [u128; 2],
}

/// Event `k` (binary, stride `2^k`) of a reference with odds `q` and prices
/// `p` over its `possible` worlds: `Q(o) = sum q_w`, `P(o) = sum q_w p_w /
/// Q(o)` and `R(o) = P(o) / I` with `I = sum q_w p_w`, over the worlds where
/// the event has outcome `o`. `None` when an outcome has no odds or the level
/// is 0.
pub fn marginal(q: &[u128], p: &[u128], possible: u8, k: u8) -> Option<Marginal> {
    let mut odds_o = [0u128; 2];
    let mut value_o = [0u128; 2];
    for (w, (qw, pw)) in q.iter().zip(p).enumerate() {
        if possible & (1 << w) == 0 {
            continue;
        }
        let o = (w >> k) & 1;
        odds_o[o] = odds_o[o].checked_add(*qw)?;
        value_o[o] = value_o[o].checked_add(checked_mul_div(*qw, *pw, WAD, Rounding::Down)?)?;
    }
    let level = value_o[0].checked_add(value_o[1])?;
    if odds_o.contains(&0) || level == 0 {
        return None;
    }
    let mut ratio = [0u128; 2];
    for o in 0..2 {
        let price = checked_mul_div(value_o[o], WAD, odds_o[o], Rounding::Down)?;
        ratio[o] = checked_mul_div(price, WAD, level, Rounding::Down)?;
    }
    Some(Marginal {
        odds0: odds_o[0],
        ratio,
    })
}

/// A combination's shape from its events' marginals (canonical order, world
/// `w = sum o_k 2^k`): `c_k` = each event's odds of outcome 0 clamped to
/// `[clamp, 1 - clamp]`, `q_w = prod_k (o_k = 0 ? c_k : 1 - c_k)` (the last
/// world takes the remainder, so the odds sum to exactly 1) and
/// `m_w = prod_k R_k(o_k)`. Returns `(q, m)`.
pub fn kind_b_shape(marginals: &[Marginal], clamp: u128) -> Option<(Vec<u128>, Vec<u128>)> {
    if marginals.is_empty() || marginals.len() > 3 || clamp >= WAD / 2 {
        return None;
    }
    let c: Vec<u128> = marginals
        .iter()
        .map(|m| m.odds0.clamp(clamp, WAD - clamp))
        .collect();
    let world_count = 1usize << marginals.len();
    let mut q = Vec::with_capacity(world_count);
    let mut m = Vec::with_capacity(world_count);
    for w in 0..world_count {
        let (mut qw, mut mw) = (WAD, WAD);
        for (k, marginal) in marginals.iter().enumerate() {
            let o = (w >> k) & 1;
            let ck = if o == 0 { c[k] } else { WAD - c[k] };
            qw = checked_mul_div(qw, ck, WAD, Rounding::Down)?;
            mw = checked_mul_div(mw, marginal.ratio[o], WAD, Rounding::Down)?;
        }
        q.push(qw);
        m.push(mw);
    }
    let others: u128 = q[..world_count - 1].iter().sum();
    q[world_count - 1] = WAD.checked_sub(others)?;
    Some((q, m))
}

/// The amounts an opening froze, from which every pledger's shares and unused
/// parts follow: pledged `(PW, PU)`, used `(UW, UU)` and the spot reference.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpenTotals {
    pub pledged_wnear: u128,
    pub pledged_usdc: u128,
    pub used_wnear: u128,
    pub used_usdc: u128,
    pub s: u128,
}

fn used_part(pledged_i: u128, used: u128, pledged: u128, rounding: Rounding) -> u128 {
    if pledged == 0 {
        return 0;
    }
    checked_mul_div(pledged_i, used, pledged, rounding).unwrap_or(pledged_i)
}

impl OpenTotals {
    /// `T = floor(UW * s) + UU`: every share there is.
    pub fn total_shares(&self) -> u128 {
        checked_mul_div(self.used_wnear, self.s, WAD, Rounding::Down)
            .unwrap_or(u128::MAX)
            .saturating_add(self.used_usdc)
    }

    /// `floor(floor(pw_i UW / PW) s) + floor(pu_i UU / PU)`.
    pub fn shares(&self, pw_i: u128, pu_i: u128) -> u128 {
        let wnear = used_part(pw_i, self.used_wnear, self.pledged_wnear, Rounding::Down);
        let usdc = used_part(pu_i, self.used_usdc, self.pledged_usdc, Rounding::Down);
        checked_mul_div(wnear, self.s, WAD, Rounding::Down)
            .unwrap_or(u128::MAX)
            .saturating_add(usdc)
    }

    /// `(pw_i - ceil(pw_i UW / PW), pu_i - ceil(pu_i UU / PU))`.
    pub fn unused(&self, pw_i: u128, pu_i: u128) -> (u128, u128) {
        let wnear = used_part(pw_i, self.used_wnear, self.pledged_wnear, Rounding::Up);
        let usdc = used_part(pu_i, self.used_usdc, self.pledged_usdc, Rounding::Up);
        (pw_i.saturating_sub(wnear), pu_i.saturating_sub(usdc))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: u128 = 3_037_693_300_000_000_000;
    const BETA: u128 = WAD / 4;
    const DEPTH: u128 = 15_000 * WAD;
    const ROUND: u128 = 1_000 * WAD;
    const MIN_GOAL: u128 = 10_000 * WAD;
    const CLAMP: u128 = 100 * BPS;

    fn input<'a>(q: &'a [u128], p: &'a [u128], pw: u128, pu: u128) -> SeedInput<'a> {
        SeedInput {
            world_count: q.len() as u8,
            q,
            p,
            s: S,
            beta: BETA,
            pledged_wnear: pw,
            pledged_usdc: pu,
        }
    }

    /// `x` (WAD) rounded half up to `decimals` places, as an integer of those
    /// units (the design quotes its figures that way).
    fn cut(x: u128, decimals: u32) -> u128 {
        let unit = 10u128.pow(18 - decimals);
        (x + unit / 2) / unit
    }

    fn milli(v: u128) -> u128 {
        v * WAD / 1_000
    }

    fn kind_a() -> (Vec<u128>, Vec<u128>) {
        let (q, m) = kind_a_shape(4_000, [11_500, 9_000]).unwrap();
        let (p, _) = shape_prices(&q, &m, S).unwrap();
        (q, p)
    }

    /// A 2-world reference for one event: its odds of outcome 0 and the two
    /// conditional prices (5 decimals).
    fn reference(odds0: u128, prices: [u128; 2]) -> Marginal {
        let q = [odds0, WAD - odds0];
        let p = prices.map(|x| x * WAD / 100_000);
        marginal(&q, &p, 0b11, 0).unwrap()
    }

    fn spice() -> Marginal {
        reference(666_700_000_000_000_000, [340_000, 280_000])
    }

    fn fed() -> Marginal {
        reference(WAD / 100, [346_669, 303_336])
    }

    fn near() -> Marginal {
        let (q, p) = kind_a();
        marginal(&q, &p, 0b11, 0).unwrap()
    }

    fn combination(events: &[Marginal]) -> (Vec<u128>, Vec<u128>) {
        let (q, m) = kind_b_shape(events, CLAMP).unwrap();
        let (p, _) = shape_prices(&q, &m, S).unwrap();
        (q, p)
    }

    fn goal(q: &[u128], p: &[u128]) -> (u128, u128, u128) {
        goal_for(&input(q, p, 0, 0), DEPTH, ROUND, MIN_GOAL).unwrap()
    }

    fn implied(q: &[u128], p: &[u128]) -> u128 {
        odds::implied_spot(q, 0xFF, |w| p.get(usize::from(w)).copied()).unwrap()
    }

    #[test]
    fn kind_a_shape_normalises_the_multipliers() {
        let (q, p) = kind_a();
        assert_eq!(q, vec![400_000_000_000_000_000, 600_000_000_000_000_000]);
        assert_eq!(cut(p[0], 4), 34_933);
        assert_eq!(cut(p[1], 4), 27_339);
        assert!(S - implied(&q, &p) <= 2);
        // k != 1: 0.5 x 1.2 + 0.5 x 1.0 = 1.1, so m = [1.0909, 0.9091].
        let (_, m) = kind_a_shape(5_000, [12_000, 10_000]).unwrap();
        assert_eq!(cut(m[0], 4), 10_909);
        assert_eq!(cut(m[1], 4), 9_091);
        assert_eq!(kind_a_shape(10_001, [10_000, 10_000]), None);
        assert_eq!(kind_a_shape(5_000, [0, 0]), None);
    }

    #[test]
    fn worked_kind_a_opening() {
        let (q, p) = kind_a();
        let plan = seed_plan(&input(&q, &p, 8_300 * WAD, 25_000 * WAD)).unwrap();
        assert_eq!(cut(plan.base, 2), 587_852);
        assert_eq!(cut(plan.used_wnear, 2), 805_575);
        assert!(plan.used_usdc <= 25_000 * WAD && 25_000 * WAD - plan.used_usdc < WAD);
        assert_eq!(cut(plan.usable_value, 2), 4_947_090);
        assert_eq!(cut(plan.world[0].0, 2), 587_852);
        assert_eq!(cut(plan.world[0].1, 2), 2_053_571);
        assert_eq!(cut(plan.world[1].0, 2), 805_575);
        assert_eq!(cut(plan.world[1].1, 2), 2_202_381);
        let (x, y, yes, no) = plan.odds_pools[0];
        assert_eq!((x, y), (1, 2));
        assert_eq!((cut(yes, 2), cut(no, 2)), (446_429, 297_619));
        // YES's odds in the pool: 2,976.19 / 7,440.48 = 0.40.
        assert_eq!(cut(odds::share_x(yes, no).unwrap(), 4), 4_000);
        // 2,177.23 wNEAR-if-YES idle; the USDC leftovers are rounding dust.
        let (asset, mask, amount) = plan.idle[0];
        assert_eq!(
            (asset, mask, cut(amount, 2)),
            (SeedAsset::Wnear, 1, 217_723)
        );
        assert!(plan.idle[1..]
            .iter()
            .all(|(asset, _, a)| *asset == SeedAsset::Usdc && *a < WAD / 100));
        // About 6.15% of the vault.
        assert_eq!(plan.idle_value * 10_000 / plan.usable_value, 614);

        let totals = OpenTotals {
            pledged_wnear: 8_300 * WAD,
            pledged_usdc: 25_000 * WAD,
            used_wnear: plan.used_wnear,
            used_usdc: plan.used_usdc,
            s: S,
        };
        assert_eq!(totals.total_shares(), plan.usable_value);
        let pledges = [
            (4_000 * WAD, 0),
            (4_000 * WAD, 0),
            (0, 20_000 * WAD),
            (300 * WAD, 5_000 * WAD),
        ];
        let shares: Vec<u128> = pledges.iter().map(|(w, u)| totals.shares(*w, *u)).collect();
        assert_eq!(
            shares.iter().map(|s| cut(*s, 2)).collect::<Vec<_>>(),
            vec![1_179_320, 1_179_320, 2_000_000, 588_449]
        );
        assert!(shares.iter().sum::<u128>() <= totals.total_shares());
        let unused: Vec<(u128, u128)> =
            pledges.iter().map(|(w, u)| totals.unused(*w, *u)).collect();
        assert_eq!(
            unused.iter().map(|u| cut(u.0, 4)).collect::<Vec<_>>(),
            vec![1_177_106, 1_177_106, 0, 88_283]
        );
        assert!(unused.iter().all(|u| u.1 < 10));
    }

    #[test]
    fn golden_goals() {
        let (q, p) = kind_a();
        let (g, a, u) = goal(&q, &p);
        assert_eq!(g, 47_000 * WAD);
        assert_eq!((cut(a, 2), cut(u, 2)), (751_870, 2_333_333));

        let (q, p) = combination(&[fed()]);
        assert_eq!(cut(q[0], 4), 100);
        assert_eq!((cut(p[0], 4), cut(p[1], 4)), (34_667, 30_334));
        assert_eq!(goal(&q, &p).0, 42_000 * WAD);

        let (q, p) = combination(&[spice(), near()]);
        assert_eq!(
            q.iter().map(|x| cut(*x, 5)).collect::<Vec<_>>(),
            vec![26_668, 13_332, 40_002, 19_998]
        );
        assert!(S.abs_diff(implied(&q, &p)) <= 16);
        assert_eq!(goal(&q, &p).0, 52_000 * WAD);
        let plan = seed_plan(&input(&q, &p, 6_900 * WAD, 31_000 * WAD)).unwrap();
        assert_eq!(cut(plan.usable_value, 2), 5_196_008);

        let (q, p) = combination(&[spice(), fed(), near()]);
        assert_eq!(q.iter().sum::<u128>(), WAD);
        assert!(S.abs_diff(implied(&q, &p)) <= 32);
        assert_eq!(goal(&q, &p).0, 61_000 * WAD);
    }

    #[test]
    fn marginal_of_a_two_by_two() {
        // SPICE x Fed (scenario 5 layout): event 0 = SPICE, event 1 = Fed.
        let q = [WAD / 10, WAD / 10, 2 * WAD / 5, 2 * WAD / 5];
        let p = [milli(3_700), milli(3_000), milli(3_300), milli(2_500)];
        let spice = marginal(&q, &p, 0xF, 0).unwrap();
        let fed = marginal(&q, &p, 0xF, 1).unwrap();
        assert_eq!(spice.odds0, WAD / 2);
        assert_eq!(fed.odds0, WAD / 5);
        // Level 0.37 + 0.30 + 1.32 + 1.00 = 2.99; SPICE ships: (0.37 + 1.32) / 0.5 = 3.38.
        assert_eq!(cut(spice.ratio[0], 4), 11_304);
        // After a resolution only the possible worlds count.
        let after = marginal(&q, &p, 0b1100, 0).unwrap();
        assert_eq!(after.odds0, 2 * WAD / 5);
        assert_eq!(marginal(&q, &p, 0b0101, 0), None);
    }

    #[test]
    fn plan_errors() {
        let (q, p) = kind_a();
        assert_eq!(
            seed_plan(&input(&q, &p, 0, 1_000 * WAD)),
            Err(PlanError::ZeroBase)
        );
        assert_eq!(
            seed_plan(&input(&q, &p, 1_000 * WAD, 0)),
            Err(PlanError::ZeroBase)
        );
        // A base too small for the odds sides to get a unit.
        assert_eq!(
            seed_plan(&input(&q, &p, 1, 10)),
            Err(PlanError::EmptyOddsSide(1, 2))
        );
        assert_eq!(
            seed_plan(&input(&q[..1], &p[..1], WAD, WAD)),
            Err(PlanError::ZeroBase)
        );
        assert_eq!(
            PlanError::EmptyOddsSide(3, 12).to_string(),
            "EmptyOddsSide(3, 12)"
        );
    }

    fn plan_json(plan: &SeedPlan) -> serde_json::Value {
        let s = |x: u128| serde_json::Value::String(x.to_string());
        serde_json::json!({
            "base": s(plan.base),
            "used_wnear": s(plan.used_wnear),
            "used_usdc": s(plan.used_usdc),
            "world": plan.world.iter().map(|(a, b)| vec![s(*a), s(*b)]).collect::<Vec<_>>(),
            "odds_pools": plan.odds_pools.iter()
                .map(|(x, y, a, b)| serde_json::json!([x, y, s(*a), s(*b)]))
                .collect::<Vec<_>>(),
            "idle": plan.idle.iter()
                .map(|(asset, m, a)| serde_json::json!([
                    if *asset == SeedAsset::Wnear { "wnear" } else { "usdc" }, m, s(*a)]))
                .collect::<Vec<_>>(),
            "usable_value": s(plan.usable_value),
            "idle_value": s(plan.idle_value),
        })
    }

    fn case_json(name: &str, q: &[u128], p: &[u128], pw: u128, pu: u128) -> serde_json::Value {
        let s = |x: u128| serde_json::Value::String(x.to_string());
        let input = input(q, p, pw, pu);
        let (goal, ideal_wnear, ideal_usdc) = goal_for(&input, DEPTH, ROUND, MIN_GOAL).unwrap();
        serde_json::json!({
            "name": name,
            "world_count": q.len(),
            "q": q.iter().map(|x| s(*x)).collect::<Vec<_>>(),
            "p": p.iter().map(|x| s(*x)).collect::<Vec<_>>(),
            "s": s(S),
            "beta": s(BETA),
            "pledged_wnear": s(pw),
            "pledged_usdc": s(pu),
            "plan": plan_json(&seed_plan(&input).unwrap()),
            "goal": {"depth": s(DEPTH), "round": s(ROUND), "min_goal": s(MIN_GOAL),
                     "goal": s(goal), "ideal_wnear": s(ideal_wnear), "ideal_usdc": s(ideal_usdc)},
        })
    }

    fn seed_vectors_json() -> String {
        let s = |x: u128| serde_json::Value::String(x.to_string());
        let (qa, pa) = kind_a();
        let (qf, pf) = combination(&[fed()]);
        let (q4, p4) = combination(&[spice(), near()]);
        let (q8, p8) = combination(&[spice(), fed(), near()]);
        let plan = seed_plan(&input(&qa, &pa, 8_300 * WAD, 25_000 * WAD)).unwrap();
        let totals = OpenTotals {
            pledged_wnear: 8_300 * WAD,
            pledged_usdc: 25_000 * WAD,
            used_wnear: plan.used_wnear,
            used_usdc: plan.used_usdc,
            s: S,
        };
        let pledges = [
            ("ana", 4_000 * WAD, 0),
            ("ben", 4_000 * WAD, 0),
            ("cy", 0, 20_000 * WAD),
            ("dee", 300 * WAD, 5_000 * WAD),
        ];
        let shares: Vec<serde_json::Value> = pledges
            .iter()
            .map(|(name, w, u)| {
                let (uw, uu) = totals.unused(*w, *u);
                serde_json::json!({"name": name, "wnear": s(*w), "usdc": s(*u),
                    "shares": s(totals.shares(*w, *u)), "unused_wnear": s(uw), "unused_usdc": s(uu)})
            })
            .collect();
        let marginals: Vec<serde_json::Value> = [spice(), fed(), near()]
            .iter()
            .zip(["spice", "fed", "near"])
            .map(|(m, name)| {
                serde_json::json!({"name": name, "odds0": s(m.odds0),
                    "ratio": [s(m.ratio[0]), s(m.ratio[1])]})
            })
            .collect();
        let doc = serde_json::json!({
            "shapes": {
                "kind_a": {"odds0_bps": 4000, "mult_bps": [11500, 9000], "s": s(S),
                           "q": qa.iter().map(|x| s(*x)).collect::<Vec<_>>(),
                           "p": pa.iter().map(|x| s(*x)).collect::<Vec<_>>()},
                "clamp": s(CLAMP),
                "marginals": marginals,
            },
            "cases": [
                case_json("kind_a_near_1b_worked", &qa, &pa, 8_300 * WAD, 25_000 * WAD),
                case_json("fed_only", &qf, &pf, 7_000 * WAD, 21_000 * WAD),
                case_json("spice_x_near_not_ready", &q4, &p4, 6_900 * WAD, 31_000 * WAD),
                case_json("spice_x_fed_x_near", &q8, &p8, 7_200 * WAD, 39_000 * WAD),
            ],
            "shares": {"pledged_wnear": s(totals.pledged_wnear), "pledged_usdc": s(totals.pledged_usdc),
                       "used_wnear": s(totals.used_wnear), "used_usdc": s(totals.used_usdc), "s": s(S),
                       "total": s(totals.total_shares()), "pledgers": shares},
        });
        let mut out = serde_json::to_string_pretty(&doc).unwrap();
        out.push('\n');
        out
    }

    /// `seed-vectors.json`, shared with `scripts/lib/seed-plan.test.ts`:
    /// written when missing or with `UPDATE_GOLDEN`, then checked byte for byte.
    #[test]
    fn seed_vectors_golden_file() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/seed-vectors.json");
        let expected = seed_vectors_json();
        if std::env::var_os("UPDATE_GOLDEN").is_some() || !std::path::Path::new(path).exists() {
            std::fs::write(path, &expected).unwrap();
        }
        let stored = std::fs::read_to_string(path).unwrap();
        assert_eq!(stored, expected, "{path} differs from seed::seed_plan");
    }

    /// The vault's value at the opening odds and prices: every token at its
    /// odds, every wNEAR-if-w at q_w p_w.
    fn vault_value(q: &[u128], p: &[u128], plan: &SeedPlan) -> u128 {
        use crate::fixed::mul_div_down as f;
        let mut value = 0u128;
        for (w, (a, u)) in plan.world.iter().enumerate() {
            value += f(q[w], f(*a, p[w], WAD) + u, WAD);
        }
        for (x, y, ax, ay) in &plan.odds_pools {
            value += f(mask_odds(q, *x), *ax, WAD) + f(mask_odds(q, *y), *ay, WAD);
        }
        for (asset, m, a) in &plan.idle {
            let w = m.trailing_zeros() as usize;
            value += match asset {
                SeedAsset::Wnear => f(q[w], f(*a, p[w], WAD), WAD),
                SeedAsset::Usdc => f(q[w], *a, WAD),
            };
        }
        value
    }

    /// Exact coverage: every world holds `used_wnear` wNEAR and `used_usdc`
    /// USDC across its pool, the odds sides containing it and its idle tokens.
    fn assert_covered(plan: &SeedPlan, world_count: usize) {
        for w in 0..world_count {
            let bit = 1u8 << w;
            let mut wnear = plan.world[w].0;
            let mut usdc = plan.world[w].1;
            for (x, y, ax, ay) in &plan.odds_pools {
                if x & bit != 0 {
                    usdc += ax;
                }
                if y & bit != 0 {
                    usdc += ay;
                }
            }
            for (asset, m, a) in &plan.idle {
                if *m == bit {
                    match asset {
                        SeedAsset::Wnear => wnear += a,
                        SeedAsset::Usdc => usdc += a,
                    }
                }
            }
            assert_eq!(
                (wnear, usdc),
                (plan.used_wnear, plan.used_usdc),
                "world {w}"
            );
        }
    }

    fn random_shape(world_count: u8, seed: &[u16]) -> (Vec<u128>, Vec<u128>) {
        let events = world_count.trailing_zeros() as usize;
        let marginals: Vec<Marginal> = (0..events)
            .map(|k| Marginal {
                odds0: u128::from(seed[3 * k] % 9_800 + 100) * BPS,
                ratio: [
                    u128::from(seed[3 * k + 1] % 10_000 + 6_000) * BPS,
                    u128::from(seed[3 * k + 2] % 10_000 + 6_000) * BPS,
                ],
            })
            .collect();
        combination(&marginals)
    }

    proptest::proptest! {
        #![proptest_config(proptest::prelude::ProptestConfig::with_cases(1_024))]

        #[test]
        fn plan_properties(
            events in 1u8..=3,
            seed in proptest::collection::vec(0u16..u16::MAX, 9),
            pw in 1_000u128..2_000_000,
            pu in 1_000u128..8_000_000,
            more_w in 0u128..100_000,
            more_u in 0u128..100_000,
        ) {
            let world_count = 1u8 << events;
            let n = usize::from(world_count);
            let (q, p) = random_shape(world_count, &seed);
            proptest::prop_assert_eq!(q.iter().sum::<u128>(), WAD);
            // Kind B implied = S within rounding, clamped or not.
            proptest::prop_assert!(S.abs_diff(implied(&q, &p)) <= 16 * n as u128);
            let (pw, pu) = (pw * WAD, pu * WAD);
            let plan = seed_plan(&input(&q, &p, pw, pu)).unwrap();
            assert_covered(&plan, n);
            proptest::prop_assert!(plan.used_wnear <= pw && plan.used_usdc <= pu);
            proptest::prop_assert!(plan.world.iter().all(|(a, u)| *a > 0 && *u > 0));
            proptest::prop_assert!(plan.odds_pools.iter().all(|(_, _, a, b)| *a > 0 && *b > 0));
            for (w, (a, u)) in plan.world.iter().enumerate() {
                // The pool's price is p_w less at most one unit per wNEAR.
                let price = crate::fixed::mul_div_down(*u, WAD, *a);
                proptest::prop_assert!(price <= p[w] && p[w] - price <= WAD / a + 1);
            }
            for (x, y, ax, ay) in &plan.odds_pools {
                let (qx, qy) = (mask_odds(&q, *x), mask_odds(&q, *y));
                let want = crate::fixed::mul_div_down(qx, WAD, qx + qy);
                let got = odds::share_x(*ax, *ay).unwrap();
                proptest::prop_assert!(want.abs_diff(got) <= 4 * WAD / ax.min(ay) + 2,
                    "pair {} {}: {} vs {}", x, y, got, want);
            }
            // Value conservation: the vault is worth the shares it issues.
            let value = vault_value(&q, &p, &plan);
            let tolerance = 16 * n as u128 * (plan.used_wnear / WAD + 1) + 64;
            proptest::prop_assert!(plan.usable_value.abs_diff(value) <= tolerance,
                "value {} usable {}", value, plan.usable_value);
            // Step 5 never raises the idle value above the base layout.
            let base = seed_plan(&input(&q, &p, plan.base, pu)).unwrap();
            proptest::prop_assert!(plan.idle_value <= base.idle_value || plan.used_wnear == plan.base);
            // Usable value is monotone in the pledges.
            let more = seed_plan(&input(&q, &p, pw + more_w * WAD, pu + more_u * WAD)).unwrap();
            proptest::prop_assert!(more.usable_value >= plan.usable_value);
            // Shares and unused parts of two pledgers never exceed the totals.
            let totals = OpenTotals { pledged_wnear: pw, pledged_usdc: pu,
                used_wnear: plan.used_wnear, used_usdc: plan.used_usdc, s: S };
            let split = [(pw / 3, pu / 7), (pw - pw / 3, pu - pu / 7)];
            let shares: u128 = split.iter().map(|(w, u)| totals.shares(*w, *u)).sum();
            proptest::prop_assert!(shares <= totals.total_shares());
            let unused = split.iter().map(|(w, u)| totals.unused(*w, *u))
                .fold((0, 0), |a, b| (a.0 + b.0, a.1 + b.1));
            proptest::prop_assert!(unused.0 <= pw - plan.used_wnear && unused.1 <= pu - plan.used_usdc);
            // A goal reached means the base depth the goal was set for.
            let (goal, _, _) = goal_for(&input(&q, &p, 0, 0), DEPTH, ROUND, MIN_GOAL).unwrap();
            let min_p = p.iter().copied().min().unwrap();
            if plan.usable_value >= goal {
                proptest::prop_assert!(plan.base + 1 >= crate::fixed::mul_div_down(DEPTH, WAD, min_p));
            }
            // Before rounding, the goal is linear in the depth.
            let (_, a1, u1) = goal_for(&input(&q, &p, 0, 0), DEPTH, 1, 1).unwrap();
            let (_, a2, u2) = goal_for(&input(&q, &p, 0, 0), 2 * DEPTH, 1, 1).unwrap();
            proptest::prop_assert!((2 * u1).abs_diff(u2) <= 16 && (2 * a1).abs_diff(a2) <= 4 * WAD / min_p + 4, "u {} {} a {} {} p {:?} q {:?}", u1, u2, a1, a2, p, q);
        }
    }
}
