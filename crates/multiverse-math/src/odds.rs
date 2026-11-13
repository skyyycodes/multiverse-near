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

/// Sibling verse pairs, parents before children, breadth-first, the most significant event first. Two worlds: SHIPS
/// (0x1) vs DELAYED (0x2). Four worlds (world = a + 2b) split on the second event first: CUTS (0x3) vs HOLDS (0xC),
/// then 0x1 vs 0x2, then 0x4 vs 0x8. Eight worlds (world = a + 2b + 4c) split on the third event, then the second
/// under each of its outcomes, then the first under each of the four. At every level each block of contiguous worlds
/// splits into its lower half (outcome 0) and its upper half (outcome 1), so the 2- and 4-world trees are the first
/// levels of the 8-world rule and the lower mask always comes first. Any other world count has no tree.
pub fn pairs(world_count: u8) -> &'static [(u8, u8)] {
    match world_count {
        2 => &[(0x1, 0x2)],
        4 => &[(0x3, 0xC), (0x1, 0x2), (0x4, 0x8)],
        8 => &[
            (0x0F, 0xF0),
            (0x03, 0x0C),
            (0x30, 0xC0),
            (0x01, 0x02),
            (0x04, 0x08),
            (0x10, 0x20),
            (0x40, 0x80),
        ],
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
    // One entry per mask of up to 8 worlds.
    let mut mass = [0u128; 256];
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
        assert_eq!(
            pairs(8),
            &[
                (15, 240),
                (3, 12),
                (48, 192),
                (1, 2),
                (4, 8),
                (16, 32),
                (64, 128)
            ]
        );
        for n in [0, 1, 3, 5, 6, 7, 9, 16] {
            assert!(pairs(n).is_empty(), "{n}");
        }
        assert_eq!(odds(3, 0b111, |_, _| Some(WAD / 2)), None);
    }

    /// The rule the tables follow: at level `l` (event `n - 1 - l`), every block of `2^(n - l)` contiguous worlds
    /// splits into its lower half and its upper half; breadth-first, blocks ascending.
    fn tree_pairs(events: u32) -> Vec<(u8, u8)> {
        let worlds = 1u32 << events;
        let mut out = Vec::new();
        for level in 0..events {
            let block = worlds >> level;
            for start in (0..worlds).step_by(block as usize) {
                let half = |from: u32| (from..from + block / 2).fold(0u8, |m, w| m | 1 << w);
                out.push((half(start), half(start + block / 2)));
            }
        }
        out
    }

    #[test]
    fn tables_follow_the_tree_rule() {
        for events in 1..=3u32 {
            let world_count = 1u8 << events;
            assert_eq!(
                pairs(world_count),
                tree_pairs(events).as_slice(),
                "{events} events"
            );
            let root = root(world_count);
            for (i, &(x, y)) in pairs(world_count).iter().enumerate() {
                assert!(x < y && x & y == 0, "{x:#x} {y:#x}");
                let parent = x | y;
                // A parent comes before its children: it is the root or the side of an earlier pair.
                assert!(
                    parent == root
                        || pairs(world_count)[..i]
                            .iter()
                            .any(|&(a, b)| a == parent || b == parent),
                    "{x:#x} {y:#x}"
                );
            }
            // Every single world is reached: 2^n - 1 splits.
            assert_eq!(pairs(world_count).len(), usize::from(world_count) - 1);
        }
    }

    #[test]
    fn eight_world_odds_sum_to_one_whatever_is_resolved() {
        // Uneven shares per pair, so every split moves mass.
        let share = |x: u8, _y: u8| Some(WAD / 3 + u128::from(x) * 1_000_003);
        for world_count in [2u8, 4, 8] {
            let root = root(world_count);
            for possible in 1..=root {
                let q = odds(world_count, possible, share).unwrap();
                assert_eq!(q.len(), usize::from(world_count));
                assert_eq!(
                    q.iter().sum::<u128>(),
                    WAD,
                    "{world_count} worlds, possible {possible:#b}"
                );
                for (w, odds) in q.iter().enumerate() {
                    if possible & (1 << w) == 0 {
                        assert_eq!(*odds, 0);
                    }
                }
            }
        }
    }

    #[test]
    fn eight_world_golden_example() {
        // P(C0) 0.5 at the root, P(CUTS) 0.01 under either C, P(SHIPS) 0.6667 at every leaf.
        let q = odds(8, 0xFF, |x, _| {
            Some(match x {
                0x0F => WAD / 2,
                0x03 | 0x30 => WAD / 100,
                _ => 666_700_000_000_000_000,
            })
        })
        .unwrap();
        let grid = [
            3_333_500_000_000_000,
            1_666_500_000_000_000,
            330_016_500_000_000_000,
            164_983_500_000_000_000,
        ];
        assert_eq!(&q[..4], &grid);
        assert_eq!(&q[4..], &grid);
        let prices =
            [3_700, 3_000, 3_300, 2_500, 3_515, 2_850, 3_135, 2_375].map(|p| p * WAD / 1_000);
        let implied = implied_spot(&q, 0xFF, |w| Some(prices[usize::from(w)])).unwrap();
        // The sandbox read 2,961,750,967,499,999,996 from seeded pools, whose shares are a few wei off these.
        assert_eq!(implied, 2_961_750_967_500_000_000);
        assert!((2_375 * WAD / 1_000..=3_700 * WAD / 1_000).contains(&implied));
    }

    /// `odds-pairs.json`, shared with the scripts and the web: the tree of every world count, as the tables give it.
    fn odds_pairs_json() -> String {
        let line = |w: u8| {
            let pairs: Vec<String> = pairs(w)
                .iter()
                .map(|(x, y)| format!("[{x}, {y}]"))
                .collect();
            format!("  \"{w}\": [{}]", pairs.join(", "))
        };
        format!("{{\n{},\n{},\n{}\n}}\n", line(2), line(4), line(8))
    }

    /// Writes the golden file when it is missing or `UPDATE_GOLDEN` is set, then checks it byte for byte.
    #[test]
    fn odds_pairs_golden_file() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/odds-pairs.json");
        let expected = odds_pairs_json();
        if std::env::var_os("UPDATE_GOLDEN").is_some() || !std::path::Path::new(path).exists() {
            std::fs::create_dir_all(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data")).unwrap();
            std::fs::write(path, &expected).unwrap();
        }
        let stored = std::fs::read_to_string(path).unwrap();
        assert_eq!(stored, expected, "{path} differs from odds::pairs");
        let parsed: serde_json::Value = serde_json::from_str(&stored).unwrap();
        for w in [2u8, 4, 8] {
            let listed: Vec<(u8, u8)> = parsed[w.to_string()]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| (p[0].as_u64().unwrap() as u8, p[1].as_u64().unwrap() as u8))
                .collect();
            assert_eq!(listed, pairs(w));
        }
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
