//! Dynamic LP fee from recent order flow (`SwapFlow`).
//!
//! A pool remembers the signed volume of its last 8 swaps, measured in one token (token0: the WETH side of a
//! within-world pool, the first verse of a between-world pool) as the swapper's delta: negative when that token was
//! sold into the pool (the full input, fee included), positive when it was bought out. The next swap pays
//! `base + ceil((cap - base) * |net| / total)`: balanced flow pays the base fee, one-sided flow pays the cap.
//!
//! Swaps that move none of the measured token are not recorded, so dust cannot flush the window. The window counts
//! swaps, not volume, so a run of tiny balanced swaps still dilutes it (a stated limitation of the design).

use borsh::{BorshDeserialize, BorshSerialize};

use crate::fixed::U256;

/// Number of recorded swaps in the window.
pub const WINDOW: usize = 8;

/// Ring buffer of the last [`WINDOW`] non-zero volumes of one pool.
#[derive(Clone, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(borsh::BorshSchema))]
pub struct SwapFlow {
    volumes: [i128; WINDOW],
    count: u64,
}

/// Sums over the window. Each is at most 8 * 2^127, more than 128 bits, hence `U256`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FlowWindow {
    /// Volume sold into the pool (the magnitudes of the negative entries).
    pub sold: U256,
    /// Volume bought out of the pool (the positive entries).
    pub bought: U256,
}

impl FlowWindow {
    /// Sum of every swap's size.
    pub fn total(&self) -> U256 {
        self.sold + self.bought
    }

    /// `|net sold|`.
    pub fn net_abs(&self) -> U256 {
        if self.sold >= self.bought {
            self.sold - self.bought
        } else {
            self.bought - self.sold
        }
    }

    /// True when more was bought out than sold in (net sold is negative).
    pub fn net_is_negative(&self) -> bool {
        self.bought > self.sold
    }
}

impl SwapFlow {
    /// An empty window: the next swap pays the base fee.
    pub fn new() -> Self {
        Self::default()
    }

    /// Non-zero volumes recorded since the pool was created.
    pub fn count(&self) -> u64 {
        self.count
    }

    /// The ring buffer as stored (unwritten slots are 0); the next volume goes to `count % WINDOW`.
    pub fn volumes(&self) -> &[i128; WINDOW] {
        &self.volumes
    }

    /// Records one swap's volume in the measured token (the swapper's delta); zero is skipped.
    pub fn record(&mut self, volume: i128) {
        if volume == 0 {
            return;
        }
        // count % 8 always fits a usize.
        self.volumes[(self.count % WINDOW as u64) as usize] = volume;
        self.count += 1;
    }

    /// Records a swap measured on token0: token0 in counts the full input (fee included) as sold, token0 out counts
    /// the output as bought. Panics with `VolumeOverflow` for an amount above `i128::MAX`.
    #[track_caller]
    pub fn record_swap(&mut self, zero_for_one: bool, amount_in: u128, amount_out: u128) {
        if zero_for_one {
            self.record(-volume(amount_in));
        } else {
            self.record(volume(amount_out));
        }
    }

    /// Sold and bought volume over the whole window.
    pub fn window(&self) -> FlowWindow {
        let mut sold = U256::zero();
        let mut bought = U256::zero();
        for &v in &self.volumes {
            if v < 0 {
                sold += U256::from(v.unsigned_abs());
            } else {
                bought += U256::from(v.unsigned_abs());
            }
        }
        FlowWindow { sold, bought }
    }

    /// Fee in pips for the next swap: `base` without history, else `base + ceil((cap - base) * |net| / total)`,
    /// rounded up in the pool's favour. Always within `[base, cap]`. Panics with `InvalidFeeBounds` if `base > cap`.
    #[track_caller]
    pub fn fee(&self, base: u32, cap: u32) -> u32 {
        if base > cap {
            panic!("InvalidFeeBounds({base}, {cap})");
        }
        let window = self.window();
        let total = window.total();
        if total.is_zero() {
            return base;
        }
        // (cap - base) < 2^32 and |net| <= 2^130, so the product fits; the quotient is at most cap - base.
        let spread = U256::from(cap - base);
        let extra = (spread * window.net_abs() + total - U256::one()) / total;
        base + extra.low_u32()
    }
}

#[track_caller]
fn volume(amount: u128) -> i128 {
    i128::try_from(amount).unwrap_or_else(|_| panic!("VolumeOverflow({amount})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: u32 = 3000;
    const CAP: u32 = 15000;
    const ONE: i128 = 1_000_000_000_000_000_000;

    #[test]
    fn base_without_history_then_cap_after_one_sale() {
        let mut flow = SwapFlow::new();
        assert_eq!(
            flow.window(),
            FlowWindow {
                sold: U256::zero(),
                bought: U256::zero()
            }
        );
        assert_eq!(flow.fee(BASE, CAP), BASE);
        flow.record(-ONE);
        assert_eq!(flow.fee(BASE, CAP), CAP);
        assert_eq!(flow.count(), 1);
    }

    #[test]
    fn zero_volume_is_not_recorded() {
        let mut flow = SwapFlow::new();
        flow.record(0);
        flow.record_swap(false, 1, 0);
        assert_eq!(flow.count(), 0);
        assert_eq!(flow.fee(BASE, CAP), BASE);
    }

    #[test]
    fn record_swap_measures_token0() {
        let mut flow = SwapFlow::new();
        flow.record_swap(true, 5, 100);
        flow.record_swap(false, 100, 3);
        assert_eq!(flow.volumes()[..2], [-5, 3]);
    }

    #[test]
    fn extremes_do_not_overflow() {
        let mut flow = SwapFlow::new();
        for _ in 0..WINDOW {
            flow.record(i128::MIN);
        }
        let window = flow.window();
        assert_eq!(window.sold, U256::from(1u8) << 130);
        assert_eq!(flow.fee(BASE, CAP), CAP);
        flow.record(i128::MAX);
        assert_eq!(
            flow.fee(0, u32::MAX),
            (u64::from(u32::MAX) * 6 / 8 + 1) as u32
        );
    }

    #[test]
    #[should_panic(expected = "VolumeOverflow")]
    fn oversized_volume_panics() {
        SwapFlow::new().record_swap(true, u128::MAX, 0);
    }

    #[test]
    #[should_panic(expected = "InvalidFeeBounds(15000, 3000)")]
    fn inverted_bounds_panic() {
        SwapFlow::new().fee(CAP, BASE);
    }
}
