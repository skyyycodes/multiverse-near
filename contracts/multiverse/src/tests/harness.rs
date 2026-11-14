//! A small in-memory chain around the contract. Each call runs the way a
//! receipt does (read the state, run the method, write the state back); a
//! panic rolls storage back to where it was, like a failed receipt. Real
//! wNEAR/USDC live in a simulated pair of NEP-141 ledgers: `ft_transfer_call`
//! moves wallet balances into the contract, and the `ft_transfer` receipts a
//! call creates are carried out (or failed, for accounts not registered with
//! the token) together with their `on_payout` callbacks.
//!
//! The fixture: two events (SPICE, Fed), the 2x2 scenario and the binary
//! SPICE scenario, and funded users. USDC has
//! 6 decimals here, as on testnet, so every USDC path crosses the scaling.
//! wNEAR has 18 decimals in the default fixture, so most tests read raw and
//! internal wNEAR alike; `World::new_with_wnear_decimals(24)` is the testnet
//! token, for the tests of the 24-decimal boundary.

use std::any::Any;
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::panic::{self, AssertUnwindSafe};
use std::sync::Once;

use near_sdk::json_types::U128;
use near_sdk::mock::{with_mocked_blockchain, MockAction, Receipt};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{
    env, AccountId, Gas, MockedBlockchain, NearToken, PromiseOrValue, PromiseResult,
    RuntimeFeesConfig, VMContext,
};

use near_sdk::borsh::BorshDeserialize;
use near_sdk::IntoStorageKey;

use crate::types::{Asset, AssetCfg, VerseKey};
use crate::{Contract, StorageKey};

pub const CONTRACT: &str = "multiverse.near";
pub const OWNER: &str = "admin.near";
pub const REPORTER: &str = "resolver.near";
pub const WNEAR_TOKEN: &str = "wnear.near";
pub const USDC_TOKEN: &str = "usdc.near";
pub const ALICE: &str = "alice.near";
pub const BOB: &str = "bob.near";
pub const CAROL: &str = "carol.near";

pub const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
pub const E18: u128 = 1_000_000_000_000_000_000;
/// 0.001 in WAD: demo prices are a few USDC per NEAR.
pub const E15: u128 = 1_000_000_000_000_000;
/// What each user starts with, in internal units (1e36).
pub const FUND: u128 = 1_000_000_000_000_000_000 * E18;
pub const DISPUTE_WINDOW: u64 = 30;
/// Block time at the start of every test (2026-09-21).
pub const T0: u64 = 1_790_000_000;
pub const DAY: u64 = 86_400;

// 2x2 scenario: world = spice + 2·fed, spice 0 SHIPS / 1 DELAYED, fed 0 CUTS / 1 HOLDS.
pub const ROOT: u8 = 0xF;
pub const SHIPS: u8 = 0x5;
pub const DELAYED: u8 = 0xA;
pub const CUTS: u8 = 0x3;
pub const HOLDS: u8 = 0xC;
pub const SHIPS_CUTS: u8 = 0x1;
pub const DELAYED_CUTS: u8 = 0x2;
pub const SHIPS_HOLDS: u8 = 0x4;
pub const DELAYED_HOLDS: u8 = 0x8;
pub const L_SHAPE: u8 = 0xE;
pub const SINGLES: [u8; 4] = [SHIPS_CUTS, DELAYED_CUTS, SHIPS_HOLDS, DELAYED_HOLDS];

// 3-event scenario [spice, fed, third]: world = spice + 2·fed + 4·third.
pub const ROOT_8: u8 = 0xFF;
pub const SINGLES_8: [u8; 8] = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80];

// Binary scenario (SPICE only).
pub const BIN_ROOT: u8 = 0x3;
pub const BIN_SHIPS: u8 = 0x1;
pub const BIN_DELAYED: u8 = 0x2;

pub const OUT_SHIPS: u8 = 0;
pub const OUT_DELAYED: u8 = 1;
pub const OUT_CUTS: u8 = 0;
pub const OUT_HOLDS: u8 = 1;

pub const SPICE_QUESTION: &str = "Will SPICE ship on NEAR mainnet by Mar 31, 2027?";
pub const SPICE_RULE: &str =
    "SHIPS if SPICE, NEAR's separation of consensus and execution, is active on NEAR mainnet before 2027-04-01 00:00 UTC; otherwise DELAYED.";
pub const FED_QUESTION: &str = "Will the Fed cut at its December meeting?";
pub const FED_RULE: &str =
    "CUTS iff DFEDTARU after the Dec 8-9, 2026 FOMC meeting is lower than before it; otherwise HOLDS.";

pub fn acc(id: &str) -> AccountId {
    id.parse().unwrap()
}

pub fn token_id(scenario: u64, asset: Asset, mask: u8) -> String {
    VerseKey::new(scenario, asset, mask).token_id()
}

/// Internal units per raw unit in the default fixture (18-decimal wNEAR).
pub fn scale(asset: Asset) -> u128 {
    match asset {
        Asset::Wnear => 1,
        Asset::Usdc => 1_000_000_000_000,
    }
}

pub fn wnear_cfg() -> AssetCfg {
    wnear_cfg_with(18)
}

