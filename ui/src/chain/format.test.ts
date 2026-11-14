import { describe, expect, it } from "vitest";
import {
  referenceOrigin,
  accountLabel,
  countdown,
  fmt,
  fmtFloat,
  fmtBps,
  fmtCompactUsd,
  fmtPct,
  parseUtcInput,
  relTime,
  utcInputValue,
  utf8Bytes,
  fmtHf,
  fmtAsset,
  fmtNear,
  fmtPrice,
  fmtUsd,
  hfTone,
  inputText,
  parseAmount,
  pct,
  shortAccount,
  utcDate,
} from "./format";

const E18 = 10n ** 18n;
const wad = (s: string) => parseAmount(s)!;

describe("fmt", () => {
  it("truncates toward zero and groups thousands", () => {
    expect(fmt(1_999_999_999_999_999_999n)).toBe("1.99");
    expect(fmt(1_234_567n * E18)).toBe("1,234,567.00");
    expect(fmt(wad("4881.885259897065638949"))).toBe("4,881.88");
    // the chart's label and the pool quote agree: both cut, neither rounds up
    expect(fmt(4_180_897_820_415_224_974n, 4)).toBe("4.1808");
    expect(fmtFloat(Number(4_180_897_820_415_224_974n) / 1e18, 4)).toBe("4.1808");
    expect(fmtFloat(0.1 + 0.2, 4)).toBe("0.3000");
    expect(fmt(0n)).toBe("0.00");
  });

  it("takes a digit count", () => {
    expect(fmt(wad("2.00009"), 4)).toBe("2.0000");
    expect(fmt(wad("2450.99"), 0)).toBe("2,450");
    expect(fmt(wad("0.5"), 1)).toBe("0.5");
  });

  it("signs negatives but never a value that shows as zero", () => {
    expect(fmt(-wad("1.5"))).toBe("-1.50");
    expect(fmt(-1n)).toBe("0.00");
    expect(fmt(-(E18 / 1000n))).toBe("0.00");
    expect(fmtUsd(-wad("124.31"))).toBe("-$124.31");
    expect(fmtUsd(-1n)).toBe("$0.00");
    expect(fmtPrice(-wad("0.0001"))).toBe("-$0.0001");
    expect(fmtPrice(-(E18 / 100_000n))).toBe("$0.0000");
  });

  it("has the screen variants", () => {
    expect(fmtAsset("wnear", wad("2000"))).toBe("2,000.00");
    expect(fmtAsset("usdc", wad("4881.885259"))).toBe("4,881.8852");
    expect(fmtUsd(wad("4881.885259"))).toBe("$4,881.88");
    expect(fmtNear(wad("2000"))).toBe("2,000.00");
    expect(fmtNear(wad("0.5"))).toBe("0.50");
  });

  it("never shows a NEAR price in whole dollars", () => {
    expect(fmtUsd(wad("3.7"))).toBe("$3.70");
    expect(fmtUsd(wad("2.45"))).toBe("$2.45");
    // actual against implied spot: cents would show both as $3.03
    expect(fmtPrice(wad("3.037866632"))).toBe("$3.0378");
    expect(fmtPrice(wad("3.0376933"))).toBe("$3.0376");
    expect(fmtPrice(wad("2.45"))).toBe("$2.4500");
    expect(inputText(wad("3643.1052"), 2)).toBe("3643.10");
  });
});

describe("parseAmount", () => {
  it("parses plain decimals into 18-decimal units", () => {
    expect(parseAmount("2")).toBe(2n * E18);
    expect(parseAmount(" 0.5 ")).toBe(E18 / 2n);
    expect(parseAmount("1.000000000000000001")).toBe(E18 + 1n);
  });

  it("rejects what is not a positive plain number", () => {
    for (const bad of ["", "0", "0.000", "-1", "+1", "1e3", ".5", "5.", "1,000", "1 2", "abc", "1.0000000000000000001"]) {
      expect(parseAmount(bad), bad).toBeUndefined();
    }
  });

  it("refuses precision the token does not have", () => {
    expect(parseAmount("1.123456", 6)).toBe(1_123_456n * 10n ** 12n);
    expect(parseAmount("1.1234567", 6)).toBeUndefined();
    expect(parseAmount("3000", 6)).toBe(3000n * E18);
  });
});

describe("pct", () => {
  it("rounds half up", () => {
    expect(pct(1n, 3n)).toBe("33.3%");
    expect(pct(2n, 3n)).toBe("66.7%");
    expect(pct(1n, 8n, 2)).toBe("12.50%");
    expect(pct(1n, 2000n, 2)).toBe("0.05%");
    expect(pct(3n, 4n, 0)).toBe("75%");
    expect(pct(wad("0.75"), E18, 0)).toBe("75%");
  });

  it("shows a dash for a zero whole", () => {
    expect(pct(5n, 0n)).toBe("—");
  });

  it("formats the seeded odds", () => {
    // 2x2 odds at ships 6667 bps, cuts 104 bps
    expect(pct(wad("0.32983368"), E18)).toBe("33.0%");
    expect(pct(wad("0.00693368"), E18)).toBe("0.7%");
  });
});

