import { defineConfig, devices } from "@playwright/test";

// Default run: the design fixtures (deterministic UI flows, `pnpm build:fixtures`), the real build against testnet
// (`pnpm build`), and the demo-wallet build signing against a stand-in RPC (`pnpm build:demo`).
// LIVE=1: the acceptance flow against a seeded local sandbox node (`pnpm build:live`), one serial run.
// STAGING=1: real transactions on the staging deployment (testnet) through the UI (`pnpm build:staging`); BASE_URL
// points it at a deployed site instead of the local out-staging server.
const LIVE = process.env.LIVE === "1";
const STAGING = process.env.STAGING === "1";
const STAGING_URL = process.env.BASE_URL || "http://localhost:3045";

export default defineConfig({
  testDir: "e2e",
  timeout: STAGING ? 600_000 : LIVE ? 240_000 : 60_000,
  expect: { timeout: STAGING ? 30_000 : 15_000 },
  fullyParallel: !LIVE && !STAGING,
  workers: LIVE || STAGING ? 1 : undefined,
  reporter: [["list"]],
  use: { trace: "retain-on-failure", reducedMotion: "reduce" },
  projects: STAGING
    ? [{ name: "staging", testMatch: /staging\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, baseURL: STAGING_URL, actionTimeout: 30_000, navigationTimeout: 60_000 } }]
    : LIVE
    ? [{ name: "live", testMatch: /live\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, baseURL: "http://localhost:3043" } }]
    : [
        { name: "fixtures-phone", testMatch: /fixtures\.spec\.ts/, use: { ...devices["iPhone 13"], browserName: "chromium", baseURL: "http://localhost:3041" } },
        { name: "fixtures-desktop", testMatch: /fixtures\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, baseURL: "http://localhost:3041" } },
        { name: "chain", testMatch: /chain\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, baseURL: "http://localhost:3042" } },
        { name: "demo", testMatch: /chain(-mock)?\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, baseURL: "http://localhost:3044" } },
      ],
  webServer: STAGING
    ? process.env.BASE_URL
      ? []
      : [{ command: "node scripts/serve.mjs out-staging 3045", port: 3045, reuseExistingServer: true }]
    : LIVE
    ? [{ command: "node scripts/serve.mjs out-live 3043", port: 3043, reuseExistingServer: true }]
    : [
        { command: "node scripts/serve.mjs out-fixtures 3041", port: 3041, reuseExistingServer: true },
        { command: "node scripts/serve.mjs out 3042", port: 3042, reuseExistingServer: true },
        { command: "node scripts/serve.mjs out-demo 3044", port: 3044, reuseExistingServer: true },
      ],
});
