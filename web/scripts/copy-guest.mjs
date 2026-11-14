// Copies the OutLayer guests into web/public/outlayer/ so every build serves them at a fixed path next to the app:
// /outlayer/fred-guest.wasm (FOMC resolution, pinned by set_outlayer_config) and /outlayer/nearusd-guest.wasm (the
// NEAR/USD reference, pinned by set_reference_config). A guest that is not built yet is skipped with a warning, so the
// build still runs; check-release.mjs is what refuses a release without the guest its network needs.
//
//   node scripts/copy-guest.mjs
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(WEB, "..");
export const OUTLAYER_DIR = join(WEB, "public", "outlayer");

export const GUESTS = [
  { name: "fred-guest.wasm", from: join(REPO, "oracle", "fred-guest", "dist", "fred-guest.wasm") },
  { name: "nearusd-guest.wasm", from: join(REPO, "oracle", "nearusd-guest", "dist", "nearusd-guest.wasm") },
];

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function copyGuests(log = console) {
  mkdirSync(OUTLAYER_DIR, { recursive: true });
  const copied = [];
  for (const g of GUESTS) {
    const to = join(OUTLAYER_DIR, g.name);
    if (!existsSync(g.from)) {
      // A copy left from an earlier build would be served without its source: drop it.
      rmSync(to, { force: true });
      log.warn(`warning: ${g.from} is missing; /outlayer/${g.name} will not be served by this build`);
      continue;
    }
    copyFileSync(g.from, to);
    const bytes = readFileSync(to);
    log.log(`/outlayer/${g.name}: ${bytes.length} bytes, sha256 ${sha256(bytes)}`);
    copied.push(g.name);
  }
  return copied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) copyGuests();
