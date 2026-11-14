import type { NextConfig } from 'next'
import { networkEnv } from './scripts/network.mjs'

// Every page renders in the browser (wallet, chain reads, 3D scenes), so the build is a plain static site: `out/`.
const config: NextConfig = {
  // contract, token ids and RPC of the chosen deployment, from deployments/<network>.json; staging unless
  // NEXT_PUBLIC_NETWORK names another (scripts/network.mjs)
  env: networkEnv(),
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  devIndicators: false, // no Next.js badge in the corner while developing
  // next dev would otherwise drop its own rules file into the project root
  agentRules: false,

  // a second build folder lets a production build (for a shared preview) run beside the dev server
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // `pnpm typecheck` (tsc 7) is the type gate; Next's own check needs the JS TypeScript API
  typescript: { ignoreBuildErrors: true },
}

export default config
