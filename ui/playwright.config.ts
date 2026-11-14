import { defineConfig } from '@playwright/test'

// STAGING=1: the ui against the staging deployment on testnet, signing with test keys through the demo-wallet bridge
// (e2e/staging/chain.ts). It serves the local out-staging build (`pnpm build:staging`) on :3045; BASE_URL points it at
// a deployed site instead. Real transactions: keep specs to the staging family's accounts.
const STAGING_URL = process.env.BASE_URL || 'http://localhost:3045'

export default defineConfig({
  testDir: 'e2e',
  timeout: 600_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure', reducedMotion: 'reduce' },
  projects: [{ name: 'staging', testMatch: /\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, baseURL: STAGING_URL, actionTimeout: 30_000, navigationTimeout: 60_000 } }],
  webServer: process.env.BASE_URL ? [] : [{ command: 'node scripts/serve.mjs out-staging 3045', port: 3045, reuseExistingServer: true }],
})
