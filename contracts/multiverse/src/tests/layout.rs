//! The stored layout, pinned: the STATE bytes `new()` writes in a fixed
//! context, one canonical Borsh sample of every stored type (v1 and v2), and
//! the prefix byte of every StorageKey. A mismatch means a deployed
//! contract's state would no longer decode: bump STATE_VERSION and add a
//! migrate step, or restore the layout.
//!
//! `UPDATE_GOLDEN=1 cargo test layout -- --nocapture` prints the current
//! values in the form the tables below take.

use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{env, testing_env, IntoStorageKey, NearToken};

use super::harness::*;
use crate::amm::{ImpactRing, Pool, PoolKind, Position};
use crate::books::Books;
use crate::catalog::{
    AccountMarkets, Catalog, EventMeta, EventSetKey, IdleToken, MarketEntry, MarketOrigin,
    MarketParams, OpenRecord, OpeningTerms, Pledge, Proposal, ProposalKind, ProposalStatus,
    ProposalText, SeedPosition, SeedVault, VMarketEntry, VProposal, VSeedVault, VoidReason,
};
use crate::index::{AccountScenario, Footprint, MaskSet};
use crate::lending::tiers::{LendingParams, Tier, TierState};
use crate::lending::{CollateralKey, Market};
use crate::ops::PauseState;
use crate::orders::{Order, Side};
use crate::outlayer::{FomcDates, OutLayerConfig, ResourceLimits};
use crate::prices::{MarketPriceCfg, PriceState};
use crate::reference::{ReferenceConfig, ReferenceGuest, ReferenceState};
use crate::rootlp::Vault;
use crate::storage::StorageAccount;
use crate::types::{Asset, EventData, Params, ProposedBy, Scenario, VerseKey, WAD};
use crate::version::{VersionRecord, CODE_VERSION, STATE_VERSION};
use crate::{Contract, StorageKey};
use multiverse_math::flow::SwapFlow;
use multiverse_math::twap::TwapOracle;

const CHANGED: &str =
    "stored layout changed: bump STATE_VERSION and add a migrate step, or restore the layout";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn printing() -> bool {
    std::env::var_os("UPDATE_GOLDEN").is_some()
}

/// `new()` run by the contract account at T0, outside the harness: the
/// contract and the raw keys it wrote.
fn fresh() -> Contract {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(CONTRACT))
        .block_timestamp(T0 * 1_000_000_000)
        .build());
    Contract::new(
        acc(OWNER),
        Some(acc(REPORTER)),
        wnear_cfg(),
        usdc_cfg(),
        DISPUTE_WINDOW,
    )
}

// ---- StorageKey ----

#[test]
fn every_storage_key_keeps_its_prefix() {
    use StorageKey as K;
    let keys = [
        (K::Events, "Events"),
        (K::ScenariosOfEvent, "ScenariosOfEvent"),
        (K::Scenarios, "Scenarios"),
        (K::Reserves, "Reserves"),
        (K::Balances, "Balances"),
        (K::Supply, "Supply"),
        (K::Created, "Created"),
        (K::Real, "Real"),
        (K::Pools, "Pools"),
        (K::Within, "Within"),
        (K::Between, "Between"),
        (K::Positions, "Positions"),
        (K::Impact, "Impact"),
        (K::Orders, "Orders"),
        (K::OpenByWorld, "OpenByWorld"),
        (K::Markets, "Markets"),
        (K::SupplyShares, "SupplyShares"),
        (K::SupplyPrincipal, "SupplyPrincipal"),
        (K::BorrowShares, "BorrowShares"),
        (K::Collateral, "Collateral"),
        (K::Vaults, "Vaults"),
        (K::LpShares, "LpShares"),
        (K::Storage, "Storage"),
        (K::DemoRecord, "DemoRecord"),
        (K::OpenByScenario, "OpenByScenario"),
        (K::OutLayerConfig, "OutLayerConfig"),
        (K::OutLayerDates, "OutLayerDates"),
        (K::VersionRecord, "VersionRecord"),
        (K::AccountVersion, "AccountVersion"),
        (K::MarketParams, "MarketParams"),
        (K::Proposals, "Proposals"),
        (K::ProposalTexts, "ProposalTexts"),
        (K::Pledges, "Pledges"),
        (K::AccountMarkets, "AccountMarkets"),
        (K::ProposalBySet, "ProposalBySet"),
        (K::LiveProposalsOfEvent, "LiveProposalsOfEvent"),
        (K::QuestionHashes, "QuestionHashes"),
        (K::MarketRegistry, "MarketRegistry"),
        (K::ListedBySet, "ListedBySet"),
        (K::ReferenceMarkets, "ReferenceMarkets"),
        (K::SeedVaults, "SeedVaults"),
        (K::EventMeta, "EventMeta"),
        (K::WorldSupply, "WorldSupply"),
        (K::CreatedMasks, "CreatedMasks"),
        (K::AccountScenarios, "AccountScenarios"),
        (K::Footprints, "Footprints"),
        (K::PriceConfigs, "PriceConfigs"),
        (K::ReferenceConfig, "ReferenceConfig"),
        (K::ReferenceState, "ReferenceState"),
        (K::TierStates, "TierStates"),
        (K::BorrowerCount, "BorrowerCount"),
        (K::BorrowerAt, "BorrowerAt"),
        (K::BorrowerPos, "BorrowerPos"),
    ];
    assert_eq!(keys.len(), 53, "StorageKey 0-52; the next free index is 53");
    for (index, (key, name)) in keys.into_iter().enumerate() {
        assert_eq!(
            key.into_storage_key(),
            vec![index as u8],
            "{name}: {CHANGED}"
        );
    }
}

