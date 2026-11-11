//! Properties the protocol relies on, checked on random inputs: integer maths agrees with wide references, pools
//! never lose value to rounding, fees stay within their bounds, share and order maths never favour the user, odds
//! always add up, and a liquidation slice covers its repayment.

use multiverse_math::cpmm::{CpmmError, Pool, Position};
use multiverse_math::flow::SwapFlow;
use multiverse_math::tick::{
    get_sqrt_ratio_at_tick, get_tick_at_sqrt_ratio, MAX_SQRT_RATIO, MAX_TICK, MIN_SQRT_RATIO,
    MIN_TICK,
};
use multiverse_math::{
    checked_mul_div, checked_mul_div_u256, isqrt_u256, isqrt_u512, odds, orders, risk, shares,
    Rounding, U256, U512, WAD,
};
use proptest::collection::vec;
use proptest::prelude::*;

/// A u128 whose bit length is itself random, so tiny, middling and huge values all come up.
fn any_u128() -> impl Strategy<Value = u128> {
    (0u32..=128, any::<u128>())
        .prop_map(|(bits, raw)| if bits == 0 { 0 } else { raw >> (128 - bits) })
}

fn any_u256() -> impl Strategy<Value = U256> {
    (0usize..=256, any::<[u64; 4]>()).prop_map(|(bits, words)| {
        let raw = U256(words);
        if bits == 0 {
            U256::zero()
        } else {
            raw >> (256 - bits)
        }
    })
}

fn u512(value: U256) -> U512 {
    let mut words = [0u64; 8];
    words[..4].copy_from_slice(&value.0);
    U512(words)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1024))]

    /// mul_div over u128 equals the 512-bit computation, including where it refuses (zero divisor, result too big).
    #[test]
    fn mul_div_matches_a_u512_reference(a in any_u128(), b in any_u128(), d in any_u128()) {
        for rounding in [Rounding::Down, Rounding::Up] {
            let expected = if d == 0 {
                None
            } else {
                let (q, r) = (U512::from(a) * U512::from(b)).div_mod(U512::from(d));
                let q = if rounding == Rounding::Up && !r.is_zero() { q + U512::one() } else { q };
                (q <= U512::from(u128::MAX)).then(|| q.low_u128())
            };
            prop_assert_eq!(checked_mul_div(a, b, d, rounding), expected);
        }
    }

    /// The 256-bit mul_div returns the q with q * d <= a * b < (q + 1) * d (or q + 1 when rounding up a remainder).
    #[test]
    fn mul_div_u256_is_the_exact_quotient(a in any_u256(), b in any_u256(), d in any_u256()) {
        let product = u512(a) * u512(b);
        match checked_mul_div_u256(a, b, d, Rounding::Down) {
            Some(q) => {
                let low = u512(q) * u512(d);
                prop_assert!(low <= product);
                prop_assert!(product - low < u512(d));
                let up = checked_mul_div_u256(a, b, d, Rounding::Up);
                prop_assert_eq!(up, if low == product { Some(q) } else { q.checked_add(U256::one()) });
            }
            None => prop_assert!(d.is_zero() || product / u512(d) > u512(U256::MAX)),
        }
    }

    #[test]
    fn isqrt_is_the_floor_root(x in any_u256(), wide in any_u256()) {
        let r = isqrt_u256(x);
        prop_assert!(u512(r) * u512(r) <= u512(x));
        prop_assert!((u512(r) + U512::one()) * (u512(r) + U512::one()) > u512(x));
        let big = u512(wide) << 256 | u512(x);
        let r = isqrt_u512(big);
        prop_assert!(r * r <= big);
        // (r + 1)^2 can need 513 bits only when r = 2^256 - 1; compare r with big / (r + 1) instead.
        prop_assert!(big / (r + U512::one()) < r + U512::one());
    }

    /// v4's test_fuzz_getTickAtSqrtPrice_getSqrtPriceAtTick_relation: a tick's own price, the middle of its range
    /// and the last price below the next tick all map back to it, and the next tick's price to the next tick.
    #[test]
    fn tick_and_sqrt_price_round_trip(tick in MIN_TICK..MAX_TICK) {
        let at = get_sqrt_ratio_at_tick(tick);
        let next = get_sqrt_ratio_at_tick(tick + 1);
        prop_assert!(at < next);
        prop_assert_eq!(get_tick_at_sqrt_ratio(at), tick);
        prop_assert_eq!(get_tick_at_sqrt_ratio((at + next) / 2), tick);
        prop_assert_eq!(get_tick_at_sqrt_ratio(next - 1), tick);
        prop_assert_eq!(get_tick_at_sqrt_ratio(next), tick + 1);
    }

    /// Any price in range sits within one tick of the tick it maps to.
    #[test]
    fn sqrt_price_sits_inside_its_tick(seed in any_u256()) {
        let span = MAX_SQRT_RATIO - MIN_SQRT_RATIO;
        let s = MIN_SQRT_RATIO + seed % span;
        let tick = get_tick_at_sqrt_ratio(s);
        prop_assert!(get_sqrt_ratio_at_tick(tick) <= s);
        if tick < MAX_TICK {
            prop_assert!(s < get_sqrt_ratio_at_tick(tick + 1));
        }
    }
}