pub fn wnear_cfg_with(decimals: u8) -> AssetCfg {
    AssetCfg {
        token_id: acc(WNEAR_TOKEN),
        symbol: "wNEAR".into(),
        decimals,
    }
}

pub fn usdc_cfg() -> AssetCfg {
    AssetCfg {
        token_id: acc(USDC_TOKEN),
        symbol: "USDC".into(),
        decimals: 6,
    }
}

pub type Storage = HashMap<Vec<u8>, Vec<u8>>;
type ChainFactory = Box<dyn Fn(VMContext, Vec<PromiseResult>, Storage) -> MockedBlockchain>;

thread_local! {
    // Building the VM config parses every protocol version's parameters, so
    // do it once per thread.
    static CHAIN_FACTORY: ChainFactory = {
        let config = near_sdk::test_vm_config();
        let fees = RuntimeFeesConfig::test();
        Box::new(move |context, results, storage| {
            MockedBlockchain::new(context, config.clone(), fees.clone(), results, storage, HashMap::new(), None)
        })
    };
    static QUIET: Cell<bool> = const { Cell::new(false) };
}

static QUIET_HOOK: Once = Once::new();

/// Runs `f` with the panic hook muted on this thread: expected panics are the
/// normal way contract checks fail, and printing each one buries the output.
pub fn quietly<R>(f: impl FnOnce() -> R) -> R {
    QUIET_HOOK.call_once(|| {
        let default = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            if !QUIET.with(Cell::get) {
                default(info);
            }
        }));
    });
    QUIET.with(|q| q.set(true));
    let out = f();
    QUIET.with(|q| q.set(false));
    out
}

/// The contract's own message from a mocked-runtime panic. The mock unwraps
/// the VM error, so the payload reads
/// `... HostError(GuestPanic { panic_msg: "DeadVerse(3)" })`.
pub fn panic_message(payload: Box<dyn Any + Send>) -> String {
    let raw = if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else {
        "<non-string panic>".to_string()
    };
    const MARK: &str = "panic_msg: \"";
    match raw.find(MARK) {
        Some(i) => {
            let rest = &raw[i + MARK.len()..];
            let end = rest.rfind("\" })").unwrap_or(rest.len());
            rest[..end].replace("\\\"", "\"").replace("\\\\", "\\")
        }
        None => raw,
    }
}

/// A function call a receipt will make.
#[derive(Clone, Debug, PartialEq)]
pub struct ScheduledCall {
    pub receiver_id: AccountId,
    pub method: String,
    pub args: Value,
    pub deposit: u128,
    pub tgas: u64,
    /// Indices of the receipts it waits for (a `.then`).
    pub after: Vec<u64>,
}

/// Logs and receipts of one executed call.
#[derive(Clone, Debug, Default)]
pub struct Outcome {
    pub logs: Vec<String>,
    pub receipts: Vec<Receipt>,
}

impl Outcome {
    /// Every `EVENT_JSON` log, parsed.
    pub fn events(&self) -> Vec<Value> {
        self.logs
            .iter()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .map(|j| serde_json::from_str(j).expect("event JSON"))
            .collect()
    }

