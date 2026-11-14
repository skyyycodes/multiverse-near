//! `migrate` on production's state. The snapshot (`tests/data/
//! prod-state-277535363.json`, a `view_state` of `app.multiverse-near.testnet`
//! at block 277,535,363, public testnet data) is installed in mocked storage as
//! is; `Contract::migrate` then runs with the production arguments, as the
//! contract account, at the snapshot block's time. The harness `World` cannot
//! do it: it reads STATE as v2 before every call.
//!
//! `migrated_prod()` hands the migrated state to the tests of every part,
//! with `Prod::call` / `Prod::view` to act on it as production's accounts.

use std::collections::HashMap;
use std::panic::{self, AssertUnwindSafe};

use near_sdk::base64::engine::general_purpose::STANDARD as BASE64;
use near_sdk::base64::Engine;
use near_sdk::borsh::{self, BorshDeserialize};
use near_sdk::mock::with_mocked_blockchain;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{
    env, AccountId, Gas, IntoStorageKey, MockedBlockchain, NearToken, RuntimeFeesConfig, VMContext,
};

use super::harness::{fails, panic_message, quietly};
use crate::migrate::v1::ContractV1;
use crate::migrate::{CatalogMigrateArgs, EventMetaArg, LendingMigrateArgs};
use crate::ops::PauseFlag;
use crate::version::{VersionRecord, CODE_VERSION, STATE_VERSION, V1_CODE_VERSION};
use crate::{Contract, StorageKey};

/// The snapshot, as the RPC returned it.
const SNAPSHOT: &str = include_str!("../../tests/data/prod-state-277535363.json");

pub const PROD_CONTRACT: &str = "app.multiverse-near.testnet";
pub const PROD_OWNER: &str = "multiverse-near.testnet";
pub const PROD_BLOCK_HEIGHT: u64 = 277_535_363;
/// Block 277,535,363's timestamp.
pub const PROD_TIMESTAMP_NS: u64 = 1_794_587_756_403_894_344;
/// The contract account's balance and storage usage at the block after it.
pub const PROD_BALANCE_YOCTO: u128 = 17_625_583_889_992_306_600_000_054;
pub const PROD_STORAGE_USAGE: u64 = 861_209;
/// v1's STATE on production.
pub const PROD_STATE_BYTES: usize = 402;
/// The v2 blocks STATE gains.
pub const V2_STATE_GROWTH: usize = 406;

pub type Storage = HashMap<Vec<u8>, Vec<u8>>;

/// The 301 key-value pairs of the snapshot, decoded.
pub fn prod_snapshot() -> Storage {
    let rpc: Value = serde_json::from_str(SNAPSHOT).expect("snapshot JSON");
    assert_eq!(rpc["result"]["block_height"], PROD_BLOCK_HEIGHT);
    rpc["result"]["values"]
        .as_array()
        .expect("values")
        .iter()
        .map(|kv| {
            let decode = |field: &str| BASE64.decode(kv[field].as_str().unwrap()).unwrap();
            (decode("key"), decode("value"))
        })
        .collect()
}

pub fn prod_account(name: &str) -> AccountId {
    if name == PROD_OWNER || name == PROD_CONTRACT {
        name.parse().unwrap()
    } else {
        format!("{name}.{PROD_OWNER}").parse().unwrap()
    }
}

/// Every AccountId of the snapshot (prefixes 04, 07, 16 and the account
/// keys of 0b, 10-13, 15), in the order of the production arguments.
pub fn prod_accounts() -> Vec<AccountId> {
    let mut out = vec![prod_account(PROD_OWNER)];
    for name in ["alice", "bob", "carl", "leo", "ravi", "sam", "uma"] {
        out.push(prod_account(name));
    }
    out
}

/// `migrate`'s production arguments.
pub struct MigrateArgs {
    pub accounts: Vec<AccountId>,
    pub pause: Option<Vec<PauseFlag>>,
    pub lending: LendingMigrateArgs,
    pub catalog: CatalogMigrateArgs,
}