#[derive(Clone, Debug)]
enum PoolOp {
    Swap {
        zero_for_one: bool,
        exact_out: bool,
        amount: u128,
        fee: u32,
    },
    Add {
        who: usize,
        liquidity: u128,
    },
    Remove {
        who: usize,
        per_mille: u128,
    },
    Collect {
        who: usize,
    },
}

fn pool_op() -> impl Strategy<Value = PoolOp> {
    prop_oneof![
        4 => (any::<bool>(), any::<bool>(), 1u128..=100_000 * WAD, 0u32..=20_000)
            .prop_map(|(zero_for_one, exact_out, amount, fee)| PoolOp::Swap { zero_for_one, exact_out, amount, fee }),
        2 => (0usize..3, 1u128..=10_000 * WAD).prop_map(|(who, liquidity)| PoolOp::Add { who, liquidity }),
        2 => (0usize..3, 1u128..=1000).prop_map(|(who, per_mille)| PoolOp::Remove { who, per_mille }),
        1 => (0usize..3).prop_map(|who| PoolOp::Collect { who }),
    ]
}

/// Zero, dust and large amounts (up to 1e30) in comparable proportions.
fn amount_with_edges() -> impl Strategy<Value = u128> {
    prop_oneof![
        Just(0u128),
        1u128..=1_000,
        0u128..=1_000_000_000_000_000_000_000_000_000_000
    ]
}

