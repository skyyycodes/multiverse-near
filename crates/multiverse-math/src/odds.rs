//! World odds from the between-world pools (`OddsTree`) and the implied spot price.
//!
//! A between-world pool trades USDC-if-X against USDC-if-Y for sibling verses X and Y. Its price says how likely X
//! is against Y: holding reserves `r_x, r_y`, X's share of the parent is `r_y / (r_x + r_y)`. Walking the tree from
//! the root, each world's odds are the product of the shares down its branch. Each split gives the second child
//! `parent - first`, so the odds always add up to exactly `1e18`.
//!
//! A split with a dead side needs no pool: the live side takes everything. Odds are "unknown" (never a guess) when a
//! split between two live verses has no pool.

use crate::fixed::{isqrt_u512, mul_div_down, Rounding, U256, U512, WAD};

/// Sibling verse pairs, parents before children. Two worlds: SHIPS (0x1) vs DELAYED (0x2). Four worlds (world =
/// a + 2b) split on the second event first: CUTS (0x3) vs HOLDS (0xC), then 0x1 vs 0x2, then 0x4 vs 0x8. Any other
/// world count has no tree.
pub fn pairs(world_count: u8) -> &'static [(u8, u8)] {
    match world_count {
        2 => &[(0x1, 0x2)],
        4 => &[(0x3, 0xC), (0x1, 0x2), (0x4, 0x8)],
        _ => &[],
    }
}

/// Share of X in a between-world pool holding `reserve_x` of USDC-if-X and `reserve_y` of USDC-if-Y:
/// `floor(reserve_y * 1e18 / (reserve_x + reserve_y))`. `None` for an empty pool.
pub fn share_x(reserve_x: u128, reserve_y: u128) -> Option<u128> {
    let total = U256::from(reserve_x) + U256::from(reserve_y);
    if total.is_zero() {
        return None;
    }
    let share = U256::from(reserve_y) * U256::from(WAD) / total;
    Some(share.low_u128())
}

/// Share of token0's verse at a square-root price (`OddsTree.shareOfToken0`): `p / (1 + p)` in WAD, rounded down,
/// with `p = s^2 / 2^192` token1 per token0.
pub fn share_of_token0(sqrt_price_x96: U256) -> u128 {
    let s = U512::from(sqrt_price_x96);
    let q96 = U512::from(1u8) << 96;
    let r = (s * s) >> 96;
    let share = r * U512::from(WAD) / (r + q96);
    // r / (r + 2^96) < 1, so the share is below 1e18.
    u128::try_from(share).expect("share below 1e18")
}

/// Square-root price of a pair priced at odds `odds0 : odds1` (any common scale), rounded down
/// (`OddsTree.sqrtPriceForOdds`). Panics with `DivisionByZero` if `odds1` is 0.
#[track_caller]
pub fn sqrt_price_for_odds(odds0: u128, odds1: u128) -> U256 {
    if odds1 == 0 {
        panic!("DivisionByZero");
    }
    let ratio_x192 = (U512::from(odds0) << 192) / U512::from(odds1);
    U256::try_from(isqrt_u512(ratio_x192)).expect("square root of a 320-bit value fits 160 bits")
}

/// Reserves that price a between-world pool at odds `q_x : q_y` with at most `depth` on either side: the less
/// likely verse gets `depth` and the likelier one `floor(depth * q_less / q_more)` (reserves are inversely
/// proportional to odds). Returns `(reserve_x, reserve_y)`. Panics with `DivisionByZero` if both odds are 0.
#[track_caller]
pub fn seed_reserves(q_x: u128, q_y: u128, depth: u128) -> (u128, u128) {
    if q_x <= q_y {
        (depth, mul_div_down(depth, q_x, q_y))
    } else {
        (mul_div_down(depth, q_y, q_x), depth)
    }
}

/// Odds of every world (WAD, summing to exactly `1e18` over possible worlds, 0 for dead ones), or `None` when
/// unknown: the world count has no tree, or `share_of(x, y)` returned `None` for a split between two live verses
/// (no pool). `share_of(x, y)` is X's share of the pair in WAD, e.g. [`share_x`] of the pool's reserves; it is only
/// asked for splits where both sides are possible. Panics if it returns more than `1e18`.
#[track_caller]
pub fn odds<F>(world_count: u8, possible: u8, mut share_of: F) -> Option<Vec<u128>>
where
    F: FnMut(u8, u8) -> Option<u128>,
{
    let tree = pairs(world_count);
    if tree.is_empty() {
        return None;
    }
    let mut mass = [0u128; 16];
    mass[usize::from(root(world_count))] = WAD;
    for &(x, y) in tree {
        let live_x = x & possible != 0;
        let live_y = y & possible != 0;
        let share = if !live_x || !live_y {
            if live_x {
                WAD
            } else {
                0
            }
        } else {
            share_of(x, y)?
        };
        if share > WAD {
            panic!("share above 1e18: {share}");
        }
        let parent = mass[usize::from(x | y)];
        mass[usize::from(x)] = mul_div_down(parent, share, WAD);
        mass[usize::from(y)] = parent - mass[usize::from(x)];
    }
    Some((0..world_count).map(|w| mass[1usize << w]).collect())
}

