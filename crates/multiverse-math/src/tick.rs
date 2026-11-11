//! Uniswap v4 `TickMath`: square-root prices for ticks of 1.0001 and back, bit for bit.
//!
//! `get_sqrt_ratio_at_tick(t)` is `sqrt(1.0001^t) * 2^96` (Q64.96, rounded up) and `get_tick_at_sqrt_ratio(s)` is the
//! greatest tick whose ratio is `<= s`. Out-of-range inputs panic with the v4 error names. The contract keeps a tick
//! TWAP per pool, and lending prices collateral from the mean tick exactly as the EVM did.

use crate::fixed::U256;

/// Lowest tick: log base 1.0001 of 2^-128.
pub const MIN_TICK: i32 = -887_272;
/// Highest tick: log base 1.0001 of 2^128.
pub const MAX_TICK: i32 = 887_272;
/// `get_sqrt_ratio_at_tick(MIN_TICK)`.
pub const MIN_SQRT_RATIO: U256 = U256([4_295_128_739, 0, 0, 0]);
/// `get_sqrt_ratio_at_tick(MAX_TICK)` = 1461446703485210103287273052203988822378723970342.
pub const MAX_SQRT_RATIO: U256 =
    U256([0x5d95_1d52_6398_8d26, 0xefd1_fc6a_5064_8849, 0xfffd_8963, 0]);

// 2^128 / sqrt(1.0001)^(2^i), Q128.128 rounded to nearest, for bit i of |tick|. Copied from v4-core.
const RATIO_BIT_0: u128 = 0xfffc_b933_bd6f_ad37_aa2d_162d_1a59_4001;
const RATIO_BITS: [u128; 19] = [
    0xfff9_7272_373d_4132_59a4_6990_580e_213a,
    0xfff2_e50f_5f65_6932_ef12_357c_f3c7_fdcc,
    0xffe5_caca_7e10_e4e6_1c36_24ea_a094_1cd0,
    0xffcb_9843_d60f_6159_c9db_5883_5c92_6644,
    0xff97_3b41_fa98_c081_472e_6896_dfb2_54c0,
    0xff2e_a164_66c9_6a38_43ec_78b3_26b5_2861,
    0xfe5d_ee04_6a99_a2a8_11c4_61f1_969c_3053,
    0xfcbe_86c7_900a_88ae_dcff_c83b_479a_a3a4,
    0xf987_a725_3ac4_1317_6f2b_074c_f781_5e54,
    0xf339_2b08_22b7_0005_940c_7a39_8e4b_70f3,
    0xe715_9475_a2c2_9b74_43b2_9c7f_a6e8_89d9,
    0xd097_f3bd_fd20_22b8_845a_d8f7_92aa_5825,
    0xa9f7_4646_2d87_0fdf_8a65_dc1f_90e0_61e5,
    0x70d8_69a1_56d2_a1b8_90bb_3df6_2baf_32f7,
    0x31be_135f_97d0_8fd9_8123_1505_542f_cfa6,
    0x09aa_508b_5b7a_84e1_c677_de54_f3e9_9bc9,
    0x005d_6af8_dedb_8119_6699_c329_225e_e604,
    0x0000_2216_e584_f5fa_1ea9_2604_1bed_fe98,
    0x0000_0000_048a_1703_91f7_dc42_444e_8fa2,
];

/// `sqrt(1.0001^tick) * 2^96`, rounded up. Panics with `InvalidTick(tick)` outside `[MIN_TICK, MAX_TICK]`.
#[track_caller]
pub fn get_sqrt_ratio_at_tick(tick: i32) -> U256 {
    let abs_tick = tick.unsigned_abs();
    if abs_tick > MAX_TICK.unsigned_abs() {
        panic!("InvalidTick({tick})");
    }
    let mut ratio = if abs_tick & 1 != 0 {
        U256::from(RATIO_BIT_0)
    } else {
        U256::one() << 128
    };
    for (bit, factor) in RATIO_BITS.iter().enumerate() {
        if abs_tick & (2 << bit) != 0 {
            // ratio <= 2^128 and factor < 2^128, so the product fits 256 bits.
            ratio = (ratio * U256::from(*factor)) >> 128;
        }
    }
    if tick > 0 {
        ratio = U256::MAX / ratio;
    }
    // Q128.128 to Q64.96, rounding up so that get_tick_at_sqrt_ratio of the result gives back `tick`.
    (ratio + U256::from(u32::MAX)) >> 32
}