// ---- STATE of new() ----

/// STATE of `new()` above: the v1 fields (owner, reporter, the two tokens,
/// params, 25 collection prefixes, counters) then the v2 blocks.
const NEW_STATE: &str = "0a00000061646d696e2e6e656172010d0000007265736f6c7665722e6e6561720a000000776e6561722e6e65617205000000774e4541521209000000757364632e6e6561720400000055534443061e000000000000000807000000000000000040b2bac9e0191e0200000000000000008bbd0689680a00000000000000000000c52ebca2b1000000000000000000bfa6805e000000000000000000000000b80b0000983a00000100000000000000000000000001000000010100000002000000000000000001000000030100000004010000000501000000060100000007010000000800000000000000000100000009010000000a00010000000b010000000c010000000d0000000000000000010000000e0100000018010000000f0100000010010000001101000000120100000013010000001401000000150100000016010000001a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000001c000000000000000000000000000000000000000000000000010000001e010000001f0100000020010000002101000000220100000023010000002401000000250100000026010000002701000000280100000029010000002a010000002b010000002c010000002d08070000000000000000407ba5f06381960a0000000000000000008a5d784563010000000000000000000014bbf08ac6020000000000000000010000002e0100000031010000003201000000330100000034000010632d5ec76b05000000000000000000da493b717d0c0000000000000000000020c65abc8ed70a00000000000000";

#[test]
fn state_of_new_is_pinned() {
    let c = fresh();
    let state = borsh::to_vec(&c).unwrap();
    if printing() {
        println!("NEW_STATE ({} bytes) = {}", state.len(), hex(&state));
    }
    assert_eq!(hex(&state), NEW_STATE, "{CHANGED}");
    // The v2 blocks add 406 bytes to whatever the v1 fields take: 20 + 1 + 1
    // + 8 + 1 + 136 + 5 (operations), 84 (catalogue), 4 x 5 (eight worlds),
    // 62 (prices), 4 x 5 + 48 (lending).
    let v1_part = state.len() - 406;
    assert_eq!(
        &state[v1_part..v1_part + 20],
        &borsh::to_vec(&PauseState::default()).unwrap()[..]
    );
    // It decodes back to the same bytes.
    let back = Contract::try_from_slice(&state).unwrap();
    assert_eq!(borsh::to_vec(&back).unwrap(), state);
}

#[test]
fn new_writes_the_version_record_and_the_testnet_params() {
    let _c = fresh();
    let record = env::storage_read(&StorageKey::VersionRecord.into_storage_key()).unwrap();
    assert_eq!(
        VersionRecord::try_from_slice(&record).unwrap(),
        VersionRecord {
            state_version: STATE_VERSION,
            code_version: CODE_VERSION.to_string(),
            upgraded_at_sec: T0,
            upgraded_from: String::new(),
        }
    );
    // state_version is the record's first four bytes, whatever follows.
    assert_eq!(&record[..4], &STATE_VERSION.to_le_bytes());
    let params = env::storage_read(&StorageKey::MarketParams.into_storage_key()).unwrap();
    assert_eq!(
        MarketParams::try_from_slice(&params).unwrap(),
        MarketParams::testnet_defaults()
    );
    assert_eq!(MarketParams::testnet_defaults().anchors, [0, 0, 0]);
}

