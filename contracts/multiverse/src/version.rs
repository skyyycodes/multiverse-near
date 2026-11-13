//! Versions of the stored layout and of the code.
//!
//! The VersionRecord lives under its own raw key (`0x1b`), outside the root
//! record, so a future `migrate` can learn which layout STATE has before it
//! decodes it. Its first four bytes are always `state_version` (u32 LE); its
//! layout is frozen. A v1 deployment has no record: its state version is 1.

use near_sdk::borsh::{self, BorshDeserialize};
use near_sdk::{env, near, IntoStorageKey};

use crate::errors::fail;
use crate::{now_sec, StorageKey};

/// +1 on any Borsh layout change of STATE or of a stored value type; each bump
/// needs a `migrate` step from the version before.
pub const STATE_VERSION: u32 = 2;
/// The crate version, which is also the NEP-330 `version` of the build.
pub const CODE_VERSION: &str = env!("CARGO_PKG_VERSION");
/// The release name of the v1 code (its NEP-330 `version` reads `0.1.0`).
pub const V1_CODE_VERSION: &str = "1.0.0";
/// The state version of a deployment that has no VersionRecord.
pub const V1_STATE_VERSION: u32 = 1;

/// Raw key 0x1b. FROZEN: never add, remove or reorder fields. state_version is
/// always the first 4 bytes (u32 LE).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VersionRecord {
    pub state_version: u32,
    pub code_version: String,
    pub upgraded_at_sec: u64,
    pub upgraded_from: String,
}

fn record_key() -> Vec<u8> {
    StorageKey::VersionRecord.into_storage_key()
}

/// The stored state version: 1 when there is no record (v1), else the record's
/// first four bytes. A record shorter than that fails `CorruptVersionRecord`.
pub(crate) fn stored_state_version() -> u32 {
    match env::storage_read(&record_key()) {
        None => V1_STATE_VERSION,
        Some(bytes) => match bytes.get(..4) {
            Some(head) => u32::from_le_bytes([head[0], head[1], head[2], head[3]]),
            None => fail("CorruptVersionRecord"),
        },
    }
}

/// The whole record, if there is one that decodes.
#[allow(dead_code)] // read by the contract_version view
pub(crate) fn version_record() -> Option<VersionRecord> {
    env::storage_read(&record_key()).and_then(|bytes| VersionRecord::try_from_slice(&bytes).ok())
}

/// Writes `{STATE_VERSION, CODE_VERSION, now, upgraded_from}` through to its
/// raw key.
pub(crate) fn write_version_record(upgraded_from: &str) {
    let record = VersionRecord {
        state_version: STATE_VERSION,
        code_version: CODE_VERSION.to_string(),
        upgraded_at_sec: now_sec(),
        upgraded_from: upgraded_from.to_string(),
    };
    let bytes = borsh::to_vec(&record).unwrap_or_else(|_| env::abort());
    env::storage_write(&record_key(), &bytes);
}