/// x * y >= L^2: every liquidity unit stays backed by at least its square-root share of the reserves.
fn backed(pool: &Pool) -> bool {
    let (x, y) = pool.reserves();
    let l = U256::from(pool.liquidity());
    U256::from(x) * U256::from(y) >= l * l
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// Single swaps: the quote is the execution, the output stays below the reserve, k never falls, an exact-output
    /// swap pays out exactly what was asked, and an exact-input swap of that input would have paid at least as much.
    #[test]
    fn swaps_never_lose_the_pool_value(
        reserve0 in 1_000u128..=1_000_000_000 * WAD,
        reserve1 in 1_000u128..=1_000_000_000 * WAD,
        zero_for_one: bool,
        amount in 1u128..=10_000_000 * WAD,
        fee in 0u32..=1_000_000,
    ) {
        let mut pool = Pool::new();
        pool.mint_initial(&mut Position::new(), reserve0, reserve1).unwrap();
        let k_before = U256::from(reserve0) * U256::from(reserve1);
        let reserve_out = if zero_for_one { reserve1 } else { reserve0 };

        let quote = pool.quote_exact_in(zero_for_one, amount, fee).unwrap();
        let mut traded = pool.clone();
        prop_assert_eq!(traded.swap_exact_in(zero_for_one, amount, fee).unwrap(), quote);
        prop_assert!(quote.amount_out < reserve_out);
        prop_assert_eq!(quote.fee_amount, amount - amount * u128::from(1_000_000 - fee) / 1_000_000);
        let (x, y) = traded.reserves();
        prop_assert!(U256::from(x) * U256::from(y) >= k_before);

        if fee < 1_000_000 {
            match pool.quote_exact_out(zero_for_one, amount, fee) {
                Ok(quote) => {
                    prop_assert_eq!(quote.amount_out, amount);
                    let mut traded = pool.clone();
                    prop_assert_eq!(traded.swap_exact_out(zero_for_one, amount, fee).unwrap(), quote);
                    let (x, y) = traded.reserves();
                    prop_assert!(U256::from(x) * U256::from(y) >= k_before);
                    let as_exact_in = pool.quote_exact_in(zero_for_one, quote.amount_in, fee).unwrap();
                    prop_assert!(as_exact_in.amount_out >= amount);
                    prop_assert_eq!(as_exact_in.fee_amount, quote.fee_amount);
                }
                Err(CpmmError::InsufficientReserve { requested, reserve }) => {
                    prop_assert!(requested >= reserve && reserve == reserve_out);
                }
                // Draining nearly the whole reserve can ask for an input beyond u128.
                Err(CpmmError::Overflow) => prop_assert!(amount * 2 > reserve_out),
                Err(other) => prop_assert!(false, "unexpected {:?}", other),
            }
        }
    }

    /// Random swaps, deposits, withdrawals and fee claims by three LPs: liquidity adds up, every unit stays backed,
    /// a deposit withdrawn at once never returns more than it paid, and fees paid out never exceed fees taken in.
    #[test]
    fn pools_stay_consistent_under_random_use(
        reserve0 in 1_000_000u128..=1_000_000 * WAD,
        reserve1 in 1_000_000u128..=1_000_000_000 * WAD,
        ops in vec(pool_op(), 1..60),
    ) {
        let mut pool = Pool::new();
        let mut lps = [Position::new(), Position::new(), Position::new()];
        pool.mint_initial(&mut lps[0], reserve0, reserve1).unwrap();
        let mut fees_in = (0u128, 0u128);
        let mut fees_out = (0u128, 0u128);
        for op in ops {
            if pool.is_empty() {
                break;
            }
            match op {
                PoolOp::Swap { zero_for_one, exact_out, amount, fee } => {
                    let k = U256::from(pool.reserve0()) * U256::from(pool.reserve1());
                    let result = if exact_out {
                        pool.swap_exact_out(zero_for_one, amount, fee)
                    } else {
                        pool.swap_exact_in(zero_for_one, amount, fee)
                    };
                    if let Ok(swap) = result {
                        if zero_for_one { fees_in.0 += swap.fee_amount } else { fees_in.1 += swap.fee_amount }
                        prop_assert!(U256::from(pool.reserve0()) * U256::from(pool.reserve1()) >= k);
                    }
                }
                PoolOp::Add { who, liquidity } => {
                    // A deposit taken straight back out never returns more than it paid.
                    let mut probe = pool.clone();
                    let mut probe_lp = Position::new();
                    let (in0, in1) = probe.add_liquidity(&mut probe_lp, liquidity).unwrap();
                    let (back0, back1) = probe.remove_liquidity(&mut probe_lp, liquidity).unwrap();
                    prop_assert!(back0 <= in0 && back1 <= in1);
                    let expected = pool.amounts_for_liquidity(liquidity, Rounding::Up).unwrap();
                    prop_assert_eq!(pool.add_liquidity(&mut lps[who], liquidity).unwrap(), expected);
                    prop_assert_eq!(expected, (in0, in1));
                }
                PoolOp::Remove { who, per_mille } => {
                    let liquidity = lps[who].liquidity() * per_mille / 1000;
                    if liquidity > 0 {
                        let expected = pool.amounts_for_liquidity(liquidity, Rounding::Down).unwrap();
                        prop_assert_eq!(pool.remove_liquidity(&mut lps[who], liquidity).unwrap(), expected);
                    }
                }
                PoolOp::Collect { who } => {
                    let pending = lps[who].pending_fees(&pool);
                    let paid = pool.collect(&mut lps[who]);
                    prop_assert_eq!(paid, pending);
                    fees_out.0 += paid.0;
                    fees_out.1 += paid.1;
                }
            }
            let total: u128 = lps.iter().map(Position::liquidity).sum();
            prop_assert_eq!(total, pool.liquidity());
            prop_assert!(backed(&pool));
            if !pool.is_empty() {
                prop_assert!(pool.reserve0() > 0 && pool.reserve1() > 0);
            }
            prop_assert_eq!(fees_in.0, fees_out.0 + pool.fees().0);
            prop_assert_eq!(fees_in.1, fees_out.1 + pool.fees().1);
        }
        // Whatever is still owed can be paid from the pool's fee balance.
        for lp in &mut lps {
            let paid = pool.collect(lp);
            fees_out.0 += paid.0;
            fees_out.1 += paid.1;
        }
        prop_assert!(fees_out.0 <= fees_in.0 && fees_out.1 <= fees_in.1);
    }

    /// `deposit` never takes more than offered, and mints the liquidity it reports.
    #[test]
    fn deposits_stay_within_what_was_offered(
        reserve0 in 1_000u128..=1_000_000 * WAD,
        reserve1 in 1_000u128..=1_000_000_000 * WAD,
        offer0 in 0u128..=1_000_000 * WAD,
        offer1 in 0u128..=1_000_000_000 * WAD,
    ) {
        let mut pool = Pool::new();
        pool.mint_initial(&mut Position::new(), reserve0, reserve1).unwrap();
        let mut lp = Position::new();
        match pool.deposit(&mut lp, offer0, offer1) {
            Ok(deposit) => {
                prop_assert!(deposit.amount0 <= offer0 && deposit.amount1 <= offer1);
                prop_assert_eq!(lp.liquidity(), deposit.liquidity);
                prop_assert!(backed(&pool));
            }
            Err(error) => {
                prop_assert_eq!(error, CpmmError::ZeroAmount);
                prop_assert_eq!(pool.liquidity_for_amounts(offer0, offer1), 0);
            }
        }
    }

    /// The dynamic fee stays within [base, cap] whatever the window holds, and is the base without history.
    #[test]
    fn fee_stays_within_its_bounds(volumes in vec(any::<i128>(), 0..20), base in 0u32..=1_000_000, spread in 0u32..=1_000_000) {
        let cap = base + spread;
        let mut flow = SwapFlow::new();
        prop_assert_eq!(flow.fee(base, cap), base);
        for volume in volumes {
            flow.record(volume);
            let fee = flow.fee(base, cap);
            prop_assert!(base <= fee && fee <= cap);
            if flow.window().total().is_zero() {
                prop_assert_eq!(fee, base);
            }
        }
    }

    /// SharesMath rounding never favours the user: shares minted round down and are worth at most what was paid,
    /// debt rounds up and is at least what was borrowed, and the two directions differ by at most one.
    #[test]
    fn share_round_trips_never_favour_the_user(
        assets in amount_with_edges(),
        total_assets in amount_with_edges(),
        shares_per_asset in prop_oneof![Just(0u128), Just(1_000_000), 0u128..2_000_000],
    ) {
        // Share supply near what a market reaches: about 1e6 shares per asset unit (exactly that when fresh).
        let total_shares = total_assets.saturating_mul(shares_per_asset);
        let too_big = |a: u128, total_a: u128, total_s: u128| {
            U256::from(a) * (U256::from(total_s) + U256::from(1_000_000u32)) / (U256::from(total_a) + U256::one())
                > U256::from(u128::MAX / 4)
        };
        prop_assume!(!too_big(assets, total_assets, total_shares));

        let down = shares::to_shares_down(assets, total_assets, total_shares);
        let up = shares::to_shares_up(assets, total_assets, total_shares);
        prop_assert!(down <= up && up <= down + 1);
        prop_assert!(shares::to_assets_down(down, total_assets, total_shares) <= assets);
        prop_assert!(shares::to_assets_up(up, total_assets, total_shares) >= assets);

        // Supply then withdraw everything at the new totals: never more than supplied.
        let (supplied_assets, supplied_shares) = (total_assets + assets, total_shares + down);
        prop_assert!(shares::to_assets_down(down, supplied_assets, supplied_shares) <= assets);
        // Borrow, then the debt read back at the new totals: never less than borrowed.
        let (borrowed_assets, borrowed_shares) = (total_assets + assets, total_shares + up);
        prop_assert!(shares::to_assets_up(up, borrowed_assets, borrowed_shares) >= assets);
    }

    /// An open bid's escrow always covers what is left: ceil(A * p) - sum floor(f_i * p) >= cost(remaining).
    #[test]
    fn bid_escrow_covers_every_remaining_fill(
        amount in 1u128..=1_000_000 * WAD,
        price in 1u128..=1_000_000 * WAD,
        cuts in vec(1u128..=1_000_000, 0..12),
    ) {
        let mut escrow = orders::cost(amount, price);
        let mut remaining = amount;
        for cut in cuts {
            let fill = (remaining * cut / 1_000_000).max(1).min(remaining);
            let paid = orders::proceeds(fill, price);
            prop_assert!(paid <= escrow);
            escrow -= paid;
            remaining -= fill;
            prop_assert!(escrow >= orders::cost(remaining, price));
            if remaining == 0 {
                break;
            }
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1024))]

    /// Whatever the pools hold and whichever worlds are left, known odds add up to exactly 1e18 and dead worlds get 0.
    #[test]
    fn odds_sum_to_exactly_one(
        four in any::<bool>(),
        reserves in vec((1u128..=u128::MAX / 2, 1u128..=u128::MAX / 2), 3),
        mask_seed in any::<u8>(),
    ) {
        let world_count = if four { 4 } else { 2 };
        let root = (1u8 << world_count) - 1;
        let possible = (mask_seed % root) + 1;
        let q = odds::odds(world_count, possible, |x, y| {
            let index = odds::pairs(world_count).iter().position(|&pair| pair == (x, y)).unwrap();
            let (r_x, r_y) = reserves[index];
            odds::share_x(r_x, r_y)
        })
        .unwrap();
        prop_assert_eq!(q.iter().sum::<u128>(), WAD);
        for (w, odds) in q.iter().enumerate() {
            if possible & (1 << w) == 0 {
                prop_assert_eq!(*odds, 0);
            }
        }
    }
}

