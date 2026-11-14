import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { KeyPair } from "near-api-js";

import { actions, KeyPair as Kp } from "near-api-js";

import {
  checkOutcome,
  gasFloatOf,
  InsufficientGasFloat,
  keyDirsFor,
  lastReceiptHeight,
  loadKeyPairFile,
  NETWORKS,
  parseDataChanges,
  parseNetwork,
  parseWaitUntil,
  receiptLogStats,
  storageDepositPlan,
  transferCallUsed,
  TxFailedError,
  WriteRefusedError,
  writeRefusal,
  type TxOutcome,
  type TxResult,
} from "./near.ts";
import { parseNear, tgas } from "./units.ts";

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

describe("networks", () => {
  it("parses the four networks and names them all when refusing another", () => {
    for (const n of ["testnet", "staging", "sandbox", "rehearsal"]) assert.equal(parseNetwork(n), n);
    assert.throws(() => parseNetwork("mainnet"), /NEAR_NETWORK must be one of testnet, staging, sandbox, rehearsal, not "mainnet"/);
  });

  it("puts staging on the testnet chain and the rehearsal on a sandbox chain", () => {
    assert.deepEqual(
      Object.values(NETWORKS).map((n) => [n.network, n.chain, n.defaultRoot]),
      [
        ["testnet", "testnet", "multiverse-near.testnet"],
        ["staging", "testnet", "ifverse-staging.testnet"],
        ["sandbox", "sandbox", "test.near"],
        ["rehearsal", "sandbox", "multiverse-near.testnet"],
      ],
    );
    assert.deepEqual(NETWORKS.staging.rpcUrls, NETWORKS.testnet.rpcUrls);
    assert.equal(NETWORKS.rehearsal.explorer, "");
  });

  it("reads near-cli's legacy keychain for production only", () => {
    assert.deepEqual(
      Object.values(NETWORKS).filter((n) => n.legacyKeychain).map((n) => n.network),
      ["testnet"],
    );
  });

  it("never looks for staging, sandbox or rehearsal keys in ~/.near-credentials", () => {
    for (const net of ["staging", "sandbox", "rehearsal"] as const) {
      const dirs = keyDirsFor(NETWORKS[net], `/repo/.keys/${net}`, "/work", undefined, "/home/u");
      assert.deepEqual(dirs, [`/repo/.keys/${net}`, `/work/.keys/${net}`]);
    }
    assert.deepEqual(keyDirsFor(NETWORKS.testnet, "/repo/.keys/testnet", "/work", undefined, "/home/u"), [
      "/repo/.keys/testnet",
      "/work/.keys/testnet",
      "/home/u/.near-credentials/testnet",
    ]);
    // variant keys (report, reference, pause) live only in the repo's key dirs
    assert.ok(!keyDirsFor(NETWORKS.testnet, "/repo/.keys/testnet", "/work", "report", "/home/u").some((d) => d.includes(".near-credentials")));
  });
});

describe("writeRefusal", () => {
  const base = { explicit: true, network: "staging" as const, approvalPresent: false, exempt: false };

  it("refuses a state-changing command without NEAR_NETWORK", () => {
    assert.match(writeRefusal({ ...base, explicit: false }) ?? "", /NEAR_NETWORK is not set/);
    assert.match(writeRefusal({ ...base, explicit: false, network: "testnet", approvalPresent: true }) ?? "", /NEAR_NETWORK is not set/);
  });

  it("refuses testnet writes without the owner's approval file", () => {
    assert.match(writeRefusal({ ...base, network: "testnet" }) ?? "", /releases\/v2\.0\.0\/production\/APPROVAL/);
    assert.equal(writeRefusal({ ...base, network: "testnet", approvalPresent: true }), null);
    assert.equal(writeRefusal({ ...base, network: "testnet", exempt: true }), null);
  });

  it("lets every other named network send", () => {
    for (const network of ["staging", "sandbox", "rehearsal"] as const) assert.equal(writeRefusal({ ...base, network }), null);
  });

  it("makes the process exit 2", () => {
    assert.equal(new WriteRefusedError("x").exitCode, 2);
  });
});

