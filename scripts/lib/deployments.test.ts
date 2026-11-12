import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { accountIds, DEPLOYMENTS_PATH, readDeployments, requireDeployments, writeDeployments, type Deployments } from "./deployments.ts";

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
    tokens: { wnear: token(ids.wnear, "wNEAR", 18), usdc: token(ids.usdc, "USDC", 6) },
    contract: null,
    updatedAt: "",
  };
}

describe("accountIds", () => {
  it("names every account under the root, as in the design", () => {
    const ids = accountIds("multiverse-lending.testnet");
    assert.equal(ids.contractId, "app.multiverse-lending.testnet");
    assert.equal(ids.wnear, "wnear.multiverse-lending.testnet");
    assert.equal(ids.usdc, "usdc.multiverse-lending.testnet");
    assert.equal(ids.reporter, "resolver.multiverse-lending.testnet");
    assert.deepEqual(Object.keys(ids.personas), ["alice", "bob", "ravi", "sam", "uma", "carl", "leo", "resolver"]);
    assert.equal(ids.personas.carl, "carl.multiverse-lending.testnet");
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
    assert.equal(d.root, "multiverse-lending.testnet");
    assert.equal(d.tokens.usdc.decimals, 6);
    assert.equal(d.tokens.wnear.decimals, 18);
    assert.doesNotMatch(readFileSync(DEPLOYMENTS_PATH, "utf8"), /private_key|secret|ed25519:/);
  });
});
