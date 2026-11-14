import { describe, expect, it } from "vitest";
import { joinWords, pauseText } from "./PauseBanner";

describe("the pause banner's words", () => {
  it("joins flag names as a sentence", () => {
    expect(joinWords([])).toBe("");
    expect(joinWords(["trading"])).toBe("trading");
    expect(joinWords(["trading", "lending"])).toBe("trading and lending");
    expect(joinWords(["trading", "lending", "liquidations"])).toBe("trading, lending and liquidations");
  });

  it("names the paused flags and what still works", () => {
    expect(pauseText([], 0n)).toBeUndefined();
    expect(pauseText(["trade", "lend"], 0n)).toEqual({
      title: "IfVerse is paused for maintenance: trading and lending.",
      detail: "Repay, adding collateral and withdrawals still work.",
    });
    expect(pauseText(["exit"], 0n)?.detail).toBe("Repay and adding collateral still work.");
  });

  it("counts down the liquidation grace, alone or with a pause", () => {
    expect(pauseText([], 724n)).toEqual({ title: "IfVerse is back from maintenance.", detail: "Liquidations resume in 12:04." });
    expect(pauseText(["oracle"], 60n)?.detail).toBe("Repay, adding collateral and withdrawals still work. Liquidations resume in 1:00.");
  });
});
