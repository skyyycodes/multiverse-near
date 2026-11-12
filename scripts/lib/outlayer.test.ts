import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEMO_EVENTS } from "./demo.ts";
import {
  configMatches,
  datesMatch,
  datesMisfit,
  multiverseEvents,
  outlayerResult,
  parseDates,
  parseSha256,
  parseWasmUrl,
  sha256Hex,
  type FomcDates,
  type OutLayerConfig,
} from "./outlayer.ts";
import type { EventView } from "./protocol.ts";

const PAST_FED = DEMO_EVENTS.find((e) => e.key === "pastFed")!;
const HASH = "8c809e11f5b4b37627baa5c0a65a8587ef5f3e4918d1e0bb42cb2f87a5ae1660";
const URL_OK = "https://multiverse-lending.vercel.app/outlayer/fred-guest.wasm";

function pastFed(patch: Partial<EventView> = {}): EventView {
  return {
    id: 24,
    question: PAST_FED.question,
    rule: PAST_FED.rule,
    outcome_names: [...PAST_FED.outcomeNames],
    deadline_sec: PAST_FED.deadlineSec,
    proposed_at_sec: 0,
    proposed_outcome: 0,
    proposal_open: false,
    finalized: false,
    outcome: 0,
    finalizable_at_sec: 0,
    proposed_by: null,
    ...patch,
  };
}

const config = (patch: Partial<OutLayerConfig> = {}): OutLayerConfig => ({
  outlayer_id: "outlayer.testnet",
  wasm_url: URL_OK,
  wasm_sha256: HASH,
  resource_limits: { max_instructions: 1_000_000_000, max_memory_mb: 128, max_execution_seconds: 30 },
  deposit: "5000000000000000000000",
  ...patch,
});

const event = (name: string, data: unknown, standard = "multiverse"): string =>
  `EVENT_JSON:${JSON.stringify({ standard, version: "1.0.0", event: name, data: [data] })}`;

describe("sha256Hex", () => {
  it("hashes bytes to lowercase hex", () => {
    assert.equal(sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("parseSha256", () => {
  it("accepts 64 lowercase hex characters", () => {
    assert.equal(parseSha256(HASH), HASH);
  });

  it("refuses uppercase, short and prefixed hashes", () => {
    assert.throws(() => parseSha256(HASH.toUpperCase()), /64 lowercase hex/);
    assert.throws(() => parseSha256(HASH.slice(1)), /64 lowercase hex/);
    assert.throws(() => parseSha256(`0x${HASH.slice(2)}`), /64 lowercase hex/);
  });
});

describe("parseWasmUrl", () => {
  it("accepts an https URL", () => {
    assert.equal(parseWasmUrl(URL_OK), URL_OK);
  });

  it("refuses what the contract refuses", () => {
    assert.throws(() => parseWasmUrl("http://example.com/a.wasm"), /not https/);
    assert.throws(() => parseWasmUrl("https://"), /not https/);
    assert.throws(() => parseWasmUrl(`https://example.com/${"a".repeat(2048)}`), /too long/);
    assert.throws(() => parseWasmUrl("https://example.com/a b.wasm"), /whitespace/);
    assert.throws(() => parseWasmUrl("https://example.com/a\u0007.wasm"), /whitespace/);
    assert.throws(() => parseWasmUrl("https://example.com/EVENT_JSON.wasm"), /EVENT_JSON/);
  });
});

describe("parseDates", () => {
  it("accepts two dates in order", () => {
    assert.deepEqual(parseDates("2026-10-27", "2026-10-29"), { before: "2026-10-27", after: "2026-10-29" });
  });

  it("refuses other formats and dates out of order", () => {
    assert.throws(() => parseDates("2026-10-7", "2026-10-29"), /--before must be YYYY-MM-DD/);
    assert.throws(() => parseDates("2026-10-27", "29/10/2026"), /--after must be YYYY-MM-DD/);
    assert.throws(() => parseDates("2026-10-29", "2026-10-29"), /not earlier/);
    assert.throws(() => parseDates("2026-10-29", "2026-10-27"), /not earlier/);
  });
});

describe("datesMisfit", () => {
  it("accepts the past Fed event with the dates its rule names", () => {
    assert.equal(datesMisfit(pastFed(), "2026-10-27", "2026-10-29"), null);
  });

  it("refuses dates the rule does not name", () => {
    assert.match(datesMisfit(pastFed(), "2026-10-27", "2026-10-30") ?? "", /does not mention 2026-10-30/);
  });

  it("refuses a finalized event and one with other outcomes", () => {
    assert.match(datesMisfit(pastFed({ finalized: true }), "2026-10-27", "2026-10-29") ?? "", /already finalized/);
    assert.match(datesMisfit(pastFed({ outcome_names: ["SHIPS", "DELAYED"] }), "2026-10-27", "2026-10-29") ?? "", /not CUTS\/HOLDS/);
    assert.match(datesMisfit(pastFed({ outcome_names: ["HOLDS", "CUTS"] }), "2026-10-27", "2026-10-29") ?? "", /not CUTS\/HOLDS/);
  });
});

describe("configMatches and datesMatch", () => {
  it("match only the same URL and hash", () => {
    assert.equal(configMatches(null, URL_OK, HASH), false);
    assert.equal(configMatches(config(), URL_OK, HASH), true);
    assert.equal(configMatches(config({ wasm_url: `${URL_OK}?v=2` }), URL_OK, HASH), false);
    assert.equal(configMatches(config({ wasm_sha256: "0".repeat(64) }), URL_OK, HASH), false);
  });

  it("match the same dates whatever the request count", () => {
    const dates: FomcDates = { before: "2026-10-27", after: "2026-10-29", pending: true, request: 3 };
    assert.equal(datesMatch(null, "2026-10-27", "2026-10-29"), false);
    assert.equal(datesMatch(dates, "2026-10-27", "2026-10-29"), true);
    assert.equal(datesMatch(dates, "2026-10-28", "2026-10-29"), false);
  });
});

describe("multiverseEvents and outlayerResult", () => {
  const logs = [
    "not an event",
    "EVENT_JSON:{broken",
    event("outlayer_requested", { event_id: 24, request: 1, payer_id: "leo.multiverse-lending.testnet" }),
    event("execution_completed", { request_id: 7 }, "near-outlayer"),
    event("outlayer_result", { event_id: 24, request: 0, outcome: null, proposed: false, note: "stale request" }),
    event("outlayer_result", { event_id: 24, request: 1, outcome: 1, proposed: true, note: "FRED ...: HOLDS" }),
  ];

  it("reads only the multiverse standard", () => {
    assert.deepEqual(multiverseEvents(logs, "execution_completed"), []);
    assert.deepEqual(multiverseEvents(logs, "outlayer_requested"), [{ event_id: 24, request: 1, payer_id: "leo.multiverse-lending.testnet" }]);
  });

  it("finds the result of one run", () => {
    assert.deepEqual(outlayerResult(logs, 24, 1), { event_id: 24, request: 1, outcome: 1, proposed: true, note: "FRED ...: HOLDS" });
    assert.equal(outlayerResult(logs, 24, 0)?.note, "stale request");
    assert.equal(outlayerResult(logs, 24, 2), undefined);
    assert.equal(outlayerResult(logs, 23, 1), undefined);
  });
});
