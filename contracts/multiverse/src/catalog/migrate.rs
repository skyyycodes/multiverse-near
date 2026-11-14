//! Migrate step 12: the catalogue of a v1 deployment.

use super::registry::{check_meta, scenario_key};
use super::{MarketEntry, MarketOrigin, MarketParams, VMarketEntry};
use crate::migrate::{CatalogMigrateArgs, CatalogUpgradeLog};
use crate::Contract;

fn bad(field: &str, id: u64) -> ! {
    fail!("MigrateBadArgs({field}, {id})")
}

impl Contract {
    /// Writes the params (`args.params` or the testnet column, with
    /// `args.anchors` either way), lists the given legacy markets, sets the
    /// reference market of each event and the events' sources and
    /// categories. Any bad argument reverts the upgrade with
    /// `MigrateBadArgs(field, id)`.
    pub(crate) fn migrate_catalog(&mut self, args: &CatalogMigrateArgs) -> CatalogUpgradeLog {
        let mut params = args
            .params
            .clone()
            .unwrap_or_else(MarketParams::testnet_defaults);
        params.anchors = args.anchors;
        if params.validate().is_err() {
            bad("params", 0);
        }
        self.write_market_params(&params);
        for &sid in &args.listed {
            if !self.scenarios.contains_key(&sid) || self.check_seeded(sid).is_err() {
                bad("listed", sid);
            }
            let key = scenario_key(self.scenario(sid));
            if self.catalog.listed_by_set.contains_key(&key) {
                bad("listed", sid);
            }
            self.catalog.registry.insert(
                sid,
                VMarketEntry::V1(MarketEntry {
                    listed: true,
                    origin: MarketOrigin::Legacy,
                    proposal_id: 0,
                    created_at_sec: 0,
                }),
            );
            self.catalog.listed_by_set.insert(key, sid);
        }
        for &(event_id, sid) in &args.references {
            if !self.events.contains_key(&event_id) || self.check_reference(event_id, sid).is_err()
            {
                bad("references", event_id);
            }
            self.catalog.reference_market.insert(event_id, sid);
        }
        for &sid in &args.anchors {
            if sid != 0 && !args.listed.contains(&sid) {
                bad("anchors", sid);
            }
        }
        for meta in &args.event_meta {
            if !self.events.contains_key(&meta.event_id)
                || check_meta(&meta.source, meta.category).is_err()
            {
                bad("event_meta", meta.event_id);
            }
            self.put_event_meta(meta.event_id, meta.source.clone(), meta.category);
        }
        CatalogUpgradeLog {
            listed: args.listed.clone(),
            references: args.references.len() as u32,
        }
    }
}
