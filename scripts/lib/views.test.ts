import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  DecodeError,
  decodeContractVersion,
  decodeEventCheck,
  decodeLiquidationStatus,
  decodeMarketCard,
  decodeMarketParams,
  decodeNearBooks,
  decodeProposal,
  decodeReference,
  decodeSeedWithdrawPreview,
  dU128,
  MARKET_PARAMS_FIELDS,
  VIEW_DECODERS,
} from "./views.ts";

// SPEC-shaped seeds of every v2 view (fixtures/v2/<view>.json); `measure --capture-fixtures`
// replaces them with JSON captured from a sandbox v2 contract.
const DIR = new URL("./fixtures/v2/", import.meta.url);
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`${name}.json`, DIR), "utf8"));
const NAMES = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -".json".length))
  .sort();

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Every value of `decoded` is in `raw` at the same place (the decoder drops unknown keys, adds nothing). */
function assertSubset(decoded: unknown, raw: unknown, path = "$"): void {
  if (Array.isArray(decoded)) {
    assert.ok(Array.isArray(raw), `${path}: array expected`);
    assert.equal(decoded.length, (raw as unknown[]).length, `${path}: length`);
    decoded.forEach((v, i) => assertSubset(v, (raw as unknown[])[i], `${path}[${i}]`));
  } else if (typeof decoded === "object" && decoded !== null) {
    assert.ok(typeof raw === "object" && raw !== null, `${path}: object expected`);
    for (const [k, v] of Object.entries(decoded)) assertSubset(v, (raw as Record<string, unknown>)[k], `${path}.${k}`);
  } else {
    assert.equal(decoded, raw, path);
  }
}

/** The first object in a value, depth first (the top object, or the first element's). */
function firstObject(x: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(x)) {
    for (const v of x) {
      const o = firstObject(v);
      if (o) return o;
    }
    return undefined;
  }
  if (typeof x === "object" && x !== null) return x as Record<string, unknown>;
  return undefined;
}

/** Adds a key to every object in `x`. */
function addKeyEverywhere(x: unknown): void {
  if (Array.isArray(x)) x.forEach(addKeyEverywhere);
  else if (typeof x === "object" && x !== null) {
    for (const v of Object.values(x)) addKeyEverywhere(v);
    (x as Record<string, unknown>).zz_added_in_a_later_version = { any: ["thing", 1] };
  }
}

function assertNoBigint(x: unknown, path = "$"): void {
  assert.notEqual(typeof x, "bigint", `${path} became a bigint`);
  if (Array.isArray(x)) x.forEach((v, i) => assertNoBigint(v, `${path}[${i}]`));
  else if (typeof x === "object" && x !== null) for (const [k, v] of Object.entries(x)) assertNoBigint(v, `${path}.${k}`);
}

describe("fixtures", () => {
  it("cover the v2 views (SPEC-C 3.9 and K4-K6)", () => {
    for (const view of ["contract_version", "pause_state", "books", "near_books", "world_supply", "world_prices", "price_check", "lending_tiers", "borrowers", "liquidation_quote", "market_params", "get_proposal", "list_markets", "event_check", "preview_seed_withdraw", "get_events"]) {
      assert.ok(NAMES.includes(view), `fixtures/v2/${view}.json`);
    }
  });

  it("each has a decoder", () => {
    for (const name of NAMES) assert.ok(VIEW_DECODERS[name], `no decoder for ${name}`);
  });
});

for (const name of NAMES) {
  describe(`decode ${name}`, () => {
    const decode = VIEW_DECODERS[name] as (x: unknown, path?: string) => unknown;
    const raw = fixture(name);

    it("accepts its v2 fixture", () => {
      assertSubset(decode(clone(raw)), raw);
    });

    it("rejects a missing key (or a wrong type)", () => {
      const broken = clone(raw);
      const o = firstObject(broken);
      if (o) {
        const key = Object.keys(o)[0] as string;
        delete o[key];
        assert.throws(() => decode(broken), (e: unknown) => e instanceof DecodeError && e.message.includes(`.${key}: missing`));
      } else {
        assert.throws(() => decode(JSON.stringify(raw)), DecodeError);
      }
    });

    it("ignores keys added later", () => {
      const extended = clone(raw);
      addKeyEverywhere(extended);
      const decoded = decode(extended);
      assertSubset(decoded, extended);
      const top = firstObject(decoded);
      assert.ok(top === undefined || !("zz_added_in_a_later_version" in top), "unknown keys are dropped");
    });

    it("keeps u64 values as numbers and U128 values as strings", () => {
      assertNoBigint(decode(clone(raw)));
    });
  });
}