describe("gas float", () => {
  const PRICE = 1_000_000_000n;

  it("a 300 Tgas call with 1 yocto needs 0.31 NEAR free", () => {
    const f = gasFloatOf([actions.functionCall("m", {}, tgas(300), 1n)], PRICE);
    assert.equal(f.prepaidGas, tgas(300));
    assert.equal(f.minFree, parseNear("0.31") + 1n);
  });

  it("adds every function call's gas and every deposit and transfer", () => {
    const f = gasFloatOf(
      [actions.createAccount(), actions.transfer(parseNear("1")), actions.addFullAccessKey(Kp.fromRandom("ed25519").getPublicKey()), actions.functionCall("new", {}, tgas(30), parseNear("0.05"))],
      PRICE,
    );
    assert.equal(f.deposits, parseNear("1.05"));
    assert.equal(f.minFree, parseNear("1.05") + parseNear("0.03") + parseNear("0.01"));
  });

  it("names the account and both amounts when it refuses", () => {
    const err = new InsufficientGasFloat("keeper.ifverse-staging.testnet", parseNear("0.2"), parseNear("0.31"));
    assert.match(err.message, /^InsufficientGasFloat\(keeper\.ifverse-staging\.testnet, 200000000000000000000000, 310000000000000000000000\)/);
    assert.match(err.message, /has 0\.2000 NEAR free, needs 0\.3100/);
  });
});

describe("receipt stats", () => {
  it("counts log lines, bytes and gas per receipt", () => {
    const stats = receiptLogStats(outcome("transfer-call-refunded"));
    assert.equal(stats.receipts, 6);
    assert.equal(stats.maxLines, 1);
    assert.equal(stats.maxBytes, 216);
    assert.equal(stats.maxGasTgas, 2.623);
    assert.deepEqual(stats.perReceipt[3], {
      id: "A9htpwAnVxM4nqKm9tV4Kz2hEvjwDFYZuWjcBMLJM6yd",
      executor: "usdc.multiverse-lending.testnet",
      lines: 1,
      bytes: 216,
      gasTgas: 1.859,
    });
  });

  it("pins a post-check to the highest block any receipt ran in", async () => {
    const heights: Record<string, number> = {
      B22Ui9pmLuiZFMPasghvz3YE2Ma7jhHowfeXhTbbZ9Jb: 100,
      JAVjBUd5oabhMHGdmT2LjrvG6EY5qKnGfGvFiAdC67eG: 101,
      "76eYtDvA6gus4wEsyF3fhR43zfiD99fJC3xoAEqMBqaT": 102,
      "4Pauht8tfiT6D2AmC744DHbqtGhH4v6yRQQ6jbqrny1Q": 103,
      GKnizZtQUwG16wEf9SeraFvyJbEV1XfNqPByWhn2iP5r: 104,
    };
    const asked: string[] = [];
    const h = await lastReceiptHeight(outcome("transfer-call-refunded"), async (hash) => {
      asked.push(hash);
      const v = heights[hash];
      if (v === undefined) throw new Error(`unknown block ${hash}`);
      return v;
    });
    assert.equal(h, 104);
    assert.equal(asked.length, 5, "each block is looked up once");
  });
});

describe("parseDataChanges", () => {
  const raw = [
    { cause: { type: "receipt_processing", receipt_hash: "R1" }, type: "data_update", change: { account_id: "app.test.near", key_base64: "U1RBVEU=", value_base64: "AAE=" } },
    { cause: { type: "receipt_processing", receipt_hash: "R1" }, type: "data_deletion", change: { account_id: "app.test.near", key_base64: "Gw==" } },
    { cause: { type: "receipt_processing", receipt_hash: "R2" }, type: "data_update", change: { account_id: "other.test.near", key_base64: "AA==", value_base64: "AA==" } },
  ];

  it("keeps the account's changes in order, a deletion with a null value", () => {
    assert.deepEqual(parseDataChanges(raw, "app.test.near"), [
      { cause: { type: "receipt_processing", receipt_hash: "R1" }, type: "data_update", key: "U1RBVEU=", value: "AAE=" },
      { cause: { type: "receipt_processing", receipt_hash: "R1" }, type: "data_deletion", key: "Gw==", value: null },
    ]);
  });

  it("refuses a change kind it does not know", () => {
    assert.throws(() => parseDataChanges([{ ...raw[0]!, type: "code_update" }], "app.test.near"), /unexpected change type code_update/);
  });
});
