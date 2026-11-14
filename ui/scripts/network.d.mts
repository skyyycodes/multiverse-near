export type NetworkName = "testnet" | "staging" | "sandbox" | "rehearsal";
export const DEPLOYMENTS: string;
export const NETWORKS: readonly NetworkName[];
export const CHAIN: Record<NetworkName, "testnet" | "sandbox">;
export const STATE_VERSION: string;
export function webVersion(): string;
export function gitSha(env?: Record<string, string | undefined>, cwd?: string): string;
export function readDeployment(network: string, dir?: string): Record<string, unknown>;
export function networkEnv(network?: string, env?: Record<string, string | undefined>, dir?: string): Record<string, string>;
