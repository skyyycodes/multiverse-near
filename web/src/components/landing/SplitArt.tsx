"use client";

import { motion, useReducedMotion } from "framer-motion";
import { auroraStyle } from "@/components/world/WorldCard";
import { HUES } from "@/components/world/hues";

const WORLDS = ["SHIPS·CUTS", "DELAYED·CUTS", "SHIPS·HOLDS", "DELAYED·HOLDS"];

/**
 * The split, drawn: one NEAR in front, and behind it the same NEAR once per future, fanned out like parallel planes.
 * Plays once on arrival; with reduced motion it is simply there.
 */
export function SplitArt({ size = "md" }: { size?: "md" | "lg" }) {
  const reduce = useReducedMotion();
  const lg = size === "lg";
  const w = lg ? 300 : 236;
  const h = lg ? 188 : 148;
  const step = lg ? { x: 34, y: -36 } : { x: 26, y: -28 };
  // Back to front: the last plane sits right behind the root card.
  const order = [3, 2, 1, 0];
  return (
    <div
      className="relative mx-auto"
      style={{ width: w + step.x * 4 + 8, height: h - step.y * 4 + 8, perspective: 1100 }}
      aria-hidden="true"
      data-demo="split-art"
    >
      {order.map((world, k) => {
        const depth = 4 - k; // 4 = farthest
        return (
          <motion.div
            key={world}
            className="absolute overflow-hidden rounded-[20px] text-white shadow-[0_24px_60px_-28px_rgba(1,4,39,0.9)] ring-1 ring-white/25 ring-inset"
            style={{ ...auroraStyle(world, true, 1.35), width: w, height: h, left: 0, bottom: 0, transformOrigin: "left bottom" }}
            initial={reduce ? false : { x: 0, y: 0, opacity: 0, rotateY: 0 }}
            animate={{ x: step.x * depth, y: step.y * depth, opacity: 0.94 - depth * 0.08, rotateY: -14 }}
            transition={{ duration: 0.9, delay: 0.25 + (4 - depth) * 0.09, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-start justify-between px-4 pt-3 text-[11px]">
              <span className="font-mono tracking-[0.06em] text-white/85">{WORLDS[world]}</span>
              <span className="num font-medium" style={{ color: HUES[world] }}>
                1 NEAR
              </span>
            </div>
          </motion.div>
        );
      })}
      <motion.div
        className="absolute flex flex-col justify-between overflow-hidden rounded-[20px] bg-white/92 p-4 text-ink shadow-[0_30px_70px_-30px_rgba(1,4,39,0.95)] ring-1 ring-white backdrop-blur"
        style={{ width: w, height: h, left: 0, bottom: 0, transformOrigin: "left bottom" }}
        initial={reduce ? false : { rotateY: 0, scale: 1.02 }}
        animate={{ rotateY: -14, scale: 1 }}
        transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="flex items-center justify-between">
          <span className="label text-mute">Today</span>
          <span className="flex gap-1">
            {HUES.map((c) => (
              <span key={c} className="size-2 rounded-full" style={{ background: c }} />
            ))}
          </span>
        </div>
        <div>
          <div className={`numeral ${lg ? "text-[52px]" : "text-[40px]"}`}>1 NEAR</div>
          <div className="mt-1 text-[12px] text-mute">= 1 NEAR in each future</div>
        </div>
      </motion.div>
    </div>
  );
}
