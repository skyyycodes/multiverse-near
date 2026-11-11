import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cutsBpsFromGamma, fedCutsOdds, POLYMARKET_FED_SLUG } from "./polymarket.ts";

const market = (question: string, yes: string): Record<string, string> => ({
  question,
  outcomes: JSON.stringify(["Yes", "No"]),
  outcomePrices: JSON.stringify([yes, (1 - Number(yes)).toFixed(4)]),
});

// The shape of the gamma answer on 2026-11-06: 0.35% + 0.65% cut, out of 99.55% in Yes prices.
const NOV_6 = [
  {
    slug: POLYMARKET_FED_SLUG,
    closed: false,
    markets: [
      market("Fed decreases interest rates by 50+ bps after December 2026 meeting?", "0.0035"),
      market("Fed decreases interest rates by 25 bps after December 2026 meeting?", "0.0065"),
      market("No change in Fed interest rates after December 2026 meeting?", "0.98"),
      market("Fed increases interest rates by 25+ bps after December 2026 meeting?", "0.0055"),
    ],
  },
];

describe("Polymarket odds", () => {
  it("the 2026-11-06 reading is 100 bps", () => {
    assert.equal(cutsBpsFromGamma(NOV_6), 100);
  });

  it("rounds half up and clamps to 1..9999", () => {
    const half = [{ closed: false, markets: [market("decrease", "0.00005"), market("no change", "0.99995")] }];
    assert.equal(cutsBpsFromGamma(half), 1);
    const none = [{ closed: false, markets: [market("decrease", "0"), market("no change", "1")] }];
    assert.equal(cutsBpsFromGamma(none), 1);
    const all = [{ closed: false, markets: [market("decrease", "1"), market("no change", "0")] }];
    assert.equal(cutsBpsFromGamma(all), 9999);
    const exact = [{ closed: false, markets: [market("Decrease 25", "0.12345"), market("hold", "0.87655")] }];
    assert.equal(cutsBpsFromGamma(exact), 1235);
  });

  it("refuses answers it cannot read", () => {
    assert.throws(() => cutsBpsFromGamma([]), /expected one Polymarket event, got 0/);
    assert.throws(() => cutsBpsFromGamma([{ closed: true, markets: [] }]), /closed/);
    assert.throws(() => cutsBpsFromGamma([{ closed: false, markets: [market("no change", "1")] }]), /no cut market/);
    assert.throws(() => cutsBpsFromGamma([{ closed: false, markets: [market("decrease", "1e-3")] }]), /not a price/);
  });

  it("falls back to 100 bps and says so", async () => {
    const offline = await fedCutsOdds({}, () => Promise.reject(new Error("offline")));
    assert.equal(offline.cutsBps, 100);
    assert.match(offline.source, /as read on 2026-11-06 \(offline fallback\)$/);
    const live = await fedCutsOdds({}, () => Promise.resolve(NOV_6), () => new Date("2026-11-11T10:00:00.123Z"));
    assert.deepEqual(live, { cutsBps: 100, source: `Fed: Polymarket ${POLYMARKET_FED_SLUG} at 2026-11-11T10:00:00Z`, live: true });
    const fixed = await fedCutsOdds({ ODDS_CUTS_BPS: "104" }, () => Promise.reject(new Error("not called")));
    assert.equal(fixed.cutsBps, 104);
  });
});
