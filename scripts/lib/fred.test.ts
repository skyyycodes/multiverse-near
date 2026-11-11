import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { CUTS, HOLDS, NO_RESULT, bpsFromCsv, fomcOutcome, fredCsvUrl, toBps, type FetchText } from "./fred.ts";

// Real fredgraph.csv responses recorded on 2026-11-11, one file per series and day. The 2026-12-10
// file is trimmed: for a day with no observation yet FRED returned the whole series (6,540 lines).
const fixtures = new URL("./fixtures/fred/", import.meta.url);
const recorded = (name: string): string => readFileSync(new URL(name, fixtures), "utf8");

function fakeFred(overrides: Record<string, string> = {}): { fetchText: FetchText; calls: string[] } {
  const calls: string[] = [];
  const fetchText: FetchText = async (url) => {
    const { searchParams } = new URL(url);
    const key = `${searchParams.get("id")}_${searchParams.get("cosd")}`;
    calls.push(key);
    assert.equal(searchParams.get("coed"), searchParams.get("cosd"));
    return overrides[key] ?? recorded(`${key}.csv`);
  };
  return { fetchText, calls };
}

describe("toBps", () => {
  it("parses rates into integer basis points", () => {
    assert.equal(toBps("4.00"), 400n);
    assert.equal(toBps("3.75"), 375n);
    assert.equal(toBps("0.25"), 25n);
    assert.equal(toBps("5"), 500n);
    assert.equal(toBps("4.5"), 450n);
    assert.equal(toBps("4."), 400n);
    assert.equal(toBps(" 4.00\r"), 400n);
  });

  it("truncates past two decimals instead of rounding", () => {
    assert.equal(toBps("4.129"), 412n);
  });

  it("rejects anything that is not a plain decimal", () => {
    for (const bad of ["", ".", ".5", "-1.00", "+1", "4,00", "1e2", "4.0x", "abc", "4.0.0"]) {
      assert.throws(() => toBps(bad), /not a rate/, bad);
    }
  });
});

describe("bpsFromCsv", () => {
  it("reads the row for the requested day", () => {
    assert.equal(bpsFromCsv(recorded("DFEDTARU_2026-10-27.csv"), "2026-10-27"), 400n);
    assert.equal(bpsFromCsv(recorded("DFEDTARL_2026-10-29.csv"), "2026-10-29"), 375n);
  });

  it("handles CRLF line endings", () => {
    assert.equal(bpsFromCsv("observation_date,DFEDTARL\r\n2026-10-27,3.75\r\n", "2026-10-27"), 375n);
  });

  it("returns null when the day is missing, even though FRED sent the whole series", () => {
    const body = recorded("DFEDTARU_2026-12-10.trimmed.csv");
    assert.equal(bpsFromCsv(body, "2026-12-10"), null);
    assert.equal(bpsFromCsv("", "2026-12-10"), null);
    assert.equal(bpsFromCsv("observation_date,DFEDTARU\n2026-12-100,4.00\n", "2026-12-10"), null);
  });

  it("returns null on an empty or missing observation", () => {
    assert.equal(bpsFromCsv("observation_date,DFEDTARU\n2026-10-27,\n", "2026-10-27"), null);
    assert.equal(bpsFromCsv("observation_date,DFEDTARU\n2026-10-27,.\n", "2026-10-27"), null);
    assert.equal(bpsFromCsv("observation_date,DFEDTARU\n2026-10-27\n", "2026-10-27"), null);
  });

  it("still throws on a value that is not a rate", () => {
    assert.throws(() => bpsFromCsv("observation_date,DFEDTARU\n2026-10-27,n/a\n", "2026-10-27"), /not a rate/);
  });
});

describe("fredCsvUrl", () => {
  it("asks for one day of one series", () => {
    assert.equal(
      fredCsvUrl("DFEDTARU", "2026-10-27"),
      "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFEDTARU&cosd=2026-10-27&coed=2026-10-27",
    );
  });

  it("refuses anything but YYYY-MM-DD", () => {
    assert.throws(() => fredCsvUrl("DFEDTARU", "2026-10-27&id=X"), /not a YYYY-MM-DD date/);
  });
});

describe("fomcOutcome", () => {
  it("October 27-28, 2026: range unchanged at 3.75-4.00, HOLDS", async () => {
    const fred = fakeFred();
    assert.equal(await fomcOutcome("2026-10-27", "2026-10-29", fred), HOLDS);
    assert.deepEqual(fred.calls, ["DFEDTARU_2026-10-29", "DFEDTARU_2026-10-27", "DFEDTARL_2026-10-29", "DFEDTARL_2026-10-27"]);
  });

  it("September 17-18, 2024: both limits down 50 bps, CUTS", async () => {
    assert.equal(await fomcOutcome("2024-09-17", "2024-09-19", fakeFred()), CUTS);
  });

  it("September 15-16, 2026: a hike resolves HOLDS", async () => {
    assert.equal(await fomcOutcome("2026-09-15", "2026-09-17", fakeFred()), HOLDS);
  });

  it("writes nothing when the two limits disagree", async () => {
    const onlyUpperCut = fakeFred({ "DFEDTARU_2026-10-29": "observation_date,DFEDTARU\n2026-10-29,3.75\n" });
    assert.equal(await fomcOutcome("2026-10-27", "2026-10-29", onlyUpperCut), NO_RESULT);
    const onlyLowerCut = fakeFred({ "DFEDTARL_2026-10-29": "observation_date,DFEDTARL\n2026-10-29,3.50\n" });
    assert.equal(await fomcOutcome("2026-10-27", "2026-10-29", onlyLowerCut), NO_RESULT);
  });

  it("NO_RESULT, never HOLDS, when FRED has no row yet, without reading anything else", async () => {
    const fred = fakeFred({ "DFEDTARU_2026-12-10": recorded("DFEDTARU_2026-12-10.trimmed.csv") });
    assert.equal(await fomcOutcome("2026-12-08", "2026-12-10", fred), NO_RESULT);
    assert.deepEqual(fred.calls, ["DFEDTARU_2026-12-10"]);
  });

  it("NO_RESULT when only a later read is missing", async () => {
    const fred = fakeFred({ "DFEDTARL_2026-10-27": "observation_date,DFEDTARL\n2026-10-27,.\n" });
    assert.equal(await fomcOutcome("2026-10-27", "2026-10-29", fred), NO_RESULT);
    assert.equal(fred.calls.length, 4);
  });

  it("propagates fetch errors", async () => {
    const failing: FetchText = async (url) => {
      throw new Error(`GET ${url} answered HTTP 503`);
    };
    await assert.rejects(fomcOutcome("2026-10-27", "2026-10-29", { fetchText: failing }), /HTTP 503/);
  });

  it(
    "live: FRED says the October 27-28, 2026 meeting HOLDS",
    { skip: process.env.FRED_LIVE === "1" ? false : "set FRED_LIVE=1 to query fred.stlouisfed.org", timeout: 120_000 },
    async () => {
      assert.equal(await fomcOutcome("2026-10-27", "2026-10-29"), HOLDS);
    },
  );
});