// ---- One canonical sample per stored type ----

fn bytes<T: BorshSerialize>(v: &T) -> String {
    hex(&borsh::to_vec(v).unwrap())
}

fn pool() -> (Pool, Position) {
    let mut amm = multiverse_math::cpmm::Pool::new();
    let mut position = Position::default();
    amm.mint_initial(&mut position, 1_000 * WAD, 3_000 * WAD)
        .unwrap();
    amm.swap_exact_in(true, 10 * WAD, 3_000).unwrap();
    let mut flow = SwapFlow::new();
    flow.record_swap(true, 10 * WAD, 29 * WAD);
    let pool = Pool {
        kind: PoolKind::Within { world: 1 },
        scenario_id: 2,
        amm,
        flow,
        twap: TwapOracle::new(T0, 10_986),
    };
    (pool, position)
}

fn proposal() -> Proposal {
    Proposal {
        kind: ProposalKind::Market,
        status: ProposalStatus::Pledging,
        void_reason: VoidReason::None,
        proposer: acc(ALICE),
        key: EventSetKey([7, 8, 0]),
        world_count: 4,
        category: 0,
        terms: OpeningTerms {
            odds0_bps: 0,
            mult_bps: [0, 0],
        },
        goal: 52_000 * WAD,
        ideal_wnear: 8_055 * WAD,
        ideal_usdc: 25_000 * WAD,
        s_hint: 3_037_693_300_000_000_000,
        beta: WAD / 4,
        seed_lock_sec: 604_800,
        created_at_sec: T0,
        approved_at_sec: T0,
        expires_at_sec: T0 + 1_209_600,
        open_not_before_sec: 0,
        deadline_sec: T0 + 40 * DAY,
        escrow_wnear: 3 * WAD,
        escrow_usdc: 10 * WAD,
        pledgers: 2,
        unused_open: 0,
        bond: 50_000_000_000_000_000_000_000,
        reserve: 150_000_000_000_000_000_000_000,
        open_scheduled_block: 0,
        open: OpenRecord::default(),
    }
}

