# fred-guest

The program OutLayer runs to resolve a FOMC event. It reads the federal funds
target range from FRED and prints one JSON value:

```
stdin:  {"before":"2026-10-27","after":"2026-10-29"}
stdout: {"outcome":1,"evidence":"FRED DFEDTARU 2026-10-27=4.00 2026-10-29=4.00, DFEDTARL 2026-10-27=3.75 2026-10-29=3.75: HOLDS"}
```

- `outcome` 0 is CUTS: both DFEDTARU and DFEDTARL are lower on `after` than on
  `before`. 1 is HOLDS: neither is (a hike resolves HOLDS).
- `outcome` is `null` when the two limits disagree, when FRED has no row for a
  date yet (today's row appears around 13:00 UTC), or when a request fails.
  The contract then proposes nothing and logs the evidence.
- Rates are compared in whole basis points, never as floats.
- Requests send `User-Agent: curl/8.7.1`. FRED's bot filter stalls clients
  that send none, and OutLayer aborts a run after two stalled requests.

The guest is a WASI Preview 2 component (`wasm32-wasip2`), the only kind
OutLayer lets make outbound HTTPS calls. It is not a member of the cargo
workspace at the repository root.

## Build

```bash
cd oracle/fred-guest
cargo test --locked
./build.sh
```

`rust-toolchain.toml` pins Rust 1.86.0 with the `wasm32-wasip2` target, and
`build.sh` remaps source paths, so the same toolchain and lockfile should give
the same bytes on another machine (two builds here at different paths did). It
prints the SHA-256 the contract pins:

```
8c809e11f5b4b37627baa5c0a65a8587ef5f3e4918d1e0bb42cb2f87a5ae1660  target/wasm32-wasip2/release/fred-guest.wasm
```

(408,875 bytes.) If your hash differs, use yours: the contract pins whatever
you configure, and OutLayer refuses a file whose bytes do not match it.

## Run locally

```bash
brew install wasmtime
echo '{"before":"2026-10-27","after":"2026-10-29"}' \
  | wasmtime run -S http target/wasm32-wasip2/release/fred-guest.wasm
```

Recorded on 2026-11-11 at 12:19 UTC, wasmtime 50.0.1, against live FRED
(about 2 s):

```
{"outcome":1,"evidence":"FRED DFEDTARU 2026-10-27=4.00 2026-10-29=4.00, DFEDTARL 2026-10-27=3.75 2026-10-29=3.75: HOLDS"}
```

And for a date FRED has no row for yet:

```
$ echo '{"before":"2026-11-10","after":"2026-11-12"}' | wasmtime run -S http target/wasm32-wasip2/release/fred-guest.wasm
{"outcome":null,"evidence":"FRED DFEDTARU has no value for 2026-11-12"}
```

## Host it at a pinned URL

The testnet deployment serves the guest from the web app's host, at
https://multiverse-lending.vercel.app/outlayer/fred-guest.wasm (408,875 bytes,
sha256 `8c809e11f5b4b37627baa5c0a65a8587ef5f3e4918d1e0bb42cb2f87a5ae1660`, the
exact output of `./build.sh`). Any URL works that is `https://`, serves the
file directly (HTTP 200, no redirect) and never changes; a raw file at a fixed
commit of the public repository does all three:

```bash
cd oracle/fred-guest
./build.sh
mkdir -p dist
cp target/wasm32-wasip2/release/fred-guest.wasm dist/
git add dist/fred-guest.wasm
git commit -m "fred-guest: publish the wasm"
git push
COMMIT=$(git rev-parse HEAD)
URL="https://raw.githubusercontent.com/skyyycodes/multiverse-near/$COMMIT/oracle/fred-guest/dist/fred-guest.wasm"
HASH=$(shasum -a 256 dist/fred-guest.wasm | cut -d' ' -f1)

curl -sSI "$URL" | head -1                 # HTTP/2 200
curl -sSf "$URL" | shasum -a 256           # must print $HASH
echo "$URL $HASH"
```

