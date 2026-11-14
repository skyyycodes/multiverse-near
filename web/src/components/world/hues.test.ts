import { describe, expect, it } from "vitest";
import { DEAD, HUES, hueOf, initials, isHatched } from "./hues";

describe("eight-world hues", () => {
  it("repeats the four hues for worlds 4-7 and hatches them", () => {
    expect(HUES).toHaveLength(8);
    for (let i = 0; i < 4; i++) expect(hueOf(i + 4)).toBe(hueOf(i));
    expect([0, 3, 4, 7].map(isHatched)).toEqual([false, false, true, true]);
    expect(hueOf(5, false)).toBe(DEAD);
  });

  it("shortens three-event labels to initials", () => {
    expect(initials("SHIPS·CUTS·YES")).toBe("S·C·Y");
    expect(initials("SHIPS")).toBe("S");
  });
});
