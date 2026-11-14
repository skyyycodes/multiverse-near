#!/usr/bin/env bash
# Prints the `vercel env add` commands that give the keeper function its secrets in the production
# environment of the Vercel project. It prints commands only, never a secret: each command reads the
# key from its key file (or makes a fresh CRON_SECRET) and pipes it straight into `vercel env add`.
# Run the printed lines yourself, then redeploy (scripts/deploy-web.sh) so the function sees them.
#
#   scripts/keeper-env.sh [--keys-dir <dir>] [--deployments <file>]
#
# KEEPER_KEY    keeper.<root>: liquidations and faucet mints (a full-access key: it calls the token and the contract)
# REPORTER_KEY  the reporter (resolver.<root>): `report_reference`; its "reference" key when one exists
# MAKER_KEY     maker.<root>: the maker's swaps, splits and faucet mints (full access: it calls both tokens and the contract)
# CRON_SECRET   random; Vercel Cron sends it as `Authorization: Bearer <CRON_SECRET>`
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# Key files live in the main checkout's .keys/ (gitignored), also when this runs from a worktree.
MAIN="$(cd "$(git -C "$REPO" rev-parse --git-common-dir)/.." && pwd -P)"
KEYS_DIR="${NEAR_KEYS_DIR:-$MAIN/.keys/staging}"
DEPLOYMENTS="$REPO/deployments/staging.json"
SCOPE="akash-chakrabortys-projects-ce92467d"
PROJECT="multiverse-lending"
RPC="https://test.rpc.fastnear.com"
while [ $# -gt 0 ]; do
  case "$1" in
    --keys-dir) KEYS_DIR="$2"; shift ;;
    --deployments) DEPLOYMENTS="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -f "$DEPLOYMENTS" ] || { echo "$DEPLOYMENTS is missing" >&2; exit 1; }

ids="$(node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(`${(d.ops && d.ops.keeper) || "keeper." + d.root} ${d.reporter} ${(d.ops && d.ops.maker) || "maker." + d.root}`);
' "$DEPLOYMENTS")"
read -r KEEPER REPORTER MAKER <<<"$ids"

# The public key of a key file (never the private one), and whether the chain knows it.
public_key() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).public_key || "")' "$1"; }
on_chain() {
  curl -fsS --max-time 15 "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key\",\"finality\":\"final\",\"account_id\":\"$1\",\"public_key\":\"$2\"}}" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);const p=r.result&&r.result.permission;process.stdout.write(r.error||!r.result||r.result.error?"NOT on chain":(p==="FullAccess"?"on chain, full access":"on chain, function call: "+JSON.stringify(p.FunctionCall.method_names)))})' ||
    printf 'unknown (RPC unreachable)'
}

missing=0
emit() { # name account file...
  local name="$1" account="$2" file=""
  shift 2
  for f in "$@"; do [ -f "$f" ] && { file="$f"; break; }; done
  if [ -z "$file" ]; then
    echo "# $name: no key file for $account (looked for: $*)"
    missing=1
    return
  fi
  local pk
  pk="$(public_key "$file")"
  echo "# $name: $account, public key $pk ($(on_chain "$account" "$pk")), from $file"
  echo "node -e 'process.stdout.write(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).private_key)' '$file' | vercel env add $name --environment production --sensitive --force --project $PROJECT --scope $SCOPE"
  echo
}

echo "# Secrets of the keeper function (Vercel project $PROJECT, production). Nothing below is a secret."
echo
emit KEEPER_KEY "$KEEPER" "$KEYS_DIR/$KEEPER.json"
emit REPORTER_KEY "$REPORTER" "$KEYS_DIR/$REPORTER.reference.json" "$KEYS_DIR/$REPORTER.json"
emit MAKER_KEY "$MAKER" "$KEYS_DIR/$MAKER.json"
echo "# CRON_SECRET: random, never written to disk"
echo "node -e 'process.stdout.write(require(\"crypto\").randomBytes(32).toString(\"hex\"))' | vercel env add CRON_SECRET --environment production --sensitive --force --project $PROJECT --scope $SCOPE"
echo
echo "# Check the names (values stay hidden), then redeploy: scripts/deploy-web.sh"
echo "vercel env ls production --project $PROJECT --scope $SCOPE"
exit "$missing"