describe("time and health factor", () => {
  it("counts down as m:ss and never below zero", () => {
    expect(countdown(29n)).toBe("0:29");
    expect(countdown(90n)).toBe("1:30");
    expect(countdown(-5n)).toBe("0:00");
  });

  it("prints UTC minutes", () => {
    expect(utcDate(1798761599)).toBe("2026-12-31 23:59 UTC");
    expect(utcDate(1796842800n)).toBe("2026-12-09 19:00 UTC");
  });

  it("shows infinity without debt and tones by threshold", () => {
    expect(fmtHf(null)).toBe("∞");
    expect(fmtHf(wad("1.220471314974266409"))).toBe("1.22");
    expect(hfTone(null)).toBe("ok");
    expect(hfTone(wad("1.5"))).toBe("ok");
    expect(hfTone(wad("1.499999"))).toBe("warn");
    expect(hfTone(wad("1.1"))).toBe("warn");
    expect(hfTone(wad("1.099999"))).toBe("bad");
  });
});

describe("accounts", () => {
  it("keeps named accounts readable and shortens implicit ones", () => {
    expect(shortAccount("alice.testnet")).toBe("alice.testnet");
    expect(shortAccount("a".repeat(64))).toBe("aaaaaa…aaaa");
    expect(shortAccount("alice.multiverse-lending.testnet")).toBe("alice.multiverse-len…");
    expect(accountLabel("ravi.test.near")).toBe("ravi.test.near");
    expect(accountLabel("ravi.multiverse-lending.testnet")).toBe("ravi.multiv….testnet");
    expect(accountLabel("ravi.multiverse-lending.testnet").length).toBe(20);
    expect(accountLabel("ravi.multiverse-lending.testnet")).not.toBe(accountLabel("ravi.other-lending.testnet"));
    expect(accountLabel("f".repeat(64))).toBe("ffffff…ffff");
  });
});

describe("v2 formats", () => {
  const usd = (s: string) => parseAmount(s)!;
  it("compact dollars, truncated toward zero, at every boundary", () => {
    expect(fmtCompactUsd(usd("950"))).toBe("$950");
    expect(fmtCompactUsd(usd("999.99"))).toBe("$999.99");
    expect(fmtCompactUsd(usd("999.999"))).toBe("$999.99");
    expect(fmtCompactUsd(usd("1000"))).toBe("$1.0k");
    expect(fmtCompactUsd(usd("42150"))).toBe("$42.1k");
    expect(fmtCompactUsd(usd("999999.99"))).toBe("$999.9k");
    expect(fmtCompactUsd(usd("1000000"))).toBe("$1.00M");
    expect(fmtCompactUsd(usd("1259999"))).toBe("$1.25M");
    expect(fmtCompactUsd(usd("2500000000"))).toBe("$2.50B");
    expect(fmtCompactUsd(0n)).toBe("$0");
    expect(fmtCompactUsd(-usd("42150"))).toBe("-$42.1k");
  });

  it("basis points and WAD fractions as percentages", () => {
    expect(fmtBps(6_700)).toBe("67%");
    expect(fmtBps(6_931)).toBe("69.31%");
    expect(fmtBps(6_930)).toBe("69.3%");
    expect(fmtBps(12_100)).toBe("121%");
    expect(fmtBps(0)).toBe("0%");
    expect(fmtPct(400_000_000_000_000_000n, 1)).toBe("40.0%");
    expect(fmtPct(666_666_666_666_666_667n, 2)).toBe("66.67%");
  });

  it("relative times", () => {
    expect(relTime(5 * 86_400 + 100)).toBe("in 5 d");
    expect(relTime(3 * 3_600)).toBe("in 3 h");
    expect(relTime(12 * 60 + 59)).toBe("in 12 min");
    expect(relTime(40)).toBe("in 40 s");
    expect(relTime(0)).toBe("now");
    expect(relTime(-120)).toBe("2 min ago");
    expect(relTime(-90_000n)).toBe("1 d ago");
  });

  it("counts UTF-8 bytes as the contract does", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("€")).toBe(3);
    expect(utf8Bytes("🌍")).toBe(4);
  });

  it("reads and writes datetime-local values as UTC", () => {
    expect(utcInputValue(1_814_399_999)).toBe("2027-06-30T23:59");
    expect(parseUtcInput("2027-06-30T23:59")).toBe(1_814_399_940);
    expect(parseUtcInput("2027-06-30T23:59:59")).toBe(1_814_399_999);
    expect(parseUtcInput("2027-02-30T10:00")).toBeUndefined();
    expect(parseUtcInput("")).toBeUndefined();
    expect(parseUtcInput("tomorrow")).toBeUndefined();
  });
});

describe("referenceOrigin", () => {
  it("counts sources for an aggregated reading and names the reporter for a posted one", () => {
    expect(referenceOrigin({ source: "outlayer", sourcesUsed: 4, spreadBps: 83 })).toBe("4 sources · spread 0.83%");
    expect(referenceOrigin({ source: "outlayer", sourcesUsed: 1, spreadBps: 0 })).toBe("1 source · spread 0%");
    expect(referenceOrigin({ source: "reporter", sourcesUsed: 0, spreadBps: 0 })).toBe("the reporter");
    expect(referenceOrigin({ source: "outlayer", sourcesUsed: 0, spreadBps: 0 })).toBe("OutLayer (TEE)");
  });
});