pub fn prod_args() -> MigrateArgs {
    let meta = |event_id, source: &str, category| EventMetaArg {
        event_id,
        source: source.to_string(),
        category,
    };
    MigrateArgs {
        accounts: prod_accounts(),
        pause: None,
        lending: LendingMigrateArgs {
            frozen_scenarios: vec![1, 2, 3, 4],
        },
        catalog: CatalogMigrateArgs {
            listed: vec![5, 6],
            references: vec![(7, 6), (8, 5)],
            anchors: [5, 0, 0],
            event_meta: vec![
                meta(6, "FRED DFEDTARU and DFEDTARL", 2),
                meta(
                    7,
                    "deployments/demo-outcomes.json (team-controlled, demo)",
                    1,
                ),
                meta(8, "FRED DFEDTARU", 2),
                meta(9, "FRED DFEDTARU and DFEDTARL", 2),
            ],
            params: None,
        },
    }
}

thread_local! {
    static PROD_CHAIN: Box<dyn Fn(VMContext, Storage) -> MockedBlockchain> = {
        let config = near_sdk::test_vm_config();
        let fees = RuntimeFeesConfig::test();
        Box::new(move |context, storage| {
            MockedBlockchain::new(context, config.clone(), fees.clone(), vec![], storage, HashMap::new(), None)
        })
    };
}

/// Production's contract account in mocked storage.
pub struct Prod {
    pub storage: Storage,
    pub now_ns: u64,
    pub balance: NearToken,
    pub storage_usage: u64,
    /// Logs of the last successful call.
    pub logs: Vec<String>,
}

impl Prod {
    /// The snapshot, unmigrated.
    pub fn from_snapshot() -> Self {
        Self {
            storage: prod_snapshot(),
            now_ns: PROD_TIMESTAMP_NS,
            balance: NearToken::from_yoctonear(PROD_BALANCE_YOCTO),
            storage_usage: PROD_STORAGE_USAGE,
            logs: Vec::new(),
        }
    }

    pub fn now_sec(&self) -> u64 {
        self.now_ns / 1_000_000_000
    }

    fn install(&self, who: &AccountId, deposit: NearToken) {
        let context = VMContextBuilder::new()
            .current_account_id(PROD_CONTRACT.parse().unwrap())
            .signer_account_id(who.clone())
            .predecessor_account_id(who.clone())
            .attached_deposit(deposit)
            .block_timestamp(self.now_ns)
            .prepaid_gas(Gas::from_tgas(300))
            .account_balance(self.balance)
            .storage_usage(self.storage_usage)
            .build();
        let chain = PROD_CHAIN.with(|make| make(context, self.storage.clone()));
        env::set_blockchain_interface(chain);
    }

    /// Runs `f` as one receipt from `who` on the raw storage (no STATE is read
    /// or written for it). On a panic nothing changes and the contract's
    /// message comes back.
    pub fn raw_call<R>(
        &mut self,
        who: &AccountId,
        deposit: NearToken,
        f: impl FnOnce() -> R,
    ) -> Result<R, String> {
        self.install(who, deposit);
        let out = quietly(|| panic::catch_unwind(AssertUnwindSafe(f)));
        match out {
            Ok(r) => {
                self.logs = get_logs();
                self.storage_usage = env::storage_usage();
                self.storage = with_mocked_blockchain(|b| b.take_storage());
                Ok(r)
            }
            Err(payload) => Err(panic_message(payload)),
        }
    }

    /// `migrate(args)` from `who`, as the deploy transaction runs it.
    pub fn migrate(&mut self, who: &AccountId, args: MigrateArgs) -> Result<(), String> {
        self.raw_call(who, NearToken::from_yoctonear(0), move || {
            let c = Contract::migrate(args.accounts, args.pause, args.lending, args.catalog);
            env::state_write(&c);
        })
    }

