import { beforeEach, describe, expect, it } from "vitest";
import { noteChainTime, resetChainTime } from "./useClock";

describe("chain clock", () => {
  beforeEach(() => resetChainTime());

  it("never steps back when an older block arrives later", () => {
    noteChainTime({ sec: 1_000n, at: 10_000 }, 10_000);
    // a lagging node answers with a block one second older, read three seconds later
    const kept = noteChainTime({ sec: 999n, at: 13_000 }, 13_000);
    expect(kept).toEqual({ sec: 1_000n, at: 10_000 });
  });

  it("moves to a newer block that is ahead of the projection", () => {
    noteChainTime({ sec: 1_000n, at: 10_000 }, 10_000);
    const kept = noteChainTime({ sec: 1_600n, at: 12_000 }, 12_000);
    expect(kept.sec).toBe(1_600n);
  });
});
