// The NEP-141 boundary. The contract keeps every amount in 18 decimals and converts at the token edge:
// - a token with 18 decimals or fewer: internal = token_amount × 10^(18 − decimals) (USDC, 6 decimals: ×1e12), and a
//   payout sends floor(internal / 10^(18 − decimals)), the dust staying inside;
// - a finer token: internal = floor(token_amount / 10^(decimals − 18)) (wNEAR, 24 decimals: ÷1e6), the remainder never
//   enters the ledger (ft_on_transfer returns it as unused), and a payout sends internal × 10^(decimals − 18) exactly.

export const WAD = 10n ** 18n;
const MAX_DECIMALS = 24;

function checked(decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) throw new Error(`unsupported token decimals ${decimals}`);
  return decimals;
}

/** Internal units in one token base unit: 1e12 for USDC, 1 for a token with 18 decimals or more. */
export function unitOf(decimals: number): bigint {
  const d = checked(decimals);
  return d <= 18 ? 10n ** BigInt(18 - d) : 1n;
}

/** Token base units in one internal unit: 1e6 for wNEAR (24 decimals), 1 for a token with 18 decimals or fewer. */
function finerBy(decimals: number): bigint {
  const d = checked(decimals);
  return d > 18 ? 10n ** BigInt(d - 18) : 1n;
}

/** A wallet balance (token units) in the 18-decimal units every screen formats (rounded down for a finer token). */
export const toInternal = (tokenAmount: bigint, decimals: number): bigint => (tokenAmount * unitOf(decimals)) / finerBy(decimals);

/** Token units that an internal amount buys at most (what a payout sends; for a coarser token the dust stays inside). */
export const toTokenFloor = (internal: bigint, decimals: number): bigint => (internal / unitOf(decimals)) * finerBy(decimals);

/** Token units needed to cover an internal amount (what a transfer must attach). */
export function toTokenCeil(internal: bigint, decimals: number): bigint {
  if (internal <= 0n) return 0n;
  const s = unitOf(decimals);
  return ((internal + s - 1n) / s) * finerBy(decimals);
}

/** Whole yoctoNEAR for a NEAR amount written as a decimal string ("0.1" → 10^23). */
export function nearToYocto(near: string): bigint {
  const [w, f = ""] = near.split(".");
  return BigInt(w || "0") * 10n ** 24n + BigInt((f + "0".repeat(24)).slice(0, 24));
}

/** Native NEAR (storage deposits), from yoctoNEAR: "0.1", "0.061". */
export function fmtYocto(yocto: bigint, digits = 3): string {
  const one = 10n ** 24n;
  const whole = yocto / one;
  const frac = ((yocto % one) * 10n ** BigInt(digits)) / one;
  return `${whole}.${frac.toString().padStart(digits, "0")}`.replace(/\.?0+$/, "") || "0";
}
