export const FIXTURE_SENTINEL: string;
export function onChainFredSha(deployment: { rpcUrl: string; contractId: string }): Promise<string | null>;
export function checkRelease(
  outDir: string,
  network: string,
  opts?: { prelaunch?: boolean; deploymentsDir?: string; fredSha?: (deployment: Record<string, unknown>) => Promise<string | null> },
): Promise<string[]>;