/// Greatest tick `t` with `get_sqrt_ratio_at_tick(t) <= sqrt_ratio_x96`. Panics with `InvalidSqrtPrice(s)` unless
/// `MIN_SQRT_RATIO <= s < MAX_SQRT_RATIO`.
#[track_caller]
pub fn get_tick_at_sqrt_ratio(sqrt_ratio_x96: U256) -> i32 {
    if sqrt_ratio_x96 < MIN_SQRT_RATIO || sqrt_ratio_x96 >= MAX_SQRT_RATIO {
        panic!("InvalidSqrtPrice({sqrt_ratio_x96})");
    }
    let ratio = sqrt_ratio_x96 << 32;
    let msb = ratio.bits() - 1;
    // Normalise to [2^127, 2^128) and square repeatedly to read off the fractional bits of log2.
    let mut r = if msb >= 128 {
        ratio >> (msb - 127)
    } else {
        ratio << (127 - msb)
    };
    let mut log_2: i128 = (msb as i128 - 128) << 64;
    for bit in (50..64).rev() {
        r = (r * r) >> 127;
        let f = (r >> 128).low_u64();
        log_2 |= i128::from(f) << bit;
        r >>= f;
    }

    // log_sqrt10001 needs more than 128 bits, so the last steps run in 256-bit two's complement.
    let log_sqrt10001 = I256::from_i128(log_2).wrapping_mul(255_738_958_999_603_826_347_141);
    let tick_low = log_sqrt10001
        .wrapping_sub(3_402_992_956_809_132_418_596_140_100_660_247_210)
        .shr_128();
    let tick_high = log_sqrt10001
        .wrapping_add(291_339_464_771_989_622_907_027_621_153_398_088_495)
        .shr_128();

    if tick_low == tick_high {
        tick_low
    } else if get_sqrt_ratio_at_tick(tick_high) <= sqrt_ratio_x96 {
        tick_high
    } else {
        tick_low
    }
}

/// [`get_tick_at_sqrt_ratio`] extended to every `s`: `MIN_TICK` below the range, `MAX_TICK` at or above its top.
///
/// A constant-product pool with `u128` reserves can in principle sit outside v4's price range, and recording a TWAP
/// observation must never fail a swap.
pub fn tick_at_sqrt_ratio_clamped(sqrt_ratio_x96: U256) -> i32 {
    if sqrt_ratio_x96 < MIN_SQRT_RATIO {
        MIN_TICK
    } else if sqrt_ratio_x96 >= MAX_SQRT_RATIO {
        MAX_TICK
    } else {
        get_tick_at_sqrt_ratio(sqrt_ratio_x96)
    }
}

/// Just enough of a signed 256-bit integer for `get_tick_at_sqrt_ratio`: two's complement in a `U256`.
#[derive(Clone, Copy)]
struct I256(U256);

impl I256 {
    fn from_i128(value: i128) -> Self {
        let magnitude = U256::from(value.unsigned_abs());
        if value < 0 {
            I256((!magnitude).overflowing_add(U256::one()).0)
        } else {
            I256(magnitude)
        }
    }

    fn wrapping_mul(self, factor: u128) -> Self {
        I256(self.0.overflowing_mul(U256::from(factor)).0)
    }

    fn wrapping_add(self, value: u128) -> Self {
        I256(self.0.overflowing_add(U256::from(value)).0)
    }

    fn wrapping_sub(self, value: u128) -> Self {
        I256(self.0.overflowing_sub(U256::from(value)).0)
    }

