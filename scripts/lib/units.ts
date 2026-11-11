// Integer-only amount handling. Token amounts are bigint base units end to end; strings are only
// for humans and JSON. Nothing in here goes through a JS number.

export const NEAR_DECIMALS = 24;
export const WAD_DECIMALS = 18;
export const WAD = 10n ** 18n;
export const TGAS = 10n ** 12n;

const DECIMAL = /^(\d+)(?:\.(\d*))?$/;

function checkDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new Error(`invalid decimals: ${decimals}`);
  }
}

/**
 * "1.5" with 6 decimals -> 1_500_000n. Rejects signs, exponents, separators and more fractional
 * digits than the token has, rather than silently rounding.
 */
export function parseUnits(human: string, decimals: number): bigint {
  checkDecimals(decimals);
  const match = DECIMAL.exec(human.trim());
  if (!match) throw new Error(`not a decimal amount: "${human}"`);
  const whole = match[1] ?? "0";
  const frac = match[2] ?? "";
  if (frac.length > decimals) {
    throw new Error(`"${human}" has more than ${decimals} decimal places`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export interface FormatOptions {
  /** Cut the fraction to this many digits, rounding down. Default: all of them. */
  maxFractionDigits?: number;
  /** Drop trailing zeros (and the dot). Default true. */
  trimZeros?: boolean;
}

/** 1_500_000n with 6 decimals -> "1.5". Rounds down when cutting digits, like the EVM scripts did. */
export function formatUnits(amount: bigint, decimals: number, options: FormatOptions = {}): string {
  checkDecimals(decimals);
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = decimals === 0 ? "" : (abs % base).toString().padStart(decimals, "0");
  if (options.maxFractionDigits !== undefined) frac = frac.slice(0, options.maxFractionDigits);
  if (options.trimZeros ?? true) frac = frac.replace(/0+$/, "");
  // a negative amount that rounds to nothing prints as zero, not "-0"
  const sign = negative && (whole > 0n || /[1-9]/.test(frac)) ? "-" : "";
  return `${sign}${whole}${frac ? `.${frac}` : ""}`;
}

export const parseNear = (human: string): bigint => parseUnits(human, NEAR_DECIMALS);

export const formatNear = (yocto: bigint, maxFractionDigits = 4): string =>
  formatUnits(yocto, NEAR_DECIMALS, { maxFractionDigits });

export const tgas = (teraGas: number): bigint => {
  if (!Number.isInteger(teraGas) || teraGas <= 0) throw new Error(`invalid Tgas: ${teraGas}`);
  return BigInt(teraGas) * TGAS;
};

/** The protocol keeps every amount in 18-decimal units; this is the factor for a token's decimals. */
export function internalScale(tokenDecimals: number): bigint {
  checkDecimals(tokenDecimals);
  if (tokenDecimals > WAD_DECIMALS) throw new Error(`token decimals above 18: ${tokenDecimals}`);
  return 10n ** BigInt(WAD_DECIMALS - tokenDecimals);
}

export const toInternal = (tokenAmount: bigint, tokenDecimals: number): bigint =>
  tokenAmount * internalScale(tokenDecimals);

/** Floors, exactly like the contract's payout conversion. */
export const fromInternal = (internal: bigint, tokenDecimals: number): bigint =>
  internal / internalScale(tokenDecimals);

/** Parses a U128 JSON value ("123") into a bigint, refusing anything that is not a plain integer. */
export function u128(value: unknown, what = "value"): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${what} is not a U128 string: ${JSON.stringify(value)}`);
  }
  const n = BigInt(value);
  if (n >= 1n << 128n) throw new Error(`${what} does not fit in u128: ${value}`);
  return n;
}