describe("decoder details", () => {
  it("names the path and the expected type", () => {
    const card = clone(fixture("get_market")) as Record<string, unknown>;
    card.pool_value = 612000;
    assert.throws(() => decodeMarketCard(card), { name: "DecodeError", message: "market_card.pool_value: expected U128 string, got number 612000" });
    const pv = clone(fixture("get_proposal")) as { preview: { world_pools: { usdc: unknown }[] } };
    (pv.preview.world_pools[1] as { usdc: unknown }).usdc = "-5";
    assert.throws(() => decodeProposal(pv), /get_proposal\.preview\.world_pools\[1\]\.usdc: expected U128 string/);
  });

  it("refuses anything that is not a u128", () => {
    for (const bad of ["-1", "1.5", "0x10", "", " 1", (1n << 128n).toString(), 5, null]) {
      assert.throws(() => dU128(bad, "x"), DecodeError, JSON.stringify(bad));
    }
    assert.equal(dU128(((1n << 128n) - 1n).toString(), "x"), "340282366920938463463374607431768211455");
  });

  it("keeps u64 as a number and refuses a stringly or unsafe one", () => {
    const v = decodeContractVersion(fixture("contract_version"));
    assert.equal(typeof v.upgraded_at_sec, "number");
    assert.equal(v.legacy_scenario_count, 6);
    assert.throws(() => decodeContractVersion({ ...v, upgraded_at_sec: "1794620000" }), /upgraded_at_sec: expected unsigned integer/);
    assert.throws(() => decodeContractVersion({ ...v, state_version: 2 ** 53 }), /state_version/);
  });

  it("takes null where the view says so, and the nullable views themselves", () => {
    assert.equal(decodeReference(null), null);
    assert.equal(decodeProposal(null), null);
    const ls = decodeLiquidationStatus(fixture("liquidation_status"));
    assert.equal(ls.unpriced_world, null);
    assert.throws(() => decodeLiquidationStatus({ ...ls, status: "stuck" }), /liquidation_status\.status: expected "none" \| "paused"/);
  });

  it("reads own_free as a signed decimal (M-13 fails when it is negative)", () => {
    const nb = decodeNearBooks(fixture("near_books"));
    assert.equal(nb.own_free, "-12000000000000000000000");
    assert.throws(() => decodeNearBooks({ ...nb, own_free: "1e3" }), /own_free: expected signed decimal string/);
  });

  it("MarketParams has the 33 fields of SPEC-C 2.4 (K14)", () => {
    const mp = decodeMarketParams(fixture("market_params"));
    assert.equal(Object.keys(mp.params).length, MARKET_PARAMS_FIELDS);
    assert.deepEqual(mp.params.anchors, [0, 0, 0]);
    assert.throws(() => decodeMarketParams({ ...mp, params: { ...mp.params, anchors: [0, 0] } }), /params\.anchors: expected array of 3/);
  });

  it("K4 event_check has two odds and two prices; K5 adds per_world", () => {
    const ec = decodeEventCheck(fixture("event_check"));
    assert.equal(ec.odds.length, 2);
    assert.throws(() => decodeEventCheck({ ...ec, prices: ["1", "2", "3"] }), /event_check\.prices: expected array of 2/);
    const sw = decodeSeedWithdrawPreview(fixture("preview_seed_withdraw"));
    assert.equal(sw.per_world.usdc.length, 4);
    const withoutPerWorld = clone(fixture("preview_seed_withdraw")) as Record<string, unknown>;
    delete withoutPerWorld.per_world;
    assert.throws(() => decodeSeedWithdrawPreview(withoutPerWorld), /per_world: missing/);
  });
});
