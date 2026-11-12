//! The USDC leg of an order-book trade (`OrderMath`).
//!
//! Prices are USDC per wNEAR (WAD) and amounts are wNEAR; the wNEAR leg is never rounded. Whoever pays USDC pays the
//! ceiling and whoever receives USDC from escrow gets the floor, so an open bid's escrow always covers every fill
//! still possible (`escrow >= cost(remaining)`).

use crate::fixed::{mul_div_down, mul_div_up, WAD};

/// Price scale: one wNEAR.
pub const ONE: u128 = WAD;

/// USDC a buyer pays for `amount` wNEAR at `price`, rounded up (a bid's escrow, the cost of filling an ask).
/// Panics with `MulDivOverflow` if it does not fit a `u128`.
#[track_caller]
pub fn cost(amount: u128, price: u128) -> u128 {
    mul_div_up(amount, price, ONE)
}

/// USDC a seller receives for `amount` wNEAR at `price`, rounded down (what filling a bid pays from escrow).
/// Panics with `MulDivOverflow` if it does not fit a `u128`.
#[track_caller]
pub fn proceeds(amount: u128, price: u128) -> u128 {
    mul_div_down(amount, price, ONE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worked_examples() {
        // A 3 wei bid at 1.5 escrows ceil(4.5) = 5; three 1 wei fills pay 1 each and the
        // last one refunds the 2 wei of rounding dust to the maker.
        let price = 1_500_000_000_000_000_000;
        let mut escrow = cost(3, price);
        assert_eq!(escrow, 5);
        for _ in 0..3 {
            let paid = proceeds(1, price);
            assert_eq!(paid, 1);
            escrow -= paid;
        }
        assert_eq!(escrow, 2);
        // An ask of 3 wei at 1.5: filling 1 wei costs ceil(1.5) = 2.
        assert_eq!(cost(1, price), 2);
        // A 1 wei sale into a bid at 0.5 pays nothing (the book rejects it with ZeroValue).
        assert_eq!(proceeds(1, 500_000_000_000_000_000), 0);
        // Ravi's demo bid: 1 wNEAR at 2,450 escrows exactly 2,450 USDC.
        assert_eq!(cost(WAD, 2_450 * WAD), 2_450 * WAD);
        assert_eq!(cost(0, 2_450 * WAD), 0);
    }
}
