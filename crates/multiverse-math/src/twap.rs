//! Time-weighted average tick of one pool (`TwapOracle`).
//!
//! Observations hold cumulative tick-seconds. There is at most one per second: several swaps in the same second
//! overwrite the newest tick, so only the tick that survives into the next second carries weight and a swap and its
//! reversal inside one block move the mean by nothing. The buffer keeps the last [`CAPACITY`] observations; it is a
//! `Vec` that grows on demand, so a young pool stores only what it has written.
//!
//! The mean over `window` seconds exists once an observation at or before `now - window` is still kept: from
//! `window` seconds after the first observation, for as long as fewer than `CAPACITY` distinct seconds with swaps
//! fall inside the window. With a 60 second window and one observation per second it cannot be overrun.
//!
//! [`TwapOracle::write_spaced`] keeps longer windows covered: it moves the newest observation forward instead of
//! adding one until `spacing` seconds have passed since the one before it. Cumulatives stay exact at every kept
//! observation; only a read that falls between the last two is interpolated with the older tick, so a mean is off
//! by at most `spacing` seconds of tick movement. Spacing a ring of `CAPACITY` at `window / 64` covers two windows.

use borsh::{BorshDeserialize, BorshSerialize};

/// Observations kept.
pub const CAPACITY: usize = 128;

/// One point of the cumulative tick curve.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(borsh::BorshSchema))]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Observation {
    /// Seconds.
    pub timestamp: u64,
    /// Sum of tick * seconds up to `timestamp`.
    #[cfg_attr(feature = "serde", serde(with = "crate::serde_impls::i64_string"))]
    pub tick_cumulative: i64,
    /// Tick in force from `timestamp` until the next observation.
    pub tick: i32,
}

/// Ring buffer of observations.
#[derive(Clone, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(borsh::BorshSchema))]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct TwapOracle {
    newest: u16,
    observations: Vec<Observation>,
}

impl TwapOracle {
    /// An oracle whose first observation is `tick` at `time` (a pool's creation).
    pub fn new(time: u64, tick: i32) -> Self {
        let mut oracle = Self::default();
        oracle.initialize(time, tick);
        oracle
    }

    /// Writes the first observation. Panics with `AlreadyInitialized` if there is one.
    #[track_caller]
    pub fn initialize(&mut self, time: u64, tick: i32) {
        if !self.observations.is_empty() {
            panic!("AlreadyInitialized");
        }
        self.observations.push(Observation {
            timestamp: time,
            tick_cumulative: 0,
            tick,
        });
        self.newest = 0;
    }

    /// Records that `tick` is in force from `time` on (after every swap, with the post-swap tick). Within the same
    /// second the newest tick is overwritten. Panics with `NotInitialized` before [`TwapOracle::initialize`],
    /// `TimeWentBackwards` if `time` is older than the newest observation, `Overflow` if the sum overflows `i64`.
    #[track_caller]
    pub fn write(&mut self, time: u64, tick: i32) {
        self.write_spaced(time, tick, 1);
    }

    /// [`TwapOracle::write`], keeping kept observations at least `spacing` seconds apart (except the newest): while
    /// the observation before the newest is younger than `spacing`, the newest moves to `time` instead. A spacing of
    /// 0 or 1 is plain `write`.
    #[track_caller]
    pub fn write_spaced(&mut self, time: u64, tick: i32, spacing: u64) {
        let newest = usize::from(self.newest);
        let last = *self
            .observations
            .get(newest)
            .unwrap_or_else(|| panic!("NotInitialized"));
        if time == last.timestamp {
            self.observations[newest].tick = tick;
            return;
        }
        if time < last.timestamp {
            panic!("TimeWentBackwards({time}, {})", last.timestamp);
        }
        let tick_cumulative = accumulate(last, time);
        let observation = Observation {
            timestamp: time,
            tick_cumulative,
            tick,
        };
        let count = self.observations.len();
        if count >= 2 {
            let previous = self.observations[(newest + count - 1) % count];
            if time - previous.timestamp < spacing {
                self.observations[newest] = observation;
                return;
            }
        }
        let next = (newest + 1) % CAPACITY;
        if self.observations.len() < CAPACITY {
            self.observations.push(observation);
        } else {
            self.observations[next] = observation;
        }
        self.newest = next as u16;
    }

    /// Observations written so far, at most [`CAPACITY`].
    pub fn count(&self) -> u16 {
        self.observations.len() as u16
    }

    /// Index of the newest observation in the ring.
    pub fn newest_index(&self) -> u16 {
        self.newest
    }

    /// The newest observation, if any.
    pub fn latest(&self) -> Option<Observation> {
        self.observations.get(usize::from(self.newest)).copied()
    }

