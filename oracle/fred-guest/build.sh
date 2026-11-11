#!/usr/bin/env bash
# Builds the guest for OutLayer and prints the sha256 the contract pins.
#
# Panic messages embed source paths, which by default include the builder's
# home directory. They are remapped to fixed prefixes so the same toolchain
# and lockfile give the same bytes, and the same hash, on any machine.
set -euo pipefail
cd "$(dirname "$0")"

sysroot="$(rustc --print sysroot)"
commit="$(rustc -vV | sed -n 's/^commit-hash: //p')"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
export RUSTFLAGS="--remap-path-prefix=$sysroot/lib/rustlib/src/rust=/rustc/$commit --remap-path-prefix=$cargo_home/registry/src=/cargo/registry/src --remap-path-prefix=$PWD=/fred-guest"

cargo build --locked --release --target wasm32-wasip2

wasm="${CARGO_TARGET_DIR:-target}/wasm32-wasip2/release/fred-guest.wasm"
if command -v sha256sum >/dev/null; then
  sha256sum "$wasm"
else
  shasum -a 256 "$wasm"
fi