    /// A call on the v2 state.
    pub fn call<R>(
        &mut self,
        who: &AccountId,
        deposit: NearToken,
        f: impl FnOnce(&mut Contract) -> R,
    ) -> Result<R, String> {
        self.raw_call(who, deposit, move || {
            let mut c: Contract = env::state_read().expect("v2 state");
            let r = f(&mut c);
            env::state_write(&c);
            r
        })
    }

    /// A read of the v2 state.
    pub fn view<R>(&mut self, f: impl FnOnce(&Contract) -> R) -> R {
        let viewer = prod_account("alice");
        self.install(&viewer, NearToken::from_yoctonear(0));
        let out = quietly(|| {
            panic::catch_unwind(AssertUnwindSafe(|| {
                let c: Contract = env::state_read().expect("v2 state");
                f(&c)
            }))
        });
        out.unwrap_or_else(|p| panic!("view failed: {}", panic_message(p)))
    }

    pub fn raw(&self, key: &[u8]) -> Option<&Vec<u8>> {
        self.storage.get(key)
    }

    /// The `data[0]` of every `multiverse` event of the last call with this name.
    pub fn data_of(&self, event: &str) -> Vec<Value> {
        self.logs
            .iter()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .map(|j| serde_json::from_str::<Value>(j).unwrap())
            .filter(|e| e["event"] == event)
            .map(|e| e["data"][0].clone())
            .collect()
    }
}

/// Production's state after `migrate` with the production arguments.
pub fn migrated_prod() -> Prod {
    let mut p = Prod::from_snapshot();
    p.migrate(&prod_account(PROD_CONTRACT), prod_args())
        .expect("migrate on production's state");
    p
}

// ---- The snapshot and the loader ----

#[test]
fn snapshot_decodes_as_the_v1_root() {
    let storage = prod_snapshot();
    assert_eq!(storage.len(), 301);
    let state = &storage[b"STATE".as_slice()];
    assert_eq!(state.len(), PROD_STATE_BYTES);
    // try_from_slice refuses trailing bytes: the mirror consumes all 402.
    let v1 = ContractV1::try_from_slice(state).unwrap();
    assert_eq!(v1.owner_id, prod_account(PROD_OWNER));
    assert_eq!(v1.event_count, 9);
    assert_eq!(v1.scenario_count, 6);
    assert_eq!(v1.pool_count, 29);
    assert_eq!(v1.order_count, 4);
    assert_eq!(v1.wnear.decimals, 24);
    assert_eq!(v1.usdc.decimals, 6);
    for (field, prefix, key) in v1.prefixes() {
        assert_eq!(prefix, key.into_storage_key().as_slice(), "{field}");
    }
    // Every key belongs to a v1 prefix (0-26) or is STATE.
    for key in storage.keys() {
        assert!(key.as_slice() == b"STATE" || key[0] <= 26, "{key:?}");
    }
}

/// The prefix bytes `migrate` may add keys under (SPEC-C 6.3, the
/// manifest's `migrate.new_prefixes`).
pub const MIGRATE_NEW_PREFIXES: [u8; 14] = [
    0x1b, 0x1c, 0x1d, 0x25, 0x26, 0x27, 0x29, 0x2a, 0x2b, 0x2e, 0x31, 0x32, 0x33, 0x34,
];