/// `sum over possible worlds w of floor(q[w] * price_w / 1e18)`: the spot price the world prices imply. `None` if
/// `price_of(w)` is `None` for a possible world (no pool). Panics with `Overflow` past `u128::MAX`.
#[track_caller]
pub fn implied_spot<F>(q: &[u128], possible: u8, mut price_of: F) -> Option<u128>
where
    F: FnMut(u8) -> Option<u128>,
{
    let mut implied = 0u128;
    for (w, &odds) in q.iter().enumerate() {
        let world = u8::try_from(w).expect("at most 8 worlds");
        if possible & (1 << world) == 0 {
            continue;
        }
        let price = price_of(world)?;
        let part = crate::fixed::checked_mul_div(odds, price, WAD, Rounding::Down)
            .unwrap_or_else(|| panic!("Overflow"));
        implied = crate::fixed::add(implied, part);
    }
    Some(implied)
}

fn root(world_count: u8) -> u8 {
    ((1u16 << world_count) - 1) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_shapes() {
        assert_eq!(pairs(2), &[(1, 2)]);
        assert_eq!(pairs(4), &[(3, 12), (1, 2), (4, 8)]);
        assert!(pairs(3).is_empty());
        assert_eq!(odds(3, 0b111, |_, _| Some(WAD / 2)), None);
    }

    #[test]
    fn spec_vector() {
        // Same as the reference lens: shareOfToken0(sqrtPriceForOdds(2, 1)) = 666666666666666666.
        assert_eq!(
            share_of_token0(sqrt_price_for_odds(2, 1)),
            666_666_666_666_666_666
        );
    }

    #[test]
    fn dead_sides_need_no_pool() {
        // Binary scenario after SHIPS: the survivor takes 1e18 without asking for a pool.
        let q = odds(2, 0b01, |_, _| panic!("no pool needed")).unwrap();
        assert_eq!(q, vec![WAD, 0]);
        // 2x2 after HOLDS (worlds 2 and 3 left): only the 0x4/0x8 split is read.
        let q = odds(4, 0b1100, |x, y| {
            assert_eq!((x, y), (0x4, 0x8));
            Some(666_700_000_000_000_000)
        })
        .unwrap();
        assert_eq!(
            q,
            vec![0, 0, 666_700_000_000_000_000, 333_300_000_000_000_000]
        );
    }

    #[test]
    fn missing_live_pool_is_unknown() {
        assert_eq!(
            odds(4, 0b1111, |x, _| if x == 0x4 {
                None
            } else {
                Some(WAD / 3)
            }),
            None
        );
        assert_eq!(odds(2, 0b11, |_, _| None), None);
    }

    #[test]
    fn share_from_reserves() {
        // 1,000,000 CUTS vs 428,571.42 HOLDS prices CUTS at 0.3.
        let (cuts, holds) = seed_reserves(3_000, 7_000, 1_000_000 * WAD);
        assert_eq!(cuts, 1_000_000 * WAD);
        assert_eq!(holds, 428_571_428_571_428_571_428_571);
        assert_eq!(share_x(cuts, holds), Some(299_999_999_999_999_999));
        assert_eq!(share_x(0, 0), None);
        assert_eq!(share_x(u128::MAX, u128::MAX), Some(WAD / 2));
    }

    #[test]
    fn implied_spot_skips_dead_worlds_and_needs_every_live_price() {
        let q = [0, 0, 666_700_000_000_000_000, 333_300_000_000_000_000];
        let prices = [3_700 * WAD, 3_000 * WAD, 3_300 * WAD, 2_500 * WAD];
        let implied = implied_spot(&q, 0b1100, |w| Some(prices[usize::from(w)])).unwrap();
        // 0.6667 * 3,300 + 0.3333 * 2,500 = 2,200.11 + 833.25.
        assert_eq!(implied, 3_033_360 * WAD / 1_000);
        assert_eq!(
            implied_spot(&q, 0b1100, |w| if w == 3 { None } else { Some(1) }),
            None
        );
        assert_eq!(
            implied_spot(&q, 0b1100, |w| if w == 0 { None } else { Some(WAD) }),
            Some(WAD)
        );
    }
}