/// Every stored type, by name, with its canonical sample.
fn samples() -> Vec<(&'static str, String)> {
    let (pool, position) = pool();
    let mut ring = ImpactRing::default();
    ring.record(T0, vec![3_700 * WAD / 1_000, 0]);
    let mut verse = MaskSet::default();
    verse.set(Asset::Usdc, 0xF0, true);
    vec![
        // v1
        ("Params", bytes(&Params::new(DISPUTE_WINDOW))),
        ("AssetCfg", bytes(&usdc_cfg())),
        (
            "EventData",
            bytes(&EventData {
                question: "Q?".into(),
                rule: "R.".into(),
                outcome_names: vec!["YES".into(), "NO".into()],
                deadline_sec: T0,
                proposed_at_sec: T0 + 1,
                proposed_outcome: 1,
                proposal_open: true,
                finalized: false,
                outcome: 0,
                proposed_by: ProposedBy::Reporter,
            }),
        ),
        (
            "Scenario",
            bytes(&Scenario {
                event_ids: vec![1, 2, 3],
                outcome_counts: vec![2, 2, 2],
                world_count: 8,
                possible: 0xF0,
                resolution_count: 1,
                resolved_events: 0b100,
                pool_ids: vec![4, 5],
            }),
        ),
        ("VerseKey", bytes(&VerseKey::new(5, Asset::Wnear, 0xAA))),
        ("Pool", bytes(&pool)),
        ("Position", bytes(&position)),
        ("ImpactRing", bytes(&ring)),
        (
            "Order",
            bytes(&Order {
                maker: acc(BOB),
                expiry_sec: T0 + DAY,
                epoch: 1,
                side: Side::Bid,
                scenario_id: 5,
                mask: 0x10,
                price: 3_100 * WAD / 1_000,
                amount: 7 * WAD,
                remaining: 5 * WAD,
                escrow: 15_500 * WAD / 1_000,
            }),
        ),
        (
            "Market",
            bytes(&Market {
                total_supply_assets: 100_000 * WAD,
                total_supply_shares: 100_000 * WAD * 1_000_000,
                total_borrow_assets: 892 * WAD,
                total_borrow_shares: 892 * WAD * 1_000_000,
                last_update: T0,
            }),
        ),
        (
            "CollateralKey::Real",
            bytes(&CollateralKey::Real(Asset::Usdc)),
        ),
        (
            "CollateralKey::Verse",
            bytes(&CollateralKey::Verse {
                asset: Asset::Wnear,
                mask: 0x80,
            }),
        ),
        (
            "Vault",
            bytes(&Vault {
                supply: 1_000,
                positions: vec![position.clone()],
                wnear_idle: vec![1, 0],
                usdc_idle: vec![0, 2],
            }),
        ),
        (
            "StorageAccount",
            bytes(&StorageAccount {
                deposit: NearToken::from_millinear(100),
                used_bytes: 742,
                open_orders: 1,
            }),
        ),
        (
            "OutLayerConfig",
            bytes(&OutLayerConfig {
                outlayer_id: acc("outlayer.testnet"),
                wasm_url: "https://example.org/fred-guest.wasm".into(),
                wasm_sha256: "ab".repeat(32),
                resource_limits: ResourceLimits::default(),
                deposit: U128(5_000_000_000_000_000_000_000),
            }),
        ),
        (
            "FomcDates",
            bytes(&FomcDates {
                before: "2026-12-08".into(),
                after: "2026-12-10".into(),
                pending: false,
                request: 3,
            }),
        ),
        // v2
        (
            "VersionRecord",
            bytes(&VersionRecord {
                state_version: 2,
                code_version: "2.0.0".into(),
                upgraded_at_sec: T0,
                upgraded_from: "1.0.0".into(),
            }),
        ),
        (
            "PauseState",
            bytes(&PauseState {
                flags: 0x7F,
                since_sec: T0,
                liquidations_resume_at_sec: T0 + 1_800,
            }),
        ),
        (
            "Books",
            bytes(&Books {
                internal: [1, 2],
                collateral: [3, 4],
                pledges: [5, 6],
                nep145_deposit: 7,
                nep145_used_bytes: 8,
                near_held: 9,
            }),
        ),
        ("Catalog", bytes(&Catalog::new())),
        ("EventSetKey", bytes(&EventSetKey([7, 8, 0]))),
        ("ProposalKind", bytes(&ProposalKind::NewEvent)),
        ("ProposalStatus", bytes(&ProposalStatus::Expired)),
        ("VoidReason", bytes(&VoidReason::Evicted)),
        (
            "OpeningTerms",
            bytes(&OpeningTerms {
                odds0_bps: 6_667,
                mult_bps: [10_500, 9_000],
            }),
        ),
        ("VProposal", bytes(&VProposal::V1(proposal()))),
        (
            "OpenRecord",
            bytes(&OpenRecord {
                scenario_id: 7,
                opened_at_sec: T0,
                s_ref: 3 * WAD,
                pledged_wnear: 8_300 * WAD,
                pledged_usdc: 25_000 * WAD,
                used_wnear: 8_055 * WAD,
                used_usdc: 25_000 * WAD,
                shares: 49_470 * WAD,
            }),
        ),
        (
            "ProposalText",
            bytes(&ProposalText {
                question: "Q?".into(),
                outcome_names: vec!["YES".into(), "NO".into()],
                rule: "R. [ifverse:price:near>=5]".into(),
                source: "Coinbase NEAR-USD daily close".into(),
            }),
        ),
        (
            "Pledge",
            bytes(&Pledge {
                wnear: 3 * WAD,
                usdc: 10 * WAD,
                withdrawn_shares: 1,
                unused_paid: true,
            }),
        ),
        (
            "AccountMarkets",
            bytes(&AccountMarkets {
                pledges: vec![1, 3],
                proposals: vec![2],
            }),
        ),
        ("MarketOrigin", bytes(&MarketOrigin::Pledged)),
        (
            "VMarketEntry",
            bytes(&VMarketEntry::V1(MarketEntry {
                listed: true,
                origin: MarketOrigin::Legacy,
                proposal_id: 0,
                created_at_sec: 0,
            })),
        ),
        (
            "EventMeta",
            bytes(&EventMeta {
                proposal_id: 4,
                proposer: Some(acc(ALICE)),
                source: "FRED DFEDTARU".into(),
                category: 2,
            }),
        ),
        (
            "VSeedVault",
            bytes(&VSeedVault::V1(SeedVault {
                proposal_id: 4,
                supply: 49_470 * WAD,
                unlock_at_sec: T0 + 604_800,
                positions: vec![SeedPosition {
                    pool_id: 30,
                    position: position.clone(),
                }],
                idle: vec![IdleToken {
                    asset: Asset::Usdc,
                    mask: 0x2,
                    amount: 17,
                }],
            })),
        ),
        ("MarketParams", bytes(&MarketParams::testnet_defaults())),
        ("MaskSet", bytes(&verse)),
        (
            "AccountScenario",
            bytes(&AccountScenario {
                verse,
                pool_positions: 2,
                lending_entries: 3,
                lp_shares: true,
            }),
        ),
        (
            "Footprint",
            bytes(&Footprint {
                scenarios: vec![7, 9],
            }),
        ),
        ("MarketPriceCfg", bytes(&MarketPriceCfg::V2)),
        ("PriceState", bytes(&PriceState::new(MarketPriceCfg::V2))),
        (
            "ReferenceConfig",
            bytes(&ReferenceConfig {
                enabled: true,
                guest: Some(ReferenceGuest {
                    outlayer_id: acc("outlayer.testnet"),
                    wasm_url: "https://example.org/nearusd-guest.wasm".into(),
                    wasm_sha256: "cd".repeat(32),
                    resource_limits: ResourceLimits::default(),
                    deposit: U128(5_000_000_000_000_000_000_000),
                }),
                reporter_id: Some(acc(REPORTER)),
                min_sources: 3,
                max_spread_bps: 200,
                max_result_delay_sec: 120,
                borrow_max_age_sec: 3_600,
                liquidation_max_age_sec: 300,
                min_price: U128(WAD / 100),
                max_price: U128(10_000 * WAD),
            }),
        ),
        (
            "ReferenceState",
            bytes(&ReferenceState {
                price: 3_512 * WAD / 1_000,
                observed_at: T0 - 30,
                stored_at: T0,
                source: 1,
                sources_used: 4,
                spread_bps: 37,
                request: 12,
                pending_since: 0,
            }),
        ),
        ("TierState", bytes(&TierState::builtin(Tier::Bold))),
        ("LendingParams", bytes(&LendingParams::default())),
    ]
}