Alternative: OutLayer's own FastFS storage, `cargo install outlayer-cli`, then
`outlayer login testnet` and `outlayer upload dist/fred-guest.wasm`, which
prints the hash and a `https://test.fastfs.io/...` URL. The login stores the
account's private key in plain text under `~/.outlayer/`, so use an account
that holds nothing else.

## Configure the contract

`scripts/outlayer.ts` does the steps below and follows the run:
`NEAR_NETWORK=testnet pnpm -C scripts outlayer configure --url <url> --sha256 <hash>`, then
`NEAR_NETWORK=testnet pnpm -C scripts outlayer request`. By hand with NEAR CLI:

One owner call pins the guest. Limits default to 1e9 instructions, 128 MB and
30 s, and a request must attach at least 0.005 NEAR (OutLayer's estimate for
those limits on testnet is 0.0040001 NEAR; what a run does not use goes back to
whoever paid). The attached NEAR pays for the stored bytes and the rest is
refunded.

```bash
near contract call-function as-transaction app.multiverse-near.testnet set_outlayer_config \
  json-args "{\"wasm_url\":\"$URL\",\"wasm_sha256\":\"$HASH\"}" \
  prepaid-gas '30.0 Tgas' attached-deposit '0.01 NEAR' \
  sign-as multiverse-near.testnet network-config testnet sign-with-keychain send
```

Optional fields: `outlayer_id` (default `outlayer.testnet`),
`resource_limits` (`{"max_instructions":…,"max_memory_mb":…,"max_execution_seconds":…}`)
and `deposit` (yoctoNEAR as a string).

Then give the past FOMC event its two FRED dates. Its id is
`demo.past_fed_event` in `get_app_config`:

```bash
near contract call-function as-read-only app.multiverse-near.testnet get_app_config \
  json-args '{}' network-config testnet now

near contract call-function as-transaction app.multiverse-near.testnet set_outlayer_dates \
  json-args '{"event_id":3,"before":"2026-10-27","after":"2026-10-29"}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0.01 NEAR' \
  sign-as multiverse-near.testnet network-config testnet sign-with-keychain send
```

Setting the dates again makes any run in flight for that event stale and
clears its pending flag.

## Trigger a resolution

Anyone can, from any funded testnet account:

```bash
near contract call-function as-transaction app.multiverse-near.testnet request_resolution \
  json-args '{"event_id":3}' \
  prepaid-gas '300.0 Tgas' attached-deposit '0.005 NEAR' \
  sign-as <you>.testnet network-config testnet sign-with-keychain send
```

The contract calls `request_execution` on `outlayer.testnet` with the pinned
URL and hash, the limits, the stored dates as input, `response_format` Json and
`<you>.testnet` as payer. OutLayer resumes the call about 15 s later (15 s in the run of 2026-11-12, of which the guest
ran 1.7 s) and the
contract's callback either proposes the outcome with source `outlayer` (event
`outcome_proposed`) or logs why not (event `outlayer_result`). Only one run per
event can be in flight. Check it, then finalize once the dispute window is over:

```bash
near contract call-function as-read-only app.multiverse-near.testnet get_event \
  json-args '{"event_id":3}' network-config testnet now

near contract call-function as-transaction app.multiverse-near.testnet finalize \
  json-args '{"event_id":3}' prepaid-gas '300.0 Tgas' attached-deposit '0 NEAR' \
  sign-as <you>.testnet network-config testnet sign-with-keychain send
```

If the run fails, open it on app.outlayer.ai under Executions to see stderr.

## Trust

The result is computed by a pinned, open WASM inside an Intel TDX enclave, and
OutLayer publishes an attestation for every run. On-chain, OutLayer's contract
accepts the result from its operator account, so the result is as trustworthy
as OutLayer's key custody; the attestation is checked off-chain. The owner can
still dispute the proposal within the window.