    /// The kept observations, oldest first.
    pub fn observations(&self) -> impl Iterator<Item = &Observation> + '_ {
        let oldest = self.oldest_index();
        let count = self.observations.len();
        (0..count).map(move |i| &self.observations[(oldest + i) % count.max(1)])
    }

    /// Cumulative tick-seconds at `target`; `None` if `target` is older than the oldest observation kept.
    #[track_caller]
    pub fn cumulative_at(&self, target: u64) -> Option<i64> {
        let count = self.observations.len();
        if count == 0 {
            return None;
        }
        let oldest = self.oldest_index();
        let at = |position: usize| &self.observations[(oldest + position) % count];
        if target < at(0).timestamp {
            return None;
        }
        // Last observation with timestamp <= target, by logical position (oldest first).
        let (mut lo, mut hi) = (0, count - 1);
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            if at(mid).timestamp <= target {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        Some(accumulate(*at(lo), target))
    }

    /// Arithmetic mean tick over `[time - window, time]`, rounded toward negative infinity; `None` when `window` is
    /// 0, `time < window`, or no observation at or before `time - window` is kept.
    #[track_caller]
    pub fn mean_tick(&self, time: u64, window: u64) -> Option<i32> {
        if window == 0 || time < window {
            return None;
        }
        let past = self.cumulative_at(time - window)?;
        let current = self.cumulative_at(time)?;
        let delta = i128::from(current) - i128::from(past);
        // Floor division, as the Solidity code truncates and then steps down for a negative remainder.
        let mean = delta.div_euclid(i128::from(window));
        Some(i32::try_from(mean).expect("a mean of ticks is a tick"))
    }

    fn oldest_index(&self) -> usize {
        if self.observations.len() < CAPACITY {
            0
        } else {
            (usize::from(self.newest) + 1) % CAPACITY
        }
    }
}

#[track_caller]
fn accumulate(from: Observation, until: u64) -> i64 {
    let elapsed = i64::try_from(until - from.timestamp).unwrap_or_else(|_| panic!("Overflow"));
    i64::from(from.tick)
        .checked_mul(elapsed)
        .and_then(|weighted| from.tick_cumulative.checked_add(weighted))
        .unwrap_or_else(|| panic!("Overflow"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grows_lazily_then_wraps() {
        let mut oracle = TwapOracle::new(0, 1);
        assert_eq!(oracle.count(), 1);
        for t in 1..=127 {
            oracle.write(t, 1);
        }
        assert_eq!(oracle.count(), 128);
        assert_eq!(oracle.newest_index(), 127);
        oracle.write(128, 2);
        assert_eq!(oracle.count(), 128);
        assert_eq!(oracle.newest_index(), 0);
        let timestamps: Vec<u64> = oracle.observations().map(|o| o.timestamp).collect();
        assert_eq!(timestamps, (1..=128).collect::<Vec<u64>>());
        assert_eq!(oracle.latest().map(|o| o.tick), Some(2));
    }

    #[test]
    fn empty_oracle_has_no_history() {
        let oracle = TwapOracle::default();
        assert_eq!(oracle.cumulative_at(5), None);
        assert_eq!(oracle.mean_tick(100, 60), None);
        assert_eq!(oracle.observations().count(), 0);
        assert_eq!(oracle.latest(), None);
    }

    #[test]
    #[should_panic(expected = "NotInitialized")]
    fn write_before_initialize_panics() {
        TwapOracle::default().write(1, 1);
    }

    #[test]
    #[should_panic(expected = "TimeWentBackwards(4, 5)")]
    fn time_going_backwards_panics() {
        let mut oracle = TwapOracle::new(5, 0);
        oracle.write(4, 1);
    }

    #[test]
    fn zero_or_oversized_window_is_invalid() {
        let oracle = TwapOracle::new(0, 7);
        assert_eq!(oracle.mean_tick(100, 0), None);
        assert_eq!(oracle.mean_tick(50, 60), None);
        assert_eq!(oracle.mean_tick(60, 60), Some(7));
    }

    #[test]
    fn spaced_writes_keep_cumulatives_exact() {
        let (mut every, mut spaced) = (TwapOracle::new(1_000, 0), TwapOracle::new(1_000, 0));
        for t in 1_001..=1_120u64 {
            let tick = ((t * 7_919) % 2_001) as i32 - 1_000;
            every.write(t, tick);
            spaced.write_spaced(t, tick, 28);
        }
        assert!(spaced.count() <= 6);
        assert_eq!(spaced.cumulative_at(1_200), every.cumulative_at(1_200));
        assert_eq!(spaced.mean_tick(1_200, 200), every.mean_tick(1_200, 200));
        // Between kept observations the older tick is assumed, so a mean is off by at most one spacing's worth.
        let (a, b) = (
            spaced.mean_tick(1_200, 150).unwrap(),
            every.mean_tick(1_200, 150).unwrap(),
        );
        assert!((a - b).abs() <= 2_000 * 28 / 150 + 1, "{a} vs {b}");
    }

    #[test]
    fn spaced_writes_cover_two_windows() {
        let mut oracle = TwapOracle::new(0, 0);
        for t in 1..=3_600u64 {
            oracle.write_spaced(t, (t % 50) as i32, 1_800 / 64);
        }
        assert!(oracle.mean_tick(3_600, 1_800).is_some());
        // Plain writes, one per second, keep only the last 128 seconds.
        let mut plain = TwapOracle::new(0, 0);
        for t in 1..=3_600u64 {
            plain.write(t, (t % 50) as i32);
        }
        assert!(plain.mean_tick(3_600, 1_800).is_none());
    }
}
