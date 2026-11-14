import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "out-fixtures/**", "out-live/**", "out-demo/**", "out-staging/**", "out-rehearsal/**", "public/outlayer/**", "build/**", "test-results/**", "playwright-report/**", "next-env.d.ts"]),
]);
