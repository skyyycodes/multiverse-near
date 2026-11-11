// The NEP-141 boundary. The contract keeps every amount in 18 decimals and converts at the token edge:
// internal = token_amount × 10^(18 − decimals). WETH (18) is unchanged; USDC (6) is ×1e12.

export const WAD = 10n ** 18n;

export function scaleOf(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error(`unsupported token decimals ${decimals}`);
  return 10n ** BigInt(18 - decimals);
}

/** A wallet balance (token units) in the 18-decimal units every screen formats. */
export const toInternal = (tokenAmount: bigint, decimals: number): bigint => tokenAmount * scaleOf(decimals);

/** Token units that an internal amount buys at most (what a payout sends; the dust stays inside). */
export const toTokenFloor = (internal: bigint, decimals: number): bigint => internal / scaleOf(decimals);

/** Token units needed to cover an internal amount (what a transfer must attach). */
export function toTokenCeil(internal: bigint, decimals: number): bigint {
  if (internal <= 0n) return 0n;
  const s = scaleOf(decimals);
  return (internal + s - 1n) / s;
}

/** Whole yoctoNEAR for a NEAR amount written as a decimal string ("0.1" → 10^23). */
export function nearToYocto(near: string): bigint {
  const [w, f = ""] = near.split(".");
  return BigInt(w || "0") * 10n ** 24n + BigInt((f + "0".repeat(24)).slice(0, 24));
}

export function fmtNear(yocto: bigint, digits = 3): string {
  const one = 10n ** 24n;
  const whole = yocto / one;
  const frac = ((yocto % one) * 10n ** BigInt(digits)) / one;
  return `${whole}.${frac.toString().padStart(digits, "0")}`.replace(/\.?0+$/, "") || "0";
}
