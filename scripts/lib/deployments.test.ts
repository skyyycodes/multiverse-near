import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { existsSync } from "node:fs";

import {
  accountIds,
  appendHistory,
  DEPLOYMENTS_PATH,
  deploymentsPath,
  goneLive,
  heldEvents,
  optionalFieldsError,
  ownerOf,
  readDeployments,
  requireDeployments,
  writeDeployments,
  type Deployments,
} from "./deployments.ts";

const token = (accountId: string, symbol: string, decimals: number): Deployments["tokens"]["wnear"] => ({
  accountId,
  name: symbol,
  symbol,
  decimals,
  maxMintPerCall: "1000",
  codeHash: "2nXWwkLzL1CnGtQD1AK7H6pM58vGCfgx5UB5shVcexZh",
});

function sample(): Deployments {
  const ids = accountIds("example.testnet");
  return {
    network: "testnet",
    rpcUrl: "https://test.rpc.fastnear.com",
    explorer: "https://testnet.nearblocks.io",
    ...ids,
    tokens: { wnear: token(ids.wnear, "wNEAR", 24), usdc: token(ids.usdc, "USDC", 6) },
    contract: null,
    updatedAt: "",
  };
}

describe("accountIds", () => {
  it("names every account under the root, as in the design", () => {
    const ids = accountIds("multiverse-near.testnet");
    assert.equal(ids.contractId, "app.multiverse-near.testnet");
    assert.equal(ids.wnear, "wnear.multiverse-near.testnet");
    assert.equal(ids.usdc, "usdc.multiverse-near.testnet");
    assert.equal(ids.reporter, "resolver.multiverse-near.testnet");
    assert.deepEqual(Object.keys(ids.personas), ["alice", "bob", "ravi", "sam", "uma", "carl", "leo", "resolver"]);
    assert.equal(ids.personas.carl, "carl.multiverse-near.testnet");
  });
});

describe("deployments file", () => {
  const dir = mkdtempSync(join(tmpdir(), "mv-deployments-"));

  it("round-trips and stamps the write time", async () => {
    const path = join(dir, "testnet.json");
    assert.equal(await readDeployments(path), undefined);
    await writeDeployments(sample(), path);
    const back = await requireDeployments(path);
    assert.deepEqual({ ...back, updatedAt: "" }, sample());
    assert.ok(!Number.isNaN(Date.parse(back.updatedAt)));
  });

  it("refuses files that are not a testnet deployments file", async () => {
    const path = join(dir, "broken.json");
    const withoutPersonas: Partial<Deployments> = sample();
    delete withoutPersonas.personas;
    writeFileSync(path, JSON.stringify(withoutPersonas));
    await assert.rejects(readDeployments(path), /does not look like a testnet deployments file/);
    writeFileSync(path, JSON.stringify({ ...sample(), network: "mainnet" }));
    await assert.rejects(readDeployments(path), /does not look like/);
    await assert.rejects(requireDeployments(join(dir, "missing.json")), /is missing; run `pnpm accounts` first/);
  });

  it("deployments/testnet.json is valid and holds no keys", async () => {
    const d = await requireDeployments(DEPLOYMENTS_PATH);
    assert.equal(d.root, "multiverse-near.testnet");
    assert.equal(d.tokens.usdc.decimals, 6);
    assert.equal(d.tokens.wnear.decimals, 24);
    assert.equal(d.tokens.wnear.accountId, "wnear.multiverse-near.testnet");
    assert.equal(BigInt(d.tokens.wnear.maxMintPerCall), 10n ** 30n);
    assert.doesNotMatch(readFileSync(DEPLOYMENTS_PATH, "utf8"), /private_key|secret|ed25519:/);
  });
});

