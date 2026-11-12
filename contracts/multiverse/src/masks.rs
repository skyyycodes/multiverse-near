//! MaskLib: worlds as bits. Bit `w` of a mask set means world `w` is
//! included. A mask is valid for a scenario when it is non-zero and has no
//! bit outside the scenario's root. Nothing here rounds: core is 1:1 base
//! units and bit operations.

use crate::errors::fail;

pub const MAX_WORLDS: u8 = 4;
pub const MAX_EVENTS: usize = 2;

/// `(1 << W) - 1`; 0 for W = 0, which no existing scenario has.
pub fn root(world_count: u8) -> u8 {
    ((1u16 << world_count) - 1) as u8
}

pub fn contains(mask: u8, world: u8) -> bool {
    world < 8 && (mask >> world) & 1 == 1
}

pub fn is_subset(a: u8, b: u8) -> bool {
    a & !b == 0
}

pub fn is_single_world(mask: u8) -> bool {
    mask != 0 && mask & (mask - 1) == 0
}

/// Index of the lowest set bit. Callers pass non-zero masks (for 0 this
/// returns 8).
pub fn lowest_world(mask: u8) -> u8 {
    mask.trailing_zeros() as u8
}

/// Digit of world `w` for the event with this stride and outcome count.
pub fn digit(world: u8, stride: u8, outcomes: u8) -> u8 {
    (world / stride) % outcomes
}

/// Every world (of `world_count`) whose digit for this event is `outcome`.
pub fn worlds_with(world_count: u8, stride: u8, outcomes: u8, outcome: u8) -> u8 {
    (0..world_count)
        .filter(|w| digit(*w, stride, outcomes) == outcome)
        .fold(0, |mask, w| mask | 1 << w)
}

pub fn is_live(mask: u8, possible: u8) -> bool {
    mask & possible != 0
}

/// Pays out in every world that can still happen, so it is worth 1:1.
pub fn is_collapsed(mask: u8, possible: u8) -> bool {
    mask & possible == possible
}

pub fn check_mask(mask: u8, root: u8) {
    if mask == 0 || mask & !root != 0 {
        crate::fail!("InvalidMask({mask})");
    }
}

/// The partition rule shared by split (parent = from mask) and merge (parent =
/// to mask). Parts must be non-empty, each a live strict subset of the parent,
/// pairwise disjoint, and together cover every possible world of the parent.
/// Dead worlds may ride along in a part and need no cover. The check order
/// decides which error a caller sees, so it never changes.
pub fn check_partition(possible: u8, parent: u8, parts: &[u8]) {
    if parts.is_empty() {
        fail("EmptyPartition");
    }
    let mut union = 0u8;
    for &part in parts {
        if part == 0 || part == parent || part & !parent != 0 {
            crate::fail!("NotStrictSubset({part}, {parent})");
        }
        if part & possible == 0 {
            crate::fail!("DeadVerse({part})");
        }
        if part & union != 0 {
            crate::fail!("NotDisjoint({part})");
        }
        union |= part;
    }
    let missing = parent & possible & !union;
    if missing != 0 {
        crate::fail!("DoesNotCover({missing})");
    }
}

/// The single-world masks of `possible`, lowest world first.
pub fn single_worlds(possible: u8) -> Vec<u8> {
    (0..MAX_WORLDS)
        .map(|w| 1u8 << w)
        .filter(|bit| possible & bit != 0)
        .collect()
}
