//! MaskLib has no direct tests in the EVM repo; these pin its table of
//! verses and masks.

use crate::masks::*;

#[test]
fn root_of_world_counts() {
    assert_eq!(root(2), 3);
    assert_eq!(root(4), 15);
    assert_eq!(root(0), 0);
}

#[test]
fn worlds_with_matches_the_2x2_table() {
    // [glam, fed]: glam is digit 0 (stride 1), fed digit 1 (stride 2).
    assert_eq!(worlds_with(4, 1, 2, 0), 0x5); // SHIPS
    assert_eq!(worlds_with(4, 1, 2, 1), 0xA); // DELAYED
    assert_eq!(worlds_with(4, 2, 2, 0), 0x3); // CUTS
    assert_eq!(worlds_with(4, 2, 2, 1), 0xC); // HOLDS
                                              // Binary [glam].
    assert_eq!(worlds_with(2, 1, 2, 0), 0x1);
    assert_eq!(worlds_with(2, 1, 2, 1), 0x2);
}

#[test]
fn digit_is_mixed_radix_with_event_zero_lowest() {
    // world = a + 2b
    for w in 0..4u8 {
        assert_eq!(digit(w, 1, 2), w % 2);
        assert_eq!(digit(w, 2, 2), w / 2);
    }
}

#[test]
fn single_world_masks() {
    assert!(!is_single_world(0));
    assert!(is_single_world(1));
    assert!(!is_single_world(3));
    assert!(is_single_world(8));
}

#[test]
fn lowest_world_of_a_single_world() {
    assert_eq!(lowest_world(0x8), 3);
    assert_eq!(lowest_world(0x1), 0);
    assert_eq!(lowest_world(0xE), 1);
}

#[test]
fn subset_contains_live_and_collapsed() {
    assert!(is_subset(0x4, 0xC));
    assert!(is_subset(0xC, 0xC));
    assert!(!is_subset(0x3, 0xC));
    assert!(is_subset(0, 0x1));
    assert!(contains(0xE, 3));
    assert!(!contains(0xE, 0));
    assert!(!contains(0xFF, 8));
    // after Fed HOLDS (possible 0xC)
    assert!(!is_live(0x3, 0xC));
    assert!(is_live(0x5, 0xC));
    assert!(is_collapsed(0xC, 0xC));
    assert!(is_collapsed(0xD, 0xC));
    assert!(is_collapsed(0xE, 0xC));
    assert!(!is_collapsed(0x4, 0xC));
    assert!(!is_collapsed(0x3, 0xC));
    assert_eq!(single_worlds(0xC), vec![0x4, 0x8]);
}

// The partition rule on its own, one check per test, in the order they run.

#[test]
#[should_panic(expected = "EmptyPartition")]
fn partition_needs_a_part() {
    check_partition(0xF, 0xF, &[]);
}

#[test]
#[should_panic(expected = "NotStrictSubset(15, 15)")]
fn partition_part_equal_to_parent() {
    check_partition(0xF, 0xF, &[0xF]);
}

#[test]
#[should_panic(expected = "NotStrictSubset(0, 15)")]
fn partition_empty_part() {
    check_partition(0xF, 0xF, &[0]);
}

#[test]
#[should_panic(expected = "NotStrictSubset(1, 14)")]
fn partition_part_outside_parent() {
    check_partition(0xF, 0xE, &[0x1, 0x2, 0xC]);
}

/// The subset check comes before liveness: a dead part outside the parent
/// reports NotStrictSubset.
#[test]
#[should_panic(expected = "NotStrictSubset(1, 12)")]
fn partition_subset_before_liveness() {
    check_partition(0xC, 0xC, &[0x1]);
}

#[test]
#[should_panic(expected = "DeadVerse(3)")]
fn partition_dead_part() {
    check_partition(0xC, 0xF, &[0x3, 0xC]);
}

/// Liveness comes before disjointness.
#[test]
#[should_panic(expected = "DeadVerse(1)")]
fn partition_liveness_before_disjointness() {
    check_partition(0xC, 0xF, &[0xD, 0x1]);
}

#[test]
#[should_panic(expected = "NotDisjoint(12)")]
fn partition_overlapping_parts() {
    check_partition(0xF, 0xF, &[0xE, 0xC, 0x1]);
}

#[test]
#[should_panic(expected = "DoesNotCover(1)")]
fn partition_must_cover_the_possible_worlds() {
    check_partition(0xF, 0xF, &[0xE]);
}

#[test]
fn partition_accepts_dead_worlds_riding_along_and_uncovered() {
    // after Fed HOLDS (possible 0xC)
    check_partition(0xC, 0xF, &[0xC]);
    check_partition(0xC, 0xF, &[0xE]);
    check_partition(0xC, 0xF, &[0x5, 0xA]);
    check_partition(0xC, 0xD, &[0x4, 0x8]);
    check_partition(0xF, 0xF, &[0x1, 0x2, 0x4, 0x8]);
}

#[test]
#[should_panic(expected = "InvalidMask(16)")]
fn mask_outside_root() {
    check_mask(0x10, 0xF);
}
