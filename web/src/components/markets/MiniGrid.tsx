"use client";

import { DEAD, HATCH, hueOf, isHatched } from "@/components/world/hues";
import { gridBlocks, isPossible } from "@/lib/market";

/** A market's worlds as 10 px squares in grid order: 2 in a row, 4 as a 2×2, 8 as two 2×2 blocks (4-7 hatched). */
export function MiniGrid({ worldCount, possible, title }: { worldCount: number; possible: number; title?: string }) {
  return (
    <span aria-hidden={title ? undefined : true} title={title} className="inline-flex shrink-0 gap-1">
      {gridBlocks(worldCount).map((block, b) => (
        <span key={b} className="grid grid-cols-2 gap-[2px]">
          {block.map((w) => {
            const alive = isPossible(possible, w);
            return (
              <span
                key={w}
                className="size-[10px] rounded-[3px]"
                style={{ background: alive ? (isHatched(w) ? `${HATCH}, ${hueOf(w)}` : hueOf(w)) : DEAD, opacity: alive ? 1 : 0.45 }}
              />
            );
          })}
        </span>
      ))}
    </span>
  );
}
