//! Unit tests, run natively against near-sdk's mocked runtime.
//!
//! `core` and `oracle` port the EVM `MultiverseCore.t.sol` and
//! `EventOracle.t.sol` test by test (same names in snake_case, same
//! assertions, error names and argument order).

mod harness;

mod core;
mod masks;
mod oracle;
