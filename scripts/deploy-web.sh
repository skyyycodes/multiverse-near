#!/usr/bin/env bash
# Assembles the Vercel deploy directory of the public app and deploys it to production of the
# existing project "multiverse-lending" (https://multiverse-lending.vercel.app).
#
#   scripts/deploy-web.sh [--dry-run] [--web-out <dir>] [--deployments <file>] [--out <dir>] [--no-check]
#
# The directory (default .deploy/web, gitignored):
#   public/                 the static site: the staging web build (default web/out-staging, from
#                           `pnpm -C web build:staging`) plus /outlayer/fred-guest.wasm (the exact
#                           bytes production serves today, sha256 8c809e11..., which the v1 contract's
#                           OutLayer config pins) and /outlayer/nearusd-guest.wasm (oracle/nearusd-guest/dist)
#   api/keeper.js           scripts/api/keeper.ts bundled by esbuild (no dependencies to install), with
#                           the deployment's account ids baked in; keys only from the environment
#   package.json            {"type":"module"}, nothing to install, no build step
#   vercel.json             deploy/vercel.json: trailing slashes as today, the keeper cron every minute
#
# --dry-run assembles and lists the files, deploys nothing. Without it: `vercel deploy --prod`. A Hobby
# account refuses crons that run more than once a day; then the cron falls back to daily and the
# page pings (web/src/lib/keeper-ping.ts) keep the keeper running while the site is open.
# Secrets: scripts/keeper-env.sh prints the `vercel env add` commands (KEEPER_KEY, REPORTER_KEY, CRON_SECRET).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCOPE="akash-chakrabortys-projects-ce92467d"
ORG_ID="team_GjK63i5tXaGTujlS7kZBCLYu"
PROJECT_ID="prj_wSWh2LNDucaKAt1ynCd5GI9UHW7K"
PROD_URL="https://multiverse-lending.vercel.app"
FRED_SHA256="8c809e11f5b4b37627baa5c0a65a8587ef5f3e4918d1e0bb42cb2f87a5ae1660"
NEARUSD_SHA256="6034aac8620b4559660c0315f1d4897509b6c3a722290e6c426ab50c21f52fc7"

DRY_RUN=0
CHECK=1
WEB_OUT="$REPO/web/out-staging"
DEPLOYMENTS="$REPO/deployments/staging.json"
OUT="$REPO/.deploy/web"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-check) CHECK=0 ;;
    --web-out) WEB_OUT="$(cd "$2" && pwd -P)"; shift ;;
    --deployments) DEPLOYMENTS="$2"; shift ;;
    --out) OUT="$2"; shift ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

die() { echo "deploy-web: $*" >&2; exit 1; }
sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }

[ -f "$WEB_OUT/index.html" ] || die "$WEB_OUT/index.html is missing: run \`pnpm -C web build:staging\` first"
[ -f "$DEPLOYMENTS" ] || die "$DEPLOYMENTS is missing"
if [ -f "$WEB_OUT/version.json" ]; then
  network="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).network||"")' "$WEB_OUT/version.json")"
  [ "$network" = "staging" ] || die "$WEB_OUT was built for '$network', not staging"
fi
if [ "$CHECK" = 1 ]; then
  node "$REPO/web/scripts/check-release.mjs" "$WEB_OUT" staging || die "the web build fails the release check (--no-check skips it)"
fi

# The account ids the keeper works on, from the deployment record (public ids only).
TARGETS="$(node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const t = { contractId: d.contractId, usdcId: d.usdc, keeperId: (d.ops && d.ops.keeper) || `keeper.${d.root}`, reporterId: d.reporter };
  for (const [k, v] of Object.entries(t)) if (typeof v !== "string" || !/^[a-z0-9._-]+$/.test(v)) { console.error(`bad ${k}: ${v}`); process.exit(1); }
  process.stdout.write(JSON.stringify(t));
' "$DEPLOYMENTS")"

rm -rf "$OUT"
mkdir -p "$OUT/public/outlayer" "$OUT/api"
cp -R "$WEB_OUT/." "$OUT/public/"