    /// `(standard, event)` of every event log, in order.
    pub fn event_names(&self) -> Vec<(String, String)> {
        self.events()
            .iter()
            .map(|e| {
                (
                    e["standard"].as_str().unwrap().to_string(),
                    e["event"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    }

    /// Every item of every event with this name, in order: a line written by
    /// a `LogScope` groups all the items of its name.
    pub fn data_of(&self, event: &str) -> Vec<Value> {
        self.events()
            .into_iter()
            .filter(|e| e["event"] == event)
            .flat_map(|e| e["data"].as_array().cloned().unwrap_or_default())
            .collect()
    }

    /// NEAR sent back by `Promise::transfer`, per receiver.
    pub fn near_transfers(&self) -> Vec<(AccountId, u128)> {
        let mut out = Vec::new();
        for r in &self.receipts {
            for a in &r.actions {
                if let MockAction::Transfer { deposit, .. } = a {
                    out.push((r.receiver_id.clone(), deposit.as_yoctonear()));
                }
            }
        }
        out
    }

    /// Every function call this call scheduled, in order.
    pub fn calls(&self) -> Vec<ScheduledCall> {
        let mut out = Vec::new();
        for r in &self.receipts {
            for a in &r.actions {
                if let MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    prepaid_gas,
                    ..
                } = a
                {
                    out.push(ScheduledCall {
                        receiver_id: r.receiver_id.clone(),
                        method: String::from_utf8(method_name.clone()).unwrap(),
                        args: serde_json::from_slice(args).unwrap_or(Value::Null),
                        deposit: attached_deposit.as_yoctonear(),
                        tgas: prepaid_gas.as_tgas(),
                        after: r.receipt_indices.clone(),
                    });
                }
            }
        }
        out
    }
}

pub struct World {
    pub now: u64,
    /// NEP-141 balances outside the contract, in token units.
    pub wallets: HashMap<(AccountId, Asset), u128>,
    /// What the contract holds on each token, in token units.
    pub contract_ft: HashMap<Asset, u128>,
    /// Accounts the tokens refuse to pay (not registered with the token).
    pub ft_unregistered: HashSet<AccountId>,
    /// Carry out payouts after each call. Tests of the receipts turn it off.
    pub auto_payouts: bool,
    /// Gas attached to each call, in Tgas.
    pub prepaid_tgas: u64,
    pub last: Outcome,
    pub callbacks: Vec<Outcome>,
    pub spice: u64,
    pub fed: u64,
    pub s2x2: u64,
    pub s_bin: u64,
    /// The configured wNEAR and USDC.
    pub cfg: [AssetCfg; 2],
    /// When set, every successful call's NEP-245 lines are replayed on it and
    /// the result checked against the ledger (`track_logs`, EW-5).
    pub replay: Option<Replay>,
}

/// The ledger an indexer rebuilds from NEP-245 lines alone: per (account,
/// token id) balances, the contract's custody included, and supplies.
/// Replaying a call's lines in log order must never take a balance below
/// zero and must land exactly on the contract's `balances` and `supply`.
#[derive(Clone, Debug, Default)]
pub struct Replay {
    pub balances: HashMap<(String, String), u128>,
    pub supply: HashMap<String, u128>,
    /// Successful calls replayed, and NEP-245 lines among them.
    pub calls: u64,
    pub lines: u64,
}

/// `(key, value)` of every entry of the map stored under `prefix`, decoded.
pub fn raw_entries<K: BorshDeserialize, V: BorshDeserialize>(
    storage: &Storage,
    prefix: &[u8],
) -> Vec<(K, V)> {
    storage
        .iter()
        .filter(|(k, _)| k.len() > prefix.len() && k.starts_with(prefix))
        .map(|(k, v)| {
            let key = K::try_from_slice(&k[prefix.len()..]).expect("stored key decodes");
            let value = V::try_from_slice(v).expect("stored value decodes");
            (key, value)
        })
        .collect()
}

/// The storage prefix of a collection of the contract.
pub fn prefix(key: StorageKey) -> Vec<u8> {
    key.into_storage_key()
}

impl Replay {
    /// The NEP-245 view of `storage` as it is: user balances, supplies, and
    /// the contract's custody (supply minus what accounts hold).
    pub fn from_storage(storage: &Storage, contract: &str) -> Self {
        let mut r = Replay::default();
        let (balances, supply) = Self::ledger(storage);
        let mut custody: HashMap<String, u128> = supply.clone();
        for ((account, token), amount) in balances {
            *custody.get_mut(&token).expect("a held token has supply") -= amount;
            r.balances.insert((account, token), amount);
        }
        for (token, amount) in custody {
            if amount > 0 {
                r.balances.insert((contract.to_string(), token), amount);
            }
        }
        r.supply = supply;
        r
    }

    /// Accounts' balances and supplies as stored (non-zero entries only).
    fn ledger(storage: &Storage) -> (HashMap<(String, String), u128>, HashMap<String, u128>) {
        let balances =
            raw_entries::<(AccountId, VerseKey), u128>(storage, &prefix(StorageKey::Balances))
                .into_iter()
                .filter(|(_, a)| *a > 0)
                .map(|((account, key), amount)| ((account.to_string(), key.token_id()), amount))
                .collect();
        let supply = raw_entries::<VerseKey, u128>(storage, &prefix(StorageKey::Supply))
            .into_iter()
            .filter(|(_, a)| *a > 0)
            .map(|(key, amount)| (key.token_id(), amount))
            .collect();
        (balances, supply)
    }

    fn credit(&mut self, account: &str, token: &str, amount: u128) {
        let b = self
            .balances
            .entry((account.to_string(), token.to_string()))
            .or_default();
        *b = b.checked_add(amount).expect("replayed balance overflows");
    }

    fn debit(
        &mut self,
        account: &str,
        token: &str,
        amount: u128,
        line: usize,
    ) -> Result<(), String> {
        let k = (account.to_string(), token.to_string());
        let held = self.balances.get(&k).copied().unwrap_or(0);
        if held < amount {
            return Err(format!(
                "line {line}: {account} would go below zero in {token} ({held} < {amount})"
            ));
        }
        if held == amount {
            self.balances.remove(&k);
        } else {
            self.balances.insert(k, held - amount);
        }
        Ok(())
    }

    /// Applies one call's logs, line by line, entry by entry.
    pub fn apply(&mut self, logs: &[String]) -> Result<(), String> {
        self.calls += 1;
        for (n, log) in logs.iter().enumerate() {
            let Some(json) = log.strip_prefix("EVENT_JSON:") else {
                continue;
            };
            let e: Value = serde_json::from_str(json).map_err(|err| format!("line {n}: {err}"))?;
            if e["standard"] != "nep245" {
                continue;
            }
            if e["version"] != "1.0.0" {
                return Err(format!("line {n}: NEP-245 version {}", e["version"]));
            }
            self.lines += 1;
            for item in e["data"].as_array().ok_or(format!("line {n}: no data"))? {
                let tokens = item["token_ids"].as_array().ok_or("token_ids")?;
                let amounts = item["amounts"].as_array().ok_or("amounts")?;
                if tokens.len() != amounts.len() {
                    return Err(format!("line {n}: token_ids and amounts differ in length"));
                }
                for (token, amount) in tokens.iter().zip(amounts) {
                    let token = token.as_str().ok_or("token id")?;
                    let amount: u128 = amount
                        .as_str()
                        .ok_or("amount")?
                        .parse()
                        .map_err(|_| "amount")?;
                    match e["event"].as_str() {
                        Some("mt_mint") => {
                            self.credit(
                                item["owner_id"].as_str().ok_or("owner_id")?,
                                token,
                                amount,
                            );
                            *self.supply.entry(token.to_string()).or_default() += amount;
                        }
                        Some("mt_burn") => {
                            self.debit(
                                item["owner_id"].as_str().ok_or("owner_id")?,
                                token,
                                amount,
                                n,
                            )?;
                            let s = self.supply.entry(token.to_string()).or_default();
                            *s = s
                                .checked_sub(amount)
                                .ok_or(format!("line {n}: supply of {token} below zero"))?;
                        }
                        Some("mt_transfer") => {
                            self.debit(
                                item["old_owner_id"].as_str().ok_or("old_owner_id")?,
                                token,
                                amount,
                                n,
                            )?;
                            self.credit(
                                item["new_owner_id"].as_str().ok_or("new_owner_id")?,
                                token,
                                amount,
                            );
                        }
                        other => return Err(format!("line {n}: unknown NEP-245 event {other:?}")),
                    }
                }
            }
        }
        self.supply.retain(|_, s| *s > 0);
        Ok(())
    }

    /// The replayed ledger equals the stored one: every account's balances
    /// and every supply. The contract's custody then equals what its modules
    /// hold, since supply is what every owner holds.
    pub fn verify(&self, storage: &Storage, contract: &str) -> Result<(), String> {
        let (balances, supply) = Self::ledger(storage);
        let replayed: HashMap<(String, String), u128> = self
            .balances
            .iter()
            .filter(|((a, _), amount)| a != contract && **amount > 0)
            .map(|(k, v)| (k.clone(), *v))
            .collect();
        if replayed != balances {
            let diff: Vec<_> = balances
                .keys()
                .chain(replayed.keys())
                .filter(|k| balances.get(*k) != replayed.get(*k))
                .map(|k| {
                    (
                        k.clone(),
                        balances.get(k).copied(),
                        replayed.get(k).copied(),
                    )
                })
                .take(5)
                .collect();
            return Err(format!("balances differ (stored, replayed): {diff:?}"));
        }
        if self.supply != supply {
            return Err("supplies differ from the replay".to_string());
        }
        Ok(())
    }
}

/// What each user starts with when wNEAR has more than 18 decimals: 1e31
/// internal units (1e37 raw at 24 decimals), so that every raw balance and
/// their sum still fit a `u128`.
pub const FUND_ABOVE_18: u128 = 10_000_000_000_000 * E18;

impl World {
    /// Contract, tokens and accounts, with no events yet, under the v1
    /// profile (`tests/profile.rs`).
    pub fn bare() -> Self {
        Self::bare_with_wnear_decimals(18)
    }

    /// `bare` on the production defaults, without the v1 profile.
    pub fn bare_v2() -> Self {
        Self::build(18, false)
    }

    /// `bare` with a wNEAR of `decimals` decimals.
    pub fn bare_with_wnear_decimals(decimals: u8) -> Self {
        Self::build(decimals, true)
    }

    fn build(decimals: u8, v1_profile: bool) -> Self {
        let mut w = World {
            now: T0,
            wallets: HashMap::new(),
            contract_ft: HashMap::new(),
            ft_unregistered: HashSet::new(),
            auto_payouts: true,
            prepaid_tgas: 300,
            last: Outcome::default(),
            callbacks: Vec::new(),
            spice: 0,
            fed: 0,
            s2x2: 0,
            s_bin: 0,
            cfg: [wnear_cfg_with(decimals), usdc_cfg()],
            replay: None,
        };
        w.install(&acc(CONTRACT), NO_DEPOSIT, vec![], Storage::new());
        quietly(|| {
            let c = Contract::new(
                acc(OWNER),
                Some(acc(REPORTER)),
                wnear_cfg_with(decimals),
                usdc_cfg(),
                DISPUTE_WINDOW,
            );
            env::state_write(&c);
        });
        for who in [OWNER, ALICE, BOB, CAROL] {
            w.register(who, NearToken::from_near(1));
        }
        for who in [ALICE, BOB] {
            w.fund(who);
        }
        if v1_profile {
            super::profile::v1_lending_profile(&mut w);
            super::profile::v1_price_profile(&mut w);
        }
        w
    }

    /// The base fixture: events spice = 1 and fed = 2, scenarios 2x2 = 1
    /// and binary = 2, under the v1 profile.
    pub fn new() -> Self {
        Self::new_with_wnear_decimals(18)
    }

    /// The base fixture on the production defaults, without the v1 profile.
    pub fn new_v2() -> Self {
        let w = Self::bare_v2();
        w.with_base_fixture()
    }

    /// `new` with a wNEAR of `decimals` decimals.
    pub fn new_with_wnear_decimals(decimals: u8) -> Self {
        Self::bare_with_wnear_decimals(decimals).with_base_fixture()
    }

    fn with_base_fixture(mut self) -> Self {
        let w = &mut self;
        w.spice = w
            .create_event(
                SPICE_QUESTION,
                &["SHIPS", "DELAYED"],
                SPICE_RULE,
                T0 + 60 * DAY,
            )
            .unwrap();
        w.fed = w
            .create_event(FED_QUESTION, &["CUTS", "HOLDS"], FED_RULE, T0 + 40 * DAY)
            .unwrap();
        w.s2x2 = w.create_scenario(&[w.spice, w.fed]).unwrap();
        w.s_bin = w.create_scenario(&[w.spice]).unwrap();
        self
    }

    fn context(&self, predecessor: &AccountId, deposit: NearToken) -> VMContext {
        VMContextBuilder::new()
            .current_account_id(acc(CONTRACT))
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor.clone())
            .attached_deposit(deposit)
            .block_timestamp(self.now * 1_000_000_000)
            .block_height(self.now)
            .prepaid_gas(Gas::from_tgas(self.prepaid_tgas))
            .account_balance(NearToken::from_near(10_000))
            .build()
    }

    fn install(
        &self,
        predecessor: &AccountId,
        deposit: NearToken,
        results: Vec<PromiseResult>,
        storage: Storage,
    ) {
        let context = self.context(predecessor, deposit);
        let chain = CHAIN_FACTORY.with(|make| make(context, results, storage));
        env::set_blockchain_interface(chain);
    }

    /// Runs `f` as one receipt from `who`. On a panic, storage goes back to
    /// what it was and the contract's message comes back as the error.
    pub fn exec<R>(
        &mut self,
        who: &str,
        deposit: NearToken,
        results: Vec<PromiseResult>,
        f: impl FnOnce(&mut Contract) -> R,
    ) -> Result<R, String> {
        let who = acc(who);
        let snapshot: Storage = with_mocked_blockchain(|b| b.take_storage());
        self.install(&who, deposit, results, snapshot.clone());
        let out = quietly(|| {
            panic::catch_unwind(AssertUnwindSafe(|| {
                let mut contract: Contract = env::state_read().expect("contract state");
                let r = f(&mut contract);
                env::state_write(&contract);
                r
            }))
        });
        match out {
            Ok(r) => {
                self.last = Outcome {
                    logs: get_logs(),
                    receipts: get_created_receipts(),
                };
                self.check_replay();
                Ok(r)
            }
            Err(payload) => {
                self.install(&who, NO_DEPOSIT, vec![], snapshot);
                self.last = Outcome::default();
                Err(panic_message(payload))
            }
        }
    }

    /// Runs `f` on the raw key-value storage as it stands.
    pub fn with_raw<R>(&mut self, f: impl FnOnce(&Storage) -> R) -> R {
        let storage: Storage = with_mocked_blockchain(|b| b.take_storage());
        let r = f(&storage);
        self.install(&acc(ALICE), NO_DEPOSIT, vec![], storage);
        r
    }

    /// From now on every successful call (callbacks included) replays its
    /// NEP-245 lines on a shadow ledger started from the current state, and
    /// the shadow must equal the stored ledger after it (EW-5).
    pub fn track_logs(&mut self) {
        let replay = self.with_raw(|s| Replay::from_storage(s, CONTRACT));
        self.replay = Some(replay);
    }

    /// The replay of the last call; panics on a negative balance or a
    /// ledger the lines do not reproduce.
    fn check_replay(&mut self) {
        let Some(mut replay) = self.replay.take() else {
            return;
        };
        let logs = self.last.logs.clone();
        if let Err(e) = replay.apply(&logs) {
            panic!("NEP-245 replay: {e}\nlogs: {logs:#?}");
        }
        let checked = self.with_raw(|s| replay.verify(s, CONTRACT));
        if let Err(e) = checked {
            panic!("NEP-245 replay: {e}\nlogs: {logs:#?}");
        }
        self.replay = Some(replay);
    }

    /// A state-changing call; payouts it schedules run right after it.
    pub fn call<R>(
        &mut self,
        who: &str,
        deposit: NearToken,
        f: impl FnOnce(&mut Contract) -> R,
    ) -> Result<R, String> {
        self.callbacks.clear();
        let r = self.exec(who, deposit, vec![], f)?;
        if self.auto_payouts {
            self.run_payouts();
        }
        Ok(r)
    }

    /// Read-only access to the current state.
    pub fn view<R>(&mut self, f: impl FnOnce(&Contract) -> R) -> R {
        let storage: Storage = with_mocked_blockchain(|b| b.take_storage());
        self.install(&acc(ALICE), NO_DEPOSIT, vec![], storage);
        let out = quietly(|| {
            panic::catch_unwind(AssertUnwindSafe(|| {
                let contract: Contract = env::state_read().expect("contract state");
                f(&contract)
            }))
        });
        out.unwrap_or_else(|p| panic!("view failed: {}", panic_message(p)))
    }

    /// Like `view`, for views expected to fail.
    pub fn try_view<R>(&mut self, f: impl FnOnce(&Contract) -> R) -> Result<R, String> {
        let storage: Storage = with_mocked_blockchain(|b| b.take_storage());
        self.install(&acc(ALICE), NO_DEPOSIT, vec![], storage);
        quietly(|| {
            panic::catch_unwind(AssertUnwindSafe(|| {
                let contract: Contract = env::state_read().expect("contract state");
                f(&contract)
            }))
        })
        .map_err(panic_message)
    }

    /// Carries out the `ft_transfer` + `on_payout` pairs the last call
    /// scheduled, in order, as the token contracts would.
    pub fn run_payouts(&mut self) {
        let main = self.last.clone();
        for callback in &main.receipts {
            let Some((args, _)) = function_call(callback, "on_payout") else {
                continue;
            };
            // `receipt_indices` name promise indices, which the mock does not
            // number by position in the receipt list
            let waits_for = callback.receipt_indices[0];
            let transfer = main
                .receipts
                .iter()
                .find(|r| {
                    r.actions
                        .iter()
                        .any(|a| a.receipt_index() == Some(waits_for))
                })
                .expect("the receipt an on_payout waits for");
            let (ft_args, deposit) =
                function_call(transfer, "ft_transfer").expect("payout without ft_transfer");
            assert_eq!(deposit, 1, "ft_transfer must attach 1 yoctoNEAR");
            let asset = self.asset_of_token(&transfer.receiver_id);
            let receiver = acc(ft_args["receiver_id"].as_str().unwrap());
            let amount: u128 = ft_args["amount"].as_str().unwrap().parse().unwrap();
            assert_eq!(args["account_id"].as_str().unwrap(), receiver.as_str());
            assert_eq!(args["amount"].as_str().unwrap(), amount.to_string());
            let ok = !self.ft_unregistered.contains(&receiver);
            if ok {
                let held = self.contract_ft.entry(asset).or_default();
                *held = held
                    .checked_sub(amount)
                    .expect("the contract paid out tokens it does not hold");
                *self.wallets.entry((receiver.clone(), asset)).or_default() += amount;
            }
            let result = if ok {
                PromiseResult::Successful(vec![])
            } else {
                PromiseResult::Failed
            };
            self.exec(CONTRACT, NO_DEPOSIT, vec![result], |c| {
                c.on_payout(receiver, asset, U128(amount))
            })
            .expect("on_payout must never panic");
            self.callbacks.push(self.last.clone());
        }
        self.last = main;
    }

    fn asset_of_token(&self, token: &AccountId) -> Asset {
        match token.as_str() {
            WNEAR_TOKEN => Asset::Wnear,
            USDC_TOKEN => Asset::Usdc,
            other => panic!("not a token: {other}"),
        }
    }

    // Users

    pub fn register(&mut self, who: &str, deposit: NearToken) {
        let id = acc(who);
        self.call(who, deposit, |c| c.storage_deposit(Some(id), None))
            .unwrap();
    }

    fn asset_cfg(&self, asset: Asset) -> &AssetCfg {
        &self.cfg[asset as usize]
    }

    /// Raw token units of `internal`, which must convert exactly.
    pub fn to_raw(&self, asset: Asset, internal: u128) -> u128 {
        let (raw, dust) = self.asset_cfg(asset).to_raw(internal).expect("raw fits");
        assert_eq!(dust, 0, "test setup: {internal} is not whole {asset} units");
        raw
    }

    /// Internal units of `raw` token units, rounded down.
    pub fn to_internal(&self, asset: Asset, raw: u128) -> u128 {
        self.asset_cfg(asset)
            .to_internal(raw)
            .expect("internal fits")
            .0
    }

    /// The smallest internal amount that is a whole number of raw units.
    pub fn unit(&self, asset: Asset) -> u128 {
        self.asset_cfg(asset).min_payable()
    }

    /// What a funded user starts with, in internal units.
    pub fn fund_amount(&self, asset: Asset) -> u128 {
        if self.asset_cfg(asset).decimals > 18 {
            FUND_ABOVE_18
        } else {
            FUND
        }
    }

    pub fn fund(&mut self, who: &str) {
        for asset in Asset::ALL {
            let raw = self.to_raw(asset, self.fund_amount(asset));
            *self.wallets.entry((acc(who), asset)).or_default() += raw;
        }
    }

    /// Wallet balance in internal units, rounded down.
    pub fn wallet(&self, who: &str, asset: Asset) -> u128 {
        let raw = self.wallets.get(&(acc(who), asset)).copied().unwrap_or(0);
        self.to_internal(asset, raw)
    }

    /// The contract's holding of the token, in internal units, rounded down.
    pub fn held_by_contract(&self, asset: Asset) -> u128 {
        let raw = self.contract_ft.get(&asset).copied().unwrap_or(0);
        self.to_internal(asset, raw)
    }

    /// The contract's holding of the token, in raw units.
    pub fn held_raw(&self, asset: Asset) -> u128 {
        self.contract_ft.get(&asset).copied().unwrap_or(0)
    }

    /// Wallet balance in raw units.
    pub fn wallet_raw(&self, who: &str, asset: Asset) -> u128 {
        self.wallets.get(&(acc(who), asset)).copied().unwrap_or(0)
    }

    /// `ft_transfer_call` from `sender`'s wallet as the token contract runs
    /// it: on success the used part moves to the contract; on a panic the
    /// whole amount stays in the wallet. Returns the unused token units.
    pub fn ft_transfer_call(
        &mut self,
        sender: &str,
        asset: Asset,
        token_amount: u128,
        msg: &str,
    ) -> Result<u128, String> {
        let wallet = self
            .wallets
            .get(&(acc(sender), asset))
            .copied()
            .unwrap_or(0);
        assert!(
            wallet >= token_amount,
            "test setup: {sender} holds {wallet} < {token_amount}"
        );
        let token = match asset {
            Asset::Wnear => WNEAR_TOKEN,
            Asset::Usdc => USDC_TOKEN,
        };
        let sender_id = acc(sender);
        let msg = msg.to_string();
        let unused = self.call(token, NO_DEPOSIT, |c| {
            c.ft_on_transfer(sender_id, U128(token_amount), msg)
        })?;
        let unused = match unused {
            PromiseOrValue::Value(v) => v.0,
            PromiseOrValue::Promise(_) => panic!("ft_on_transfer returned a promise"),
        };
        assert!(
            unused <= token_amount,
            "ft_on_transfer returned more than it got"
        );
        let used = token_amount - unused;
        *self.wallets.get_mut(&(acc(sender), asset)).unwrap() -= used;
        *self.contract_ft.entry(asset).or_default() += used;
        Ok(unused)
    }

    pub fn deposit(&mut self, who: &str, asset: Asset, internal: u128) -> Result<(), String> {
        let unused = self.ft_transfer_call(who, asset, self.to_raw(asset, internal), "")?;
        assert_eq!(unused, 0);
        Ok(())
    }

    /// Root split paid straight from the wallet (`ft_transfer_call` with the
    /// `split` action).
    pub fn split_ft(
        &mut self,
        who: &str,
        sid: u64,
        asset: Asset,
        to_masks: &[u8],
        internal: u128,
    ) -> Result<(), String> {
        let msg = json!({"action": "split", "scenario_id": sid, "to_masks": to_masks}).to_string();
        let unused = self.ft_transfer_call(who, asset, self.to_raw(asset, internal), &msg)?;
        assert_eq!(unused, 0);
        Ok(())
    }

    pub fn split(
        &mut self,
        who: &str,
        sid: u64,
        asset: Asset,
        from: u8,
        to: &[u8],
        amount: u128,
    ) -> Result<(), String> {
        let to = to.to_vec();
        self.call(who, ONE_YOCTO, |c| {
            c.split(sid, asset, from, to, U128(amount))
        })
    }

    pub fn merge(
        &mut self,
        who: &str,
        sid: u64,
        asset: Asset,
        from: &[u8],
        to: u8,
        amount: u128,
    ) -> Result<(), String> {
        let from = from.to_vec();
        self.call(who, ONE_YOCTO, |c| {
            c.merge(sid, asset, from, to, U128(amount))
        })
    }

    pub fn redeem(
        &mut self,
        who: &str,
        sid: u64,
        asset: Asset,
        mask: u8,
        amount: u128,
    ) -> Result<(), String> {
        self.call(who, ONE_YOCTO, |c| c.redeem(sid, asset, mask, U128(amount)))
    }

    pub fn withdraw(&mut self, who: &str, asset: Asset, amount: u128) -> Result<(), String> {
        self.call(who, ONE_YOCTO, |c| c.withdraw(asset, U128(amount)))
    }

    pub fn mt_transfer(
        &mut self,
        from: &str,
        to: &str,
        token: &str,
        amount: u128,
    ) -> Result<(), String> {
        let (to, token) = (acc(to), token.to_string());
        self.call(from, ONE_YOCTO, |c| {
            c.mt_transfer(to, token, U128(amount), None, None)
        })
    }

    pub fn mt_batch_transfer(
        &mut self,
        from: &str,
        to: &str,
        tokens: &[String],
        amounts: &[u128],
    ) -> Result<(), String> {
        let (to, tokens) = (acc(to), tokens.to_vec());
        let amounts = amounts.iter().map(|a| U128(*a)).collect();
        self.call(from, ONE_YOCTO, |c| {
            c.mt_batch_transfer(to, tokens, amounts, None, None)
        })
    }

    // Oracle

    pub fn create_event(
        &mut self,
        question: &str,
        names: &[&str],
        rule: &str,
        deadline: u64,
    ) -> Result<u64, String> {
        let names = names.iter().map(|n| n.to_string()).collect();
        let (q, r) = (question.to_string(), rule.to_string());
        self.call(OWNER, NearToken::from_millinear(100), |c| {
            c.create_event(q, names, r, deadline)
        })
    }

    pub fn create_scenario(&mut self, events: &[u64]) -> Result<u64, String> {
        let events = events.to_vec();
        self.call(OWNER, NearToken::from_millinear(100), |c| {
            c.create_scenario(events)
        })
    }

    pub fn admin_resolve(&mut self, event: u64, outcome: u8) -> Result<(), String> {
        self.call(OWNER, ONE_YOCTO, |c| c.admin_resolve(event, outcome))
    }

    /// The reporter's proposal.
    pub fn report(&mut self, event: u64, outcome: u8) -> Result<(), String> {
        self.call(REPORTER, NO_DEPOSIT, |c| {
            c.report_outcome(event, outcome, acc(CONTRACT), String::new())
        })
    }

    pub fn dispute(&mut self, event: u64) -> Result<(), String> {
        self.call(OWNER, ONE_YOCTO, |c| c.dispute(event))
    }

    pub fn finalize(&mut self, who: &str, event: u64) -> Result<(), String> {
        self.call(who, NO_DEPOSIT, |c| c.finalize(event))
    }

    pub fn warp(&mut self, seconds: u64) {
        self.now += seconds;
    }

    // Reads

    pub fn bal(&mut self, who: &str, sid: u64, asset: Asset, mask: u8) -> u128 {
        let key = VerseKey::new(sid, asset, mask);
        let who = acc(who);
        self.view(|c| c.verse_balance(&who, &key))
    }

    pub fn supply(&mut self, sid: u64, asset: Asset, mask: u8) -> u128 {
        let key = VerseKey::new(sid, asset, mask);
        self.view(|c| c.verse_supply(&key))
    }

    pub fn created(&mut self, sid: u64, asset: Asset, mask: u8) -> bool {
        let key = VerseKey::new(sid, asset, mask);
        self.view(|c| c.is_created(&key))
    }

    pub fn reserves(&mut self, sid: u64, asset: Asset) -> u128 {
        self.view(|c| c.reserves_of(sid, asset).0)
    }

    pub fn possible(&mut self, sid: u64) -> u8 {
        self.view(|c| c.get_scenario(sid).possible)
    }

    pub fn real(&mut self, who: &str, asset: Asset) -> u128 {
        let who = acc(who);
        self.view(|c| c.real_balance(&who, asset))
    }

    pub fn storage_used(&mut self, who: &str) -> u64 {
        let who = acc(who);
        self.view(|c| c.storage.get(&who).map_or(0, |a| a.used_bytes))
    }

    /// For every verse key: supply == what `accounts` hold + what modules
    /// hold. Only accounts in the list are counted, so pass all holders.
    /// Every scenario's per-world counters (`world_supply`) equal the full
    /// scan of `backing` too.
    pub fn assert_conservation(&mut self, accounts: &[&str]) {
        let accounts: Vec<AccountId> = accounts.iter().map(|a| acc(a)).collect();
        self.view(|c| {
            for sid in 1..=c.scenario_count {
                let (ws, b) = (c.world_supply(sid), c.backing(sid));
                let scan: Vec<(U128, U128)> = b
                    .worlds
                    .iter()
                    .map(|x| (x.wnear_supply, x.usdc_supply))
                    .collect();
                let counters: Vec<(U128, U128)> = ws
                    .wnear
                    .iter()
                    .copied()
                    .zip(ws.usdc.iter().copied())
                    .collect();
                assert_eq!(counters, scan, "world_supply of scenario {sid}");
            }
            for key in c.verse_keys() {
                let held: u128 = accounts
                    .iter()
                    .map(|a| c.verse_balance(a, &key))
                    .sum::<u128>()
                    + c.pool_holdings(&key)
                    + c.escrow_holdings(&key)
                    + c.collateral_holdings(&key)
                    + c.vault_holdings(&key);
                assert_eq!(
                    c.verse_supply(&key),
                    held,
                    "conservation broken for {}",
                    key.token_id()
                );
            }
        });
    }
}

/// Args and deposit of `method` if `receipt` calls it.
fn function_call(receipt: &Receipt, method: &str) -> Option<(Value, u128)> {
    receipt.actions.iter().find_map(|a| match a {
        MockAction::FunctionCallWeight {
            method_name,
            args,
            attached_deposit,
            ..
        } if method_name.as_slice() == method.as_bytes() => Some((
            serde_json::from_slice(args).unwrap_or(Value::Null),
            attached_deposit.as_yoctonear(),
        )),
        _ => None,
    })
}

/// `assert_eq!(err, expected)` for calls that must fail with exactly this message.
#[track_caller]
pub fn fails<R>(result: Result<R, String>, expected: &str) {
    match result {
        Ok(_) => panic!("expected `{expected}`, but the call succeeded"),
        Err(e) => assert_eq!(e, expected),
    }
}

/// The next seed for random partitions; any decent mixer will do (splitmix64).
pub fn next_seed(seed: u64) -> u64 {
    let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// `PartitionLib.random`: a valid partition of `parent` (parts pairwise
/// disjoint, each a live strict subset, together covering `parent &
/// possible`, dead worlds sometimes attached), or empty if there is none.
/// Any world count up to 8; a seed draws the same partition of a 2- or
/// 4-world parent as before.
pub fn random_partition(parent: u8, possible: u8, mut seed: u64) -> Vec<u8> {
    let live = parent & possible;
    let dead = parent & !possible;
    if live == 0 {
        return Vec::new();
    }
    let mut groups = [0u8; 8];
    let mut count = 0usize;
    for w in 0..8 {
        if (live >> w) & 1 == 0 {
            continue;
        }
        // an existing group or a new one
        let g = (seed % (count as u64 + 1)) as usize;
        seed = next_seed(seed);
        if g == count {
            count += 1;
        }
        groups[g] |= 1 << w;
    }
    for w in 0..8 {
        if (dead >> w) & 1 == 0 {
            continue;
        }
        // attach to a group, or (g == count) leave it out
        let g = (seed % (count as u64 + 1)) as usize;
        seed = next_seed(seed);
        if g < count {
            groups[g] |= 1 << w;
        }
    }
    if count == 1 && groups[0] == parent {
        if dead != 0 {
            // drop the dead worlds to make it a strict subset
            groups[0] = live;
        } else {
            if live & (live - 1) == 0 {
                // one live world and nothing else: no strict split
                return Vec::new();
            }
            let lowest = live & live.wrapping_neg();
            groups[0] = live & !lowest;
            groups[1] = lowest;
            count = 2;
        }
    }
    groups[..count].to_vec()
}
