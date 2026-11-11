//! Failed checks panic with a message shaped like the Solidity custom error
//! they replace, e.g. `DeadVerse(8)` or `InsufficientOutput(3, 4748, 4800)`,
//! so the app can show it verbatim and tests can match it exactly. A panic
//! rolls back the whole receipt; inside `ft_on_transfer` it also makes the
//! token contract refund the transfer in full.
//!
//! Numbers are printed in decimal (masks too), account ids as plain text,
//! arguments separated by ", ".

use near_sdk::env;

pub fn fail(msg: &str) -> ! {
    env::panic_str(msg)
}

/// `fail!("DeadVerse({mask})")`: format, then panic.
#[macro_export]
macro_rules! fail {
    ($($arg:tt)*) => {
        $crate::errors::fail(&format!($($arg)*))
    };
}

/// For `ft_on_transfer` actions whose module is not built yet.
pub fn not_implemented(action: &str) -> ! {
    fail!("NotImplemented({action})")
}

// Checked arithmetic that fails the way Solidity 0.8 reverts on overflow.

pub fn add(a: u128, b: u128) -> u128 {
    a.checked_add(b)
        .unwrap_or_else(|| fail("ArithmeticOverflow"))
}

pub fn sub(a: u128, b: u128) -> u128 {
    a.checked_sub(b)
        .unwrap_or_else(|| fail("ArithmeticUnderflow"))
}

pub fn mul(a: u128, b: u128) -> u128 {
    a.checked_mul(b)
        .unwrap_or_else(|| fail("ArithmeticOverflow"))
}
