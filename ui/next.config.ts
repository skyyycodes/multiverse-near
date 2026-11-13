import type { NextConfig } from 'next'

// The app is all client-side state (wallet, scenario store, 3D scenes), so pages are client components.
const config: NextConfig = {
  reactStrictMode: true,
  devIndicators: false, // no Next.js badge in the corner while developing

  // a second build folder lets a production build (for a shared preview) run beside the dev server
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // `pnpm typecheck` (tsc 7) runs separately in CI; Next's own check needs the JS TypeScript API
  typescript: { ignoreBuildErrors: true },
}

export default config
