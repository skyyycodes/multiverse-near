import { describe, expect, it } from "vitest";
import { KEEPER_PING_EVERY_MS, KEEPER_PING_PATH, pingDue, pingKeeper } from "./keeper-ping";

function memory(): Pick<Storage, "getItem" | "setItem"> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("keeper ping", () => {
  it("is due when never sent, after a minute, or when the stored time is unreadable or ahead", () => {
    expect(pingDue(null, 1_000)).toBe(true);
    expect(pingDue(1_000, 1_000 + KEEPER_PING_EVERY_MS - 1)).toBe(false);
    expect(pingDue(1_000, 1_000 + KEEPER_PING_EVERY_MS)).toBe(true);
    expect(pingDue(Number.NaN, 1_000)).toBe(true);
    expect(pingDue(5_000, 1_000)).toBe(true);
  });

  it("sends at most once a minute per browser, to the slash path, and only from a visible tab", () => {
    const storage = memory();
    const sent: string[] = [];
    const env = (now: number, visible = true) => ({ now, storage, visible, send: async (p: string) => void sent.push(p) });
    expect(pingKeeper(env(10_000), true)).toBe(true);
    expect(pingKeeper(env(30_000), true)).toBe(false);
    expect(pingKeeper(env(10_000 + KEEPER_PING_EVERY_MS, false), true)).toBe(false);
    expect(pingKeeper(env(10_000 + KEEPER_PING_EVERY_MS), true)).toBe(true);
    expect(sent).toEqual([KEEPER_PING_PATH, KEEPER_PING_PATH]);
    expect(KEEPER_PING_PATH).toBe("/api/keeper/");
  });

  it("never pings from a build without a hosted keeper, and survives blocked storage and a failed request", () => {
    const sent: string[] = [];
    expect(pingKeeper({ now: 1, storage: memory(), visible: true, send: async (p) => void sent.push(p) }, false)).toBe(false);
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(pingKeeper({ now: 1, storage: blocked, visible: true, send: () => Promise.reject(new Error("offline")) }, true)).toBe(true);
    expect(sent).toEqual([]);
  });
});
