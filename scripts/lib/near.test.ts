import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { KeyPair } from "near-api-js";

import {
  checkOutcome,
  loadKeyPairFile,
  parseWaitUntil,
  storageDepositPlan,
  transferCallUsed,
  TxFailedError,
  type TxOutcome,
  type TxResult,
} from "./near.ts";

// Raw FINAL outcomes of three testnet transactions signed by alice.multiverse-lending.testnet:
//   mint-ok                 FyxsMsdHbFN6rpt1vrSZjbZxQTf5U6RQm5APWJNw1pYW  usdc.mint(5 USDC)
//   mint-above-cap          2Sfonpeje9EuQJL1Lkuj9MQkLXx5FtHd51GyJLiuspFA  usdc.mint over the per-call cap
//   transfer-call-refunded  8kM7RdHxBUhUUSN2p5pjc69NGLBU6e6L3Cufn7kyX13w  usdc.ft_transfer_call to bob, who has no contract
const outcome = (name: string): TxOutcome =>
  JSON.parse(readFileSync(new URL(`./fixtures/near/${name}.json`, import.meta.url), "utf8")) as TxOutcome;

function result(returnText: string): TxResult {
  return { hash: "test", outcome: {} as TxOutcome, logs: [], gasBurnt: 0n, returnText };
}

describe("checkOutcome", () => {
  it("returns the logs, gas and return value of a successful transaction", () => {
    const r = checkOutcome(outcome("mint-ok"), "mint");
    assert.equal(r.hash, "FyxsMsdHbFN6rpt1vrSZjbZxQTf5U6RQm5APWJNw1pYW");
    assert.equal(r.returnText, "");
    assert.ok(r.gasBurnt > 0n);
    assert.deepEqual(r.logs, [
      'EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_mint","data":[{"owner_id":"alice.multiverse-lending.testnet","amount":"5000000","memo":"faucet"}]}',
    ]);
  });

  it("throws the contract's panic message when the call fails", () => {
    assert.throws(
      () => checkOutcome(outcome("mint-above-cap"), "mint"),
      (err: unknown) =>
        err instanceof TxFailedError &&
        err.hash === "2Sfonpeje9EuQJL1Lkuj9MQkLXx5FtHd51GyJLiuspFA" &&
        err.message.startsWith(
          "mint: receipt on usdc.multiverse-lending.testnet failed: Smart contract panicked: amount 10000000000001 is above the per-call cap of 10000000000000",
        ),
    );
  });

  it("catches a refunded ft_transfer_call even though the transaction itself succeeded", () => {
    const raw = outcome("transfer-call-refunded");
    // What a status-only check would see: success, returning "0" (nothing used).
    assert.deepEqual(raw.status, { SuccessValue: Buffer.from('"0"').toString("base64") });
    assert.throws(
      () => checkOutcome(raw, "transfer"),
      (err: unknown) =>
        err instanceof TxFailedError &&
        err.message.includes("receipt on bob.multiverse-lending.testnet failed") &&
        err.message.includes("CodeDoesNotExist") &&
        err.logs.some((log) => log.includes('"event":"ft_transfer"')),
    );
  });

  it("refuses an outcome that has not finished", () => {
    const pending = { ...outcome("mint-ok"), status: "Started" } as unknown as TxOutcome;
    assert.throws(() => checkOutcome(pending, "mint"), /transaction not finished/);
  });
});

describe("parseWaitUntil", () => {
  it("accepts the levels that return receipt outcomes", () => {
    for (const level of ["EXECUTED_OPTIMISTIC", "EXECUTED", "FINAL"]) assert.equal(parseWaitUntil(level), level);
  });

  it("rejects levels whose answer has no outcome, and anything else", () => {
    for (const level of ["NONE", "INCLUDED", "INCLUDED_FINAL", "final", ""]) {
      assert.throws(() => parseWaitUntil(level), /NEAR_WAIT_UNTIL must be one of EXECUTED_OPTIMISTIC, EXECUTED, FINAL/, level);
    }
  });
});

