// Constant-product maths for the design fixtures, matching the contract's pool rules: fee taken on the input
// (a_eff = a·(1e6 − fee)/1e6, floored), output floored, the fee kept outside the reserves.

export const PIPS = 1_000_000n;
export const E18 = 10n ** 18n;

export type Pool = { x: bigint; y: bigint; t: bigint; feePips: bigint };

/** Output of selling `amountIn` of the X side (WETH-if-w) for the Y side (USDC-if-w). */
export function swapOut(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feePips: bigint): bigint {
  if (amountIn <= 0n || reserveIn === 0n || reserveOut === 0n) return 0n;
  const aEff = (amountIn * (PIPS - feePips)) / PIPS;
  return (reserveOut * aEff) / (reserveIn + aEff);
}

/** The pool after selling `amountIn` WETH-if-w into it, and what it paid. */
export function sellInto(p: Pool, amountIn: bigint, nextFee = p.feePips): { pool: Pool; out: bigint } {
  const out = swapOut(p.x, p.y, amountIn, p.feePips);
  const aEff = (amountIn * (PIPS - p.feePips)) / PIPS;
  return { pool: { x: p.x + aEff, y: p.y - out, t: p.t, feePips: nextFee }, out };
}

/** USDC per WETH, 18 decimals, floored. */
export const priceOf = (p: Pool): bigint => (p.x === 0n ? 0n : (p.y * E18) / p.x);

export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("negative");
  if (n < 2n) return n;
  // Newton from a power of two above the root decreases monotonically onto the floor root.
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** A pool seeded at `price` with `depth` WETH (both 18 decimals), liquidity units √(x·y). */
export function seededPool(depth: bigint, price: bigint, feePips = 3000n): Pool {
  const x = depth;
  const y = (depth * price) / E18;
  return { x, y, t: isqrt(x * y), feePips };
}

/** Liquidity a deposit of (w, u) buys at the pool's ratio, and what the pool keeps of it (rounded up). */
export function addLiquidity(p: Pool, w: bigint, u: bigint): { liquidity: bigint; keptWeth: bigint; keptUsdc: bigint } {
  const byW = (w * p.t) / p.x;
  const byU = (u * p.t) / p.y;
  const liquidity = byW < byU ? byW : byU;
  const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n);
  return { liquidity, keptWeth: ceilDiv(liquidity * p.x, p.t), keptUsdc: ceilDiv(liquidity * p.y, p.t) };
}
