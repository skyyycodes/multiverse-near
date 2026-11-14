// The release check (scripts/check-release.mjs) on hand-made build outputs: each rule must pass a good output and fail
// the bad one it exists for. The on-chain OutLayer read is stood in for.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRelease } from "../../scripts/check-release.mjs";

const PROD = { rpcUrl: "https://rpc", contractId: "app.multiverse-near.testnet", wnear: "w", usdc: "u" };
const STAGING = { rpcUrl: "https://rpc", contractId: "app.ifverse-staging.testnet", wnear: "w", usdc: "u" };
const FRED = Buffer.from("fred guest bytes");
const FRED_SHA = createHash("sha256").update(FRED).digest("hex");

function dir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function deployments(): string {
  const d = dir("ifverse-dep-");
  writeFileSync(join(d, "testnet.json"), JSON.stringify(PROD));
  writeFileSync(join(d, "staging.json"), JSON.stringify(STAGING));
  return d;
}

type Out = Record<string, string | Buffer>;

function output(files: Out): string {
  const d = dir("ifverse-out-");
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(d, path)), { recursive: true });
    writeFileSync(join(d, path), body);
  }
  return d;
}

const version = (network: string, contract: string, prelaunch = false) =>
  JSON.stringify({ web_version: "2.0.0", git_sha: "abc1234", network, contract_id: contract, prelaunch, built_at: "2026-11-14T00:00:00.000Z" });

function production(extra: Out = {}): Out {
  return {
    "index.html": "<html><title>IfVerse</title></html>",
    "_next/static/chunks/app.js": `const e={contractId:"${PROD.contractId}"};const b="formerly Multiverse Lending";`,
    "outlayer/fred-guest.wasm": FRED,
    "version.json": version("testnet", PROD.contractId),
    ...extra,
  };
}

function staging(extra: Out = {}): Out {
  return {
    "index.html": "<html><title>IfVerse</title></html>",
    "_next/static/chunks/app.js": `const e={contractId:"${STAGING.contractId}"};window.__nearDemo;`,
    "outlayer/nearusd-guest.wasm": Buffer.from("nearusd"),
    "version.json": version("staging", STAGING.contractId),
    ...extra,
  };
}

const check = (out: string, network: string, prelaunch = false, sha: string | null = FRED_SHA) =>
  checkRelease(out, network, { prelaunch, deploymentsDir: deployments(), fredSha: async () => sha });

describe("the release check", () => {
  it("passes a clean production and a clean staging output", async () => {
    expect(await check(output(production()), "testnet")).toEqual([]);
    expect(await check(output(staging()), "staging")).toEqual([]);
  });

  it("fails an output built for another deployment", async () => {
    const wrong = output(production({ "_next/static/chunks/app.js": `const e={contractId:"${STAGING.contractId}"};` }));
    const f = await check(wrong, "testnet");
    expect(f).toContain(`no JS file inlines the contract id ${PROD.contractId} of deployments/testnet.json`);
    expect(f.some((x) => x.includes(`inlines staging's contract id ${STAGING.contractId}`))).toBe(true);
    const mislabelled = await check(output(production({ "version.json": version("staging", STAGING.contractId) })), "testnet");
    expect(mislabelled).toContain("version.json names network staging, not testnet");
    expect(await check(output(production({ "version.json": "{}" })), "testnet")).toContain("version.json has no web_version");
  });

  it("fails an output that holds design data", async () => {
    const sentinel = await check(output(production({ "_next/static/chunks/fx.js": 'const s="__IFVERSE_FIXTURES__";' })), "testnet");
    expect(sentinel).toContain("_next/static/chunks/fx.js holds the fixture sentinel __IFVERSE_FIXTURES__");
    const personas = await check(output(production({ "_next/static/chunks/fx.js": 'const P=["alice","bob","ravi","sam"];' })), "testnet");
    expect(personas).toContain("_next/static/chunks/fx.js holds the fixture persona list");
  });

  it("allows the old name only inside 'formerly Multiverse Lending'", async () => {
    const old = await check(output(production({ "index.html": "<title>Multiverse Lending</title>" })), "testnet");
    expect(old).toContain('index.html says "Multiverse Lending" outside "formerly Multiverse Lending" (1x)');
    const chip = await check(output(production({ "_next/static/chunks/b.js": 'label:"In Multiverse"' })), "testnet");
    expect(chip).toContain('_next/static/chunks/b.js says "In Multiverse"');
  });

  it("wants the demo-wallet bridge off testnet and only there", async () => {
    const bridged = output(production({ "_next/static/chunks/d.js": "window.__nearDemo" }));
    expect(await check(bridged, "testnet")).toContain("the demo-wallet bridge (__nearDemo) is in a testnet build");
    const bare = output(staging({ "_next/static/chunks/app.js": `const e={contractId:"${STAGING.contractId}"};` }));
    expect(await check(bare, "staging")).toContain("the demo-wallet bridge (__nearDemo) is missing from the staging build");
  });

  it("checks the served guests against the chain and the staging guest's presence", async () => {
    expect(await check(output(production()), "testnet", false, "00".repeat(32))).toContain(
      `outlayer/fred-guest.wasm sha256 ${FRED_SHA} differs from the on-chain OutLayerConfig ${"00".repeat(32)}`,
    );
    expect(await check(output(production()), "testnet", false, null)).toContain(`${PROD.contractId} has no OutLayerConfig to compare outlayer/fred-guest.wasm with`);
    const noFred = production();
    delete noFred["outlayer/fred-guest.wasm"];
    expect(await check(output(noFred), "testnet")).toContain("outlayer/fred-guest.wasm is missing (scripts/copy-guest.mjs)");
    const noGuest = staging();
    delete noGuest["outlayer/nearusd-guest.wasm"];
    expect((await check(output(noGuest), "staging")).some((f) => f.startsWith("outlayer/nearusd-guest.wasm is missing"))).toBe(true);
  });

  it("tells the pre-launch build apart in both directions", async () => {
    const pre = output(staging({ "version.json": version("staging", STAGING.contractId, true), "index.html": '<main data-demo="prelaunch">IfVerse opens soon</main>' }));
    expect(await check(pre, "staging", true)).toEqual([]);
    expect(await check(pre, "staging")).toContain("this is the pre-launch build; check it with --prelaunch, or build the full app");
    const full = await check(output(staging()), "staging", true);
    expect(full).toContain("--prelaunch given, but version.json does not say prelaunch: true (build:staging:prelaunch)");
    expect(full).toContain("--prelaunch given, but no page shows the pre-launch notice");
  });

  it("names a missing output or deployment file", async () => {
    expect(await check(join(tmpdir(), "ifverse-nothing-here"), "testnet")).toEqual([`${join(tmpdir(), "ifverse-nothing-here")} does not exist; build first`]);
    expect((await check(output(production()), "rehearsal"))[0]).toMatch(/rehearsal\.json is missing/);
  });
});