/// R1 (OPS part): every v1 key but STATE is byte-equal, none is deleted,
/// every added key is under a new prefix; OPS adds the VersionRecord and one
/// upgrade marker (value 2) per account of the dump.
#[test]
fn migrate_changes_only_state_and_adds_keys_under_new_prefixes() {
    let before = prod_snapshot();
    let p = migrated_prod();
    for (key, value) in &before {
        if key.as_slice() == b"STATE" {
            continue;
        }
        assert_eq!(p.raw(key), Some(value), "v1 key changed: {key:?}");
    }
    let added: Vec<&Vec<u8>> = p
        .storage
        .keys()
        .filter(|k| !before.contains_key(*k))
        .collect();
    for key in &added {
        assert!(MIGRATE_NEW_PREFIXES.contains(&key[0]), "{key:?}");
    }
    let under = |prefix: u8| added.iter().filter(|k| k[0] == prefix).count();
    assert_eq!(under(0x1b), 1);
    assert_eq!(under(0x1c), prod_accounts().len());
    let marker_prefix = StorageKey::AccountVersion.into_storage_key();
    for a in prod_accounts() {
        let mut key = marker_prefix.clone();
        key.extend(borsh::to_vec(&a).unwrap());
        assert_eq!(
            p.raw(&key),
            Some(&STATE_VERSION.to_le_bytes().to_vec()),
            "{a}"
        );
    }
    assert_eq!(
        p.raw(b"STATE").unwrap().len(),
        PROD_STATE_BYTES + V2_STATE_GROWTH
    );
}

#[test]
fn migrate_records_the_version_and_leaves_the_guardian_flags_paused() {
    let mut p = migrated_prod();
    let record = p
        .raw(&StorageKey::VersionRecord.into_storage_key())
        .unwrap();
    assert_eq!(
        VersionRecord::try_from_slice(record).unwrap(),
        VersionRecord {
            state_version: STATE_VERSION,
            code_version: CODE_VERSION.to_string(),
            upgraded_at_sec: p.now_sec(),
            upgraded_from: V1_CODE_VERSION.to_string(),
        }
    );
    let now = p.now_sec();
    let (flags, since, legacy, backfill) = p.view(|c| {
        (
            c.pause.paused(),
            c.pause.since_sec,
            c.legacy_scenario_count,
            c.legacy_backfill_open,
        )
    });
    assert_eq!(flags, PauseFlag::GUARDIAN.to_vec());
    assert_eq!((since, legacy, backfill), (now, 6, false));
    let upgraded = p.data_of("contract_upgraded");
    assert_eq!(upgraded.len(), 1, "one contract_upgraded line");
    let u = &upgraded[0];
    assert_eq!(u["from_state_version"], 1);
    assert_eq!(u["to_state_version"], 2);
    assert_eq!(u["from_code_version"], "1.0.0");
    assert_eq!(u["code_version"], CODE_VERSION);
    assert_eq!(u["accounts_upgraded"], 8);
    assert_eq!(
        (
            u["scenarios"].clone(),
            u["pools"].clone(),
            u["orders"].clone()
        ),
        (6.into(), 29.into(), 4.into())
    );
    assert_eq!(
        u["paused"],
        serde_json::json!([
            "trade",
            "mint",
            "transfer",
            "lend",
            "liquidate",
            "oracle",
            "pledge"
        ])
    );
    assert_eq!(u["legacy_scenario_count"], 6);
    assert!(u["lending"].is_object() && u["catalog"].is_object());
}

#[test]
fn migrate_keeps_every_v1_scalar() {
    let v1 = ContractV1::try_from_slice(&prod_snapshot()[b"STATE".as_slice()]).unwrap();
    let mut p = migrated_prod();
    let (owner, reporter, wnear, usdc, params) = p.view(|c| {
        (
            c.owner_id.clone(),
            c.reporter_id.clone(),
            c.wnear.clone(),
            c.usdc.clone(),
            c.params.clone(),
        )
    });
    assert_eq!(
        (owner, reporter, wnear, usdc),
        (v1.owner_id, v1.reporter_id, v1.wnear, v1.usdc)
    );
    assert_eq!(
        borsh::to_vec(&params).unwrap(),
        borsh::to_vec(&v1.params).unwrap()
    );
    let counts = p.view(|c| {
        (
            c.event_count,
            c.scenario_count,
            c.pool_count,
            c.order_count,
            c.spot_pool,
        )
    });
    assert_eq!(
        counts,
        (
            v1.event_count,
            v1.scenario_count,
            v1.pool_count,
            v1.order_count,
            v1.spot_pool
        )
    );
    // The v1 views read the same records through the re-created collections.
    let config = p.view(|c| c.get_app_config());
    assert_eq!((config.event_count, config.scenario_count), (9, 6));
    assert_eq!(p.view(|c| c.get_scenario(5)).event_ids, vec![7, 8]);
    let carl = prod_account("carl");
    assert!(p.view(|c| c.debt_of(1, carl).0) > 0);
}