describe("storageDepositPlan", () => {
  const MIN = 100n;
  const balance = (total: bigint, available: bigint) => ({ total: total.toString(), available: available.toString() });

  it("registers a new account with the minimum or the given deposit", () => {
    assert.deepEqual(storageDepositPlan(null, MIN), { amount: MIN, registrationOnly: true });
    assert.deepEqual(storageDepositPlan(null, MIN, { deposit: 150n }), { amount: 150n, registrationOnly: true });
  });

  it("leaves a registered account alone unless asked to top up", () => {
    assert.equal(storageDepositPlan(balance(MIN, 0n), MIN), null);
    assert.equal(storageDepositPlan(balance(MIN, 0n), MIN, { deposit: 500n }), null);
  });

  it("tops up only the missing part", () => {
    assert.deepEqual(storageDepositPlan(balance(MIN, 30n), MIN, { minAvailable: 80n }), { amount: 50n, registrationOnly: false });
    assert.equal(storageDepositPlan(balance(MIN, 80n), MIN, { minAvailable: 80n }), null);
    assert.equal(storageDepositPlan(balance(MIN, 90n), MIN, { minAvailable: 80n }), null);
  });

  it("registers with room to spare when a new account must have some available", () => {
    assert.deepEqual(storageDepositPlan(null, MIN, { minAvailable: 80n }), { amount: 180n, registrationOnly: false });
    assert.deepEqual(storageDepositPlan(null, MIN, { deposit: 500n, minAvailable: 80n }), { amount: 500n, registrationOnly: false });
  });

  it("refuses a malformed balance", () => {
    assert.throws(() => storageDepositPlan({ total: "1", available: "-1" }, MIN, { minAvailable: 1n }));
  });
});

describe("transferCallUsed", () => {
  it("accepts a receiver that used everything", () => {
    assert.equal(transferCallUsed(result('"1000000"'), 1_000_000n, "t"), 1_000_000n);
  });

  it("rejects a partial or full refund unless asked to allow it", () => {
    assert.throws(() => transferCallUsed(result('"0"'), 1_000_000n, "t"), /receiver used 0 of 1000000; the rest was refunded/);
    assert.throws(() => transferCallUsed(result('"400"'), 1_000n, "t"), /receiver used 400 of 1000/);
    assert.equal(transferCallUsed(result('"400"'), 1_000n, "t", true), 400n);
  });

  it("rejects a token that claims more than was sent, or garbage", () => {
    assert.throws(() => transferCallUsed(result('"1001"'), 1_000n, "t"), /more than the 1000 sent/);
    assert.throws(() => transferCallUsed(result(""), 1_000n, "t"), /not a U128 string/);
    assert.throws(() => transferCallUsed(result("1000"), 1_000n, "t"), /not a U128 string/);
  });
});

describe("loadKeyPairFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "mv-keys-"));
  const keyPair = KeyPair.fromRandom("ed25519");
  const write = (name: string, body: object): string => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(body));
    return path;
  };

  it("reads near-cli's legacy keychain format", async () => {
    const path = write("alice.json", {
      account_id: "alice.testnet",
      public_key: keyPair.getPublicKey().toString(),
      private_key: keyPair.toString(),
    });
    const loaded = await loadKeyPairFile(path, "alice.testnet");
    assert.equal(loaded.getPublicKey().toString(), keyPair.getPublicKey().toString());
  });

  it("refuses a key file of another account or with a mismatched public key", async () => {
    const other = write("other.json", { account_id: "bob.testnet", private_key: keyPair.toString() });
    await assert.rejects(loadKeyPairFile(other, "alice.testnet"), /belongs to bob.testnet/);
    const mismatched = write("mismatch.json", {
      account_id: "alice.testnet",
      public_key: KeyPair.fromRandom("ed25519").getPublicKey().toString(),
      private_key: keyPair.toString(),
    });
    await assert.rejects(loadKeyPairFile(mismatched, "alice.testnet"), /public_key does not match/);
    const empty = write("empty.json", { account_id: "alice.testnet" });
    await assert.rejects(loadKeyPairFile(empty, "alice.testnet"), /has no private_key/);
  });
});