/// One collateral piece: USDC-valued or WETH-valued, over a mask of worlds (root = the real asset).
#[derive(Clone, Debug)]
struct Piece {
    weth: bool,
    mask: u8,
    held: u128,
}

fn piece() -> impl Strategy<Value = Piece> {
    (any::<bool>(), 1u8..=0b1111, 1u128..=100_000 * WAD).prop_map(|(weth, mask, held)| Piece {
        weth,
        mask,
        held,
    })
}

/// Value of `amount` of a piece in world `w`, floored per piece.
fn value_in(piece: &Piece, amount: u128, w: usize, prices: &[u128; 4]) -> u128 {
    if piece.mask & (1 << w) == 0 {
        0
    } else if piece.weth {
        risk::weth_value(amount, prices[w])
    } else {
        amount
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1024))]

    /// When a liquidation is a cut and passes the LiquidationTooSmall margin, the slice it takes is
    /// worth more than the repayment in every possible world; when target >= C_min it takes everything.
    #[test]
    fn liquidation_slices_cover_the_repayment(
        pieces in vec(piece(), 1..=16),
        prices in proptest::array::uniform4(1u128..=10_000 * WAD),
        possible in 1u8..=0b1111,
        debt_seed in 1u128..=1_000_000,
        repay_seed in 1u128..=1_000_000,
        bonus in 1u128..=330_000_000_000_000_000,
    ) {
        let values: Vec<u128> = (0..4)
            .map(|w| if possible & (1 << w) == 0 { 0 } else { pieces.iter().map(|p| value_in(p, p.held, w, &prices)).sum() })
            .collect();
        let (_, lowest) = risk::worst_world(&values, possible).unwrap();
        // Debt from just healthy to deep underwater: up to 2x the worst world's value.
        let debt = (lowest / 500_000).max(1) * debt_seed;
        let max_repay = risk::max_repay(debt);
        prop_assume!(max_repay > 0);
        let repaid = (max_repay * repay_seed / 1_000_000).max(1);
        let target = risk::liquidation_target(repaid, bonus);
        let max_price = (0..4).filter(|w| possible & (1 << w) != 0).map(|w| prices[w]).max().unwrap();
        let seized: Vec<u128> = pieces.iter().map(|p| risk::seize_amount(p.held, target, lowest)).collect();
        if target >= lowest {
            prop_assert!(seized.iter().zip(&pieces).all(|(s, p)| *s == p.held));
        } else if !risk::is_too_small(repaid, target, lowest, pieces.len() as u32, max_price) {
            for w in (0..4).filter(|w| possible & (1 << w) != 0) {
                let slice: u128 = pieces.iter().zip(&seized).map(|(p, s)| value_in(p, *s, w, &prices)).sum();
                prop_assert!(slice > repaid, "world {}: slice {} <= repaid {}", w, slice, repaid);
            }
        }
    }

    /// Health factor: none without debt, floor(lowest * lltv / debt) otherwise, saturating instead of overflowing.
    #[test]
    fn health_factor_rounds_down_and_saturates(lowest in any_u128(), debt in any_u128(), lltv in 0u128..=WAD) {
        match risk::health_factor(lowest, debt, lltv) {
            None => prop_assert_eq!(debt, 0),
            Some(hf) => {
                let exact = U256::from(lowest) * U256::from(lltv) / U256::from(debt);
                prop_assert_eq!(U256::from(hf), exact.min(U256::from(u128::MAX)));
            }
        }
    }
}
