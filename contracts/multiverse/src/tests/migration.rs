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
    env, AccountId, Gas, IntoStorageKey, MockedBlockchain, NearToken, PromiseResult,
    RuntimeFeesConfig, VMContext,
};

use near_sdk::json_types::U128;

use super::harness::{fails, panic_message, quietly};
use crate::lending::{CollateralKey, LiquidationState};
use crate::migrate::v1::ContractV1;
use crate::migrate::{CatalogMigrateArgs, EventMetaArg, LendingMigrateArgs};
use crate::ops::PauseFlag;
use crate::storage::StorageAccount;
use crate::types::{Asset, VerseKey};
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
    static PROD_CHAIN: Box<dyn Fn(VMContext, Vec<PromiseResult>, Storage) -> MockedBlockchain> = {
        let config = near_sdk::test_vm_config();
        let fees = RuntimeFeesConfig::test();
        Box::new(move |context, results, storage| {
            MockedBlockchain::new(context, config.clone(), fees.clone(), results, storage, HashMap::new(), None)
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
        self.install_with(who, deposit, vec![]);
    }

    fn install_with(&self, who: &AccountId, deposit: NearToken, results: Vec<PromiseResult>) {
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
        let chain = PROD_CHAIN.with(|make| make(context, results, self.storage.clone()));
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
        self.raw_call_with(who, deposit, vec![], f)
    }

    /// `raw_call` with the results of the promises a callback reads.
    pub fn raw_call_with<R>(
        &mut self,
        who: &AccountId,
        deposit: NearToken,
        results: Vec<PromiseResult>,
        f: impl FnOnce() -> R,
    ) -> Result<R, String> {
        self.install_with(who, deposit, results);
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

    /// A callback on the v2 state, run by the contract with `results`.
    pub fn callback<R>(
        &mut self,
        results: Vec<PromiseResult>,
        f: impl FnOnce(&mut Contract) -> R,
    ) -> Result<R, String> {
        let contract = prod_account(PROD_CONTRACT);
        self.raw_call_with(
            &contract,
            NearToken::from_yoctonear(0),
            results,
            move || {
                let mut c: Contract = env::state_read().expect("v2 state");
                let r = f(&mut c);
                env::state_write(&c);
                r
            },
        )
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

    /// Every item of every `multiverse` event of the last call with this
    /// name: a line written by a `LogScope` groups all the items of its name.
    pub fn data_of(&self, event: &str) -> Vec<Value> {
        self.logs
            .iter()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .map(|j| serde_json::from_str::<Value>(j).unwrap())
            .filter(|e| e["event"] == event)
            .flat_map(|e| e["data"].as_array().cloned().unwrap_or_default())
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
    let record_key = StorageKey::VersionRecord.into_storage_key();
    assert!(added.contains(&&record_key), "the VersionRecord is new");
    for key in &added {
        assert!(MIGRATE_NEW_PREFIXES.contains(&key[0]), "{key:?}");
    }
    let under = |prefix: u8| added.iter().filter(|k| k[0] == prefix).count();
    assert_eq!(under(0x1b), 1);
    assert_eq!(under(0x1c), prod_accounts().len());
    // EW, step 7: one per-world supply vector per (legacy scenario, asset),
    // one created set per legacy scenario (tests/eight.rs checks the values)
    assert_eq!(under(0x2a), 12);
    assert_eq!(under(0x2b), 6);
    // PRC, step 8: one price config per legacy scenario (tests/prices.rs,
    // module `migration`, checks the values)
    assert_eq!(under(0x2e), 6);
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

// ---- The R-rules of OPS on production's state (SPEC-C 6.5) ----

/// The contract's token balances at block 277,535,363 (`ft_balance_of`,
/// `logs/prod-companions-b277535363.json`): wNEAR 24 decimals, USDC 6.
pub const PROD_WNEAR_RAW: u128 = 706_000_000_000_000_000_000_649_000_000;
pub const PROD_USDC_RAW: u128 = 12_846_845_361_198;

/// Every `(key, value)` of a v1 map in the raw storage, decoded.
fn raw_map<K: BorshDeserialize, V: BorshDeserialize>(
    storage: &Storage,
    key: StorageKey,
) -> Vec<(K, V)> {
    let prefix = key.into_storage_key();
    storage
        .iter()
        .filter(|(k, _)| k.starts_with(&prefix) && k.as_slice() != b"STATE")
        .map(|(k, v)| {
            (
                K::try_from_slice(&k[prefix.len()..]).unwrap(),
                V::try_from_slice(v).unwrap(),
            )
        })
        .collect()
}

/// The books' running totals enumerated from the raw storage: internal real
/// balances, real collateral pieces and NEP-145 deposits and used bytes of
/// every account.
fn raw_books(storage: &Storage) -> ([u128; 2], [u128; 2], u128, u64) {
    let mut internal = [0u128; 2];
    for ((_, asset), v) in raw_map::<(AccountId, Asset), u128>(storage, StorageKey::Real) {
        internal[asset as usize] += v;
    }
    let mut collateral = [0u128; 2];
    for (_, pieces) in
        raw_map::<(u64, AccountId), Vec<(CollateralKey, u128)>>(storage, StorageKey::Collateral)
    {
        let real = crate::books::real_amounts(&pieces);
        collateral[0] += real[0];
        collateral[1] += real[1];
    }
    let (mut deposit, mut used) = (0u128, 0u64);
    for (_, r) in raw_map::<AccountId, StorageAccount>(storage, StorageKey::Storage) {
        deposit += r.deposit.as_yoctonear();
        used += r.used_bytes;
    }
    (internal, collateral, deposit, used)
}

fn books_of(p: &mut Prod) -> crate::books::Books {
    p.view(|c| c.books.clone())
}

/// Whether the running totals equal their enumeration over every account.
fn books_match_raw(p: &mut Prod) -> Result<(), String> {
    let (internal, collateral, deposit, used) = raw_books(&p.storage);
    let b = books_of(p);
    let got = (
        b.internal,
        b.collateral,
        b.nep145_deposit,
        b.nep145_used_bytes,
    );
    if got == (internal, collateral, deposit, used) {
        Ok(())
    } else {
        Err(format!(
            "books {got:?} != raw {:?}",
            (internal, collateral, deposit, used)
        ))
    }
}

/// R3: the books pages sum to the token balances exactly (surplus 0), bucket
/// by bucket as measured on the snapshot; the running totals equal the raw
/// records; the NEAR books leave the contract's own funds non-negative.
#[test]
fn r3_books_equal_the_token_balances() {
    let mut p = migrated_prod();
    books_match_raw(&mut p).unwrap();
    let page = p.view(|c| c.books(None, None));
    assert_eq!((page.from_scenario, page.next_scenario), (1, None));
    // internal units: wNEAR raw / 1e6, USDC raw × 1e12
    assert_eq!(page.wnear.total.0 * 1_000_000, PROD_WNEAR_RAW);
    assert_eq!(page.usdc.total.0, PROD_USDC_RAW * 1_000_000_000_000);
    let wnear = [
        page.wnear.reserves.0,
        page.wnear.internal.0,
        page.wnear.collateral.0,
        page.wnear.spot_pool.0,
        page.wnear.lending_cash.0,
    ];
    assert_eq!(
        wnear,
        [
            605_000_000_000_000_000_000_649,
            452_709_837_542_801_824_273,
            547_290_162_621_796_721_603,
            99_999_999_999_835_401_454_124,
            0,
        ]
    );
    let usdc = [
        page.usdc.reserves.0,
        page.usdc.internal.0,
        page.usdc.collateral.0,
        page.usdc.spot_pool.0,
        page.usdc.lending_cash.0,
        page.usdc.insurance.0,
        page.usdc.pledges.0,
    ];
    assert_eq!(
        usdc,
        [
            12_143_968_693_472_680_569_999_219,
            2_952_735_441_215,
            0,
            303_769_329_999_499_999_899_999 + 1_504_513_240,
            399_107_337_722_865_190_146_327,
            0,
            0,
        ]
    );
    // the NEAR books: Σ NEP-145 available is the users'; the rest is the
    // contract's own
    let near = p.view(|c| c.near_books());
    assert_eq!(near.balance.0, PROD_BALANCE_YOCTO);
    assert_eq!(
        near.storage_stake.0,
        u128::from(p.storage_usage) * 10u128.pow(19)
    );
    let available: u128 = prod_accounts()
        .into_iter()
        .map(|a| p.view(|c| c.storage_balance_of(a).unwrap().available.0))
        .sum();
    assert_eq!(near.nep145_available.0, available);
    // 7.024 NEAR of the 17.6 belong to users
    assert_eq!(available / 10u128.pow(21), 7_024);
    let own_free = PROD_BALANCE_YOCTO as i128 - near.storage_stake.0 as i128 - available as i128;
    assert_eq!(near.own_free, own_free.to_string());
    assert!(own_free > 0);
    assert_eq!((near.near_held.0, near.storage_fund.0), (0, 0));
}

/// R5: the ledger reads every raw v1 record unchanged: verse balances,
/// supplies, internal real balances and reserves.
#[test]
fn r5_ledger_reads_every_v1_record() {
    let raw = prod_snapshot();
    let mut p = migrated_prod();
    let balances = raw_map::<(AccountId, VerseKey), u128>(&raw, StorageKey::Balances);
    assert_eq!(balances.len(), 43);
    for ((a, key), v) in balances {
        assert_eq!(p.view(|c| c.mt_balance_of(a.clone(), key.token_id())).0, v);
    }
    let supply = raw_map::<VerseKey, u128>(&raw, StorageKey::Supply);
    assert_eq!(supply.len(), 45);
    for (key, v) in supply {
        assert_eq!(p.view(|c| c.mt_supply(key.token_id())), Some(U128(v)));
    }
    for ((a, asset), v) in raw_map::<(AccountId, Asset), u128>(&raw, StorageKey::Real) {
        assert_eq!(p.view(|c| c.real_balance_of(a.clone(), asset)).0, v);
    }
    for ((sid, asset), v) in raw_map::<(u64, Asset), u128>(&raw, StorageKey::Reserves) {
        assert_eq!(p.view(|c| c.reserves_of(sid, asset)).0, v);
    }
}

/// R7: every `storage_balance_of` equals the raw v1 record.
#[test]
fn r7_storage_balances_equal_the_v1_records() {
    let raw = prod_snapshot();
    let mut p = migrated_prod();
    let records = raw_map::<AccountId, StorageAccount>(&raw, StorageKey::Storage);
    assert_eq!(records.len(), 8);
    for (a, r) in records {
        let b = p.view(|c| c.storage_balance_of(a.clone())).unwrap();
        let used = u128::from(r.used_bytes) * 10u128.pow(19);
        assert_eq!(b.total.0, r.deposit.as_yoctonear(), "{a}");
        assert_eq!(b.available.0, r.deposit.as_yoctonear() - used, "{a}");
    }
}

/// R9 and L-8: Carl's liquidation-side health factor is v1's formula on v1's
/// numbers: his worst-world collateral value C_min = 1,133.134240 USDC
/// (world 3; SPEC-C 3.6.5) times lltv 0.75 over his debt at the snapshot's
/// timestamp, 892.818832 USDC (5% a year since the last accrual), i.e.
/// 0.951873 (the 0.951870 of the design is the same loan about 40 minutes of
/// interest later, at the sandbox import). Every status reads `paused` where
/// v1 read anything but `none`, until the owner unpauses `liquidate` with no
/// grace: then Carl is `liquidatable`, as under v1.
#[test]
fn r9_health_unchanged_and_statuses_paused_until_liquidate_is_unpaused() {
    let mut p = migrated_prod();
    let carl = prod_account("carl");
    let values = p.view(|c| c.collateral_values(1, carl.clone())).values;
    let c_min = values[3].0;
    assert_eq!(c_min / 1_000_000_000_000, 1_133_134_240);
    let debt = p.view(|c| c.debt_of(1, carl.clone())).0;
    assert_eq!(debt / 1_000_000_000_000, 892_818_832);
    let hf = p
        .view(|c| c.health_factor(1, carl.clone()))
        .health_factor
        .unwrap()
        .0;
    let lltv = 750_000_000_000_000_000;
    assert_eq!(hf, multiverse_math::fixed::mul_div_down(c_min, lltv, debt));
    assert_eq!(hf / 1_000_000_000_000, 951_873);
    let statuses = |p: &mut Prod| {
        let mut out = Vec::new();
        for a in prod_accounts() {
            for sid in 1..=6u64 {
                let s = p.view(|c| c.liquidation_status(sid, a.clone()).status);
                if s != LiquidationState::None {
                    out.push((a.to_string(), sid, s));
                }
            }
        }
        out
    };
    let carl_name = carl.to_string();
    assert_eq!(
        statuses(&mut p),
        vec![(carl_name.clone(), 1, LiquidationState::Paused)]
    );
    let owner = prod_account(PROD_OWNER);
    p.call(&owner, NearToken::from_yoctonear(1), |c| {
        c.unpause(vec![PauseFlag::Liquidate], Some(0))
    })
    .unwrap();
    assert_eq!(
        statuses(&mut p),
        vec![(carl_name, 1, LiquidationState::Liquidatable)]
    );
    assert_eq!(
        p.view(|c| c.health_factor(1, carl.clone()))
            .health_factor
            .unwrap()
            .0,
        hf
    );
}

/// R10 (OPS part) and R11: the new OPS fields hold their 6.3 values and the
/// version view reads (2.0.0, 2, 2.0.0, from 1.0.0).
#[test]
fn r10_r11_ops_fields_and_contract_version() {
    let mut p = migrated_prod();
    let now = p.now_sec();
    let pause = p.view(|c| c.pause_state());
    assert_eq!(pause.paused, PauseFlag::GUARDIAN.to_vec());
    assert_eq!(
        (
            pause.since_sec,
            pause.liquidations_resume_at_sec,
            pause.guardian_id,
            pause.pending_owner_id
        ),
        (now, 0, None, None)
    );
    let v = serde_json::to_value(p.view(|c| c.contract_version())).unwrap();
    assert_eq!(
        v,
        serde_json::json!({"code_version": "2.0.0", "state_version": 2, "recorded_code_version": "2.0.0",
                           "upgraded_at_sec": now, "upgraded_from": "1.0.0", "event_version": "2.0.0",
                           "legacy_scenario_count": 6})
    );
    for a in prod_accounts() {
        assert_eq!(
            p.view(|c| c.account_version.get(&a).copied()),
            Some(STATE_VERSION)
        );
    }
}

/// R12 (app config): every v1 key of `get_app_config` is there with its v1
/// type.
#[test]
fn r12_app_config_keeps_every_v1_key() {
    let mut p = migrated_prod();
    let v = serde_json::to_value(p.view(|c| c.get_app_config())).unwrap();
    let strings = [
        "lltv",
        "liquidation_bonus",
        "borrow_rate_per_sec",
        "min_pool_depth",
    ];
    let numbers = [
        "dispute_window_sec",
        "twap_window_sec",
        "twap_min_age_sec",
        "fee_base_pips",
        "fee_cap_pips",
        "event_count",
        "scenario_count",
    ];
    for k in strings {
        assert!(v[k].is_string(), "{k}");
    }
    for k in numbers {
        assert!(v[k].is_u64(), "{k}");
    }
    for k in ["order_book", "root_lp"] {
        assert!(v[k].is_boolean(), "{k}");
    }
    for k in ["wnear", "usdc"] {
        assert!(
            v[k]["token_id"].is_string() && v[k]["decimals"].is_u64(),
            "{k}"
        );
    }
    assert!(v["owner_id"].is_string() && v["reporter_id"].is_string());
    assert!(v.get("spot_pool_id").is_some() && v.get("demo").is_some());
}

/// R13: `storage_unregister` is refused exactly for the accounts that hold
/// something under the v1 rule, read from the raw records (verse balances,
/// real balances of at least one token unit, pool positions, lending entries,
/// Root LP shares, open orders); the others may leave.
#[test]
fn r13_unregister_outcomes_follow_the_v1_holdings() {
    let raw = prod_snapshot();
    let mut holders = std::collections::BTreeSet::new();
    for ((a, _), v) in raw_map::<(AccountId, VerseKey), u128>(&raw, StorageKey::Balances) {
        if v > 0 {
            holders.insert(a);
        }
    }
    let unit = |asset: Asset| match asset {
        Asset::Wnear => 1,
        Asset::Usdc => 1_000_000_000_000,
    };
    for ((a, asset), v) in raw_map::<(AccountId, Asset), u128>(&raw, StorageKey::Real) {
        if v >= unit(asset) {
            holders.insert(a);
        }
    }
    for key in [
        StorageKey::Positions,
        StorageKey::SupplyShares,
        StorageKey::SupplyPrincipal,
        StorageKey::BorrowShares,
        StorageKey::LpShares,
    ] {
        let prefix = key.into_storage_key();
        for k in raw
            .keys()
            .filter(|k| k.starts_with(&prefix) && k.as_slice() != b"STATE")
        {
            let (_, a) = <(u64, AccountId)>::try_from_slice(&k[prefix.len()..]).unwrap();
            holders.insert(a);
        }
    }
    for (a, _) in
        raw_map::<(u64, AccountId), Vec<(CollateralKey, u128)>>(&raw, StorageKey::Collateral)
    {
        holders.insert(a.1);
    }
    for (a, r) in raw_map::<AccountId, StorageAccount>(&raw, StorageKey::Storage) {
        if r.open_orders > 0 {
            holders.insert(a);
        }
    }
    let mut p = migrated_prod();
    let mut left = Vec::new();
    for a in prod_accounts() {
        let out = p.call(&a, NearToken::from_yoctonear(1), |c| {
            c.storage_unregister(None)
        });
        if holders.contains(&a) {
            fails(out, &format!("AccountNotEmpty({a})"));
        } else {
            assert_eq!(out, Ok(true), "{a}");
            left.push(a.to_string());
            books_match_raw(&mut p).unwrap();
        }
    }
    // on production every account of the dump holds something
    assert_eq!(left, Vec::<String>::new());
    assert_eq!(holders.len(), prod_accounts().len());
}

/// R17: the guardian flags are set; a v1 empty-msg deposit, a repayment and
/// a withdrawal go through while paused; a stranger cannot pause.
#[test]
fn r17_never_paused_paths_work_on_the_migrated_state() {
    let mut p = migrated_prod();
    let (wnear, usdc) = p.view(|c| (c.wnear.token_id.clone(), c.usdc.token_id.clone()));
    let (alice, carl, leo) = (
        prod_account("alice"),
        prod_account("carl"),
        prod_account("leo"),
    );
    // a plain deposit of 1 USDC
    let a = alice.clone();
    let unused = p
        .call(&usdc, NearToken::from_yoctonear(0), |c| {
            c.ft_on_transfer(a, U128(1_000_000), String::new())
        })
        .unwrap();
    assert!(matches!(unused, near_sdk::PromiseOrValue::Value(U128(0))));
    assert_eq!(p.data_of("real_deposit").len(), 1);
    // Carl repays 1 USDC
    let debt = p.view(|c| c.debt_of(1, carl.clone())).0;
    let cc = carl.clone();
    p.call(&usdc, NearToken::from_yoctonear(0), |c| {
        c.ft_on_transfer(
            cc,
            U128(1_000_000),
            r#"{"action":"repay","scenario_id":1,"all":false}"#.into(),
        )
    })
    .unwrap();
    assert_eq!(p.data_of("repay").len(), 1);
    assert_eq!(
        p.view(|c| c.debt_of(1, carl.clone())).0,
        debt - 1_000_000_000_000_000_000
    );
    // Leo withdraws 1 wNEAR of his internal balance
    p.call(&leo, NearToken::from_yoctonear(1), |c| {
        c.withdraw(Asset::Wnear, U128(1_000_000_000_000_000_000))
    })
    .unwrap();
    assert_eq!(p.data_of("real_withdraw").len(), 1);
    // the tokens came in: the books moved with them
    books_match_raw(&mut p).unwrap();
    let _ = wnear;
    // a stranger cannot pause; the owner can, with no deposit
    fails(
        p.call(&alice, NearToken::from_yoctonear(0), |c| {
            c.pause(vec![PauseFlag::Exit], String::new())
        }),
        &format!("NotGuardian({alice})"),
    );
    let owner = prod_account(PROD_OWNER);
    p.call(&owner, NearToken::from_yoctonear(0), |c| {
        c.pause(vec![PauseFlag::Exit], "incident".into())
    })
    .unwrap();
    assert_eq!(p.view(|c| c.pause.paused()).len(), 8);
}

// ---- Step 6: the record checks ----

fn record_key(map: StorageKey, id: u64) -> Vec<u8> {
    let mut key = map.into_storage_key();
    key.extend(id.to_le_bytes());
    key
}

#[test]
fn migrate_refuses_a_missing_or_undecodable_record() {
    let cases = [
        (StorageKey::Events, 9, "event", "events"),
        (StorageKey::Scenarios, 1, "scenario", "scenarios"),
        (StorageKey::Pools, 7, "pool", "pools"),
        (StorageKey::Orders, 3, "order", "orders"),
    ];
    for (map, id, kind, field) in cases {
        let key = record_key(map, id);
        let mut p = Prod::from_snapshot();
        assert!(p.storage.remove(&key).is_some(), "{kind} {id} exists");
        fails(
            p.migrate(&prod_account(PROD_CONTRACT), prod_args()),
            &format!("MigrateMissingRecord({kind}, {id})"),
        );
        let mut p = Prod::from_snapshot();
        p.storage.get_mut(&key).unwrap().push(0);
        fails(
            p.migrate(&prod_account(PROD_CONTRACT), prod_args()),
            &format!("MigrateLayoutMismatch({field})"),
        );
    }
    // the 48 records of production all decode
    let p = migrated_prod();
    assert!(p.raw(&record_key(StorageKey::Pools, 29)).is_some());
    assert!(p.raw(&record_key(StorageKey::Pools, 30)).is_none());
}

// ---- post_upgrade and upgrade_accounts on the migrated state ----

#[test]
fn post_upgrade_on_the_migrated_state_rewrites_only_the_record() {
    let mut p = migrated_prod();
    let contract = prod_account(PROD_CONTRACT);
    fails(
        p.call(
            &prod_account(PROD_OWNER),
            NearToken::from_yoctonear(0),
            |c| c.post_upgrade(STATE_VERSION),
        ),
        "InitNotSelf",
    );
    fails(
        p.call(&contract, NearToken::from_yoctonear(0), |c| {
            c.post_upgrade(3)
        }),
        "WrongStateVersion(2, 3)",
    );
    let before = p.storage.clone();
    p.now_ns += 3_600 * 1_000_000_000;
    p.call(&contract, NearToken::from_yoctonear(0), |c| {
        c.post_upgrade(STATE_VERSION)
    })
    .unwrap();
    let record_key = StorageKey::VersionRecord.into_storage_key();
    let changed: Vec<&Vec<u8>> = p
        .storage
        .iter()
        .filter(|(k, v)| before.get(*k) != Some(*v))
        .map(|(k, _)| k)
        .collect();
    assert_eq!(changed, vec![&record_key], "only the VersionRecord changes");
    assert_eq!(p.storage.len(), before.len(), "no key added or deleted");
    assert_eq!(
        VersionRecord::try_from_slice(p.raw(&record_key).unwrap()).unwrap(),
        VersionRecord {
            state_version: STATE_VERSION,
            code_version: CODE_VERSION.to_string(),
            upgraded_at_sec: p.now_sec(),
            upgraded_from: CODE_VERSION.to_string(),
        }
    );
    let u = &p.data_of("contract_upgraded")[0];
    assert_eq!(
        (
            u["from_state_version"].clone(),
            u["to_state_version"].clone(),
            u["accounts_upgraded"].clone()
        ),
        (2.into(), 2.into(), 0.into())
    );
    assert!(u["lending"].is_null() && u["catalog"].is_null());
    assert_eq!(
        u["paused"].as_array().unwrap().len(),
        7,
        "it pauses nothing new"
    );
}

/// OPS-5: `upgrade_account` folds an account once: upgrading the dump's
/// accounts again changes nothing.
#[test]
fn upgrade_accounts_again_is_a_no_op() {
    let mut p = migrated_prod();
    let books = books_of(&mut p);
    let before = p.storage.clone();
    let bob = prod_account("bob");
    let n = p
        .call(&bob, NearToken::from_yoctonear(1), |c| {
            c.upgrade_accounts(prod_accounts())
        })
        .unwrap();
    assert_eq!(n, 0);
    assert_eq!(
        p.data_of("accounts_upgraded"),
        vec![serde_json::json!({"count": 0})]
    );
    assert_eq!(books_of(&mut p), books);
    assert_eq!(p.storage, before);
}

// ---- Stragglers: folded exactly once, whichever funnel touches them first ----

/// Production migrated without `left_out` in `accounts` (a straggler) and
/// with nothing paused, so every funnel can be reached.
fn straggler_prod(left_out: &str) -> Prod {
    let mut p = Prod::from_snapshot();
    let mut args = prod_args();
    let out = prod_account(left_out);
    args.accounts.retain(|a| a != &out);
    args.pause = Some(vec![]);
    p.migrate(&prod_account(PROD_CONTRACT), args).unwrap();
    assert_eq!(p.data_of("contract_upgraded")[0]["accounts_upgraded"], 7);
    p
}

/// A first touch through one funnel.
type Touch = fn(&mut Prod) -> Result<(), String>;

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

fn touches() -> Vec<(&'static str, &'static str, Touch)> {
    vec![
        ("leo", "upgrade_accounts", |p| {
            let n = p.call(&prod_account("bob"), ONE_YOCTO, |c| {
                c.upgrade_accounts(vec![prod_account("leo"), prod_account("leo")])
            })?;
            assert_eq!(n, 1);
            Ok(())
        }),
        ("leo", "set_real (withdraw)", |p| {
            p.call(&prod_account("leo"), ONE_YOCTO, |c| {
                c.withdraw(Asset::Wnear, U128(1_000_000_000_000_000_000))
            })
        }),
        ("leo", "set_real_in_callback (failed payout)", |p| {
            let ok = p.callback(vec![PromiseResult::Failed], |c| {
                c.on_payout(prod_account("leo"), Asset::Usdc, U128(5))
            })?;
            assert!(!ok);
            Ok(())
        }),
        ("leo", "NEP-145 top-up", |p| {
            p.call(&prod_account("leo"), NearToken::from_millinear(10), |c| {
                c.storage_deposit(None, None)
            })
            .map(|_| ())
        }),
        ("leo", "NEP-145 withdrawal", |p| {
            p.call(&prod_account("leo"), ONE_YOCTO, |c| {
                c.storage_withdraw(Some(U128(1)))
            })
            .map(|_| ())
        }),
        ("carl", "set_borrow_shares (repay from balance)", |p| {
            p.call(&prod_account("carl"), ONE_YOCTO, |c| {
                c.repay_from_balance(1, Some(U128(1)))
            })
            .map(|_| ())
        }),
        ("carl", "set_pieces (collateral from balance)", |p| {
            p.call(&prod_account("carl"), ONE_YOCTO, |c| {
                c.deposit_collateral(1, "usdc".to_string(), U128(1))
            })
        }),
        ("alice", "charge_storage (a transfer)", |p| {
            let token = p.view(|c| {
                let a = prod_account("alice");
                c.verse_keys()
                    .find(|k| c.verse_balance(&a, k) > 0)
                    .unwrap()
                    .token_id()
            });
            p.call(&prod_account("alice"), ONE_YOCTO, |c| {
                c.mt_transfer(prod_account("bob"), token, U128(1), None, None)
            })
        }),
    ]
}

#[test]
fn stragglers_are_folded_exactly_once_whichever_funnel_touches_them_first() {
    for (who, funnel, touch) in touches() {
        let mut p = straggler_prod(who);
        let a = prod_account(who);
        // before the touch the books miss exactly the straggler's v1 data
        let (internal, collateral, deposit, used) = raw_books(&p.storage);
        let mine = p.view(|c| {
            let real = [
                c.real_balance(&a, Asset::Wnear),
                c.real_balance(&a, Asset::Usdc),
            ];
            let pieces = crate::books::real_amounts(&c.pieces(1, &a));
            let record = c.storage.get(&a).cloned().unwrap();
            (real, pieces, record)
        });
        let b = books_of(&mut p);
        assert_eq!(
            (b.internal[0] + mine.0[0], b.internal[1] + mine.0[1]),
            (internal[0], internal[1]),
            "{funnel}"
        );
        assert_eq!(b.collateral[1] + mine.1[1], collateral[1], "{funnel}");
        assert_eq!(
            b.nep145_deposit + mine.2.deposit.as_yoctonear(),
            deposit,
            "{funnel}"
        );
        assert_eq!(b.nep145_used_bytes + mine.2.used_bytes, used, "{funnel}");
        assert_eq!(
            p.view(|c| c.account_version.get(&a).copied()),
            None,
            "{funnel}"
        );
        // the first touch folds
        touch(&mut p).unwrap_or_else(|e| panic!("{funnel}: {e}"));
        assert_eq!(
            p.view(|c| c.account_version.get(&a).copied()),
            Some(STATE_VERSION),
            "{funnel}"
        );
        books_match_raw(&mut p).unwrap_or_else(|e| panic!("{funnel}: {e}"));
        // any later touch finds the marker and counts nothing twice
        let n = p
            .call(&prod_account("bob"), NearToken::from_yoctonear(1), |c| {
                c.upgrade_accounts(vec![a.clone()])
            })
            .unwrap();
        assert_eq!(n, 0, "{funnel}");
        p.call(&a, NearToken::from_millinear(10), |c| {
            c.storage_deposit(None, None)
        })
        .unwrap();
        p.call(&a, NearToken::from_yoctonear(1), |c| {
            c.withdraw(Asset::Usdc, U128(1))
        })
        .ok();
        books_match_raw(&mut p).unwrap_or_else(|e| panic!("{funnel}, second touch: {e}"));
    }
}

/// A straggler's marker is paid by whoever's call folds it: the caller of
/// `upgrade_accounts`, or the straggler itself on its own calls.
#[test]
fn a_stragglers_marker_is_charged_to_the_folding_call() {
    let marker = |a: &AccountId| 40 + 1 + 4 + a.len() as u64 + 4;
    let leo = prod_account("leo");
    let bob = prod_account("bob");
    let used = |p: &mut Prod, a: &AccountId| p.view(|c| c.storage.get(a).unwrap().used_bytes);
    let mut p = straggler_prod("leo");
    let bob_used = used(&mut p, &bob);
    p.call(&bob, NearToken::from_yoctonear(1), |c| {
        c.upgrade_accounts(vec![leo.clone()])
    })
    .unwrap();
    assert_eq!(used(&mut p, &bob), bob_used + marker(&leo));
    let mut p = straggler_prod("leo");
    let leo_used = used(&mut p, &leo);
    p.call(&leo, NearToken::from_yoctonear(1), |c| {
        c.withdraw(Asset::Wnear, U128(1_000_000_000_000_000_000))
    })
    .unwrap();
    assert_eq!(used(&mut p, &leo), leo_used + marker(&leo));
}
