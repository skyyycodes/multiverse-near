#!/usr/bin/env bash
# Builds the deployable wasm of the protocol contract and the mock token into target/deploy/,
# with every local path rewritten (repo -> /build, cargo home -> /cargo, rustup home -> /rustup),
# checks that no local path is left in either file and prints their sha256.
#
#   scripts/build-wasm.sh            (or: pnpm -C scripts build:wasm)
#
# deploy.ts, accounts.ts and sandbox.ts read target/deploy/*.wasm by default.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CARGO_HOME_DIR="$(cd "${CARGO_HOME:-$HOME/.cargo}" && pwd -P)"
RUSTUP_HOME_DIR="$(cd "${RUSTUP_HOME:-$HOME/.rustup}" && pwd -P)"
OUT="$REPO/target/deploy"

export PATH="$CARGO_HOME_DIR/bin:$PATH"
# Its own target dir: other RUSTFLAGS here would make every other build in target/ start over.
export CARGO_TARGET_DIR="$REPO/target/wasm-build"
# cargo near ignores RUSTFLAGS from the shell and only takes them through --env; -C link-arg=-s
# is its default, kept here.
RUSTFLAGS="-C link-arg=-s --remap-path-prefix=$REPO=/build --remap-path-prefix=$CARGO_HOME_DIR=/cargo --remap-path-prefix=$RUSTUP_HOME_DIR=/rustup"

mkdir -p "$OUT"
for crate in multiverse mock-ft; do
  cargo near build non-reproducible-wasm --locked --env "RUSTFLAGS=$RUSTFLAGS" --manifest-path "$REPO/contracts/$crate/Cargo.toml" --out-dir "$OUT"
done

status=0
for wasm in "$OUT/multiverse_contract.wasm" "$OUT/mock_ft.wasm"; do
  leaks="$(LC_ALL=C grep -a -o -E "/Users/|/home/|/private/tmp|$(basename "$HOME")" "$wasm" | sort -u || true)"
  if [ -n "$leaks" ]; then
    echo "local paths left in $wasm:" >&2
    echo "$leaks" | sed 's/^/  /' >&2
    status=1
  fi
done
[ "$status" -eq 0 ] || exit "$status"

cd "$OUT"
shasum -a 256 multiverse_contract.wasm mock_ft.wasm
