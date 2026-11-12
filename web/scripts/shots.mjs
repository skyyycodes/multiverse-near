// Screenshots of every screen and state against a running fixtures build, at phone and desktop size.
//   pnpm build:fixtures && pnpm serve &   then   node scripts/shots.mjs [baseUrl] [outDir] [filter]
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://localhost:3030";
const out = resolve(process.argv[3] ?? "shots");
const only = process.argv[4];
mkdirSync(out, { recursive: true });

const VIEWPORTS = [
  { name: "390", width: 390, height: 844, scale: 2, mobile: true },
  { name: "1440", width: 1440, height: 900, scale: 1, mobile: false },
];

/** name, path (fixture stage and persona in the query), optional steps run before the picture. */
const SHOTS = [
  { name: "01-welcome", path: "/welcome/?fx=seeded" },
  { name: "02-trade-guest", path: "/?fx=seeded&welcome=0" },
  { name: "03-trade-alice", path: "/?fx=seeded&as=alice" },
  { name: "04-sell-alice-lshape", path: "/sell/?fx=seeded&as=alice&sel=14", wait: "bid #" },
  { name: "05-trade-alice-sold", path: "/?fx=sold&as=alice" },
  { name: "06-world-delayed-holds", path: "/world/?w=3&fx=sold&as=alice" },
  { name: "07-orders-sam", path: "/orders/?w=0&fx=book&as=sam" },
  {
    name: "08-orders-accept-ask",
    path: "/orders/?w=0&fx=book&as=sam",
    steps: async (page) => {
      await page.locator('[data-demo="ladder-row"][data-side="ask"] [data-demo="accept"]').last().click();
      await page.getByText("Buy from ask").first().waitFor();
    },
  },
  {
    name: "09-orders-crossing",
    path: "/orders/?w=0&fx=book&as=alice",
    steps: async (page) => {
      await page.locator('[data-demo="post-price"]').fill("3.80");
      await page.locator('[data-demo="post-amount"]').fill("200");
    },
  },
  { name: "10-borrow-alice", path: "/borrow/?fx=borrowed&as=alice" },
  { name: "11-borrow-carl-liquidatable", path: "/borrow/?fx=pushed&as=carl" },
  { name: "12-borrow-carl-paused", path: "/borrow/?fx=proposed&as=carl" },
  { name: "13-lend-bob", path: "/lend/?fx=borrowed&as=bob" },
  { name: "14-lend-uma-rootlp", path: "/lend/?fx=lp&as=uma" },
  { name: "15-resolve-proposed", path: "/resolve/?fx=proposed&as=alice" },
  { name: "16-resolve-fed", path: "/resolve/?fx=fed&as=alice" },
  { name: "17-resolve-collapsed", path: "/resolve/?fx=collapsed&as=alice" },
  { name: "18-admin-owner", path: "/admin/?fx=pushed&as=owner" },
  {
    name: "19-trade-binary",
    path: "/?fx=seeded&as=alice",
    steps: async (page) => {
      await page.locator('[data-demo="scenario-switch"]').click();
      await page.locator('[data-demo="scenario-binary"]').click();
      await page.waitForTimeout(600);
    },
  },
  { name: "20-trade-collapsed", path: "/?fx=collapsed&as=alice" },
  { name: "21-sell-guest", path: "/sell/?fx=seeded&welcome=0" },
  { name: "22-lend-guest", path: "/lend/?fx=seeded&welcome=0" },
];

const browser = await chromium.launch();
let n = 0;
for (const vp of VIEWPORTS) {
  for (const shot of SHOTS) {
    if (only && !new RegExp(only).test(shot.name)) continue;
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.scale,
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(base + shot.path, { waitUntil: "networkidle" });
    await page.waitForSelector("main", { timeout: 15_000 });
    if (shot.wait) await page.getByText(shot.wait).first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(900);
    if (shot.steps) await shot.steps(page);
    await page.waitForTimeout(500);
    const file = join(out, `${shot.name}-${vp.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    // The first screen as a phone shows it, with the floating navigation where it really sits.
    if (vp.mobile) await page.screenshot({ path: join(out, `${shot.name}-${vp.name}-screen.png`) });
    n++;
    console.log(`${file}${errors.length ? `  (${errors.length} console errors: ${errors[0].slice(0, 160)})` : ""}`);
    await context.close();
  }
}
await browser.close();
console.log(`${n} screenshots in ${out}`);