/// The pinned bytes of every sample, in `samples()` order.
const SAMPLES: &[(&str, &str)] = &[
    ("Params", "1e000000000000000807000000000000000040b2bac9e0191e0200000000000000008bbd0689680a00000000000000000000c52ebca2b1000000000000000000bfa6805e000000000000000000000000b80b0000983a0000"),
    ("AssetCfg", "09000000757364632e6e656172040000005553444306"),
    ("EventData", "02000000513f02000000522e0200000003000000594553020000004e4f803bb16a00000000813bb16a000000000101000002"),
    ("Scenario", "030000000100000000000000020000000000000003000000000000000300000002020208f001040200000004000000000000000500000000000000"),
    ("VerseKey", "050000000000000000aa"),
    ("Pool", "0001020000000000000000004519f33b26c036000000000000000bab958141576006a100000000000000d70f6577af9808e55d000000000000006a373fbf79f0514da2380704972201000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000434fd7946a0000000000000000000000000000000000000000000000000000001876fbdc3875ffffffffffffffff000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000001000000803bb16a000000000000000000000000ea2a0000"),
    ("Position", "d70f6577af9808e55d00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"),
    ("ImpactRing", "01000000803bb16a00000000020000000000f284650a5933000000000000000000000000000000000000000000000000"),
    ("Order", "08000000626f622e6e656172008db26a0000000001000500000000000000100000b6539369052b00000000000000000000bc93e9fe246100000000000000000000f44482916345000000000000000000008ea2e00f1bd70000000000000000"),
    ("Market", "000080f64ae1c7022d15000000000000000000a0ca17726dae0f1e430100000000007040fb99fc5a3000000000000000000000fcfc0b92e458d8e10200000000803bb16a00000000"),
    ("CollateralKey::Real", "0001"),
    ("CollateralKey::Verse", "010080"),
    ("Vault", "e803000000000000000000000000000001000000d70f6577af9808e55d00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000100000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000002000000000000000000000000000000"),
    ("StorageAccount", "000080f64ae1c7022d15000000000000e60200000000000001000000"),
    ("OutLayerConfig", "100000006f75746c617965722e746573746e65742300000068747470733a2f2f6578616d706c652e6f72672f667265642d67756573742e7761736d400000006162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616200ca9a3b00000000800000001e0000000000000000002059dd64f00c0f01000000000000"),
    ("FomcDates", "0a000000323032362d31322d30380a000000323032362d31322d3130000300000000000000"),
    ("VersionRecord", "0200000005000000322e302e30803bb16a0000000005000000312e302e30"),
    ("PauseState", "7f000000803bb16a000000008842b16a00000000"),
    ("Books", "01000000000000000000000000000000020000000000000000000000000000000300000000000000000000000000000004000000000000000000000000000000050000000000000000000000000000000600000000000000000000000000000007000000000000000000000000000000080000000000000009000000000000000000000000000000"),
    ("Catalog", "000000000000000000000000000000000000000000000000010000001e010000001f0100000020010000002101000000220100000023010000002401000000250100000026010000002701000000280100000029"),
    ("EventSetKey", "070000000000000008000000000000000000000000000000"),
    ("ProposalKind", "00"),
    ("ProposalStatus", "05"),
    ("VoidReason", "05"),
    ("OpeningTerms", "0b1a04292823"),
    ("VProposal", "000101000a000000616c6963652e6e656172070000000000000008000000000000000000000000000000040000000000000000008038314cf7ec020b00000000000000007cebc7ae94a9b4010000000000000000a0bd52f8b1404b0500000000000000881543f60d282a00000000000000000000d9e9ac2d78030000000000000000803a090000000000803bb16a00000000803bb16a0000000080b0c36a00000000000000000000000080f7e56a0000000000002cf61a24a22900000000000000000000e8890423c78a000000000000000002000000000000000000407ba5f06381960a0000000000000000c071f0d12b84c31f000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"),
    ("OpenRecord", "0700000000000000803bb16a0000000000002cf61a24a22900000000000000000000301eb788a3f1c1010000000000000000a0bd52f8b1404b0500000000000000007cebc7ae94a9b4010000000000000000a0bd52f8b1404b05000000000000000038eeb4b029c6790a000000000000"),
    ("ProposalText", "02000000513f0200000003000000594553020000004e4f1a000000522e205b696676657273653a70726963653a6e6561723e3d355d1d000000436f696e62617365204e4541522d555344206461696c7920636c6f7365"),
    ("Pledge", "00002cf61a24a22900000000000000000000e8890423c78a00000000000000000100000000000000000000000000000001"),
    ("AccountMarkets", "0200000001000000000000000300000000000000010000000200000000000000"),
    ("MarketOrigin", "02"),
    ("VMarketEntry", "00010000000000000000000000000000000000"),
    ("EventMeta", "0400000000000000010a000000616c6963652e6e6561720d0000004652454420444645445441525502"),
    ("VSeedVault", "000400000000000000000038eeb4b029c6790a0000000000000076ba6a00000000010000001e00000000000000d70f6577af9808e55d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000010211000000000000000000000000000000"),
    ("MarketParams", "000000ed95c28f055a2a0000000000000000407ba5f06381960a0000000000000000407ba5f06381960a0000000000000000a0bd52f8b1404b0500000000000000751200000000000075120000000000805101000000000080f4030000000000100e000000000000803a09000000000080f4030000000000e8030000600b982ed1262d03000000000000000040b2bac9e0191e02000000000000000040b2bac9e0191e020000000000000000a0dec5adc9353600000000000000c40964008813204ed00750c30000000000000000000000000000000000000000000000002c01e803000040b2bac9e0191e020000000000000000a0dec5adc935360000000000000000e8030000e8890423c78a000000000000000000002cf61a24a229000000000000000020041001"),
    ("MaskSet", "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100"),
    ("AccountScenario", "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100020301"),
    ("Footprint", "0200000007000000000000000900000000000000"),
    ("MarketPriceCfg", "08070000000000000000407ba5f06381960a0000000000000000008a5d784563010000000000000000000014bbf08ac6020000000000000000"),
    ("PriceState", "08070000000000000000407ba5f06381960a0000000000000000008a5d784563010000000000000000000014bbf08ac6020000000000000000010000002e"),
    ("ReferenceConfig", "0101100000006f75746c617965722e746573746e65742600000068747470733a2f2f6578616d706c652e6f72672f6e6561727573642d67756573742e7761736d400000006364636463646364636463646364636463646364636463646364636463646364636463646364636463646364636463646364636463646364636463646364636400ca9a3b00000000800000001e0000000000000000002059dd64f00c0f01000000000000010d0000007265736f6c7665722e6e65617203c80000007800000000000000100e0000000000002c010000000000000000c16ff28623000000000000000000000040b2bac9e0191e02000000000000"),
    ("ReferenceState", "00002c836421bd300000000000000000623bb16a00000000803bb16a000000000104250000000c000000000000000000000000000000"),
    ("TierState", "000050ecc22b1a0b00000000000000000000c68e4ae6b60900000000000000000000087e93371c01000000000000000000008a5d7845630100000000000000003f97b338000000000000000000000000bec51aaa0000000000000000000000003568bba6040000000000000000000000000050ecc22b1a0b00000000000000000000da493b717d0c0000000000000000ffffffffffffffffffffffffffffffff00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"),
    ("LendingParams", "000010632d5ec76b05000000000000000000da493b717d0c0000000000000000000020c65abc8ed70a00000000000000"),
];

