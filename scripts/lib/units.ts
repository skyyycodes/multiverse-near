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

/** 1_500_000n with 6 decimals -> "1.5". Rounds down when cutting digits. */
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

// The protocol keeps every amount in 18-decimal internal units. At the token boundary:
// - up to 18 decimals, internal = raw x 10^(18-d) and a payout floors back to raw, the dust staying
//   in the contract;
// - above 18 decimals (wNEAR has 24), internal = floor(raw / 10^(d-18)): the contract hands the
//   remainder back as unused, and a payout is exact, raw = internal x 10^(d-18).

function checkTokenDecimals(tokenDecimals: number): void {
  checkDecimals(tokenDecimals);
  if (tokenDecimals > NEAR_DECIMALS) throw new Error(`token decimals above ${NEAR_DECIMALS}: ${tokenDecimals}`);
}

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** Token base units to internal units, flooring for a token with more than 18 decimals. */
export function toInternal(raw: bigint, tokenDecimals: number): bigint {
  checkTokenDecimals(tokenDecimals);
  return tokenDecimals <= WAD_DECIMALS
    ? raw * pow10(WAD_DECIMALS - tokenDecimals)
    : raw / pow10(tokenDecimals - WAD_DECIMALS);
}

/** Internal units to token base units, exactly as the contract pays out (floors up to 18 decimals). */
export function toRaw(internal: bigint, tokenDecimals: number): bigint {
  checkTokenDecimals(tokenDecimals);
  return tokenDecimals <= WAD_DECIMALS
    ? internal / pow10(WAD_DECIMALS - tokenDecimals)
    : internal * pow10(tokenDecimals - WAD_DECIMALS);
}

/**
 * The smallest internal amount that is a whole number of token base units: 10^(18-d) up to 18
 * decimals, and 1 above, where every internal unit is 10^(d-18) base units.
 */
export function internalStep(tokenDecimals: number): bigint {
  checkTokenDecimals(tokenDecimals);
  return tokenDecimals <= WAD_DECIMALS ? pow10(WAD_DECIMALS - tokenDecimals) : 1n;
}

/** Rounds an internal amount up to a whole number of token base units. */
export function roundUpToStep(internal: bigint, tokenDecimals: number): bigint {
  const step = internalStep(tokenDecimals);
  return ((internal + step - 1n) / step) * step;
}

/** Rounds an internal amount down to a whole number of token base units. */
export function roundDownToStep(internal: bigint, tokenDecimals: number): bigint {
  const step = internalStep(tokenDecimals);
  return (internal / step) * step;
}

/** Parses a U128 JSON value ("123") into a bigint, refusing anything that is not a plain integer. */
export function u128(value: unknown, what = "value"): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${what} is not a U128 string: ${JSON.stringify(value)}`);
  }
  const n = BigInt(value);
  if (n >= 1n << 128n) throw new Error(`${what} does not fit in u128: ${value}`);
  return n;
}

/** The token amount for `internal`, refusing an amount that is not a whole number of base units. */
export function exactRaw(internal: bigint, tokenDecimals: number, what = "amount"): bigint {
  const raw = toRaw(internal, tokenDecimals);
  if (toInternal(raw, tokenDecimals) !== internal) {
    throw new Error(`${what} ${internal} is not a whole number of base units of a ${tokenDecimals}-decimal token`);
  }
  return raw;
}

/** `raw` cut into amounts of at most `cap`, in order: one faucet `mint` call each. */
export function splitByCap(raw: bigint, cap: bigint): bigint[] {
  if (cap <= 0n) throw new Error(`mint cap must be positive, not ${cap}`);
  if (raw < 0n) throw new Error(`cannot mint a negative amount: ${raw}`);
  const parts: bigint[] = [];
  for (let left = raw; left > 0n; left -= left > cap ? cap : left) parts.push(left > cap ? cap : left);
  return parts;
}