    /// Arithmetic shift right by 128 (floor division by 2^128), narrowed to the tick it encodes.
    fn shr_128(self) -> i32 {
        let negative = self.0.bit(255);
        let shifted = if negative {
            !((!self.0) >> 128)
        } else {
            self.0 >> 128
        };
        // The value is a tick, well inside i32; its low 64 bits are its two's complement.
        shifted.low_u64() as i64 as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn min_tick_is_minus_max_tick() {
        assert_eq!(MIN_TICK, -MAX_TICK);
    }

    #[test]
    fn canonical_values() {
        // From v4-core TickMath.t.sol.
        assert_eq!(get_sqrt_ratio_at_tick(MIN_TICK), MIN_SQRT_RATIO);
        assert_eq!(
            get_sqrt_ratio_at_tick(MIN_TICK),
            U256::from(4_295_128_739u64)
        );
        assert_eq!(
            get_sqrt_ratio_at_tick(MIN_TICK + 1),
            U256::from(4_295_343_490u64)
        );
        assert_eq!(get_sqrt_ratio_at_tick(MAX_TICK), MAX_SQRT_RATIO);
        assert_eq!(
            get_sqrt_ratio_at_tick(MAX_TICK),
            U256::from_dec_str("1461446703485210103287273052203988822378723970342").unwrap()
        );
        assert_eq!(
            get_sqrt_ratio_at_tick(MAX_TICK - 1),
            U256::from_dec_str("1461373636630004318706518188784493106690254656249").unwrap()
        );
        assert_eq!(get_sqrt_ratio_at_tick(0), U256::one() << 96);
        assert_eq!(get_tick_at_sqrt_ratio(MIN_SQRT_RATIO), MIN_TICK);
        assert_eq!(
            get_tick_at_sqrt_ratio(U256::from(4_295_343_490u64)),
            MIN_TICK + 1
        );
        assert_eq!(get_tick_at_sqrt_ratio(MAX_SQRT_RATIO - 1), MAX_TICK - 1);
        assert_eq!(
            get_tick_at_sqrt_ratio(
                U256::from_dec_str("1461373636630004318706518188784493106690254656249").unwrap()
            ),
            MAX_TICK - 1
        );
        assert_eq!(get_tick_at_sqrt_ratio(U256::one() << 96), 0);
    }

    #[test]
    fn javascript_bounds() {
        // sqrt(2^-127) * 2^96 and sqrt(2^127) * 2^96 from the v4 test suite.
        assert!(get_sqrt_ratio_at_tick(MIN_TICK) < U256::from(6_085_630_636u64));
        assert!(
            get_sqrt_ratio_at_tick(MAX_TICK)
                > U256::from_dec_str("1033437718471923706666374484006904511252097097914").unwrap()
        );
    }

    #[test]
    #[should_panic(expected = "InvalidTick(-887273)")]
    fn tick_below_min_panics() {
        get_sqrt_ratio_at_tick(MIN_TICK - 1);
    }

    #[test]
    #[should_panic(expected = "InvalidTick(887273)")]
    fn tick_above_max_panics() {
        get_sqrt_ratio_at_tick(MAX_TICK + 1);
    }

    #[test]
    #[should_panic(expected = "InvalidTick(-8388608)")]
    fn int24_min_panics() {
        get_sqrt_ratio_at_tick(-8_388_608);
    }

    #[test]
    #[should_panic(expected = "InvalidTick(-2147483648)")]
    fn i32_min_panics() {
        get_sqrt_ratio_at_tick(i32::MIN);
    }

    #[test]
    #[should_panic(expected = "InvalidSqrtPrice(4295128738)")]
    fn sqrt_ratio_below_min_panics() {
        get_tick_at_sqrt_ratio(MIN_SQRT_RATIO - 1);
    }

    #[test]
    #[should_panic(
        expected = "InvalidSqrtPrice(1461446703485210103287273052203988822378723970342)"
    )]
    fn sqrt_ratio_at_max_panics() {
        get_tick_at_sqrt_ratio(MAX_SQRT_RATIO);
    }

    #[test]
    fn clamping() {
        assert_eq!(tick_at_sqrt_ratio_clamped(U256::zero()), MIN_TICK);
        assert_eq!(tick_at_sqrt_ratio_clamped(MIN_SQRT_RATIO - 1), MIN_TICK);
        assert_eq!(tick_at_sqrt_ratio_clamped(MIN_SQRT_RATIO), MIN_TICK);
        assert_eq!(tick_at_sqrt_ratio_clamped(MAX_SQRT_RATIO - 1), MAX_TICK - 1);
        assert_eq!(tick_at_sqrt_ratio_clamped(MAX_SQRT_RATIO), MAX_TICK);
        assert_eq!(tick_at_sqrt_ratio_clamped(U256::MAX), MAX_TICK);
    }

    #[test]
    fn signed_helper() {
        assert_eq!(
            I256::from_i128(-5)
                .wrapping_mul(1 << 64)
                .wrapping_mul(1 << 64)
                .shr_128(),
            -5
        );
        assert_eq!(
            I256::from_i128(5)
                .wrapping_mul(1 << 64)
                .wrapping_mul(1 << 64)
                .shr_128(),
            5
        );
        // floor(-1 / 2^128) = -1 and floor(1 / 2^128) = 0.
        assert_eq!(I256::from_i128(-1).shr_128(), -1);
        assert_eq!(I256::from_i128(1).shr_128(), 0);
        assert_eq!(I256::from_i128(0).wrapping_sub(1).shr_128(), -1);
    }
}
