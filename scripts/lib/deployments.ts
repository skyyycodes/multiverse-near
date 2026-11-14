// deployments/<network>.json: the public account ids every other piece (web app, resolver, seed and
// demo scripts) reads. No keys in here, ever.
//
// The v1 fields are required and checked as before, so every existing file still loads and the web
// reader (web/scripts/network.mjs) ignores the v2 fields. The v2 fields are optional; when present
// they are type-checked too, so a hand edit cannot slip a string into `resolutionHold`.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DEFAULT_RPC_URL, EXPLORER, NETWORK, REPO_ROOT, type Network } from "./near.ts";

export const DEPLOYMENTS_DIR = join(REPO_ROOT, "deployments");
export const deploymentsPath = (network: Network): string => join(DEPLOYMENTS_DIR, `${network}.json`);
export const DEPLOYMENTS_PATH = deploymentsPath(NETWORK);

export const PERSONAS = ["alice", "bob", "ravi", "sam", "uma", "carl", "leo", "resolver"] as const;
export type Persona = (typeof PERSONAS)[number];

export interface TokenDeployment {
  accountId: string;
  name: string;
  symbol: string;
  decimals: number;
  /** Faucet cap per `mint` call, in base units. */
  maxMintPerCall: string;
  codeHash: string;
}

/** One deploy or upgrade of the contract, appended by deploy.ts and upgrade.ts. */
export interface ContractHistoryEntry {
  version: string;
  codeHash: string;
  previousCodeHash?: string;
  tx?: string;
  /** ISO time. */
  at: string;
  /** Path of the upgrade report (releases/...). */
  report?: string;
}

export interface ContractDeployment {
  accountId: string;
  codeHash: string;
  deployedAt: string;
  disputeWindowSec: number;
  /** Release name of the code ("1.0.0", "2.0.0"); absent on files written before v2. */
  version?: string;
  stateVersion?: number;
  history?: ContractHistoryEntry[];
}

/** Team accounts that run the bots; never personas, never in PERSONAS. */
export interface OpsAccounts {
  guardian?: string;
  keeper?: string;
  maker?: string;
}

export interface Deployments {
  network: Network;
  rpcUrl: string;
  explorer: string;
  /** Owner and admin of the protocol, parent of every other account. */
  root: string;
  /** The Multiverse contract (deployed by deploy.ts; `contract` is null until then). */
  contractId: string;
  wnear: string;
  usdc: string;
  /** Account allowed to call report_outcome (the resolver). */
  reporter: string;
  personas: Record<Persona, string>;
  tokens: { wnear: TokenDeployment; usdc: TokenDeployment };
  contract: ContractDeployment | null;
  updatedAt: string;
  /** The contract owner when it is not the root (after a two-step ownership change). */
  owner?: string;
  ops?: OpsAccounts;
  /** The release manifest the deployed code came from, e.g. "releases/v2.0.0/manifest.json". */
  release?: string;
  /** ISO time seed-v2 finished; e2e and soak refuse to send on this network after it. */
  goLiveAt?: string;
  /** Event ids the resolver loop leaves alone (resolved on camera); an explicit --events overrides. */
  resolutionHold?: number[];
}

const isString = (v: unknown): v is string => typeof v === "string";
const isEventId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** Why the optional v2 fields are malformed, or null. */
export function optionalFieldsError(o: Partial<Deployments>): string | null {
  if (o.owner !== undefined && !isString(o.owner)) return "owner is not a string";
  if (o.ops !== undefined) {
    if (typeof o.ops !== "object" || o.ops === null || Array.isArray(o.ops)) return "ops is not an object";
    for (const [k, v] of Object.entries(o.ops)) {
      if (k !== "guardian" && k !== "keeper" && k !== "maker") return `ops.${k} is not an ops account`;
      if (!isString(v)) return `ops.${k} is not a string`;
    }
  }
  if (o.release !== undefined && !isString(o.release)) return "release is not a string";
  if (o.goLiveAt !== undefined && (!isString(o.goLiveAt) || Number.isNaN(Date.parse(o.goLiveAt)))) return "goLiveAt is not an ISO time";
  if (o.resolutionHold !== undefined && (!Array.isArray(o.resolutionHold) || !o.resolutionHold.every(isEventId))) {
    return "resolutionHold is not a list of event ids";
  }
  const c = o.contract;
  if (c) {
    if (c.version !== undefined && !isString(c.version)) return "contract.version is not a string";
    if (c.stateVersion !== undefined && !(typeof c.stateVersion === "number" && Number.isInteger(c.stateVersion) && c.stateVersion > 0)) {
      return "contract.stateVersion is not a positive integer";
    }
    if (c.history !== undefined) {
      if (!Array.isArray(c.history)) return "contract.history is not a list";
      for (const [i, h] of c.history.entries()) {
        const e = h as Partial<ContractHistoryEntry> | null;
        if (typeof e !== "object" || e === null || !isString(e.version) || !isString(e.codeHash) || !isString(e.at)) {
          return `contract.history[${i}] needs version, codeHash and at`;
        }
      }
    }
  }
  return null;
}

