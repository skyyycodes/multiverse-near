//! MultiverseCore: scenarios, split, merge, redeem and resolution.
//!
//! A scenario's real assets sit in `reserves[(scenario, asset)]`, which moves
//! only on a root split (+), a merge to root (-) and a redeem (-). Splits and
//! merges otherwise just burn and mint verse tokens, 1:1 with no rounding.
//! That keeps invariant 1: in every possible world, the supply of the verse
//! tokens covering that world equals the reserves.
//!
//! Check orders are fixed; tests assert the first error. There is no `to`
//! (the caller receives everything) and the asset is one of the two
//! configured tokens by type, so `AssetNotAllowed` cannot happen here
//! (`ft_on_transfer` raises it).

use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, near, AccountId};

use crate::errors::{add, fail, sub};
use crate::events::{Merged, MultiverseEvent, Redeemed, ScenarioCreated, Split, WorldsRemoved};
use crate::masks::{self, MAX_EVENTS, MAX_WORLDS};
use crate::types::{Asset, BackingView, Scenario, ScenarioInfo, VerseKey, WorldBacking};
use crate::{Contract, ContractExt};

/// Finalizing an event logs one line per scenario that uses it, and a receipt
/// may log at most 100 lines, so the fan-out is bounded well below that.
pub const MAX_SCENARIOS_PER_EVENT: usize = 16;

#[near]
impl Contract {
    /// Owner only; the attached deposit (or the owner's storage balance) pays
    /// for the new state. Events are used in the order given: event 0 is the
    /// least significant digit of a world index, so the order is part of the
    /// scenario's identity.
    #[payable]
    pub fn create_scenario(&mut self, event_ids: Vec<u64>) -> u64 {
        self.assert_owner();
        let n = event_ids.len();
        if n == 0 || n > MAX_EVENTS {
            fail!("BadEventCount({n})");
        }
        let mut worlds: u64 = 1;
        let mut outcome_counts = Vec::with_capacity(n);
        for (k, id) in event_ids.iter().enumerate() {
            if event_ids[..k].contains(id) {
                fail!("DuplicateEvent({id})");
            }
            // An unknown id has 0 outcomes, so it is "not open" too.
            let outcomes = self.outcome_count(*id);
            if outcomes < 2 || self.is_finalized(*id) || self.has_open_proposal(*id) {
                fail!("EventNotOpen({id})");
            }
            worlds *= u64::from(outcomes);
            if worlds > u64::from(MAX_WORLDS) {
                fail!("TooManyWorlds({worlds})");
            }
            if self.scenarios_of_event.get(id).map_or(0, Vec::len) >= MAX_SCENARIOS_PER_EVENT {
                fail!("TooManyScenarios({id})");
            }
            outcome_counts.push(outcomes);
        }

        let before = env::storage_usage();
        let world_count = worlds as u8;
        self.scenario_count += 1;
        let sid = self.scenario_count;
        self.scenarios.insert(
            sid,
            Scenario {
                event_ids: event_ids.clone(),
                outcome_counts,
                world_count,
                possible: masks::root(world_count),
                resolution_count: 0,
                resolved_events: 0,
                pool_ids: Vec::new(),
            },
        );
        for id in &event_ids {
            let mut list = self.scenarios_of_event.get(id).cloned().unwrap_or_default();
            list.push(sid);
            self.scenarios_of_event.insert(*id, list);
        }
        ScenarioCreated {
            scenario_id: sid,
            event_ids: &event_ids,
            world_count,
        }
        .emit();
        self.charge_storage_or_deposit(&env::predecessor_account_id(), before);
        sid
    }

    /// Splits `amount` of `from_mask` into each of `to_masks` for the caller.
    /// From root it draws the real asset from the caller's internal balance.
    #[payable]
    pub fn split(
        &mut self,
        scenario_id: u64,
        asset: Asset,
        from_mask: u8,
        to_masks: Vec<u8>,
        amount: U128,
    ) {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        self.internal_split(&account, scenario_id, asset, from_mask, &to_masks, amount.0);
        self.charge_storage(&account, before);
    }

    /// Merges `amount` of each of `from_masks` into `to_mask`. Merging into
    /// root releases the real asset and pays it out to the caller.
    #[payable]
    pub fn merge(
        &mut self,
        scenario_id: u64,
        asset: Asset,
        from_masks: Vec<u8>,
        to_mask: u8,
        amount: U128,
    ) {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        let released =
            self.internal_merge(&account, scenario_id, asset, &from_masks, to_mask, amount.0);
        if released > 0 {
            self.payout(&account, asset, released);
        }
        self.charge_storage(&account, before);
    }

