// deployments/<network>.json: the public account ids every other piece (web app, resolver, seed and
// demo scripts) reads. No keys in here, ever.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DEFAULT_RPC_URL, EXPLORER, NETWORK, REPO_ROOT, type Network } from "./near.ts";

export const DEPLOYMENTS_PATH = join(REPO_ROOT, "deployments", `${NETWORK}.json`);

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

export interface ContractDeployment {
  accountId: string;
  codeHash: string;
  deployedAt: string;
  disputeWindowSec: number;
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
}

export async function readDeployments(path = DEPLOYMENTS_PATH): Promise<Deployments | undefined> {
  if (!existsSync(path)) return undefined;
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  assertShape(parsed, path);
  return parsed;
}

export async function requireDeployments(path = DEPLOYMENTS_PATH): Promise<Deployments> {
  const d = await readDeployments(path);
  if (!d) throw new Error(`${path} is missing; run \`pnpm accounts\` first`);
  return d;
}

/** Writes through a temp file so a crash never leaves half a JSON file behind. */
export async function writeDeployments(d: Deployments, path = DEPLOYMENTS_PATH): Promise<void> {
  assertShape(d, path);
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
