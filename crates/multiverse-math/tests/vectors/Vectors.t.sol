// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Reference vectors for crates/multiverse-math, computed by the EVM libraries this crate ports.
//
// To rebuild the file: copy this file into the EVM project's contracts/test/, allow writes to ./vectors in foundry.toml
// (fs_permissions = [{ access = "read-write", path = "./vectors" }]), run `forge test --match-contract VectorsTest`
// (Foundry 1.9.0, solc 0.8.26), then concatenate the section files in order:
//   cat vectors/{tickmath,pricemath,odds,shares-orders,muldiv,swapflow,twap}.txt > evm-vectors.txt
// Each test writes its own file because forge runs tests in parallel. Inputs come from a fixed keccak chain, so the
// output is deterministic.

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PriceMath} from "../src/libraries/PriceMath.sol";
import {OddsTree} from "../src/libraries/OddsTree.sol";
import {SharesMath} from "../src/libraries/SharesMath.sol";
import {OrderMath} from "../src/libraries/OrderMath.sol";
import {SwapFlow} from "../src/libraries/SwapFlow.sol";
import {TwapOracle} from "../src/libraries/TwapOracle.sol";

contract VectorsTest is Test {
    using SwapFlow for SwapFlow.State;
    using TwapOracle for TwapOracle.State;

    uint256 seed = 0x5eed;
    string out;

    SwapFlow.State flow;
    TwapOracle.State twap;

    function rnd() internal returns (uint256) {
        seed = uint256(keccak256(abi.encode(seed)));
        return seed;
    }

    /// A random value of 0..maxBits random bits, so small and large magnitudes both show up.
    function rndBits(uint256 maxBits) internal returns (uint256) {
        uint256 bits = rnd() % (maxBits + 1);
        if (bits == 0) return 0;
        return rnd() >> (256 - bits);
    }

    function open(string memory name, uint256 sectionSeed) internal {
        out = string.concat("vectors/", name, ".txt");
        seed = sectionSeed;
        vm.writeFile(out, "");
    }

    function line(string memory text) internal {
        vm.writeLine(out, text);
    }

    function s(uint256 v) internal pure returns (string memory) {
        return vm.toString(v);
    }

    function i(int256 v) internal pure returns (string memory) {
        return vm.toString(v);
    }

    function sqrtAt(int24 t) internal {
        line(string.concat("sqrt_at_tick ", i(t), " ", s(TickMath.getSqrtPriceAtTick(t))));
    }

    function tickAt(uint160 p) internal {
        line(string.concat("tick_at_sqrt ", s(p), " ", i(TickMath.getTickAtSqrtPrice(p))));
    }

    function test_tickMath() public {
        open("tickmath", 0x5eed);
        int24 MIN = TickMath.MIN_TICK;
        int24 MAX = TickMath.MAX_TICK;

        sqrtAt(MIN);
        sqrtAt(MIN + 1);
        sqrtAt(MAX);
        sqrtAt(MAX - 1);
        sqrtAt(0);
        for (uint256 k; k < 20; ++k) {
            int24 p = int24(int256(1 << k));
            sqrtAt(p);
            sqrtAt(-p);
            if (p + 1 <= MAX) {
                sqrtAt(p + 1);
                sqrtAt(-p - 1);
            }
            if (p > 1) {
                sqrtAt(p - 1);
                sqrtAt(-p + 1);
            }
        }
        int24[16] memory named =
            [int24(50), 60, 100, 250, 500, 1000, 2500, 3000, 4000, 5000, 50000, 150000, 250000, 500000, 738203, 887220];
        for (uint256 k; k < named.length; ++k) {
            sqrtAt(named[k]);
            sqrtAt(-named[k]);
        }
        for (uint256 k; k < 300; ++k) {
            sqrtAt(int24(int256(rnd() % uint256(int256(2 * MAX + 1))) + MIN));
        }

        tickAt(TickMath.MIN_SQRT_PRICE);
        tickAt(TickMath.MIN_SQRT_PRICE + 1);
        tickAt(4295343490);
        tickAt(TickMath.MAX_SQRT_PRICE - 1);
        tickAt(1461373636630004318706518188784493106690254656249);
        tickAt(uint160(1 << 96));
        for (uint160 p = TickMath.MIN_SQRT_PRICE; p < TickMath.MAX_SQRT_PRICE / 16; p *= 16) {
            tickAt(p);
        }
        for (uint256 k = 33; k < 160; ++k) {
            tickAt(uint160(1 << k));
        }
        // Either side of a tick's own price is where an off-by-one would show.
        for (uint256 k; k < 150; ++k) {
            int24 t = int24(int256(rnd() % uint256(int256(2 * MAX - 1))) + MIN + 1);
            uint160 p = TickMath.getSqrtPriceAtTick(t);
            tickAt(p);
            tickAt(p - 1);
            tickAt(p + 1);
        }
        for (uint256 k; k < 150; ++k) {
            uint256 bits = 33 + rnd() % 127;
            uint256 v = (rnd() >> (256 - bits)) | (uint256(1) << (bits - 1));
            if (v >= TickMath.MAX_SQRT_PRICE) v = TickMath.MAX_SQRT_PRICE - 1;
            if (v < TickMath.MIN_SQRT_PRICE) v = TickMath.MIN_SQRT_PRICE;
            tickAt(uint160(v));
        }
    }

    function toSqrt(uint256 p) internal {
        uint160 q = PriceMath.toSqrtPriceX96(p);
        line(string.concat("to_sqrt ", s(p), " ", s(q)));
        line(string.concat("from_sqrt ", s(q), " ", s(PriceMath.fromSqrtPriceX96(q))));
    }

    function fromTick(int24 t) internal {
        line(string.concat("from_tick ", i(t), " ", s(PriceMath.fromTick(t))));
    }

    function test_priceMath() public {
        open("pricemath", 0xbeef);
        uint256[17] memory prices = [
            uint256(1e12),
            1e15,
            1e18,
            2500e18,
            2800e18,
            2900e18,
            3000e18,
            3200e18,
            3300e18,
            3400e18,
            3700e18,
            3163.359e18,
            3037866632000000000000,
            3038516627000000000000,
            1e24,
            1e26,
            123456789012345678901234
        ];
        for (uint256 k; k < prices.length; ++k) {
            toSqrt(prices[k]);
        }
        for (uint256 k; k < 60; ++k) {
            uint256 digits = 12 + rnd() % 15;
            toSqrt(10 ** digits + rnd() % (9 * 10 ** digits));
        }
        // The demo's seeded prices: the tick a fresh pool records, then what a TWAP at that tick reads.
        for (uint256 k = 3; k < 11; ++k) {
            int24 t = TickMath.getTickAtSqrtPrice(PriceMath.toSqrtPriceX96(prices[k]));
            line(string.concat("seed_tick ", s(prices[k]), " ", i(t)));
            fromTick(t);
        }
        fromTick(0);
        fromTick(-1);
        fromTick(1);
        for (uint256 k; k < 80; ++k) {
            fromTick(int24(int256(rnd() % 800001)) - 400000);
        }
        for (uint256 k; k < 40; ++k) {
            uint256 digits = 15 + rnd() % 9;
            uint256 p = 10 ** digits + rnd() % (9 * 10 ** digits);
            line(string.concat("pool_price_inv ", s(p), " ", s(PriceMath.poolPrice(p, false))));
            line(string.concat("wnear_price_inv ", s(p), " ", s(PriceMath.wnearPrice(p, false))));
        }
    }

    function oddsLine(uint256 a, uint256 b) internal {
        uint160 q = OddsTree.sqrtPriceForOdds(a, b);
        line(string.concat("sqrt_for_odds ", s(a), " ", s(b), " ", s(q)));
        line(string.concat("share0 ", s(q), " ", s(OddsTree.shareOfToken0(q))));
    }

    function test_odds() public {
        open("odds", 0x0dd5);
        uint256[2][8] memory odds = [
            [uint256(2), 1],
            [uint256(6667), 3333],
            [uint256(3), 7],
            [uint256(3000), 7000],
            [uint256(104), 9896],
            [uint256(1e18), 1],
            [uint256(1), 1e18],
            [uint256(666700000000000000), 333300000000000000]
        ];
        for (uint256 k; k < odds.length; ++k) {
            oddsLine(odds[k][0], odds[k][1]);
        }
        for (uint256 k; k < 40; ++k) {
            oddsLine(1 + rnd() % 1e24, 1 + rnd() % 1e24);
        }
    }

    function test_sharesAndOrders() public {
        open("shares-orders", 0x5a5e);
        for (uint256 k; k < 60; ++k) {
            uint256 x = rnd() >> (256 - (1 + rnd() % 120));
            uint256 ta = rnd() >> (256 - (1 + rnd() % 120));
            uint256 ts = rnd() >> (256 - (1 + rnd() % 120));
            string memory args = string.concat(s(x), " ", s(ta), " ", s(ts), " ");
            line(string.concat("to_shares_down ", args, s(SharesMath.toSharesDown(x, ta, ts))));
            line(string.concat("to_shares_up ", args, s(SharesMath.toSharesUp(x, ta, ts))));
            line(string.concat("to_assets_down ", args, s(SharesMath.toAssetsDown(x, ta, ts))));
            line(string.concat("to_assets_up ", args, s(SharesMath.toAssetsUp(x, ta, ts))));
        }
        for (uint256 k; k < 60; ++k) {
            uint256 amount = rnd() >> (256 - (1 + rnd() % 100));
            uint256 price = rnd() >> (256 - (1 + rnd() % 80));
            string memory args = string.concat(s(amount), " ", s(price), " ");
            line(string.concat("cost ", args, s(OrderMath.cost(amount, price))));
            line(string.concat("proceeds ", args, s(OrderMath.proceeds(amount, price))));
        }
    }

    function mulDivExt(uint256 x, uint256 y, uint256 d, bool up) external pure returns (uint256) {
        return Math.mulDiv(x, y, d, up ? Math.Rounding.Ceil : Math.Rounding.Floor);
    }

    function mulDivLine(string memory tag, uint256 x, uint256 y, uint256 d) internal {
        string memory args = string.concat(tag, " ", s(x), " ", s(y), " ", s(d), " ");
        try this.mulDivExt(x, y, d, false) returns (uint256 down) {
            line(string.concat(args, s(down), " ", s(this.mulDivExt(x, y, d, true))));
        } catch {
            line(string.concat(args, "overflow"));
        }
    }

    function test_mulDiv() public {
        open("muldiv", 0x3d1f);
        // u128 operands, as the contract passes them; the quotient may still exceed u128.
        for (uint256 k; k < 200; ++k) {
            uint256 d = rndBits(128);
            mulDivLine("mul_div", rndBits(128), rndBits(128), d == 0 ? 1 : d);
        }
        uint256 m = type(uint128).max;
        mulDivLine("mul_div", m, m, m);
        mulDivLine("mul_div", m, m, 1);
        mulDivLine("mul_div", m, m - 1, m);
        mulDivLine("mul_div", m, 2, 2);
        // 256-bit operands with a 512-bit product.
        for (uint256 k; k < 120; ++k) {
            uint256 d = rndBits(256);
            mulDivLine("mul_div_256", rndBits(256), rndBits(256), d == 0 ? 1 : d);
        }
        uint256 n = type(uint256).max;
        mulDivLine("mul_div_256", n, n, n);
        mulDivLine("mul_div_256", n, n - 1, n);
        mulDivLine("mul_div_256", n, n, n - 1);
    }

    function flowState() internal {
        (int256 netSold, uint256 total) = flow.window();
        uint24 base = uint24(rnd() % 20001);
        uint24 cap = base + uint24(rnd() % 20001);
        line(
            string.concat(
                "flow_state ",
                i(netSold),
                " ",
                s(total),
                " ",
                s(flow.count),
                " ",
                s(flow.fee(3000, 15000)),
                " ",
                s(base),
                " ",
                s(cap),
                " ",
                s(flow.fee(base, cap))
            )
        );
    }

    function test_swapFlow() public {
        open("swapflow", 0xf10e);
        for (uint256 run; run < 24; ++run) {
            delete flow;
            line("flow_reset");
            flowState();
            uint256 steps = rnd() % 26;
            for (uint256 k; k < steps; ++k) {
                uint256 r = rnd();
                int128 v;
                if (r % 16 == 0) {
                    v = 0;
                } else if (r % 16 == 1) {
                    v = type(int128).min;
                } else if (r % 16 == 2) {
                    v = type(int128).max;
                } else {
                    // Small runs of one sign so windows come out balanced, lopsided and in between.
                    int256 magnitude = int256(rndBits(127 - (r >> 8) % 64));
                    v = int128((r >> 16) % 3 == 0 ? magnitude : -magnitude);
                }
                flow.record(v);
                line(string.concat("flow_record ", i(v)));
                flowState();
            }
        }
    }

    function twapQueries(uint32 first, uint32 last) internal {
        for (uint256 k; k < 6; ++k) {
            uint32 target = first - 5 + uint32(rnd() % (uint256(last - first) + 106));
            (int56 c, bool ok) = twap.cumulativeAt(target);
            line(string.concat("twap_cum ", s(target), " ", ok ? "1 " : "0 ", i(c)));
        }
        uint32[4] memory windows = [uint32(0), 1, 30, 60];
        for (uint256 k; k < 6; ++k) {
            uint32 time = first + uint32(rnd() % (uint256(last - first) + 101));
            uint32 window = k < 4 ? windows[k] : uint32(rnd() % 400);
            (int24 t, bool ok) = twap.meanTick(time, window);
            line(string.concat("twap_mean ", s(time), " ", s(window), " ", ok ? "1 " : "0 ", i(t)));
        }
        line(string.concat("twap_count ", s(twap.count), " ", s(twap.newest)));
    }

    function test_twap() public {
        open("twap", 0x7a3a);
        uint256[4] memory fixedWrites = [uint256(0), 20, 129, 260];
        for (uint256 run; run < 8; ++run) {
            delete twap;
            uint32 first = uint32(1_700_000_000 + rnd() % 1_000_000);
            int24 tick = int24(int256(rnd() % 1_774_545)) - 887272;
            twap.initialize(first, tick);
            line(string.concat("twap_init ", s(first), " ", i(tick)));
            uint32 time = first;
            twapQueries(first, time);
            // About a quarter of the writes overwrite within a second, so the 260-write run is the one that wraps
            // the 128-slot ring.
            uint256 writes = run < 4 ? fixedWrites[run] : rnd() % 200;
            for (uint256 k; k < writes; ++k) {
                uint256 r = rnd();
                // One write in four lands in the same second and overwrites the newest tick.
                if (r % 4 != 0) time += uint32(1 + (r >> 8) % 50);
                tick = (r >> 64) % 8 == 0 ? int24(int256((r >> 96) % 1_774_545)) - 887272 : int24(int256((r >> 96) % 2_001)) - 1_000;
                twap.write(time, tick);
                line(string.concat("twap_write ", s(time), " ", i(tick)));
                if (k % 25 == 24) twapQueries(first, time);
            }
            twapQueries(first, time);
        }
    }
}