describe("v2 fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "mv-deployments-v2-"));
  const contract = { accountId: "app.example.testnet", codeHash: "G6GtUs6AqHfxRb8YCdBx5dv1bgiQ3c1gDhPE9ygQTkEt", deployedAt: "2026-11-01T00:00:00.000Z", disputeWindowSec: 120 };

  it("loads a file with every optional field", async () => {
    const path = join(dir, "full.json");
    const d: Deployments = {
      ...sample(),
      contract: { ...contract, version: "1.0.0", stateVersion: 1, history: [{ version: "1.0.0", codeHash: contract.codeHash, at: contract.deployedAt }] },
      owner: "owner.example.testnet",
      ops: { guardian: "guardian.example.testnet", keeper: "keeper.example.testnet", maker: "maker.example.testnet" },
      release: "releases/v2.0.0/manifest.json",
      goLiveAt: "2026-11-20T12:00:00.000Z",
      resolutionHold: [7, 9],
    };
    await writeDeployments(d, path);
    const back = await requireDeployments(path);
    assert.deepEqual(back.ops, d.ops);
    assert.deepEqual(back.resolutionHold, [7, 9]);
    assert.equal(back.contract?.history?.length, 1);
  });

  it("refuses malformed optional fields with the field named", async () => {
    const path = join(dir, "bad.json");
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ resolutionHold: ["7"] }, /resolutionHold is not a list of event ids/],
      [{ resolutionHold: [0] }, /resolutionHold/],
      [{ goLiveAt: "soon" }, /goLiveAt is not an ISO time/],
      [{ ops: { guardian: 1 } }, /ops\.guardian is not a string/],
      [{ ops: { bot: "x" } }, /ops\.bot is not an ops account/],
      [{ contract: { ...contract, stateVersion: "2" } }, /contract\.stateVersion/],
      [{ contract: { ...contract, history: [{ version: "2.0.0" }] } }, /contract\.history\[0\] needs version, codeHash and at/],
    ];
    for (const [extra, pattern] of cases) {
      writeFileSync(path, JSON.stringify({ ...sample(), ...extra }));
      await assert.rejects(readDeployments(path), pattern);
    }
    assert.equal(optionalFieldsError(sample()), null);
  });

  it("appends a deploy or upgrade to the history and names the new code", () => {
    const d: Deployments = { ...sample(), contract: { ...contract, version: "1.0.0" } };
    const up = appendHistory(d, { version: "2.0.0", codeHash: "NewHash111", tx: "Tx1", at: "2026-11-21T00:00:00.000Z" }, 2);
    assert.equal(up.contract?.codeHash, "NewHash111");
    assert.equal(up.contract?.version, "2.0.0");
    assert.equal(up.contract?.stateVersion, 2);
    assert.deepEqual(up.contract?.history, [{ version: "2.0.0", codeHash: "NewHash111", tx: "Tx1", at: "2026-11-21T00:00:00.000Z", previousCodeHash: contract.codeHash }]);
    assert.equal(d.contract?.history, undefined, "the input is not changed");
    assert.throws(() => appendHistory(sample(), { version: "2.0.0", codeHash: "x", at: "" }), /no contract record/);
  });

  it("knows go-live, the resolution hold and the owner", () => {
    const d: Deployments = { ...sample(), goLiveAt: "2026-11-20T12:00:00.000Z", resolutionHold: [7, 9] };
    assert.equal(goneLive(d, Date.parse("2026-11-20T11:59:59Z")), false);
    assert.equal(goneLive(d, Date.parse("2026-11-20T12:00:00Z")), true);
    assert.equal(goneLive(sample()), false);
    assert.deepEqual([...heldEvents(d)], [7, 9]);
    assert.deepEqual([...heldEvents(d, [9])], [7], "an explicit --events id is not held");
    assert.equal(ownerOf(d), "example.testnet");
    assert.equal(ownerOf({ ...d, owner: "new-owner.testnet" }), "new-owner.testnet");
  });

  it("reads the file of the network it is asked for", async () => {
    const path = join(dir, "staging.json");
    writeFileSync(path, JSON.stringify({ ...sample(), network: "staging" }));
    await assert.rejects(readDeployments(path), /does not look like a testnet deployments file/);
    assert.equal((await readDeployments(path, "staging"))?.network, "staging");
    assert.match(deploymentsPath("rehearsal"), /deployments\/rehearsal\.json$/);
  });

  it("deployments/staging.json, when present, is valid and holds no keys", async (t) => {
    const path = deploymentsPath("staging");
    if (!existsSync(path)) {
      t.skip("deployments/staging.json is written by accounts.ts on staging");
      return;
    }
    const d = await requireDeployments(path, "staging");
    assert.equal(d.root, "ifverse-staging.testnet");
    assert.doesNotMatch(readFileSync(path, "utf8"), /private_key|secret|ed25519:/);
  });
});