    /// Collapse: a mask covering every world still possible is worth exactly
    /// one unit of the asset, so it redeems 1:1 and pays out.
    #[payable]
    pub fn redeem(&mut self, scenario_id: u64, asset: Asset, mask: u8, amount: U128) {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        self.internal_redeem(&account, scenario_id, asset, mask, amount.0);
        self.payout(&account, asset, amount.0);
        self.charge_storage(&account, before);
    }

    /// Makes a verse token exist before anything is minted (an explicit
    /// creation step), so its id resolves in `mt_supply` and pools can be
    /// set up first. Anyone may call it; it is idempotent and the caller pays
    /// the storage.
    pub fn register_verse(&mut self, scenario_id: u64, asset: Asset, mask: u8) -> String {
        let account = env::predecessor_account_id();
        let s = self.scenario(scenario_id);
        masks::check_mask(mask, s.root());
        if mask == s.root() {
            fail("NoTokenForRoot");
        }
        if !s.is_live(mask) {
            fail!("DeadVerse({mask})");
        }
        let key = VerseKey::new(scenario_id, asset, mask);
        let before = env::storage_usage();
        self.mark_created(&key);
        self.charge_storage(&account, before);
        key.token_id()
    }

    pub fn get_scenario(&self, scenario_id: u64) -> ScenarioInfo {
        let s = self.scenario(scenario_id);
        ScenarioInfo {
            scenario_id,
            event_ids: s.event_ids.clone(),
            outcome_counts: s.outcome_counts.clone(),
            world_count: s.world_count,
            root: s.root(),
            possible: s.possible,
            resolution_count: s.resolution_count,
            resolved_events: s.resolved_events,
            halted: self.halted(s),
            pool_ids: s.pool_ids.clone(),
        }
    }

    pub fn scenario_count(&self) -> u64 {
        self.scenario_count
    }