#[test]
fn every_stored_type_keeps_its_borsh_layout() {
    let samples = samples();
    if printing() {
        for (name, bytes) in &samples {
            println!("    (\"{name}\", \"{bytes}\"),");
        }
    }
    assert_eq!(samples.len(), SAMPLES.len(), "one golden per stored type");
    for ((name, got), (golden_name, golden)) in samples.iter().zip(SAMPLES) {
        assert_eq!(name, golden_name);
        assert_eq!(got, golden, "{name}: {CHANGED}");
    }
}

#[test]
fn fixed_sizes_are_as_specified() {
    let size = |v: &dyn Fn() -> Vec<u8>| v().len();
    assert_eq!(size(&|| borsh::to_vec(&PauseState::default()).unwrap()), 20);
    assert_eq!(size(&|| borsh::to_vec(&Books::default()).unwrap()), 136);
    assert_eq!(size(&|| borsh::to_vec(&MarketPriceCfg::V2).unwrap()), 57);
    assert_eq!(
        size(&|| borsh::to_vec(&PriceState::new(MarketPriceCfg::V2)).unwrap()),
        62
    );
    assert_eq!(
        size(&|| borsh::to_vec(&ReferenceState::default()).unwrap()),
        54
    );
    assert_eq!(
        size(&|| borsh::to_vec(&TierState::builtin(Tier::Safe).config).unwrap()),
        160
    );
    assert_eq!(
        size(&|| borsh::to_vec(&TierState::builtin(Tier::Safe)).unwrap()),
        209
    );
    assert_eq!(
        size(&|| borsh::to_vec(&LendingParams::default()).unwrap()),
        48
    );
    assert_eq!(size(&|| borsh::to_vec(&MaskSet::default()).unwrap()), 64);
    assert_eq!(
        size(&|| borsh::to_vec(&AccountScenario::default()).unwrap()),
        67
    );
    assert_eq!(size(&|| borsh::to_vec(&Catalog::new()).unwrap()), 84);
    assert_eq!(size(&|| borsh::to_vec(&Market::default()).unwrap()), 72);
    // A proposal record never changes size with its status.
    let mut p = proposal();
    let before = borsh::to_vec(&VProposal::V1(p.clone())).unwrap().len();
    p.status = ProposalStatus::Void;
    p.void_reason = VoidReason::MarketExists;
    p.open.scenario_id = u64::MAX;
    assert_eq!(borsh::to_vec(&VProposal::V1(p)).unwrap().len(), before);
}