function assertShape(d: unknown, path: string, network: Network = NETWORK): asserts d is Deployments {
  const o = d as Partial<Deployments> | null;
  const isToken = (t: Partial<TokenDeployment> | undefined): boolean =>
    typeof t?.accountId === "string" && typeof t.decimals === "number" && typeof t.maxMintPerCall === "string";
  const ok =
    typeof o === "object" &&
    o !== null &&
    o.network === network &&
    typeof o.root === "string" &&
    typeof o.contractId === "string" &&
    typeof o.wnear === "string" &&
    typeof o.usdc === "string" &&
    typeof o.reporter === "string" &&
    typeof o.personas === "object" &&
    o.personas !== null &&
    PERSONAS.every((p) => typeof o.personas?.[p] === "string") &&
    isToken(o.tokens?.wnear) &&
    isToken(o.tokens?.usdc) &&
    (o.contract === null || typeof o.contract?.codeHash === "string");
  if (!ok) throw new Error(`${path} does not look like a ${network} deployments file`);
  const bad = optionalFieldsError(o);
  if (bad) throw new Error(`${path}: ${bad}`);
}

export async function readDeployments(path = DEPLOYMENTS_PATH, network: Network = NETWORK): Promise<Deployments | undefined> {
  if (!existsSync(path)) return undefined;
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  assertShape(parsed, path, network);
  return parsed;
}

export async function requireDeployments(path = DEPLOYMENTS_PATH, network: Network = NETWORK): Promise<Deployments> {
  const d = await readDeployments(path, network);
  if (!d) throw new Error(`${path} is missing; run \`pnpm accounts\` first`);
  return d;
}

/** Writes through a temp file so a crash never leaves half a JSON file behind. */
export async function writeDeployments(d: Deployments, path = DEPLOYMENTS_PATH): Promise<void> {
  assertShape(d, path, d.network);
  const next = { ...d, rpcUrl: d.rpcUrl || DEFAULT_RPC_URL, explorer: d.explorer || EXPLORER, updatedAt: new Date().toISOString() };
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tmp, path);
}

export function accountIds(root: string): Omit<Deployments, "tokens" | "contract" | "updatedAt" | "rpcUrl" | "explorer" | "network"> {
  const sub = (name: string): string => `${name}.${root}`;
  const personas = Object.fromEntries(PERSONAS.map((p) => [p, sub(p)])) as Record<Persona, string>;
  return { root, contractId: sub("app"), wnear: sub("wnear"), usdc: sub("usdc"), reporter: sub("resolver"), personas };
}

/** The contract owner: `owner` when set, else the root. */
export const ownerOf = (d: Deployments): string => d.owner ?? d.root;

/**
 * A copy of `d` whose contract record names the new code, with the deploy or upgrade appended to
 * its history (the previous hash filled in from the record when the entry has none).
 */
export function appendHistory(d: Deployments, entry: ContractHistoryEntry, stateVersion?: number): Deployments {
  if (!d.contract) throw new Error(`${d.network}: no contract record to append a history entry to`);
  const previous = d.contract.codeHash;
  const full: ContractHistoryEntry = { ...entry, previousCodeHash: entry.previousCodeHash ?? previous };
  return {
    ...d,
    contract: {
      ...d.contract,
      codeHash: entry.codeHash,
      version: entry.version,
      ...(stateVersion === undefined ? {} : { stateVersion }),
      history: [...(d.contract.history ?? []), full],
    },
  };
}

/** Whether go-live has happened at `nowMs` (e2e and soak then only read). */
export function goneLive(d: Deployments, nowMs: number = Date.now()): boolean {
  return d.goLiveAt !== undefined && Date.parse(d.goLiveAt) <= nowMs;
}

/** The event ids the resolver loop skips this round, minus those named explicitly on the command line. */
export function heldEvents(d: Deployments, explicit: readonly number[] = []): Set<number> {
  const held = new Set(d.resolutionHold ?? []);
  for (const id of explicit) held.delete(id);
  return held;
}