    /// Scenario ids using the event, in creation order; empty if none.
    pub fn scenarios_of_event(&self, event_id: u64) -> Vec<u64> {
        self.scenarios_of_event
            .get(&event_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Worlds of the scenario in which `event_id` has `outcome`, regardless of
    /// what is still possible.
    pub fn worlds_with(&self, scenario_id: u64, event_id: u64, outcome: u8) -> u8 {
        let s = self.scenario(scenario_id);
        let k = s.event_index(scenario_id, event_id);
        if outcome >= s.outcome_counts[k] {
            fail!("InvalidOutcome({outcome})");
        }
        s.worlds_with(k, outcome)
    }

    /// A valid mask that still contains a possible world. Root is live.
    pub fn is_live(&self, scenario_id: u64, mask: u8) -> bool {
        let s = self.scenario(scenario_id);
        mask != 0 && masks::is_subset(mask, s.root()) && s.is_live(mask)
    }

    /// Whether `mask` pays in `world` and that world can still happen. Bits
    /// above the scenario's worlds are ignored.
    pub fn value_in(&self, scenario_id: u64, mask: u8, world: u8) -> bool {
        let s = self.scenario(scenario_id);
        world < s.world_count && masks::contains(mask, world) && masks::contains(s.possible, world)
    }

    /// True while any event of the scenario has an open proposal. Swaps,
    /// order fills and liquidations stop; nothing in core does.
    pub fn is_halted(&self, scenario_id: u64) -> bool {
        self.halted(self.scenario(scenario_id))
    }

    /// `"ANY"` for root, outcome names joined by `·` for a single world, the
    /// outcome name for a mask equal to one outcome of one event, otherwise
    /// the bits from the highest world down, e.g. `"0b1110"`.
    pub fn verse_label(&self, scenario_id: u64, mask: u8) -> String {
        let s = self.scenario(scenario_id);
        masks::check_mask(mask, s.root());
        if mask == s.root() {
            return "ANY".to_string();
        }
        if masks::is_single_world(mask) {
            let w = masks::lowest_world(mask);
            return (0..s.event_ids.len())
                .map(|k| {
                    let o = masks::digit(w, s.stride(k), s.outcome_counts[k]);
                    self.outcome_name(s.event_ids[k], o)
                })
                .collect::<Vec<_>>()
                .join("·");
        }
        for k in 0..s.event_ids.len() {
            for o in 0..s.outcome_counts[k] {
                if mask == s.worlds_with(k, o) {
                    return self.outcome_name(s.event_ids[k], o);
                }
            }
        }
        let bits: String = (0..s.world_count)
            .rev()
            .map(|w| if masks::contains(mask, w) { '1' } else { '0' })
            .collect();
        format!("0b{bits}")
    }

    /// The token's display name, `"{SYMBOL}-if-{label}"`, e.g. `"wNEAR-if-DELAYED·HOLDS"`.
    /// Not unique across scenarios.
    pub fn verse_name(&self, scenario_id: u64, asset: Asset, mask: u8) -> String {
        let label = self.verse_label(scenario_id, mask);
        format!("{}-if-{}", self.asset_cfg(asset).symbol, label)
    }

    /// Root is the real asset itself, so it maps to the NEP-141 account. Any
    /// other mask maps to its NEP-245 id once the token exists, else null.
    pub fn token_for(&self, scenario_id: u64, asset: Asset, mask: u8) -> Option<String> {
        let s = self.scenario(scenario_id);
        if mask == s.root() {
            return Some(self.asset_cfg(asset).token_id.to_string());
        }
        let key = VerseKey::new(scenario_id, asset, mask);
        self.is_created(&key).then(|| key.token_id())
    }

    pub fn reserves_of(&self, scenario_id: u64, asset: Asset) -> U128 {
        self.scenario(scenario_id);
        U128(self.reserve(scenario_id, asset))
    }

    /// Invariant 1 per world and asset: the supply of every verse token
    /// covering the world, against the scenario's reserves. The supply counts
    /// tokens held by pools, escrow, collateral and the Root LP too.
    pub fn backing(&self, scenario_id: u64) -> BackingView {
        let s = self.scenario(scenario_id);
        let wnear_reserves = self.reserve(scenario_id, Asset::Wnear);
        let usdc_reserves = self.reserve(scenario_id, Asset::Usdc);
        let worlds = (0..s.world_count)
            .map(|w| {
                let possible = masks::contains(s.possible, w);
                let wnear = self.supply_in_world(scenario_id, s.root(), Asset::Wnear, w);
                let usdc = self.supply_in_world(scenario_id, s.root(), Asset::Usdc, w);
                WorldBacking {
                    world: w,
                    possible,
                    wnear_supply: U128(wnear),
                    usdc_supply: U128(usdc),
                    wnear_backed: !possible || wnear == wnear_reserves,
                    usdc_backed: !possible || usdc == usdc_reserves,
                }
            })
            .collect();
        BackingView {
            scenario_id,
            possible: s.possible,
            wnear_reserves: U128(wnear_reserves),
            usdc_reserves: U128(usdc_reserves),
            worlds,
        }
    }
}

impl Contract {
    pub(crate) fn scenario(&self, scenario_id: u64) -> &Scenario {
        self.scenarios
            .get(&scenario_id)
            .unwrap_or_else(|| fail!("UnknownScenario({scenario_id})"))
    }

    pub(crate) fn reserve(&self, scenario_id: u64, asset: Asset) -> u128 {
        self.reserves
            .get(&(scenario_id, asset))
            .copied()
            .unwrap_or(0)
    }

    fn set_reserve(&mut self, scenario_id: u64, asset: Asset, value: u128) {
        self.reserves.insert((scenario_id, asset), value);
    }

    pub(crate) fn halted(&self, s: &Scenario) -> bool {
        s.event_ids.iter().any(|e| self.has_open_proposal(*e))
    }

    /// Supply of every non-root mask that contains world `w`.
    pub(crate) fn supply_in_world(&self, scenario_id: u64, root: u8, asset: Asset, w: u8) -> u128 {
        (1..root)
            .filter(|m| masks::contains(*m, w))
            .map(|m| self.verse_supply(&VerseKey::new(scenario_id, asset, m)))
            .sum()
    }

    /// Split for `account`. Root draws real assets from its internal balance
    /// into the reserves; any other mask burns the caller's tokens.
    pub(crate) fn internal_split(
        &mut self,
        account: &AccountId,
        scenario_id: u64,
        asset: Asset,
        from_mask: u8,
        to_masks: &[u8],
        amount: u128,
    ) {
        let s = self.scenario(scenario_id);
        let (root, possible) = (s.root(), s.possible);
        if amount == 0 {
            fail("ZeroAmount");
        }
        masks::check_mask(from_mask, root);
        if !masks::is_live(from_mask, possible) {
            fail!("DeadVerse({from_mask})");
        }
        masks::check_partition(possible, from_mask, to_masks);

        if from_mask == root {
            let reserve = add(self.reserve(scenario_id, asset), amount);
            self.set_reserve(scenario_id, asset, reserve);
            self.real_debit(account, asset, amount);
        } else {
            // A collapsed mask splits like root but burns the token; reserves stay put.
            self.burn(
                account,
                &[(VerseKey::new(scenario_id, asset, from_mask), amount)],
                None,
            );
        }
        let parts: Vec<(VerseKey, u128)> = to_masks
            .iter()
            .map(|m| (VerseKey::new(scenario_id, asset, *m), amount))
            .collect();
        self.mint(account, &parts, None);
        Split {
            account_id: account,
            scenario_id,
            asset,
            from_mask,
            to_masks,
            amount: U128(amount),
        }
        .emit();
    }

    /// Merge for `account`. Returns the real amount released from reserves
    /// (non-zero only when merging into root); the caller pays it out.
    pub(crate) fn internal_merge(
        &mut self,
        account: &AccountId,
        scenario_id: u64,
        asset: Asset,
        from_masks: &[u8],
        to_mask: u8,
        amount: u128,
    ) -> u128 {
        let s = self.scenario(scenario_id);
        let (root, possible) = (s.root(), s.possible);
        if amount == 0 {
            fail("ZeroAmount");
        }
        masks::check_mask(to_mask, root);
        // No separate liveness check on `to_mask`: every part is a subset of
        // it, so a dead `to_mask` fails on its first part.
        masks::check_partition(possible, to_mask, from_masks);

        let parts: Vec<(VerseKey, u128)> = from_masks
            .iter()
            .map(|m| (VerseKey::new(scenario_id, asset, *m), amount))
            .collect();
        self.burn(account, &parts, None);
        let released = if to_mask == root {
            let reserve = sub(self.reserve(scenario_id, asset), amount);
            self.set_reserve(scenario_id, asset, reserve);
            amount
        } else {
            self.mint(
                account,
                &[(VerseKey::new(scenario_id, asset, to_mask), amount)],
                None,
            );
            0
        };
        Merged {
            account_id: account,
            scenario_id,
            asset,
            from_masks,
            to_mask,
            amount: U128(amount),
        }
        .emit();
        released
    }

    /// Redeem for `account`: burns the collapsed token and takes the amount
    /// out of reserves; the caller pays it out.
    pub(crate) fn internal_redeem(
        &mut self,
        account: &AccountId,
        scenario_id: u64,
        asset: Asset,
        mask: u8,
        amount: u128,
    ) {
        let s = self.scenario(scenario_id);
        let (root, possible) = (s.root(), s.possible);
        if amount == 0 {
            fail("ZeroAmount");
        }
        masks::check_mask(mask, root);
        if mask == root {
            fail("NoTokenForRoot");
        }
        // A dead mask is not collapsed either, so it fails here too.
        if !masks::is_collapsed(mask, possible) {
            fail!("NotCollapsed({mask})");
        }
        self.burn(
            account,
            &[(VerseKey::new(scenario_id, asset, mask), amount)],
            None,
        );
        let reserve = sub(self.reserve(scenario_id, asset), amount);
        self.set_reserve(scenario_id, asset, reserve);
        Redeemed {
            account_id: account,
            scenario_id,
            asset,
            mask,
            amount: U128(amount),
        }
        .emit();
    }

    /// Applies an event's outcome to one scenario. Only the oracle's finalize
    /// path calls this, once per scenario using the event, so there is no
    /// separate caller check.
    pub(crate) fn resolve(&mut self, scenario_id: u64, event_id: u64, outcome: u8) {
        let mut s = self.scenario(scenario_id).clone();
        let k = s.event_index(scenario_id, event_id);
        if s.resolved_events & (1 << k) != 0 {
            fail!("EventAlreadyResolved({scenario_id}, {event_id})");
        }
        if outcome >= s.outcome_counts[k] {
            fail!("InvalidOutcome({outcome})");
        }
        let keep = s.worlds_with(k, outcome);
        let removed = s.possible & !keep;
        s.possible &= keep;
        s.resolved_events |= 1 << k;
        s.resolution_count += 1;
        let possible = s.possible;
        self.scenarios.insert(scenario_id, s);
        WorldsRemoved {
            scenario_id,
            event_id,
            outcome,
            removed,
            possible,
        }
        .emit();
    }
}
