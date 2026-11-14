#!/usr/bin/env bash
# Builds the guest for OutLayer into dist/nearusd-guest.wasm and prints the
# sha256 the contract pins (`set_reference_config`).
#
# Panic messages embed source paths, which by default include the builder's
# home directory. They are remapped to fixed prefixes, and the crate builds in
# its own target directory whatever CARGO_TARGET_DIR says, so the same
# toolchain and lockfile give the same bytes, and the same hash, on any
# machine and at any checkout path.
set -euo pipefail
cd "$(dirname "$0")"

sysroot="$(rustc --print sysroot)"
commit="$(rustc -vV | sed -n 's/^commit-hash: //p')"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
export CARGO_TARGET_DIR="$PWD/target"
export RUSTFLAGS="--remap-path-prefix=$sysroot/lib/rustlib/src/rust=/rustc/$commit --remap-path-prefix=$cargo_home/registry/src=/cargo/registry/src --remap-path-prefix=$PWD=/nearusd-guest"

cargo build --locked --release --target wasm32-wasip2 --bin nearusd-guest

mkdir -p dist
cp "$CARGO_TARGET_DIR/wasm32-wasip2/release/nearusd-guest.wasm" dist/nearusd-guest.wasm
if command -v sha256sum >/dev/null; then
  sha256sum dist/nearusd-guest.wasm
else
  shasum -a 256 dist/nearusd-guest.wasm
fi