# fred-guest.wasm: the bytes production serves, checked against the pinned hash.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if curl -fsS --max-time 60 -o "$tmp/fred-guest.wasm" "$PROD_URL/outlayer/fred-guest.wasm" && [ "$(sha256 "$tmp/fred-guest.wasm")" = "$FRED_SHA256" ]; then
  cp "$tmp/fred-guest.wasm" "$OUT/public/outlayer/fred-guest.wasm"
  echo "fred-guest.wasm: fetched from $PROD_URL, sha256 $FRED_SHA256"
elif [ -f "$REPO/oracle/fred-guest/dist/fred-guest.wasm" ] && [ "$(sha256 "$REPO/oracle/fred-guest/dist/fred-guest.wasm")" = "$FRED_SHA256" ]; then
  cp "$REPO/oracle/fred-guest/dist/fred-guest.wasm" "$OUT/public/outlayer/fred-guest.wasm"
  echo "fred-guest.wasm: production unreachable or changed; oracle/fred-guest/dist has the pinned bytes, sha256 $FRED_SHA256"
else
  die "no fred-guest.wasm with sha256 $FRED_SHA256"
fi
cp "$REPO/oracle/nearusd-guest/dist/nearusd-guest.wasm" "$OUT/public/outlayer/nearusd-guest.wasm"
[ "$(sha256 "$OUT/public/outlayer/nearusd-guest.wasm")" = "$NEARUSD_SHA256" ] || die "oracle/nearusd-guest/dist/nearusd-guest.wasm is not sha256 $NEARUSD_SHA256"
echo "nearusd-guest.wasm: sha256 $NEARUSD_SHA256"

# The keeper function, one ESM file.
"$REPO/scripts/node_modules/.bin/esbuild" "$REPO/scripts/api/keeper.ts" \
  --bundle --platform=node --format=esm --target=node22 --legal-comments=none --log-level=warning \
  --define:KEEPER_TARGETS="$TARGETS" \
  --banner:js="import { createRequire as __keeperRequire } from 'node:module'; const require = __keeperRequire(import.meta.url);" \
  --outfile="$OUT/api/keeper.js"
echo "api/keeper.js: targets $TARGETS"

cp "$REPO/deploy/vercel.json" "$OUT/vercel.json"
cp "$REPO/deploy/package.json" "$OUT/package.json"

# Nothing secret may ship: no secret key (64 bytes, about 88 base58 characters), no key file.
KEY_PATTERN='ed25519:[1-9A-HJ-NP-Za-km-z]{80,}|"private_key"[[:space:]]*:'
if grep -rIlE "$KEY_PATTERN" "$OUT" >/dev/null 2>&1; then
  grep -rIlE "$KEY_PATTERN" "$OUT" >&2
  die "the deploy directory holds key material"
fi
[ -z "$(find "$OUT" -name '*.json' -path '*keys*')" ] || die "a key file is in the deploy directory"

echo
echo "deploy directory: $OUT"
(cd "$OUT" && find . -type f ! -path './public/_next/*' | sort | while read -r f; do printf '  %10s  %s\n' "$(wc -c < "$f" | tr -d ' ')" "$f"; done)
echo "  $(find "$OUT/public/_next" -type f 2>/dev/null | wc -l | tr -d ' ') files under public/_next/"
if [ "$DRY_RUN" = 1 ]; then
  echo "dry run: nothing deployed"
  exit 0
fi

deploy() {
  (cd "$OUT" && VERCEL_ORG_ID="$ORG_ID" VERCEL_PROJECT_ID="$PROJECT_ID" vercel deploy --prod --yes --scope "$SCOPE") 2>&1 | tee "$tmp/deploy.log"
  return "${PIPESTATUS[0]}"
}
if deploy; then
  echo "deployed: $PROD_URL"
  exit 0
fi
if grep -qiE 'hobby|once per day|cron' "$tmp/deploy.log"; then
  echo "the account refuses a per-minute cron: falling back to a daily cron (page pings keep the keeper running)"
  node -e '
    const fs = require("fs"); const p = process.argv[1]; const v = JSON.parse(fs.readFileSync(p, "utf8"));
    v.crons = [{ path: "/api/keeper/", schedule: "0 12 * * *" }];
    fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
  ' "$OUT/vercel.json"
  deploy && { echo "deployed with a daily cron: $PROD_URL"; exit 0; }
fi
die "vercel deploy failed (log above)"
