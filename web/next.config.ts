import type { NextConfig } from "next";
import { networkEnv } from "./scripts/network.mjs";

const nextConfig: NextConfig = {
  // Contract, token ids and RPC of the chosen network, from deployments/<network>.json.
  env: networkEnv(),
  // next dev would otherwise drop its own rules file into the project root.
  agentRules: false,
  // Everything renders in the browser (wallet, chain reads), so the build is a plain static site.
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  devIndicators: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