#[test]
fn migrate_takes_the_pause_argument() {
    let mut p = Prod::from_snapshot();
    let mut args = prod_args();
    args.pause = Some(vec![PauseFlag::Exit, PauseFlag::Trade]);
    p.migrate(&prod_account(PROD_CONTRACT), args).unwrap();
    assert_eq!(
        p.view(|c| c.pause.paused()),
        vec![PauseFlag::Trade, PauseFlag::Exit]
    );
    let mut p = Prod::from_snapshot();
    let mut args = prod_args();
    args.pause = Some(vec![]);
    p.migrate(&prod_account(PROD_CONTRACT), args).unwrap();
    assert!(p.view(|c| c.pause.paused()).is_empty());
}

#[test]
fn migrate_twice_fails_wrong_state_version() {
    let mut p = migrated_prod();
    fails(
        p.migrate(&prod_account(PROD_CONTRACT), prod_args()),
        "WrongStateVersion(2, 1)",
    );
}

#[test]
fn migrate_by_anyone_but_the_contract_fails_init_not_self() {
    let mut p = Prod::from_snapshot();
    fails(
        p.migrate(&prod_account(PROD_OWNER), prod_args()),
        "InitNotSelf",
    );
    fails(
        p.migrate(&prod_account("alice"), prod_args()),
        "InitNotSelf",
    );
}

#[test]
fn migrate_without_state_fails_no_state() {
    let mut p = Prod::from_snapshot();
    p.storage.clear();
    fails(
        p.migrate(&prod_account(PROD_CONTRACT), prod_args()),
        "NoState",
    );
}

#[test]
fn migrate_refuses_a_moved_prefix_or_a_bad_record() {
    let mut v1 = ContractV1::try_from_slice(&prod_snapshot()[b"STATE".as_slice()]).unwrap();
    v1.markets = vec![99];
    let mut p = Prod::from_snapshot();
    p.storage
        .insert(b"STATE".to_vec(), borsh::to_vec(&v1).unwrap());
    fails(
        p.migrate(&prod_account(PROD_CONTRACT), prod_args()),
        "MigrateLayoutMismatch(markets)",
    );

    let mut p = Prod::from_snapshot();
    p.storage.get_mut(b"STATE".as_slice()).unwrap().push(0);
    fails(
        p.migrate(&prod_account(PROD_CONTRACT), prod_args()),
        "MigrateLayoutMismatch(STATE)",
    );

    let mut p = Prod::from_snapshot();
    p.storage
        .insert(StorageKey::VersionRecord.into_storage_key(), vec![2, 0]);
    fails(
        p.migrate(&prod_account(PROD_CONTRACT), prod_args()),
        "CorruptVersionRecord",
    );
}

#[test]
fn migrated_state_takes_v2_calls() {
    let mut p = migrated_prod();
    // A plain v1 view and a v2 key of the app config on the migrated state.
    let config = p.view(|c| c.get_app_config());
    assert_eq!(config.state_version, 2);
    assert_eq!(config.paused.len(), 7);
    // Never-paused owner tools still work while the guardian flags are set.
    let owner = prod_account(PROD_OWNER);
    p.call(&owner, NearToken::from_yoctonear(1), |c| {
        c.set_dispute_window(60)
    })
    .unwrap();
    assert_eq!(p.view(|c| c.dispute_window_sec()), 60);
    // A paused action fails its flag first.
    fails(
        p.call(&owner, NearToken::from_yoctonear(1), |c| {
            c.split(
                5,
                crate::types::Asset::Usdc,
                15,
                vec![1, 14],
                near_sdk::json_types::U128(1),
            )
        }),
        "Paused(mint)",
    );
}
