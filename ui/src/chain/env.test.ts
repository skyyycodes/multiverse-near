import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAIN, NETWORKS, gitSha, networkEnv, webVersion } from "../../scripts/network.mjs";

function deployments(files: Record<string, object>): string {
  const dir = mkdtempSync(join(tmpdir(), "ifverse-deployments-"));
  for (const [network, body] of Object.entries(files)) writeFileSync(join(dir, `${network}.json`), JSON.stringify(body));
  return dir;
}

const STAGING = {
  rpcUrl: "https://test.rpc.fastnear.com",
  contractId: "app.ifverse-staging.testnet",
  wnear: "wnear.ifverse-staging.testnet",
  usdc: "usdc.ifverse-staging.testnet",
  explorer: "https://testnet.nearblocks.io",
};

describe("networks and build settings", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("knows four networks on two chains", () => {
    expect(NETWORKS).toEqual(["testnet", "staging", "sandbox", "rehearsal"]);
    expect(CHAIN).toEqual({ testnet: "testnet", staging: "testnet", sandbox: "sandbox", rehearsal: "sandbox" });
  });

  it("builds staging on the testnet chain with the ids of deployments/staging.json", () => {
    const dir = deployments({ staging: STAGING });
    const e = networkEnv("staging", { GIT_SHA: "abcdef0123" }, dir);
    expect(e).toMatchObject({
      NEXT_PUBLIC_NETWORK: "staging",
      NEXT_PUBLIC_CHAIN: "testnet",
      NEXT_PUBLIC_CONTRACT_ID: "app.ifverse-staging.testnet",
      NEXT_PUBLIC_WNEAR_ID: "wnear.ifverse-staging.testnet",
      NEXT_PUBLIC_USDC_ID: "usdc.ifverse-staging.testnet",
      NEXT_PUBLIC_RPC_URL: "https://test.rpc.fastnear.com",
      NEXT_PUBLIC_EXPLORER: "https://testnet.nearblocks.io",
      NEXT_PUBLIC_WEB_VERSION: "2.1.0",
      NEXT_PUBLIC_GIT_SHA: "abcdef0",
      NEXT_PUBLIC_STATE_VERSION: "2",
      NEXT_PUBLIC_PRELAUNCH: "0",
    });
    // staging and production are never reset, whatever the environment says
    expect(e.NEXT_PUBLIC_RESET_COMMAND).toBe("");
    expect(networkEnv("staging", { NEXT_PUBLIC_RESET_COMMAND: "pnpm reset" }, dir).NEXT_PUBLIC_RESET_COMMAND).toBe("");
    // a value set in the environment wins over the file
    expect(networkEnv("staging", { NEXT_PUBLIC_CONTRACT_ID: "app2.ifverse-staging.testnet" }, dir).NEXT_PUBLIC_CONTRACT_ID).toBe(
      "app2.ifverse-staging.testnet",
    );
    expect(networkEnv("staging", { NEXT_PUBLIC_PRELAUNCH: "1" }, dir).NEXT_PUBLIC_PRELAUNCH).toBe("1");
  });

  it("gives the local networks their reset command and production none", () => {
    const local = { rpcUrl: "http://127.0.0.1:3030", contractId: "app.test.near", wnear: "wnear.test.near", usdc: "usdc.test.near" };
    const dir = deployments({ sandbox: local, rehearsal: { ...local, contractId: "app.multiverse-near.testnet" }, testnet: STAGING });
    expect(networkEnv("rehearsal", {}, dir)).toMatchObject({
      NEXT_PUBLIC_CHAIN: "sandbox",
      NEXT_PUBLIC_RESET_COMMAND: "NEAR_NETWORK=rehearsal pnpm -C scripts rehearse import",
    });
    expect(networkEnv("sandbox", {}, dir).NEXT_PUBLIC_RESET_COMMAND).toBe("NEAR_NETWORK=sandbox RUN_SALE=false pnpm -C scripts reset");
    expect(networkEnv("testnet", {}, dir).NEXT_PUBLIC_RESET_COMMAND).toBe("");
    // the design-data build shows the reset block as on the sandbox
    expect(networkEnv("testnet", { NEXT_PUBLIC_FIXTURES: "1" }, dir).NEXT_PUBLIC_RESET_COMMAND).toBe(
      "NEAR_NETWORK=sandbox RUN_SALE=false pnpm -C scripts reset",
    );
  });

  it("says how to create a missing deployment file, per network", () => {
    const dir = deployments({});
    expect(() => networkEnv("testnet", {}, dir)).toThrow(/testnet\.json is missing; run pnpm -C scripts accounts$/);
    expect(() => networkEnv("staging", {}, dir)).toThrow(/staging\.json is missing; run NEAR_NETWORK=staging pnpm -C scripts accounts --root ifverse-staging\.testnet/);
    expect(() => networkEnv("sandbox", {}, dir)).toThrow(/sandbox\.json is missing; start the local node first/);
    expect(() => networkEnv("rehearsal", {}, dir)).toThrow(/rehearsal\.json is missing; import production state first/);
    expect(() => networkEnv("mainnet", {}, dir)).toThrow(/must be one of testnet, staging, sandbox, rehearsal/);
  });

  it("reads the git sha from GIT_SHA, else the checkout, else says dev", () => {
    expect(gitSha({ GIT_SHA: "0123456789abcdef" })).toBe("0123456");
    expect(gitSha({})).toMatch(/^[0-9a-f]{7}$/);
    expect(gitSha({}, mkdtempSync(join(tmpdir(), "ifverse-no-git-")))).toBe("dev");
    expect(webVersion()).toBe("2.1.0");
  });

  it("derives the chain and the badge label from the build variables", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "staging");
    vi.stubEnv("NEXT_PUBLIC_CHAIN", "testnet");
    vi.stubEnv("NEXT_PUBLIC_CONTRACT_ID", "app.ifverse-staging.testnet");
    vi.stubEnv("NEXT_PUBLIC_RPC_URL", "https://test.rpc.fastnear.com");
    let m = await import("./env");
    expect(m.ENV).toMatchObject({ network: "staging", chain: "testnet", contractId: "app.ifverse-staging.testnet", resetCommand: "" });
    expect(m.ENV.rpcUrls).toEqual(["https://near-testnet.drpc.org", "https://test.rpc.fastnear.com", "https://rpc.testnet.fastnear.com"]);
    expect(m.networkLabel()).toBe("staging · testnet");

    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "rehearsal");
    vi.stubEnv("NEXT_PUBLIC_CHAIN", "sandbox");
    vi.stubEnv("NEXT_PUBLIC_RPC_URL", "http://127.0.0.1:3030");
    m = await import("./env");
    expect(m.ENV.rpcUrls).toEqual(["http://127.0.0.1:3030"]);
    expect(m.networkLabel()).toBe("rehearsal · sandbox");

    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "testnet");
    vi.stubEnv("NEXT_PUBLIC_CHAIN", "testnet");
    m = await import("./env");
    expect(m.networkLabel()).toBe("testnet");
    expect(m.ENV.stateVersion).toBe(2);
  });
});
